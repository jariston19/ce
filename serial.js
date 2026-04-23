const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { MongoClient } = require('mongodb');

const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);
const SERIAL_PORT_PATH =
  process.env.SERIAL_PORT_PATH || '/dev/cu.usbserial-A5069RR4';
const SERIAL_BAUD_RATE = Number(process.env.SERIAL_BAUD_RATE || 9600);
const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const MONGODB_DB = process.env.MONGODB_DB || 'sensor_monitor';
const MONGODB_COLLECTION =
  process.env.MONGODB_COLLECTION || 'sensor_readings';
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 40);
const SENSOR_MIN_DISTANCE_CM = Number(
  process.env.SENSOR_MIN_DISTANCE_CM || 0
);
const SENSOR_MAX_DISTANCE_CM = Number(
  process.env.SENSOR_MAX_DISTANCE_CM || 400
);
const RESET_READINGS_ON_START =
  process.env.RESET_READINGS_ON_START === 'true';
const SERIAL_ENABLED = process.env.SERIAL_ENABLED !== 'false';

const DIST_DIR = path.join(__dirname, 'dist');
const SENSOR_KEYS = ['s1', 's2', 's3'];

function createEmptySensorMap(defaultValue = null) {
  return SENSOR_KEYS.reduce((result, key) => {
    result[key] = defaultValue;
    return result;
  }, {});
}

function createCalibrationState() {
  return {
    source: 'arduino',
    active: true,
    phase: 'startup',
    baseline: createEmptySensorMap(),
    completedAt: null,
    detail: 'Waiting for Arduino calibration status.',
  };
}

function createEmptyAnalytics() {
  return {
    perSensor: SENSOR_KEYS.reduce((result, key) => {
      result[key] = {
        currentDisplacementCm: null,
        maxCrestCm: null,
        maxTroughCm: null,
        spanCm: null,
      };
      return result;
    }, {}),
  };
}

let readingsCollection;
let io;
let calibrationState = createCalibrationState();
let currentAnalytics = createEmptyAnalytics();
const sessionExtrema = SENSOR_KEYS.reduce((result, key) => {
  result[key] = { maxCrestCm: null, maxTroughCm: null };
  return result;
}, {});
let serialStatus = {
  enabled: SERIAL_ENABLED,
  connected: false,
  path: SERIAL_PORT_PATH,
  baudRate: SERIAL_BAUD_RATE,
  message: SERIAL_ENABLED ? 'Serial not started yet' : 'Serial disabled',
};

function emitSerialStatus() {
  if (io) {
    io.emit('serial:status', serialStatus);
  }
}

function getCalibrationStatus() {
  return calibrationState;
}

function emitCalibrationStatus() {
  if (io) {
    io.emit('calibration:status', getCalibrationStatus());
  }
}

function resetCalibrationState() {
  calibrationState = createCalibrationState();
}

function resetAnalyticsState() {
  currentAnalytics = createEmptyAnalytics();

  for (const key of SENSOR_KEYS) {
    sessionExtrema[key] = {
      maxCrestCm: null,
      maxTroughCm: null,
    };
  }
}

function isValidSensorValue(value) {
  return (
    Number.isFinite(value) &&
    value >= SENSOR_MIN_DISTANCE_CM &&
    value <= SENSOR_MAX_DISTANCE_CM
  );
}

function isValidActualHeightValue(value) {
  return value === null || isValidSensorValue(value);
}

function getInvalidSensorKeys(sensors) {
  return SENSOR_KEYS.filter((key) => !isValidSensorValue(sensors[key]));
}

function isValidSensorSample(sensors) {
  return getInvalidSensorKeys(sensors).length === 0;
}

function isFiniteSensorSample(sensors) {
  return SENSOR_KEYS.every((key) => Number.isFinite(sensors[key]));
}

function hasBaselineForSensor(key) {
  return Number.isFinite(calibrationState.baseline[key]);
}

function hasBaseline() {
  return SENSOR_KEYS.every((key) => hasBaselineForSensor(key));
}

function translateToActualHeights(sensors) {
  return SENSOR_KEYS.reduce((result, key) => {
    result[key] = hasBaselineForSensor(key)
      ? Number((calibrationState.baseline[key] + sensors[key]).toFixed(4))
      : null;
    return result;
  }, {});
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function updateDisplacementAnalytics(displacements) {
  const analytics = createEmptyAnalytics();

  for (const key of SENSOR_KEYS) {
    const displacement = displacements[key];
    const extrema = sessionExtrema[key];

    if (!Number.isFinite(displacement)) {
      analytics.perSensor[key] = { ...extrema, currentDisplacementCm: null, spanCm: null };
      continue;
    }

    extrema.maxCrestCm =
      typeof extrema.maxCrestCm === 'number'
        ? Math.max(extrema.maxCrestCm, displacement)
        : displacement;
    extrema.maxTroughCm =
      typeof extrema.maxTroughCm === 'number'
        ? Math.min(extrema.maxTroughCm, displacement)
        : displacement;

    analytics.perSensor[key] = {
      currentDisplacementCm: round(displacement),
      maxCrestCm: round(extrema.maxCrestCm),
      maxTroughCm: round(extrema.maxTroughCm),
      spanCm: round(extrema.maxCrestCm - extrema.maxTroughCm),
    };
  }

  currentAnalytics = analytics;
  return analytics;
}

function updateCalibrationStatus(patch) {
  Object.assign(calibrationState, patch);
  emitCalibrationStatus();
}

function getCalibrationLogLine(line) {
  const match = line.match(
    /(CALIBRATION:\s*invalid sample(?:\s+on\s+s[123](?:,\s*s[123])*)?,\s*retrying\.\.\.|CALIBRATION:\s*collecting.*|NOISE CALIBRATION:\s*invalid sample(?:\s+on\s+s[123](?:,\s*s[123])*)?,\s*retrying\.\.\.|NOISE CALIBRATION:.*|NOISE CALIBRATION COMPLETE|Deadband\s+s[123]:.*|CALIBRATION COMPLETE|Baseline\s+s[123]:\s*-?\d+(?:\.\d+)?)/i
  );

  return match ? match[1].trim() : null;
}

function handleCalibrationLogLine(line) {
  const calibrationLine = getCalibrationLogLine(line);

  if (!calibrationLine) {
    return false;
  }

  if (/^CALIBRATION:\s*collecting/i.test(calibrationLine)) {
    const match = calibrationLine.match(/(\d+)\/(\d+)/);
    updateCalibrationStatus({
      active: true,
      phase: 'baseline',
      detail: calibrationLine.replace(/^CALIBRATION:\s*/i, ''),
      collected: match ? Number(match[1]) : undefined,
      targetSamples: match ? Number(match[2]) : undefined,
    });
    return true;
  }

  if (/^CALIBRATION:\s*invalid sample(?:\s+on\s+s[123](?:,\s*s[123])*)?,\s*retrying\.\.\.$/i.test(calibrationLine)) {
    const invalidSensors = calibrationLine.match(/on\s+(.+),\s*retrying/i)?.[1] || null;
    updateCalibrationStatus({
      active: true,
      phase: 'baseline',
      detail: invalidSensors
        ? `Calibration retrying because ${invalidSensors} returned no echo.`
        : 'Calibration retrying because one or more sensors returned no echo.',
    });
    return true;
  }

  if (
    /^NOISE CALIBRATION:\s*invalid sample(?:\s+on\s+s[123](?:,\s*s[123])*)?,\s*retrying\.\.\.$/i.test(
      calibrationLine
    )
  ) {
    const invalidSensors = calibrationLine.match(/on\s+(.+),\s*retrying/i)?.[1] || null;
    updateCalibrationStatus({
      active: true,
      phase: 'noise',
      detail: invalidSensors
        ? `Noise calibration retrying because ${invalidSensors} returned no echo.`
        : 'Noise calibration retrying because one or more sensors returned no echo.',
    });
    return true;
  }

  if (/^NOISE CALIBRATION:/i.test(calibrationLine)) {
    const match = calibrationLine.match(/(\d+)\/(\d+)/);
    updateCalibrationStatus({
      active: true,
      phase: 'noise',
      detail: calibrationLine.replace(/^NOISE CALIBRATION:\s*/i, ''),
      collected: match ? Number(match[1]) : calibrationState.collected,
      targetSamples: match ? Number(match[2]) : calibrationState.targetSamples,
    });
    return true;
  }

  if (/^NOISE CALIBRATION COMPLETE$/i.test(calibrationLine)) {
    updateCalibrationStatus({
      active: true,
      phase: 'baseline',
      detail: 'Noise calibration complete.',
    });
    return true;
  }

  if (/^Deadband\s+s[123]:/i.test(calibrationLine)) {
    updateCalibrationStatus({
      active: true,
      detail: 'Arduino calibration is finalizing.',
    });
    return true;
  }

  if (/^Baseline\s+(s[123]):\s*(-?\d+(?:\.\d+)?)$/i.test(calibrationLine)) {
    const match = calibrationLine.match(/^Baseline\s+(s[123]):\s*(-?\d+(?:\.\d+)?)$/i);
    const key = match[1].toLowerCase();
    const value = Number(match[2]);
    calibrationState.baseline[key] = value;

    if (!calibrationState.active && hasBaseline()) {
      calibrationState.detail = 'Arduino calibration complete. Showing translated actual heights.';
    }

    emitCalibrationStatus();
    return true;
  }

  if (/^CALIBRATION COMPLETE$/i.test(calibrationLine)) {
    updateCalibrationStatus({
      active: false,
      phase: 'ready',
      completedAt: new Date().toISOString(),
      detail: hasBaseline()
        ? 'Arduino calibration complete. Showing translated actual heights.'
        : 'Arduino calibration complete.',
    });
    return true;
  }

  return false;
}

function normalizeSensorValues(line) {
  const sanitized = line
    .trim()
    .replace(/(^|,)\s*-{2,}(?=\d)/g, '$1-')
    .replace(/[^0-9,.\-\s]/g, '');

  const values = sanitized
    .split(',')
    .map((value) => Number.parseFloat(value.trim()));

  if (values.length !== SENSOR_KEYS.length || values.some(Number.isNaN)) {
    return null;
  }

  return SENSOR_KEYS.reduce((result, key, index) => {
    result[key] = values[index];
    return result;
  }, {});
}

function getInvalidActualHeightKeys(sensors) {
  return SENSOR_KEYS.filter((key) => !isValidActualHeightValue(sensors[key]));
}

function buildReadingPayload(document) {
  return {
    id: document._id?.toString?.() || null,
    sensors: document.sensors,
    rawSensors: document.rawSensors || document.sensors,
    createdAt: document.createdAt,
    analytics: document.analytics || currentAnalytics,
  };
}

async function storeReading(rawLine, rawSensors, sensors, analytics, createdAt) {
  if (!readingsCollection) {
    return null;
  }

  const document = {
    rawLine,
    rawSensors,
    sensors,
    analytics,
    createdAt,
  };

  const result = await readingsCollection.insertOne(document);
  return {
    ...document,
    _id: result.insertedId,
  };
}

async function getLatestReadings() {
  const latest = await readingsCollection.findOne(
    {},
    { sort: { createdAt: -1 } }
  );

  return latest ? buildReadingPayload(latest) : null;
}

async function getReadingFeed({ limit, from, to } = {}) {
  const safeLimit = Number.isFinite(limit)
    ? Math.min(Math.max(limit, 1), 5000)
    : HISTORY_LIMIT;
  const query = {};

  if (from instanceof Date || to instanceof Date) {
    query.createdAt = {};

    if (from instanceof Date && !Number.isNaN(from.getTime())) {
      query.createdAt.$gte = from;
    }

    if (to instanceof Date && !Number.isNaN(to.getTime())) {
      query.createdAt.$lte = to;
    }
  }

  const documents = await readingsCollection
    .find(query, { sort: { createdAt: -1 }, limit: safeLimit })
    .toArray();

  return documents.reverse().map(buildReadingPayload);
}

async function connectToMongo() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();

  const database = client.db(MONGODB_DB);
  readingsCollection = database.collection(MONGODB_COLLECTION);
  await readingsCollection.createIndex({ createdAt: -1 });

  if (RESET_READINGS_ON_START) {
    const result = await readingsCollection.deleteMany({});
    console.log(
      `Startup reset cleared ${result.deletedCount} stored sensor readings`
    );
  }

  console.log(
    `MongoDB connected: ${MONGODB_DB}.${MONGODB_COLLECTION} at ${MONGODB_URI}`
  );
}

function broadcastReading(reading) {
  if (!io || !reading) {
    return;
  }

  io.emit('sensor:reading', buildReadingPayload(reading));
}

function startSerialReader() {
  if (!SERIAL_ENABLED) {
    console.log('Serial reader disabled. API will use MongoDB only.');
    return null;
  }

  let port;

  try {
    port = new SerialPort({
      path: SERIAL_PORT_PATH,
      baudRate: SERIAL_BAUD_RATE,
    });
  } catch (error) {
    serialStatus = {
      ...serialStatus,
      connected: false,
      message: `Serial unavailable: ${error.message}`,
    };
    emitSerialStatus();
    console.error(serialStatus.message);
    return null;
  }

  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

  port.on('open', () => {
    serialStatus = {
      ...serialStatus,
      connected: true,
      message: `Serial connected on ${SERIAL_PORT_PATH}`,
    };
    emitSerialStatus();
    console.log(
      `Serial port connected on ${SERIAL_PORT_PATH} @ ${SERIAL_BAUD_RATE}`
    );
  });

  port.on('error', (error) => {
    serialStatus = {
      ...serialStatus,
      connected: false,
      message: `Serial port error: ${error.message}`,
    };
    emitSerialStatus();
    console.error('Serial port error:', error.message);
  });

  parser.on('data', async (data) => {
    const rawLine = data.trim();

    if (!rawLine) {
      return;
    }

    if (handleCalibrationLogLine(rawLine)) {
      return;
    }

    const sensors = normalizeSensorValues(rawLine);

    if (!sensors) {
      console.warn(`Skipping invalid serial line: ${rawLine}`);
      return;
    }

    if (!isFiniteSensorSample(sensors)) {
      console.warn(`Skipping invalid sensor sample: ${rawLine}`);
      return;
    }

    const translatedSensors = translateToActualHeights(sensors);

    const invalidKeys = getInvalidActualHeightKeys(translatedSensors);
    if (invalidKeys.length) {
      console.warn(
        `Skipping invalid sensor sample (${invalidKeys.join(', ')}): ${rawLine}`
      );
      return;
    }

    try {
      const createdAt = new Date();
      const analytics = updateDisplacementAnalytics(sensors);
      const reading = await storeReading(
        rawLine,
        sensors,
        translatedSensors,
        analytics,
        createdAt
      );
      broadcastReading(reading);
    } catch (error) {
      console.error('Failed to store reading:', error.message);
    }
  });

  return port;
}

function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/api/readings/latest', async (_req, res) => {
    try {
      const latest = await getLatestReadings();
      res.json({ latest });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/readings/feed', async (req, res) => {
    try {
      const limit = Number.parseInt(req.query.limit || String(HISTORY_LIMIT), 10);
      const from = req.query.from ? new Date(req.query.from) : null;
      const to = req.query.to ? new Date(req.query.to) : null;
      const readings = await getReadingFeed({ limit, from, to });
      res.json({ readings });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/calibration/node', (_req, res) => {
    res.json({ calibration: getCalibrationStatus() });
  });

  app.post('/api/calibration/node/start', (_req, res) => {
    res.json({
      ok: true,
      message: 'Raw height logging mode is active. No calibration step is required.',
      calibration: getCalibrationStatus(),
    });
  });

  app.get('/api/serial/status', (_req, res) => {
    res.json({ serial: serialStatus });
  });

  if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));

    app.get(/^(?!\/api\/|\/socket\.io\/).*/, (_req, res) => {
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  } else {
    app.get(/^(?!\/api\/|\/socket\.io\/).*/, (_req, res) => {
      res.status(503).send(
        'React frontend is not built yet. Run "npm run build" for production or "npm run dev" for the Vite client.'
      );
    });
  }

  return app;
}

async function start() {
  resetCalibrationState();
  resetAnalyticsState();
  await connectToMongo();

  const app = createApp();
  const server = http.createServer(app);
  io = new Server(server, {
    cors: {
      origin: '*',
    },
  });

  io.on('connection', async (socket) => {
    try {
      const latest = await getLatestReadings();
      socket.emit('sensor:latest', latest);
      socket.emit('calibration:status', getCalibrationStatus());
      socket.emit('serial:status', serialStatus);
    } catch (error) {
      socket.emit('sensor:error', { message: error.message });
    }
  });

  server.listen(HTTP_PORT, () => {
    console.log(
      `API and Socket.IO server available at http://localhost:${HTTP_PORT}`
    );
  });

  emitCalibrationStatus();
  startSerialReader();
}

start().catch((error) => {
  console.error('Startup failed:', error);
  process.exit(1);
});

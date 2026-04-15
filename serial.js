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
const NODE_CALIBRATION_SAMPLES = Number(
  process.env.NODE_CALIBRATION_SAMPLES || 30
);
const NODE_OUTPUT_DEADBAND_CM_S1 = Number(
  process.env.NODE_OUTPUT_DEADBAND_CM_S1 || 0.2
);
const NODE_OUTPUT_DEADBAND_CM_S2 = Number(
  process.env.NODE_OUTPUT_DEADBAND_CM_S2 || 0.2
);
const NODE_OUTPUT_DEADBAND_CM_S3 = Number(
  process.env.NODE_OUTPUT_DEADBAND_CM_S3 || 0.2
);
const NODE_EMA_ALPHA = Number(process.env.NODE_EMA_ALPHA || 0.28);
const ANALYTICS_WINDOW = Number(process.env.ANALYTICS_WINDOW || 80);
const PEAK_MIN_ABS_CM = Number(process.env.PEAK_MIN_ABS_CM || 0.5);
const SERIAL_ENABLED = process.env.SERIAL_ENABLED !== 'false';

const DIST_DIR = path.join(__dirname, 'dist');
const SENSOR_KEYS = ['s1', 's2', 's3'];

let readingsCollection;
let io;
let nodeCalibration = createCalibrationState();
let currentAnalytics = createEmptyAnalytics();
const nodeFilterState = { s1: 0, s2: 0, s3: 0 };
let serialStatus = {
  enabled: SERIAL_ENABLED,
  connected: false,
  path: SERIAL_PORT_PATH,
  baudRate: SERIAL_BAUD_RATE,
  message: SERIAL_ENABLED ? 'Serial not started yet' : 'Serial disabled',
};

const analyticsState = {
  series: { s1: [], s2: [], s3: [] },
  peakTimes: { s1: [], s2: [], s3: [] },
};

function round(value, digits = 4) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pushLimited(array, value, limit) {
  array.push(value);
  if (array.length > limit) {
    array.shift();
  }
}

function createEmptyAnalytics() {
  return {
    perSensor: {
      s1: { amplitudeCm: null, waveHeightCm: null, waveHeightBandCm: null, frequencyHz: null, periodSec: null },
      s2: { amplitudeCm: null, waveHeightCm: null, waveHeightBandCm: null, frequencyHz: null, periodSec: null },
      s3: { amplitudeCm: null, waveHeightCm: null, waveHeightBandCm: null, frequencyHz: null, periodSec: null },
    },
    breakwater: {
      reductionEfficiencyPct: null,
      transmissionRatio: null,
      interactionChangePct: null,
    },
  };
}

function average(numbers) {
  if (!numbers.length) {
    return null;
  }

  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function getAveragePeriodFromPeaks(peakTimes) {
  if (peakTimes.length < 2) {
    return null;
  }

  const intervals = [];
  for (let index = 1; index < peakTimes.length; index += 1) {
    const interval = peakTimes[index] - peakTimes[index - 1];
    if (interval > 0) {
      intervals.push(interval);
    }
  }

  return average(intervals);
}

function detectPeak(key) {
  const samples = analyticsState.series[key];
  if (samples.length < 3) {
    return;
  }

  const a = samples[samples.length - 3];
  const b = samples[samples.length - 2];
  const c = samples[samples.length - 1];

  const isPeak = b.value > a.value && b.value >= c.value && Math.abs(b.value) >= PEAK_MIN_ABS_CM;
  if (!isPeak) {
    return;
  }

  const peaks = analyticsState.peakTimes[key];
  const lastPeak = peaks[peaks.length - 1];

  if (!lastPeak || b.timeSec - lastPeak >= 0.08) {
    pushLimited(peaks, b.timeSec, ANALYTICS_WINDOW);
  }
}

function updateAnalytics(sensors, createdAt) {
  const timeSec = createdAt.getTime() / 1000;

  for (const key of SENSOR_KEYS) {
    pushLimited(
      analyticsState.series[key],
      { timeSec, value: sensors[key] },
      ANALYTICS_WINDOW
    );
    detectPeak(key);
  }

  const nextAnalytics = createEmptyAnalytics();

  for (const key of SENSOR_KEYS) {
    const values = analyticsState.series[key].map((entry) => entry.value);
    if (!values.length) {
      continue;
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const amplitudeCm = (max - min) / 2;
    const waveHeightCm = amplitudeCm * 2;
    const periodSec = getAveragePeriodFromPeaks(analyticsState.peakTimes[key]);
    const frequencyHz = periodSec ? 1 / periodSec : null;

    nextAnalytics.perSensor[key] = {
      amplitudeCm: round(amplitudeCm),
      waveHeightCm: round(waveHeightCm),
      waveHeightBandCm: {
        min: round(waveHeightCm * 0.9),
        max: round(waveHeightCm * 1.1),
      },
      frequencyHz: round(frequencyHz),
      periodSec: round(periodSec),
    };
  }

  const incidentWaveHeight = nextAnalytics.perSensor.s1.waveHeightCm;
  const interactionWaveHeight = nextAnalytics.perSensor.s2.waveHeightCm;
  const transmittedWaveHeight = nextAnalytics.perSensor.s3.waveHeightCm;
  const transmissionRatio =
    typeof incidentWaveHeight === 'number' && incidentWaveHeight > 0
      ? transmittedWaveHeight / incidentWaveHeight
      : null;
  const reductionEfficiencyPct =
    typeof incidentWaveHeight === 'number' && incidentWaveHeight > 0
      ? ((incidentWaveHeight - transmittedWaveHeight) / incidentWaveHeight) * 100
      : null;
  const interactionChangePct =
    typeof incidentWaveHeight === 'number' && incidentWaveHeight > 0
      ? ((interactionWaveHeight - incidentWaveHeight) / incidentWaveHeight) * 100
      : null;

  nextAnalytics.breakwater = {
    reductionEfficiencyPct: round(reductionEfficiencyPct),
    transmissionRatio: round(transmissionRatio),
    interactionChangePct: round(interactionChangePct),
  };

  currentAnalytics = nextAnalytics;
  return nextAnalytics;
}

function createCalibrationState() {
  return {
    active: true,
    targetSamples: Math.max(1, NODE_CALIBRATION_SAMPLES),
    collected: 0,
    sums: { s1: 0, s2: 0, s3: 0 },
    baseline: { s1: 0, s2: 0, s3: 0 },
    startedAt: new Date(),
    completedAt: null,
  };
}

function getCalibrationStatus() {
  return {
    active: nodeCalibration.active,
    targetSamples: nodeCalibration.targetSamples,
    collected: nodeCalibration.collected,
    baseline: nodeCalibration.baseline,
    startedAt: nodeCalibration.startedAt,
    completedAt: nodeCalibration.completedAt,
  };
}

function startNodeCalibration() {
  if (!SERIAL_ENABLED) {
    nodeCalibration = {
      ...createCalibrationState(),
      active: false,
      completedAt: new Date(),
    };
    return;
  }

  nodeCalibration = createCalibrationState();
  for (const key of SENSOR_KEYS) {
    nodeFilterState[key] = 0;
  }
  console.log(
    `Node calibration started (${nodeCalibration.targetSamples} samples)`
  );
  if (io) {
    io.emit('calibration:status', getCalibrationStatus());
  }
}

function applyNodeCalibration(sensors) {
  if (nodeCalibration.active) {
    for (const key of SENSOR_KEYS) {
      nodeCalibration.sums[key] += sensors[key];
    }
    nodeCalibration.collected += 1;

    if (nodeCalibration.collected >= nodeCalibration.targetSamples) {
      for (const key of SENSOR_KEYS) {
        nodeCalibration.baseline[key] =
          nodeCalibration.sums[key] / nodeCalibration.collected;
      }
      nodeCalibration.active = false;
      nodeCalibration.completedAt = new Date();
      console.log('Node calibration complete:', nodeCalibration.baseline);
      if (io) {
        io.emit('calibration:status', getCalibrationStatus());
      }
    }
  }

  const calibrated = {};
  const deadbandBySensor = {
    s1: NODE_OUTPUT_DEADBAND_CM_S1,
    s2: NODE_OUTPUT_DEADBAND_CM_S2,
    s3: NODE_OUTPUT_DEADBAND_CM_S3,
  };

  for (const key of SENSOR_KEYS) {
    const shifted = sensors[key] - nodeCalibration.baseline[key];
    const deadband = deadbandBySensor[key];
    const gated = Math.abs(shifted) < deadband ? 0 : shifted;
    const filtered = NODE_EMA_ALPHA * gated + (1 - NODE_EMA_ALPHA) * nodeFilterState[key];
    nodeFilterState[key] = filtered;
    calibrated[key] = Math.abs(filtered) < deadband ? 0 : Number(filtered.toFixed(4));
  }
  return calibrated;
}

function normalizeSensorValues(line) {
  const values = line.split(',').map((value) => Number.parseFloat(value.trim()));

  if (values.length !== SENSOR_KEYS.length || values.some(Number.isNaN)) {
    return null;
  }

  return SENSOR_KEYS.reduce((result, key, index) => {
    result[key] = values[index];
    return result;
  }, {});
}

function isCalibrationLogLine(line) {
  return (
    line.startsWith('CALIBRATION:') ||
    line.startsWith('CALIBRATION ') ||
    line.startsWith('NOISE CALIBRATION') ||
    line.startsWith('BASELINE ')
  );
}

function buildReadingPayload(document) {
  return {
    id: document._id?.toString?.() || null,
    sensors: document.sensors,
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
    console.log(`Serial port connected on ${SERIAL_PORT_PATH} @ ${SERIAL_BAUD_RATE}`);
  });

  port.on('error', (error) => {
    serialStatus = {
      ...serialStatus,
      connected: false,
      message: `Serial port error: ${error.message}`,
    };
    console.error('Serial port error:', error.message);
  });

  parser.on('data', async (data) => {
    const rawLine = data.trim();

    if (!rawLine) {
      return;
    }

    const sensors = normalizeSensorValues(rawLine);

    if (!sensors) {
      if (!isCalibrationLogLine(rawLine)) {
        console.warn(`Skipping invalid serial line: ${rawLine}`);
      }
      return;
    }

    try {
      const calibratedSensors = applyNodeCalibration(sensors);
      const createdAt = new Date();
      const analytics = updateAnalytics(calibratedSensors, createdAt);
      const reading = await storeReading(
        rawLine,
        sensors,
        calibratedSensors,
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
    startNodeCalibration();
    res.json({
      ok: true,
      message: 'Node calibration restarted',
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
    console.log(`API and Socket.IO server available at http://localhost:${HTTP_PORT}`);
  });

  startNodeCalibration();
  startSerialReader();
}

start().catch((error) => {
  console.error('Startup failed:', error);
  process.exit(1);
});

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

const DIST_DIR = path.join(__dirname, 'dist');
const SENSOR_KEYS = ['s1', 's2', 's3'];

let readingsCollection;
let io;

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

function buildReadingPayload(document) {
  return {
    id: document._id?.toString?.() || null,
    sensors: document.sensors,
    createdAt: document.createdAt,
  };
}

async function storeReading(rawLine, sensors) {
  if (!readingsCollection) {
    return null;
  }

  const document = {
    rawLine,
    sensors,
    createdAt: new Date(),
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

async function getReadingFeed(limit) {
  const safeLimit = Number.isFinite(limit)
    ? Math.min(Math.max(limit, 1), 200)
    : HISTORY_LIMIT;

  const documents = await readingsCollection
    .find({}, { sort: { createdAt: -1 }, limit: safeLimit })
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
  const port = new SerialPort({
    path: SERIAL_PORT_PATH,
    baudRate: SERIAL_BAUD_RATE,
  });

  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

  port.on('open', () => {
    console.log(`Serial port connected on ${SERIAL_PORT_PATH} @ ${SERIAL_BAUD_RATE}`);
  });

  port.on('error', (error) => {
    console.error('Serial port error:', error.message);
  });

  parser.on('data', async (data) => {
    const rawLine = data.trim();

    if (!rawLine) {
      return;
    }

    const sensors = normalizeSensorValues(rawLine);

    if (!sensors) {
      console.warn(`Skipping invalid serial line: ${rawLine}`);
      return;
    }

    try {
      const reading = await storeReading(rawLine, sensors);
      broadcastReading(reading);
    } catch (error) {
      console.error('Failed to store reading:', error.message);
    }
  });
}

function createApp() {
  const app = express();

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
      const readings = await getReadingFeed(limit);
      res.json({ readings });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
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
    } catch (error) {
      socket.emit('sensor:error', { message: error.message });
    }
  });

  startSerialReader();

  server.listen(HTTP_PORT, () => {
    console.log(`API and Socket.IO server available at http://localhost:${HTTP_PORT}`);
  });
}

start().catch((error) => {
  console.error('Startup failed:', error);
  process.exit(1);
});

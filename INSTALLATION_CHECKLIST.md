# Installation Checklist

Use this checklist when moving the project to another laptop.

## 1. Install Required Software

- Install Node.js LTS
- Install npm
- Install MongoDB Community Server
- Install Arduino USB serial drivers if your board needs them

Optional:

- Use MongoDB Atlas instead of local MongoDB

## 2. Copy the Project

- Copy the whole project folder to the new laptop
- Open a terminal in the project folder

## 3. Install Project Dependencies

Run:

```bash
npm install
```

## 4. Build the React Frontend

Run:

```bash
npm run build
```

## 5. Confirm MongoDB is Running

If using local MongoDB:

- Start the MongoDB service
- Confirm the default URI works:

```bash
mongodb://127.0.0.1:27017
```

If using MongoDB Atlas:

- Copy your Atlas connection string
- Use it as `MONGODB_URI`

## 6. Find the Serial Port

You must update the Arduino serial port path for the new laptop.

Examples:

- macOS: `/dev/cu.usbserial-*` or `/dev/cu.usbmodem-*`
- Linux: `/dev/ttyUSB0` or `/dev/ttyACM0`
- Windows: `COM3`, `COM4`, etc.

## 7. Run the App

Production mode:

```bash
SERIAL_PORT_PATH="/your/serial/path" MONGODB_URI="mongodb://127.0.0.1:27017" npm start
```

Development mode:

Terminal 1:

```bash
SERIAL_PORT_PATH="/your/serial/path" MONGODB_URI="mongodb://127.0.0.1:27017" npm run dev:server
```

Terminal 2:

```bash
npm run dev
```

## 8. Open the Dashboard

- Production: `http://localhost:3000`
- Development: `http://localhost:5173`

## 9. Verify These Things

- MongoDB connects successfully
- The serial port path is correct
- Arduino is plugged in
- Live sensor values appear in the dashboard
- Socket.IO updates are working
- Alarm works when a sensor value is `20` or below

## 10. Common Problems

- `Cannot find module`
  - Run `npm install`

- MongoDB connection error
  - Start MongoDB or fix `MONGODB_URI`

- Serial port open error
  - Check `SERIAL_PORT_PATH`
  - Reconnect the Arduino
  - Check USB drivers

- Frontend loads but no live data
  - Confirm backend is running
  - Confirm Arduino is sending valid CSV sensor values
  - Confirm MongoDB is connected

## 11. Quick Command Summary

Install packages:

```bash
npm install
```

Build frontend:

```bash
npm run build
```

Start app:

```bash
SERIAL_PORT_PATH="/your/serial/path" MONGODB_URI="mongodb://127.0.0.1:27017" npm start
```

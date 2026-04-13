import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SENSOR_KEYS = ['s1', 's2', 's3'];
const SENSOR_META = {
  s1: { label: 'Sensor 1', color: '#d74d37' },
  s2: { label: 'Sensor 2', color: '#287271' },
  s3: { label: 'Sensor 3', color: '#d9a441' },
  average: { label: 'Average', color: '#3e3a39' },
};
const MAX_POINTS = 40;
const CHART_WIDTH = 960;
const CHART_HEIGHT = 320;
const CHART_PADDING = 24;
const LOW_SENSOR_THRESHOLD = 20;

function createAlarmController() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    return null;
  }

  const context = new AudioContextClass();
  let intervalId = null;

  const beep = () => {
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    oscillator.connect(gainNode);
    gainNode.connect(context.destination);

    gainNode.gain.setValueAtTime(0.0001, context.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.28);

    oscillator.start(context.currentTime);
    oscillator.stop(context.currentTime + 0.28);
  };

  return {
    async resume() {
      if (context.state === 'suspended') {
        await context.resume();
      }
    },
    async start() {
      await this.resume();

      if (intervalId) {
        return;
      }

      beep();
      intervalId = window.setInterval(beep, 900);
    },
    stop() {
      if (!intervalId) {
        return;
      }

      window.clearInterval(intervalId);
      intervalId = null;
    },
  };
}

function formatValue(value) {
  return typeof value === 'number' ? value.toFixed(2) : '--';
}

function formatTimestamp(value) {
  if (!value) {
    return 'No data yet';
  }

  return new Date(value).toLocaleString();
}

function getTriggeredSensors(latestReading) {
  if (!latestReading?.sensors) {
    return [];
  }

  return SENSOR_KEYS.filter((key) => {
    const value = latestReading.sensors[key];
    return typeof value === 'number' && value <= LOW_SENSOR_THRESHOLD;
  });
}

function clampFeed(readings) {
  return readings.slice(-MAX_POINTS);
}

function buildAverageSeries(readings, visibleSensors) {
  const included = SENSOR_KEYS.filter((key) => visibleSensors[key]);

  return readings
    .map((reading) => {
      if (!included.length) {
        return null;
      }

      const values = included
        .map((key) => reading.sensors[key])
        .filter((value) => typeof value === 'number');

      if (!values.length) {
        return null;
      }

      return {
        createdAt: reading.createdAt,
        value: values.reduce((sum, value) => sum + value, 0) / values.length,
      };
    })
    .filter(Boolean);
}

function buildSeries(readings, key) {
  return readings
    .map((reading) => ({
      createdAt: reading.createdAt,
      value: reading.sensors[key],
    }))
    .filter((entry) => typeof entry.value === 'number');
}

function getSmoothPath(points) {
  if (!points.length) {
    return '';
  }

  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }

  let path = `M ${points[0].x} ${points[0].y}`;

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const controlX = (current.x + next.x) / 2;

    path += ` C ${controlX} ${current.y}, ${controlX} ${next.y}, ${next.x} ${next.y}`;
  }

  return path;
}

function getLabelY(value, minValue, range) {
  const innerHeight = CHART_HEIGHT - CHART_PADDING * 2;

  return (
    CHART_HEIGHT -
    CHART_PADDING -
    ((value - minValue) / range) * innerHeight
  );
}

function WaveChart({
  readings,
  visibleSensors,
  showAverage,
  showValueLabels,
}) {
  const seriesMap = {
    s1: buildSeries(readings, 's1'),
    s2: buildSeries(readings, 's2'),
    s3: buildSeries(readings, 's3'),
  };

  if (showAverage) {
    seriesMap.average = buildAverageSeries(readings, visibleSensors);
  }

  const activeKeys = [
    ...SENSOR_KEYS.filter((key) => visibleSensors[key]),
    ...(showAverage ? ['average'] : []),
  ].filter((key) => (seriesMap[key] || []).length);

  if (!activeKeys.length) {
    return (
      <div className="chart-empty">
        Enable at least one sensor to draw the live wave.
      </div>
    );
  }

  const allValues = activeKeys.flatMap((key) =>
    seriesMap[key].map((entry) => entry.value)
  );
  const minValue = Math.min(...allValues);
  const maxValue = Math.max(...allValues);
  const range = maxValue - minValue || 1;
  const innerWidth = CHART_WIDTH - CHART_PADDING * 2;
  const innerHeight = CHART_HEIGHT - CHART_PADDING * 2;
  const scaleLabels = Array.from({ length: 4 }, (_, index) => {
    const ratio = 1 - index / 3;
    const value = minValue + range * ratio;
    const y = CHART_PADDING + (innerHeight / 3) * index;

    return { value, y };
  });

  const xStep = Math.max(innerWidth / Math.max(readings.length - 1, 1), 1);

  const chartPaths = activeKeys.map((key) => {
    const series = seriesMap[key];
    const points = series.map((entry, index) => ({
      x: CHART_PADDING + xStep * index,
      y: getLabelY(entry.value, minValue, range),
    }));
    const latestEntry = series[series.length - 1];

    return {
      key,
      path: getSmoothPath(points),
      color: SENSOR_META[key].color,
      latestEntry,
      lastPoint: points[points.length - 1],
    };
  });

  const guideLines = Array.from({ length: 4 }, (_, index) => {
    const y = CHART_PADDING + (innerHeight / 3) * index;
    return { y };
  });

  return (
    <div className="chart-shell">
      <svg
        className="wave-chart"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        role="img"
        aria-label="Live sensor wave chart"
      >
        <defs>
          {chartPaths.map((entry) => (
            <linearGradient
              key={`${entry.key}-gradient`}
              id={`${entry.key}-gradient`}
              x1="0%"
              x2="100%"
              y1="0%"
              y2="0%"
            >
              <stop offset="0%" stopColor={entry.color} stopOpacity="0.35" />
              <stop offset="50%" stopColor={entry.color} stopOpacity="1" />
              <stop offset="100%" stopColor={entry.color} stopOpacity="0.45" />
            </linearGradient>
          ))}
        </defs>

        {guideLines.map((line) => (
          <line
            key={line.y}
            className="chart-guide"
            x1={CHART_PADDING}
            x2={CHART_WIDTH - CHART_PADDING}
            y1={line.y}
            y2={line.y}
          />
        ))}

        {scaleLabels.map((label) => (
          <g key={`scale-${label.y}`}>
            <text
              x={8}
              y={label.y + 4}
              className="chart-scale-label"
            >
              {formatValue(label.value)}
            </text>
          </g>
        ))}

        {chartPaths.map((entry) => (
          <path
            key={entry.key}
            d={entry.path}
            fill="none"
            stroke={`url(#${entry.key}-gradient)`}
            strokeWidth={entry.key === 'average' ? 3 : 2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {showValueLabels &&
          chartPaths.map((entry) =>
            entry.lastPoint ? (
              <g key={`${entry.key}-value-label`}>
                <circle
                  cx={entry.lastPoint.x}
                  cy={entry.lastPoint.y}
                  r={entry.key === 'average' ? 5.5 : 4.5}
                  fill={entry.color}
                  className="chart-endpoint"
                />
                <text
                  x={Math.min(entry.lastPoint.x + 10, CHART_WIDTH - 68)}
                  y={entry.lastPoint.y - 10}
                  className="chart-value-label"
                  fill={entry.color}
                >
                  {`${SENSOR_META[entry.key].label}: ${formatValue(entry.latestEntry.value)}`}
                </text>
              </g>
            ) : null
          )}
      </svg>
    </div>
  );
}

function SensorCard({ sensorKey, latest, history, enabled, isAlarmed }) {
  return (
    <article
      className={`sensor-card ${enabled ? '' : 'sensor-card-muted'} ${
        isAlarmed ? 'sensor-card-alarm' : ''
      }`}
    >
      <header className="sensor-card-header">
        <div>
          <p className="sensor-label">{SENSOR_META[sensorKey].label}</p>
          <h2 className="sensor-name">{sensorKey.toUpperCase()}</h2>
        </div>
        <span
          className="sensor-pill"
          style={{
            backgroundColor: isAlarmed
              ? 'rgba(178, 34, 34, 0.14)'
              : `${SENSOR_META[sensorKey].color}20`,
            color: isAlarmed ? '#b22222' : SENSOR_META[sensorKey].color,
          }}
        >
          {isAlarmed ? 'Alarm' : enabled ? 'Visible' : 'Hidden'}
        </span>
      </header>

      <div className="sensor-reading">
        <span className="sensor-value">{formatValue(latest)}</span>
      </div>

      <div className="history-block">
        <h3>Recent readings</h3>
        <ul className="history-list">
          {history.length ? (
            history
              .slice()
              .reverse()
              .slice(0, 5)
              .map((entry) => (
                <li key={`${sensorKey}-${entry.createdAt}`}>
                  <strong>{formatValue(entry.value)}</strong>
                  <span className="history-time">
                    {formatTimestamp(entry.createdAt)}
                  </span>
                </li>
              ))
          ) : (
            <li>No readings yet</li>
          )}
        </ul>
      </div>
    </article>
  );
}

export default function App() {
  const [readings, setReadings] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState('Connecting...');
  const [lastUpdated, setLastUpdated] = useState('Waiting for data');
  const [visibleSensors, setVisibleSensors] = useState({
    s1: true,
    s2: true,
    s3: true,
  });
  const [showAverage, setShowAverage] = useState(true);
  const [showValueLabels, setShowValueLabels] = useState(true);
  const alarmControllerRef = useRef(null);

  useEffect(() => {
    let active = true;

    async function loadInitialReadings() {
      try {
        const response = await fetch(`/api/readings/feed?limit=${MAX_POINTS}`);

        if (!response.ok) {
          throw new Error('Failed to load reading history');
        }

        const payload = await response.json();

        if (!active) {
          return;
        }

        setReadings(clampFeed(payload.readings || []));
        if ((payload.readings || []).length) {
          const latest = payload.readings[payload.readings.length - 1];
          setLastUpdated(formatTimestamp(latest.createdAt));
          setConnectionStatus('Streaming live data');
        } else {
          setConnectionStatus('Connected, waiting for Arduino');
        }
      } catch (error) {
        if (!active) {
          return;
        }

        setConnectionStatus('History unavailable');
        setLastUpdated(error.message);
      }
    }

    loadInitialReadings();

    const socket = io({
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
      if (!active) {
        return;
      }

      setConnectionStatus('Streaming live data');
    });

    socket.on('disconnect', () => {
      if (!active) {
        return;
      }

      setConnectionStatus('Socket disconnected');
    });

    socket.on('sensor:latest', (reading) => {
      if (!active || !reading) {
        return;
      }

      setReadings((current) => clampFeed([...current, reading]));
      setLastUpdated(formatTimestamp(reading.createdAt));
    });

    socket.on('sensor:reading', (reading) => {
      if (!active || !reading) {
        return;
      }

      setReadings((current) => clampFeed([...current, reading]));
      setLastUpdated(formatTimestamp(reading.createdAt));
      setConnectionStatus('Streaming live data');
    });

    socket.on('sensor:error', (payload) => {
      if (!active) {
        return;
      }

      setConnectionStatus('Socket error');
      setLastUpdated(payload?.message || 'Unknown socket error');
    });

    return () => {
      active = false;
      socket.disconnect();
    };
  }, []);

  const latest = readings[readings.length - 1] || null;
  const triggeredSensors = getTriggeredSensors(latest);
  const isAlarmActive = triggeredSensors.length > 0;
  const historyBySensor = SENSOR_KEYS.reduce((result, key) => {
    result[key] = readings
      .map((reading) => ({
        value: reading.sensors[key],
        createdAt: reading.createdAt,
      }))
      .filter((entry) => typeof entry.value === 'number');
    return result;
  }, {});

  useEffect(() => {
    const controller = createAlarmController();
    alarmControllerRef.current = controller;

    if (!controller) {
      return undefined;
    }

    const unlockAudio = () => {
      controller.resume().catch(() => {});
    };

    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio);

    return () => {
      controller.stop();
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, []);

  useEffect(() => {
    const controller = alarmControllerRef.current;

    if (!controller) {
      return;
    }

    if (isAlarmActive) {
      controller.start().catch(() => {});
      return;
    }

    controller.stop();
  }, [isAlarmActive]);

  return (
    <main className="page">
      <section className="hero">
        <div className="hero-title-row">
          <img
            className="hero-logo"
            src="/images/secsa.png"
            alt="SECSA logo"
          />
          <p className="eyebrow">
            Southland College | School of Engineering and Computer Studies
          </p>
        </div>
        <div>
          <h1>Live Wave Monitor</h1>
        </div>
        <p className="subtitle">
          A real-time wave tank monitoring system that transforms ultrasonic sensor data into live, curved visualizations using Node.js, MongoDB, and a responsive MERN stack dashboard.
        </p>
      </section>

      <section className="status-bar">
        <div>
          <span className="status-label">Connection</span>
          <strong>{connectionStatus}</strong>
        </div>
        <div>
          <span className="status-label">Last update</span>
          <strong>{lastUpdated}</strong>
        </div>
      </section>

      {triggeredSensors.length ? (
        <section className="alarm-banner">
          <span className="alarm-dot" />
          <div className="alarm-copy">
            <strong>Low sensor alarm</strong>
            <span>
            {triggeredSensors
              .map(
                (key) =>
                  `${SENSOR_META[key].label} at ${formatValue(latest.sensors[key])}`
              )
              .join(' • ')}
            {` (threshold: ${LOW_SENSOR_THRESHOLD} and below)`}
            </span>
          </div>
        </section>
      ) : null}

      <section className="chart-panel">
        <div className="chart-panel-header">
          <div>
            <p className="sensor-label">Overlapping waves</p>
            <h2 className="chart-title">Smooth live sensor graph</h2>
          </div>
          <div className="legend">
            {[...SENSOR_KEYS, 'average'].map((key) => (
              <span key={key} className="legend-item">
                <span
                  className="legend-swatch"
                  style={{ backgroundColor: SENSOR_META[key].color }}
                />
                {SENSOR_META[key].label}
              </span>
            ))}
          </div>
        </div>

        <div className="control-row">
          {SENSOR_KEYS.map((key) => (
            <label key={key} className="toggle">
              <input
                type="checkbox"
                checked={visibleSensors[key]}
                onChange={(event) =>
                  setVisibleSensors((current) => ({
                    ...current,
                    [key]: event.target.checked,
                  }))
                }
              />
              <span>{SENSOR_META[key].label}</span>
            </label>
          ))}

          <label className="toggle toggle-average">
            <input
              type="checkbox"
              checked={showAverage}
              onChange={(event) => setShowAverage(event.target.checked)}
            />
            <span>Average wave</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={showValueLabels}
              onChange={(event) => setShowValueLabels(event.target.checked)}
            />
            <span>Wave labels</span>
          </label>
        </div>

        <WaveChart
          readings={readings}
          visibleSensors={visibleSensors}
          showAverage={showAverage}
          showValueLabels={showValueLabels}
        />
      </section>

      <section className="sensor-grid">
        {SENSOR_KEYS.map((sensorKey) => (
          <SensorCard
            key={sensorKey}
            sensorKey={sensorKey}
            latest={latest?.sensors?.[sensorKey]}
            history={historyBySensor[sensorKey] || []}
            enabled={visibleSensors[sensorKey]}
            isAlarmed={triggeredSensors.includes(sensorKey)}
          />
        ))}
      </section>
    </main>
  );
}

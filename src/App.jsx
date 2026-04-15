import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { io } from 'socket.io-client';

const SENSOR_KEYS = ['s1', 's2', 's3'];
const SENSOR_META = {
  s1: { label: 'Incident Wave', shortLabel: 'S1', color: '#d74d37' },
  s2: { label: 'Interaction Zone', shortLabel: 'S2', color: '#287271' },
  s3: { label: 'Transmitted Wave', shortLabel: 'S3', color: '#d9a441' },
  average: { label: 'Average', color: '#3e3a39' },
};
const MAX_POINTS = 40;
const REPORT_POINTS = 2000;
const DB_REFRESH_INTERVAL_MS = 15000;
const PAGE_TRANSITION_MS = 180;
const CHART_WIDTH = 960;
const CHART_HEIGHT = 320;
const CHART_PADDING = 24;
const CHART_X_AXIS_HEIGHT = 28;
const LOW_SENSOR_THRESHOLD = 20;
const ALARM_ENABLED = false;
const ROUTES = {
  dashboard: '/',
  trends: '/trends',
};
const THEME_OPTIONS = [
  { key: 'sage', label: 'Sage', swatch: '#9ab29f' },
  { key: 'mist-blue', label: 'Mist Blue', swatch: '#a9c3df' },
  { key: 'lavender', label: 'Lavender', swatch: '#c7b4e7' },
  { key: 'white', label: 'White', swatch: '#f5f7fb' },
  { key: 'black', label: 'Black', swatch: '#1a1c20' },
];
const TREND_METRICS = {
  sensor: {
    label: 'Sensor reading',
    unit: 'cm',
    getValue: (reading, key) => reading?.sensors?.[key],
  },
  waveHeightCm: {
    label: 'Wave height',
    unit: 'cm',
    getValue: (reading, key) => reading?.analytics?.perSensor?.[key]?.waveHeightCm,
  },
  frequencyHz: {
    label: 'Frequency',
    unit: 'Hz',
    getValue: (reading, key) => reading?.analytics?.perSensor?.[key]?.frequencyHz,
  },
  periodSec: {
    label: 'Period',
    unit: 's',
    getValue: (reading, key) => reading?.analytics?.perSensor?.[key]?.periodSec,
  },
};
const TABLE_COLUMN_GROUPS = {
  heights: {
    label: 'Heights',
    columns: [
      { key: 'incidentHeight', label: 'Incident Height' },
      { key: 'interactionHeight', label: 'Interaction Height' },
      { key: 'transmittedHeight', label: 'Transmitted Height' },
    ],
  },
  frequency: {
    label: 'Frequency',
    columns: [
      { key: 'incidentFreq', label: 'Incident Freq' },
      { key: 'interactionFreq', label: 'Interaction Freq' },
      { key: 'transmittedFreq', label: 'Transmitted Freq' },
    ],
  },
  period: {
    label: 'Period',
    columns: [
      { key: 'incidentPeriod', label: 'Incident Period' },
      { key: 'interactionPeriod', label: 'Interaction Period' },
      { key: 'transmittedPeriod', label: 'Transmitted Period' },
    ],
  },
  performance: {
    label: 'Performance Metrics',
    columns: [
      { key: 'reductionEfficiency', label: 'Reduction Eff.' },
      { key: 'transmissionRatio', label: 'Transmission Ratio' },
      { key: 'interactionChange', label: 'Interaction Change' },
    ],
  },
};
const DEFAULT_TABLE_COLUMN_GROUPS = {
  heights: true,
  frequency: false,
  period: false,
  performance: true,
};

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

function formatMetricValue(value, unit = '') {
  const base = formatValue(value);
  return base === '--' ? base : `${base}${unit ? ` ${unit}` : ''}`;
}

function formatRange(range, unit = '') {
  if (!range || typeof range.min !== 'number' || typeof range.max !== 'number') {
    return '--';
  }

  const suffix = unit ? ` ${unit}` : '';
  return `${range.min.toFixed(2)} to ${range.max.toFixed(2)}${suffix}`;
}

function formatTimestamp(value) {
  if (!value) {
    return 'No data yet';
  }

  return new Date(value).toLocaleString();
}

function openNativePicker(event) {
  const input = event.currentTarget;

  if (typeof input.showPicker === 'function') {
    input.showPicker();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getReadingsAtOneSecondInterval(readings) {
  const latestBySecond = new Map();

  readings.forEach((reading) => {
    const createdAt = new Date(reading.createdAt);

    if (Number.isNaN(createdAt.getTime())) {
      return;
    }

    const secondKey = createdAt.toISOString().slice(0, 19);
    latestBySecond.set(secondKey, reading);
  });

  return Array.from(latestBySecond.values());
}

function getTrendTableCellValue(reading, columnKey) {
  if (columnKey === 'timestamp') {
    return formatTimestamp(reading.createdAt);
  }

  if (columnKey === 'incidentHeight') {
    return formatMetricValue(reading.analytics?.perSensor?.s1?.waveHeightCm, 'cm');
  }

  if (columnKey === 'interactionHeight') {
    return formatMetricValue(reading.analytics?.perSensor?.s2?.waveHeightCm, 'cm');
  }

  if (columnKey === 'transmittedHeight') {
    return formatMetricValue(reading.analytics?.perSensor?.s3?.waveHeightCm, 'cm');
  }

  if (columnKey === 'incidentFreq') {
    return formatMetricValue(reading.analytics?.perSensor?.s1?.frequencyHz, 'Hz');
  }

  if (columnKey === 'interactionFreq') {
    return formatMetricValue(reading.analytics?.perSensor?.s2?.frequencyHz, 'Hz');
  }

  if (columnKey === 'transmittedFreq') {
    return formatMetricValue(reading.analytics?.perSensor?.s3?.frequencyHz, 'Hz');
  }

  if (columnKey === 'incidentPeriod') {
    return formatMetricValue(reading.analytics?.perSensor?.s1?.periodSec, 's');
  }

  if (columnKey === 'interactionPeriod') {
    return formatMetricValue(reading.analytics?.perSensor?.s2?.periodSec, 's');
  }

  if (columnKey === 'transmittedPeriod') {
    return formatMetricValue(reading.analytics?.perSensor?.s3?.periodSec, 's');
  }

  if (columnKey === 'reductionEfficiency') {
    return formatMetricValue(reading.analytics?.breakwater?.reductionEfficiencyPct, '%');
  }

  if (columnKey === 'transmissionRatio') {
    return formatValue(reading.analytics?.breakwater?.transmissionRatio);
  }

  if (columnKey === 'interactionChange') {
    return formatMetricValue(reading.analytics?.breakwater?.interactionChangePct, '%');
  }

  return '--';
}

function openTablePdfWindow({
  columns,
  readings,
  reportDate,
  startTime,
  endTime,
}) {
  const exportWindow = window.open('about:blank', '_blank');

  if (!exportWindow) {
    window.alert('Unable to open the print window. Please allow pop-ups and try again.');
    return;
  }

  const summary = [
    reportDate ? `Date: ${reportDate}` : null,
    startTime ? `From: ${startTime}` : null,
    endTime ? `To: ${endTime}` : null,
    `Rows: ${readings.length}`,
  ]
    .filter(Boolean)
    .join(' | ');

  const tableHead = columns
    .map((column) => `<th>${escapeHtml(column.label)}</th>`)
    .join('');
  const tableBody = readings
    .map(
      (reading) =>
        `<tr>${columns
          .map(
            (column) =>
              `<td>${escapeHtml(getTrendTableCellValue(reading, column.key))}</td>`
          )
          .join('')}</tr>`
    )
    .join('');

  exportWindow.document.write(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Wave Trends Table</title>
    <style>
      @page {
        size: landscape;
        margin: 12mm;
      }

      body {
        margin: 24px;
        color: #211b17;
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 28px;
      }
      p {
        margin: 0 0 18px;
        color: #72665c;
        font-size: 14px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      th, td {
        padding: 8px 10px;
        border: 1px solid rgba(33, 27, 23, 0.12);
        text-align: left;
        vertical-align: top;
      }
      th {
        background: #f7f2e8;
      }
      @media print {
        body {
          margin: 0;
        }
      }
    </style>
  </head>
  <body>
    <h1>Wave Trends Table</h1>
    <p>${escapeHtml(summary)}</p>
    <table>
      <thead>
        <tr>${tableHead}</tr>
      </thead>
      <tbody>
        ${tableBody || `<tr><td colspan="${columns.length}">No trend readings yet.</td></tr>`}
      </tbody>
    </table>
  </body>
</html>`);
  exportWindow.document.close();
  exportWindow.focus();
  exportWindow.print();
}

function getLocalDateInputValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function buildDateTimeQueryValue(date, time, fallbackTime) {
  if (!date) {
    return null;
  }

  return `${date}T${time || fallbackTime}`;
}

function buildReportFeedUrl({ date, startTime, endTime }) {
  const params = new URLSearchParams({
    limit: String(REPORT_POINTS),
  });
  const from = buildDateTimeQueryValue(date, startTime, '00:00');
  const to = buildDateTimeQueryValue(date, endTime, '23:59');

  if (from) {
    params.set('from', from);
  }

  if (to) {
    params.set('to', `${to}:59`);
  }

  return `/api/readings/feed?${params.toString()}`;
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function roundMetric(value, digits = 2) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }

  return Number(value.toFixed(digits));
}

function buildSimulatedReading(createdAt, index) {
  const t = index;
  const basePeriodSec = 4.8 + 0.25 * Math.sin(t / 18);
  const frequencyHz = 1 / basePeriodSec;

  const incidentWaveHeight = 368 + 18 * Math.sin(t / 9) + 7 * Math.sin(t / 3.8);
  const interactionWaveHeight =
    incidentWaveHeight * (0.87 + 0.03 * Math.sin(t / 11 + 0.6));
  const transmittedWaveHeight =
    incidentWaveHeight * (0.74 + 0.04 * Math.sin(t / 13 + 1.2));

  const sensorS1 = 4.8 * Math.sin((2 * Math.PI * t) / basePeriodSec) + 0.7 * Math.sin(t / 2.3);
  const sensorS2 =
    4.2 * Math.sin((2 * Math.PI * t) / (basePeriodSec * 0.98) + 0.45) +
    0.6 * Math.sin(t / 2.6);
  const sensorS3 =
    3.5 * Math.sin((2 * Math.PI * t) / (basePeriodSec * 1.04) + 0.9) +
    0.45 * Math.sin(t / 2.9);

  const reductionEfficiencyPct =
    ((incidentWaveHeight - transmittedWaveHeight) / incidentWaveHeight) * 100;
  const transmissionRatio = transmittedWaveHeight / incidentWaveHeight;
  const interactionChangePct =
    ((interactionWaveHeight - incidentWaveHeight) / incidentWaveHeight) * 100;

  return {
    id: `sim-${createdAt.toISOString()}`,
    createdAt: createdAt.toISOString(),
    sensors: {
      s1: roundMetric(sensorS1),
      s2: roundMetric(sensorS2),
      s3: roundMetric(sensorS3),
    },
    analytics: {
      perSensor: {
        s1: {
          amplitudeCm: roundMetric(incidentWaveHeight / 2),
          waveHeightCm: roundMetric(incidentWaveHeight),
          waveHeightBandCm: {
            min: roundMetric(incidentWaveHeight * 0.9),
            max: roundMetric(incidentWaveHeight * 1.1),
          },
          frequencyHz: roundMetric(frequencyHz, 3),
          periodSec: roundMetric(basePeriodSec, 2),
        },
        s2: {
          amplitudeCm: roundMetric(interactionWaveHeight / 2),
          waveHeightCm: roundMetric(interactionWaveHeight),
          waveHeightBandCm: {
            min: roundMetric(interactionWaveHeight * 0.9),
            max: roundMetric(interactionWaveHeight * 1.1),
          },
          frequencyHz: roundMetric(frequencyHz * 1.02, 3),
          periodSec: roundMetric(basePeriodSec * 0.98, 2),
        },
        s3: {
          amplitudeCm: roundMetric(transmittedWaveHeight / 2),
          waveHeightCm: roundMetric(transmittedWaveHeight),
          waveHeightBandCm: {
            min: roundMetric(transmittedWaveHeight * 0.9),
            max: roundMetric(transmittedWaveHeight * 1.1),
          },
          frequencyHz: roundMetric(frequencyHz * 0.97, 3),
          periodSec: roundMetric(basePeriodSec * 1.03, 2),
        },
      },
      breakwater: {
        reductionEfficiencyPct: roundMetric(reductionEfficiencyPct),
        transmissionRatio: roundMetric(transmissionRatio, 3),
        interactionChangePct: roundMetric(interactionChangePct),
      },
    },
  };
}

function buildSimulatedReadings(sampleCount = 180) {
  const readings = [];
  const startTime = new Date(Date.now() - (sampleCount - 1) * 1000);

  for (let index = 0; index < sampleCount; index += 1) {
    const createdAt = new Date(startTime.getTime() + index * 1000);
    readings.push(buildSimulatedReading(createdAt, index));
  }

  return readings;
}

function getRouteFromLocation() {
  const pathname = window.location.pathname || ROUTES.dashboard;
  return pathname === ROUTES.trends ? 'trends' : 'dashboard';
}

function navigateTo(routeKey) {
  const target = ROUTES[routeKey] || ROUTES.dashboard;

  if (window.location.pathname !== target) {
    window.history.pushState({}, '', target);
  }
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

function clampFeed(readings, limit = MAX_POINTS) {
  return readings.slice(-limit);
}

function isSameReading(a, b) {
  if (!a || !b) {
    return false;
  }

  if (a.id && b.id) {
    return a.id === b.id;
  }

  return (
    a.createdAt === b.createdAt &&
    a?.sensors?.s1 === b?.sensors?.s1 &&
    a?.sensors?.s2 === b?.sensors?.s2 &&
    a?.sensors?.s3 === b?.sensors?.s3
  );
}

function appendUniqueReading(current, incoming, limit = MAX_POINTS) {
  if (!incoming) {
    return current;
  }

  if (current.some((reading) => isSameReading(reading, incoming))) {
    return current;
  }

  return clampFeed([...current, incoming], limit);
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

function buildMetricAverageSeries(readings, visibleSensors, getMetricValue) {
  const included = SENSOR_KEYS.filter((key) => visibleSensors[key]);

  return readings
    .map((reading) => {
      if (!included.length) {
        return null;
      }

      const values = included
        .map((key) => getMetricValue(reading, key))
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

function buildTrendSeries(readings, metricKey) {
  const metric = TREND_METRICS[metricKey];

  return SENSOR_KEYS.reduce((result, sensorKey) => {
    result[sensorKey] = readings
      .map((reading) => ({
        createdAt: reading.createdAt,
        value: metric.getValue(reading, sensorKey),
      }))
      .filter((entry) => typeof entry.value === 'number');

    return result;
  }, {});
}

function getSmoothPath(points) {
  if (!points.length) {
    return '';
  }

  if (points.length === 1) {
    const startX = Math.max(points[0].x - 18, CHART_PADDING);
    const endX = Math.min(points[0].x + 18, CHART_WIDTH - CHART_PADDING);
    return `M ${startX} ${points[0].y} L ${endX} ${points[0].y}`;
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
  const innerHeight = CHART_HEIGHT - CHART_PADDING * 2 - CHART_X_AXIS_HEIGHT;

  return (
    CHART_HEIGHT -
    CHART_PADDING -
    CHART_X_AXIS_HEIGHT -
    ((value - minValue) / range) * innerHeight
  );
}

function ChartEmpty({ message }) {
  return <div className="chart-empty">{message}</div>;
}

function getChartGradientId(label, key) {
  const safeLabel = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return `${safeLabel || 'chart'}-${key}-gradient`;
}

function getValueLabelPosition(lastPoint) {
  const preferredX = lastPoint.x + 10;
  const maxX = CHART_WIDTH - 12;
  const nearRightEdge = preferredX > CHART_WIDTH - 120;

  return {
    x: nearRightEdge ? maxX : Math.min(preferredX, maxX),
    y: Math.max(lastPoint.y - 10, 16),
    textAnchor: nearRightEdge ? 'end' : 'start',
  };
}

function formatHourLabel(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleTimeString([], {
    hour: 'numeric',
    hour12: true,
  });
}

function buildTimeAxisLabels(series) {
  if (!series.length) {
    return [];
  }

  const labelCount = Math.min(5, series.length);

  return Array.from({ length: labelCount }, (_, index) => {
    const seriesIndex =
      labelCount === 1
        ? series.length - 1
        : Math.round((index / (labelCount - 1)) * (series.length - 1));
    const entry = series[seriesIndex];

    return {
      key: `${entry.createdAt}-${seriesIndex}`,
      x:
        CHART_PADDING +
        ((CHART_WIDTH - CHART_PADDING * 2) / Math.max(series.length - 1, 1)) *
          seriesIndex,
      label: formatHourLabel(entry.createdAt),
    };
  });
}

function LineChart({ seriesMap, label, emptyMessage, showValueLabels = true }) {
  const activeKeys = Object.keys(seriesMap).filter((key) => (seriesMap[key] || []).length);
  const hasAverageSeries = activeKeys.includes('average');

  if (!activeKeys.length) {
    return <ChartEmpty message={emptyMessage} />;
  }

  const longestSeriesLength = Math.max(
    ...activeKeys.map((key) => seriesMap[key].length),
    1
  );
  const allValues = activeKeys.flatMap((key) =>
    seriesMap[key].map((entry) => entry.value)
  );
  const minValue = Math.min(...allValues);
  const maxValue = Math.max(...allValues);
  const range = maxValue - minValue || 1;
  const innerWidth = CHART_WIDTH - CHART_PADDING * 2;
  const innerHeight = CHART_HEIGHT - CHART_PADDING * 2 - CHART_X_AXIS_HEIGHT;
  const scaleLabels = Array.from({ length: 4 }, (_, index) => {
    const ratio = 1 - index / 3;
    const value = minValue + range * ratio;
    const y = CHART_PADDING + (innerHeight / 3) * index;

    return { value, y };
  });
  const xStep = Math.max(innerWidth / Math.max(longestSeriesLength - 1, 1), 1);
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
  const guideLines = Array.from({ length: 4 }, (_, index) => ({
    y: CHART_PADDING + (innerHeight / 3) * index,
  }));
  const referenceSeries =
    chartPaths.reduce((selected, entry) => {
      const currentSeries = seriesMap[entry.key] || [];

      if (!selected || currentSeries.length > selected.length) {
        return currentSeries;
      }

      return selected;
    }, null) || [];
  const timeAxisLabels = buildTimeAxisLabels(referenceSeries);
  const xAxisY = CHART_HEIGHT - CHART_PADDING;

  return (
    <div className="chart-shell">
      <svg
        className="wave-chart"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        role="img"
        aria-label={label}
      >
        <defs>
          {chartPaths.map((entry) => (
            <linearGradient
              key={`${entry.key}-gradient`}
              id={getChartGradientId(label, entry.key)}
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

        <line
          className="chart-guide"
          x1={CHART_PADDING}
          x2={CHART_WIDTH - CHART_PADDING}
          y1={xAxisY - CHART_X_AXIS_HEIGHT + 8}
          y2={xAxisY - CHART_X_AXIS_HEIGHT + 8}
        />

        {scaleLabels.map((scaleLabel) => (
          <text
            key={`scale-${scaleLabel.y}`}
            x={8}
            y={scaleLabel.y + 4}
            className="chart-scale-label"
          >
            {formatValue(scaleLabel.value)}
          </text>
        ))}

        {timeAxisLabels.map((timeLabel) => (
          <text
            key={timeLabel.key}
            x={timeLabel.x}
            y={xAxisY}
            className="chart-time-label"
            textAnchor="middle"
          >
            {timeLabel.label}
          </text>
        ))}

        {chartPaths.map((entry) => (
          <path
            key={entry.key}
            d={entry.path}
            fill="none"
            stroke={`url(#${getChartGradientId(label, entry.key)})`}
            strokeWidth={entry.key === 'average' ? 3 : 2}
            strokeOpacity={hasAverageSeries && entry.key !== 'average' ? 0.3 : 1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {showValueLabels &&
          chartPaths.map((entry) =>
            entry.lastPoint ? (
              (() => {
                const labelPosition = getValueLabelPosition(entry.lastPoint);

                return (
              <g key={`${entry.key}-value-label`}>
                <circle
                  cx={entry.lastPoint.x}
                  cy={entry.lastPoint.y}
                  r={entry.key === 'average' ? 5.5 : 4.5}
                  fill={entry.color}
                  opacity={hasAverageSeries && entry.key !== 'average' ? 0.55 : 1}
                  className="chart-endpoint"
                />
                <text
                  x={labelPosition.x}
                  y={labelPosition.y}
                  className="chart-value-label"
                  fill={entry.color}
                  opacity={hasAverageSeries && entry.key !== 'average' ? 0.55 : 1}
                  textAnchor={labelPosition.textAnchor}
                >
                  {`${SENSOR_META[entry.key].label}: ${formatValue(entry.latestEntry.value)}`}
                </text>
              </g>
                );
              })()
            ) : null
          )}
      </svg>
    </div>
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

  const activeSeriesMap = Object.fromEntries(
    [...SENSOR_KEYS, ...(showAverage ? ['average'] : [])]
      .filter((key) => key === 'average' || visibleSensors[key])
      .map((key) => [key, seriesMap[key]])
  );

  return (
    <LineChart
      seriesMap={activeSeriesMap}
      label="Live sensor wave chart"
      emptyMessage="Enable at least one sensor to draw the live wave."
      showValueLabels={showValueLabels}
    />
  );
}

function TrendChart({
  readings,
  metricKey,
  visibleSensors,
  showAverage,
  showValueLabels,
}) {
  const metric = TREND_METRICS[metricKey];
  const seriesMap = buildTrendSeries(readings, metricKey);

  if (showAverage) {
    seriesMap.average = buildMetricAverageSeries(
      readings,
      visibleSensors,
      metric.getValue
    );
  }

  const activeSeriesMap = Object.fromEntries(
    [...SENSOR_KEYS, ...(showAverage ? ['average'] : [])]
      .filter((key) => key === 'average' || visibleSensors[key])
      .map((key) => [key, seriesMap[key]])
  );

  return (
    <LineChart
      seriesMap={activeSeriesMap}
      label={`${TREND_METRICS[metricKey].label} trend chart`}
      emptyMessage="Trend data will appear here once enough readings are collected."
      showValueLabels={showValueLabels}
    />
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
          <h2 className="sensor-name">{SENSOR_META[sensorKey].shortLabel}</h2>
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

function ParametersModal({ analytics, onClose }) {
  return createPortal(
    (
    <section
      role="dialog"
      aria-modal="true"
      aria-label="All sensor parameters"
      onClick={onClose}
      className="app-modal-overlay"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="app-modal-panel app-modal-panel-wide"
      >
        <div className="app-modal-header">
          <h2 className="app-modal-title">Breakwater Wave Parameters</h2>
          <button
            type="button"
            className="toggle"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="app-modal-table-wrap">
          <table className="data-table" style={{ minWidth: 640 }}>
            <thead>
              <tr>
                <th>Sensor</th>
                <th>Height (cm)</th>
                <th>Height Band ±10%</th>
                <th>Frequency (Hz)</th>
                <th>Period (s)</th>
              </tr>
            </thead>
            <tbody>
              {SENSOR_KEYS.map((key) => (
                <tr key={`modal-row-${key}`}>
                  <td>{`${SENSOR_META[key].shortLabel} · ${SENSOR_META[key].label}`}</td>
                  <td>{formatValue(analytics?.perSensor?.[key]?.waveHeightCm)}</td>
                  <td>{formatRange(analytics?.perSensor?.[key]?.waveHeightBandCm, 'cm')}</td>
                  <td>{formatValue(analytics?.perSensor?.[key]?.frequencyHz)}</td>
                  <td>{formatValue(analytics?.perSensor?.[key]?.periodSec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="app-modal-footer-note">
          Reduction efficiency: {formatMetricValue(analytics?.breakwater?.reductionEfficiencyPct, '%')} | Transmission ratio: {formatValue(analytics?.breakwater?.transmissionRatio)} | Interaction change: {formatMetricValue(analytics?.breakwater?.interactionChangePct, '%')}
        </p>
      </div>
    </section>
    ),
    document.body
  );
}

function TableColumnsModal({ columnGroups, onClose, onResetDefaults, onToggleGroup }) {
  return createPortal(
    (
    <section
      role="dialog"
      aria-modal="true"
      aria-label="Trend table column controls"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        background: 'rgba(21, 18, 15, 0.58)',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(640px, 100%)',
          maxHeight: '80vh',
          overflowY: 'auto',
          background: 'rgba(255, 253, 248, 0.98)',
          border: '1px solid rgba(33, 27, 23, 0.1)',
          borderRadius: 20,
          boxShadow: '0 24px 70px rgba(26, 15, 9, 0.2)',
          padding: 20,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            marginBottom: 14,
          }}
        >
          <h2 style={{ margin: 0, fontSize: '1.4rem' }}>Trend Table Columns</h2>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="toggle"
              onClick={onResetDefaults}
              style={{ cursor: 'pointer' }}
            >
              Default
            </button>
            <button
              type="button"
              className="toggle"
              onClick={onClose}
              style={{ cursor: 'pointer' }}
            >
              Close
            </button>
          </div>
        </div>

        <div className="table-column-groups">
          {Object.entries(TABLE_COLUMN_GROUPS).map(([groupKey, group]) => (
            <label key={groupKey} className="toggle table-column-toggle">
              <input
                type="checkbox"
                checked={columnGroups[groupKey]}
                onChange={(event) => onToggleGroup(groupKey, event.target.checked)}
              />
              <span>{group.label}</span>
              <span className="table-column-summary">
                {group.columns.map((column) => column.label).join(', ')}
              </span>
            </label>
          ))}
        </div>
      </div>
    </section>
    ),
    document.body
  );
}

function MetricSelect({ value, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef(null);
  const activeMetric = TREND_METRICS[value] || TREND_METRICS.sensor;

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  return (
    <div ref={rootRef} className="metric-select">
      <button
        type="button"
        className="metric-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="metric-select-value">{activeMetric.label}</span>
        <span className={`metric-select-chevron ${isOpen ? 'metric-select-chevron-open' : ''}`}>
          <svg viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M3.25 5.5L7 9.25L10.75 5.5"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.6"
            />
          </svg>
        </span>
      </button>

      {isOpen ? (
        <div className="metric-select-menu" role="listbox" aria-label="Visualization metric">
          {Object.entries(TREND_METRICS).map(([key, metric]) => (
            <button
              key={key}
              type="button"
              role="option"
              aria-selected={value === key}
              className={`metric-select-option ${value === key ? 'metric-select-option-active' : ''}`}
              onClick={() => {
                onChange(key);
                setIsOpen(false);
              }}
            >
              <span>{metric.label}</span>
              <span className="metric-select-unit">{metric.unit}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Navigation({ page, onNavigate }) {
  return (
    <nav className="page-nav" aria-label="Primary navigation">
      <button
        type="button"
        className={`nav-link ${page === 'dashboard' ? 'nav-link-active' : ''}`}
        onClick={() => onNavigate('dashboard')}
      >
        Dashboard
      </button>
      <button
        type="button"
        className={`nav-link ${page === 'trends' ? 'nav-link-active' : ''}`}
        onClick={() => onNavigate('trends')}
      >
        Trends Report
      </button>
    </nav>
  );
}

function ThemePicker({ theme, onThemeChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef(null);
  const activeTheme =
    THEME_OPTIONS.find((option) => option.key === theme) || THEME_OPTIONS[0];

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  return (
    <div ref={rootRef} className="theme-picker" aria-label="Color theme">
      <button
        type="button"
        className="theme-picker-trigger"
        aria-expanded={isOpen}
        aria-label={`Theme: ${activeTheme.label}`}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span
          className="theme-dot theme-dot-active"
          style={{ backgroundColor: activeTheme.swatch }}
        />
      </button>

      {isOpen ? (
        <div className="theme-menu">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`theme-option ${theme === option.key ? 'theme-option-active' : ''}`}
              onClick={() => {
                onThemeChange(option.key);
                setIsOpen(false);
              }}
            >
              <span
                className="theme-dot"
                style={{ backgroundColor: option.swatch }}
              />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TopBar({ page, onNavigate, theme, onThemeChange }) {
  return (
    <header className="top-bar">
      <div className="hero-title-row top-bar-brand">
        <img
          className="hero-logo"
          src="/images/secsa.png"
          alt="SECSA logo"
        />
        <p className="eyebrow">
          Southland College | School of Engineering and Computer Studies
        </p>
      </div>

      <div className="top-bar-actions">
        <ThemePicker theme={theme} onThemeChange={onThemeChange} />
        <Navigation page={page} onNavigate={onNavigate} />
      </div>
    </header>
  );
}

function DashboardPage({
  analytics,
  connectionStatus,
  historyBySensor,
  lastUpdated,
  latest,
  readings,
  showAverage,
  showParametersModal,
  showValueLabels,
  triggeredSensors,
  visibleSensors,
  onCloseModal,
  onOpenModal,
  onToggleAverage,
  onToggleSensor,
  onToggleValueLabels,
}) {
  return (
    <>
      <section className="hero hero-surface">
        <div>
          <h1>Live Wave Monitor</h1>
        </div>
        <p className="subtitle">
          A real-time wave tank monitoring system for comparing incident, interaction-zone, and transmitted wave behavior around a breakwater setup.
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

      <section className="metrics-grid">
        <article className="sensor-card">
          <p className="sensor-label">Incident wave height</p>
          <h3 className="sensor-name">{formatValue(analytics?.perSensor?.s1?.waveHeightCm)} cm</h3>
          <p className="subtitle compact-subtitle">
            {`Sensor: ${SENSOR_META.s1.label}`}
          </p>
        </article>

        <article className="sensor-card">
          <p className="sensor-label">Transmitted wave height</p>
          <h3 className="sensor-name">{formatValue(analytics?.perSensor?.s3?.waveHeightCm)} cm</h3>
          <p className="subtitle compact-subtitle">
            {`Sensor: ${SENSOR_META.s3.label}`}
          </p>
        </article>

        <article className="sensor-card">
          <p className="sensor-label">Reduction efficiency</p>
          <h3 className="sensor-name">{formatMetricValue(analytics?.breakwater?.reductionEfficiencyPct, '%')}</h3>
          <p className="subtitle compact-subtitle">
            Transmission ratio: {formatValue(analytics?.breakwater?.transmissionRatio)}
          </p>
        </article>

        <article className="sensor-card">
          <p className="sensor-label">Interaction zone change</p>
          <h3 className="sensor-name">{formatMetricValue(analytics?.breakwater?.interactionChangePct, '%')}</h3>
          <p className="subtitle compact-subtitle">
            {`Wave height: ${formatMetricValue(analytics?.perSensor?.s2?.waveHeightCm, 'cm')}`}
          </p>
        </article>
      </section>

      <div className="actions-row">
        <button
          type="button"
          className="toggle"
          onClick={onOpenModal}
          style={{ cursor: 'pointer' }}
        >
          View Breakwater Parameters
        </button>
      </div>

      {showParametersModal ? (
        <ParametersModal analytics={analytics} onClose={onCloseModal} />
      ) : null}

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
            <p className="sensor-label">Breakwater monitoring</p>
            <h2 className="chart-title">Live multi-point wave graph</h2>
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
                onChange={(event) => onToggleSensor(key, event.target.checked)}
              />
              <span>{SENSOR_META[key].label}</span>
            </label>
          ))}

          <label className="toggle toggle-average">
            <input
              type="checkbox"
              checked={showAverage}
              onChange={(event) => onToggleAverage(event.target.checked)}
            />
            <span>Average wave</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={showValueLabels}
              onChange={(event) => onToggleValueLabels(event.target.checked)}
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
    </>
  );
}

function TrendsPage({
  connectionStatus,
  isSimulationMode,
  lastUpdated,
  latestAnalytics,
  metricKey,
  readings,
  reportDate,
  startTime,
  endTime,
  isRefreshing,
  showAverage,
  showValueLabels,
  visibleSensors,
  onMetricChange,
  onEndTimeChange,
  onDateChange,
  onRefresh,
  onToggleAverage,
  onToggleSensor,
  onToggleValueLabels,
  onStartTimeChange,
  onSaveTablePdf,
  onStartSimulation,
  onStopSimulation,
}) {
  const tableReadings = getReadingsAtOneSecondInterval(readings);
  const [tablePageSize, setTablePageSize] = useState(10);
  const [tablePage, setTablePage] = useState(1);
  const [showTableColumnsModal, setShowTableColumnsModal] = useState(false);
  const [visibleTableColumnGroups, setVisibleTableColumnGroups] = useState(
    DEFAULT_TABLE_COLUMN_GROUPS
  );
  const totalPages = Math.max(
    1,
    Math.ceil(tableReadings.length / tablePageSize)
  );
  const paginatedTableReadings = tableReadings
    .slice()
    .reverse()
    .slice((tablePage - 1) * tablePageSize, tablePage * tablePageSize);

  useEffect(() => {
    setTablePage(1);
  }, [tablePageSize, readings]);

  useEffect(() => {
    setTablePage((current) => clampNumber(current, 1, totalPages));
  }, [totalPages]);

  const visibleTableColumns = [
    { key: 'timestamp', label: 'Timestamp' },
    ...Object.entries(TABLE_COLUMN_GROUPS).flatMap(([groupKey, group]) =>
      visibleTableColumnGroups[groupKey] ? group.columns : []
    ),
  ];

  return (
    <section className="report-page">
      <section className="hero hero-surface">
        <p className="eyebrow">Historical Analytics</p>
        <h1>Wave Trends Report</h1>
        <p className="subtitle">
          This page turns the modal parameters into a printable trend view with timestamped rows and a visualization for S1, S2, and S3.
        </p>
      </section>

      <section className="status-bar">
        <div>
          <span className="status-label">Connection</span>
          <strong>{connectionStatus}</strong>
        </div>
        <div>
          <span className="status-label">Report updated</span>
          <strong>{lastUpdated}</strong>
        </div>
      </section>

      <section className="metrics-grid">
        <article className="sensor-card">
          <p className="sensor-label">Rows in table</p>
          <h3 className="sensor-name">{paginatedTableReadings.length}</h3>
          <p className="subtitle compact-subtitle">{`Showing ${tablePageSize} rows max per page from ${tableReadings.length} total`}</p>
        </article>
        <article className="sensor-card">
          <p className="sensor-label">Current reduction efficiency</p>
          <h3 className="sensor-name">{formatMetricValue(latestAnalytics?.breakwater?.reductionEfficiencyPct, '%')}</h3>
          <p className="subtitle compact-subtitle">
            Transmission ratio: {formatValue(latestAnalytics?.breakwater?.transmissionRatio)}
          </p>
        </article>
        <article className="sensor-card">
          <p className="sensor-label">Current interaction change</p>
          <h3 className="sensor-name">{formatMetricValue(latestAnalytics?.breakwater?.interactionChangePct, '%')}</h3>
          <p className="subtitle compact-subtitle">
            Selected metric: {TREND_METRICS[metricKey].label}
          </p>
        </article>
      </section>

      <section className="chart-panel report-controls-panel">
        <div className="report-actions">
          <div className="report-filter-grid">
            <label className="report-select">
              <span className="status-label">Visualization metric</span>
              <MetricSelect value={metricKey} onChange={onMetricChange} />
            </label>

            <label className="report-select">
              <span className="status-label">Filter date</span>
              <input
                type="date"
                value={reportDate}
                onChange={(event) => onDateChange(event.target.value)}
                onClick={openNativePicker}
                onFocus={openNativePicker}
              />
            </label>

            <label className="report-select">
              <span className="status-label">From</span>
              <input
                type="time"
                value={startTime}
                onChange={(event) => onStartTimeChange(event.target.value)}
                onClick={openNativePicker}
                onFocus={openNativePicker}
              />
            </label>

            <label className="report-select">
              <span className="status-label">To</span>
              <input
                type="time"
                value={endTime}
                onChange={(event) => onEndTimeChange(event.target.value)}
                onClick={openNativePicker}
                onFocus={openNativePicker}
              />
            </label>
          </div>

          <div className="report-button-row">
            <button
              type="button"
              className="toggle"
              onClick={onRefresh}
              disabled={isSimulationMode}
            >
              {isRefreshing ? 'Fetching DB...' : 'Fetch from Database'}
            </button>

            <button
              type="button"
              className="toggle"
              onClick={isSimulationMode ? onStopSimulation : onStartSimulation}
            >
              {isSimulationMode ? 'Return to Live Data' : 'Load Simulated Trends'}
            </button>

            <button
              type="button"
              className="toggle"
              onClick={() =>
                onSaveTablePdf({
                  columns: visibleTableColumns,
                  readings: tableReadings.slice().reverse(),
                })
              }
            >
              Print - PDF
            </button>
          </div>
        </div>
      </section>

      <section className="chart-panel">
        <div className="chart-panel-header">
          <div>
            <p className="sensor-label">Visualization</p>
            <h2 className="chart-title">
              {TREND_METRICS[metricKey].label} trend
            </h2>
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
            <label key={`trend-${key}`} className="toggle">
              <input
                type="checkbox"
                checked={visibleSensors[key]}
                onChange={(event) => onToggleSensor(key, event.target.checked)}
              />
              <span>{SENSOR_META[key].label}</span>
            </label>
          ))}

          <label className="toggle toggle-average">
            <input
              type="checkbox"
              checked={showAverage}
              onChange={(event) => onToggleAverage(event.target.checked)}
            />
            <span>Average trend</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={showValueLabels}
              onChange={(event) => onToggleValueLabels(event.target.checked)}
            />
            <span>Trend labels</span>
          </label>
        </div>

        <TrendChart
          readings={readings}
          metricKey={metricKey}
          visibleSensors={visibleSensors}
          showAverage={showAverage}
          showValueLabels={showValueLabels}
        />
      </section>

      <section className="chart-panel report-table-panel">
        <div className="chart-panel-header">
          <div>
            <p className="sensor-label">Trend table</p>
            <h2 className="chart-title">Timestamped breakwater parameters</h2>
          </div>
          <div className="table-controls">
            <button
              type="button"
              className="toggle"
              onClick={() => setShowTableColumnsModal(true)}
            >
              Table Columns
            </button>

            <label className="report-select table-page-size">
              <span className="status-label">Rows per page</span>
              <select
                value={tablePageSize}
                onChange={(event) => setTablePageSize(Number(event.target.value))}
              >
                <option value="10">10</option>
                <option value="20">20</option>
              </select>
            </label>

            <div className="table-pagination">
              <span className="status-label">{`Page ${tablePage} of ${totalPages}`}</span>
              <button
                type="button"
                className="toggle"
                onClick={() => setTablePage((current) => Math.max(1, current - 1))}
                disabled={tablePage <= 1}
              >
                Previous
              </button>
              <button
                type="button"
                className="toggle"
                onClick={() =>
                  setTablePage((current) => Math.min(totalPages, current + 1))
                }
                disabled={tablePage >= totalPages}
              >
                Next
              </button>
            </div>
          </div>
        </div>

        <div className="table-wrap">
          <table className="data-table report-table">
            <thead>
              <tr>
                {visibleTableColumns.map((column) => (
                  <th key={column.key}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginatedTableReadings.length ? (
                paginatedTableReadings.map((reading) => (
                    <tr key={reading.id || reading.createdAt}>
                      {visibleTableColumns.map((column) => {
                        return <td key={column.key}>{getTrendTableCellValue(reading, column.key)}</td>;
                      })}
                    </tr>
                  ))
              ) : (
                <tr>
                  <td colSpan={visibleTableColumns.length}>No trend readings yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {showTableColumnsModal ? (
        <TableColumnsModal
          columnGroups={visibleTableColumnGroups}
          onClose={() => setShowTableColumnsModal(false)}
          onResetDefaults={() =>
            setVisibleTableColumnGroups(DEFAULT_TABLE_COLUMN_GROUPS)
          }
          onToggleGroup={(groupKey, checked) =>
            setVisibleTableColumnGroups((current) => ({
              ...current,
              [groupKey]: checked,
            }))
          }
        />
      ) : null}
    </section>
  );
}

export default function App() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('ce-theme') || 'sage';
    } catch {
      return 'sage';
    }
  });
  const [page, setPage] = useState(() => getRouteFromLocation());
  const [renderedPage, setRenderedPage] = useState(() => getRouteFromLocation());
  const [pageTransitionStage, setPageTransitionStage] = useState('idle');
  const [readings, setReadings] = useState([]);
  const [reportReadings, setReportReadings] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [isSimulationMode, setIsSimulationMode] = useState(false);
  const [trendMetric, setTrendMetric] = useState('sensor');
  const [reportDate, setReportDate] = useState(() => getLocalDateInputValue());
  const [reportStartTime, setReportStartTime] = useState('00:00');
  const [reportEndTime, setReportEndTime] = useState('23:59');
  const [showParametersModal, setShowParametersModal] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('Connecting...');
  const [lastUpdated, setLastUpdated] = useState('Waiting for data');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [visibleSensors, setVisibleSensors] = useState({
    s1: true,
    s2: true,
    s3: true,
  });
  const [showAverage, setShowAverage] = useState(false);
  const [showValueLabels, setShowValueLabels] = useState(false);
  const alarmControllerRef = useRef(null);
  const reportReadingsRef = useRef([]);
  const reportFiltersRef = useRef({
    date: getLocalDateInputValue(),
    startTime: '00:00',
    endTime: '23:59',
  });
  const simulationModeRef = useRef(false);
  const pageTransitionTimerRef = useRef(null);

  useEffect(() => {
    document.body.dataset.theme = theme;

    try {
      localStorage.setItem('ce-theme', theme);
    } catch {
      // Ignore storage failures and keep the in-memory theme.
    }
  }, [theme]);

  useEffect(() => {
    reportReadingsRef.current = reportReadings;
  }, [reportReadings]);

  useEffect(() => {
    simulationModeRef.current = isSimulationMode;
  }, [isSimulationMode]);

  useEffect(() => {
    reportFiltersRef.current = {
      date: reportDate,
      startTime: reportStartTime,
      endTime: reportEndTime,
    };
  }, [reportDate, reportStartTime, reportEndTime]);

  useEffect(() => {
    if (page === renderedPage) {
      setPageTransitionStage('idle');
      return undefined;
    }

    setPageTransitionStage('exit');

    pageTransitionTimerRef.current = window.setTimeout(() => {
      setRenderedPage(page);
      setPageTransitionStage('enter');

      pageTransitionTimerRef.current = window.setTimeout(() => {
        setPageTransitionStage('idle');
        pageTransitionTimerRef.current = null;
      }, PAGE_TRANSITION_MS);
    }, PAGE_TRANSITION_MS);

    return () => {
      if (pageTransitionTimerRef.current) {
        window.clearTimeout(pageTransitionTimerRef.current);
        pageTransitionTimerRef.current = null;
      }
    };
  }, [page, renderedPage]);

  useEffect(() => {
    const syncRoute = () => {
      setPage(getRouteFromLocation());
      setShowParametersModal(false);
    };

    window.addEventListener('popstate', syncRoute);
    return () => window.removeEventListener('popstate', syncRoute);
  }, []);

  async function syncReadingsFromDatabase(options = {}) {
    const {
      silent = false,
      reportDate: nextReportDate = reportFiltersRef.current.date,
      reportStartTime: nextReportStartTime = reportFiltersRef.current.startTime,
      reportEndTime: nextReportEndTime = reportFiltersRef.current.endTime,
    } = options;

    if (!silent) {
      setIsRefreshing(true);
    }

    try {
      const [dashboardResponse, reportResponse] = await Promise.all([
        fetch(`/api/readings/feed?limit=${MAX_POINTS}`),
        fetch(
          buildReportFeedUrl({
            date: nextReportDate,
            startTime: nextReportStartTime,
            endTime: nextReportEndTime,
          })
        ),
      ]);

      if (!dashboardResponse.ok || !reportResponse.ok) {
        throw new Error('Failed to load reading history');
      }

      const [dashboardPayload, reportPayload] = await Promise.all([
        dashboardResponse.json(),
        reportResponse.json(),
      ]);

      const dashboardReadings = clampFeed(dashboardPayload.readings || [], MAX_POINTS);
      const fullReportReadings = clampFeed(reportPayload.readings || [], REPORT_POINTS);

      setReadings(dashboardReadings);
      setReportReadings(fullReportReadings);

      if (fullReportReadings.length) {
        const latestReading = fullReportReadings[fullReportReadings.length - 1];
        setAnalytics(latestReading.analytics || null);
        setLastUpdated(formatTimestamp(latestReading.createdAt));
        setConnectionStatus('Showing saved database readings');
      } else {
        setConnectionStatus('No saved records found for the selected date and time range');
      }
    } catch (error) {
      setConnectionStatus('History unavailable');
      setLastUpdated(error.message);
    } finally {
      if (!silent) {
        setIsRefreshing(false);
      }
    }
  }

  useEffect(() => {
    let active = true;

    const guardedSync = async (options = {}) => {
      if (!active || simulationModeRef.current) {
        return;
      }

      await syncReadingsFromDatabase(options);
    };

    guardedSync();
    const refreshTimerId = window.setInterval(
      () => {
        guardedSync({ silent: true });
      },
      DB_REFRESH_INTERVAL_MS
    );

    const socket = io({
      transports: ['polling'],
    });

    socket.on('connect', () => {
      if (!active) {
        return;
      }

      setConnectionStatus((current) =>
        current === 'Streaming live data' ? current : 'Connected to server'
      );
    });

    socket.on('disconnect', () => {
      if (!active) {
        return;
      }

      setConnectionStatus(
        reportReadingsRef.current.length
          ? 'Live stream unavailable, showing saved database data'
          : 'Socket disconnected'
      );
    });

    socket.on('sensor:latest', (reading) => {
      if (!active || !reading) {
        return;
      }

      if (simulationModeRef.current) {
        return;
      }

      setReadings((current) => appendUniqueReading(current, reading, MAX_POINTS));
      setReportReadings((current) => appendUniqueReading(current, reading, REPORT_POINTS));
      setAnalytics(reading.analytics || null);
      setLastUpdated(formatTimestamp(reading.createdAt));
    });

    socket.on('sensor:reading', (reading) => {
      if (!active || !reading) {
        return;
      }

      if (simulationModeRef.current) {
        return;
      }

      setReadings((current) => appendUniqueReading(current, reading, MAX_POINTS));
      setReportReadings((current) => appendUniqueReading(current, reading, REPORT_POINTS));
      setAnalytics(reading.analytics || null);
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
      window.clearInterval(refreshTimerId);
      socket.disconnect();
    };
  }, []);

  const latest = readings[readings.length - 1] || null;
  const triggeredSensors = ALARM_ENABLED ? getTriggeredSensors(latest) : [];
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

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') {
        setShowParametersModal(false);
      }
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  const handleNavigate = (nextPage) => {
    navigateTo(nextPage);
    setPage(nextPage);
    setShowParametersModal(false);
  };

  const handleStartSimulation = () => {
    const simulatedReadings = buildSimulatedReadings();
    const latestReading = simulatedReadings[simulatedReadings.length - 1] || null;

    setIsSimulationMode(true);
    setTrendMetric('waveHeightCm');
    setReadings(clampFeed(simulatedReadings, MAX_POINTS));
    setReportReadings(clampFeed(simulatedReadings, REPORT_POINTS));
    setAnalytics(latestReading?.analytics || null);
    setConnectionStatus('Showing simulated trend data');
    setLastUpdated(latestReading ? formatTimestamp(latestReading.createdAt) : 'Simulation ready');
    setPage('trends');
    navigateTo('trends');
  };

  const handleStopSimulation = () => {
    setIsSimulationMode(false);
    syncReadingsFromDatabase({
      reportDate,
      reportStartTime,
      reportEndTime,
    });
  };

  return (
    <main className="page">
      <TopBar
        page={page}
        onNavigate={handleNavigate}
        theme={theme}
        onThemeChange={setTheme}
      />

      <div className={`route-shell route-shell-${pageTransitionStage}`}>
        {renderedPage === 'trends' ? (
          <TrendsPage
            connectionStatus={connectionStatus}
            isSimulationMode={isSimulationMode}
            lastUpdated={lastUpdated}
            latestAnalytics={analytics}
            metricKey={trendMetric}
            readings={reportReadings}
            reportDate={reportDate}
            startTime={reportStartTime}
            endTime={reportEndTime}
            isRefreshing={isRefreshing}
            showAverage={showAverage}
            showValueLabels={showValueLabels}
            visibleSensors={visibleSensors}
            onMetricChange={setTrendMetric}
            onDateChange={setReportDate}
            onStartTimeChange={setReportStartTime}
            onEndTimeChange={setReportEndTime}
            onRefresh={() =>
              syncReadingsFromDatabase({
                reportDate,
                reportStartTime,
                reportEndTime,
              })
            }
            onToggleAverage={setShowAverage}
            onToggleSensor={(key, checked) =>
              setVisibleSensors((current) => ({
                ...current,
                [key]: checked,
              }))
            }
            onToggleValueLabels={setShowValueLabels}
            onSaveTablePdf={({ columns, readings }) =>
              openTablePdfWindow({
                columns,
                readings,
                reportDate,
                startTime: reportStartTime,
                endTime: reportEndTime,
              })
            }
            onStartSimulation={handleStartSimulation}
            onStopSimulation={handleStopSimulation}
          />
        ) : (
          <DashboardPage
            analytics={analytics}
            connectionStatus={connectionStatus}
            historyBySensor={historyBySensor}
            lastUpdated={lastUpdated}
            latest={latest}
            readings={readings}
            showAverage={showAverage}
            showParametersModal={showParametersModal}
            showValueLabels={showValueLabels}
            triggeredSensors={triggeredSensors}
            visibleSensors={visibleSensors}
            onCloseModal={() => setShowParametersModal(false)}
            onOpenModal={() => setShowParametersModal(true)}
            onToggleAverage={setShowAverage}
            onToggleSensor={(key, checked) =>
              setVisibleSensors((current) => ({
                ...current,
                [key]: checked,
              }))
            }
            onToggleValueLabels={setShowValueLabels}
          />
        )}
      </div>
    </main>
  );
}

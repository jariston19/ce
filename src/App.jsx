import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { TimePicker } from '@mui/x-date-pickers/TimePicker';
import dayjs from 'dayjs';
import { io } from 'socket.io-client';

const SENSOR_KEYS = ['s1', 's2', 's3'];
const SENSOR_META = {
  s1: { label: 'Sensor 1', shortLabel: 'S1', color: '#d62828' },
  s2: { label: 'Sensor 2', shortLabel: 'S2', color: '#111111' },
  s3: { label: 'Sensor 3', shortLabel: 'S3', color: '#ffffff' },
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
const MUI_THEME_TOKENS = {
  sage: {
    mode: 'light',
    primary: '#223127',
    secondary: '#6b7f71',
    paper: '#fcfffb',
    modal: '#fffdf8',
    line: 'rgba(34, 49, 39, 0.08)',
    modalBorder: 'rgba(33, 27, 23, 0.1)',
  },
  'mist-blue': {
    mode: 'light',
    primary: '#1a2733',
    secondary: '#64778b',
    paper: '#ffffff',
    modal: '#fbfeff',
    line: 'rgba(26, 39, 51, 0.08)',
    modalBorder: 'rgba(26, 39, 51, 0.1)',
  },
  lavender: {
    mode: 'light',
    primary: '#2f2540',
    secondary: '#7d7390',
    paper: '#ffffff',
    modal: '#fffcff',
    line: 'rgba(47, 37, 64, 0.08)',
    modalBorder: 'rgba(47, 37, 64, 0.1)',
  },
  white: {
    mode: 'light',
    primary: '#1f2730',
    secondary: '#6d7782',
    paper: '#ffffff',
    modal: '#ffffff',
    line: 'rgba(31, 39, 48, 0.08)',
    modalBorder: 'rgba(31, 39, 48, 0.1)',
  },
  black: {
    mode: 'dark',
    primary: '#eef1f5',
    secondary: '#b0b6c1',
    paper: '#373c45',
    modal: '#292d34',
    line: 'rgba(238, 241, 245, 0.08)',
    modalBorder: 'rgba(238, 241, 245, 0.08)',
  },
};
const TREND_METRICS = {
  sensor: {
    label: 'Actual height',
    unit: 'cm',
    getValue: (reading, key) => getDisplayedHeightCm(reading?.sensors?.[key]),
  },
  displacement: {
    label: 'Displacement',
    unit: 'cm',
    getValue: (reading, key) =>
      reading?.analytics?.perSensor?.[key]?.currentDisplacementCm,
  },
};
const TABLE_COLUMN_GROUPS = {
  actualHeights: {
    label: 'Actual Heights',
    columns: [
      { key: 'incidentActualHeight', label: 'Sensor 1 Height' },
      { key: 'interactionActualHeight', label: 'Sensor 2 Height' },
      { key: 'transmittedActualHeight', label: 'Sensor 3 Height' },
    ],
  },
  displacement: {
    label: 'Displacement',
    columns: [
      { key: 'incidentDisplacement', label: 'Sensor 1 Disp.' },
      { key: 'interactionDisplacement', label: 'Sensor 2 Disp.' },
      { key: 'transmittedDisplacement', label: 'Sensor 3 Disp.' },
    ],
  },
  extrema: {
    label: 'Extrema',
    columns: [
      { key: 'incidentMaxCrest', label: 'Sensor 1 Max Crest' },
      { key: 'incidentMaxTrough', label: 'Sensor 1 Max Trough' },
      { key: 'incidentSpan', label: 'Sensor 1 Span' },
      { key: 'interactionMaxCrest', label: 'Sensor 2 Max Crest' },
      { key: 'interactionMaxTrough', label: 'Sensor 2 Max Trough' },
      { key: 'interactionSpan', label: 'Sensor 2 Span' },
      { key: 'transmittedMaxCrest', label: 'Sensor 3 Max Crest' },
      { key: 'transmittedMaxTrough', label: 'Sensor 3 Max Trough' },
      { key: 'transmittedSpan', label: 'Sensor 3 Span' },
    ],
  },
};
const DEFAULT_TABLE_COLUMN_GROUPS = {
  actualHeights: true,
  displacement: true,
  extrema: false,
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

function formatSignedValue(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '--';
  }

  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

function formatSignedMetricValue(value, unit = '') {
  const base = formatSignedValue(value);
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

function parseDateInputValue(value) {
  if (!value) {
    return null;
  }

  const [year, month, day] = value.split('-').map(Number);

  if (!year || !month || !day) {
    return null;
  }

  return new Date(year, month - 1, day);
}

function formatDateInputValue(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return '';
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateStringToDayjs(value) {
  if (!value) {
    return null;
  }

  const parsed = dayjs(value, 'YYYY-MM-DD', true);
  return parsed.isValid() ? parsed : null;
}

function parseTimeInputValue(value, anchorDate = new Date()) {
  if (!value) {
    return null;
  }

  const [hours, minutes] = value.split(':').map(Number);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return null;
  }

  const parsed = new Date(anchorDate);
  parsed.setHours(hours, minutes, 0, 0);
  return parsed;
}

function formatTimeInputValue(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return '';
  }

  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function getDisplayedHeightCm(value) {
  return value;
}

function getSensorSystemStatus(calibrationStatus, serialRuntimeStatus) {
  if (serialRuntimeStatus && serialRuntimeStatus.enabled === false) {
    return {
      label: 'Serial disabled',
      detail: serialRuntimeStatus.message || 'Sensors are disabled for this session.',
    };
  }

  if (serialRuntimeStatus && serialRuntimeStatus.connected === false) {
    return {
      label: 'Starting up',
      detail: serialRuntimeStatus.message || 'Waiting for the sensor controller to connect.',
    };
  }

  if (calibrationStatus?.active) {
    if (calibrationStatus.detail) {
      return {
        label: 'Calibrating',
        detail: calibrationStatus.detail,
      };
    }

    if (
      calibrationStatus.phase === 'noise' &&
      typeof calibrationStatus.collected === 'number' &&
      typeof calibrationStatus.targetSamples === 'number'
    ) {
      return {
        label: 'Calibrating',
        detail: `Measuring water noise ${calibrationStatus.collected}/${calibrationStatus.targetSamples} sec`,
      };
    }

    return {
      label: 'Calibrating',
      detail: `Collecting baseline samples ${calibrationStatus.collected}/${calibrationStatus.targetSamples}`,
    };
  }

  if (calibrationStatus?.source === 'raw' && serialRuntimeStatus?.connected) {
    return {
      label: 'Ready',
      detail:
        calibrationStatus.detail ||
        'Raw sensor mode is active. No baseline calibration is applied.',
    };
  }

  if (
    calibrationStatus?.source === 'node' &&
    calibrationStatus?.adaptiveActive
  ) {
    return {
      label: 'Self-calibrating',
      detail:
        calibrationStatus.detail ||
        'The baseline is slowly adapting to long-term water-level drift.',
    };
  }

  if (
    calibrationStatus?.source === 'arduino' &&
    serialRuntimeStatus?.connected &&
    !calibrationStatus?.completedAt
  ) {
    return {
      label: 'Starting up',
      detail: calibrationStatus?.detail || 'Waiting for Arduino calibration status.',
    };
  }

  if (serialRuntimeStatus?.connected) {
    return {
      label: 'Ready',
      detail:
        calibrationStatus?.detail ||
        'Sensors are connected and baseline calibration is complete.',
    };
  }

  return {
    label: 'Waiting',
    detail: 'Awaiting sensor startup status.',
  };
}

function timeStringToDayjs(value) {
  if (!value) {
    return null;
  }

  const parsed = dayjs(value, 'HH:mm', true);
  return parsed.isValid() ? parsed : null;
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

  if (columnKey === 'incidentActualHeight') {
    return formatMetricValue(reading?.sensors?.s1, 'cm');
  }

  if (columnKey === 'interactionActualHeight') {
    return formatMetricValue(reading?.sensors?.s2, 'cm');
  }

  if (columnKey === 'transmittedActualHeight') {
    return formatMetricValue(reading?.sensors?.s3, 'cm');
  }

  if (columnKey === 'incidentDisplacement') {
    return formatMetricValue(reading.analytics?.perSensor?.s1?.currentDisplacementCm, 'cm');
  }

  if (columnKey === 'interactionDisplacement') {
    return formatMetricValue(reading.analytics?.perSensor?.s2?.currentDisplacementCm, 'cm');
  }

  if (columnKey === 'transmittedDisplacement') {
    return formatMetricValue(reading.analytics?.perSensor?.s3?.currentDisplacementCm, 'cm');
  }

  if (columnKey === 'incidentMaxCrest') {
    return formatMetricValue(reading.analytics?.perSensor?.s1?.maxCrestCm, 'cm');
  }

  if (columnKey === 'incidentMaxTrough') {
    return formatMetricValue(reading.analytics?.perSensor?.s1?.maxTroughCm, 'cm');
  }

  if (columnKey === 'incidentSpan') {
    return formatMetricValue(reading.analytics?.perSensor?.s1?.spanCm, 'cm');
  }

  if (columnKey === 'interactionMaxCrest') {
    return formatMetricValue(reading.analytics?.perSensor?.s2?.maxCrestCm, 'cm');
  }

  if (columnKey === 'interactionMaxTrough') {
    return formatMetricValue(reading.analytics?.perSensor?.s2?.maxTroughCm, 'cm');
  }

  if (columnKey === 'interactionSpan') {
    return formatMetricValue(reading.analytics?.perSensor?.s2?.spanCm, 'cm');
  }

  if (columnKey === 'transmittedMaxCrest') {
    return formatMetricValue(reading.analytics?.perSensor?.s3?.maxCrestCm, 'cm');
  }

  if (columnKey === 'transmittedMaxTrough') {
    return formatMetricValue(reading.analytics?.perSensor?.s3?.maxTroughCm, 'cm');
  }

  if (columnKey === 'transmittedSpan') {
    return formatMetricValue(reading.analytics?.perSensor?.s3?.spanCm, 'cm');
  }

  return '--';
}

function buildPrintableTrendSeriesMap({
  readings,
  metricKey,
  visibleSensors,
  showAverage,
}) {
  const metric = TREND_METRICS[metricKey];
  const baseSeriesMap = buildTrendSeries(readings, metricKey);

  if (showAverage) {
    baseSeriesMap.average = buildMetricAverageSeries(
      readings,
      visibleSensors,
      metric.getValue
    );
  }

  return Object.fromEntries(
    [...SENSOR_KEYS, ...(showAverage ? ['average'] : [])]
      .filter((key) => key === 'average' || visibleSensors[key])
      .map((key) => [key, baseSeriesMap[key] || []])
  );
}

function renderPrintableTrendChartMarkup({
  readings,
  metricKey,
  visibleSensors,
  showAverage,
}) {
  const seriesMap = buildPrintableTrendSeriesMap({
    readings,
    metricKey,
    visibleSensors,
    showAverage,
  });
  const activeKeys = Object.keys(seriesMap).filter((key) => (seriesMap[key] || []).length);

  if (!activeKeys.length) {
    return '<div class="print-chart-empty">No trend data available for the selected filters.</div>';
  }

  const hasAverageSeries = activeKeys.includes('average');
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
  const xStep = Math.max(innerWidth / Math.max(longestSeriesLength - 1, 1), 1);
  const guideLines = Array.from({ length: 4 }, (_, index) => ({
    y: CHART_PADDING + (innerHeight / 3) * index,
  }));
  const scaleLabels = Array.from({ length: 4 }, (_, index) => {
    const ratio = 1 - index / 3;
    const value = minValue + range * ratio;
    const y = CHART_PADDING + (innerHeight / 3) * index;

    return { value, y };
  });
  const chartPaths = activeKeys.map((key) => {
    const series = seriesMap[key];
    const points = series.map((entry, index) => ({
      x: CHART_PADDING + xStep * index,
      y: getLabelY(entry.value, minValue, range),
    }));

    return {
      key,
      color: SENSOR_META[key].color,
      path: getSmoothPath(points),
      lastPoint: points[points.length - 1],
      latestEntry: series[series.length - 1],
    };
  });
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
  const chartLabel = `${TREND_METRICS[metricKey].label} trend chart`;
  const chartIdBase = `print-${metricKey}-trend`;

  const defsMarkup = chartPaths
    .map(
      (entry) => `
        <linearGradient
          id="${escapeHtml(getChartGradientId(chartIdBase, entry.key))}"
          x1="0%"
          x2="100%"
          y1="0%"
          y2="0%"
        >
          <stop offset="0%" stop-color="${escapeHtml(entry.color)}" stop-opacity="0.35" />
          <stop offset="50%" stop-color="${escapeHtml(entry.color)}" stop-opacity="1" />
          <stop offset="100%" stop-color="${escapeHtml(entry.color)}" stop-opacity="0.45" />
        </linearGradient>`
    )
    .join('');

  const guideMarkup = guideLines
    .map(
      (line) => `
        <line
          x1="${CHART_PADDING}"
          x2="${CHART_WIDTH - CHART_PADDING}"
          y1="${line.y}"
          y2="${line.y}"
          stroke="rgba(33, 27, 23, 0.16)"
          stroke-width="1"
        />`
    )
    .join('');

  const scaleMarkup = scaleLabels
    .map(
      (scaleLabel) => `
        <text x="8" y="${scaleLabel.y + 4}" fill="#72665c" font-size="11">
          ${escapeHtml(formatValue(scaleLabel.value))}
        </text>`
    )
    .join('');

  const timeMarkup = timeAxisLabels
    .map(
      (timeLabel) => `
        <text
          x="${timeLabel.x}"
          y="${xAxisY}"
          fill="#72665c"
          font-size="11"
          text-anchor="middle"
        >
          ${escapeHtml(timeLabel.label)}
        </text>`
    )
    .join('');

  const pathsMarkup = chartPaths
    .map(
      (entry) => `
        <path
          d="${escapeHtml(entry.path)}"
          fill="none"
          stroke="url(#${escapeHtml(getChartGradientId(chartIdBase, entry.key))})"
          stroke-width="${entry.key === 'average' ? 2.9 : 1.9}"
          stroke-opacity="${hasAverageSeries && entry.key !== 'average' ? 0.34 : 0.98}"
          stroke-linecap="round"
          stroke-linejoin="round"
        />`
    )
    .join('');

  const endpointMarkup = chartPaths
    .filter((entry) => entry.lastPoint)
    .map((entry) => {
      return `
        <circle
          cx="${entry.lastPoint.x}"
          cy="${entry.lastPoint.y}"
          r="${entry.key === 'average' ? 5.5 : 4.5}"
          fill="${escapeHtml(entry.color)}"
          opacity="${hasAverageSeries && entry.key !== 'average' ? 0.55 : 1}"
        />`;
    })
    .join('');

  const legendMarkup = activeKeys
    .map(
      (key) => `
        <span class="print-chart-legend-item">
          <span
            class="print-chart-legend-swatch"
            style="background:${escapeHtml(SENSOR_META[key].color)}"
          ></span>
          ${escapeHtml(SENSOR_META[key].label)}
        </span>`
    )
    .join('');

  return `
    <section class="print-chart-section">
      <div class="print-chart-header">
        <div>
          <h2>${escapeHtml(TREND_METRICS[metricKey].label)} trend</h2>
          <p>Filtered report visualization for the selected time range.</p>
        </div>
        <div class="print-chart-legend">${legendMarkup}</div>
      </div>
      <div class="print-chart-frame">
        <svg
          viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}"
          role="img"
          aria-label="${escapeHtml(chartLabel)}"
        >
          <defs>${defsMarkup}</defs>
          ${guideMarkup}
          <line
            x1="${CHART_PADDING}"
            x2="${CHART_WIDTH - CHART_PADDING}"
            y1="${xAxisY - CHART_X_AXIS_HEIGHT + 8}"
            y2="${xAxisY - CHART_X_AXIS_HEIGHT + 8}"
            stroke="rgba(33, 27, 23, 0.16)"
            stroke-width="1"
          />
          ${scaleMarkup}
          ${timeMarkup}
          ${pathsMarkup}
          ${endpointMarkup}
        </svg>
      </div>
    </section>`;
}

function openTablePdfWindow({
  columns,
  readings,
  reportDate,
  startTime,
  endTime,
  metricKey,
  visibleSensors,
  showAverage,
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
  const chartMarkup = renderPrintableTrendChartMarkup({
    readings,
    metricKey,
    visibleSensors,
    showAverage,
  });

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
      h2 {
        margin: 0 0 6px;
        font-size: 18px;
      }
      .print-chart-section {
        margin: 0 0 24px;
      }
      .print-chart-header {
        display: flex;
        gap: 16px;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: 12px;
      }
      .print-chart-header p {
        margin: 0;
      }
      .print-chart-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 10px 14px;
        justify-content: flex-end;
        max-width: 360px;
      }
      .print-chart-legend-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: #4d4138;
        font-size: 12px;
        font-weight: 600;
      }
      .print-chart-legend-swatch {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 999px;
      }
      .print-chart-frame {
        border: 1px solid rgba(30, 41, 59, 0.12);
        border-radius: 16px;
        padding: 12px;
        background:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.3), transparent 24%),
          radial-gradient(circle at bottom right, rgba(214, 40, 40, 0.08), transparent 34%),
          linear-gradient(180deg, rgba(163, 169, 178, 0.96), rgba(128, 135, 145, 0.96)),
          repeating-linear-gradient(
            90deg,
            rgba(255, 255, 255, 0.2) 0,
            rgba(255, 255, 255, 0.2) 1px,
            transparent 1px,
            transparent 64px
          );
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28);
      }
      .print-chart-frame svg {
        display: block;
        width: 100%;
        height: auto;
      }
      .print-chart-empty {
        margin: 0 0 24px;
        padding: 18px;
        border: 1px solid rgba(33, 27, 23, 0.12);
        border-radius: 16px;
        color: #72665c;
        font-size: 14px;
        background: #fbf7ef;
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
    ${chartMarkup}
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

function buildDateTimeQueryIsoValue(date, time, fallbackTime, options = {}) {
  const { endOfMinute = false } = options;
  const baseValue = buildDateTimeQueryValue(date, time, fallbackTime);

  if (!baseValue) {
    return null;
  }

  const dateTime = new Date(`${baseValue}:${endOfMinute ? '59.999' : '00.000'}`);

  if (Number.isNaN(dateTime.getTime())) {
    return null;
  }

  return dateTime.toISOString();
}

function buildSimulationRange({
  date,
  startTime,
  endTime,
  sampleCount,
}) {
  const defaultDate = getLocalDateInputValue();
  const baseDate = date || defaultDate;
  const startValue = buildDateTimeQueryValue(baseDate, startTime, '00:00');
  const endValue = buildDateTimeQueryValue(baseDate, endTime, '23:59');
  const start = startValue ? new Date(startValue) : new Date(`${defaultDate}T00:00`);
  const end = endValue ? new Date(endValue) : new Date(`${defaultDate}T23:59:59`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    const fallbackStart = new Date(`${defaultDate}T00:00:00`);
    const fallbackEnd = new Date(`${defaultDate}T23:59:59`);
    return {
      start: fallbackStart,
      stepMs: (fallbackEnd.getTime() - fallbackStart.getTime()) / Math.max(sampleCount - 1, 1),
    };
  }

  return {
    start,
    stepMs: (end.getTime() - start.getTime()) / Math.max(sampleCount - 1, 1),
  };
}

function buildReportFeedUrl({ date, startTime, endTime }) {
  const params = new URLSearchParams({
    limit: String(REPORT_POINTS),
  });
  const from = buildDateTimeQueryIsoValue(date, startTime, '00:00');
  const to = buildDateTimeQueryIsoValue(date, endTime, '23:59', {
    endOfMinute: true,
  });

  if (from) {
    params.set('from', from);
  }

  if (to) {
    params.set('to', to);
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

function createEmptyDisplacementAnalytics() {
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

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function createSimulationProfile() {
  return {
    baseLevel: randomBetween(356, 378),
    primaryAmplitude: randomBetween(14, 24),
    secondaryAmplitude: randomBetween(4, 9),
    interactionRatioBase: randomBetween(0.84, 0.9),
    interactionRatioSwing: randomBetween(0.015, 0.04),
    transmittedRatioBase: randomBetween(0.69, 0.79),
    transmittedRatioSwing: randomBetween(0.02, 0.05),
    periodBase: randomBetween(4.3, 5.3),
    periodSwing: randomBetween(0.12, 0.34),
    sensorS1Amplitude: randomBetween(4.1, 5.5),
    sensorS2Amplitude: randomBetween(3.6, 4.8),
    sensorS3Amplitude: randomBetween(2.9, 4.1),
    sensorDrift: randomBetween(0.35, 0.85),
    phaseS2: randomBetween(0.25, 0.7),
    phaseS3: randomBetween(0.65, 1.15),
    freqS2Factor: randomBetween(0.99, 1.03),
    freqS3Factor: randomBetween(0.95, 1.01),
    trendShift: randomBetween(0, Math.PI * 2),
  };
}

function buildSimulatedReading(createdAt, index, profile, extremaState) {
  const t = index;
  const basePeriodSec =
    profile.periodBase + profile.periodSwing * Math.sin(t / 18 + profile.trendShift);

  const displacementS1 =
    profile.sensorS1Amplitude * Math.sin((2 * Math.PI * t) / basePeriodSec) +
    profile.sensorDrift * Math.sin(t / 2.3 + profile.trendShift);
  const displacementS2 =
    profile.sensorS2Amplitude *
      Math.sin((2 * Math.PI * t) / (basePeriodSec * profile.freqS2Factor) + profile.phaseS2) +
    profile.sensorDrift * 0.82 * Math.sin(t / 2.6 + profile.trendShift * 0.8);
  const displacementS3 =
    profile.sensorS3Amplitude *
      Math.sin((2 * Math.PI * t) / (basePeriodSec * profile.freqS3Factor) + profile.phaseS3) +
    profile.sensorDrift * 0.64 * Math.sin(t / 2.9 + profile.trendShift * 0.65);
  const displacements = {
    s1: roundMetric(displacementS1),
    s2: roundMetric(displacementS2),
    s3: roundMetric(displacementS3),
  };

  const analytics = createEmptyDisplacementAnalytics();

  SENSOR_KEYS.forEach((key) => {
    const nextValue = displacements[key];
    const extrema = extremaState[key];
    extrema.maxCrestCm =
      typeof extrema.maxCrestCm === 'number'
        ? Math.max(extrema.maxCrestCm, nextValue)
        : nextValue;
    extrema.maxTroughCm =
      typeof extrema.maxTroughCm === 'number'
        ? Math.min(extrema.maxTroughCm, nextValue)
        : nextValue;

    analytics.perSensor[key] = {
      currentDisplacementCm: nextValue,
      maxCrestCm: roundMetric(extrema.maxCrestCm),
      maxTroughCm: roundMetric(extrema.maxTroughCm),
      spanCm: roundMetric(extrema.maxCrestCm - extrema.maxTroughCm),
    };
  });

  return {
    id: `sim-${createdAt.toISOString()}`,
    createdAt: createdAt.toISOString(),
    sensors: {
      s1: roundMetric(profile.baseLevel - displacements.s1),
      s2: roundMetric(profile.baseLevel - displacements.s2),
      s3: roundMetric(profile.baseLevel - displacements.s3),
    },
    rawSensors: displacements,
    analytics,
  };
}

function buildSimulatedReadings(options = {}) {
  const {
    sampleCount = 180,
    date,
    startTime,
    endTime,
  } = options;
  const readings = [];
  const simulationRange = buildSimulationRange({
    date,
    startTime,
    endTime,
    sampleCount,
  });
  const profile = createSimulationProfile();
  const extremaState = SENSOR_KEYS.reduce((result, key) => {
    result[key] = { maxCrestCm: null, maxTroughCm: null };
    return result;
  }, {});

  for (let index = 0; index < sampleCount; index += 1) {
    const createdAt = new Date(simulationRange.start.getTime() + simulationRange.stepMs * index);
    readings.push(buildSimulatedReading(createdAt, index, profile, extremaState));
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
        .map((key) => getDisplayedHeightCm(reading.sensors[key]))
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

function getAverageAnalyticsMetric(analytics, metricKey) {
  const values = SENSOR_KEYS.map((key) => analytics?.perSensor?.[key]?.[metricKey]).filter(
    (value) => typeof value === 'number'
  );

  if (!values.length) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildSeries(readings, key) {
  return readings
    .map((reading) => ({
      createdAt: reading.createdAt,
      value: getDisplayedHeightCm(reading.sensors[key]),
    }))
    .filter((entry) => typeof entry.value === 'number');
}

function buildDisplacementSeries(readings, key) {
  return readings
    .map((reading) => ({
      createdAt: reading.createdAt,
      value: reading?.analytics?.perSensor?.[key]?.currentDisplacementCm,
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
          <filter id={`${label}-endpoint-glow`} x="-200%" y="-200%" width="400%" height="400%">
            <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="rgba(255,255,255,0.85)" />
          </filter>
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
            className={`chart-line ${entry.key === 'average' ? 'chart-line-average' : 'chart-line-sensor'}`}
            stroke={`url(#${getChartGradientId(label, entry.key)})`}
            strokeWidth={entry.key === 'average' ? 2.9 : 1.9}
            strokeOpacity={hasAverageSeries && entry.key !== 'average' ? 0.34 : 0.98}
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
                  filter={`url(#${label}-endpoint-glow)`}
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
    s1: buildDisplacementSeries(readings, 's1'),
    s2: buildDisplacementSeries(readings, 's2'),
    s3: buildDisplacementSeries(readings, 's3'),
  };

  if (showAverage) {
    seriesMap.average = buildMetricAverageSeries(
      readings,
      visibleSensors,
      (reading, key) => reading?.analytics?.perSensor?.[key]?.currentDisplacementCm
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
      label="Live displacement chart"
      emptyMessage="Enable at least one sensor to draw the live displacement trend."
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
          {isAlarmed ? 'Alarm' : enabled ? 'Active' : 'Disabled'}
        </span>
      </header>

      <div className="sensor-reading">
        <span className="sensor-value">{formatValue(latest)}</span>
      </div>

      <div className="history-block">
        <h3>Actual heights (cm)</h3>
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
          <h2 className="app-modal-title">Displacement Summary</h2>
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
                <th>Current Disp. (cm)</th>
                <th>Max Crest (cm)</th>
                <th>Max Trough (cm)</th>
                <th>Span (cm)</th>
              </tr>
            </thead>
            <tbody>
              {SENSOR_KEYS.map((key) => (
                <tr key={`modal-row-${key}`}>
                  <td>{`${SENSOR_META[key].shortLabel} · ${SENSOR_META[key].label}`}</td>
                  <td>{formatValue(analytics?.perSensor?.[key]?.currentDisplacementCm)}</td>
                  <td>{formatValue(analytics?.perSensor?.[key]?.maxCrestCm)}</td>
                  <td>{formatValue(analytics?.perSensor?.[key]?.maxTroughCm)}</td>
                  <td>{formatValue(analytics?.perSensor?.[key]?.spanCm)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="app-modal-footer-note">
          Average crest: {formatMetricValue(getAverageAnalyticsMetric(analytics, 'maxCrestCm'), 'cm')} | Average trough: {formatMetricValue(getAverageAnalyticsMetric(analytics, 'maxTroughCm'), 'cm')} | Average span: {formatMetricValue(getAverageAnalyticsMetric(analytics, 'spanCm'), 'cm')}
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
      className="app-modal-overlay"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="app-modal-panel"
      >
        <div className="app-modal-header">
          <h2 className="app-modal-title">Trend Table Columns</h2>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="toggle"
              onClick={onResetDefaults}
            >
              Default
            </button>
            <button
              type="button"
              className="toggle"
              onClick={onClose}
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
        Overview
      </button>
      <button
        type="button"
        className={`nav-link ${page === 'trends' ? 'nav-link-active' : ''}`}
        onClick={() => onNavigate('trends')}
      >
        Insights
      </button>
    </nav>
  );
}

function ThemePicker({ theme, onThemeChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const activeTheme =
    THEME_OPTIONS.find((option) => option.key === theme) || THEME_OPTIONS[0];

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      const target = event.target;

      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
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

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const updatePosition = () => {
      const triggerRect = rootRef.current?.getBoundingClientRect();
      const menuWidth = Math.min(180, window.innerWidth - 24);

      if (!triggerRect) {
        return;
      }

      const nextLeft = Math.min(
        Math.max(12, triggerRect.right - menuWidth),
        window.innerWidth - menuWidth - 12
      );
      const nextTop = Math.min(triggerRect.bottom + 10, window.innerHeight - 12);

      setMenuPosition({
        left: nextLeft,
        top: nextTop,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
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
        createPortal(
          <div
            ref={menuRef}
            className="theme-menu theme-menu-portal"
            style={{
              left: `${menuPosition.left}px`,
              top: `${menuPosition.top}px`,
            }}
          >
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
          </div>,
          document.body
        )
      ) : null}
    </div>
  );
}

function FloatingToast({ toast, onClose }) {
  if (!toast) {
    return null;
  }

  return createPortal(
    <div className={`floating-toast floating-toast-${toast.kind || 'info'}`} role="status" aria-live="polite">
      <div className="floating-toast-copy">
        <strong>{toast.title}</strong>
        <span>{toast.message}</span>
      </div>
      <button type="button" className="floating-toast-close" onClick={onClose} aria-label="Dismiss notification">
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.6"
          />
        </svg>
      </button>
    </div>,
    document.body
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
  calibrationStatus,
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
  onRecalibrate,
  onToggleAverage,
  onToggleSensor,
  onToggleValueLabels,
  recalibrationPending,
  serialRuntimeStatus,
}) {
  const averageDisplacement = getAverageAnalyticsMetric(
    analytics,
    'currentDisplacementCm'
  );
  const averageCrest = getAverageAnalyticsMetric(analytics, 'maxCrestCm');
  const averageTrough = getAverageAnalyticsMetric(analytics, 'maxTroughCm');
  const averageSpan = getAverageAnalyticsMetric(analytics, 'spanCm');
  const sensorSystemStatus = getSensorSystemStatus(calibrationStatus, serialRuntimeStatus);
  const showRecalibrateControl =
    calibrationStatus?.source !== 'arduino' &&
    calibrationStatus?.source !== 'raw';

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
        <div>
          <span className="status-label">Sensor status</span>
          <strong>{sensorSystemStatus.label}</strong>
          <span className="status-detail">{sensorSystemStatus.detail}</span>
        </div>
      </section>

      <section className="metrics-grid dashboard-metrics-grid">
        <article className="sensor-card">
          <p className="sensor-label">Sensor 1 displacement</p>
          <h3 className="sensor-name">{formatMetricValue(analytics?.perSensor?.s1?.currentDisplacementCm, 'cm')}</h3>
          <p className="subtitle compact-subtitle">
            {`Sensor: ${SENSOR_META.s1.label}`}
          </p>
        </article>

        <article className="sensor-card">
          <p className="sensor-label">Sensor 2 displacement</p>
          <h3 className="sensor-name">{formatMetricValue(analytics?.perSensor?.s2?.currentDisplacementCm, 'cm')}</h3>
          <p className="subtitle compact-subtitle">
            {`Sensor: ${SENSOR_META.s2.label}`}
          </p>
        </article>

        <article className="sensor-card">
          <p className="sensor-label">Sensor 3   displacement</p>
          <h3 className="sensor-name">{formatMetricValue(analytics?.perSensor?.s3?.currentDisplacementCm, 'cm')}</h3>
          <p className="subtitle compact-subtitle">
            {`Sensor: ${SENSOR_META.s3.label}`}
          </p>
        </article>

        <article className="sensor-card">
          <p className="sensor-label">Average max crest</p>
          <h3 className="sensor-name">{formatMetricValue(averageCrest, 'cm')}</h3>
          <p className="subtitle compact-subtitle">
            Average current displacement: {formatMetricValue(averageDisplacement, 'cm')}
          </p>
        </article>

        <article className="sensor-card">
          <p className="sensor-label">Average max trough</p>
          <h3 className="sensor-name">{formatMetricValue(averageTrough, 'cm')}</h3>
          <p className="subtitle compact-subtitle">
            Average span: {formatMetricValue(averageSpan, 'cm')}
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
          View Displacement Summary
        </button>
        {showRecalibrateControl ? (
          <button
            type="button"
            className="toggle action-button"
            onClick={onRecalibrate}
            disabled={recalibrationPending || calibrationStatus?.active || !serialRuntimeStatus?.connected}
          >
            {recalibrationPending ? 'Recalibrating...' : 'Recalibrate baseline'}
          </button>
        ) : null}
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
                    `${SENSOR_META[key].label} at ${formatValue(
                      getDisplayedHeightCm(latest.sensors[key])
                    )}`
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
            latest={getDisplayedHeightCm(latest?.sensors?.[sensorKey])}
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
          <p className="sensor-label">Average max crest</p>
          <h3 className="sensor-name">{formatMetricValue(getAverageAnalyticsMetric(latestAnalytics, 'maxCrestCm'), 'cm')}</h3>
          <p className="subtitle compact-subtitle">
            Selected metric: {TREND_METRICS[metricKey].label}
          </p>
        </article>
        <article className="sensor-card">
          <p className="sensor-label">Average max trough</p>
          <h3 className="sensor-name">{formatMetricValue(getAverageAnalyticsMetric(latestAnalytics, 'maxTroughCm'), 'cm')}</h3>
          <p className="subtitle compact-subtitle">
            Average span: {formatMetricValue(getAverageAnalyticsMetric(latestAnalytics, 'spanCm'), 'cm')}
          </p>
        </article>
      </section>

      <section className="chart-panel report-controls-panel">
        <div className="report-actions">
          <LocalizationProvider dateAdapter={AdapterDayjs}>
            <div className="report-filter-grid">
              <label className="report-select">
                <span className="status-label">Visualization metric</span>
                <MetricSelect value={metricKey} onChange={onMetricChange} />
              </label>

              <label className="report-select">
                <span className="status-label">Filter date</span>
                <DatePicker
                  value={dateStringToDayjs(reportDate)}
                  format="MM/DD/YYYY"
                  onChange={(nextValue) => {
                    onDateChange(nextValue?.isValid() ? nextValue.format('YYYY-MM-DD') : '');
                  }}
                  slotProps={{
                    textField: {
                      fullWidth: true,
                      size: 'small',
                      className: 'mui-picker-input',
                    },
                  }}
                />
              </label>

              <label className="report-select">
                <span className="status-label">From</span>
                <TimePicker
                  value={timeStringToDayjs(startTime)}
                  format="hh:mm A"
                  onChange={(nextValue) => {
                    onStartTimeChange(nextValue?.isValid() ? nextValue.format('HH:mm') : '');
                  }}
                  slotProps={{
                    textField: {
                      fullWidth: true,
                      size: 'small',
                      className: 'mui-picker-input',
                    },
                  }}
                />
              </label>

              <label className="report-select">
                <span className="status-label">To</span>
                <TimePicker
                  value={timeStringToDayjs(endTime)}
                  format="hh:mm A"
                  onChange={(nextValue) => {
                    onEndTimeChange(nextValue?.isValid() ? nextValue.format('HH:mm') : '');
                  }}
                  slotProps={{
                    textField: {
                      fullWidth: true,
                      size: 'small',
                      className: 'mui-picker-input',
                    },
                  }}
                />
              </label>
            </div>
          </LocalizationProvider>

          <div className="report-button-row">
            <button
              type="button"
              className="toggle"
              onClick={onRefresh}
              disabled={isSimulationMode}
            >
              Fetch from Database
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
                  metricKey,
                  visibleSensors,
                  showAverage,
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
            <h2 className="chart-title">Timestamped displacement records</h2>
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
                <option value="50">50</option>
                <option value="100">100</option>
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
      return localStorage.getItem('ce-theme') || 'black';
    } catch {
      return 'black';
    }
  });
  const [page, setPage] = useState(() => getRouteFromLocation());
  const [renderedPage, setRenderedPage] = useState(() => getRouteFromLocation());
  const [pageTransitionStage, setPageTransitionStage] = useState('idle');
  const [readings, setReadings] = useState([]);
  const [reportReadings, setReportReadings] = useState([]);
  const [analytics, setAnalytics] = useState(createEmptyDisplacementAnalytics);
  const [isSimulationMode, setIsSimulationMode] = useState(false);
  const [trendMetric, setTrendMetric] = useState('displacement');
  const [reportDate, setReportDate] = useState(() => getLocalDateInputValue());
  const [reportStartTime, setReportStartTime] = useState('00:00');
  const [reportEndTime, setReportEndTime] = useState('23:59');
  const [showParametersModal, setShowParametersModal] = useState(false);
  const [calibrationStatus, setCalibrationStatus] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('Connecting...');
  const [lastUpdated, setLastUpdated] = useState('Waiting for data');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [serialRuntimeStatus, setSerialRuntimeStatus] = useState(null);
  const [recalibrationPending, setRecalibrationPending] = useState(false);
  const [toast, setToast] = useState(null);
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

  const muiTheme = useMemo(
    () => {
      const tokens = MUI_THEME_TOKENS[theme] || MUI_THEME_TOKENS.black;

      return createTheme({
        palette: {
          mode: tokens.mode,
          primary: {
            main: tokens.primary,
            contrastText: tokens.paper,
          },
          secondary: {
            main: tokens.secondary,
          },
          text: {
            primary: tokens.primary,
            secondary: tokens.secondary,
          },
          background: {
            default: tokens.paper,
            paper: tokens.paper,
          },
          divider: tokens.line,
        },
        shape: {
          borderRadius: 18,
        },
        typography: {
          fontFamily: 'var(--font-body)',
        },
        components: {
          MuiPaper: {
            styleOverrides: {
              root: {
                backgroundColor: tokens.paper,
                backgroundImage: 'none',
                color: tokens.primary,
                border: `1px solid ${tokens.line}`,
              },
            },
          },
          MuiDialog: {
            styleOverrides: {
              paper: {
                backgroundColor: tokens.modal,
                color: tokens.primary,
                border: `1px solid ${tokens.modalBorder}`,
                boxShadow: 'var(--modal-shadow)',
              },
            },
          },
          MuiPopover: {
            styleOverrides: {
              paper: {
                backgroundColor: tokens.paper,
                color: tokens.primary,
                border: `1px solid ${tokens.line}`,
              },
            },
          },
          MuiPopper: {
            styleOverrides: {
              root: {
                zIndex: 45,
              },
            },
          },
          MuiOutlinedInput: {
            styleOverrides: {
              root: {
                backgroundColor: tokens.paper,
                color: tokens.primary,
                borderRadius: 18,
              },
              notchedOutline: {
                borderColor: tokens.line,
              },
              input: {
                color: tokens.primary,
                fontFamily: 'var(--font-body)',
              },
            },
          },
          MuiInputLabel: {
            styleOverrides: {
              root: {
                color: tokens.secondary,
                fontFamily: 'var(--font-body)',
              },
            },
          },
          MuiIconButton: {
            styleOverrides: {
              root: {
                color: tokens.secondary,
              },
            },
          },
          MuiPickersDay: {
            styleOverrides: {
              root: {
                color: tokens.primary,
                '&:hover': {
                  backgroundColor: 'color-mix(in srgb, currentColor 10%, transparent)',
                },
                '&.Mui-selected': {
                  backgroundColor: 'color-mix(in srgb, currentColor 18%, transparent)',
                  color: tokens.primary,
                },
                '&.Mui-selected:hover': {
                  backgroundColor: 'color-mix(in srgb, currentColor 22%, transparent)',
                },
              },
            },
          },
          MuiMenuItem: {
            styleOverrides: {
              root: {
                color: tokens.primary,
                '&.Mui-selected': {
                  backgroundColor: 'color-mix(in srgb, currentColor 18%, transparent)',
                },
              },
            },
          },
          MuiClockNumber: {
            styleOverrides: {
              root: {
                color: tokens.primary,
              },
            },
          },
        },
      });
    },
    [theme]
  );

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
    if (!toast) {
      return undefined;
    }

    const timerId = window.setTimeout(() => {
      setToast(null);
    }, 3200);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [toast]);

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
      notifyOnEmpty = !silent,
      notifyOnError = !silent,
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
        setAnalytics(latestReading.analytics || createEmptyDisplacementAnalytics());
        setLastUpdated(formatTimestamp(latestReading.createdAt));
        setConnectionStatus('Showing saved database readings');
      } else {
        setAnalytics(createEmptyDisplacementAnalytics());
        setConnectionStatus('No saved records found for the selected date and time range');
        if (notifyOnEmpty) {
          setToast({
            kind: 'warning',
            title: 'No data found',
            message: 'No readings were saved for the selected date and time range.',
          });
        }
      }
    } catch (error) {
      setAnalytics(createEmptyDisplacementAnalytics());
      setConnectionStatus('History unavailable');
      setLastUpdated(error.message);
      if (notifyOnError) {
        setToast({
          kind: 'error',
          title: 'Unable to fetch data',
          message: error.message || 'The selected records could not be loaded right now.',
        });
      }
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

    guardedSync({
      notifyOnEmpty: false,
      notifyOnError: false,
    });
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
      setAnalytics(reading.analytics || createEmptyDisplacementAnalytics());
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
      setAnalytics(reading.analytics || createEmptyDisplacementAnalytics());
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

    socket.on('calibration:status', (status) => {
      if (!active) {
        return;
      }

      setCalibrationStatus(status || null);
    });

    socket.on('serial:status', (status) => {
      if (!active) {
        return;
      }

      setSerialRuntimeStatus(status || null);
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
        value: getDisplayedHeightCm(reading.sensors[key]),
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
    const simulatedReadings = buildSimulatedReadings({
      date: reportDate,
      startTime: reportStartTime,
      endTime: reportEndTime,
    });
    const latestReading = simulatedReadings[simulatedReadings.length - 1] || null;

    setIsSimulationMode(true);
    setTrendMetric('displacement');
    setReadings(clampFeed(simulatedReadings, MAX_POINTS));
    setReportReadings(clampFeed(simulatedReadings, REPORT_POINTS));
    setAnalytics(latestReading?.analytics || createEmptyDisplacementAnalytics());
    setConnectionStatus('Showing simulated trend data');
    setLastUpdated(latestReading ? formatTimestamp(latestReading.createdAt) : 'Simulation ready');
    setPage('trends');
    navigateTo('trends');
  };

  const handleStopSimulation = () => {
    setIsSimulationMode(false);
    setToast(null);
    syncReadingsFromDatabase({
      reportDate,
      reportStartTime,
      reportEndTime,
      notifyOnEmpty: false,
      notifyOnError: false,
    });
  };

  const handleRecalibrate = async () => {
    setRecalibrationPending(true);

    try {
      const response = await fetch('/api/calibration/node/start', {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to restart baseline calibration');
      }

      const payload = await response.json();
      setCalibrationStatus(payload.calibration || null);
      setToast({
        kind: 'info',
        title: 'Calibration restarted',
        message: payload.message || 'The sensors are collecting a fresh baseline now.',
      });
    } catch (error) {
      setToast({
        kind: 'error',
        title: 'Calibration failed',
        message: error.message || 'The baseline could not be restarted right now.',
      });
    } finally {
      setRecalibrationPending(false);
    }
  };

  return (
    <ThemeProvider theme={muiTheme}>
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
            onSaveTablePdf={({ columns, readings, metricKey, visibleSensors, showAverage }) =>
              openTablePdfWindow({
                columns,
                readings,
                reportDate,
                startTime: reportStartTime,
                endTime: reportEndTime,
                metricKey,
                visibleSensors,
                showAverage,
              })
            }
            onStartSimulation={handleStartSimulation}
            onStopSimulation={handleStopSimulation}
            />
          ) : (
            <DashboardPage
            analytics={analytics}
            calibrationStatus={calibrationStatus}
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
            onRecalibrate={handleRecalibrate}
            onToggleAverage={setShowAverage}
            onToggleSensor={(key, checked) =>
              setVisibleSensors((current) => ({
                ...current,
                [key]: checked,
              }))
            }
            onToggleValueLabels={setShowValueLabels}
            recalibrationPending={recalibrationPending}
            serialRuntimeStatus={serialRuntimeStatus}
            />
          )}
        </div>
        <FloatingToast toast={toast} onClose={() => setToast(null)} />
      </main>
    </ThemeProvider>
  );
}

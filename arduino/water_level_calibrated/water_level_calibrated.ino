// Baseline-calibrated 3-sensor ultrasonic sketch
//
// What it does:
// 1. Waits for the water to become stable on startup
// 2. Captures a calm-water baseline for each sensor
// 3. Outputs the live distance delta from that baseline as CSV
// 4. Allows recalibration by sending 'c' over Serial Monitor
//
// Important:
// - If your dashboard alarm currently expects raw distance values,
//   update that threshold logic before using baseline-relative output.

#include <math.h>

const int SENSOR_COUNT = 3;
const int trigPins[SENSOR_COUNT] = {2, 4, 6};
const int echoPins[SENSOR_COUNT] = {3, 5, 7};

const unsigned long SERIAL_BAUD = 9600;
const unsigned long PULSE_TIMEOUT_US = 30000;
const int SENSOR_SETTLE_DELAY_MS = 60;
const int LOOP_DELAY_MS = 200;

// Calibration tuning
const int BASELINE_SAMPLES = 20;
const int STABILITY_WINDOW = 20;
const float STABILITY_THRESHOLD_CM = 0.8f;
const int CALIBRATION_SAMPLE_DELAY_MS = 150;
const float EMA_ALPHA = 0.25f;
const unsigned long NOISE_CALIBRATION_MS = 45000; // 30-60s recommended
const float NOISE_SIGMA_MULTIPLIER = 3.0f;
const float MIN_DEADBAND_CM = 0.12f;
const float MAX_DEADBAND_CM = 0.35f;

// Flip this to -1.0f if you want wave direction inverted.
const float DELTA_SIGN = 1.0f;

float baselineCm[SENSOR_COUNT] = {0.0f, 0.0f, 0.0f};
float sampleWindow[SENSOR_COUNT][STABILITY_WINDOW];
float filteredDeltaCm[SENSOR_COUNT] = {0.0f, 0.0f, 0.0f};
float noiseDeadbandCm[SENSOR_COUNT] = {0.2f, 0.2f, 0.2f};
bool isCalibrated = false;

float applyNoiseFilter(float delta, int sensorIndex) {
  const float deadband = noiseDeadbandCm[sensorIndex];
  float flattened = (fabs(delta) < deadband) ? 0.0f : delta;
  filteredDeltaCm[sensorIndex] =
    (EMA_ALPHA * flattened) + ((1.0f - EMA_ALPHA) * filteredDeltaCm[sensorIndex]);

  if (fabs(filteredDeltaCm[sensorIndex]) < deadband) {
    filteredDeltaCm[sensorIndex] = 0.0f;
  }

  return filteredDeltaCm[sensorIndex];
}

float clampFloat(float value, float minValue, float maxValue) {
  if (value < minValue) {
    return minValue;
  }
  if (value > maxValue) {
    return maxValue;
  }
  return value;
}

float readDistanceCm(int sensorIndex) {
  digitalWrite(trigPins[sensorIndex], LOW);
  delayMicroseconds(2);

  digitalWrite(trigPins[sensorIndex], HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPins[sensorIndex], LOW);

  long duration = pulseIn(echoPins[sensorIndex], HIGH, PULSE_TIMEOUT_US);

  if (duration == 0) {
    return NAN;
  }

  return duration * 0.0343f / 2.0f;
}

bool readAllSensors(float values[SENSOR_COUNT]) {
  for (int i = 0; i < SENSOR_COUNT; i++) {
    values[i] = readDistanceCm(i);

    if (isnan(values[i])) {
      return false;
    }

    delay(SENSOR_SETTLE_DELAY_MS);
  }

  return true;
}

void pushSample(float values[SENSOR_COUNT], int filled) {
  if (filled < STABILITY_WINDOW) {
    for (int sensor = 0; sensor < SENSOR_COUNT; sensor++) {
      sampleWindow[sensor][filled] = values[sensor];
    }
    return;
  }

  for (int sensor = 0; sensor < SENSOR_COUNT; sensor++) {
    for (int index = 1; index < STABILITY_WINDOW; index++) {
      sampleWindow[sensor][index - 1] = sampleWindow[sensor][index];
    }
    sampleWindow[sensor][STABILITY_WINDOW - 1] = values[sensor];
  }
}

float computeAverage(float values[STABILITY_WINDOW]) {
  float total = 0.0f;

  for (int i = 0; i < STABILITY_WINDOW; i++) {
    total += values[i];
  }

  return total / STABILITY_WINDOW;
}

float computeRange(float values[STABILITY_WINDOW]) {
  float minValue = values[0];
  float maxValue = values[0];

  for (int i = 1; i < STABILITY_WINDOW; i++) {
    if (values[i] < minValue) {
      minValue = values[i];
    }
    if (values[i] > maxValue) {
      maxValue = values[i];
    }
  }

  return maxValue - minValue;
}

bool windowIsStable() {
  for (int sensor = 0; sensor < SENSOR_COUNT; sensor++) {
    if (computeRange(sampleWindow[sensor]) > STABILITY_THRESHOLD_CM) {
      return false;
    }
  }

  return true;
}

void printCalibrationSummary() {
  Serial.println("CALIBRATION COMPLETE");

  for (int sensor = 0; sensor < SENSOR_COUNT; sensor++) {
    Serial.print("Baseline s");
    Serial.print(sensor + 1);
    Serial.print(": ");
    Serial.println(baselineCm[sensor], 2);
  }
}

void calibrateNoiseFloor() {
  float mean[SENSOR_COUNT] = {0.0f, 0.0f, 0.0f};
  float m2[SENSOR_COUNT] = {0.0f, 0.0f, 0.0f};
  unsigned long sampleCount = 0;
  unsigned long startMs = millis();
  unsigned long nextProgressMs = startMs + 5000;
  float rawValues[SENSOR_COUNT];

  Serial.println("NOISE CALIBRATION: keep water calm...");

  while (millis() - startMs < NOISE_CALIBRATION_MS) {
    if (!readAllSensors(rawValues)) {
      delay(CALIBRATION_SAMPLE_DELAY_MS);
      continue;
    }

    sampleCount++;

    for (int sensor = 0; sensor < SENSOR_COUNT; sensor++) {
      float delta = (rawValues[sensor] - baselineCm[sensor]) * DELTA_SIGN;
      float diff = delta - mean[sensor];
      mean[sensor] += diff / sampleCount;
      float diff2 = delta - mean[sensor];
      m2[sensor] += diff * diff2;
    }

    if (millis() >= nextProgressMs) {
      unsigned long elapsedSec = (millis() - startMs) / 1000;
      unsigned long targetSec = NOISE_CALIBRATION_MS / 1000;
      Serial.print("NOISE CALIBRATION: ");
      Serial.print(elapsedSec);
      Serial.print("/");
      Serial.print(targetSec);
      Serial.println(" sec");
      nextProgressMs += 5000;
    }
  }

  if (sampleCount < 2) {
    Serial.println("NOISE CALIBRATION: not enough samples, using defaults");
    return;
  }

  for (int sensor = 0; sensor < SENSOR_COUNT; sensor++) {
    float variance = m2[sensor] / (sampleCount - 1);
    float sigma = sqrtf(fabs(variance));
    float calibratedDeadband = clampFloat(
      sigma * NOISE_SIGMA_MULTIPLIER,
      MIN_DEADBAND_CM,
      MAX_DEADBAND_CM
    );
    noiseDeadbandCm[sensor] = calibratedDeadband;
  }

  Serial.println("NOISE CALIBRATION COMPLETE");
  for (int sensor = 0; sensor < SENSOR_COUNT; sensor++) {
    Serial.print("Deadband s");
    Serial.print(sensor + 1);
    Serial.print(": ");
    Serial.println(noiseDeadbandCm[sensor], 3);
  }
}

void calibrateBaselines() {
  float values[SENSOR_COUNT];
  float sums[SENSOR_COUNT] = {0.0f, 0.0f, 0.0f};
  int validCount = 0;

  Serial.println("CALIBRATION: collecting baseline samples...");

  while (validCount < BASELINE_SAMPLES) {
    bool valid = readAllSensors(values);

    if (!valid) {
      Serial.println("CALIBRATION: invalid reading, retrying...");
      delay(CALIBRATION_SAMPLE_DELAY_MS);
      continue;
    }

    for (int sensor = 0; sensor < SENSOR_COUNT; sensor++) {
      sums[sensor] += values[sensor];
      sampleWindow[sensor][validCount % STABILITY_WINDOW] = values[sensor];
    }

    validCount++;
    Serial.print("CALIBRATION: collecting samples ");
    Serial.print(validCount);
    Serial.print("/");
    Serial.println(BASELINE_SAMPLES);

    delay(CALIBRATION_SAMPLE_DELAY_MS);
  }

  for (int sensor = 0; sensor < SENSOR_COUNT; sensor++) {
    baselineCm[sensor] = sums[sensor] / BASELINE_SAMPLES;
    filteredDeltaCm[sensor] = 0.0f;
  }

  if (!windowIsStable()) {
    Serial.println("CALIBRATION: warning - using sampled baseline under disturbed water");
  }

  calibrateNoiseFloor();
  isCalibrated = true;
  printCalibrationSummary();
}

void setup() {
  Serial.begin(SERIAL_BAUD);

  for (int i = 0; i < SENSOR_COUNT; i++) {
    pinMode(trigPins[i], OUTPUT);
    pinMode(echoPins[i], INPUT);
  }

  delay(1000);
  calibrateBaselines();
}

void loop() {
  float rawValues[SENSOR_COUNT];
  float calibratedValues[SENSOR_COUNT];

  if (Serial.available() > 0) {
    char command = Serial.read();

    if (command == 'c' || command == 'C') {
      Serial.println("CALIBRATION: manual recalibration requested");
      calibrateBaselines();
    }
  }

  if (!isCalibrated) {
    calibrateBaselines();
  }

  if (!readAllSensors(rawValues)) {
    Serial.println("-999.00,-999.00,-999.00");
    delay(LOOP_DELAY_MS);
    return;
  }

  for (int i = 0; i < SENSOR_COUNT; i++) {
    float delta = (rawValues[i] - baselineCm[i]) * DELTA_SIGN;
    calibratedValues[i] = applyNoiseFilter(delta, i);
  }

  Serial.print(calibratedValues[0], 2);
  Serial.print(",");
  Serial.print(calibratedValues[1], 2);
  Serial.print(",");
  Serial.println(calibratedValues[2], 2);

  delay(LOOP_DELAY_MS);
}

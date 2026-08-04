#include <Arduino.h>

class Ultrasonic {
public:
  Ultrasonic(uint8_t trigPin,
             uint8_t echoPin,
             const String& name,
             float safeDistanceCm)
      : trigPin(trigPin),
        echoPin(echoPin),
        nametag(name),
        safeDistance(safeDistanceCm) {
    pinMode(trigPin, OUTPUT);
    pinMode(echoPin, INPUT);
    digitalWrite(trigPin, LOW);
  }

  bool detectBoat() {
    update();

    if (sampleCount < minimumSamples) {
      return false;
    }

    return filteredDistance <= safeDistance;
  }

  float getDistance() const {
    return filteredDistance;
  }

  bool hasValidReading() const {
    return sampleCount >= minimumSamples;
  }

private:
  static constexpr uint8_t sampleSize = 5;
  static constexpr uint8_t minimumSamples = 3;

  static constexpr unsigned long readCooldownMs = 60;
  static constexpr unsigned long echoTimeoutUs = 25000UL;

  static constexpr float speedOfSoundCmPerUs = 0.0343f;
  static constexpr float minimumDistanceCm = 2.0f;
  static constexpr float maximumDistanceCm = 400.0f;

  uint8_t trigPin;
  uint8_t echoPin;
  String nametag;
  float safeDistance;

  float samples[sampleSize] = {};
  uint8_t sampleIndex = 0;
  uint8_t sampleCount = 0;

  float filteredDistance = 0.0f;
  unsigned long lastReadMillis = 0;

  void update() {
    const unsigned long now = millis();

    if (now - lastReadMillis < readCooldownMs) {
      return;
    }

    lastReadMillis = now;

    const float newDistance = readDistanceCm();

    if (!isValidDistance(newDistance)) {
      return;
    }

    samples[sampleIndex] = newDistance;
    sampleIndex = (sampleIndex + 1) % sampleSize;

    if (sampleCount < sampleSize) {
      sampleCount++;
    }

    filteredDistance = calculateMedian();
  }

  float readDistanceCm() {
    digitalWrite(trigPin, LOW);
    delayMicroseconds(3);

    digitalWrite(trigPin, HIGH);
    delayMicroseconds(10);

    digitalWrite(trigPin, LOW);

    const unsigned long duration =
        pulseIn(echoPin, HIGH, echoTimeoutUs);

    if (duration == 0) {
      return NAN;
    }

    return duration * speedOfSoundCmPerUs * 0.5f;
  }

  bool isValidDistance(float distance) const {
    return !isnan(distance) &&
           distance >= minimumDistanceCm &&
           distance <= maximumDistanceCm;
  }

  float calculateMedian() const {
    float sorted[sampleSize];

    for (uint8_t i = 0; i < sampleCount; i++) {
      sorted[i] = samples[i];
    }

    for (uint8_t i = 1; i < sampleCount; i++) {
      float value = sorted[i];
      int8_t j = i - 1;

      while (j >= 0 && sorted[j] > value) {
        sorted[j + 1] = sorted[j];
        j--;
      }

      sorted[j + 1] = value;
    }

    if (sampleCount % 2 == 1) {
      return sorted[sampleCount / 2];
    }

    const uint8_t upper = sampleCount / 2;
    return (sorted[upper - 1] + sorted[upper]) * 0.5f;
  }
};

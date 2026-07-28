#include <Arduino.h>

class Ultrasonic {
  public:
  float arr[3] = {100, 100, 100};
  int arrIndex = 0;
  float avg = 0;
  float safeDistance = 0;

  unsigned long lastReadMillis = 0;
  const unsigned long readCooldown = 20;

  int trigPin = 0;
  int echoPin = 0;
  String nametag = "";

  bool detectBoat() {
    unsigned long now = millis();
    if (now - lastReadMillis < readCooldown) {
      return avg <= safeDistance;
    }

    lastReadMillis = now;
    digitalWrite(trigPin, LOW);
    delayMicroseconds(2);
    digitalWrite(trigPin, HIGH);
    delayMicroseconds(10);
    digitalWrite(trigPin, LOW);

    unsigned long duration = pulseIn(echoPin, HIGH, 30000UL);
    if (duration > 0) {
      float distance = (0.0343f * duration) / 2.0f;
      arr[arrIndex] = distance;
      arrIndex = (arrIndex + 1) % 3;
      avg = (arr[0] + arr[1] + arr[2]) / 3.0f;
    }

    return avg <= safeDistance;
  }

  Ultrasonic(int tPin, int ePin, String name, float sDist) {
    trigPin = tPin;
    echoPin = ePin;
    nametag = name;
    safeDistance = sDist;
    pinMode(trigPin, OUTPUT);
    pinMode(echoPin, INPUT);
    digitalWrite(trigPin, LOW);
    avg = (arr[0] + arr[1] + arr[2]) / 3.0f;
  }
};

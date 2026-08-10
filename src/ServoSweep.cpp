#include <Arduino.h>

class Servo
{
public:
  int servoPin;
  const int MIN_ANGLE = 0;
  const int MAX_ANGLE = 180;
  const int SWEEP_DELAY = 15;
  const int ANGLE_STEP = 1;

  void sweep() {
    for (int angle = MIN_ANGLE; angle <= MAX_ANGLE; angle += ANGLE_STEP) {
      setAngle(angle);
      delay(SWEEP_DELAY);
    }
    for (int angle = MAX_ANGLE; angle >= MIN_ANGLE; angle -= ANGLE_STEP) {
      setAngle(angle);
      delay(SWEEP_DELAY);
    }
  }

Servo(int pin) : servoPin(pin) {
    pinMode(servoPin, OUTPUT);
  }

  void setAngle(int angle) {
    angle = constrain(angle, MIN_ANGLE, MAX_ANGLE);
    int pulseWidth = map(angle, MIN_ANGLE, MAX_ANGLE, 544, 2400);
    digitalWrite(servoPin, HIGH);
    delayMicroseconds(pulseWidth);
    digitalWrite(servoPin, LOW);
  }
};
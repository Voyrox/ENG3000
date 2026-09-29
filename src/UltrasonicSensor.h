#pragma once

#include <Arduino.h>

// One HC-SR04 style ultrasonic sensor: a trigger pin that sends the pulse and
// an echo pin that stays high for the round trip.
class UltrasonicSensor {
public:
    UltrasonicSensor(uint8_t trigPin, uint8_t echoPin);

    void begin();

    // Sends one pulse and waits for its echo (at most config::ECHO_TIMEOUT_US).
    // Returns the distance in centimetres, or config::NO_ECHO if none came back.
    float readCm();

    // Whether a reading is inside the play area, i.e. taken to be the player.
    static bool isTarget(float distanceCm);

private:
    uint8_t trigPin_;
    uint8_t echoPin_;
};

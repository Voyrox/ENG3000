#include "UltrasonicSensor.h"

#include "Config.h"

UltrasonicSensor::UltrasonicSensor(uint8_t trigPin, uint8_t echoPin)
    : trigPin_(trigPin), echoPin_(echoPin) {}

void UltrasonicSensor::begin() {
    pinMode(trigPin_, OUTPUT);
    pinMode(echoPin_, INPUT);
    digitalWrite(trigPin_, LOW);
}

float UltrasonicSensor::readCm() {
    // A clean 10 us trigger pulse.
    digitalWrite(trigPin_, LOW);
    delayMicroseconds(2);
    digitalWrite(trigPin_, HIGH);
    delayMicroseconds(10);
    digitalWrite(trigPin_, LOW);

    // The echo pin's high time is the round trip, in microseconds.
    unsigned long durationUs = pulseIn(echoPin_, HIGH, config::ECHO_TIMEOUT_US);

    // A timeout reads as zero, which would come out as a distance of 0 cm - a
    // target pressed against the sensor. Report silence as silence instead.
    if (durationUs == 0) {
        return config::NO_ECHO;
    }
    return (durationUs * config::SOUND_CM_PER_US) / 2;
}

bool UltrasonicSensor::isTarget(float distanceCm) {
    return distanceCm >= config::MIN_TARGET_CM && distanceCm <= config::MAX_TARGET_CM;
}

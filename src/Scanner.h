#pragma once

#include <Arduino.h>

#include "Config.h"
#include "ScannerServo.h"
#include "UltrasonicSensor.h"

// What the scan concluded at one angle. The numbers are what the node sends as
// scanState, so they must not change.
enum class ScanState : uint8_t {
    Found = 0,     // both sensors see the player and agree: hold this angle
    HalfFound = 1, // one sensor has the player (or both, too far apart): steer
    Lost = 2,      // neither sees the player: sweep
};

// One reading the node reports: both sensors (cm, or config::NO_ECHO), the
// servo angle they were read at, and what the scan concluded there.
struct ScanReading {
    float leftCm = config::NO_ECHO;
    float rightCm = config::NO_ECHO;
    int angleDeg = config::CENTRE_DEG;
    ScanState state = ScanState::Lost;

    // The node's distance to the player: the mean of the sensors reading inside
    // the play area, else the nearer real echo, else config::NO_ECHO.
    float distanceCm() const;

    static ScanState classify(float leftCm, float rightCm);
};

// Tracks the player with two ultrasonic sensors on a servo.
//
// Each step reads a pulse pair - left, a short gap, then right - at a settled
// angle, and moves the servo on what it saw:
//   found      stay put
//   half-found a small step towards the sensor that has the player
//   lost       a large sweep step, reversing at each servo limit
//
// Multi-pulse: with pulsesPerAngle above 1, a pair that is found or half-found
// is not acted on straight away. The servo stays where it is for that many
// pairs, each sensor's readings are averaged with outliers left out, and the
// averaged reading is what gets reported and moved on. A lost pair still sweeps
// on its own, so a search is no slower.
class Scanner {
public:
    Scanner(UltrasonicSensor& left, UltrasonicSensor& right, ScannerServo& servo);

    void begin();

    // Call every loop. Returns true when a new reading is ready in latest().
    bool update();

    const ScanReading& latest() const { return latest_; }

    // These can move the servo, so they also restart(): pulses read at the old
    // angle are not averaged with ones read at the new angle.
    void setRole(NodeRole role);
    void holdAt(int degrees);
    void resumeScanning();

    // 1 turns multi-pulse off. Clamped to 1..config::MAX_PULSES_PER_ANGLE.
    void setPulsesPerAngle(int count);
    int pulsesPerAngle() const { return pulsesPerAngle_; }

    // Drops a half-read pair and any pulses collected at this angle, so a new
    // scan turn starts clean rather than pairing a left reading from before the
    // HALT with a right one from after the next TURN.
    void restart();

private:
    struct PulsePair {
        float leftCm;
        float rightCm;
    };

    bool readPair(PulsePair& pair);
    bool isCollectingMore(const PulsePair& pair) const;
    ScanReading averagePulses() const;
    void move(const ScanReading& reading);
    void logPair(const PulsePair& pair) const;

    // The average of one sensor's echoes, outliers left out; see Scanner.cpp.
    static float averageWithoutOutliers(const float* readings, int count);

    UltrasonicSensor& leftSensor_;
    UltrasonicSensor& rightSensor_;
    ScannerServo& servo_;

    // The pair being read.
    bool readLeftNext_ = true;
    float pendingLeftCm_ = config::NO_ECHO;
    unsigned long leftReadMs_ = 0;
    unsigned long lastPairMs_ = 0;

    // The pulses collected at the current angle.
    int pulsesPerAngle_ = config::DEFAULT_PULSES_PER_ANGLE;
    PulsePair pulses_[config::MAX_PULSES_PER_ANGLE] = {};
    int pulseCount_ = 0;

    ScanReading latest_;

    // The sweep direction when lost (+1 = towards left), and the steering
    // direction when half-found. Kept apart so a stuck sweep cannot drag the
    // steering with it, and vice versa.
    int sweepDir_ = 1;
    int steerDir_ = 1;
};

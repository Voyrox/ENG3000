#pragma once

#include <Arduino.h>

#include "Config.h"
#include "DeadZoneAlarm.h"
#include "RoomMap.h"
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
    // What the node knew about the empty room when this was read. While it is
    // learning, the sensors' echoes are the room's, sent as heard.
    RoomStatus room = RoomStatus::NotLearned;

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
//
// Empty room: once the room has been learnt (learnRoom(), the game's Room
// button), an echo from the room - a chair, a desk, the wall - counts as no
// echo, so the scan sweeps past furniture instead of locking on to it. See
// RoomMap.h.
//
// Dead zone: every pair the scan acts on (the room taken out) also goes to the
// dead-zone alarm, with the angle it was read at. See DeadZoneAlarm.h.
class Scanner {
public:
    Scanner(UltrasonicSensor& left, UltrasonicSensor& right, ScannerServo& servo, DeadZoneAlarm& deadZone);

    void begin();

    // Call every loop. Returns true when a new reading is ready in latest().
    bool update();

    const ScanReading& latest() const { return latest_; }

    // These can move the servo, so they also restart(): pulses read at the old
    // angle are not averaged with ones read at the new angle.
    void setRole(NodeRole role);
    void holdAt(int degrees);
    void resumeScanning();

    // The server's LOOK <deg>: the other node is confident where the player is,
    // and this is the bearing from here to them. Turns there (within this
    // mount's limits) and tracks from there as usual - unlike holdAt() it does
    // not hold. Ignored while held for calibration.
    void lookAt(int degrees);

    // 1 turns multi-pulse off. Clamped to 1..config::MAX_PULSES_PER_ANGLE.
    void setPulsesPerAngle(int count);
    int pulsesPerAngle() const { return pulsesPerAngle_; }

    // Drops a half-read pair and any pulses collected at this angle, so a new
    // scan turn starts clean rather than pairing a left reading from before the
    // HALT with a right one from after the next TURN.
    void restart();

    // LEARN: sweep the whole range with nobody in the play area and learn the
    // room, then scan on. LEARN again starts over. Not while the servo is held
    // for calibration: returns false and does nothing. A learn is cut short by
    // calibration (holdAt) or by a role with other limits, which keeps the room
    // from before.
    bool learnRoom();
    // FORGET: no room; every echo counts again.
    void forgetRoom();
    RoomStatus roomStatus() const { return room_.status(); }

private:
    struct PulsePair {
        float leftCm;
        float rightCm;
    };

    bool readPair(PulsePair& pair);
    bool isCollectingMore(const PulsePair& pair) const;
    ScanReading averagePulses() const;
    void move(const ScanReading& reading);
    void logPair(const PulsePair& heard, const PulsePair& pair) const;

    bool updateLearning();
    int learningSteps() const;
    int learningAngle(int pass, int step) const;
    float withoutRoom(Side side, float distanceCm) const;

    // The average of one sensor's echoes, outliers left out; see Scanner.cpp.
    static float averageWithoutOutliers(const float* readings, int count);

    UltrasonicSensor& leftSensor_;
    UltrasonicSensor& rightSensor_;
    ScannerServo& servo_;
    DeadZoneAlarm& deadZone_;

    // After a lookAt() swing, no pair is read until lookSettleMs_ has passed
    // since lookStartMs_.
    unsigned long lookStartMs_ = 0;
    unsigned long lookSettleMs_ = 0;

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

    RoomMap room_;

    // Learning the room: which sweep, which angle along it, how many pairs have
    // been read there, and when the servo set off for the first angle.
    int learnPass_ = 0;
    int learnStep_ = 0;
    int learnPairs_ = 0;
    unsigned long learnStartMs_ = 0;
};

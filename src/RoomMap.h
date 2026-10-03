#pragma once

#include <Arduino.h>

#include "Config.h"

// Which of the two sensors on the horn.
enum class Side : uint8_t { Left = 0, Right = 1 };

// What a node knows about the empty room. The numbers are what it sends as
// "room", so they must not change.
enum class RoomStatus : uint8_t {
    NotLearned = 0,
    Learning = 1,
    Learned = 2,
};

// The empty room: for each servo angle, the nearest echo each sensor got while
// nobody was in the play area. An echo that is not clearly nearer than that is
// the room - a chair, a desk, the wall - and not the player.
//
// Learning collects into a scratch table and only replaces the room when it
// finishes, so a learn that is cut short (calibration, a new role) leaves the
// room from before in place.
class RoomMap {
public:
    // Loads the room saved in flash, if there is one.
    void begin();

    // Starts collecting, from nothing.
    void startLearning();
    // One pulse pair read at angleDeg while learning.
    void record(int angleDeg, float leftCm, float rightCm);
    // Turns what was collected into the room and saves it to flash.
    void finishLearning();
    // Drops what was collected; the room from before (if any) stays.
    void cancelLearning();
    // Clears the room, in flash too.
    void forget();

    RoomStatus status() const;

    // Whether an echo of distanceCm, read by this sensor at angleDeg, is the
    // room. Never true for no echo, or before a room has been learnt.
    bool isRoom(Side side, int angleDeg, float distanceCm) const;

private:
    static constexpr int ANGLES = 181; // 0..180 degrees
    static constexpr int SAMPLES = config::ROOM_PASSES * config::ROOM_PAIRS_PER_ANGLE;

    float learntEcho(int side, int angleDeg) const;
    bool hasMatch(int side, int angleDeg, int sampleIndex, float echoCm) const;
    void clearRoom();

    bool learning_ = false;
    bool learned_ = false;

    // The room: per sensor and angle, the nearest echo that counts, or NO_ECHO.
    float roomCm_[2][ANGLES];

    // While learning: every reading, per sensor and angle.
    float samples_[2][ANGLES][SAMPLES];
    uint8_t sampleCount_[ANGLES];
};

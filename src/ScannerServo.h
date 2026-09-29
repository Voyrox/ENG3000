#pragma once

#include <Arduino.h>
#include <ESP32Servo.h>

#include "Config.h"

// Which mount this node is, as decided on the game's calibration screen and
// passed on by the server (ROLE LEFT / ROLE RIGHT). Sets the servo limits.
enum class NodeRole { Unknown, Left, Right };

// The servo the two sensors ride on. Left is towards the larger angle.
//
// It can be held at a fixed angle for calibration (the server's AIM <deg>), so
// the node can be aimed straight by hand: while held, nothing moves it - not a
// scan step, not a new role's limits - until release() (the server's SCAN).
// A node boots held at 90 and scans only once told SCAN, so a node that reboots
// in the middle of calibration never moves.
class ScannerServo {
public:
    explicit ScannerServo(uint8_t pin);

    // Attaches the servo, centres it and waits config::BOOT_SETTLE_MS.
    void begin();

    // Turns by deltaDeg, clamped to this mount's limits. Returns true if it hit a
    // limit. Does nothing while held.
    bool stepBy(int deltaDeg);

    void holdAt(int degrees);
    void release();
    bool isHeld() const { return held_; }

    // Sets the limits for this mount and pulls the servo back inside them (not
    // while held).
    void setRole(NodeRole role);

    // Whether the servo has had time to reach the last angle it was sent.
    bool isSettled() const;

    int angleDeg() const { return angleDeg_; }

private:
    void write(int degrees);

    Servo servo_;
    uint8_t pin_;
    int angleDeg_ = config::CENTRE_DEG;
    config::ServoLimits limits_ = config::UNKNOWN_ROLE_LIMITS;
    bool held_ = true;
    unsigned long lastWriteMs_ = 0;
};

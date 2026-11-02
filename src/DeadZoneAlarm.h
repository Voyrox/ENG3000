#pragma once

#include <Arduino.h>

#include "Config.h"

// The dead-zone buzzer: it sounds while the player is less than
// config::DEAD_ZONE_CM in front of the line the nodes stand on.
//
// A sensor measures along its beam, not straight out from that line. At servo
// angle a (90 = straight out) an echo d cm away is
//
//     y = d * sin(a)        (the same as d * cos(a - 90))
//
// in front of the line. So the dead zone is d < DEAD_ZONE_CM / sin(a): 10 cm
// straight out, 15.6 cm at 40 or 140 degrees, 29.2 cm at 160. It is checked as
// y < DEAD_ZONE_CM rather than as d against that quotient, so nothing divides
// by a sine near zero. sin(a) = sin(180 - a), so which way the servo counts
// does not matter.
//
// It hears every pulse pair the scan acts on, with the learnt room already taken
// out, so a chair beside the node cannot set it off:
//   - an echo in the dead zone counts towards sounding; config::DEAD_ZONE_PAIRS
//     of them in a row sound it, so one stray echo does not;
//   - an echo, and the nearest is config::DEAD_ZONE_CLEAR_CM or more beyond the
//     dead zone: silences it at once. In between, nothing changes, so a player
//     standing on the line does not make it chatter;
//   - no echo from either sensor says nothing, and changes nothing.
// It also goes quiet config::DEAD_ZONE_HOLD_MS after the last pair in the dead
// zone, since a node reads nothing during the other node's turn.
//
// The control panel's hold button (BUZZ 1 / BUZZ 0) sounds it whatever the
// sensors say; let go, and it is back to the sensors.
//
// The control panel takes priority over the sensors (Aaron, 3 Nov): while
// someone steers the cursor from its pad (PAD 1, re-sent every 250 ms) or its
// Dead-zone alarm switch is off (ALARM 0), the sensors cannot sound it. They
// still keep track, so a player in the dead zone sounds it again once the pad
// is let go. The hold button still sounds it.
class DeadZoneAlarm {
public:
    explicit DeadZoneAlarm(uint8_t buzzerPin);

    void begin();

    // One pulse pair (cm, or config::NO_ECHO) and the servo angle it was read at.
    void hear(float leftCm, float rightCm, int angleDeg);

    // Call every loop, scanning turn or not: silences the buzzer once the last
    // pair in the dead zone is config::DEAD_ZONE_HOLD_MS old, and lets go of
    // a hold that has not been renewed for config::BUZZER_HELD_TIMEOUT_MS.
    void update();

    // The control panel's hold button: on sounds the buzzer until off, or
    // until config::BUZZER_HELD_TIMEOUT_MS without another on.
    void hold(bool on);

    // The control panel's pad: on while someone steers the cursor from it,
    // until off, or until config::BUZZER_HELD_TIMEOUT_MS without another on.
    void padInUse(bool on);

    // The control panel's Dead-zone alarm switch: off, the sensors never sound it.
    void setAlarm(bool on);
    bool alarm() const { return alarm_; }

    bool isSounding() const { return held_ || (sounding_ && alarm_ && !pad_); }

    // How far in front of the nodes' line an echo distanceCm away at angleDeg
    // is, or config::NO_ECHO for no echo.
    static float depthCm(float distanceCm, int angleDeg);

private:
    void sound(bool on);
    void write();

    uint8_t pin_;
    bool sounding_ = false; // the sensors' say
    bool held_ = false;     // the control panel's
    unsigned long heldMs_ = 0;
    bool pad_ = false;      // someone steers from the control panel's pad
    unsigned long padMs_ = 0;
    bool alarm_ = true;     // the control panel's Dead-zone alarm switch
    int closePairs_ = 0;
    unsigned long lastCloseMs_ = 0;
};

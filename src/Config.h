#pragma once

#include <Arduino.h>

// Every setting the scanner node firmware uses, in one place. Change a value
// here, not in the class that uses it.

// --- Network --------------------------------------------------------------
// The Wi-Fi network and server are whoever's hotspot the rig is on today. Each
// of these can be overridden without touching this file, from your own
// (gitignored) platformio.ini:
//
//   build_flags =
//       '-DNODE_WIFI_SSID="MyHotspot"'
//       '-DNODE_WIFI_PASSWORD="secret"'
//       '-DNODE_SERVER_IP="192.168.137.1"'
#ifndef NODE_WIFI_SSID
#define NODE_WIFI_SSID "Josh's S24"
#endif
#ifndef NODE_WIFI_PASSWORD
#define NODE_WIFI_PASSWORD "bruh12345"
#endif
#ifndef NODE_SERVER_IP
#define NODE_SERVER_IP "192.168.137.1"
#endif

namespace config {

constexpr unsigned long SERIAL_BAUD = 115200;

// --- Network --------------------------------------------------------------
constexpr char WIFI_SSID[] = NODE_WIFI_SSID;
constexpr char WIFI_PASSWORD[] = NODE_WIFI_PASSWORD;
constexpr char SERVER_IP[] = NODE_SERVER_IP;
constexpr uint16_t SERVER_PORT = 3000;

// true: ignore SERVER_IP and search the local subnet for the server instead.
constexpr bool AUTO_DISCOVER_SERVER = false;

constexpr unsigned long WIFI_CONNECT_TIMEOUT_MS = 15000;
constexpr unsigned long WIFI_RETRY_INTERVAL_MS = 1000;
constexpr unsigned long SERVER_CONNECT_TIMEOUT_MS = 3000;
constexpr unsigned long SERVER_DISCOVERY_TIMEOUT_MS = 120000;
constexpr int32_t SERVER_PROBE_TIMEOUT_MS = 300;
constexpr unsigned long NODE_ID_TIMEOUT_MS = 2000;

// How long ONE connect attempt may block. Must be well under
// SERVER_CONNECT_TIMEOUT_MS so that budget buys several attempts rather than one
// long stall.
constexpr int32_t SERVER_ATTEMPT_TIMEOUT_MS = 1000;

// WiFiClient::setTimeout takes SECONDS and multiplies by 1000 internally. It also
// doubles as the timeout for the *next* connect(), because connect(host, port)
// forwards this same value as its connect timeout.
constexpr uint32_t SOCKET_READ_TIMEOUT_SECONDS = 1;

// --- Pins -----------------------------------------------------------------
// Two ultrasonic sensors side by side on the servo horn.
constexpr uint8_t LEFT_TRIG_PIN = 5;
constexpr uint8_t LEFT_ECHO_PIN = 18;
constexpr uint8_t RIGHT_TRIG_PIN = 16;
constexpr uint8_t RIGHT_ECHO_PIN = 17;
constexpr uint8_t SERVO_PIN = 32;
// The dead-zone buzzer (D13 on the board).
constexpr uint8_t BUZZER_PIN = 13;

// --- Ultrasonic sensors ---------------------------------------------------
// Returned when no echo came back. Distinct from a reading of 0 cm, which is
// impossible, and from a real close target: a dropped echo must not be allowed to
// masquerade as a distance, or the scan treats silence as "nothing there" and
// swings past a player who is standing right there.
constexpr float NO_ECHO = -1.0f;

// Speed of sound in cm/us. A reading is half the round trip.
constexpr double SOUND_CM_PER_US = 0.034;

// A reading inside this range is taken to be the player; outside it there is no
// target.
constexpr float MIN_TARGET_CM = 10;
constexpr float MAX_TARGET_CM = 230;

// How long a reading may wait for its echo. pulseIn() counts from the trigger,
// not from the start of the echo pulse, and the rig's sensors only raise ECHO
// about 2.2 ms after their trigger. So the timeout is the round trip to
// MAX_TARGET_CM plus that start: the old flat 9000 us left room for only
// ~145 cm, and nothing past it - the far edge of the play area included - was
// ever heard. The start was taken as 600 us at first, and the rig's serial
// logs (4-5 Oct) then stopped dead about 28 cm short of MAX_TARGET_CM at every
// setting: at most 152 cm with 180, 162 with 190 and 203 with 230. Each of
// those puts the start at 2.21-2.24 ms; 2.5 ms leaves some room.
constexpr unsigned long ECHO_START_US = 2500;
constexpr unsigned long ECHO_TIMEOUT_US =
    static_cast<unsigned long>(MAX_TARGET_CM * 2 / SOUND_CM_PER_US) + ECHO_START_US;

// --- Scan timing ----------------------------------------------------------
// Quiet time after one pulse pair before the next pair starts.
constexpr unsigned long PAIR_GAP_MS = 30;

// Quiet time between the left and the right sensor of one pair, so the right
// sensor never hears the left one's pulse.
constexpr unsigned long SIDE_GAP_MS = 50;

// How long the servo is given to actually arrive at a commanded angle before
// anything is read through it. A reading taken while the horn is still
// travelling describes some angle the rig was never at.
constexpr unsigned long SERVO_SETTLE_MS = 40;

// The servo is centred at boot and given this long to get there.
constexpr unsigned long BOOT_SETTLE_MS = 5000;

// --- Scan state machine ---------------------------------------------------
// Both sensors in range and less than this far apart: the same target, found.
constexpr float MAX_PAIR_DIFF_CM = 40;

// Half-found: a small step towards the sensor that has the player.
constexpr int STEER_STEP_DEG = 3;

// Lost: a large sweep step, reversing at each servo limit.
constexpr int SWEEP_STEP_DEG = 14;

// --- Multi-pulse ----------------------------------------------------------
// In found or half-found, take this many pulse pairs at one angle and average
// them before reporting and moving. 1 is off (one pair per move). The server
// sets it (PULSES <n>) from the game screen's Pulses button; a node starts at
// the default until it is told.
constexpr int DEFAULT_PULSES_PER_ANGLE = 1;
constexpr int MAX_PULSES_PER_ANGLE = 5;

// When the pulses are averaged, an echo further than this from their median is
// an outlier and is left out (see Scanner::averageWithoutOutliers).
constexpr float OUTLIER_TOLERANCE_CM = 20;

// --- Empty room -------------------------------------------------------------
// The game's Room button (LEARN) has each node sweep its whole range with nobody
// in the play area and record, at every angle, the nearest echo each sensor gets:
// a chair, a desk, the wall. From then on an echo that is not clearly nearer than
// the room at that angle is the room, not the player, and counts as no echo -
// so the scan sweeps past furniture instead of locking on to it. The room is
// kept in flash, so it survives a reset; FORGET clears it. See RoomMap.h.
//
// Degrees between the angles learnt.
constexpr int ROOM_STEP_DEG = 3;
// Sweeps across the range (there, back, ...) and pulse pairs read at each angle
// on each sweep.
constexpr int ROOM_PASSES = 2;
constexpr int ROOM_PAIRS_PER_ANGLE = 2;
// The first angle learnt can be across the whole range from where the servo
// was, which takes far longer than SERVO_SETTLE_MS.
constexpr unsigned long ROOM_START_SETTLE_MS = 800;
// An echo is the room unless it is at least this much nearer than the nearest
// learnt echo within ROOM_STEP_DEG of the angle it was read at.
constexpr float ROOM_MARGIN_CM = 15;
// A learnt echo only counts if another one - at the same angle or within
// ROOM_STEP_DEG of it - is within this of it. One stray echo would otherwise
// hide everything behind it in that direction for good.
constexpr float ROOM_MATCH_CM = 10;

// --- Dead zone --------------------------------------------------------------
// The buzzer sounds while the player is less than DEAD_ZONE_CM in front of the
// line the nodes stand on. That is measured straight out from the line, not
// along the beam, so it takes the servo angle into account: see DeadZoneAlarm.h.
// The brief's dead zone ends 60 cm from the wall, so this is 60 minus how far
// the nodes stand from the wall: 10 for nodes 50 cm out.
constexpr float DEAD_ZONE_CM = 10;
// Pairs in a row with an echo in the dead zone before the buzzer sounds, so one
// stray echo does not.
constexpr int DEAD_ZONE_PAIRS = 2;
// Once it sounds, the nearest echo must be this much further out than
// DEAD_ZONE_CM to silence it, so a player standing on the line does not make it
// chatter.
constexpr float DEAD_ZONE_CLEAR_CM = 3;
// It stops by itself this long after the last pair in the dead zone. A node
// reads nothing while the other node has the scanning turn (1 s), so this is
// longer than a turn and the buzzer sounds on through it.
constexpr unsigned long DEAD_ZONE_HOLD_MS = 1500;
// 0 for an active buzzer, which beeps by itself on a steady HIGH. A passive one
// only clicks on that: give it a tone in Hz instead (2000-4000 is loudest).
constexpr unsigned int BUZZER_TONE_HZ = 0;

// --- Servo ----------------------------------------------------------------
// 90 points straight out into the play area; larger turns towards screen-left.
constexpr int CENTRE_DEG = 90;

// Servo limits per mount. Which node is which is decided on the game's
// calibration screen, and the server passes it on as ROLE LEFT / ROLE RIGHT.
// Until then the node sweeps only the range both mounts allow.
struct ServoLimits {
    int maxLeftDeg;
    int maxRightDeg;
};
constexpr ServoLimits LEFT_NODE_LIMITS = {160, 40};
constexpr ServoLimits RIGHT_NODE_LIMITS = {140, 30};
constexpr ServoLimits UNKNOWN_ROLE_LIMITS = {140, 40};

// --- Debug ----------------------------------------------------------------
// Print every pulse pair to the serial monitor.
constexpr bool LOG_EVERY_PAIR = true;

} // namespace config

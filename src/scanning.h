#pragma once

void scanSetup();
bool scanLoop();

// Distances from the two ultrasonic heads, in centimetres, or -1 when the last
// read got no echo at all. Floats, because the scan state machine and the
// payload both work in centimetres and truncating here threw away the decimal
// the servo sweep is tuned against.
float getLeftVal();
float getRightVal();

// The node's distance to the player, in centimetres: the mean of the heads
// reading inside the scan range, else the nearer real echo, else -1.
float getScanDistance();

// Where the servo was pointing when the latest pair was read (90 = straight
// out, more = screen-left), and what the scan concluded there:
//   0 = both heads agree, hold this angle
//   1 = one head has the player, steering toward it
//   2 = nobody found, sweeping
// A node's two readings only become a position once its angle is known, so these
// travel with every payload.
int getAngle();
int getScanState();

// Which node this is, as decided on the game's calibration screen and passed
// on by the server (ROLE LEFT / ROLE RIGHT). Sets the servo limits for that mount.
enum ScanRole { ROLE_UNKNOWN, ROLE_LEFT, ROLE_RIGHT };
void setScanRole(ScanRole role);

// Calibration (server AIM <deg> / SCAN): hold the servo at a fixed angle so the
// node can be aimed straight by hand - it still reads and reports, but neither
// steers nor sweeps - then go back to scanning.
void aimServoAt(int degrees);
void resumeScanning();

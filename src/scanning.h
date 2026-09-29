#pragma once

void scanSetup();
bool scanLoop();

// Distances from the two ultrasonic heads, in centimetres, or -1 when the last
// read got no echo at all. Floats, because the scan state machine and the
// payload both work in centimetres and truncating here threw away the decimal
// the servo sweep is tuned against.
float getLeftVal();
float getRightVal();

// Where the servo is pointing, and what the scan concluded there:
//   0 = both heads agree, hold this angle
//   1 = one head has the player, steering toward it
//   2 = nobody found, sweeping
// A node's two readings only become a position once its angle is known, so these
// travel with every payload.
int getAngle();
int getScanState();

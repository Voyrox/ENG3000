#pragma once

void scanSetup();
bool scanLoop();
int getLeftVal();
int getRightVal();

// What the node reports to the game, for the pair read by the latest
// scanLoop() that returned true.
float getLeftCm();       // left ultrasonic, cm; -1 = no echo
float getRightCm();      // right ultrasonic, cm; -1 = no echo
float getScanDistance(); // the node's distance to the player, cm; -1 = nothing heard
int getScanAngle();      // servo angle the pair was read at; 90 = straight out, more = screen-left
int getScanState();      // 0 found (both sensors agree), 1 half-found, 2 lost

// Which node this is, as decided on the game's calibration screen and passed
// on by the server (ROLE LEFT / ROLE RIGHT). Sets the servo limits for that mount.
enum ScanRole { ROLE_UNKNOWN, ROLE_LEFT, ROLE_RIGHT };
void setScanRole(ScanRole role);

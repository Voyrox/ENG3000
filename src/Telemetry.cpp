#include "Telemetry.h"

// -1 means a sensor got no echo at all, and it is never averaged in: that would
// hand the website a plausible-looking distance that no sensor actually
// measured.
//
// A reading in which neither sensor heard anything is still sent, with avg -1.
// It is not a fix, but it shows the node is connected and scanning, which is how
// a rig with a silent sensor is told apart from one that has dropped off the
// network.
String formatReading(int nodeId, const String& mac, const ScanReading& reading) {
    String line = "{";
    line += "\"nodeId\":" + String(nodeId);
    line += ",\"mac\":\"" + mac + "\"";
    // The node's distance to the player; see ScanReading::distanceCm().
    line += ",\"avg\":" + String(reading.distanceCm(), 2);
    // Per sensor, so a reader can tell which one dropped out.
    line += ",\"left\":" + String(reading.leftCm, 2);
    line += ",\"right\":" + String(reading.rightCm, 2);
    // The angle the pair was read at. Two ranges from a known heading give a
    // position; from an unknown one they do not.
    line += ",\"angle\":" + String(reading.angleDeg);
    line += ",\"scanState\":" + String(static_cast<int>(reading.state));
    // The empty room: 0 not learnt, 1 learning (the echoes are the room's), 2
    // learnt (echoes from the room already count as none).
    line += ",\"room\":" + String(static_cast<int>(reading.room));
    line += "}";
    return line;
}

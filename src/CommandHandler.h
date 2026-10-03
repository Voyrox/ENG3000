#pragma once

#include <Arduino.h>

#include "NodeConnection.h"
#include "Scanner.h"

// Carries out the control lines the server sends:
//   SYNC <tick>          the server's tick (logged)
//   TURN / HALT          this node may scan / must stay quiet. The server hands
//                        out one turn at a time so two nodes never ping at once.
//   ROLE LEFT|RIGHT      which mount this is: sets the servo limits
//   AIM <deg> / SCAN     hold the servo for calibration / scan again
//   PULSES <n>           multi-pulse: pulse pairs per angle in found or
//                        half-found, 1 = off (clamped to 1..MAX_PULSES_PER_ANGLE)
//   LEARN / FORGET       learn the empty room (sweep with nobody in the play
//                        area) / clear it; see RoomMap.h
class CommandHandler {
public:
    CommandHandler(NodeConnection& connection, Scanner& scanner);

    // Forgets the turn, e.g. after a reconnect: the node waits for a fresh TURN.
    void reset();

    // Handles every line waiting on the connection.
    void poll();

    bool hasTurn() const { return hasTurn_; }

private:
    void handle(const String& line);

    NodeConnection& connection_;
    Scanner& scanner_;
    bool hasTurn_ = false;
};

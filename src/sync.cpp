#include "sync.h"
#include "scanning.h"

static bool synced = false;
static bool turnGranted = false;
static unsigned long pcTick = 0;

void initSync() {
    synced = false;
    turnGranted = false;
    pcTick = 0;
}

static void handleLine(const String& line) {
    if (line.startsWith("SYNC ")) {
        pcTick = strtoul(line.substring(5).c_str(), nullptr, 10);
        synced = true;
        Serial.print("Synced to PC tick ");
        Serial.println(pcTick);
    } else if (line == "TURN") {
        turnGranted = true;
        synced = true;
        Serial.println("Scan turn granted by PC");
    } else if (line == "HALT") {
        turnGranted = false;
        Serial.println("Scan turn revoked by PC");
    } else if (line.startsWith("ROLE ")) {
        // Sent by the server once the calibration screen has identified this node.
        String role = line.substring(5);
        if (role == "LEFT") setScanRole(ROLE_LEFT);
        else if (role == "RIGHT") setScanRole(ROLE_RIGHT);
        else setScanRole(ROLE_UNKNOWN);
        Serial.print("Scan role: ");
        Serial.println(role);
    } else {
        Serial.print("Unhandled PC command: ");
        Serial.println(line);
    }
}

bool pollCommands() {
    if (!client.connected()) {
        return false;
    }

    bool handled = false;
    while (client.available()) {
        String line = client.readStringUntil('\n');
        line.trim();
        if (line.length() > 0) {
            handleLine(line);
            handled = true;
        }
    }
    return handled;
}

bool awaitingTurn() {
    return !turnGranted;
}

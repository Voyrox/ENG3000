#include "CommandHandler.h"

CommandHandler::CommandHandler(NodeConnection& connection, Scanner& scanner)
    : connection_(connection), scanner_(scanner) {}

void CommandHandler::reset() {
    hasTurn_ = false;
}

void CommandHandler::poll() {
    String line;
    while (connection_.readLine(line)) {
        if (line.length() > 0) {
            handle(line);
        }
    }
}

void CommandHandler::handle(const String& line) {
    if (line.startsWith("SYNC ")) {
        Serial.printf("Synced to PC tick %lu\n", strtoul(line.substring(5).c_str(), nullptr, 10));
    } else if (line == "TURN") {
        // A fresh turn starts a fresh pair: one half-read before the last HALT
        // would otherwise be finished a whole turn later.
        if (!hasTurn_) {
            scanner_.restart();
        }
        hasTurn_ = true;
        Serial.println("Scan turn granted by PC");
    } else if (line == "HALT") {
        hasTurn_ = false;
        Serial.println("Scan turn revoked by PC");
    } else if (line.startsWith("ROLE ")) {
        // Sent once the calibration screen has identified this node.
        String role = line.substring(5);
        if (role == "LEFT") {
            scanner_.setRole(NodeRole::Left);
        } else if (role == "RIGHT") {
            scanner_.setRole(NodeRole::Right);
        } else {
            scanner_.setRole(NodeRole::Unknown);
        }
        Serial.printf("Scan role: %s\n", role.c_str());
    } else if (line.startsWith("AIM ")) {
        // Calibration: hold the servo here so the node can be aimed by hand.
        int degrees = line.substring(4).toInt();
        scanner_.holdAt(degrees);
        Serial.printf("Servo held at %d\n", degrees);
    } else if (line.startsWith("LOOK ")) {
        // The other node is confident where the player is: turn towards them
        // and track from there. Unlike AIM, the servo is not held.
        int degrees = line.substring(5).toInt();
        scanner_.lookAt(degrees);
        Serial.printf("Looking towards %d\n", degrees);
    } else if (line == "SCAN") {
        scanner_.resumeScanning();
        Serial.println("Scanning resumed");
    } else if (line.startsWith("PULSES ")) {
        scanner_.setPulsesPerAngle(line.substring(7).toInt());
        Serial.printf("Pulses per angle: %d\n", scanner_.pulsesPerAngle());
    } else {
        Serial.printf("Unhandled PC command: %s\n", line.c_str());
    }
}

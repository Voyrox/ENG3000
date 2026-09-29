// Scanner node: two ultrasonic sensors on a servo that tracks the player, and
// reports each reading to the game server over Wi-Fi. Settings are in Config.h.

#include <Arduino.h>

#include "CommandHandler.h"
#include "Config.h"
#include "NodeConnection.h"
#include "Scanner.h"
#include "ScannerServo.h"
#include "Telemetry.h"
#include "UltrasonicSensor.h"

UltrasonicSensor leftSensor(config::LEFT_TRIG_PIN, config::LEFT_ECHO_PIN);
UltrasonicSensor rightSensor(config::RIGHT_TRIG_PIN, config::RIGHT_ECHO_PIN);
ScannerServo scannerServo(config::SERVO_PIN);
Scanner scanner(leftSensor, rightSensor, scannerServo);

NodeConnection connection;
CommandHandler commands(connection, scanner);

void setup() {
    Serial.begin(config::SERIAL_BAUD);
    Serial.println("ESP32 Node is starting...");
    connection.begin();
    scanner.begin();
}

void loop() {
    if (!connection.isReady()) {
        commands.reset();
        connection.reconnect();
        return;
    }

    commands.poll();

    // The server hands out one scanning turn at a time and holds the rest of the
    // rig still with HALT, so two nodes never ping at once.
    if (!commands.hasTurn()) {
        return;
    }

    if (scanner.update()) {
        connection.sendLine(formatReading(connection.nodeId(), connection.macAddress(), scanner.latest()));
    }
}

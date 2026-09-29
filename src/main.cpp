#include <Arduino.h>
#include <WiFi.h>
#include "wifi/connectionManager.h"
#include "sync.h"
#include "scanning.h"

const int UltrasonicCount = 1;

// A standalone ultrasonic head used to be declared here on pins 33/32. It was
// never read from: scanSetup() drives pin 32 as the servo (scanning.cpp), which
// makes it an OUTPUT, and every call to updateReading() then ran pulseIn() on the
// servo's own pin and threw the result away. It fought the servo for the pin and
// bought nothing, so it is gone. The two heads on the swivel are leftUSS and
// rightUSS in scanning.cpp.

// -1 means that head got no echo at all. Averaging one in would hand the website
// a plausible-looking distance that no head actually measured - and since the
// browser has no way to tell it from a real reading, the cursor would sit
// confidently in the wrong place rather than waiting for the next clean frame.
const float NO_ECHO = -1.0f;

void sendSensorSnapshot(float left, float right) {
    const bool leftHeard = left >= 0.0f;
    const bool rightHeard = right >= 0.0f;
    // Neither head heard anything, so there is no fix to report. Staying quiet
    // is better than reporting a fabricated one; the website holds the last
    // good reading across a short gap anyway.
    if (!leftHeard && !rightHeard) {
        return;
    }

    String payload = "{";
    payload += "\"nodeId\":" + String(nodeID);
    payload += ",\"mac\":\"" + WiFi.macAddress() + "\"";
    // `avg` stays exactly as it was - the website derives the cell from it and
    // the parity fixture pins it, so it is the one field that must not change
    // meaning. It is now the mean of whichever heads actually heard something.
    payload += ",\"avg\":" + String(
        ((leftHeard ? left : 0.0f) + (rightHeard ? right : 0.0f))
            / (float)((leftHeard ? 1 : 0) + (rightHeard ? 1 : 0)),
        2);
    // Per head, so a reader can tell which one dropped out.
    payload += ",\"left\":" + String(left, 2);
    payload += ",\"right\":" + String(right, 2);
    // The pose those readings were taken at. Two ranges from a known heading
    // triangulate; two ranges from an unknown one do not, so the angle is what
    // turns this pair into a position the game can draw.
    payload += ",\"angle\":" + String(getAngle());
    payload += ",\"scanState\":" + String(getScanState());
    payload += "}";

    sendData(payload);
}

void setup() {
  Serial.begin(115200);
  Serial.println("ESP32 Node is starting...");
  initSync();
  connectWiFi();
  scanSetup();
}

void loop() {
    bool wifiReady = WiFi.status() == WL_CONNECTED;

    if (!wifiReady) {
        if (wifiConnected || client.connected()) {
            Serial.println("Wi-Fi lost");
            wifiConnected = false;
            client.stop();
        }

        if (millis() - lastWifiAttemptMillis >= WIFI_RETRY_INTERVAL_MS) {
            lastWifiAttemptMillis = millis();
            Serial.println("Retrying Wi-Fi connect...");
            initSync();
            connectWiFi();
        }

        return;
    }

    wifiConnected = true;

    if (!client.connected()) {
        initSync();
        connectServer();
        return;
    }

    if (nodeID < 0) {
        client.stop();
        return;
    }

    // The broker hands out one scanning turn at a time and holds the rest of the
    // rig still with HALT, so two nodes never sweep at once and cross-talk
    // between their ultrasonics cannot reach the website. That was commented out,
    // which left both nodes scanning simultaneously and made the whole
    // TURN/HALT exchange decorative - while the website's timing constants were
    // quietly tuned to work around it. Honour the handshake.
    if (awaitingTurn()) {
        pollCommands();
        return;
    }

    pollCommands();
    bool ready = scanLoop();
    if(ready){
        sendSensorSnapshot(getLeftVal(), getRightVal());
    }
}

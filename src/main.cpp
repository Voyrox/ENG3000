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
// bought nothing, so it is gone. The heads on the swivel are leftUSS and
// rightUSS in scanning.cpp.

// One reading from the scanner. -1 means a head got no echo at all, and it is
// never averaged in: that would hand the website a plausible-looking distance
// that no head actually measured, and the cursor would sit confidently in the
// wrong place.
//
// A pass in which neither head heard anything is still sent, with avg -1. It is
// not a fix - the website and server read -1 as no echo - but it shows the node
// is connected and scanning, which is how a rig with a silent sensor is told
// apart from one that has dropped off the network.
void sendSensorSnapshot() {
    String payload = "{";
    payload += "\"nodeId\":" + String(nodeID);
    payload += ",\"mac\":\"" + WiFi.macAddress() + "\"";
    // `avg` keeps its meaning for the website and server: the node's distance to
    // the player. Only heads reading inside the scan range count, so neither a
    // missed echo nor a wall behind the player is averaged in (getScanDistance).
    payload += ",\"avg\":" + String(getScanDistance(), 2);
    // Per head, so a reader can tell which one dropped out.
    payload += ",\"left\":" + String(getLeftVal(), 2);
    payload += ",\"right\":" + String(getRightVal(), 2);
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
        sendSensorSnapshot();
    }
}

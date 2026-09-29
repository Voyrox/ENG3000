#include <Arduino.h>
#include <WiFi.h>
#include "wifi/connectionManager.h"
#include "sync.h"
#include "scanning.h"

// One reading from the scanner: the node's distance (avg, what the game and
// server have always read), both ultrasonics, the servo angle the pair was
// read at, and the scan state. Distances are cm, -1 when nothing was heard.
void sendSensorSnapshot() {
    String payload = "{";
    payload += "\"nodeId\":" + String(nodeID);
    payload += ",\"mac\":\"" + WiFi.macAddress() + "\"";
    payload += ",\"avg\":" + String(getScanDistance(), 2);
    payload += ",\"left\":" + String(getLeftCm(), 2);
    payload += ",\"right\":" + String(getRightCm(), 2);
    payload += ",\"angle\":" + String(getScanAngle());
    payload += ",\"state\":" + String(getScanState());
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

    // if (awaitingTurn()) {
    //     pollCommands();
    //     return;
    // }

    pollCommands();
    bool ready = scanLoop();
    if(ready){
        sendSensorSnapshot();
    }
}

#include <Arduino.h>
#include <WiFi.h>
#include "ultrasonicSensor.cpp"
#include "wifi/connectionManager.h"
#include "sync.h"
#include "scanning.h"

const int UltrasonicCount = 1;
const int triggerPin = 33;
const int echoPin = 32;
Ultrasonic center(triggerPin, echoPin, "Center");

void sendSensorSnapshot() {
    center.updateReading();

    String payload = "{";
    payload += "\"nodeId\":" + String(nodeID);
    payload += ",\"mac\":\"" + WiFi.macAddress() + "\"";
    payload += ",\"avg\":" + String(center.avg, 2);
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

    if (awaitingTurn()) {
        pollCommands();
        return;
    }

    pollCommands();
    sendSensorSnapshot();
    scanLoop();
}

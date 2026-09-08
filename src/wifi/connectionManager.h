#pragma once

#include <Arduino.h>
#include <WiFi.h>

extern int nodeID;
extern unsigned long lastWifiAttemptMillis;
extern bool wifiConnected;
extern WiFiClient client;

constexpr unsigned long WIFI_RETRY_INTERVAL_MS = 1000;

bool connectWiFi();
bool connectServer();
bool sendData(const String& data);

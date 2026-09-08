#pragma once

#include <Arduino.h>
#include <WiFi.h>

bool discoverServer(WiFiClient& client, String& serverIP,
                    uint16_t serverPort, int32_t probeTimeoutMs,
                    unsigned long discoveryTimeoutMs);

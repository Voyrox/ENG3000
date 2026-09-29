#pragma once

#include <Arduino.h>
#include <WiFi.h>

// Finds the game server by trying every address on the local subnet, nearest to
// this node's own address first. On success the client is left connected and
// serverIp holds the address. Only used with config::AUTO_DISCOVER_SERVER.
bool discoverServer(WiFiClient& client, String& serverIp, uint16_t serverPort,
                    int32_t probeTimeoutMs, unsigned long discoveryTimeoutMs);

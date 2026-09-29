#pragma once

#include <Arduino.h>
#include <WiFi.h>

// The node's link to the game server: Wi-Fi, one persistent TCP socket, and the
// node id the server hands out in the handshake. Lines go both ways: readings
// out, control commands in.
class NodeConnection {
public:
    NodeConnection();

    // Joins Wi-Fi and the server. Blocks for up to config::WIFI_CONNECT_TIMEOUT_MS
    // plus the server connect; if either fails, reconnect() keeps trying.
    void begin();

    // Connected, with a node id: readings can be sent.
    bool isReady();

    // One step towards isReady(): retries Wi-Fi every
    // config::WIFI_RETRY_INTERVAL_MS, then the server. Call while not ready.
    void reconnect();

    // Sends one line. On a failed write the socket is closed, so the next loop
    // reconnects.
    bool sendLine(const String& line);

    // Reads one line from the server, trimmed, if one is waiting.
    bool readLine(String& line);

    int nodeId() const { return nodeId_; }
    String macAddress() const { return WiFi.macAddress(); }

private:
    bool connectWiFi();
    bool connectServer();
    bool waitForNodeId();

    WiFiClient client_;
    String serverIp_;
    int nodeId_ = -1;
    bool wifiConnected_ = false;
    unsigned long lastWifiAttemptMs_ = 0;
};

#include "NodeConnection.h"

#include "Config.h"
#include "ServerDiscovery.h"

NodeConnection::NodeConnection()
    : serverIp_(config::AUTO_DISCOVER_SERVER ? "" : config::SERVER_IP) {}

void NodeConnection::begin() {
    connectWiFi();
}

bool NodeConnection::isReady() {
    return WiFi.status() == WL_CONNECTED && client_.connected() && nodeId_ >= 0;
}

void NodeConnection::reconnect() {
    if (WiFi.status() != WL_CONNECTED) {
        if (wifiConnected_ || client_.connected()) {
            Serial.println("Wi-Fi lost");
            wifiConnected_ = false;
            client_.stop();
        }
        if (millis() - lastWifiAttemptMs_ >= config::WIFI_RETRY_INTERVAL_MS) {
            lastWifiAttemptMs_ = millis();
            Serial.println("Retrying Wi-Fi connect...");
            connectWiFi();
        }
        return;
    }

    wifiConnected_ = true;
    if (!client_.connected()) {
        connectServer();
        return;
    }
    // Connected but never given an id: start the handshake again.
    if (nodeId_ < 0) {
        client_.stop();
    }
}

bool NodeConnection::sendLine(const String& line) {
    if (!client_.connected()) {
        return false;
    }
    if (client_.println(line) > 0) {
        return true;
    }
    Serial.println("TCP write failed");
    client_.stop();
    return false;
}

bool NodeConnection::readLine(String& line) {
    if (!client_.connected() || !client_.available()) {
        return false;
    }
    line = client_.readStringUntil('\n');
    line.trim();
    return true;
}

bool NodeConnection::connectWiFi() {
    wifiConnected_ = false;
    client_.stop();

    WiFi.mode(WIFI_OFF);
    delay(200);
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.persistent(false);
    delay(200);
    WiFi.disconnect(true, true);
    delay(200);

    // Scan first, so the connect can go straight to the right channel and
    // access point.
    int targetIndex = -1;
    int networkCount = WiFi.scanNetworks();
    Serial.printf("Wi-Fi scan found %d network(s):\n", networkCount);
    for (int i = 0; i < networkCount; i++) {
        Serial.printf("  %s channel=%d RSSI=%d\n", WiFi.SSID(i).c_str(),
                      static_cast<int>(WiFi.channel(i)), static_cast<int>(WiFi.RSSI(i)));
        if (WiFi.SSID(i) == config::WIFI_SSID) {
            targetIndex = i;
            break;
        }
    }

    if (targetIndex >= 0) {
        Serial.printf("Connecting to SSID on channel %d\n", static_cast<int>(WiFi.channel(targetIndex)));
        WiFi.begin(config::WIFI_SSID, config::WIFI_PASSWORD, WiFi.channel(targetIndex),
                   WiFi.BSSID(targetIndex), true);
    } else {
        Serial.println("Target SSID not found in scan, using generic connect");
        WiFi.begin(config::WIFI_SSID, config::WIFI_PASSWORD);
    }

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < config::WIFI_CONNECT_TIMEOUT_MS) {
        delay(500);
        Serial.println("Connecting to Wi-Fi...");
    }
    if (WiFi.status() != WL_CONNECTED) {
        Serial.printf("Wi-Fi failed, status=%d\n", static_cast<int>(WiFi.status()));
        return false;
    }

    wifiConnected_ = true;
    Serial.print("Connected. IP: ");
    Serial.println(WiFi.localIP());
    return connectServer();
}

bool NodeConnection::connectServer() {
    client_.stop();
    unsigned long start = millis();

    if (serverIp_.isEmpty() &&
        !discoverServer(client_, serverIp_, config::SERVER_PORT, config::SERVER_PROBE_TIMEOUT_MS,
                        config::SERVER_DISCOVERY_TIMEOUT_MS)) {
        return false;
    }

    // Each attempt gets its own explicit timeout, in milliseconds. Passing only
    // the host and port would reuse the socket's stored timeout, and that value
    // is whatever the last setTimeout() left behind - see
    // config::SOCKET_READ_TIMEOUT_SECONDS. One attempt blocking far longer than
    // SERVER_CONNECT_TIMEOUT_MS also defeats the budget check below, which can
    // only run between attempts.
    while (WiFi.status() == WL_CONNECTED && !serverIp_.isEmpty() && !client_.connected() &&
           !client_.connect(serverIp_.c_str(), config::SERVER_PORT, config::SERVER_ATTEMPT_TIMEOUT_MS)) {
        Serial.println("Connecting to TCP server...");
        if (millis() - start >= config::SERVER_CONNECT_TIMEOUT_MS) {
            Serial.println("TCP connect timed out");
            client_.stop();
            return false;
        }
        delay(500);
    }
    if (!client_.connected()) {
        return false;
    }

    Serial.println("TCP connected");
    // Read timeout for control lines, in seconds. This also becomes the connect
    // timeout of the next attempt, which is why the retry loop above passes its
    // own value explicitly rather than relying on it.
    client_.setTimeout(config::SOCKET_READ_TIMEOUT_SECONDS);

    // The handshake: the id this node had before (-1 on a fresh boot) and its
    // MAC, so the server can give a reconnecting node its old id back.
    String handshake = "{";
    handshake += "\"nodeId\":" + String(nodeId_);
    handshake += ",\"mac\":\"" + WiFi.macAddress() + "\"";
    handshake += "}";
    client_.println(handshake);

    return waitForNodeId();
}

// The server answers the handshake with this node's id on a line of its own.
bool NodeConnection::waitForNodeId() {
    int assignedId = -1;
    unsigned long start = millis();
    while (assignedId < 0 && client_.connected()) {
        if (client_.available()) {
            assignedId = client_.readStringUntil('\n').toInt();
            Serial.printf("Server confirmed ID: %d\n", assignedId);
        } else {
            if (millis() - start >= config::NODE_ID_TIMEOUT_MS) {
                Serial.println("Node ID wait timed out");
                client_.stop();
                return false;
            }
            delay(10);
        }
    }
    if (assignedId < 0) {
        return false;
    }
    nodeId_ = assignedId;
    Serial.println("ESP32 Node is initialized");
    return true;
}

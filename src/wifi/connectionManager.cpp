#include "connectionManager.h"
#include "networkDiscovery.h"

constexpr char WIFI_SSID[] = "Josh's S24";
constexpr char WIFI_PASSWORD[] = "bruh12345";
constexpr bool AUTO_DISCOVER_SERVER = false;
constexpr char SERVER_IP[] = "192.168.59.99";
constexpr uint16_t SERVER_PORT = 3000;
constexpr unsigned long SERVER_CONNECT_TIMEOUT_MS = 3000;
constexpr unsigned long SERVER_DISCOVERY_TIMEOUT_MS = 120000;
constexpr int32_t SERVER_PROBE_TIMEOUT_MS = 300;
constexpr unsigned long NODE_ID_TIMEOUT_MS = 2000;

// How long ONE connect attempt may block. Must be well under
// SERVER_CONNECT_TIMEOUT_MS so that budget buys several attempts rather than one
// long stall.
constexpr int32_t SERVER_ATTEMPT_TIMEOUT_MS = 1000;

// WiFiClient::setTimeout takes SECONDS and multiplies by 1000 internally. It also
// doubles as the timeout for the *next* connect(), because connect(host, port)
// forwards this same value as its connect timeout.
constexpr uint32_t SOCKET_READ_TIMEOUT_SECONDS = 1;

int nodeID = -1;
unsigned long lastWifiAttemptMillis = 0;
bool wifiConnected = false;
WiFiClient client;
String serverIP = AUTO_DISCOVER_SERVER ? "" : SERVER_IP;

bool connectServer() {
    client.stop();

    unsigned long start = millis();

    if (serverIP.isEmpty()) {
        if (!discoverServer(client, serverIP, SERVER_PORT, SERVER_PROBE_TIMEOUT_MS,
                            SERVER_DISCOVERY_TIMEOUT_MS)) {
            return false;
        }
    }

    // Each attempt gets its own explicit timeout, in milliseconds. Passing only
    // the host and port would reuse the socket's stored timeout, and that value
    // is whatever the last setTimeout() left behind - see the note on
    // SOCKET_READ_TIMEOUT_SECONDS. One attempt blocking far longer than
    // SERVER_CONNECT_TIMEOUT_MS also defeats the budget check below, which can
    // only run between attempts.
    while (WiFi.status() == WL_CONNECTED && !serverIP.isEmpty() &&
           !client.connected() &&
           !client.connect(serverIP.c_str(), SERVER_PORT,
                           SERVER_ATTEMPT_TIMEOUT_MS)) {
        Serial.println("Connecting to TCP server...");
        if (millis() - start >= SERVER_CONNECT_TIMEOUT_MS) {
            Serial.println("TCP connect timed out");
            client.stop();
            return false;
        }
        delay(500);
    }

    if (!client.connected()) {
        return false;
    }

    Serial.println("TCP connected");
    // Read timeout for control lines, in seconds. This also becomes the connect
    // timeout of the next attempt, which is why the retry loop above passes its
    // own value explicitly rather than relying on it.
    client.setTimeout(SOCKET_READ_TIMEOUT_SECONDS);

    String handshake = "{";
    handshake += "\"nodeId\":" + String(nodeID);
    handshake += ",\"mac\":\"" + WiFi.macAddress() + "\"";
    handshake += "}";
    client.println(handshake);

    int assignedNodeID = -1;

    start = millis();
    while (assignedNodeID < 0 && client.connected()) {
        if (client.available()) {
            String idStr = client.readStringUntil('\n');
            assignedNodeID = idStr.toInt();
            Serial.print("Server confirmed ID: ");
            Serial.println(assignedNodeID);
        } else {
            if (millis() - start >= NODE_ID_TIMEOUT_MS) {
                Serial.println("Node ID wait timed out");
                client.stop();
                return false;
            }
            delay(10);
        }
    }
    if (assignedNodeID >= 0) {
        nodeID = assignedNodeID;
        Serial.println("ESP32 Node is initialized");
        return true;
    }

    return false;
}

bool connectWiFi() {
    wifiConnected = false;
    client.stop();

    WiFi.mode(WIFI_OFF);
    delay(200);
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.persistent(false);
    delay(200);
    WiFi.disconnect(true, true);
    delay(200);

    int32_t targetIndex = -1;
    int32_t networkCount = WiFi.scanNetworks();
    Serial.print("Wi-Fi scan found ");
    Serial.print(networkCount);
    Serial.println(" network(s):");
    if (networkCount > 0) {
        for (int i = 0; i < networkCount; i++) {
            Serial.print("  ");
            Serial.print(WiFi.SSID(i));
            Serial.print(" channel=");
            Serial.print(WiFi.channel(i));
            Serial.print(" RSSI=");
            Serial.println(WiFi.RSSI(i));
            if (WiFi.SSID(i) == WIFI_SSID) {
                targetIndex = i;
                break;
            }
        }
    }

    if (targetIndex >= 0) {
        Serial.print("Connecting to SSID on channel ");
        Serial.println(WiFi.channel(targetIndex));
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD, WiFi.channel(targetIndex), WiFi.BSSID(targetIndex), true);
    } else {
        Serial.println("Target SSID not found in scan, using generic connect");
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
        delay(500);
        Serial.println("Connecting to Wi-Fi...");
    }

    if (WiFi.status() != WL_CONNECTED) {
        Serial.print("Wi-Fi failed, status=");
        Serial.println((int)WiFi.status());
        return false;
    }

    wifiConnected = true;
    Serial.print("Connected. IP: ");
    Serial.println(WiFi.localIP());
    return connectServer();
}

bool sendData(const String& data) {
    if (client.connected()) {
        size_t written = client.println(data);
        if (written > 0) {
            return true;
        }

        Serial.println("TCP write failed");
        client.stop();
    }

    return false;
}

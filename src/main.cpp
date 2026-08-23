#include <Arduino.h>
#include <WiFi.h>
#include "ultrasonicSensor.cpp"

constexpr char WIFI_SSID[] = "Josh's S24";
constexpr char WIFI_PASSWORD[] = "bruh12345";

constexpr bool AUTO_DISCOVER_SERVER = false;
constexpr char SERVER_IP[] = "192.168.1.108";
constexpr uint16_t SERVER_PORT = 3000;

int nodeID = -1;
unsigned long lastWifiAttemptMillis = 0;
constexpr unsigned long WIFI_RETRY_INTERVAL_MS = 1000;
constexpr unsigned long SERVER_CONNECT_TIMEOUT_MS = 3000;
constexpr unsigned long SERVER_DISCOVERY_TIMEOUT_MS = 120000;
constexpr int32_t SERVER_PROBE_TIMEOUT_MS = 300;
constexpr unsigned long NODE_ID_TIMEOUT_MS = 2000;
bool wifiConnected = false;

WiFiClient client;
String serverIP = AUTO_DISCOVER_SERVER ? "" : SERVER_IP;

const int UltrasonicCount = 1;
const int triggerPin = 33;
const int echoPin = 32;
Ultrasonic center(triggerPin, echoPin, "Center");

bool connectServer() {
    client.stop();

    unsigned long start = millis();

    if (serverIP.isEmpty()) {
        IPAddress localIP = WiFi.localIP();
        IPAddress subnetMask = WiFi.subnetMask();
        uint32_t localAddress = (uint32_t(localIP[0]) << 24) |
                                (uint32_t(localIP[1]) << 16) |
                                (uint32_t(localIP[2]) << 8) |
                                uint32_t(localIP[3]);
        uint32_t mask = (uint32_t(subnetMask[0]) << 24) |
                        (uint32_t(subnetMask[1]) << 16) |
                        (uint32_t(subnetMask[2]) << 8) |
                        uint32_t(subnetMask[3]);
        uint32_t network = localAddress & mask;
        uint32_t broadcast = network | ~mask;

        Serial.print("Searching subnet ");
        Serial.print(network >> 24);
        Serial.print('.');
        Serial.print((network >> 16) & 0xff);
        Serial.print('.');
        Serial.print((network >> 8) & 0xff);
        Serial.print('.');
        Serial.print(network & 0xff);
        Serial.println();
        Serial.println("Searching local subnet for TCP server...");

        for (uint32_t distance = 1;
             distance < broadcast - network && millis() - start < SERVER_DISCOVERY_TIMEOUT_MS;
             distance++) {
            for (uint8_t side = 0; side < 2; side++) {
                uint32_t address = side == 0
                    ? localAddress + distance
                    : localAddress >= distance ? localAddress - distance : 0;
                if (address <= network || address >= broadcast || address == localAddress) {
                    continue;
                }

                IPAddress candidate(
                    (address >> 24) & 0xff,
                    (address >> 16) & 0xff,
                    (address >> 8) & 0xff,
                    address & 0xff);
                Serial.print("Trying ");
                Serial.print(candidate.toString());
                Serial.println();
                if (client.connect(candidate, SERVER_PORT, SERVER_PROBE_TIMEOUT_MS)) {
                    serverIP = candidate.toString();
                    Serial.print("Server found at ");
                    Serial.println(serverIP);
                    break;
                }
            }
            if (!serverIP.isEmpty()) {
                break;
            }
        }

        if (serverIP.isEmpty()) {
            Serial.println("TCP server not found on local subnet");
            return false;
        }
    }

    while (WiFi.status() == WL_CONNECTED && !serverIP.isEmpty() &&
           !client.connected() &&
           !client.connect(serverIP.c_str(), SERVER_PORT)) {
        Serial.println("Connecting to TCP server...");
        if (millis() - start >= SERVER_CONNECT_TIMEOUT_MS) {
            Serial.println("TCP connect timed out");
            client.stop();
            return false;
        }
        delay(1000);
    }

    if (!client.connected()) {
        return false;
    }

    Serial.println("TCP connected");
    client.setTimeout(1000);

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
  connectWiFi();
}

//Used for delaying how quickly the ultrasonic is read
int now = 0;
int waitUntil = 0;

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
            connectWiFi();
        }

        return;
    }

    wifiConnected = true;

    if (!client.connected()) {
        connectServer();
        return;
    }

    if (nodeID < 0) {
        client.stop();
        return;
    }

    now = millis();
    if (wifiConnected && client.connected()) {
        if(now >= waitUntil){
            sendSensorSnapshot();
            waitUntil = millis() + 50;
        }
    }
}

#include <Arduino.h>
#include <WiFi.h>
#include "ultrasonicSensor.cpp"

constexpr char WIFI_SSID[] = "Group_1_ENGG3000";
constexpr char WIFI_PASSWORD[] = "1234567890";

constexpr char SERVER_IP[] = "192.168.1.25";
constexpr uint16_t SERVER_PORT = 3000;

int nodeID = -1;
unsigned long lastWifiAttemptMillis = 0;
constexpr unsigned long WIFI_RETRY_INTERVAL_MS = 1000;
constexpr unsigned long SERVER_CONNECT_TIMEOUT_MS = 3000;
constexpr unsigned long NODE_ID_TIMEOUT_MS = 2000;
bool wifiConnected = false;

WiFiClient client;

const int UltrasonicCount = 1;
Ultrasonic center(5, 18, "Center", 50.0f);

bool connectServer() {
    client.stop();

    unsigned long start = millis();
    while (WiFi.status() == WL_CONNECTED && !client.connect(SERVER_IP, SERVER_PORT)) {
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
    client.println(String(nodeID));

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
    if (networkCount > 0) {
        for (int i = 0; i < networkCount; i++) {
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
    bool detected = center.detectBoat();

    String payload = "{";
    payload += "\"nodeId\":" + String(nodeID);
    payload += ",\"mac\":\"" + WiFi.macAddress() + "\"";
    payload += ",\"avg\":" + String(center.avg, 2);
    payload += ",\"detected\":" + String(detected ? "true" : "false");
    payload += "}";

    sendData(payload);
}

void setup() {
  Serial.begin(115200);
  Serial.println("ESP32 Node is starting...");
  connectWiFi();
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

    if (wifiConnected && client.connected()) {
        sendSensorSnapshot();
    }
}

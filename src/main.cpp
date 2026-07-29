#include <Arduino.h>
#include <WiFi.h>
#include "ultrasonicSensor.cpp"

constexpr char WIFI_SSID[] = "Group_1_ENGG3000";
constexpr char WIFI_PASSWORD[] = "1234567890";

constexpr char SERVER_IP[] = "192.168.1.25";
constexpr uint16_t SERVER_PORT = 3000;

int nodeID = -1;
unsigned long lastWifiAttemptMillis = 0;
constexpr unsigned long WIFI_RETRY_INTERVAL_MS = 10000;
bool wifiConnected = false;

WiFiClient client;

const int UltrasonicCount = 1;
Ultrasonic center(5, 18, "Center", 50.0f);

void connectServer() {
    nodeID = -1;
    client.stop();
    while (!client.connect(SERVER_IP, SERVER_PORT)) {
        Serial.println("Connecting to TCP server...");
        delay(1000);
    }

    Serial.println("TCP connected");
    while (nodeID < 0) {
        if (client.available()) {
            String idStr = client.readStringUntil('\n');
            nodeID = idStr.toInt();
            Serial.print("Assigned ID: ");
            Serial.println(nodeID);
        } else {
            delay(10);
        }
    }
    if (nodeID >= 0) {
        Serial.println("ESP32 Node is initialized");
    }
}

void connectWiFi() {
    wifiConnected = false;
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
        return;
    }

    wifiConnected = true;
    Serial.print("Connected. IP: ");
    Serial.println(WiFi.localIP());
    connectServer();
}

void sendData(const String& data) {
    if (client.connected()) {
        client.println(data);
    }
}

void sendSensorSnapshot() {
    bool detected = center.detectBoat();

    String payload = "{";
    payload += "\"nodeId\":" + String(nodeID);
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
    if (WiFi.status() != WL_CONNECTED && millis() - lastWifiAttemptMillis >= WIFI_RETRY_INTERVAL_MS) {
        lastWifiAttemptMillis = millis();
        Serial.println("Retrying Wi-Fi connect...");
        connectWiFi();
    }

    if (wifiConnected && !client.connected()) {
        connectServer();
    }

    if (wifiConnected && client.connected()) {
        sendSensorSnapshot();
    }
}

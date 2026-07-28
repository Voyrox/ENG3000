#include <Arduino.h>
#include <WiFi.h>
#include "ultrasonicSensor.cpp"

constexpr char WIFI_SSID[] = "Group_1_ENGG3000";
constexpr char WIFI_PASSWORD[] = "1234567890";
constexpr char SERVER_IP[] = "192.168.1.100";
constexpr uint16_t SERVER_PORT = 3000;
int nodeID = -1;
unsigned long lastSendMillis = 0;

WiFiClient client;

const int UltrasonicCount = 3;
Ultrasonic left(2, 4, "Left", 50.0f);
Ultrasonic right(5, 18, "Right", 50.0f);
Ultrasonic center(19, 21, "Center", 50.0f);

void connectServer() {
    nodeID = -1;
    while (!client.connected()) {
        Serial.println("Connecting to TCP server...");

        if (!client.connect(SERVER_IP, SERVER_PORT)) {
            delay(1000);
        }
    }

    client.setNoDelay(true);
    Serial.println("TCP connected");
    while (nodeID < 0) {
        if (client.available()) {
            String idStr = client.readStringUntil('\n');
            nodeID = idStr.toInt();
            Serial.print("Assigned ID: ");
            Serial.println(nodeID);
        } else {
            delay(50);
        }
    }
    Serial.println("ESP32 Node is initialized");
}

void connectWiFi() {
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.println("Connecting to Wi-Fi...");
    }

    Serial.print("Connected. IP: ");
    Serial.println(WiFi.localIP());
    connectServer();
}

void sendData(const String& data) {
    if (client.connected()) {
        client.println(data);
        Serial.print("Sent: ");
        Serial.println(data);
    } else {
        Serial.println("Not connected to server. Cannot send data.");
    }
}

void sendSensorSnapshot() {
    bool leftDetected = left.detectBoat();
    bool rightDetected = right.detectBoat();
    bool centerDetected = center.detectBoat();

    String payload = "{";
    payload += "\"nodeId\":" + String(nodeID);
    payload += ",\"leftAvg\":" + String(left.avg, 2);
    payload += ",\"rightAvg\":" + String(right.avg, 2);
    payload += ",\"centerAvg\":" + String(center.avg, 2);
    payload += ",\"leftDetected\":" + String(leftDetected ? "true" : "false");
    payload += ",\"rightDetected\":" + String(rightDetected ? "true" : "false");
    payload += ",\"centerDetected\":" + String(centerDetected ? "true" : "false");
    payload += "}";

    sendData(payload);
}

void setup() {
  Serial.begin(115200);
  Serial.println("ESP32 Node is starting...");
  connectWiFi();
}

void loop() {
    if (WiFi.status() != WL_CONNECTED) {
        connectWiFi();
    }

    if (!client.connected()) {
        client.stop();
        connectServer();
        lastSendMillis = 0;
    }

    if (millis() - lastSendMillis >= 1000) {
        lastSendMillis = millis();
        sendSensorSnapshot();
    }
}

#include <Arduino.h>
#include <WiFi.h>

constexpr char WIFI_SSID[] = "Group_1_ENGG3000";
constexpr char WIFI_PASSWORD[] = "1234567890";
constexpr char SERVER_IP[] = "192.168.1.100";
constexpr uint16_t SERVER_PORT = 3000;
int nodeID = -1;

WiFiClient client;

void connectServer() {
    while (!client.connected()) {
        Serial.println("Connecting to TCP server...");

        if (!client.connect(SERVER_IP, SERVER_PORT)) {
            delay(1000);
        }
    }

    client.setNoDelay(true);
    Serial.println("TCP connected");
    if (client.available()) {
        String idStr = client.readStringUntil('\n');
        nodeID = idStr.toInt();
        Serial.print("Assigned ID: ");
        Serial.println(nodeID);
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
    }
}
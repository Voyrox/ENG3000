#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  Serial.println("ESP32 Node is starting...");
}

void loop() {
  // Your main code here
  Serial.println("ESP32 Node is running...");
  delay(1000); // Delay for 1 second
}
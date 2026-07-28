#include <Arduino.h>

class Ultrasonic {
  public:
  float arr[3] = {100, 100, 100};
  int arrIndex = 0;
  float avg = 0;
  float safeDistance = 0;

  unsigned long currMillis = 0;
  unsigned long blinkPrevMillis = 0;
  const unsigned long blinkDuration = 500;
  int stage = 0;

  int trigPin = 0;
  int echoPin = 0;
  String nametag = "";

  bool detectBoat() {
    currMillis = millis();
    if(stage == 0 && currMillis - blinkPrevMillis >= blinkDuration) {
      digitalWrite(trigPin, LOW);
      stage = 1;
    } else if (stage == 1 && currMillis - blinkPrevMillis >= blinkDuration + 2){
      digitalWrite(trigPin, HIGH);
      stage = 2;
    } else if(stage == 2 && currMillis - blinkPrevMillis >= blinkDuration + 12){
      digitalWrite(trigPin, LOW);
      float duration = pulseIn(echoPin, HIGH);
      float distance = (0.0343f * duration) / 2.0f;
      arr[arrIndex] = distance;
      arrIndex = (arrIndex + 1) % 3;

      avg = (arr[0] + arr[1] + arr[2]) / 3.0f;

      //Serial.print(nametag);
      //Serial.print(", Distance = ");
      //Serial.print(distance);
      //Serial.print(" cm, Average = ");
      //Serial.print(avg);
      //Serial.println(" cm");
      blinkPrevMillis = currMillis;
      stage = 0;
      }
    if(avg <= safeDistance) return true;
    else return false;
  }

  Ultrasonic(int tPin, int ePin, String name, float sDist) {
    trigPin = tPin;
    echoPin = ePin;
    nametag = name;
    safeDistance = sDist;
    pinMode(trigPin, OUTPUT);
    pinMode(echoPin, INPUT);
    digitalWrite(trigPin, LOW);
    avg = (arr[0] + arr[1] + arr[2]) / 3.0f;
  }
};

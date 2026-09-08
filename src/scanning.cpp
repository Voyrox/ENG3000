#include <Arduino.h>
#include <ESP32Servo.h>
#include <cmath>
#include "scanning.h"

//Trigger pin, Echo Pin
int leftUSS[2] = {5, 18};
int rightUSS[2] = {16, 17};
int servoPin = 32;

//Notes
  //Refactor ultrasonics into seperate class later

//Constant and variable definitions
//For the ultrasonic
  const int maxDist = 140;
  const int minDist = 10;

//For the exponential smoothing [current not here -- to reimplement]
  const float aP = 0.6;
  float EAvalue = 100;

//For the servo
  Servo theServo;

// void Scan::scanSetup(){
void scanSetup(){
  // Ultrasonic setup
  pinMode(leftUSS[0], OUTPUT);
  pinMode(leftUSS[1], INPUT);
  digitalWrite(leftUSS[1], LOW);

  pinMode(rightUSS[0], OUTPUT);
  pinMode(rightUSS[1], INPUT);
  digitalWrite(rightUSS[1], LOW);

  // Servo setup
  theServo.attach(servoPin);

  // theServo.write(90);
  // delay(5000);
}

//If both sensors see the person, state = Found, state 0
  //No angle deviations
  //Full data smoothing

//If only one sees the person, state = Half-Found, state 1
  //Small angle deviations (5 degrees)
  //No data smoothing??? [only basic max min, angle customised max min later]

//If neither sees the person, state = Lost, state 2
  //Large angle deviations (20 degrees?)
  //No data smoothing [only basic max min, angle customised max min later]

//Assumption being if in range, theres a target, if out of range there is no target
//Left is towards max [i.e. ++]
//Right is towards min [i.e. --]

int state = 0;
int angle = 90;
int dir = 1;

bool rotate(int amount){
  bool returnVal = false;
  angle = angle + amount;
  if (angle > 150){
    angle = 150;
    returnVal = true;
  }
  if (angle < 30){
    angle = 30;
    returnVal = true;
  }
  theServo.write(angle);
  return returnVal;
}

float ultraSonicRead(const int USS[2]){
  const int trigPin = USS[0];
  const int echoPin = USS[1];

  // Clear the trigPin
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  
  // Set the trigPin HIGH for 10 microseconds
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);
  
  // Read the echoPin, returns sound wave travel time in microseconds
  unsigned long duration = pulseIn(echoPin, HIGH, 50000); //Timeout in 50ms, aka 17 metres
  
  // Calculate the distance (speed of sound is 0.034 cm/us, divided by 2 for round trip)
  float distance = (duration * 0.034) / 2;

  return distance;
}

int rotationWaitTrack = 0;
int leftSensorWait = 0;
int rightSesnorWait = 0;
const int rotatationWait = 20;
const int ultraSonicWait = 20;
bool sensorWaiting = false;

float leftVal = 0;
float rightVal = 0;

bool scanLoop(){
  if ((rotationWaitTrack + rotatationWait) >= millis()){
    return false;
  }

  if(!sensorWaiting){
    leftVal = ultraSonicRead(leftUSS);
    sensorWaiting = true;
  }

  if (leftSensorWait + ultraSonicWait >= millis()){
    return false;
  } else  {
    sensorWaiting = false;
  }

  rightVal = ultraSonicRead(rightUSS);

  bool leftInRange = (leftVal >= minDist && leftVal <= maxDist);
  bool rightInRange = (rightVal >= minDist && rightVal <= maxDist);

  if (leftInRange && rightInRange){
    float diff = abs((leftVal - rightVal));
    if(diff < 20){
      state = 0;
    }
  } 
  else if (leftInRange){ //Combine if no logic for individual sides will be processed here
    state = 1;
  }
  else if (rightInRange){
    state = 1;
  }
  else {
    state = 2;
  }

  Serial.println(leftVal);
  Serial.println(rightVal);
  Serial.println(state);
  Serial.println();

  switch (state){
    case 0:{
      //Put in trilateration (+ angle correction? - depending on how the final value is caculated)
      // Serial.println(leftVal);
      // Serial.println(rightVal);
      break;
    }
    case 1:{
      if(leftInRange){
        rotate(5);
      } else {
        rotate(-5);
      }
      break;
    }
    case 2:{
      bool flip = rotate(20 * dir);
      if(flip){
        dir = -dir;
      }
      break;
    }
  }

  rotationWaitTrack = millis();
  return true;
}

int getLeftVal(){
  return leftVal;
}

int getRightVal(){
  return rightVal;
}
#include <Arduino.h>
#include <ESP32Servo.h>
#include <cmath>
#include "scanning.h"

//Trigger pin, Echo Pin
int leftUSS[2] = {33, 32};
int rightUSS[2] = {33, 32};
int servoPin = 15;

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

  theServo.write(90);
  delay(5000);
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

//USB 0001 is the left one, 1320 is the right one

//For the left node; maxLeft = 150 [90 + 60], maxRight = 50 [90 - 40]

//For the right node; maxLeft = 130 [90 + 40], maxRight = 40 [90 - 50]

// Servo limits per mount. Which node is which is decided on the game's
// calibration screen, and the server passes it on as ROLE LEFT / ROLE RIGHT
// (setScanRole). Until then the node sweeps only the range both mounts allow.
struct ScanLimits {
  int maxLeft;
  int maxRight;
};
const ScanLimits LEFT_NODE_LIMITS = {160, 40};
const ScanLimits RIGHT_NODE_LIMITS = {140, 30};
const ScanLimits UNKNOWN_ROLE_LIMITS = {140, 40};

int maxLeft = UNKNOWN_ROLE_LIMITS.maxLeft;
int maxRight = UNKNOWN_ROLE_LIMITS.maxRight;

bool rotate(int amount){
  bool returnVal = false;
  angle = angle + amount;
  if (angle > maxLeft){
    angle = maxLeft;
    returnVal = true;
  }
  if (angle < maxRight){
    angle = maxRight;
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

  // No echo before the timeout. -1, not 0: a 0 reads as "touching the
  // sensor" to anything downstream, which is what the game's too-close alert
  // is looking for.
  if (duration == 0) {
    return -1;
  }

  // Calculate the distance (speed of sound is 0.034 cm/us, divided by 2 for round trip)
  float distance = (duration * 0.034) / 2;

  return distance;
}

void setScanRole(ScanRole role) {
  ScanLimits limits = UNKNOWN_ROLE_LIMITS;
  if (role == ROLE_LEFT) limits = LEFT_NODE_LIMITS;
  if (role == ROLE_RIGHT) limits = RIGHT_NODE_LIMITS;
  maxLeft = limits.maxLeft;
  maxRight = limits.maxRight;
  rotate(0);  // pull the servo back inside the new limits straight away
}

int rotationWaitTrack = 0;
const int rotatationWait = 30;
const int sideReadDelay = 30;
int ultrasonicWaitTrack = 0;
bool readLeftNext = true;

float leftVal = -1;
float rightVal = -1;
int readAngle = 90;  // the servo angle the latest pair was read at

bool scanLoop(){
  if ((rotationWaitTrack + rotatationWait) >= millis()){
    return false;
  }

  if(readLeftNext){
    leftVal = ultraSonicRead(leftUSS);
    ultrasonicWaitTrack = millis();
    readLeftNext = false;
  }

  if((ultrasonicWaitTrack + sideReadDelay) < millis()){
    rightVal = ultraSonicRead(rightUSS);
    readLeftNext = true;
  } else{
    // Serial.print(millis());
    // Serial.println(" waiting");
    return false;
  }

  bool leftInRange = (leftVal >= minDist && leftVal <= maxDist);
  bool rightInRange = (rightVal >= minDist && rightVal <= maxDist);

  const int maxDiff = 30;

  if (leftInRange && rightInRange){
    float diff = abs((leftVal - rightVal));
    if(diff < maxDiff){
      state = 0;
    }
  }
  else if (leftInRange){
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

  const int smallRotation = 4;
  const int largeRotation = 15;

  // Both sensors were read at this angle; the servo only moves below.
  readAngle = angle;

  switch (state){
    case 0:{
      break;
    }
    case 1:{
      if(leftInRange){
        rotate(smallRotation);
      } else {
        rotate(-smallRotation);
      }
      break;
    }
    case 2:{
      bool flip = rotate(largeRotation * dir);
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

float getLeftCm(){
  return leftVal;
}

float getRightCm(){
  return rightVal;
}

int getScanAngle(){
  return readAngle;
}

int getScanState(){
  return state;
}

// The node's distance to the player. Only sensors reading inside the scan
// range count: averaging in a missed echo or a wall behind the player would
// put them somewhere they are not. With nothing in range, the nearer real
// echo is still sent, so the game can say too close or out of bounds.
float getScanDistance(){
  bool leftInRange = (leftVal >= minDist && leftVal <= maxDist);
  bool rightInRange = (rightVal >= minDist && rightVal <= maxDist);
  if (leftInRange && rightInRange) return (leftVal + rightVal) / 2.0;
  if (leftInRange) return leftVal;
  if (rightInRange) return rightVal;
  if (leftVal > 0 && rightVal > 0) return min(leftVal, rightVal);
  if (leftVal > 0) return leftVal;
  if (rightVal > 0) return rightVal;
  return -1;
}

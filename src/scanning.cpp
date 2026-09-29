#include <Arduino.h>
#include <ESP32Servo.h>
#include <cmath>
#include "scanning.h"

//Trigger pin, Echo Pin - two sensors side by side on the servo horn
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

// How long the servo is given to actually arrive at a commanded angle before
// anything is read through it. The pulse the previous read left in the air, and
// the mechanics of the horn itself, both need clearing time: a reading taken
// while the horn is still travelling describes some angle the rig was never at,
// and two such readings are not two views of the same place.
  const unsigned long servoSettleMs = 40;

// How long a reading may wait for its echo. Sound covers the round trip to the
// far edge of the play area in about 8.2 ms, so anything past this is not a
// target. The old 50 ms budget let one dropped echo stall the whole scan for
// seventeen metres' worth of nothing.
  const unsigned long echoTimeoutUs = 9000;

// Returned when no echo came back. Distinct from a reading of 0 cm, which is
// impossible, and from a real close target: a dropped echo must not be allowed to
// masquerade as a distance, or the scan treats silence as "nothing there" and
// swings past a player who is standing right there.
  const float NO_ECHO = -1.0f;

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
// Direction the half-found case steers in. Kept apart from `dir` (the sweep
// direction used when the player is lost) so a stuck sweep cannot drag the
// steering with it, and vice versa.
int steerDir = 1;

// When the servo was last commanded to a new angle. Nothing is read through the
// horn until it has had time to get there. Declared with the rest of the scan
// state, ahead of rotate(), which is what sets it.
unsigned long lastServoWriteAt = 0;

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
  lastServoWriteAt = millis();
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
  unsigned long duration = pulseIn(echoPin, HIGH, echoTimeoutUs);

  // A timeout reads as zero, which would come out as a distance of 0 cm - a
  // target pressed against the sensor. Report silence as silence instead.
  if (duration <= 0) {
    return NO_ECHO;
  }

  // Calculate the distance (speed of sound is 0.034 cm/us, divided by 2 for round trip)
  float distance = (duration * 0.034) / 2;

  return distance;
}

// Calibration: the server holds the servo at a fixed angle (AIM 90) while the
// operator aims each node straight out by hand, then lets it scan again (SCAN).
// While held the node still reads and reports - the calibration screen needs
// the readings to tell which node is which - but it neither steers nor sweeps.
bool aimHeld = false;

void aimServoAt(int degrees) {
  aimHeld = true;
  angle = constrain(degrees, 0, 180);
  theServo.write(angle);
  lastServoWriteAt = millis();
}

void resumeScanning() {
  aimHeld = false;
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
const int sideReadDelay = 50;
int ultrasonicWaitTrack = 0;
bool readLeftNext = true;

float leftVal = NO_ECHO;
float rightVal = NO_ECHO;
int readAngle = 90;  // the servo angle the latest pair was read at

bool scanLoop(){
  if ((rotationWaitTrack + rotatationWait) >= millis()){
    return false;
  }

  // A reading taken while the horn is still travelling describes an angle the
  // rig was never at, so it cannot be compared with - or triangulated against -
  // a reading from a settled horn. Wait the horn out first.
  if ((lastServoWriteAt + servoSettleMs) >= millis()){
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

  const int maxDiff = 40;

  if (leftInRange && rightInRange && fabsf(leftVal - rightVal) < maxDiff){
    state = 0;
  }
  else if (leftInRange || rightInRange){
    // One sensor, or both but too far apart to be the same target at a
    // straight-on angle. Either way the player is off to one side, so steer.
    // Previously this left `state` holding whatever it was before, so a scan
    // that arrived here from "found" would sit still and never turn.
    state = 1;
  }
  else {
    state = 2;
  }

  Serial.println(leftVal);
  Serial.println(rightVal);
  Serial.println(state);
  Serial.println();

  const int smallRotation = 3;
  const int largeRotation = 14;

  // Both sensors were read at this angle; the servo only moves below.
  readAngle = angle;

  // Held straight for calibration: report this reading, but do not move.
  if (aimHeld) {
    rotationWaitTrack = millis();
    return true;
  }

  switch (state){
    case 0:{
      steerDir = 1;
      break;
    }
    case 1:{
      // Steer toward whichever sensor has the player (left is towards max,
      // right towards min): the only one in range, or the nearer one when both
      // are in range but too far apart to be the same target.
      //
      // If that runs the servo into its own stop it is no longer chasing
      // anything - it is grinding against the limit - and without this it would
      // sit there pinned until the player happened to walk away. steerDir
      // reverses the next step, so the rig backs off the stop, and the step
      // after that steers toward the player again.
      bool towardLeft = leftInRange && (!rightInRange || leftVal <= rightVal);
      int step = (towardLeft ? smallRotation : -smallRotation) * steerDir;
      bool flip = rotate(step);
      steerDir = flip ? -steerDir : 1;
      break;
    }
    case 2:{
      steerDir = 1;
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

float getLeftVal(){
  return leftVal;
}

float getRightVal(){
  return rightVal;
}

// The pose the readings above were taken at. Until the rig reports these the
// broker and the website have no idea where a node is pointing, so "left" and
// "right" are just two distances and not a position. This is the angle the
// pair was READ at: scanLoop() turns the servo straight after reading, so the
// live `angle` is already one step on by the time the reading is sent.
int getAngle(){
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
  return NO_ECHO;
}

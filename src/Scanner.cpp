#include "Scanner.h"

// --- ScanReading ------------------------------------------------------------

// Only sensors reading inside the play area count: averaging in a missed echo
// or a wall behind the player would put them somewhere they are not. With
// nothing in range, the nearer real echo is still sent, so the game can say too
// close or out of bounds.
float ScanReading::distanceCm() const {
    bool leftIsTarget = UltrasonicSensor::isTarget(leftCm);
    bool rightIsTarget = UltrasonicSensor::isTarget(rightCm);
    if (leftIsTarget && rightIsTarget) return (leftCm + rightCm) / 2.0f;
    if (leftIsTarget) return leftCm;
    if (rightIsTarget) return rightCm;
    if (leftCm > 0 && rightCm > 0) return min(leftCm, rightCm);
    if (leftCm > 0) return leftCm;
    if (rightCm > 0) return rightCm;
    return config::NO_ECHO;
}

ScanState ScanReading::classify(float leftCm, float rightCm) {
    bool leftIsTarget = UltrasonicSensor::isTarget(leftCm);
    bool rightIsTarget = UltrasonicSensor::isTarget(rightCm);

    if (leftIsTarget && rightIsTarget && fabsf(leftCm - rightCm) < config::MAX_PAIR_DIFF_CM) {
        return ScanState::Found;
    }
    // One sensor, or both but too far apart to be the same target at a
    // straight-on angle. Either way the player is off to one side, so steer.
    if (leftIsTarget || rightIsTarget) {
        return ScanState::HalfFound;
    }
    return ScanState::Lost;
}

// --- Scanner ----------------------------------------------------------------

Scanner::Scanner(UltrasonicSensor& left, UltrasonicSensor& right, ScannerServo& servo)
    : leftSensor_(left), rightSensor_(right), servo_(servo) {}

void Scanner::begin() {
    leftSensor_.begin();
    rightSensor_.begin();
    servo_.begin();
}

bool Scanner::update() {
    PulsePair pair;
    if (!readPair(pair)) {
        return false;
    }
    logPair(pair);

    if (pulseCount_ < config::MAX_PULSES_PER_ANGLE) {
        pulses_[pulseCount_++] = pair;
    }
    if (isCollectingMore(pair)) {
        return false;
    }

    latest_ = averagePulses();
    pulseCount_ = 0;
    move(latest_);
    return true;
}

void Scanner::setRole(NodeRole role) {
    servo_.setRole(role);
    restart();
}

void Scanner::holdAt(int degrees) {
    servo_.holdAt(degrees);
    restart();
}

void Scanner::resumeScanning() {
    servo_.release();
    restart();
}

void Scanner::lookAt(int degrees) {
    if (servo_.isHeld()) {
        return;
    }
    int before = servo_.angleDeg();
    servo_.stepBy(degrees - before);
    lookStartMs_ = millis();
    lookSettleMs_ = abs(servo_.angleDeg() - before) * config::LOOK_SETTLE_MS_PER_DEG;
    restart();
}

void Scanner::setPulsesPerAngle(int count) {
    pulsesPerAngle_ = constrain(count, 1, config::MAX_PULSES_PER_ANGLE);
}

void Scanner::restart() {
    readLeftNext_ = true;
    pulseCount_ = 0;
}

// Reads one pulse pair without blocking: the left sensor, then the right one
// once config::SIDE_GAP_MS has passed. Returns true once both are in.
bool Scanner::readPair(PulsePair& pair) {
    if (millis() - lastPairMs_ <= config::PAIR_GAP_MS) {
        return false;
    }

    // A reading taken while the horn is still travelling describes an angle the
    // rig was never at, so it cannot be compared with - or triangulated against -
    // a reading from a settled horn. Wait the horn out first.
    if (!servo_.isSettled()) {
        return false;
    }
    // A LOOK swing is longer than a scan step, so it is waited out in full.
    if (millis() - lookStartMs_ < lookSettleMs_) {
        return false;
    }

    if (readLeftNext_) {
        pendingLeftCm_ = leftSensor_.readCm();
        leftReadMs_ = millis();
        readLeftNext_ = false;
    }
    if (millis() - leftReadMs_ <= config::SIDE_GAP_MS) {
        return false;
    }

    pair.leftCm = pendingLeftCm_;
    pair.rightCm = rightSensor_.readCm();
    readLeftNext_ = true;
    lastPairMs_ = millis();
    return true;
}

// Whether to stay at this angle for another pair before reporting and moving.
bool Scanner::isCollectingMore(const PulsePair& pair) const {
    if (pulseCount_ >= pulsesPerAngle_) {
        return false; // this angle has all its pulses
    }
    // Held for calibration: the servo is not moving anyway, and the calibration
    // screen wants every reading as it comes.
    if (servo_.isHeld()) {
        return false;
    }
    // Only a found or half-found angle is worth a second look; a lost first
    // pair sweeps straight away.
    if (pulseCount_ == 1 && ScanReading::classify(pair.leftCm, pair.rightCm) == ScanState::Lost) {
        return false;
    }
    return true;
}

// One reading from the pulses collected at this angle. With a single pulse
// (multi-pulse off) it is exactly that pulse.
ScanReading Scanner::averagePulses() const {
    float leftReadings[config::MAX_PULSES_PER_ANGLE];
    float rightReadings[config::MAX_PULSES_PER_ANGLE];
    for (int i = 0; i < pulseCount_; i++) {
        leftReadings[i] = pulses_[i].leftCm;
        rightReadings[i] = pulses_[i].rightCm;
    }

    ScanReading reading;
    reading.leftCm = averageWithoutOutliers(leftReadings, pulseCount_);
    reading.rightCm = averageWithoutOutliers(rightReadings, pulseCount_);
    reading.angleDeg = servo_.angleDeg(); // the servo has not moved since the first pulse
    reading.state = ScanReading::classify(reading.leftCm, reading.rightCm);

    if (config::LOG_EVERY_PAIR && pulseCount_ > 1) {
        Serial.printf("  average of %d: L %.2f  R %.2f  state %d\n", pulseCount_,
                      reading.leftCm, reading.rightCm, static_cast<int>(reading.state));
    }
    return reading;
}

// The average of one sensor's pulses at one angle, outliers left out:
//   - pulses with no echo are skipped (none at all: config::NO_ECHO);
//   - if any echo is inside the play area, only those count: an echo outside it
//     cannot be the player (with none inside, the rest are still averaged, so
//     the game can say too close or out of bounds);
//   - an echo more than config::OUTLIER_TOLERANCE_CM from the median is an
//     outlier - a missed player hitting the wall behind, say - and is dropped;
//   - the rest are averaged.
// With an even number of echoes the lower median is used, so of two echoes
// that disagree the nearer one is kept: the player stands in front of the
// background, not behind it.
float Scanner::averageWithoutOutliers(const float* readings, int count) {
    bool anyTarget = false;
    for (int i = 0; i < count; i++) {
        anyTarget = anyTarget || UltrasonicSensor::isTarget(readings[i]);
    }

    float echoes[config::MAX_PULSES_PER_ANGLE];
    int echoCount = 0;
    for (int i = 0; i < count; i++) {
        bool counts = anyTarget ? UltrasonicSensor::isTarget(readings[i]) : readings[i] > 0;
        if (counts) {
            echoes[echoCount++] = readings[i];
        }
    }
    if (echoCount == 0) {
        return config::NO_ECHO;
    }

    // Insertion sort: there are at most config::MAX_PULSES_PER_ANGLE.
    for (int i = 1; i < echoCount; i++) {
        float echo = echoes[i];
        int j = i - 1;
        while (j >= 0 && echoes[j] > echo) {
            echoes[j + 1] = echoes[j];
            j--;
        }
        echoes[j + 1] = echo;
    }
    float median = echoes[(echoCount - 1) / 2];

    float sum = 0;
    int kept = 0;
    for (int i = 0; i < echoCount; i++) {
        if (fabsf(echoes[i] - median) <= config::OUTLIER_TOLERANCE_CM) {
            sum += echoes[i];
            kept++;
        }
    }
    return sum / kept; // the median itself is always kept
}

void Scanner::move(const ScanReading& reading) {
    // Held straight for calibration: report the reading, but do not move.
    if (servo_.isHeld()) {
        return;
    }

    switch (reading.state) {
    case ScanState::Found:
        steerDir_ = 1;
        break;

    case ScanState::HalfFound: {
        // Steer towards whichever sensor has the player (left is towards the
        // larger angle): the only one in range, or the nearer one when both
        // are in range but too far apart to be the same target.
        //
        // If that runs the servo into its own stop it is no longer chasing
        // anything - it is grinding against the limit. steerDir_ reverses the
        // next step, so the rig backs off the stop, and the step after that
        // steers towards the player again.
        bool leftIsTarget = UltrasonicSensor::isTarget(reading.leftCm);
        bool rightIsTarget = UltrasonicSensor::isTarget(reading.rightCm);
        bool towardsLeft = leftIsTarget && (!rightIsTarget || reading.leftCm <= reading.rightCm);
        int step = (towardsLeft ? config::STEER_STEP_DEG : -config::STEER_STEP_DEG) * steerDir_;
        bool hitLimit = servo_.stepBy(step);
        steerDir_ = hitLimit ? -steerDir_ : 1;
        break;
    }

    case ScanState::Lost:
        steerDir_ = 1;
        if (servo_.stepBy(config::SWEEP_STEP_DEG * sweepDir_)) {
            sweepDir_ = -sweepDir_;
        }
        break;
    }
}

void Scanner::logPair(const PulsePair& pair) const {
    if (!config::LOG_EVERY_PAIR) {
        return;
    }
    Serial.printf("L %.2f  R %.2f  state %d  angle %d\n", pair.leftCm, pair.rightCm,
                  static_cast<int>(ScanReading::classify(pair.leftCm, pair.rightCm)),
                  servo_.angleDeg());
}

#include "ScannerServo.h"

ScannerServo::ScannerServo(uint8_t pin) : pin_(pin) {}

void ScannerServo::begin() {
    servo_.attach(pin_);
    write(config::CENTRE_DEG);
    delay(config::BOOT_SETTLE_MS);
}

bool ScannerServo::stepBy(int deltaDeg) {
    if (held_) {
        return false;
    }

    int target = angleDeg_ + deltaDeg;
    bool hitLimit = false;
    if (target > limits_.maxLeftDeg) {
        target = limits_.maxLeftDeg;
        hitLimit = true;
    }
    if (target < limits_.maxRightDeg) {
        target = limits_.maxRightDeg;
        hitLimit = true;
    }
    write(target);
    return hitLimit;
}

void ScannerServo::holdAt(int degrees) {
    held_ = true;
    write(constrain(degrees, 0, 180));
}

void ScannerServo::release() {
    held_ = false;
    stepBy(0); // inside this mount's limits before the first scan step
}

void ScannerServo::setRole(NodeRole role) {
    switch (role) {
    case NodeRole::Left:
        limits_ = config::LEFT_NODE_LIMITS;
        break;
    case NodeRole::Right:
        limits_ = config::RIGHT_NODE_LIMITS;
        break;
    default:
        limits_ = config::UNKNOWN_ROLE_LIMITS;
        break;
    }
    stepBy(0); // pull the servo back inside the new limits (not while held)
}

bool ScannerServo::isSettled() const {
    return millis() - lastWriteMs_ > config::SERVO_SETTLE_MS;
}

void ScannerServo::write(int degrees) {
    angleDeg_ = degrees;
    servo_.write(angleDeg_);
    lastWriteMs_ = millis();
}

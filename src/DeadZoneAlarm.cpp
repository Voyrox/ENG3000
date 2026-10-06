#include "DeadZoneAlarm.h"

// A passive buzzer's tone goes out on this LEDC channel. ESP32Servo takes its
// channels from timer 0 first, and channel 15 runs off timer 3, so the tone
// cannot change the servo's 50 Hz.
static constexpr uint8_t TONE_CHANNEL = 15;

DeadZoneAlarm::DeadZoneAlarm(uint8_t buzzerPin) : pin_(buzzerPin) {}

void DeadZoneAlarm::begin() {
    if (config::BUZZER_TONE_HZ > 0) {
        ledcSetup(TONE_CHANNEL, config::BUZZER_TONE_HZ, 8);
        ledcAttachPin(pin_, TONE_CHANNEL);
        ledcWriteTone(TONE_CHANNEL, 0);
    } else {
        pinMode(pin_, OUTPUT);
        digitalWrite(pin_, LOW);
    }
}

void DeadZoneAlarm::hear(float leftCm, float rightCm, int angleDeg) {
    float left = depthCm(leftCm, angleDeg);
    float right = depthCm(rightCm, angleDeg);
    float nearest;
    if (left >= 0 && right >= 0) {
        nearest = min(left, right);
    } else if (left >= 0) {
        nearest = left;
    } else if (right >= 0) {
        nearest = right;
    } else {
        return; // no echo at all
    }

    if (nearest < config::DEAD_ZONE_CM) {
        lastCloseMs_ = millis();
        if (++closePairs_ >= config::DEAD_ZONE_PAIRS && !sounding_) {
            Serial.printf("Dead zone: buzzer on, %.1f cm from the line at angle %d\n", nearest, angleDeg);
            sound(true);
        }
        return;
    }

    closePairs_ = 0;
    if (sounding_ && nearest >= config::DEAD_ZONE_CM + config::DEAD_ZONE_CLEAR_CM) {
        Serial.printf("Dead zone: buzzer off, %.1f cm from the line\n", nearest);
        sound(false);
    }
}

void DeadZoneAlarm::update() {
    if (millis() - lastCloseMs_ <= config::DEAD_ZONE_HOLD_MS) {
        return;
    }
    closePairs_ = 0;
    if (sounding_) {
        Serial.println("Dead zone: buzzer off, nothing in the dead zone for a while");
        sound(false);
    }
}

float DeadZoneAlarm::depthCm(float distanceCm, int angleDeg) {
    if (distanceCm <= 0) {
        return config::NO_ECHO;
    }
    return distanceCm * sinf(radians(angleDeg));
}

void DeadZoneAlarm::sound(bool on) {
    sounding_ = on;
    if (config::BUZZER_TONE_HZ > 0) {
        ledcWriteTone(TONE_CHANNEL, on ? config::BUZZER_TONE_HZ : 0);
    } else {
        digitalWrite(pin_, on ? HIGH : LOW);
    }
}

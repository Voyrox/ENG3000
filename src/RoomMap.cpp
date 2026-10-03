#include "RoomMap.h"

#include <Preferences.h>

namespace {
// Where the room is kept in flash (NVS).
constexpr char PREFS_NAMESPACE[] = "room";
constexpr char PREFS_KEY[] = "map";
} // namespace

void RoomMap::begin() {
    clearRoom();
    Preferences prefs;
    if (!prefs.begin(PREFS_NAMESPACE, false)) {
        return;
    }
    // A room saved with another layout (a different ANGLES, say) is not this one.
    if (prefs.getBytesLength(PREFS_KEY) == sizeof(roomCm_)) {
        prefs.getBytes(PREFS_KEY, roomCm_, sizeof(roomCm_));
        learned_ = true;
    }
    prefs.end();
}

void RoomMap::startLearning() {
    memset(sampleCount_, 0, sizeof(sampleCount_));
    learning_ = true;
}

void RoomMap::record(int angleDeg, float leftCm, float rightCm) {
    if (!learning_ || angleDeg < 0 || angleDeg >= ANGLES || sampleCount_[angleDeg] >= SAMPLES) {
        return;
    }
    int index = sampleCount_[angleDeg]++;
    samples_[static_cast<int>(Side::Left)][angleDeg][index] = leftCm;
    samples_[static_cast<int>(Side::Right)][angleDeg][index] = rightCm;
}

void RoomMap::finishLearning() {
    if (!learning_) {
        return;
    }
    for (int side = 0; side < 2; side++) {
        for (int angle = 0; angle < ANGLES; angle++) {
            roomCm_[side][angle] = learntEcho(side, angle);
        }
    }
    learning_ = false;
    learned_ = true;

    Preferences prefs;
    if (prefs.begin(PREFS_NAMESPACE, false)) {
        prefs.putBytes(PREFS_KEY, roomCm_, sizeof(roomCm_));
        prefs.end();
    }
}

void RoomMap::cancelLearning() {
    learning_ = false;
}

void RoomMap::forget() {
    learning_ = false;
    clearRoom();
    Preferences prefs;
    if (prefs.begin(PREFS_NAMESPACE, false)) {
        prefs.remove(PREFS_KEY);
        prefs.end();
    }
}

RoomStatus RoomMap::status() const {
    if (learning_) {
        return RoomStatus::Learning;
    }
    return learned_ ? RoomStatus::Learned : RoomStatus::NotLearned;
}

// The room is the nearest learnt echo within config::ROOM_STEP_DEG of the angle:
// the beam is far wider than one step, so a chair seen at one learnt angle is
// in the beam at the angles either side of it too. Anything not clearly nearer
// than that is the chair - or something behind it, which the chair would hide.
bool RoomMap::isRoom(Side side, int angleDeg, float distanceCm) const {
    if (!learned_ || distanceCm <= 0) {
        return false;
    }
    int s = static_cast<int>(side);
    int from = constrain(angleDeg - config::ROOM_STEP_DEG, 0, ANGLES - 1);
    int to = constrain(angleDeg + config::ROOM_STEP_DEG, 0, ANGLES - 1);
    float nearest = config::NO_ECHO;
    for (int angle = from; angle <= to; angle++) {
        float room = roomCm_[s][angle];
        if (room > 0 && (nearest <= 0 || room < nearest)) {
            nearest = room;
        }
    }
    return nearest > 0 && distanceCm >= nearest - config::ROOM_MARGIN_CM;
}

// The nearest echo read at this angle that another reading backs up, or
// NO_ECHO: none read here, or none backed up.
float RoomMap::learntEcho(int side, int angleDeg) const {
    float nearest = config::NO_ECHO;
    for (int i = 0; i < sampleCount_[angleDeg]; i++) {
        float echo = samples_[side][angleDeg][i];
        if (echo <= 0 || (nearest > 0 && echo >= nearest)) {
            continue;
        }
        if (hasMatch(side, angleDeg, i, echo)) {
            nearest = echo;
        }
    }
    return nearest;
}

// Whether another reading by the same sensor - at this angle, or within
// config::ROOM_STEP_DEG of it - is within config::ROOM_MATCH_CM of this echo.
bool RoomMap::hasMatch(int side, int angleDeg, int sampleIndex, float echoCm) const {
    int from = constrain(angleDeg - config::ROOM_STEP_DEG, 0, ANGLES - 1);
    int to = constrain(angleDeg + config::ROOM_STEP_DEG, 0, ANGLES - 1);
    for (int angle = from; angle <= to; angle++) {
        for (int i = 0; i < sampleCount_[angle]; i++) {
            if (angle == angleDeg && i == sampleIndex) {
                continue;
            }
            float other = samples_[side][angle][i];
            if (other > 0 && fabsf(other - echoCm) <= config::ROOM_MATCH_CM) {
                return true;
            }
        }
    }
    return false;
}

void RoomMap::clearRoom() {
    for (int side = 0; side < 2; side++) {
        for (int angle = 0; angle < ANGLES; angle++) {
            roomCm_[side][angle] = config::NO_ECHO;
        }
    }
    learned_ = false;
}

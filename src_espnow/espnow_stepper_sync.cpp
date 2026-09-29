// espnow_stepper_sync.cpp - Two ESP32s, each driving one stepper + one
// ultrasonic sensor, sweeping in lockstep via free-run + periodic resync.
//
// The first version of this PoC sent a packet after every single step, so
// the slave's motion depended on network delivery for all 400 steps of a
// sweep. This version flips that around: both boards compute their own
// position purely from elapsed LOCAL time, using the identical deterministic
// formula in stepForElapsed() below, so almost no step depends on a packet
// arriving at all. The master just periodically (RESYNC_INTERVAL_MS)
// broadcasts how much time has elapsed since ITS sweep began; the slave
// re-anchors its own clock reference to match, correcting whatever drift has
// crept in since the last beacon. That same packet doubles as the "start"
// signal - the slave does nothing until the first one arrives.

// --- One-time setup, per pair of boards ---
//   1. Flash EITHER role to a board (see the two PlatformIO envs below) and
//      open its serial monitor. It prints "My MAC: aa:bb:cc:dd:ee:ff" on boot.
//   2. Copy that address into PEER_MAC on the OTHER board's source, then
//      build and flash that one.
//   3. Repeat in the other direction so each board's PEER_MAC holds the
//      OTHER board's address, not its own.
//   4. Both boards must be on the same Wi-Fi channel as your access point -
//      ESP-NOW and station mode share one radio. This PoC never calls
//      WiFi.begin(), so both boards stay on the default channel and pair up
//      with no access point involved at all.

//
// Build with:
//   pio run -e espnow_master -t upload
//   pio run -e espnow_slave  -t upload

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <cstring>

#if !defined(ROLE_MASTER) && !defined(ROLE_SLAVE)
#error "Define ROLE_MASTER or ROLE_SLAVE via build_flags - see platformio.ini"
#endif

// --- Fill in before flashing -------------------------------------------------
// The OTHER board's MAC address, printed on its own boot. Master's copy holds
// the slave's address and vice versa - the two boards never hold the same value.
static uint8_t PEER_MAC[6] = { 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 };

// --- Stepper wiring -----------------------------------------------------
constexpr int PIN_STEP = 25;
constexpr int PIN_DIR = 26;
constexpr int PIN_ENABLE = 27; // most drivers enable the output stage on LOW

// --- Sweep geometry and speed --------------------------------------------
// How many microsteps cover the full sweep. Work this out from
// (degrees of travel wanted / motor step angle) * microstepping factor, e.g.
// a 180 degree sweep on a 1.8 degree/step motor at 1/4 microstepping is
// (180 / 1.8) * 4 = 400. Placeholder, not a measurement.
constexpr int32_t STEPS_PER_SWEEP = 400;

// How long one one-way sweep should take. This is now the speed knob - the
// time between individual steps is derived from it, not set directly.
constexpr uint32_t SWEEP_DURATION_MS = 2000;
constexpr uint32_t STEP_PERIOD_US = SWEEP_DURATION_MS * 1000UL / STEPS_PER_SWEEP;

// Electrical HIGH time for the STEP pulse itself - a driver requirement
// (check the datasheet; A4988/DRV8825/TMC2208 all want low single-digit
// microseconds), unrelated to how fast the sweep moves.
constexpr uint32_t STEP_PULSE_US = 5;

// How often the master announces its elapsed time so the slave can correct
// drift. The same packet doubles as the initial "start" signal.
constexpr uint32_t RESYNC_INTERVAL_MS = 1000;

// All time fields are 32-bit microseconds (matching micros()'s own return
// type) rather than 64-bit specifically so reads/writes stay atomic on this
// architecture without needing locks around the ESP-NOW receive callback -
// wraps around after ~71 minutes, which unsigned subtraction handles safely
// and is far longer than a bench test needs.
struct SyncPacket {
  uint32_t masterElapsedUs; // time since the master's own sweep began
};

static esp_now_peer_info_t peerInfo;

static void pulseStep(int direction) {
  digitalWrite(PIN_DIR, direction > 0 ? HIGH : LOW);
  digitalWrite(PIN_STEP, HIGH);
  delayMicroseconds(STEP_PULSE_US);
  digitalWrite(PIN_STEP, LOW);
}

// Deterministic position for a given elapsed time, identical on both roles -
// as long as their clocks agree on elapsed time, they agree on where the
// motor should be, with no message exchange required. Bounces
// 0 -> STEPS_PER_SWEEP -> 0 rather than sawtoothing back to 0, so the motor
// never has to make one huge jump.
static int32_t stepForElapsed(uint32_t elapsedUs) {
  uint32_t totalSteps = elapsedUs / STEP_PERIOD_US;
  uint32_t cycle = totalSteps % (uint32_t)(2 * STEPS_PER_SWEEP);
  return cycle <= (uint32_t)STEPS_PER_SWEEP
    ? (int32_t)cycle
    : (int32_t)(2 * STEPS_PER_SWEEP - cycle);
}

static int32_t currentStep = 0;
static uint32_t startMicros = 0;

// Moves the motor toward wherever stepForElapsed() says it should be right
// now. Under normal conditions that is at most one step away each call -
// only a genuine stall (a blocking Wi-Fi call, a slow print) would ever
// require more than one pulse here in a single pass.
static void trackTarget(uint32_t elapsedUs) {
  int32_t target = stepForElapsed(elapsedUs);
  while (currentStep != target) {
    int direction = target > currentStep ? 1 : -1;
    pulseStep(direction);
    currentStep += direction;
  }
}

#ifdef ROLE_SLAVE
static volatile bool haveSync = false;
static volatile bool pendingSync = false;
static volatile uint32_t pendingMasterElapsedUs = 0;

static void onDataRecv(const uint8_t *mac, const uint8_t *data, int len) {
  if (len != sizeof(SyncPacket)) return;
  SyncPacket pkt;
  memcpy(&pkt, data, sizeof(pkt));
  pendingMasterElapsedUs = pkt.masterElapsedUs;
  pendingSync = true;
}
#endif

void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(PIN_STEP, OUTPUT);
  pinMode(PIN_DIR, OUTPUT);
  pinMode(PIN_ENABLE, OUTPUT);
  digitalWrite(PIN_ENABLE, LOW);

  WiFi.mode(WIFI_STA);
  Serial.print("My MAC: ");
  Serial.println(WiFi.macAddress());

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init failed");
    return;
  }

  memcpy(peerInfo.peer_addr, PEER_MAC, 6);
  peerInfo.channel = 0; // 0 = use whatever channel Wi-Fi station mode is already on
  peerInfo.encrypt = false;
  if (esp_now_add_peer(&peerInfo) != ESP_OK) {
    Serial.println("Failed to add peer - check PEER_MAC, and that both boards share a Wi-Fi channel");
  }

#ifdef ROLE_SLAVE
  esp_now_register_recv_cb(onDataRecv);
  Serial.println("Role: SLAVE, waiting for the master's first beacon");
#else
  startMicros = micros();
  Serial.println("Role: MASTER, sweep starting now");
#endif
}

#ifdef ROLE_MASTER
static uint32_t lastResyncAt = 0;

void loop() {
  uint32_t elapsed = micros() - startMicros;
  trackTarget(elapsed);

  uint32_t now = millis();
  if (now - lastResyncAt >= RESYNC_INTERVAL_MS) {
    lastResyncAt = now;
    SyncPacket pkt{ elapsed };
    esp_now_send(PEER_MAC, reinterpret_cast<const uint8_t *>(&pkt), sizeof(pkt));
  }
}
#endif

#ifdef ROLE_SLAVE
void loop() {
  if (pendingSync) {
    pendingSync = false;
    uint32_t masterElapsed = pendingMasterElapsedUs;
    // Re-anchor our own clock so "time since start" matches the master's
    // right now. This one line handles the very first packet (which doubles
    // as "start") and every later drift correction identically.
    startMicros = micros() - masterElapsed;
    haveSync = true;
  }

  if (!haveSync) return;

  trackTarget(micros() - startMicros);
}
#endif

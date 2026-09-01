// espnow_servo_sync.cpp - Two ESP32s, each driving one hobby servo + one
// ultrasonic sensor, sweeping in lockstep via free-run + periodic resync.
//
// Servo sibling of espnow_stepper_sync.cpp - same free-run + periodic resync
// idea, but a servo takes an absolute angle command and its own electronics
// get it there, so there is no step count to track at all. Both boards just
// work out "what angle should I be at right now" from elapsed LOCAL time
// (angleForElapsed() below) and write that straight to the servo. The master
// periodically (RESYNC_INTERVAL_MS) broadcasts how much time has elapsed
// since ITS sweep began; the slave re-anchors its own clock reference to
// match, correcting whatever drift has crept in since the last beacon. That
// same packet doubles as the "start" signal - the slave does nothing until
// the first one arrives.
//
// Neither side reads its ultrasonic sensor or talks to the game server yet;
// that comes once the sync itself has been checked on the bench.
//
// --- One-time setup, per pair of boards ---
//   1. Flash EITHER role to a board (see the PlatformIO envs below) and
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
// --- Hardware assumption -----------------------------------------------------
// A standard hobby positional servo (0-180 degree range) on PIN_SERVO,
// driven through the ESP32Servo library (hardware LEDC PWM) rather than
// bit-banged pulses - a bit-banged single pulse per call, like
// src/ServoSweep.cpp uses, will not reliably hold a servo in position; it
// needs a steady stream of pulses. Give the servo its own power rail if it
// draws more than the board's 5V/3.3V regulator can supply, same caution as
// for a stepper driver.
//
// Build with:
//   pio run -e espnow_servo_master -t upload
//   pio run -e espnow_servo_slave  -t upload

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <ESP32Servo.h>
#include <cstring>

#if !defined(ROLE_MASTER) && !defined(ROLE_SLAVE)
#error "Define ROLE_MASTER or ROLE_SLAVE via build_flags - see platformio.ini"
#endif

// --- Fill in before flashing -------------------------------------------------
// The OTHER board's MAC address, printed on its own boot. Master's copy holds
// the slave's address and vice versa - the two boards never hold the same value.
static uint8_t PEER_MAC[6] = { 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 };

// --- Servo wiring and sweep ------------------------------------------------
constexpr int PIN_SERVO = 25;
constexpr int SWEEP_DEGREES = 180; // full travel of the sweep

// How long one one-way sweep should take. The speed knob - both boards
// derive their current target angle from this and elapsed time.
constexpr uint32_t SWEEP_DURATION_MS = 2000;

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
static Servo servo;

// Target angle for a given elapsed time, identical on both roles - as long
// as their clocks agree on elapsed time, they agree on where the servo
// should point, with no message exchange required. Bounces
// 0 -> SWEEP_DEGREES -> 0 rather than snapping back to 0, so the servo never
// has to make one huge jump.
static int angleForElapsed(uint32_t elapsedUs) {
  uint32_t oneWayUs = SWEEP_DURATION_MS * 1000UL;
  uint32_t cycle = elapsedUs % (oneWayUs * 2);
  uint32_t intoSweep = cycle <= oneWayUs ? cycle : (oneWayUs * 2 - cycle);
  return (int)((uint64_t)intoSweep * SWEEP_DEGREES / oneWayUs);
}

static uint32_t startMicros = 0;

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

  servo.attach(PIN_SERVO);

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
  servo.write(angleForElapsed(elapsed));

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

  servo.write(angleForElapsed(micros() - startMicros));
}
#endif

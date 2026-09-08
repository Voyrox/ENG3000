#include "networkDiscovery.h"

bool discoverServer(WiFiClient& client, String& serverIP,
                    uint16_t serverPort, int32_t probeTimeoutMs,
                    unsigned long discoveryTimeoutMs) {
    IPAddress localIP = WiFi.localIP();
    IPAddress subnetMask = WiFi.subnetMask();
    uint32_t localAddress = (uint32_t(localIP[0]) << 24) |
                            (uint32_t(localIP[1]) << 16) |
                            (uint32_t(localIP[2]) << 8) |
                            uint32_t(localIP[3]);
    uint32_t mask = (uint32_t(subnetMask[0]) << 24) |
                    (uint32_t(subnetMask[1]) << 16) |
                    (uint32_t(subnetMask[2]) << 8) |
                    uint32_t(subnetMask[3]);
    uint32_t network = localAddress & mask;
    uint32_t broadcast = network | ~mask;

    Serial.print("Searching subnet ");
    Serial.print(network >> 24);
    Serial.print('.');
    Serial.print((network >> 16) & 0xff);
    Serial.print('.');
    Serial.print((network >> 8) & 0xff);
    Serial.print('.');
    Serial.println(network & 0xff);
    Serial.println("Searching local subnet for TCP server...");

    unsigned long start = millis();

    for (uint32_t distance = 1;
         distance < broadcast - network && millis() - start < discoveryTimeoutMs;
         distance++) {
        for (uint8_t side = 0; side < 2; side++) {
            uint32_t address = side == 0
                ? localAddress + distance
                : localAddress >= distance ? localAddress - distance : 0;
            if (address <= network || address >= broadcast || address == localAddress) {
                continue;
            }

            IPAddress candidate(
                (address >> 24) & 0xff,
                (address >> 16) & 0xff,
                (address >> 8) & 0xff,
                address & 0xff);
            Serial.print("Trying ");
            Serial.print(candidate.toString());
            Serial.println();
            if (client.connect(candidate, serverPort, probeTimeoutMs)) {
                serverIP = candidate.toString();
                Serial.print("Server found at ");
                Serial.println(serverIP);
                return true;
            }
        }
    }

    Serial.println("TCP server not found on local subnet");
    return false;
}

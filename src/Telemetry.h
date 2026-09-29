#pragma once

#include <Arduino.h>

#include "Scanner.h"

// The JSON line a node sends for each reading, e.g.
//   {"nodeId":1,"mac":"14:08:08:AB:F6:20","avg":82.40,"left":81.90,"right":82.90,"angle":112,"scanState":0}
// The website and the server read these fields by name; see the README.
String formatReading(int nodeId, const String& mac, const ScanReading& reading);

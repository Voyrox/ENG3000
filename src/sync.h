#pragma once

#include <Arduino.h>
#include "wifi/connectionManager.h"

void initSync();
bool pollCommands();
bool awaitingTurn();

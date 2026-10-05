// menu.js - fills in the live parts of the start screen (the "menu" section
// in index.html): how many sensors are online, the clock, and the data rate.
// ui.js shows and hides it and routes its tiles to canvas.js.
//
//   window.updateMenu(nodes) - call from draw() while the menu is showing

(function () {
  const sensorPill = document.getElementById("menuSensors");
  const sensorText = sensorPill.querySelector("span");
  const clock = document.getElementById("menuClock");
  const status = document.getElementById("menuStatus");
  const optionsMeta = document.getElementById("menuOptionsMeta");
  const logsMeta = document.getElementById("menuLogsMeta");

  function tickClock() {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    clock.dateTime = now.toISOString();
  }

  tickClock();
  window.setInterval(tickClock, 15000);

  window.updateMenu = function updateMenu(nodes = []) {
    const expected = window.CALIBRATE_AUTO_CONTINUE_NODES || 2;
    const online = nodes.filter((node) => node.online !== false).length;

    sensorPill.classList.toggle("is-live", online > 0);
    sensorText.textContent = online
      ? `${online} of ${expected} sensors online`
      : "No sensors connected";

    // Live state on the tiles themselves, the way a console tile shows what
    // is behind it.
    const settings = window.getGameSettings ? window.getGameSettings() : null;
    if (settings) {
      const round = settings.testMode ? "Test mode" : `${Math.round(settings.durationMs / 1000)} s`;
      optionsMeta.textContent =
        `${round} \u00b7 ${settings.startingLives} lives \u00b7 Sound ${settings.soundEnabled ? "on" : "off"}`;
    }
    logsMeta.innerHTML = nodes.length
      ? nodes
          .map(
            (node) =>
              `<span class="node-chip"><span class="dot${node.online !== false ? " is-live" : ""}"></span>` +
              `Node ${node.id} \u00b7 ${(node.rps || 0).toFixed(0)}/s</span>`
          )
          .join("")
      : "No nodes yet";

    const rate = nodes.reduce((sum, node) => sum + (node.rps || 0), 0);
    status.textContent = online
      ? `${rate.toFixed(1)} readings per second`
      : "Waiting for sensor data";
  };
})();

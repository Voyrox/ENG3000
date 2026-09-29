// options.js - the Options screen (the "options" section in index.html):
// round length, starting lives, sound and test mode. Reads settings through
// window.getGameSettings() from game.js; the controls' clicks go through
// ui.js to canvas.js, which writes them with window.setGameSettings().
//
//   window.updateOptionsScreen() - sync the controls with the current settings

(function () {
  const durationGroup = document.getElementById("optDuration");
  const livesGroup = document.getElementById("optLives");
  const soundSwitch = document.getElementById("optSound");
  const testModeSwitch = document.getElementById("optTestMode");

  // Built once, on first show: game.js owns the option lists and loads after
  // this file. Rebuilding on every update would swap the buttons out from
  // under a click or a keyboard focus.
  function buildSegments(group, action, values, format) {
    if (group.childElementCount) return;
    group.innerHTML = values
      .map(
        (value) =>
          `<button class="segment" data-action="${action}" data-value="${value}" data-nav aria-pressed="false">${format(value)}</button>`
      )
      .join("");
  }

  // The pressed segment is also where keyboard focus lands when the page opens.
  function syncSegments(group, current) {
    group.querySelectorAll(".segment").forEach((button) => {
      const pressed = Number(button.dataset.value) === current;
      button.setAttribute("aria-pressed", String(pressed));
      button.toggleAttribute("data-default-focus", pressed && group === durationGroup);
    });
  }

  window.updateOptionsScreen = function updateOptionsScreen() {
    const settings = window.getGameSettings
      ? window.getGameSettings()
      : { durationMs: 60000, startingLives: 3, soundEnabled: true, testMode: false };

    buildSegments(durationGroup, "duration", window.DURATION_OPTIONS_MS || [30000, 60000, 90000], (ms) => `${ms / 1000} s`);
    buildSegments(livesGroup, "lives", window.LIVES_OPTIONS || [1, 3, 5], (n) => `${n}`);

    syncSegments(durationGroup, settings.durationMs);
    syncSegments(livesGroup, settings.startingLives);
    soundSwitch.setAttribute("aria-checked", String(Boolean(settings.soundEnabled)));
    testModeSwitch.setAttribute("aria-checked", String(Boolean(settings.testMode)));
  };
})();

// ui.js - plumbing for the HTML screens layered over the canvas (the
// [data-screen] sections in index.html).
//
//   window.showScreen(name)                      - show that section, hide the rest;
//                                                  any other name (game, alert)
//                                                  hides them all and leaves the canvas
//   window.onScreenAction = (action, data) => {} - set by canvas.js; called for every
//                                                  enabled [data-action] click, with
//                                                  the element's dataset
//
// Navigation works like a console dashboard: the arrow keys move focus to the
// nearest [data-nav] control in that direction, Enter presses it (native), and
// Escape presses the screen's Back button.

(function () {
  const sections = Array.from(document.querySelectorAll("[data-screen]"));
  let current = null;
  let shown = null;

  function focusables(section) {
    return Array.from(section.querySelectorAll("[data-nav]")).filter(
      (el) => !el.disabled && el.offsetParent !== null
    );
  }

  // Land on the screen's main control when it has one. Otherwise focus the
  // heading, so a screen reader starts at the top and no ring lands on Back;
  // the first arrow press then brings the ring in.
  function focusDefault(section, fromKey) {
    const target =
      section.querySelector("[data-default-focus]:not(:disabled)") ||
      (fromKey ? focusables(section)[0] : section.querySelector("h1, h2"));
    if (target) target.focus({ preventScroll: true });
  }

  window.showScreen = function showScreen(name) {
    if (name === current) return;
    current = name;
    shown = null;

    sections.forEach((section) => {
      const match = section.dataset.screen === name;
      section.hidden = !match;
      if (match) shown = section;
    });

    if (shown) focusDefault(shown);
  };

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target || target.disabled || !target.closest("[data-screen]")) return;
    if (window.onScreenAction) window.onScreenAction(target.dataset.action, target.dataset);
  });

  const DIRECTIONS = {
    ArrowLeft: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
    ArrowUp: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 },
  };

  function centre(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // Nearest control whose centre lies in the pressed direction. Distance along
  // the direction counts once; drifting sideways counts three times, so the
  // focus travels the row or column the eye expects.
  function neighbour(from, candidates, dir) {
    const origin = centre(from);
    let best = null;
    let bestScore = Infinity;

    candidates.forEach((el) => {
      if (el === from) return;
      const c = centre(el);
      const along = (c.x - origin.x) * dir.x + (c.y - origin.y) * dir.y;
      if (along <= 1) return;
      const across = Math.abs((c.x - origin.x) * dir.y) + Math.abs((c.y - origin.y) * dir.x);
      const score = along + across * 3;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    });
    return best;
  }

  document.addEventListener("keydown", (event) => {
    if (!shown || event.altKey || event.ctrlKey || event.metaKey) return;

    if (event.key === "Escape") {
      const back = shown.querySelector('[data-action="back"]');
      if (back) {
        event.preventDefault();
        back.click();
      }
      return;
    }

    const dir = DIRECTIONS[event.key];
    if (!dir) return;

    const candidates = focusables(shown);
    if (!candidates.length) return;
    event.preventDefault();

    const active = document.activeElement;
    if (!candidates.includes(active)) {
      focusDefault(shown, true);
      return;
    }
    const next = neighbour(active, candidates, dir);
    if (next) next.focus();
  });
})();

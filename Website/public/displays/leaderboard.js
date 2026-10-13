// leaderboard.js - the leaderboard: the name box on the game-over card, and
// the Leaderboard screen (the "leaderboard" section in index.html). The scores
// live on the server in leaderboard.json (leaderboard.py), through
// /api/leaderboard.
//
//   window.syncScoreEntry(canvas, state) - call every draw: shows the name box
//                                          over the game-over card, hides it
//                                          everywhere else
//   window.updateLeaderboardScreen()     - fill the Leaderboard screen
//   window.leaderboardSummary()          - the best score in a line, for the
//                                          menu tile ("" until loaded)
//
// A round is saved at most once (state.round). The name typed is remembered
// in this browser, so the next player only has to change it.

(function () {
  const NAME_KEY = "eng3000.playerName";
  const STALE_MS = 5000; // the Leaderboard screen fetches again after this long
  // How the round was played; entries saved before this was recorded have none.
  const INPUT_LABELS = { mouse: "Mouse", sensor: "Sensors" };

  const box = document.getElementById("scoreEntry");
  const form = document.getElementById("scoreForm");
  const input = document.getElementById("scoreName");
  const saveButton = document.getElementById("scoreSave");
  const message = document.getElementById("scoreMessage");
  const rows = document.getElementById("leaderboardRows");
  const note = document.getElementById("leaderboardNote");

  let shownRound = null; // the round the box was last set up for
  let pending = null;    // { round, score, level, board, input } waiting to be saved
  let lastSaved = null;  // { name, at } of the entry saved here, highlighted on the screen
  let board = { entries: null, error: null, at: 0, loading: false };
  let renderedFor = null; // the board (and saved entry) the rows were last built from

  function rememberedName() {
    try {
      return localStorage.getItem(NAME_KEY) || "";
    } catch (err) {
      return "";
    }
  }

  function rememberName(name) {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch (err) {
      // Not remembered; the next player types it again.
    }
  }

  function say(text, tone) {
    message.textContent = text;
    message.dataset.tone = tone || "";
  }

  // A finished round: offer the name box, or say why this one is not saved.
  function setUp(state) {
    const settings = window.getGameSettings ? window.getGameSettings() : {};
    form.hidden = true;
    pending = null;
    if (settings.testMode) {
      say("Test mode scores are not saved");
    } else if (state.score <= 0) {
      say("Score a point to get on the leaderboard");
    } else {
      pending = {
        round: state.round, score: state.score, level: state.peakLevel, board: settings.boardStyle,
        input: window.getGameInputMode ? window.getGameInputMode() : null,
      };
      form.hidden = false;
      saveButton.disabled = false;
      saveButton.textContent = "Save";
      input.value = rememberedName();
      say("");
      input.focus({ preventScroll: true });
      input.select();
    }
  }

  window.syncScoreEntry = function syncScoreEntry(canvas, state) {
    const show = Boolean(canvas && state && state.status === "gameover");
    box.hidden = !show;
    if (!show) {
      if (document.activeElement === input) input.blur();
      return;
    }
    // Over the room the card leaves for it (game.js getScoreEntryRect()).
    const slot = window.getScoreEntryRect(canvas);
    const at = canvas.getBoundingClientRect();
    box.style.left = `${at.left + slot.x}px`;
    box.style.top = `${at.top + slot.y}px`;
    box.style.width = `${slot.width}px`;
    box.style.height = `${slot.height}px`;
    if (state.round !== shownRound) {
      shownRound = state.round;
      setUp(state);
    }
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!pending) return;
    const name = input.value.trim();
    if (!name) {
      say("Type your name first", "fault");
      input.focus();
      return;
    }
    const round = pending.round;
    saveButton.disabled = true;
    saveButton.textContent = "Saving";
    say("");
    try {
      const response = await fetch("/api/leaderboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, score: pending.score, level: pending.level, board: pending.board, input: pending.input,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `the server said ${response.status}`);
      if (shownRound !== round) return; // a new round started meanwhile
      rememberName(result.entry.name);
      lastSaved = { name: result.entry.name, at: result.entry.at };
      board = { entries: result.entries, error: null, at: Date.now(), loading: false };
      pending = null;
      form.hidden = true;
      input.blur();
      say(`Saved! ${result.entry.name} is #${result.entry.rank} of ${result.total}`, "good");
      window.GameSounds?.play("levelUp");
    } catch (err) {
      if (shownRound !== round) return;
      saveButton.disabled = false;
      saveButton.textContent = "Save";
      say(`Could not save: ${err.message}`, "fault");
    }
  });

  // --- The Leaderboard screen ------------------------------------------------

  function fetchBoard() {
    if (board.loading) return;
    board.loading = true;
    fetch("/api/leaderboard?limit=20")
      .then((response) => {
        if (!response.ok) throw new Error(`the server said ${response.status}`);
        return response.json();
      })
      .then((result) => {
        board = { entries: result.entries || [], error: null, at: Date.now(), loading: false };
      })
      .catch((err) => {
        board = { entries: board.entries, error: err.message, at: Date.now(), loading: false };
      })
      .finally(render);
  }

  function cell(text, className) {
    const span = document.createElement("span");
    span.textContent = text;
    if (className) span.className = className;
    return span;
  }

  function render() {
    renderedFor = { board, lastSaved };
    rows.replaceChildren();
    const entries = board.entries;
    if (!entries || !entries.length) {
      const li = document.createElement("li");
      li.className = "board-empty";
      if (board.error) li.textContent = `Could not load the leaderboard: ${board.error}`;
      else if (!entries) li.textContent = "Loading...";
      else li.textContent = "No scores yet. Finish a round and save your name to be first.";
      rows.append(li);
      note.textContent = "";
      return;
    }
    entries.forEach((entry) => {
      const li = document.createElement("li");
      if (entry.rank <= 3) li.classList.add(`is-top${entry.rank}`);
      if (lastSaved && entry.name === lastSaved.name && entry.at === lastSaved.at) li.classList.add("is-mine");
      const when = new Date(entry.at * 1000);
      li.append(
        cell(`${entry.rank}`, "board-rank"),
        cell(entry.name, "board-name"),
        cell(`${entry.score}`, "board-score"),
        cell(`${entry.level}`, "board-level"),
        cell(entry.board === "random" ? "Random" : "Classic", "board-style"),
        cell(INPUT_LABELS[entry.input] || "\u2014", "board-input"),
        cell(when.toLocaleDateString([], { day: "numeric", month: "short" }), "board-date"),
      );
      rows.append(li);
    });
    note.textContent = board.error ? `Showing the last scores loaded: ${board.error}` : "";
  }

  window.leaderboardSummary = function leaderboardSummary() {
    if (Date.now() - board.at > STALE_MS) fetchBoard();
    const best = board.entries && board.entries[0];
    if (board.entries && !best) return "No scores yet";
    return best ? `Best: ${best.name} \u00b7 ${best.score}` : "";
  };

  window.updateLeaderboardScreen = function updateLeaderboardScreen() {
    if (Date.now() - board.at > STALE_MS) fetchBoard();
    // draw() calls this many times a second; rebuild the rows only when
    // there is something new to show.
    if (!renderedFor || renderedFor.board !== board || renderedFor.lastSaved !== lastSaved) render();
  };
})();

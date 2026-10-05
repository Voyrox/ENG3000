// logs.js - the node picker ("select_node" section) and a node's raw message
// log ("logs" section) in index.html. Clicks go through ui.js to canvas.js.
//
//   window.updateNodeSelectScreen(nodes)
//   window.updateLogsScreen(node, entries) - entries oldest first, { time, data }

(function () {
  const nodeList = document.getElementById("nodeList");
  const logsTitle = document.getElementById("logsTitle");
  const logsAddress = document.getElementById("logsAddress");
  const logsCount = document.getElementById("logsCount");
  const logRows = document.getElementById("logRows");

  // Payloads come straight off the sensors, so never trust them as markup.
  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  let renderedRoster = null;

  // Node updates arrive many times a second. The tiles are only rebuilt when
  // the roster itself changes, so a click or keyboard focus is never lost to a
  // tile being replaced; the live details are patched in place.
  window.updateNodeSelectScreen = function updateNodeSelectScreen(nodes) {
    const roster = nodes.map((node) => node.id).join(",");

    if (roster !== renderedRoster) {
      renderedRoster = roster;
      nodeList.innerHTML = nodes.length
        ? nodes
            .map(
              (node, i) => `
                <button class="node-tile" data-action="node" data-node="${node.id}" data-nav${i === 0 ? " data-default-focus" : ""}>
                  <strong>Node ${node.id}</strong>
                  <span class="node-address">${escapeHtml(node.address || "unknown address")}</span>
                  <span class="node-state"><span class="dot"></span><span class="node-state-text"></span></span>
                </button>`
            )
            .join("")
        : '<p class="empty">No sensor nodes are connected yet. They appear here as soon as they join the hotspot.</p>';
    }

    nodes.forEach((node) => {
      const tile = nodeList.querySelector(`[data-node="${node.id}"]`);
      if (!tile) return;
      const online = node.online !== false;
      tile.querySelector(".dot").classList.toggle("is-live", online);
      tile.querySelector(".node-state-text").textContent =
        `${online ? "Online" : "Offline"} · ${(node.rps || 0).toFixed(1)} readings/s`;
    });
  };

  let renderedLog = null;

  window.updateLogsScreen = function updateLogsScreen(node, entries) {
    logsTitle.textContent = `Node ${node.id}`;
    logsAddress.textContent = node.address || "unknown address";

    // Skip the rebuild when nothing new has arrived.
    const newest = entries.length ? entries[entries.length - 1].time : 0;
    const key = `${node.id}:${entries.length}:${newest}`;
    if (key === renderedLog) return;
    renderedLog = key;

    logsCount.textContent = entries.length
      ? `Latest ${entries.length} messages, newest first.`
      : "";
    logRows.innerHTML = entries.length
      ? entries
          .slice()
          .reverse()
          .map((entry) => {
            const time = new Date(entry.time).toLocaleTimeString();
            // Offer line breaks after JSON commas so a long payload wraps
            // between fields instead of inside one.
            const payload = escapeHtml(entry.data).replaceAll(",", ",<wbr>");
            return `<li><time>${time}</time><code>${payload}</code></li>`;
          })
          .join("")
      : '<li class="log-empty">Waiting for this node to send its first reading.</li>';
  };
})();

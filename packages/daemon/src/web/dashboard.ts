// Embedded single-page dashboard for hotcell — dependency-free vanilla JS + CSS,
// served by the daemon at GET /. No build step: the markup is a plain string so
// it compiles straight to dist with the rest of the daemon. It talks to the same
// REST API the SDK/CLI use (same origin, so no CORS), polling the sandbox list +
// cost and showing live metrics for the selected sandbox.
//
// Implementation note: this is authored without JS template literals/backticks
// on purpose, so it can live inside this TS template-literal export without an
// escaping minefield. String concatenation it is.

export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>hotcell dashboard</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --fg: #e6edf3;
    --muted: #8b949e; --accent: #2f81f7; --green: #3fb950; --yellow: #d29922;
    --red: #f85149; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 14px 20px;
    border-bottom: 1px solid var(--border); background: var(--panel); }
  header h1 { font-size: 16px; margin: 0; letter-spacing: .5px; }
  header .meta { color: var(--muted); font-size: 12px; }
  header .spacer { flex: 1; }
  header .cost { font-family: var(--mono); font-size: 13px; }
  header .cost b { color: var(--green); }
  main { padding: 20px; max-width: 1200px; margin: 0 auto; }
  .bar { display: flex; gap: 8px; margin-bottom: 14px; align-items: center; }
  input, button, select { font: inherit; }
  input, select { background: var(--bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
  button { background: var(--accent); color: #fff; border: 0; border-radius: 6px;
    padding: 6px 12px; cursor: pointer; }
  button.secondary { background: #21262d; color: var(--fg); border: 1px solid var(--border); }
  button.danger { background: transparent; color: var(--red); border: 1px solid var(--border); }
  button:hover { filter: brightness(1.1); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border);
    font-size: 13px; }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase;
    letter-spacing: .5px; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: #1c2230; }
  tbody tr.sel { background: #1f2937; }
  td.id { font-family: var(--mono); }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px;
    font-weight: 600; }
  .badge.running { background: rgba(63,185,80,.15); color: var(--green); }
  .badge.creating { background: rgba(88,166,255,.15); color: var(--blue, #58a6ff); }
  .badge.paused { background: rgba(210,153,34,.15); color: var(--yellow); }
  .badge.stopped { background: rgba(139,148,158,.15); color: var(--muted); }
  .badge.error { background: rgba(248,81,73,.15); color: var(--red, #f85149); }
  .num { font-family: var(--mono); text-align: right; }
  .actions { white-space: nowrap; }
  .actions button { padding: 3px 8px; font-size: 12px; margin-left: 4px; }
  .detail { margin-top: 18px; padding: 16px; background: var(--panel);
    border: 1px solid var(--border); border-radius: 8px; }
  .detail h2 { font-size: 14px; margin: 0 0 10px; font-family: var(--mono); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px; }
  .stat { background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 10px 12px; }
  .stat .k { color: var(--muted); font-size: 11px; text-transform: uppercase; }
  .stat .v { font-family: var(--mono); font-size: 18px; margin-top: 2px; }
  .ports a { color: var(--accent); font-family: var(--mono); font-size: 12px;
    display: inline-block; margin-right: 12px; }
  .empty { color: var(--muted); padding: 30px; text-align: center; }
  .err { color: var(--red); padding: 8px 0; font-size: 13px; }
  .sparks { display: flex; gap: 16px; margin: 0 0 14px; }
  .sparkbox { background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 12px; }
  .sparkbox .k { color: var(--muted); font-size: 11px; text-transform: uppercase;
    margin-bottom: 4px; }
  .spark { display: block; }
  .spark-empty { color: var(--muted); }
  #terminal { margin-top: 18px; }
  #terminal:empty { margin-top: 0; }
  .termbar { display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    background: var(--panel); border: 1px solid var(--border); border-bottom: 0;
    border-radius: 8px 8px 0 0; font-family: var(--mono); font-size: 12px; }
  .termbar .spacer { flex: 1; }
  #termMount { height: 360px; background: #0d1117; border: 1px solid var(--border);
    border-radius: 0 0 8px 8px; padding: 6px; }
  .detail h2 .termbtn { float: right; padding: 2px 10px; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>hotcell</h1>
  <span class="meta" id="info">connecting…</span>
  <span class="spacer"></span>
  <span class="cost" id="cap" title="host memory committed / budget"></span>
  <span class="cost">total cost: <b id="totalCost">$0.000000</b></span>
</header>
<main>
  <div class="bar">
    <input id="newImage" placeholder="image (optional)" size="22" />
    <input id="newSleep" placeholder="sleepAfter ms" size="13" />
    <input id="newMem" placeholder="mem MB" size="8" />
    <input id="newCpus" placeholder="cpus" size="6" />
    <input id="newPids" placeholder="pids" size="6" />
    <button id="newBtn">New sandbox</button>
    <span class="spacer" style="flex:1"></span>
    <button class="secondary" id="refreshBtn">Refresh</button>
  </div>
  <div id="err" class="err" style="display:none"></div>
  <table>
    <thead><tr>
      <th>ID</th><th>Status</th><th>Image</th><th>Created</th><th>Last activity</th>
      <th class="num">vCPU-s</th><th class="num">GB-s</th><th class="num">Cost</th><th></th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="detail"></div>
  <div id="terminal"></div>
</main>
<script>
var rates = { costCpuPerHour: 0, costMemGbPerHour: 0 };
var selected = null;
var liveTimer = null;
var apiKey = localStorage.getItem("hotcell_api_key") || localStorage.getItem("sbx_api_key") || "";
// A link like /dashboard#key=<key> signs the dashboard in, then the key is
// dropped from the address bar (a fragment never reaches the server).
(function () {
  var m = /(?:^#|&)key=([^&]+)/.exec(location.hash);
  if (!m) return;
  apiKey = decodeURIComponent(m[1]);
  localStorage.setItem("hotcell_api_key", apiKey);
  history.replaceState(null, "", location.pathname + location.search);
})();

function authHeaders(h) {
  h = h || {};
  if (apiKey) h["authorization"] = "Bearer " + apiKey;
  return h;
}
function promptKey() {
  var k = window.prompt("This daemon requires an API key: HOTCELL_API_KEY, or the generated one in ~/.hotcell/api-key on the daemon host.", apiKey);
  if (k != null) { apiKey = k; localStorage.setItem("hotcell_api_key", k); }
  return k;
}
function api(path, opts) {
  opts = opts || {};
  opts.headers = authHeaders(opts.headers);
  return fetch(path, opts).then(function (r) {
    if (r.status === 401) {
      if (promptKey()) return api(path, opts);
      throw new Error("401: API key required");
    }
    if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + ": " + t); });
    return r.status === 204 ? null : r.json();
  });
}
function showErr(e) {
  var el = document.getElementById("err");
  el.style.display = "block"; el.textContent = String(e && e.message ? e.message : e);
}
function clearErr() { document.getElementById("err").style.display = "none"; }

function computeCost(u) {
  if (!u) return 0;
  var cpu = (u.cpuSeconds / 3600) * rates.costCpuPerHour;
  var mem = (u.memByteSeconds / 1e9 / 3600) * rates.costMemGbPerHour;
  var egress = ((u.egressBytes || 0) / 1e9) * (rates.costEgressPerGb || 0);
  var provider = u.providerCost || 0; // provider-reported LLM cost (USD)
  return cpu + mem + egress + provider;
}
function money(n) { return "$" + n.toFixed(6); }
function ago(iso) {
  if (!iso) return "—";
  var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
function mb(b) { return (b / 1e6).toFixed(1) + " MB"; }
function sparkline(values, color) {
  if (!values || values.length < 2) return "<span class=\"spark-empty\">—</span>";
  var w = 120, h = 28, n = values.length;
  var max = Math.max.apply(null, values);
  var min = Math.min.apply(null, values);
  var range = max - min || 1;
  var pts = values.map(function (v, i) {
    var x = (i / (n - 1)) * w;
    var y = h - ((v - min) / range) * (h - 4) - 2;
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  return "<svg class=\"spark\" viewBox=\"0 0 " + w + " " + h + "\" width=\"" + w +
    "\" height=\"" + h + "\" preserveAspectRatio=\"none\"><polyline fill=\"none\" stroke=\"" +
    color + "\" stroke-width=\"1.5\" points=\"" + pts + "\" /></svg>";
}
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
  return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

function loadInfo() {
  // /info is unauthenticated, so we can read whether auth is on and prompt for
  // the key before any authenticated call.
  return api("/info").then(function (i) {
    if (i.auth && !apiKey) promptKey();
    applyInfo(i);
  });
}
function applyInfo(i) {
  if (!i) return;
  rates = i;
  document.getElementById("info").textContent =
    "driver=" + i.driver + " · image=" + i.defaultImage + " · proxy=:" + i.proxyPort +
    (i.auth ? " · auth=on" : "") + (i.otlp ? " · otlp=on" : "");
  document.getElementById("newImage").placeholder = "image (default " + i.defaultImage + ")";
  // Show the daemon defaults as placeholders so blank inputs are understood.
  document.getElementById("newMem").placeholder = "mem MB" + (i.defaultMemoryMb ? " (" + i.defaultMemoryMb + ")" : "");
  document.getElementById("newCpus").placeholder = "cpus" + (i.defaultCpus ? " (" + i.defaultCpus + ")" : "");
  document.getElementById("newPids").placeholder = "pids" + (i.defaultPidsLimit ? " (" + i.defaultPidsLimit + ")" : "");
}

function loadCapacity() {
  api("/capacity").then(function (c) {
    var el = document.getElementById("cap");
    if (!c || !c.memory || !c.memory.budgetMb) { el.textContent = ""; return; }
    var gb = function (mb) { return (mb / 1024).toFixed(1); };
    el.innerHTML = "mem <b>" + gb(c.memory.committedMb) + "/" + gb(c.memory.budgetMb) +
      " GB</b> · ~" + c.fits + " more" + (c.enforced ? "" : " (admission off)");
  }).catch(function () {});
}

function refresh() {
  loadCapacity();
  api("/sandboxes").then(function (data) {
    clearErr();
    var list = data.sandboxes || [];
    var total = 0;
    var html = "";
    list.forEach(function (s) {
      var cost = computeCost(s.usage);
      total += cost;
      var sel = s.id === selected ? " class=\"sel\"" : "";
      html += "<tr data-id=\"" + s.id + "\"" + sel + ">";
      html += "<td class=\"id\">" + esc(s.id) + "</td>";
      html += "<td><span class=\"badge " + s.status + "\">" + s.status + "</span></td>";
      html += "<td>" + esc(s.image) + "</td>";
      html += "<td>" + ago(s.createdAt) + "</td>";
      html += "<td>" + ago(s.lastActivityAt) + "</td>";
      html += "<td class=\"num\">" + (s.usage ? s.usage.cpuSeconds.toFixed(1) : "0") + "</td>";
      html += "<td class=\"num\">" + (s.usage ? (s.usage.memByteSeconds / 1e9).toFixed(1) : "0") + "</td>";
      html += "<td class=\"num\">" + money(cost) + "</td>";
      html += "<td class=\"actions\">";
      if (s.status === "running" || s.status === "paused") {
        html += "<button class=\"secondary\" data-act=\"stop\" data-id=\"" + s.id + "\">Stop</button>";
      } else if (s.status === "stopped") {
        html += "<button class=\"secondary\" data-act=\"start\" data-id=\"" + s.id + "\">Start</button>";
      }
      html += "<button class=\"danger\" data-act=\"rm\" data-id=\"" + s.id + "\">Destroy</button>";
      html += "</td></tr>";
    });
    var rows = document.getElementById("rows");
    rows.innerHTML = html ||
      "<tr><td colspan=\"9\" class=\"empty\">No sandboxes. Create one above.</td></tr>";
    document.getElementById("totalCost").textContent = money(total);
    if (selected && !list.some(function (s) { return s.id === selected; })) {
      selected = null; renderDetail();
    }
  }).catch(showErr);
}

function act(action, id) {
  var p;
  if (action === "stop") p = api("/sandboxes/" + id + "/stop", { method: "POST" });
  else if (action === "start") p = api("/sandboxes/" + id + "/start", { method: "POST" });
  else if (action === "rm") {
    if (!confirm("Destroy " + id + "? Its workspace volume is deleted too.")) return;
    p = api("/sandboxes/" + id, { method: "DELETE" });
  }
  p.then(refresh).catch(showErr);
}

function createSandbox() {
  var body = {};
  var img = document.getElementById("newImage").value.trim();
  var sleep = document.getElementById("newSleep").value.trim();
  var memv = document.getElementById("newMem").value.trim();
  var cpusv = document.getElementById("newCpus").value.trim();
  var pidsv = document.getElementById("newPids").value.trim();
  if (img) body.image = img;
  if (sleep) body.sleepAfter = Number(sleep);
  if (memv) body.memoryMb = Number(memv);
  if (cpusv) body.cpus = Number(cpusv);
  if (pidsv) body.pidsLimit = Number(pidsv);
  api("/sandboxes", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(function () {
    ["newImage", "newSleep", "newMem", "newCpus", "newPids"].forEach(function (k) {
      document.getElementById(k).value = "";
    });
    refresh();
  }).catch(showErr);
}

function select(id) {
  selected = (selected === id) ? null : id;
  refresh();
  renderDetail();
}

function renderDetail() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  var el = document.getElementById("detail");
  if (!selected) { el.innerHTML = ""; return; }
  var id = selected;
  function paint() {
    Promise.all([
      api("/sandboxes/" + id + "/metrics"),
      api("/sandboxes/" + id + "/expose").catch(function () { return { exposed: [] }; }),
      api("/sandboxes/" + id + "/metrics/history").catch(function () { return { samples: [] }; }),
      api("/sandboxes/" + id).catch(function () { return { limits: {} }; }),
    ]).then(function (res) {
      if (selected !== id) return;
      var m = res[0], ex = res[1].exposed || [], hist = res[2].samples || [];
      var limits = (res[3] && res[3].limits) || {};
      var live = m.live;
      var h = "<div class=\"detail\"><h2>" + esc(id) +
        " <span class=\"badge " + m.status + "\">" + m.status + "</span>" +
        "<button class=\"secondary termbtn\" data-term=\"" + id + "\">Terminal</button></h2>";
      if (hist.length >= 2) {
        h += "<div class=\"sparks\">";
        h += "<div class=\"sparkbox\"><div class=\"k\">CPU %</div>" +
          sparkline(hist.map(function (s) { return s.cpuPercent; }), "#2f81f7") + "</div>";
        h += "<div class=\"sparkbox\"><div class=\"k\">Memory</div>" +
          sparkline(hist.map(function (s) { return s.memBytes; }), "#3fb950") + "</div>";
        h += "</div>";
      }
      h += "<div class=\"grid\">";
      h += statCard("CPU", live ? live.cpuPercent.toFixed(1) + "%" : "—");
      h += statCard("CPU limit", limits.cpus ? limits.cpus + " cpu" : "∞");
      h += statCard("Memory", live ? mb(live.memBytes) : "—");
      h += statCard("Mem limit", limits.memoryMb ? limits.memoryMb + " MB" : "∞");
      h += statCard("PIDs", live ? String(live.pids) : "—");
      h += statCard("PID limit", limits.pidsLimit ? String(limits.pidsLimit) : "∞");
      h += statCard("Net in", live ? mb(live.netRxBytes) : "—");
      h += statCard("Net out", live ? mb(live.netTxBytes) : "—");
      h += statCard("CPU total", m.usage.cpuSeconds.toFixed(1) + " vCPU-s");
      h += statCard("Mem total", (m.usage.memByteSeconds / 1e9).toFixed(1) + " GB-s");
      h += statCard("Egress", mb(m.usage.egressBytes || 0));
      h += statCard("Cost", money(m.cost.total));
      if (m.usage.providerCalls) {
        h += statCard("LLM calls", m.usage.providerCalls);
        h += statCard("LLM tokens",
          (m.usage.providerTokensIn || 0) + " in / " + (m.usage.providerTokensOut || 0) + " out");
        h += statCard("LLM cost", money(m.usage.providerCost || 0));
      }
      h += "</div>";
      if (ex.length) {
        h += "<div class=\"ports\" style=\"margin-top:12px\"><b>Preview:</b> ";
        ex.forEach(function (p) {
          h += "<a href=\"" + esc(p.url) + "\" target=\"_blank\">:" + p.port + " ↗</a>";
        });
        h += "</div>";
      }
      h += "</div>";
      el.innerHTML = h;
    }).catch(function (e) { if (selected === id) showErr(e); });
  }
  paint();
  liveTimer = setInterval(paint, 2500);
}
function statCard(k, v) {
  return "<div class=\"stat\"><div class=\"k\">" + k + "</div><div class=\"v\">" + v + "</div></div>";
}

// --- live terminal (xterm.js over WebSocket) -------------------------------
// xterm is loaded lazily from a CDN only when a terminal is first opened, so the
// rest of the dashboard stays dependency-free and works offline on loopback.
var XTERM_VER = "5.5.0", FIT_VER = "0.10.0";
function loadScript(src) {
  return new Promise(function (res, rej) {
    var s = document.createElement("script");
    s.src = src; s.onload = res;
    s.onerror = function () { rej(new Error("failed to load " + src)); };
    document.head.appendChild(s);
  });
}
function loadXterm() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  var css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "https://cdn.jsdelivr.net/npm/@xterm/xterm@" + XTERM_VER + "/css/xterm.min.css";
  document.head.appendChild(css);
  return loadScript("https://cdn.jsdelivr.net/npm/@xterm/xterm@" + XTERM_VER + "/lib/xterm.min.js")
    .then(function () {
      return loadScript("https://cdn.jsdelivr.net/npm/@xterm/addon-fit@" + FIT_VER + "/lib/addon-fit.min.js");
    });
}
function closeTerm() {
  var host = document.getElementById("terminal");
  if (host._ws) { try { host._ws.close(); } catch (e) {} host._ws = null; }
  if (host._term) { try { host._term.dispose(); } catch (e) {} host._term = null; }
  if (host._onResize) { window.removeEventListener("resize", host._onResize); host._onResize = null; }
  host.innerHTML = ""; host.dataset.id = "";
}
function openTerm(id) {
  var host = document.getElementById("terminal");
  if (host.dataset.id === id) { closeTerm(); return; } // toggle off
  closeTerm();
  host.dataset.id = id;
  host.innerHTML =
    "<div class=\"termbar\"><span>terminal — " + esc(id) + "</span><span class=\"spacer\"></span>" +
    "<button class=\"secondary\" id=\"termClose\">Close</button></div><div id=\"termMount\"></div>";
  document.getElementById("termClose").addEventListener("click", closeTerm);
  loadXterm().then(function () {
    if (host.dataset.id !== id) return; // closed while loading
    connectTerm(id, host);
  }).catch(showErr);
}
function connectTerm(id, host) {
  var term = new window.Terminal({ fontSize: 13, cursorBlink: true,
    theme: { background: "#0d1117", foreground: "#e6edf3" } });
  var fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById("termMount"));
  try { fit.fit(); } catch (e) {}
  var wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  var url = wsProto + "//" + location.host + "/sandboxes/" + id + "/terminal" +
    "?cols=" + term.cols + "&rows=" + term.rows;
  if (apiKey) url += "&key=" + encodeURIComponent(apiKey);
  var ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  host._ws = ws; host._term = term;
  var enc = new TextEncoder();
  ws.onmessage = function (e) {
    if (typeof e.data === "string") term.write(e.data);
    else term.write(new Uint8Array(e.data));
  };
  ws.onclose = function () { try { term.write("\r\n\x1b[90m[connection closed]\x1b[0m\r\n"); } catch (x) {} };
  ws.onerror = function () { showErr("terminal websocket error"); };
  term.onData(function (d) { if (ws.readyState === 1) ws.send(enc.encode(d)); });
  term.onResize(function (s) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols: s.cols, rows: s.rows }));
  });
  host._onResize = function () { try { fit.fit(); } catch (e) {} };
  window.addEventListener("resize", host._onResize);
}
document.getElementById("detail").addEventListener("click", function (e) {
  var b = e.target.closest("button[data-term]");
  if (b) { e.stopPropagation(); openTerm(b.dataset.term); }
});

document.getElementById("rows").addEventListener("click", function (e) {
  var btn = e.target.closest("button");
  if (btn && btn.dataset.act) { e.stopPropagation(); act(btn.dataset.act, btn.dataset.id); return; }
  var tr = e.target.closest("tr");
  if (tr && tr.dataset.id) select(tr.dataset.id);
});
document.getElementById("newBtn").addEventListener("click", createSandbox);
document.getElementById("refreshBtn").addEventListener("click", refresh);

loadInfo().then(refresh).catch(showErr);
setInterval(refresh, 3000);
</script>
</body>
</html>`;

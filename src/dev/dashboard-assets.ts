/**
 * The local dashboard's single-page UI — one self-contained HTML document with inline CSS and
 * vanilla JavaScript, no framework and no build step. It is served verbatim by
 * {@link ./dashboard.ts}, talks only to that server's same-origin JSON + SSE API, and never reaches
 * the network. Kept as a string constant (not a file read) so it works regardless of the bundled
 * `dist/` layout, and so it only loads when the dashboard is actually started.
 *
 * Branding follows BRAND.md: indigo primary, teal/green for healthy runs, amber for retries, red for
 * failures, slate neutrals, light + dark, monospace for cron expressions.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Cronvello — local dashboard</title>
<style>
  :root {
    --indigo: #4F46E5;
    --indigo-soft: #6366F1;
    --teal: #14B8A6;
    --green: #10B981;
    --amber: #F59E0B;
    --red: #EF4444;
    --bg: #f8fafc;
    --panel: #ffffff;
    --panel-2: #f1f5f9;
    --border: #e2e8f0;
    --text: #0f172a;
    --muted: #64748b;
    --shadow: 0 1px 3px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.04);
  }
  [data-theme="dark"] {
    --bg: #0b1120;
    --panel: #111827;
    --panel-2: #0f172a;
    --border: #1f2937;
    --text: #e5e7eb;
    --muted: #94a3b8;
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.5), 0 1px 2px rgba(0, 0, 0, 0.4);
  }
  /* Dark-mode-first: follow the OS preference unless the user has explicitly chosen light. */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0b1120;
      --panel: #111827;
      --panel-2: #0f172a;
      --border: #1f2937;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --shadow: 0 1px 3px rgba(0, 0, 0, 0.5), 0 1px 2px rgba(0, 0, 0, 0.4);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.5;
  }
  code, .mono { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    position: sticky; top: 0; z-index: 10;
  }
  .logo {
    width: 28px; height: 28px; border-radius: 8px;
    display: grid; place-items: center;
    background: linear-gradient(135deg, var(--indigo), var(--teal));
    color: #fff; font-size: 17px; font-weight: 700;
  }
  .brand { font-weight: 700; letter-spacing: -0.01em; }
  .brand small { color: var(--muted); font-weight: 500; margin-left: 6px; }
  .spacer { flex: 1; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 600;
    border: 1px solid var(--border); background: var(--panel-2); color: var(--muted);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .pill.live .dot { background: var(--green); box-shadow: 0 0 0 0 rgba(16,185,129,0.5); animation: pulse 1.8s infinite; }
  .pill.down .dot { background: var(--red); }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(16,185,129,0.5); } 70% { box-shadow: 0 0 0 6px rgba(16,185,129,0); } 100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); } }
  button {
    font: inherit; cursor: pointer; color: var(--text);
    background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 8px; padding: 6px 12px;
  }
  button:hover { border-color: var(--indigo-soft); }
  button.primary { background: var(--indigo); color: #fff; border-color: var(--indigo); }
  button.primary:hover { background: var(--indigo-soft); }
  .layout { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; padding: 16px 20px; align-items: start; }
  @media (max-width: 860px) { .layout { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; }
  .card > h2 { margin: 0; padding: 12px 16px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); border-bottom: 1px solid var(--border); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 16px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--panel-2); }
  .jobkey { font-weight: 600; }
  .jobdesc { color: var(--muted); font-size: 12px; }
  .count { font-variant-numeric: tabular-nums; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .badge.success { background: rgba(16,185,129,0.15); color: var(--green); }
  .badge.error, .badge.timed_out { background: rgba(239,68,68,0.15); color: var(--red); }
  .badge.skipped { background: rgba(100,116,139,0.18); color: var(--muted); }
  .badge.running { background: rgba(79,70,229,0.15); color: var(--indigo-soft); }
  .badge.none { background: var(--panel-2); color: var(--muted); }
  .feed { max-height: 70vh; overflow-y: auto; }
  .ev { display: flex; gap: 10px; padding: 8px 16px; border-bottom: 1px solid var(--border); font-size: 13px; }
  .ev .glyph { width: 16px; text-align: center; flex: none; }
  .ev .body { flex: 1; min-width: 0; }
  .ev .when { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .ev.success .glyph { color: var(--green); }
  .ev.error .glyph, .ev.timeout .glyph { color: var(--red); }
  .ev.retry .glyph { color: var(--amber); }
  .ev.fire .glyph { color: var(--indigo-soft); }
  .ev.skipped .glyph, .ev.scheduled .glyph, .ev.engine .glyph { color: var(--muted); }
  .empty { padding: 24px 16px; color: var(--muted); text-align: center; }
  footer { padding: 12px 20px 28px; color: var(--muted); font-size: 12px; }
  .overlay { position: fixed; inset: 0; background: rgba(15,23,42,0.45); display: none; align-items: stretch; justify-content: flex-end; z-index: 30; }
  .overlay.open { display: flex; }
  .drawer { width: min(520px, 92vw); background: var(--panel); border-left: 1px solid var(--border); height: 100%; overflow-y: auto; box-shadow: var(--shadow); }
  .drawer header { background: var(--panel); }
  .drawer .pad { padding: 16px; }
  .kv { display: flex; gap: 8px; margin: 4px 0; }
  .kv span:first-child { color: var(--muted); min-width: 90px; }
  .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 18px 0 8px; }
  ul.plain { list-style: none; margin: 0; padding: 0; }
  ul.plain li { padding: 6px 0; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; gap: 8px; }
</style>
</head>
<body>
<header>
  <div class="logo">&#8635;</div>
  <div class="brand">Cronvello <small>local dashboard</small></div>
  <div class="spacer"></div>
  <span id="conn" class="pill"><span class="dot"></span><span id="conn-text">connecting&hellip;</span></span>
  <button id="theme-btn" title="Toggle theme">&#9788;</button>
</header>

<div class="layout">
  <section class="card">
    <h2>Jobs &mdash; next fire &amp; last status</h2>
    <table>
      <thead><tr><th>Job</th><th>Schedule</th><th>Timezone</th><th>Next fire</th><th>Last</th></tr></thead>
      <tbody id="jobs"><tr><td colspan="5" class="empty">Loading jobs&hellip;</td></tr></tbody>
    </table>
  </section>

  <section class="card">
    <h2>Live run feed</h2>
    <div id="feed" class="feed"><div class="empty">Waiting for runs&hellip;</div></div>
  </section>
</div>

<footer>Local &middot; no account &middot; no cloud &middot; no external network. The engine on this machine is the only source of truth.</footer>

<div id="overlay" class="overlay">
  <div class="drawer">
    <header>
      <div class="brand" id="drawer-title">Job</div>
      <div class="spacer"></div>
      <button id="drawer-close">Close</button>
    </header>
    <div class="pad" id="drawer-body"></div>
  </div>
</div>

<script>
(function () {
  "use strict";
  var MAX_FEED = 200;
  var jobsByKey = {};

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function clockTime(ms) {
    var d = new Date(ms);
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }
  function fmtDuration(ms) {
    if (ms == null) return "";
    if (ms < 1000) return ms + "ms";
    return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + "s";
  }
  function countdown(iso) {
    if (!iso) return "&mdash;";
    var diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return "due now";
    var s = Math.floor(diff / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    var out = "in ";
    if (d) out += d + "d ";
    if (d || h) out += h + "h ";
    if (d || h || m) out += m + "m ";
    out += s + "s";
    return out;
  }

  // ── Theme ──────────────────────────────────────────────────────────────────
  function applyTheme(t) {
    if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
  }
  function resolvedTheme() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t) return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  try { applyTheme(localStorage.getItem("cronvello-theme")); } catch (e) {}
  el("theme-btn").addEventListener("click", function () {
    var next = resolvedTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem("cronvello-theme", next); } catch (e) {}
  });

  // ── Jobs table ─────────────────────────────────────────────────────────────
  function statusBadge(s) {
    if (!s) return '<span class="badge none">&mdash;</span>';
    return '<span class="badge ' + esc(s) + '">' + esc(s) + "</span>";
  }
  function renderJobs(jobs) {
    jobsByKey = {};
    if (!jobs.length) { el("jobs").innerHTML = '<tr><td colspan="5" class="empty">No jobs registered.</td></tr>'; return; }
    var rows = "";
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      jobsByKey[j.key] = j;
      var last = j.running ? "running" : (j.lastStatus || "");
      rows +=
        '<tr data-key="' + esc(j.key) + '">' +
        "<td><div class=\\"jobkey\\">" + esc(j.key) + "</div>" + (j.description ? '<div class="jobdesc">' + esc(j.description) + "</div>" : "") + "</td>" +
        '<td><code>' + esc(j.schedule) + "</code></td>" +
        "<td>" + esc(j.timeZone) + "</td>" +
        '<td class="count" data-next="' + esc(j.nextFire || "") + '">' + countdown(j.nextFire) + "</td>" +
        "<td>" + (j.running ? '<span class="badge running">running</span>' : statusBadge(j.lastStatus)) + "</td>" +
        "</tr>";
    }
    el("jobs").innerHTML = rows;
    var trs = el("jobs").querySelectorAll("tr[data-key]");
    for (var k = 0; k < trs.length; k++) {
      trs[k].addEventListener("click", function () { openDrawer(this.getAttribute("data-key")); });
    }
  }
  function tickCountdowns() {
    var cells = el("jobs").querySelectorAll("td[data-next]");
    for (var i = 0; i < cells.length; i++) {
      var iso = cells[i].getAttribute("data-next");
      cells[i].innerHTML = iso ? countdown(iso) : "&mdash;";
    }
  }

  function loadJobs() {
    return fetch("/api/jobs").then(function (r) { return r.json(); }).then(function (jobs) {
      // Fold in each job's last run so the table can show a status without a per-row fetch.
      return fetch("/api/runs").then(function (r) { return r.json(); }).then(function (runs) {
        var lastByKey = {};
        for (var i = 0; i < runs.length; i++) { if (!lastByKey[runs[i].key]) lastByKey[runs[i].key] = runs[i]; }
        for (var j = 0; j < jobs.length; j++) {
          var lr = lastByKey[jobs[j].key];
          jobs[j].lastStatus = lr ? lr.status : "";
        }
        renderJobs(jobs);
      });
    }).catch(function () {});
  }

  // ── Live feed ──────────────────────────────────────────────────────────────
  var glyphs = { fire: "&#9655;", success: "&#10003;", error: "&#10007;", timeout: "&#9203;", retry: "&#8635;", skipped: "&#8866;", scheduled: "&#128337;", "engine-start": "&#9889;", "engine-stop": "&#9632;" };
  function describe(ev) {
    switch (ev.type) {
      case "fire": return "<strong>" + esc(ev.key) + "</strong> fired" + (ev.attempt > 1 ? " (attempt " + ev.attempt + ")" : "");
      case "success": return "<strong>" + esc(ev.key) + "</strong> succeeded in " + fmtDuration(ev.durationMs) + (ev.attempts > 1 ? " after " + ev.attempts + " attempts" : "");
      case "error": return "<strong>" + esc(ev.key) + "</strong> errored: " + esc(ev.error) + (ev.willRetry ? " — will retry" : "");
      case "timeout": return "<strong>" + esc(ev.key) + "</strong> timed out after " + fmtDuration(ev.durationMs) + (ev.willRetry ? " — will retry" : "");
      case "retry": return "<strong>" + esc(ev.key) + "</strong> retrying (attempt " + ev.attempt + ") in " + fmtDuration(ev.delayMs);
      case "skipped": return "<strong>" + esc(ev.key) + "</strong> skipped (overlap)";
      case "scheduled": return "<strong>" + esc(ev.key) + "</strong> scheduled";
      case "engine-start": return "Engine started — " + ev.jobs + " job(s)";
      case "engine-stop": return "Engine stopped";
      default: return esc(ev.type);
    }
  }
  function feedClass(type) {
    if (type === "engine-start" || type === "engine-stop" || type === "scheduled") return "engine";
    return type;
  }
  function pushEvent(ev) {
    var feed = el("feed");
    if (feed.firstChild && feed.firstChild.className === "empty") feed.innerHTML = "";
    var div = document.createElement("div");
    div.className = "ev " + feedClass(ev.type);
    div.innerHTML =
      '<div class="glyph">' + (glyphs[ev.type] || "&#8226;") + "</div>" +
      '<div class="body">' + describe(ev) + "</div>" +
      '<div class="when">' + clockTime(ev.at || Date.now()) + "</div>";
    feed.insertBefore(div, feed.firstChild);
    while (feed.childNodes.length > MAX_FEED) feed.removeChild(feed.lastChild);

    // A terminal event changes a job's last status / running flag — refresh the table.
    if (ev.type === "success" || ev.type === "error" || ev.type === "timeout" || ev.type === "skipped" || ev.type === "scheduled") {
      loadJobs();
    }
  }

  function setConn(state) {
    var pill = el("conn"), text = el("conn-text");
    pill.className = "pill " + state;
    text.textContent = state === "live" ? "live" : (state === "down" ? "disconnected" : "connecting…");
  }

  function connect() {
    setConn("connecting");
    var src = new EventSource("/api/events");
    src.onopen = function () { setConn("live"); };
    src.onmessage = function (m) {
      try { pushEvent(JSON.parse(m.data)); } catch (e) {}
    };
    src.onerror = function () { setConn("down"); };
  }

  // ── Job drawer ─────────────────────────────────────────────────────────────
  function openDrawer(key) {
    var job = jobsByKey[key];
    if (!job) return;
    el("drawer-title").textContent = key;
    el("drawer-body").innerHTML = '<div class="empty">Loading&hellip;</div>';
    el("overlay").classList.add("open");

    Promise.all([
      fetch("/api/preview/" + encodeURIComponent(key) + "?n=5").then(function (r) { return r.json(); }).catch(function () { return []; }),
      fetch("/api/runs/" + encodeURIComponent(key)).then(function (r) { return r.json(); }).catch(function () { return []; })
    ]).then(function (res) {
      var fires = res[0] || [], runs = res[1] || [];
      var html =
        '<div class="kv"><span>Schedule</span><code>' + esc(job.schedule) + "</code></div>" +
        '<div class="kv"><span>Timezone</span><span>' + esc(job.timeZone) + "</span></div>" +
        (job.description ? '<div class="kv"><span>Description</span><span>' + esc(job.description) + "</span></div>" : "") +
        '<div style="margin-top:14px"><button class="primary" id="run-now">Run now</button></div>' +
        '<div class="section-title">Next fire times</div>';
      if (fires.length) {
        html += '<ul class="plain">';
        for (var i = 0; i < fires.length; i++) html += "<li><span>" + esc(new Date(fires[i]).toLocaleString()) + "</span><span class=\\"count\\">" + countdown(fires[i]) + "</span></li>";
        html += "</ul>";
      } else { html += '<div class="empty">No upcoming fires.</div>'; }

      html += '<div class="section-title">Recent runs</div>';
      if (runs.length) {
        html += '<ul class="plain">';
        for (var j = 0; j < runs.length && j < 20; j++) {
          var run = runs[j];
          html += "<li><span>" + statusBadge(run.status) + " <span class=\\"when\\">" + esc(new Date(run.startedAt).toLocaleString()) + "</span></span><span>" + fmtDuration(run.durationMs) + "</span></li>";
        }
        html += "</ul>";
      } else { html += '<div class="empty">No runs yet.</div>'; }

      el("drawer-body").innerHTML = html;
      el("run-now").addEventListener("click", function () { runNow(key, this); });
    });
  }
  function closeDrawer() { el("overlay").classList.remove("open"); }
  el("drawer-close").addEventListener("click", closeDrawer);
  el("overlay").addEventListener("click", function (e) { if (e.target === el("overlay")) closeDrawer(); });

  function runNow(key, btn) {
    btn.disabled = true; btn.textContent = "Running…";
    fetch("/api/trigger/" + encodeURIComponent(key), { method: "POST", headers: { "content-type": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function () { btn.textContent = "Ran ✓"; setTimeout(function () { openDrawer(key); }, 600); loadJobs(); })
      .catch(function () { btn.disabled = false; btn.textContent = "Run now"; });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  loadJobs();
  connect();
  setInterval(tickCountdowns, 1000);
  setInterval(loadJobs, 15000);
})();
</script>
</body>
</html>`;

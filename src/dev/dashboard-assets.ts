/**
 * The local dashboard's single-page UI — one self-contained HTML document with inline CSS and
 * vanilla JavaScript, no framework and no build step. It is served verbatim by
 * {@link ./dashboard.ts}, talks only to that server's same-origin JSON + SSE API, and never reaches
 * the network. Kept as a string constant (not a file read) so it works regardless of the bundled
 * `dist/` layout, and so it only loads when the dashboard is actually started.
 *
 * Two things shape the implementation:
 *
 * - **One read model.** Everything on screen comes from a single `/api/state` snapshot. The live
 *   event stream appends to the feed and marks the snapshot stale; a debounced refetch reconciles.
 *   Nothing re-renders per event.
 * - **The timeline is a fixed track that slides.** Run and fire positions are absolute in time, so
 *   they are written once per snapshot; the passing second is a single `translateX` on the track
 *   rather than a repositioning pass over every mark.
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
<title>Cronvello — local engine</title>
<style>
  :root {
    --indigo: #4F46E5;
    --indigo-soft: #6366F1;
    --teal: #14B8A6;
    --green: #10B981;
    --amber: #F59E0B;
    --red: #EF4444;
    --bg: #f7f8fa;
    --panel: #ffffff;
    --panel-2: #f1f5f9;
    --panel-3: #e9edf3;
    --border: #e3e8ef;
    --border-strong: #cbd5e1;
    --text: #0f172a;
    --muted: #64748b;
    --faint: #94a3b8;
    --shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06);
    --focus: rgba(79, 70, 229, 0.35);
  }
  [data-theme="dark"] {
    --bg: #0a0f1c;
    --panel: #111827;
    --panel-2: #161f2f;
    --panel-3: #1c2740;
    --border: #1f2937;
    --border-strong: #334155;
    --text: #e6e9ef;
    --muted: #94a3b8;
    --faint: #64748b;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.35);
    --focus: rgba(99, 102, 241, 0.45);
  }
  /* Dark-mode-first: follow the OS preference unless the user has explicitly chosen light. */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0a0f1c;
      --panel: #111827;
      --panel-2: #161f2f;
      --panel-3: #1c2740;
      --border: #1f2937;
      --border-strong: #334155;
      --text: #e6e9ef;
      --muted: #94a3b8;
      --faint: #64748b;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.35);
      --focus: rgba(99, 102, 241, 0.45);
    }
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
    font-size: 13.5px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  code, .mono, .num {
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums;
  }
  .num { font-variant-numeric: tabular-nums; }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }

  /* ── Header ─────────────────────────────────────────────────────────────── */
  header.top {
    display: flex; align-items: center; gap: 12px;
    padding: 0 20px; height: 52px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    position: sticky; top: 0; z-index: 20;
  }
  .mark {
    width: 26px; height: 26px; border-radius: 7px; flex: none;
    display: grid; place-items: center;
    background: linear-gradient(140deg, var(--indigo), var(--teal));
    color: #fff;
  }
  .mark svg { width: 15px; height: 15px; }
  .wordmark { font-weight: 650; letter-spacing: -0.012em; font-size: 14px; }
  .wordmark span { color: var(--muted); font-weight: 450; margin-left: 7px; }
  .spacer { flex: 1; }

  .chip {
    display: inline-flex; align-items: center; gap: 7px;
    height: 26px; padding: 0 10px; border-radius: 7px;
    font-size: 12px; font-weight: 500;
    border: 1px solid var(--border); background: var(--panel-2); color: var(--muted);
    white-space: nowrap;
  }
  .chip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; }
  .chip.live .dot { background: var(--green); animation: pulse 2.4s ease-out infinite; }
  .chip.down { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, var(--border)); }
  .chip.down .dot { background: var(--red); }
  @keyframes pulse {
    0%   { box-shadow: 0 0 0 0 rgba(16,185,129,0.45); }
    70%  { box-shadow: 0 0 0 5px rgba(16,185,129,0); }
    100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); }
  }

  button {
    font: inherit; cursor: pointer; color: var(--text);
    background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 7px; padding: 5px 11px;
    transition: background-color .12s ease, border-color .12s ease;
  }
  button:hover:not(:disabled) { background: var(--panel-3); border-color: var(--border-strong); }
  button:disabled { opacity: .55; cursor: default; }
  button.primary { background: var(--indigo); color: #fff; border-color: var(--indigo); }
  button.primary:hover:not(:disabled) { background: var(--indigo-soft); border-color: var(--indigo-soft); }
  button.icon { padding: 5px 7px; line-height: 0; color: var(--muted); }
  button.icon svg { width: 15px; height: 15px; display: block; }
  button.ghost { background: transparent; border-color: transparent; color: var(--muted); }
  button.ghost:hover:not(:disabled) { background: var(--panel-2); border-color: var(--border); }
  button.tiny { font-size: 11.5px; padding: 3px 8px; border-radius: 6px; }

  main { padding: 16px 20px 8px; display: flex; flex-direction: column; gap: 14px; }

  /* ── Stat row ───────────────────────────────────────────────────────────── */
  .stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
  @media (max-width: 900px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .stat {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 11px 13px; box-shadow: var(--shadow); min-width: 0;
  }
  .stat .label {
    font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--faint); font-weight: 600;
  }
  .stat .value {
    margin-top: 3px; font-size: 21px; font-weight: 600; letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums; line-height: 1.2;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .stat .sub { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stat.ok .value { color: var(--green); }
  .stat.bad .value { color: var(--red); }
  .stat.bad.zero .value { color: var(--text); }

  /* ── Cards ──────────────────────────────────────────────────────────────── */
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 11px;
    box-shadow: var(--shadow); overflow: hidden; min-width: 0;
  }
  .card > .head {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 14px; border-bottom: 1px solid var(--border);
    background: var(--panel);
  }
  .card > .head h2 {
    margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); font-weight: 650;
  }
  .card > .head .hint { font-size: 11.5px; color: var(--faint); }
  select {
    font: inherit; font-size: 11.5px; color: var(--muted); cursor: pointer;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px;
  }

  /* ── Timeline ───────────────────────────────────────────────────────────── */
  .tl { display: flex; align-items: stretch; }
  .tl-gutter {
    flex: none; width: 168px; border-right: 1px solid var(--border);
    background: var(--panel); padding-bottom: 8px;
  }
  @media (max-width: 700px) { .tl-gutter { width: 108px; } }
  .tl-gutter .axis-pad { height: 22px; border-bottom: 1px solid var(--border); }
  .tl-gutter .lane-label {
    height: 26px; display: flex; align-items: center; padding: 0 12px;
    font-size: 12px; font-weight: 550;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .tl-viewport { position: relative; flex: 1; overflow: hidden; padding-bottom: 8px; min-width: 0; }
  .tl-track { position: relative; width: 100%; will-change: transform; }
  .tl-axis { position: relative; height: 22px; border-bottom: 1px solid var(--border); }
  .tl-axis .gl {
    position: absolute; top: 0; bottom: -1000px; width: 1px;
    background: var(--border); opacity: .75;
  }
  .tl-axis .gt {
    position: absolute; top: 4px; font-size: 10.5px; color: var(--faint);
    transform: translateX(4px); white-space: nowrap; font-variant-numeric: tabular-nums;
  }
  .tl-lane { position: relative; height: 26px; }
  .tl-lane + .tl-lane { border-top: 1px dashed transparent; }
  .tl-lane:hover { background: color-mix(in srgb, var(--panel-2) 60%, transparent); }
  .mk { position: absolute; top: 7px; height: 12px; border-radius: 2px; }
  .mk.run { width: 4px; margin-left: -2px; }
  .mk.success { background: var(--green); }
  .mk.error, .mk.timed_out { background: var(--red); }
  .mk.skipped { background: var(--faint); }
  .mk.retried { background: var(--amber); }
  .mk.up {
    width: 0; height: 12px; margin-left: -1px;
    border-left: 1px dashed var(--border-strong); border-radius: 0; opacity: .5;
  }
  .mk.up.first { border-left-color: var(--indigo-soft); border-left-style: solid; opacity: 1; }
  .lane-note {
    position: absolute; right: 8px; top: 6px;
    font-size: 10.5px; color: var(--faint); white-space: nowrap;
    font-variant-numeric: tabular-nums; pointer-events: none;
  }
  .tl-now {
    position: absolute; left: 50%; top: 0; bottom: 0; width: 1px;
    background: var(--indigo); opacity: .75; pointer-events: none; z-index: 3;
  }
  .tl-now::before {
    content: ""; position: absolute; top: 0; left: -3px;
    border: 3.5px solid transparent; border-top-color: var(--indigo);
  }
  .tl-empty { padding: 22px 16px; color: var(--muted); text-align: center; font-size: 12.5px; }
  .tl-legend { display: flex; gap: 14px; align-items: center; font-size: 11px; color: var(--faint); }
  .tl-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
  @media (max-width: 700px) { .tl-legend { display: none; } }

  /* ── Grid ───────────────────────────────────────────────────────────────── */
  .grid { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 14px; align-items: start; }
  @media (max-width: 980px) { .grid { grid-template-columns: minmax(0, 1fr); } }

  /* ── Jobs table ─────────────────────────────────────────────────────────── */
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th {
    font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.055em;
    color: var(--faint); font-weight: 650; padding-top: 8px; padding-bottom: 8px;
  }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr.job { cursor: pointer; }
  tbody tr.job:hover { background: var(--panel-2); }
  tbody tr.job.is-running { background: color-mix(in srgb, var(--indigo) 6%, transparent); }
  .jobkey { font-weight: 600; }
  .jobdesc { color: var(--muted); font-size: 11.5px; margin-top: 1px; }
  td.sched code { font-size: 12px; color: var(--muted); }
  td.next { white-space: nowrap; }
  td.act { text-align: right; width: 1%; white-space: nowrap; }
  tbody tr.job .act button { opacity: 0; transition: opacity .12s ease; }
  tbody tr.job:hover .act button, tbody tr.job .act button:focus-visible { opacity: 1; }
  @media (hover: none) { tbody tr.job .act button { opacity: 1; } }

  .badge {
    display: inline-block; padding: 1.5px 8px; border-radius: 999px;
    font-size: 10.5px; font-weight: 650; letter-spacing: 0.01em;
  }
  .badge.success { background: color-mix(in srgb, var(--green) 16%, transparent); color: var(--green); }
  .badge.error, .badge.timed_out { background: color-mix(in srgb, var(--red) 16%, transparent); color: var(--red); }
  .badge.skipped { background: color-mix(in srgb, var(--faint) 20%, transparent); color: var(--muted); }
  .badge.running { background: color-mix(in srgb, var(--indigo) 16%, transparent); color: var(--indigo-soft); }
  .badge.none { background: var(--panel-2); color: var(--faint); }

  /* ── Feed ───────────────────────────────────────────────────────────────── */
  .feed { max-height: 62vh; overflow-y: auto; overscroll-behavior: contain; }
  .ev {
    display: flex; gap: 9px; align-items: baseline;
    padding: 7px 14px; border-bottom: 1px solid var(--border); font-size: 12.5px;
  }
  .ev:last-child { border-bottom: none; }
  .ev .glyph { width: 13px; text-align: center; flex: none; font-size: 11px; }
  .ev .body { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .ev .when { color: var(--faint); font-size: 10.5px; font-variant-numeric: tabular-nums; flex: none; }
  .ev .k { font-weight: 600; }
  .ev.success .glyph { color: var(--green); }
  .ev.error .glyph, .ev.timeout .glyph { color: var(--red); }
  .ev.retry .glyph { color: var(--amber); }
  .ev.fire .glyph { color: var(--indigo-soft); }
  .ev.skipped .glyph, .ev.engine .glyph { color: var(--faint); }
  .ev .detail { color: var(--muted); }
  .paused-note {
    padding: 6px 14px; font-size: 11.5px; color: var(--amber);
    background: color-mix(in srgb, var(--amber) 10%, transparent);
    border-bottom: 1px solid var(--border);
  }

  .empty { padding: 26px 16px; color: var(--muted); text-align: center; font-size: 12.5px; }
  .empty .lead { color: var(--text); font-weight: 550; margin-bottom: 3px; }

  footer {
    padding: 14px 20px 30px; color: var(--faint); font-size: 11.5px;
    display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
  }
  footer .sep { opacity: .5; }

  /* ── Drawer ─────────────────────────────────────────────────────────────── */
  .overlay {
    position: fixed; inset: 0; background: rgba(2, 6, 23, 0.5);
    display: none; justify-content: flex-end; z-index: 40;
  }
  .overlay.open { display: flex; }
  .drawer {
    width: min(560px, 94vw); background: var(--panel); border-left: 1px solid var(--border);
    height: 100%; overflow-y: auto; display: flex; flex-direction: column;
  }
  .drawer .dhead {
    display: flex; align-items: center; gap: 10px; padding: 12px 16px;
    border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--panel); z-index: 2;
  }
  .drawer .dtitle { font-weight: 650; letter-spacing: -0.01em; }
  .drawer .pad { padding: 16px; }
  .kv { display: flex; gap: 10px; padding: 5px 0; font-size: 12.5px; }
  .kv > span:first-child { color: var(--muted); min-width: 92px; flex: none; }
  .section-title {
    font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--faint); font-weight: 650; margin: 20px 0 7px;
  }
  ul.plain { list-style: none; margin: 0; padding: 0; }
  ul.plain > li {
    padding: 7px 0; border-bottom: 1px solid var(--border);
    display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px;
  }
  ul.plain > li:last-child { border-bottom: none; }
  .runline { display: block; }
  .runline .row1 { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
  .runline .meta { color: var(--faint); font-size: 11px; font-variant-numeric: tabular-nums; }
  .runline pre {
    margin: 6px 0 0; padding: 8px 10px; border-radius: 7px;
    background: var(--panel-2); border: 1px solid var(--border);
    font-size: 11.5px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow: auto;
  }
  .runline pre.err { color: var(--red); border-color: color-mix(in srgb, var(--red) 30%, var(--border)); }
</style>
</head>
<body>

<header class="top">
  <div class="mark" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.2V12l3.4 2"></path></svg>
  </div>
  <div class="wordmark">Cronvello <span>local engine</span></div>
  <span id="engine-chip" class="chip"><span class="dot"></span><span id="engine-text">starting&hellip;</span></span>
  <div class="spacer"></div>
  <span id="conn" class="chip"><span class="dot"></span><span id="conn-text">connecting&hellip;</span></span>
  <button id="theme-btn" class="icon" title="Toggle light / dark" aria-label="Toggle light or dark theme">
    <svg id="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"></path></svg>
    <svg id="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" hidden><circle cx="12" cy="12" r="4"></circle><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"></path></svg>
  </button>
</header>

<main>
  <section class="stats" aria-label="Engine summary">
    <div class="stat"><div class="label">Jobs</div><div class="value num" id="s-jobs">&mdash;</div><div class="sub" id="s-jobs-sub">&nbsp;</div></div>
    <div class="stat"><div class="label">Runs this session</div><div class="value num" id="s-runs">&mdash;</div><div class="sub" id="s-runs-sub">&nbsp;</div></div>
    <div class="stat ok"><div class="label">Succeeded</div><div class="value num" id="s-ok">&mdash;</div><div class="sub" id="s-ok-sub">&nbsp;</div></div>
    <div class="stat bad zero"><div class="label">Failed</div><div class="value num" id="s-bad">&mdash;</div><div class="sub" id="s-bad-sub">&nbsp;</div></div>
    <div class="stat"><div class="label">Next fire</div><div class="value num" id="s-next">&mdash;</div><div class="sub" id="s-next-sub">&nbsp;</div></div>
  </section>

  <section class="card">
    <div class="head">
      <h2>Timeline</h2>
      <span class="hint" id="tl-hint"></span>
      <div class="spacer"></div>
      <div class="tl-legend" aria-hidden="true">
        <span><i style="background:var(--green)"></i>ok</span>
        <span><i style="background:var(--red)"></i>failed</span>
        <span><i style="background:var(--faint)"></i>skipped</span>
        <span><i style="border-left:2px dashed var(--border-strong);width:2px;border-radius:0"></i>upcoming</span>
      </div>
      <label class="hint" for="tl-span">Window</label>
      <select id="tl-span" aria-label="Timeline window">
        <option value="120000">2 min</option>
        <option value="600000" selected>10 min</option>
        <option value="3600000">1 hour</option>
        <option value="21600000">6 hours</option>
      </select>
    </div>
    <div class="tl" id="tl">
      <div class="tl-gutter" id="tl-gutter"><div class="axis-pad"></div></div>
      <div class="tl-viewport" id="tl-viewport">
        <div class="tl-track" id="tl-track"><div class="tl-axis" id="tl-axis"></div></div>
        <div class="tl-now" aria-hidden="true"></div>
      </div>
    </div>
    <div class="tl-empty" id="tl-empty" hidden>No jobs to plot.</div>
  </section>

  <div class="grid">
    <section class="card">
      <div class="head"><h2>Jobs</h2><span class="hint" id="jobs-hint"></span></div>
      <table>
        <thead><tr><th>Job</th><th>Schedule</th><th>Zone</th><th>Next fire</th><th>Last run</th><th></th></tr></thead>
        <tbody id="jobs"><tr><td colspan="6" class="empty">Loading&hellip;</td></tr></tbody>
      </table>
    </section>

    <section class="card">
      <div class="head">
        <h2>Live feed</h2>
        <div class="spacer"></div>
        <button id="feed-pause" class="tiny ghost" aria-pressed="false">Pause</button>
        <button id="feed-clear" class="tiny ghost">Clear</button>
      </div>
      <div id="feed-paused" class="paused-note" hidden></div>
      <div id="feed" class="feed" role="log" aria-label="Live run feed">
        <div class="empty"><div class="lead">Waiting for the first run.</div><div id="feed-hint">Every fire shows up here as it happens.</div></div>
      </div>
    </section>
  </div>
</main>

<footer>
  <span>Local engine</span><span class="sep">&middot;</span>
  <span>no account</span><span class="sep">&middot;</span>
  <span>no cloud</span><span class="sep">&middot;</span>
  <span>no outbound network</span><span class="sep">&middot;</span>
  <span>this process is the only source of truth</span>
</footer>

<div id="overlay" class="overlay" role="dialog" aria-modal="true" aria-labelledby="drawer-title" hidden>
  <div class="drawer">
    <div class="dhead">
      <div class="dtitle" id="drawer-title">Job</div>
      <div class="spacer"></div>
      <button id="drawer-run" class="primary tiny">Run now</button>
      <button id="drawer-close" class="tiny">Close</button>
    </div>
    <div class="pad" id="drawer-body"></div>
  </div>
</div>

<script>
(function () {
  "use strict";

  var MAX_FEED = 250;
  var REFRESH_MS = 10000;      // reconciliation poll behind the event stream
  var DEBOUNCE_MS = 400;       // collapse a burst of events into one refetch
  var UPCOMING = 40;           // fire times requested per job

  var state = { engine: {}, jobs: [], runs: [] };
  var jobsByKey = {};
  var rows = {};               // key -> { tr, next, last, running }
  var lanes = {};              // key -> { lane, label }
  var laneOrder = [];
  var anchorNow = Date.now();
  var spanMs = 600000;
  var openKey = null;
  var lastFocus = null;
  var paused = false;
  var pausedCount = 0;
  var refreshTimer = null;

  function el(id) { return document.getElementById(id); }
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function clockTime(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }
  function fmtDuration(ms) {
    if (ms == null) return "";
    if (ms < 1000) return ms + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + "s";
    var m = Math.floor(ms / 60000);
    return m + "m " + Math.round((ms % 60000) / 1000) + "s";
  }
  function fmtElapsed(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    if (d) return d + "d " + h + "h";
    if (h) return h + "h " + m + "m";
    if (m) return m + "m " + s + "s";
    return s + "s";
  }
  /** A round duration, for labels rather than countdowns: "5m", not "5m 0s". */
  function fmtSpan(ms) {
    if (ms % 3600000 === 0) return (ms / 3600000) + "h";
    if (ms % 60000 === 0) return (ms / 60000) + "m";
    return Math.round(ms / 1000) + "s";
  }
  function countdown(iso) {
    if (!iso) return "\\u2014";
    var diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return "due now";
    return "in " + fmtElapsed(diff);
  }
  function localTime(iso) {
    try { return new Date(iso).toLocaleString(); } catch (e) { return String(iso); }
  }
  function setText(node, text) { if (node && node.textContent !== text) node.textContent = text; }

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
  // The icon offers the theme you would switch *to*, which is the only reading that stays true
  // whether the current theme came from the OS or from a previous click.
  function paintThemeIcon() {
    var dark = resolvedTheme() === "dark";
    el("icon-sun").hidden = !dark;
    el("icon-moon").hidden = dark;
    el("theme-btn").title = dark ? "Switch to light" : "Switch to dark";
  }
  try { applyTheme(localStorage.getItem("cronvello-theme")); } catch (e) {}
  paintThemeIcon();
  el("theme-btn").addEventListener("click", function () {
    var next = resolvedTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    paintThemeIcon();
    try { localStorage.setItem("cronvello-theme", next); } catch (e) {}
  });

  // ── Badges ─────────────────────────────────────────────────────────────────
  function badge(status) {
    var span = document.createElement("span");
    span.className = "badge " + (status || "none");
    span.textContent = status || "\\u2014";
    return span;
  }
  function replaceChild1(cell, node) {
    cell.textContent = "";
    cell.appendChild(node);
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  function renderStats() {
    var jobs = state.jobs, runs = state.runs;
    var ok = 0, bad = 0, skipped = 0, retried = 0;
    for (var i = 0; i < runs.length; i++) {
      var s = runs[i].status;
      if (s === "success") { ok++; if (runs[i].attempts > 1) retried++; }
      else if (s === "skipped") skipped++;
      else bad++;
    }
    var active = 0;
    for (var j = 0; j < jobs.length; j++) if (jobs[j].running) active++;

    setText(el("s-jobs"), String(jobs.length));
    setText(el("s-jobs-sub"), active ? active + " running now" : "idle");

    setText(el("s-runs"), String(runs.length));
    var upSince = state.engine.startedAt ? "up " + fmtElapsed(Date.now() - state.engine.startedAt) : "not started";
    setText(el("s-runs-sub"), upSince);

    setText(el("s-ok"), String(ok));
    setText(el("s-ok-sub"), retried ? retried + " after a retry" : (skipped ? skipped + " skipped (overlap)" : "\\u00a0"));

    setText(el("s-bad"), String(bad));
    el("s-bad").parentNode.className = "stat bad" + (bad ? "" : " zero");
    setText(el("s-bad-sub"), bad ? "check the feed" : "nothing failed");

    // Soonest upcoming fire across all jobs.
    var soonest = null, soonestKey = "";
    for (var k = 0; k < jobs.length; k++) {
      if (!jobs[k].nextFire) continue;
      var t = new Date(jobs[k].nextFire).getTime();
      if (soonest === null || t < soonest) { soonest = t; soonestKey = jobs[k].key; }
    }
    if (soonest === null) {
      setText(el("s-next"), "\\u2014");
      setText(el("s-next-sub"), jobs.length ? "nothing scheduled" : "\\u00a0");
    } else {
      setText(el("s-next"), countdown(new Date(soonest).toISOString()).replace(/^in /, ""));
      setText(el("s-next-sub"), soonestKey);
    }
  }

  // ── Jobs table ─────────────────────────────────────────────────────────────
  // "No jobs" and "not loaded yet" both leave the row map empty, so this flag is what separates
  // them. Without it the first snapshot of an empty registry would sit on "Loading" forever.
  var built = false;

  function sameKeys(jobs) {
    if (!built) return false;
    var keys = Object.keys(rows);
    if (keys.length !== jobs.length) return false;
    for (var i = 0; i < jobs.length; i++) if (!rows[jobs[i].key]) return false;
    return true;
  }

  function buildRows(jobs) {
    var tbody = el("jobs");
    tbody.textContent = "";
    rows = {};
    if (!jobs.length) {
      var tr0 = document.createElement("tr");
      var td0 = document.createElement("td");
      td0.colSpan = 6; td0.className = "empty";
      td0.innerHTML = '<div class="lead">No jobs registered.</div>Add one to <code>jobs</code> in your config and restart.';
      tr0.appendChild(td0); tbody.appendChild(tr0);
      return;
    }
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      var tr = document.createElement("tr");
      tr.className = "job";
      tr.tabIndex = 0;
      tr.setAttribute("role", "button");
      tr.setAttribute("aria-label", "Details for " + j.key);
      tr.dataset.key = j.key;

      var tdName = document.createElement("td");
      var name = document.createElement("div");
      name.className = "jobkey"; name.textContent = j.key;
      tdName.appendChild(name);
      if (j.description) {
        var desc = document.createElement("div");
        desc.className = "jobdesc"; desc.textContent = j.description;
        tdName.appendChild(desc);
      }

      var tdSched = document.createElement("td");
      tdSched.className = "sched";
      var code = document.createElement("code"); code.textContent = j.schedule;
      tdSched.appendChild(code);

      var tdZone = document.createElement("td");
      tdZone.style.color = "var(--muted)";
      tdZone.textContent = j.timeZone;

      var tdNext = document.createElement("td");
      tdNext.className = "next num";

      var tdLast = document.createElement("td");

      var tdAct = document.createElement("td");
      tdAct.className = "act";
      var btn = document.createElement("button");
      btn.className = "tiny"; btn.textContent = "Run";
      btn.setAttribute("aria-label", "Run " + j.key + " now");
      btn.dataset.key = j.key;
      tdAct.appendChild(btn);

      tr.appendChild(tdName); tr.appendChild(tdSched); tr.appendChild(tdZone);
      tr.appendChild(tdNext); tr.appendChild(tdLast); tr.appendChild(tdAct);
      tbody.appendChild(tr);

      rows[j.key] = { tr: tr, next: tdNext, last: tdLast, btn: btn };
    }
  }

  function paintRows(jobs) {
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i], r = rows[j.key];
      if (!r) continue;
      r.tr.classList.toggle("is-running", !!j.running);
      r.next.dataset.next = j.nextFire || "";
      setText(r.next, j.nextFire ? countdown(j.nextFire) : "\\u2014");
      var status = j.running ? "running" : (j.lastRun ? j.lastRun.status : "");
      if (r.lastStatus !== status) {
        r.lastStatus = status;
        replaceChild1(r.last, badge(status));
      }
    }
  }

  function tickCountdowns() {
    for (var key in rows) {
      if (!Object.prototype.hasOwnProperty.call(rows, key)) continue;
      var cell = rows[key].next;
      var iso = cell.dataset.next;
      setText(cell, iso ? countdown(iso) : "\\u2014");
    }
    if (state.engine.startedAt) {
      setText(el("s-runs-sub"), "up " + fmtElapsed(Date.now() - state.engine.startedAt));
    }
    var jobs = state.jobs, soonest = null, soonestKey = "";
    for (var i = 0; i < jobs.length; i++) {
      if (!jobs[i].nextFire) continue;
      var t = new Date(jobs[i].nextFire).getTime();
      if (soonest === null || t < soonest) { soonest = t; soonestKey = jobs[i].key; }
    }
    if (soonest !== null) {
      setText(el("s-next"), countdown(new Date(soonest).toISOString()).replace(/^in /, ""));
      setText(el("s-next-sub"), soonestKey);
    }
  }

  // ── Timeline ───────────────────────────────────────────────────────────────
  //
  // The track covers a fixed absolute window [anchorNow - span/2, anchorNow + span/2] and every mark
  // is positioned once, as a percentage of that window. The passing second only shifts the whole
  // track, so an idle dashboard writes one transform per frame-ish instead of touching every mark.
  function buildLanes(jobs) {
    var gutter = el("tl-gutter"), track = el("tl-track");
    gutter.textContent = "";
    var pad = document.createElement("div"); pad.className = "axis-pad";
    gutter.appendChild(pad);

    // Keep the axis, drop the lanes.
    var axis = el("tl-axis");
    track.textContent = "";
    track.appendChild(axis);

    lanes = {}; laneOrder = [];
    for (var i = 0; i < jobs.length; i++) {
      var key = jobs[i].key;
      var label = document.createElement("div");
      label.className = "lane-label"; label.textContent = key; label.title = key;
      gutter.appendChild(label);

      var lane = document.createElement("div");
      lane.className = "tl-lane"; lane.dataset.key = key;
      track.appendChild(lane);

      lanes[key] = { lane: lane, label: label };
      laneOrder.push(key);
    }
    el("tl").hidden = jobs.length === 0;
    el("tl-empty").hidden = jobs.length !== 0;
  }

  function axisStep(span) {
    var steps = [1000, 5000, 15000, 30000, 60000, 300000, 900000, 1800000, 3600000, 10800000, 21600000];
    for (var i = 0; i < steps.length; i++) if (span / steps[i] <= 10) return steps[i];
    return steps[steps.length - 1];
  }

  function paintTimeline() {
    var jobs = state.jobs;
    anchorNow = Date.now();
    var start = anchorNow - spanMs / 2;
    var pct = function (t) { return ((t - start) / spanMs) * 100; };
    el("tl-track").style.transform = "translateX(0%)";

    // Axis gridlines.
    var axis = el("tl-axis");
    axis.textContent = "";
    var step = axisStep(spanMs);
    var first = Math.ceil(start / step) * step;
    for (var t = first; t < start + spanMs; t += step) {
      var p = pct(t);
      var gl = document.createElement("div");
      gl.className = "gl"; gl.style.left = p + "%";
      axis.appendChild(gl);
      var gt = document.createElement("div");
      gt.className = "gt"; gt.style.left = p + "%"; gt.textContent = clockTime(t);
      axis.appendChild(gt);
    }

    // Marks per lane: past runs, then upcoming fires.
    var runsByKey = {};
    for (var i = 0; i < state.runs.length; i++) {
      var run = state.runs[i];
      (runsByKey[run.key] || (runsByKey[run.key] = [])).push(run);
    }

    for (var l = 0; l < laneOrder.length; l++) {
      var key = laneOrder[l];
      var lane = lanes[key].lane;
      lane.textContent = "";

      var list = runsByKey[key] || [];
      for (var r = 0; r < list.length; r++) {
        var rec = list[r];
        if (rec.startedAt < start || rec.startedAt > start + spanMs) continue;
        var mk = document.createElement("div");
        mk.className = "mk run " + rec.status + (rec.status === "success" && rec.attempts > 1 ? " retried" : "");
        mk.style.left = pct(rec.startedAt) + "%";
        mk.title = key + " \\u00b7 " + rec.status + " \\u00b7 " + clockTime(rec.startedAt) +
          (rec.durationMs ? " \\u00b7 " + fmtDuration(rec.durationMs) : "") +
          (rec.attempts > 1 ? " \\u00b7 " + rec.attempts + " attempts" : "");
        lane.appendChild(mk);
      }

      var ups = jobsByKey[key] && jobsByKey[key].upcoming ? jobsByKey[key].upcoming : [];
      var plotted = 0;
      for (var u = 0; u < ups.length; u++) {
        var at = new Date(ups[u]).getTime();
        if (at > start + spanMs) break;
        if (at < anchorNow) continue;
        var um = document.createElement("div");
        um.className = "mk up" + (plotted === 0 ? " first" : "");
        um.style.left = pct(at) + "%";
        um.title = key + " \\u00b7 next fire " + clockTime(at);
        lane.appendChild(um);
        plotted++;
      }

      // A lane whose whole schedule sits outside the window would otherwise read as "nothing here",
      // which is indistinguishable from a broken job. Say when it actually fires.
      if (!lane.childNodes.length) {
        var note = document.createElement("div");
        note.className = "lane-note";
        var job = jobsByKey[key];
        note.textContent = job && job.nextFire ? "next " + countdown(job.nextFire) : "not scheduled";
        lane.appendChild(note);
      }
    }

    el("tl-hint").textContent = fmtSpan(spanMs / 2) + " back, " + fmtSpan(spanMs / 2) + " ahead";
  }

  function slideTimeline() {
    var drift = Date.now() - anchorNow;
    // Re-anchor rather than sliding forever, so marks that left the window get dropped.
    if (Math.abs(drift) > spanMs / 4) { paintTimeline(); return; }
    el("tl-track").style.transform = "translateX(" + (-(drift / spanMs) * 100) + "%)";
  }

  el("tl-span").addEventListener("change", function () {
    spanMs = Number(this.value) || 600000;
    paintTimeline();
  });

  // ── Live feed ──────────────────────────────────────────────────────────────
  var glyphs = {
    fire: "\\u25b8", success: "\\u2713", error: "\\u2717", timeout: "\\u29d6",
    retry: "\\u21ba", skipped: "\\u2298", scheduled: "\\u00b7",
    "engine-start": "\\u25cf", "engine-stop": "\\u25a0"
  };

  function describe(ev) {
    var frag = document.createDocumentFragment();
    function k(text) { var s = document.createElement("span"); s.className = "k"; s.textContent = text; return s; }
    function plain(text) { return document.createTextNode(text); }
    function dim(text) { var s = document.createElement("span"); s.className = "detail"; s.textContent = text; return s; }

    switch (ev.type) {
      case "fire":
        frag.appendChild(k(ev.key)); frag.appendChild(plain(" fired"));
        if (ev.attempt > 1) frag.appendChild(dim(" (attempt " + ev.attempt + ")"));
        break;
      case "success":
        frag.appendChild(k(ev.key)); frag.appendChild(plain(" succeeded "));
        frag.appendChild(dim("in " + fmtDuration(ev.durationMs) + (ev.attempts > 1 ? ", after " + ev.attempts + " attempts" : "")));
        break;
      case "error":
        frag.appendChild(k(ev.key)); frag.appendChild(plain(" errored: " + ev.error));
        frag.appendChild(dim(ev.willRetry ? " (retrying)" : " (gave up)"));
        break;
      case "timeout":
        frag.appendChild(k(ev.key)); frag.appendChild(plain(" timed out "));
        frag.appendChild(dim("after " + fmtDuration(ev.durationMs) + (ev.willRetry ? ", retrying" : ", gave up")));
        break;
      case "retry":
        frag.appendChild(k(ev.key));
        frag.appendChild(dim(" retrying in " + fmtDuration(ev.delayMs) + " (attempt " + ev.attempt + ")"));
        break;
      case "skipped":
        frag.appendChild(k(ev.key)); frag.appendChild(dim(" skipped, previous run still in flight"));
        break;
      case "scheduled":
        // This event's timestamp is the *next fire*, not the moment it was emitted. Saying so keeps
        // the feed's right-hand clock strictly the arrival time and never looks out of order.
        frag.appendChild(k(ev.key)); frag.appendChild(dim(" scheduled for " + clockTime(ev.at)));
        break;
      case "engine-start":
        frag.appendChild(plain("Engine started with " + ev.jobs + " job" + (ev.jobs === 1 ? "" : "s")));
        break;
      case "engine-stop":
        frag.appendChild(plain("Engine stopped"));
        break;
      default:
        frag.appendChild(plain(ev.type));
    }
    return frag;
  }

  function feedClass(type) {
    if (type === "engine-start" || type === "engine-stop" || type === "scheduled") return "engine";
    return type;
  }

  function pushEvent(ev) {
    var feed = el("feed");
    var firstChild = feed.firstChild;
    if (firstChild && firstChild.className === "empty") feed.textContent = "";

    var div = document.createElement("div");
    div.className = "ev " + feedClass(ev.type);

    var g = document.createElement("div");
    g.className = "glyph"; g.textContent = glyphs[ev.type] || "\\u2022";
    var b = document.createElement("div");
    b.className = "body"; b.appendChild(describe(ev));
    var w = document.createElement("div");
    w.className = "when";
    w.textContent = clockTime(ev.type === "scheduled" ? Date.now() : (ev.at || Date.now()));

    div.appendChild(g); div.appendChild(b); div.appendChild(w);
    feed.insertBefore(div, feed.firstChild);
    while (feed.childNodes.length > MAX_FEED) feed.removeChild(feed.lastChild);
  }

  el("feed-pause").addEventListener("click", function () {
    paused = !paused;
    this.textContent = paused ? "Resume" : "Pause";
    this.setAttribute("aria-pressed", paused ? "true" : "false");
    if (!paused) { pausedCount = 0; el("feed-paused").hidden = true; }
  });
  el("feed-clear").addEventListener("click", function () {
    el("feed").textContent = "";
    var d = document.createElement("div");
    d.className = "empty"; d.textContent = "Cleared. New events appear here.";
    el("feed").appendChild(d);
  });

  // ── Connection ─────────────────────────────────────────────────────────────
  function setConn(stateName) {
    var chip = el("conn");
    chip.className = "chip " + stateName;
    setText(el("conn-text"), stateName === "live" ? "live" : (stateName === "down" ? "reconnecting" : "connecting\\u2026"));
  }
  function setEngineChip() {
    var chip = el("engine-chip");
    var running = state.engine.running;
    chip.className = "chip" + (running ? " live" : "");
    var n = state.jobs.length;
    setText(el("engine-text"), (running ? "running" : "stopped") + " \\u00b7 " + n + " job" + (n === 1 ? "" : "s"));
  }

  function connect() {
    setConn("connecting");
    var src = new EventSource("/api/events");
    src.onopen = function () { setConn("live"); scheduleRefresh(0); };
    src.onmessage = function (m) {
      var ev;
      try { ev = JSON.parse(m.data); } catch (e) { return; }
      if (paused) {
        pausedCount++;
        el("feed-paused").hidden = false;
        el("feed-paused").textContent = "Paused \\u00b7 " + pausedCount + " event" + (pausedCount === 1 ? "" : "s") + " not shown";
      } else {
        pushEvent(ev);
      }
      // Terminal events change job status / history; reconcile on the next tick.
      if (ev.type !== "fire") scheduleRefresh(DEBOUNCE_MS);
    };
    src.onerror = function () { setConn("down"); };
  }

  // ── State ──────────────────────────────────────────────────────────────────
  function scheduleRefresh(delay) {
    if (refreshTimer) return;
    refreshTimer = setTimeout(function () { refreshTimer = null; refresh(); }, delay);
  }

  function refresh() {
    return fetch("/api/state?upcoming=" + UPCOMING)
      .then(function (r) { return r.json(); })
      .then(function (next) {
        var structureChanged = !sameKeys(next.jobs);
        state = next;
        jobsByKey = {};
        for (var i = 0; i < next.jobs.length; i++) jobsByKey[next.jobs[i].key] = next.jobs[i];

        if (structureChanged) { buildRows(next.jobs); buildLanes(next.jobs); built = true; }
        paintRows(next.jobs);
        paintTimeline();
        renderStats();
        setEngineChip();
        if (openKey) paintDrawer(openKey);
      })
      .catch(function () { /* the poll below retries */ });
  }

  // ── Drawer ─────────────────────────────────────────────────────────────────
  function openDrawer(key) {
    if (!jobsByKey[key]) return;
    openKey = key;
    lastFocus = document.activeElement;
    el("overlay").hidden = false;
    el("overlay").classList.add("open");
    paintDrawer(key);
    el("drawer-close").focus();
  }

  function closeDrawer() {
    openKey = null;
    el("overlay").classList.remove("open");
    el("overlay").hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function runLine(run) {
    var li = document.createElement("li");
    var wrap = document.createElement("div");
    wrap.className = "runline";

    var row1 = document.createElement("div");
    row1.className = "row1";
    var left = document.createElement("span");
    left.appendChild(badge(run.status));
    var when = document.createElement("span");
    when.className = "meta";
    when.textContent = " " + localTime(new Date(run.startedAt).toISOString());
    left.appendChild(when);
    var right = document.createElement("span");
    right.className = "meta";
    right.textContent = fmtDuration(run.durationMs) + (run.attempts > 1 ? " \\u00b7 " + run.attempts + " attempts" : "");
    row1.appendChild(left); row1.appendChild(right);
    wrap.appendChild(row1);

    if (run.error) {
      var pre = document.createElement("pre");
      pre.className = "err"; pre.textContent = run.error;
      wrap.appendChild(pre);
    } else if (run.result !== undefined && run.result !== null) {
      var pre2 = document.createElement("pre");
      try { pre2.textContent = JSON.stringify(run.result, null, 2); }
      catch (e) { pre2.textContent = String(run.result); }
      wrap.appendChild(pre2);
    }

    li.appendChild(wrap);
    li.style.display = "block";
    return li;
  }

  function paintDrawer(key) {
    var job = jobsByKey[key];
    if (!job) { closeDrawer(); return; }
    setText(el("drawer-title"), key);

    var body = el("drawer-body");
    body.textContent = "";

    function kv(label, valueNode) {
      var d = document.createElement("div");
      d.className = "kv";
      var l = document.createElement("span"); l.textContent = label;
      d.appendChild(l); d.appendChild(valueNode);
      body.appendChild(d);
    }
    function textNode(t) { var s = document.createElement("span"); s.textContent = t; return s; }
    function codeNode(t) { var s = document.createElement("code"); s.textContent = t; return s; }

    kv("Schedule", codeNode(job.schedule));
    kv("Time zone", textNode(job.timeZone));
    if (job.description) kv("Description", textNode(job.description));
    kv("Status", job.running ? badge("running") : badge(job.lastRun ? job.lastRun.status : ""));

    var t1 = document.createElement("div");
    t1.className = "section-title"; t1.textContent = "Next fire times";
    body.appendChild(t1);

    var ups = job.upcoming || [];
    if (ups.length) {
      var ul = document.createElement("ul");
      ul.className = "plain";
      for (var i = 0; i < ups.length && i < 8; i++) {
        var li = document.createElement("li");
        var a = document.createElement("span"); a.textContent = localTime(ups[i]);
        var b = document.createElement("span"); b.className = "meta num"; b.textContent = countdown(ups[i]);
        li.appendChild(a); li.appendChild(b);
        ul.appendChild(li);
      }
      body.appendChild(ul);
    } else {
      var e1 = document.createElement("div");
      e1.className = "empty"; e1.textContent = "No upcoming fires for this expression.";
      body.appendChild(e1);
    }

    var t2 = document.createElement("div");
    t2.className = "section-title"; t2.textContent = "Recent runs";
    body.appendChild(t2);

    var mine = [];
    for (var r = 0; r < state.runs.length; r++) if (state.runs[r].key === key) mine.push(state.runs[r]);
    if (mine.length) {
      var ul2 = document.createElement("ul");
      ul2.className = "plain";
      for (var m = 0; m < mine.length && m < 25; m++) ul2.appendChild(runLine(mine[m]));
      body.appendChild(ul2);
    } else {
      var e2 = document.createElement("div");
      e2.className = "empty"; e2.textContent = "No runs yet in this session.";
      body.appendChild(e2);
    }
  }

  function runNow(key, btn) {
    var label = btn.textContent;
    btn.disabled = true; btn.textContent = "Running\\u2026";
    fetch("/api/trigger/" + encodeURIComponent(key), { method: "POST", headers: { "content-type": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function () { btn.textContent = "Ran"; scheduleRefresh(0); })
      .catch(function () { btn.textContent = "Failed"; })
      .then(function () {
        setTimeout(function () { btn.disabled = false; btn.textContent = label; }, 1200);
      });
  }

  el("drawer-close").addEventListener("click", closeDrawer);
  el("drawer-run").addEventListener("click", function () { if (openKey) runNow(openKey, this); });
  el("overlay").addEventListener("click", function (e) { if (e.target === el("overlay")) closeDrawer(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && openKey) closeDrawer();
  });

  // Row interactions are delegated, so rebuilding the table never leaks listeners.
  el("jobs").addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("button[data-key]") : null;
    if (btn) { e.stopPropagation(); runNow(btn.dataset.key, btn); return; }
    var tr = e.target.closest ? e.target.closest("tr.job") : null;
    if (tr) openDrawer(tr.dataset.key);
  });
  el("jobs").addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var tr = e.target.closest ? e.target.closest("tr.job") : null;
    if (tr) { e.preventDefault(); openDrawer(tr.dataset.key); }
  });
  el("tl-gutter").addEventListener("click", function (e) {
    var label = e.target.closest ? e.target.closest(".lane-label") : null;
    if (label) openDrawer(label.textContent);
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  refresh();
  connect();
  setInterval(tickCountdowns, 1000);
  setInterval(slideTimeline, 1000);
  setInterval(function () { scheduleRefresh(0); }, REFRESH_MS);
})();
</script>
</body>
</html>`;

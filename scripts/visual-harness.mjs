/**
 * Visual harness: renders the panel's real markup with the real compiled CSS
 * (extracted from lib/client.js) as a static page, so the layout can be
 * reviewed in a browser at any width/theme/state without a running host.
 *
 * Usage:  node scripts/build.mjs && node scripts/visual-harness.mjs [outPath]
 * Output: ../doctor-visual-harness.html (workspace root, outside the repo)
 *
 * The markup below mirrors DoctorSection.tsx render output with dsh_td_*
 * class names (the build's 1:1 CSS-module prefix). Keep it in sync when the
 * component structure changes — the harness exists only for eyeball checks.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

const cssMatch = bundle.match(/var css = ('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/s);
if (!cssMatch) {
  console.error("Could not find the inlined CSS string in lib/client.js");
  process.exit(1);
}
const css = Function(`return ${cssMatch[1]}`)();

const out = process.argv[2]
  ? resolve(process.argv[2])
  : join(here, "..", "..", "doctor-visual-harness.html");

const html = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tool Doctor — visual harness</title>
<style>
body { margin: 0; padding: 24px; background: #ffffff; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
@media (prefers-color-scheme: dark) { body { background: #101216; } }
.harnessPane { display: flex; flex-direction: column; gap: 28px; max-width: 1024px; margin: 0 auto; }
.harnessNote { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #999; margin: 0; }
</style>
<style>${css}</style>
</head>
<body>
<main class="harnessPane">

<p class="harnessNote">Populated — overview, live log, shadow banner</p>
<div class="dsh_td_container">
  <header class="dsh_td_hero">
    <div class="dsh_td_heroMain">
      <div class="dsh_td_titleGroup">
        <h2 class="dsh_td_title">Tool Doctor</h2>
        <p class="dsh_td_subtitle">Watches tool calls, repairs recoverable failures, and reports what happened.</p>
      </div>
    </div>
    <div class="dsh_td_headerActions">
      <button type="button" class="dsh_td_btnGhost">Refresh</button>
      <button type="button" class="dsh_td_btnGhost dsh_td_btnGhostActive">Auto-refresh</button>
    </div>
  </header>

  <section class="dsh_td_overview">
    <div class="dsh_td_outcomeCard" data-state="attention">
      <div class="dsh_td_outcomeStatus">
        <span class="dsh_td_statusDot dsh_td_statusDotAttention" aria-hidden="true"></span>
        <div class="dsh_td_statusCopy">
          <span class="dsh_td_statusHeadline">Needs attention</span>
          <span class="dsh_td_statusReason">9 calls are still failing.</span>
          <span class="dsh_td_statusMeta"><span>Updated 2 min ago</span></span>
        </div>
        <button type="button" class="dsh_td_statusAction">See failing calls</button>
      </div>
      <div class="dsh_td_outcomeEvidence">
        <div class="dsh_td_outcomePrimary">
          <span class="dsh_td_outcomeValue dsh_td_kpiValueSuccess">37</span>
          <span class="dsh_td_outcomeCaption">calls repaired</span>
          <span class="dsh_td_outcomeRateRow">
            <span class="dsh_td_kpiMeter"><span class="dsh_td_kpiMeterFill" style="width:92.5%"></span></span>
            <span class="dsh_td_kpiDesc">92.5% of repair attempts succeeded.</span>
          </span>
        </div>
        <div class="dsh_td_outcomeSplit">
          <div class="dsh_td_outcomeSplitItem">
            <span class="dsh_td_outcomeSplitValue dsh_td_kpiValueDanger">9</span>
            <span class="dsh_td_outcomeSplitLabel">calls still failing</span>
          </div>
        </div>
      </div>
    </div>
    <div class="dsh_td_outcomeCard" data-state="ok">
      <div class="dsh_td_outcomeStatus">
        <span class="dsh_td_statusDot dsh_td_statusDotOk" aria-hidden="true"></span>
        <div class="dsh_td_statusCopy">
          <span class="dsh_td_statusHeadline">Working normally</span>
          <span class="dsh_td_statusReason">Every recent failure was repaired before the host saw it.</span>
          <span class="dsh_td_statusMeta"><span class="dsh_td_statusStale">Connection lost — showing saved data.</span></span>
        </div>
      </div>
      <div class="dsh_td_outcomeEvidence">
        <div class="dsh_td_outcomePrimary">
          <span class="dsh_td_outcomeValue dsh_td_kpiValueSuccess">12</span>
          <span class="dsh_td_outcomeCaption">calls repaired</span>
          <span class="dsh_td_outcomeRateRow">
            <span class="dsh_td_kpiMeter"><span class="dsh_td_kpiMeterFill" style="width:100%"></span></span>
            <span class="dsh_td_kpiDesc">100% of repair attempts succeeded.</span>
          </span>
        </div>
        <div class="dsh_td_outcomeSplit">
          <div class="dsh_td_outcomeSplitItem">
            <span class="dsh_td_outcomeSplitValue">0</span>
            <span class="dsh_td_outcomeSplitLabel">calls still failing</span>
          </div>
        </div>
      </div>
    </div>
    <div class="dsh_td_kpiGrid">
      <div class="dsh_td_kpiCard dsh_td_kpiCardSmall"><span class="dsh_td_kpiTitle">Calls checked</span><span class="dsh_td_kpiValue">146</span></div>
      <div class="dsh_td_kpiCard dsh_td_kpiCardSmall"><span class="dsh_td_kpiTitle">Promoted calls</span><span class="dsh_td_kpiValue dsh_td_kpiValueAccent">4</span></div>
      <div class="dsh_td_kpiCard dsh_td_kpiCardSmall"><span class="dsh_td_kpiTitle">Estimated tokens saved <span class="dsh_td_estimateBadge">Estimate</span></span><span class="dsh_td_kpiValue dsh_td_kpiValueSuccess">5.2k</span></div>
      <div class="dsh_td_kpiCard dsh_td_kpiCardSmall"><span class="dsh_td_kpiTitle">Would have repaired</span><span class="dsh_td_kpiValue dsh_td_kpiValueAccent">11</span></div>
    </div>
  </section>

  <nav class="dsh_td_tabsBar">
    <button type="button" class="dsh_td_tabItem dsh_td_tabActive">Live log <span class="dsh_td_tabCount">5</span></button>
    <button type="button" class="dsh_td_tabItem">Analytics</button>
    <button type="button" class="dsh_td_tabItem">Errors <span class="dsh_td_tabCount">9</span></button>
    <button type="button" class="dsh_td_tabItem">Rules</button>
  </nav>

  <section class="dsh_td_livePane">
    <div class="dsh_td_shadowBanner">
      <span class="dsh_td_shadowBannerLead">Shadow mode: repairs are counted, but the original arguments are still sent — nothing changes yet.</span>
      <span class="dsh_td_shadowBannerCount">11 Would have repaired</span>
    </div>
    <div class="dsh_td_toolbar">
      <span class="dsh_td_searchWrap"><input class="dsh_td_searchInput" placeholder="Search tool, category, or args…" /></span>
      <div class="dsh_td_pills">
        <button type="button" class="dsh_td_pill dsh_td_pillActive">All events <span class="dsh_td_countBadge">5</span></button>
        <button type="button" class="dsh_td_pill">Healed only <span class="dsh_td_countBadge">2</span></button>
        <button type="button" class="dsh_td_pill">Failed only <span class="dsh_td_countBadge">2</span></button>
        <button type="button" class="dsh_td_pill">Promoted only <span class="dsh_td_countBadge">1</span></button>
      </div>
    </div>
    <div class="dsh_td_tableWrap">
    <table class="dsh_td_logTable">
      <thead><tr><th>Time</th><th>Tool</th><th>Category</th><th>Status</th><th></th></tr></thead>
      <tbody>
        <tr class="dsh_td_logRow dsh_td_logRowOk">
          <td class="dsh_td_timeText">14:02:11</td><td><span class="dsh_td_badgeTool">edit</span></td>
          <td><span class="dsh_td_badgeCategory">Invalid args</span></td>
          <td><span class="dsh_td_statusPill dsh_td_statusPillOk">Healed</span></td>
          <td><button type="button" class="dsh_td_expandBtn">Diff details</button></td>
        </tr>
        <tr class="dsh_td_logRow">
          <td class="dsh_td_timeText">14:02:40</td><td><span class="dsh_td_badgeTool">run_code</span></td>
          <td><span class="dsh_td_badgeCategory">Code wrap</span></td>
          <td><span class="dsh_td_statusPill dsh_td_statusPillPass">Passed through</span></td>
          <td><button type="button" class="dsh_td_expandBtn dsh_td_expandBtnOpen">Hide details</button></td>
        </tr>
        <tr class="dsh_td_logRow dsh_td_logRowFail">
          <td class="dsh_td_timeText">14:03:02</td><td><span class="dsh_td_badgeTool">read</span></td>
          <td><span class="dsh_td_badgeCategory">Passthrough</span></td>
          <td><span class="dsh_td_statusPill dsh_td_statusPillFail">Failed</span></td>
          <td><button type="button" class="dsh_td_expandBtn">Diff details</button></td>
        </tr>
        <tr class="dsh_td_logRow">
          <td class="dsh_td_timeText">14:03:19</td><td><span class="dsh_td_badgeTool">bash</span></td>
          <td><span class="dsh_td_badgeCategory">Unknown tool</span></td>
          <td><span class="dsh_td_statusPill dsh_td_statusPillPromoted">Promoted</span></td>
          <td><button type="button" class="dsh_td_expandBtn">Diff details</button></td>
        </tr>
      </tbody>
    </table>
    </div>
  </section>

  <p class="harnessNote">Errors tab — candidate button (expanded card), stats row</p>
  <section class="dsh_td_errorsPane">
    <div class="dsh_td_errorsStats">
      <div class="dsh_td_errorsStat"><span class="dsh_td_errorsStatValue">4</span><span class="dsh_td_errorsStatLabel">Recurring patterns</span></div>
      <div class="dsh_td_errorsStat"><span class="dsh_td_errorsStatValue dsh_td_errorsStatDanger">9</span><span class="dsh_td_errorsStatLabel">Unrecovered</span></div>
      <div class="dsh_td_errorsStat"><span class="dsh_td_errorsStatValue dsh_td_errorsStatAccent">2</span><span class="dsh_td_errorsStatLabel">New-rule candidates</span></div>
      <div class="dsh_td_errorsStat"><span class="dsh_td_errorsStatValue dsh_td_errorsStatOk">1</span><span class="dsh_td_errorsStatLabel">Fixable now</span></div>
    </div>
    <div class="dsh_td_candList">
      <article class="dsh_td_candCard">
        <button type="button" class="dsh_td_candHead">
          <div class="dsh_td_candMetaCol">
            <span class="dsh_td_badgeTool">edit</span>
            <span class="dsh_td_statusPill dsh_td_verdictFix">Possible existing</span>
            <span class="dsh_td_candSig">old_string not found in file</span>
          </div>
          <div class="dsh_td_candSide">
            <span class="dsh_td_countBadge">1002 times</span>
            <span class="dsh_td_expandLabel dsh_td_expandLabelOpen">Hide sample <span class="dsh_td_chevron">▾</span></span>
          </div>
        </button>
        <div class="dsh_td_candBody">
          <p class="dsh_td_candVerdict">This keeps failing although a repair ran — the rule matched but did not resolve it.</p>
          <p class="dsh_td_watchNote">Watch: if it keeps recurring, consider tightening the rule.</p>
        </div>
      </article>
      <article class="dsh_td_candCard">
        <button type="button" class="dsh_td_candHead">
          <div class="dsh_td_candMetaCol">
            <span class="dsh_td_badgeTool">read</span>
            <span class="dsh_td_statusPill dsh_td_verdictNew">New rule candidate</span>
            <span class="dsh_td_candSig">ENOENT: no such file or directory, open '~\\notes.txt'</span>
          </div>
          <div class="dsh_td_candSide">
            <span class="dsh_td_countBadge">7 times</span>
            <span class="dsh_td_expandLabel">Show sample <span class="dsh_td_chevron">▾</span></span>
          </div>
        </button>
      </article>
    </div>
  </section>

  <p class="harnessNote">Analytics — trend from recorded events, health line, ranks</p>
  <section class="dsh_td_analyticsPane">
    <div class="dsh_td_trendCard">
      <div class="dsh_td_trendHead">
        <div class="dsh_td_cardTitle">Recent outcomes</div>
        <p class="dsh_td_kpiDesc">Repaired vs failed calls across the recorded event window.</p>
      </div>
      <div class="dsh_td_trendWrap">
        <svg class="dsh_td_trendSvg" viewBox="0 0 280 48" preserveAspectRatio="none" role="img">
          <g><rect class="dsh_td_trendBarOk" x="4" y="30" width="10" height="18" rx="1"/></g>
          <g><rect class="dsh_td_trendBarOk" x="24" y="22" width="10" height="26" rx="1"/><rect class="dsh_td_trendBarErr" x="24" y="12" width="10" height="10" rx="1"/></g>
          <g><rect class="dsh_td_trendBarOk" x="44" y="36" width="10" height="12" rx="1"/></g>
          <g><rect class="dsh_td_trendBarErr" x="64" y="38" width="10" height="10" rx="1"/></g>
          <g><rect class="dsh_td_trendBarOk" x="84" y="8" width="10" height="40" rx="1"/><rect class="dsh_td_trendBarErr" x="84" y="0" width="10" height="8" rx="1"/></g>
          <g><rect class="dsh_td_trendBarOk" x="104" y="26" width="10" height="22" rx="1"/></g>
          <g><rect class="dsh_td_trendBarErr" x="124" y="32" width="10" height="16" rx="1"/></g>
          <g><rect class="dsh_td_trendBarOk" x="144" y="18" width="10" height="30" rx="1"/></g>
          <g><rect class="dsh_td_trendBarOk" x="164" y="30" width="10" height="18" rx="1"/><rect class="dsh_td_trendBarErr" x="164" y="24" width="10" height="6" rx="1"/></g>
          <g><rect class="dsh_td_trendBarOk" x="184" y="34" width="10" height="14" rx="1"/></g>
          <g><rect class="dsh_td_trendBarErr" x="204" y="40" width="10" height="8" rx="1"/></g>
          <g><rect class="dsh_td_trendBarOk" x="224" y="16" width="10" height="32" rx="1"/></g>
        </svg>
        <div class="dsh_td_trendLegend">
          <span><span class="dsh_td_trendDot dsh_td_trendDotOk"></span>repaired</span>
          <span><span class="dsh_td_trendDot dsh_td_trendDotErr"></span>failed</span>
          <span class="dsh_td_trendSpan">13:41:02 – 14:03:19 · 38 events</span>
        </div>
        <p class="dsh_td_trendSummary">Failures increased in the recent half of this window.</p>
      </div>
    </div>
    <div class="dsh_td_healthCard">
      <div>
        <div class="dsh_td_healthTitle">Health</div>
        <p class="dsh_td_healthDesc">Working well — most anomalies are repaired before the host sees them.</p>
      </div>
    </div>
    <div class="dsh_td_rankGrid">
      <div class="dsh_td_rankCard">
        <div class="dsh_td_cardTitle">Tools by activity</div>
        <ul class="dsh_td_rankList">
          <li><span>edit</span><span class="dsh_td_barTrack"><span class="dsh_td_bar dsh_td_barAccent" style="width:80%"></span></span><span class="dsh_td_rankValue">58</span></li>
          <li><span>read</span><span class="dsh_td_barTrack"><span class="dsh_td_bar dsh_td_barAccent" style="width:52%"></span></span><span class="dsh_td_rankValue">38</span></li>
        </ul>
      </div>
      <div class="dsh_td_rankCard">
        <div class="dsh_td_cardTitle">Failures by tool</div>
        <ul class="dsh_td_rankList">
          <li><span>read</span><span class="dsh_td_barTrack"><span class="dsh_td_bar dsh_td_barErr" style="width:60%"></span></span><span class="dsh_td_rankValue">6</span></li>
        </ul>
      </div>
    </div>
  </section>

  <p class="harnessNote">Rules — paused state at its switch, disclosure detail, danger zone last</p>
  <section class="dsh_td_rulesPane">
    <div class="dsh_td_breakerBar">
      <span class="dsh_td_breakerBarTitle">Repairs temporarily paused:</span>
      <span class="dsh_td_openPill">Fuzzy edit match</span>
      <span class="dsh_td_openPill">Range clamp</span>
    </div>
    <div class="dsh_td_ruleGroup">
      <h3 class="dsh_td_ruleGroupTitle">Call repair</h3>
      <div class="dsh_td_rulesGrid">
        <article class="dsh_td_ruleCard">
          <div class="dsh_td_ruleHead">
            <div class="dsh_td_ruleNameGroup">
              <h3 class="dsh_td_ruleTitle">Schema-typed arguments</h3>
            </div>
            <button type="button" role="switch" aria-checked="true" class="dsh_td_ruleToggle dsh_td_ruleToggleOn"><span class="dsh_td_ruleToggleTrack"><span class="dsh_td_ruleToggleKnob"></span></span>Active</button>
          </div>
          <p class="dsh_td_kpiDesc">Coerces argument values to the type the tool schema declares.</p>
          <details class="dsh_td_ruleDetails">
            <summary>Recent activity</summary>
            <p class="dsh_td_ruleDetailLine">9 events</p>
            <p class="dsh_td_ruleIdLine">autoSchemaArgs · ARGS_SCHEMA</p>
          </details>
        </article>
        <article class="dsh_td_ruleCard">
          <div class="dsh_td_ruleHead">
            <div class="dsh_td_ruleNameGroup">
              <h3 class="dsh_td_ruleTitle">Fuzzy edit match</h3>
              <span class="dsh_td_pausedChip" title="This category failed its recoveries too often inside the window; retries stay paused until the circuit closes.">Repairs paused</span>
            </div>
            <button type="button" role="switch" aria-checked="false" class="dsh_td_ruleToggle"><span class="dsh_td_ruleToggleTrack"><span class="dsh_td_ruleToggleKnob"></span></span>Inactive</button>
          </div>
          <p class="dsh_td_kpiDesc">Retries a failed edit with whitespace-normalized matching.</p>
          <details class="dsh_td_ruleDetails">
            <summary>Recent activity</summary>
            <p class="dsh_td_rulePausedNote">Retries are paused after repeated failures. The rule resumes automatically once calls succeed again.</p>
            <p class="dsh_td_ruleDetailLine">14 events <span class="dsh_td_catFailed">· 5 failed</span></p>
            <p class="dsh_td_ruleIdLine">autoFuzzyEdit · FS_WHITESPACE</p>
          </details>
        </article>
      </div>
    </div>
    <div class="dsh_td_ruleGroup">
      <h3 class="dsh_td_ruleGroupTitle">Model guidance &amp; responses</h3>
      <div class="dsh_td_rulesGrid">
        <article class="dsh_td_ruleCard">
          <div class="dsh_td_ruleHead">
            <div class="dsh_td_ruleNameGroup">
              <h3 class="dsh_td_ruleTitle">Error hints</h3>
            </div>
            <button type="button" role="switch" aria-checked="true" class="dsh_td_ruleToggle dsh_td_ruleToggleOn"><span class="dsh_td_ruleToggleTrack"><span class="dsh_td_ruleToggleKnob"></span></span>Active</button>
          </div>
          <p class="dsh_td_kpiDesc">Appends a short recovery hint to tool errors the doctor could not fix.</p>
        </article>
      </div>
    </div>
    <div class="dsh_td_ruleGroup">
      <h3 class="dsh_td_ruleGroupTitle">Recording &amp; measurement</h3>
      <div class="dsh_td_rulesGrid">
        <article class="dsh_td_ruleCard">
          <div class="dsh_td_ruleHead">
            <div class="dsh_td_ruleNameGroup">
              <h3 class="dsh_td_ruleTitle">Shadow mode</h3>
            </div>
            <button type="button" role="switch" aria-checked="true" class="dsh_td_ruleToggle dsh_td_ruleToggleOn"><span class="dsh_td_ruleToggleTrack"><span class="dsh_td_ruleToggleKnob"></span></span>Active</button>
          </div>
          <p class="dsh_td_kpiDesc">Evaluates repairs and dispatches the original arguments — measures coverage.</p>
        </article>
      </div>
    </div>
    <details class="dsh_td_healthDetails">
      <summary class="dsh_td_healthSummary">Rule health by category</summary>
      <div class="dsh_td_rankCard">
        <ul>
          <li class="dsh_td_catRow"><span class="dsh_td_catName">Fuzzy edit match</span><span class="dsh_td_openPill">Paused</span><span class="dsh_td_catCounts">14 total <span class="dsh_td_catFailed">· 5 failed</span></span></li>
          <li class="dsh_td_catRow dsh_td_catRowMuted"><span class="dsh_td_catName">Path quotes</span><span class="dsh_td_catCounts">0 total</span></li>
        </ul>
      </div>
    </details>
    <div class="dsh_td_dangerZone">
      <div class="dsh_td_dangerCopy">
        <span class="dsh_td_dangerTitle">Clear records</span>
        <p class="dsh_td_kpiDesc">Deletes every recorded event and all recurring-error counts. This cannot be undone.</p>
      </div>
      <button type="button" class="dsh_td_btnGhost">Clear records</button>
    </div>
    <div class="dsh_td_dangerZone">
      <div class="dsh_td_dangerCopy">
        <span class="dsh_td_dangerTitle">Clear records</span>
      </div>
      <div class="dsh_td_dangerConfirm" role="group" aria-label="Clear records">
        <p class="dsh_td_dangerConfirmText">This deletes 146 recorded events and all recurring-error counts. It cannot be undone.</p>
        <div class="dsh_td_dangerButtons">
          <button type="button" class="dsh_td_btnGhost">Cancel</button>
          <button type="button" class="dsh_td_btnDanger">Clear everything</button>
        </div>
      </div>
    </div>
  </section>

  <p class="harnessNote">Empty state — waiting status, no age line</p>
  <div class="dsh_td_container">
    <div class="dsh_td_outcomeCard" data-state="waiting">
      <div class="dsh_td_outcomeStatus">
        <span class="dsh_td_statusDot dsh_td_statusDotWaiting" aria-hidden="true"></span>
        <div class="dsh_td_statusCopy">
          <span class="dsh_td_statusHeadline">Waiting for tool calls</span>
          <span class="dsh_td_statusReason">The doctor starts reporting as soon as the agent calls tools.</span>
          <span class="dsh_td_statusMeta"></span>
        </div>
      </div>
      <div class="dsh_td_outcomeEvidence">
        <div class="dsh_td_outcomePrimary">
          <span class="dsh_td_outcomeValue">0</span>
          <span class="dsh_td_outcomeCaption">calls repaired</span>
          <span class="dsh_td_outcomeRateRow">
            <span class="dsh_td_kpiMeter"><span class="dsh_td_kpiMeterFill" style="width:0%"></span></span>
            <span class="dsh_td_kpiDesc">0% of repair attempts succeeded.</span>
          </span>
        </div>
        <div class="dsh_td_outcomeSplit">
          <div class="dsh_td_outcomeSplitItem"><span class="dsh_td_outcomeSplitValue">0</span><span class="dsh_td_outcomeSplitLabel">calls still failing</span></div>
        </div>
      </div>
    </div>
    <div class="dsh_td_kpiGrid">
      <div class="dsh_td_kpiCard dsh_td_kpiCardSmall"><span class="dsh_td_kpiTitle">Calls checked</span><span class="dsh_td_kpiValue">0</span></div>
      <div class="dsh_td_kpiCard dsh_td_kpiCardSmall"><span class="dsh_td_kpiTitle">Promoted calls</span><span class="dsh_td_kpiValue">0</span></div>
    </div>
    <div class="dsh_td_emptyState">
      <div class="dsh_td_emptyTitle">No records yet</div>
      <p class="dsh_td_emptyDesc">When the agent calls tools, interception and repair details appear here in real time.</p>
    </div>
  </div>

</main>
</body>
</html>
`;

writeFileSync(out, html, "utf8");
console.log(`Harness written: ${out} (${html.length} bytes)`);

# Changelog — dsh-tool-doctor

## Unreleased (2026-11-14)

- **Nested recovery now dispatches through the host's batch API (it was
  failing silently before).** Live records showed every range/edit/name retry
  ending in "retry still failed (Tool batch execution failed) — original
  error kept": the do-no-harm path kept the model's error honest, but the
  nested dispatch itself never succeeded. Root cause, read from the installed
  host: `ToolsService` exposes exactly one `execute`, and it is a BATCH —
  `execute(input: ToolBatchInput): Promise<ToolBatchResult>` with
  `ToolBatchInput = { calls: ToolCallBlock[]; signal; agent? }` and each
  `ToolCallBlock = { type:"tool-call", id, name, arguments: string }` (raw
  JSON). The doctor had been calling it with a single `{ name, arguments }`
  execution, so `executeToolBatch` did `const { calls } = input; calls.map(...)`
  on `undefined`, threw, and the runner rewrapped it as `ToolBatchExecutionError`
  ("Tool batch execution failed"). `recovery/nested-dispatch.ts` now sends the
  correct single-call batch and unwraps `results[0]` as the recovery outcome;
  a batch that settles no result is an explicit recovery failure. The execution
  token is no longer required (the batch contract never used it). All test
  fakes were converted to the batch shape via a shared `batchTools` helper; the
  `arguments`/`results` round-trip is now exercised end to end. This is the
  change that lets nested heals actually land — before it, every one fell back
  to do-no-harm. Suite: 432 green.

- **Adoption now carries the child's whole outcome, and recovery dispatches
  carry the step's admission.** Audited every stage claim against the host
  contract after the batch fix. (1) The host delivers a batch's deferred
  contexts and turn-conclusion beside `results`, not inside a settled result —
  the unwrap dropped them, so a bridged call whose module promises "full
  context and terminal state" silently lost both. `executeNestedTool` now
  folds `additionalContexts` and `concluded` (never onto a failure) into the
  adopted result. (2) The host resolves conditional registrations — MCP tools
  among them — ONLY with the step's admitted `toolSet`, which the doctor never
  read or forwarded: the visibility probes (`tools.get`, the `tools.schemas`
  candidate enumeration behind TOOL_NAME / kind fixes) and the nested batch
  itself now pass the execution's `toolSet` through, exactly as the host's own
  declarations expose it. Tests: the batch-shape test pins `toolSet`
  forwarding; adoption pins context/conclusion carry and the
  never-conclude-on-a-failure rule. Suite: 434 green.

- **A heal can no longer be swallowed by the host's serialization gate.** The
  live pass caught a clamped read-offset retry whose repaired result came back
  as the bare host error "tool result must be losslessly JSON-serializable",
  hiding both the original error and the repair. Root cause: the host snapshots
  every settled result through a lossless-JSON walker that rejects class
  instances — and the doctor's own `recoveryFailure()` attaches the live
  `Error` as `error`, so the projection threw and replaced the WHOLE payload.
  Two fixes, both inside the doctor. (1) `projectForHost()` in `core/result.ts`
  mirrors the host's walker (`isPlainJsonValue`) and runs at the `tools/execute`
  boundary: plain results pass untouched; otherwise model-visible `content` is
  kept (text fallback only if content itself is unprojectable) and lossy
  `error`/`meta`/`additionalContexts` are dropped or reduced to their plain
  `{code, message}` identity — `resultHasCode` still matches. Records are
  stashed before the boundary, so nothing is lost to the log. (2) The range
  stage now applies do-no-harm: a retry that still fails never replaces the
  original error — the model keeps the message naming the bound it can act on,
  while the record honestly stays repaired-but-failed. Same pass also closed
  the observed gap that schema-capping rejections (`limit must be less than or
  equal to 2000`, which no clamp shape matched) are now retried at the stated
  cap (`argMaxFromError`). New tests: `range-retry.spec.ts` (14 — both error
  shapes, retry args, do-no-harm incl. two through the full pipeline) and
  `result-projection.spec.ts` (9 — the walker rules, the identity-preserving
  swaps, double-projection safety). Suite: 430 green.

- **Factory guidance rewritten to "## Reliable tool calls".** The prompt
  contribution now leads with host-structured tool calls (no simulated tags
  in response text), exact names and schemas (description only where the
  schema requires one), and dependency-ordered awaits with cause-first
  retries. The Code-Mode and grep rules stay CONDITIONAL IN WORDING ("If
  Code-Mode exposes run_code…", "If using grep's default ripgrep regex…")
  because the section is shared and KV-cache-stable — no per-session tool
  detection was added (none verified on the host API). Heading and text
  replaced verbatim; exported constants, mutable guidance functions,
  registration order (400), and dashboard edit/reset behavior unchanged.
  New `tests/prompt-guidance.spec.ts` pins the behaviors, not the copy: the
  default appears through `getGuidanceText()`, edits stick (whitespace can't
  wipe them), reset restores, and the injectPrompt toggle empties/restores
  the section per assemble without re-registration.

- **A restored snapshot is checked, not trusted.** On open, the store
  restores saved stats while `status` is still "idle" — so before the first
  live refresh resolved, the card could wear a green "Working normally" (or
  "Needs attention") earned by an UNVERIFIED saved snapshot, with no age
  line to say so. A neutral "checking" state now covers exactly that window
  (`status === "idle"` + saved data + nothing failed yet): headline
  "Checking current status", reason labeling the numbers as the last saved
  snapshot, no action button on unverified data. A health state appears only
  after a successful stats load; if that first load fails, `statsStale`
  takes over and the card reads "Showing saved data" — never an endless
  check. Two rendered tests pin the neutral headline and the fail-over to
  stale. 405 tests green.

- **Stats freshness got its own flag.** The stale card keyed on
  `state.error.source === "stats"`, but `error` is one shared transient
  slot: a config or guidance request completing successfully right after a
  failed stats refresh (both run alongside it, and both patch `error: null`
  on success) erased the failure and flipped the card back to "Working
  normally" without a single successful stats load. The store now tracks
  `statsStale` itself — set only when a stats load fails, cleared only by a
  successful stats load or reset — and the card reads that. Two store tests
  pin the scenario (stats fails → config succeeds: error slot empties, the
  stale claim stands → stats succeeds: recovered) and the rendered test now
  seeds `statsStale` with an empty error slot. 403 tests green.

- **Design-pass corrections: the status never overstates what it knows.**
  (1) A snapshot the API could not refresh no longer claims health: the card
  switches to an amber "Showing saved data" state (reason + the retained
  numbers kept beneath as saved evidence) instead of a green headline next
  to "Connection lost". (2) The lifetime split is honestly labeled "calls
  that failed" with the reason "N calls failed and were not repaired." —
  cumulative counts are no longer phrased as a present-tense condition.
  (3) Breaker copy now matches `breaker.ts` reality: the circuit reopens
  when failures age out of its window, so both the status card and the rule
  note say retries resume "automatically after a cooldown", not "when calls
  succeed again". (4) Narrow panels: the supporting metric cards pair into
  a two-column grid under 720 px, bringing the live log into view sooner.
  New rendered test pins the stale headline and label; harness mirrored and
  re-verified at 460 px dark (amber accent, 2×2 grid, no overflow).

- **Design pass: answer "Is Tool Doctor working, and do I need to do
  anything?" first (design recommendations 1–7).** (1) The outcome card now
  LEADS with a plain-language status — Working normally / Needs attention /
  Repairs temporarily paused / Waiting for tool calls — derived in honest
  severity order (paused breakers > still-failing calls > clean log > empty),
  with one short reason and one relevant action; the repaired count and rate
  stay as evidence beneath. (2) Stale data is unmistakable: the store tracks
  `lastUpdated`, the card shows "Updated N min ago" (bucketed, 30 s
  heartbeat), and a failed refresh over retained data says "Connection lost —
  showing saved data." (3) "Clear records" left the header for a quiet danger
  zone at the bottom of the rules, confirming by naming exactly how many
  events and counts go away (irreversible). (4) Main view speaks user
  language: "calls repaired", "calls that failed" (one honest split =
  Errors-tab number), "Calls checked", "Would have repaired"; shadow/breaker/
  candidate/rule ids moved into expanded details. (5) The trend now names its
  span and event count and adds a directional sentence only when ≥4 failures
  support it ("Failures increased in the recent half…", else an honest
  "too few to judge"). (6) Smallest explanatory text raised to 12 px and
  dim/muted tokens strengthened in both themes; state still pairs color with
  words and symbols. (7) Rules read as settings: paused rules carry a chip at
  their OWN switch plus a "Recent activity" disclosure (events, failures,
  last fired, flag + category ids), and the full per-category health table
  sits behind a disclosure. New pure-function and rendered-component tests
  pin the status derivation, age bucketing, trend direction, per-rule paused
  chip, and clear-records placement; harness re-verified programmatically at
  1280/460 px light/dark with no overflow.

- **Round-6 corrections: trend counts by outcome, lone events, candidate
  id.** (1) The Analytics trend no longer hides real failures during shadow
  mode: bars are filled BY OUTCOME, so a shadow failure (the original call
  really failed) lands in the failed bar, while a shadow match can still
  never count as a repair. (2) A lone record — or several sharing one
  timestamp — now renders its events in one bucket instead of an empty
  trend chart. (3) Candidate DOM ids: `candidateDomId` percent-encodes the
  tool+signature key, so `aria-controls` stays a single whitespace-free
  id token instead of an accidental token list. All three are pinned by
  new rendered-component tests (`tests/client-component.spec.tsx`,
  react-dom/server through the real `DoctorSection`/`OutcomeTrend`, state
  seeded via a fake controller snapshot).

- **Visual pass on truthful numbers (reviewer layout brief).** Overview now
  has one prominent outcome card (actual repairs leading, with failed
  repairs and unrecovered failures as honest split stats and the rate meter)
  and a smaller supporting tier (intercepted, promoted, saved tokens,
  would-repair). The live log gains a dashed shadow-mode banner whenever
  shadow is active; log rows carry `aria-expanded`/`aria-controls`, and
  candidate headers are real `<button>`s now — fully keyboard-operable with
  one focus-visible ring across the panel. Analytics opens with a small
  time trend of ACTUAL outcomes (stacked repaired/failed buckets computed
  from the recorded events, shadow matches excluded). The Rules tab groups
  all 13 toggles by purpose (Call repair / Model guidance / Recording) —
  a mirror test pins the partition — and paused circuit breakers now lead
  the tab. Narrow panels: the log table scrolls within its own wrapper
  instead of widening the page. Verified via `scripts/visual-harness.mjs`:
  real compiled CSS + mirrored markup, checked programmatically at 1280
  and 460 px in light and dark, incl. empty, shadow and breaker-open
  states — no overflow, correct theme token swaps.

- **Unambiguous numbers: five dashboard-metric corrections (reviewer
  priorities 1–5).** (1) Promoted calls get their own status pill and filter
  chip — the live log no longer labels them "Passed through". (2) Shadow
  mode is honest: a would-repair match counts in a new `shadowMatches`
  total and the untouched call lands in pass-through buckets — never in
  healed success/failure, token savings, or the healing rate; the Overview
  shows a "Would repair (shadow)" card when shadow is on, and the counter
  persists and replays with the same identity rules. (3) The "Unrecovered
  errors" KPI now reads `healedFailed + passThroughFailed` — the same
  total the Errors tab shows. (4) Recurring-error counts survive history
  scrolling: the tracker maintains per-signature aggregates fed by EVERY
  failure (bounded 200-pattern map, least-recently-seen eviction), rebuilt
  from the full JSONL replay on restore; `/candidates` serves from them,
  the client prefers them over its window-bound local grouping, and both
  paths judge through one shared `candidatesFromAggregates` (deep-equal
  pinned). (5) Polling is single-flight — a slow response never piles up
  or overwrites newer data — and pauses while the panel is hidden, with an
  immediate refresh on return to view.

- **Reviewer round (4th): home containment resolves the cwd string first.**
  Containment ran on the RAW cwd, so `C:\Users\Srini\project\..\..\elsewhere`
  — which resolves OUTSIDE the home — still passed and expanded `~`. The
  comparison now runs on segment-normalized paths: separators unified, `.`
  dropped, `..` collapsed with root protection (drive letter / POSIX `/` /
  UNC share never pop). The doc block records the honest limits: collapse is
  text-level (no symlink resolution), and a remote session can report a path
  identical to the local home — certainty needs a host-provided session home
  or an explicit local-session signal, not a better string heuristic.

- **Reviewer round (3rd): tilde home-trust strengthened from style-match to
  containment.** Matching path styles only proved the same OS, not a shared
  home — a same-OS remote session could still have `~` expand to the plugin
  machine's directory. `~` now expands only when the session cwd IS the
  known home or sits UNDER it (separator-boundary check, not a string
  prefix); every other world — same-OS remote, cross-platform, cwd unknown
  — leaves `~` untouched for the tool to resolve honestly.

- **Reviewer round (2nd): five correctness fixes, each with a pinning
  regression test.** (1) Trailing-comma stripping in the argument-JSON
  recovery is now a string-aware scanner — `{"text":"x,}","count":1,}`
  keeps its string content (the old regex corrupted it to `x}`).
  (2) A string value under a union schema that admits `"string"` is
  preserved (`"42"` no longer rewrites to `42` under
  `["string","number"]`); the null-sentinel convention for nullable
  unions still applies. (3) `~` expansion only happens when the plugin
  process's home matches the session world's path style — a Windows
  harness driving a POSIX session now leaves `~/notes` untouched instead
  of rewriting it into the plugin user's directory. (4) Integer/number
  coercion requires `Number.isSafeInteger` — `9007199254740993` is left
  as a string rather than silently landing on `…992`. (5) Preview
  redaction covers non-string JSON values: `{"password":12345678}` is
  masked like any other secret (and `preview.ts` gained its first test
  suite).

- **Guarded client mirror**: the dashboard's taxonomy tables and
  candidate-fix logic moved from `DoctorSection.tsx` to
  `src/client/mirror.ts` (pure, React-free), typed as `Record` over
  `HealCategory`/`ConfigFlag` (missing entries = compile error), and pinned
  against the server originals by `tests/client-mirror.spec.ts` — labels
  (one derivation rule: server label minus the "(CATEGORY)" suffix),
  category order, rule/flag tables in registry order, hint patterns, and
  behavioral parity of `proposeFix`/`fixEligible`/`hintRule`/
  `normalizeErrorSignature`. The guard immediately caught real drift:
  ARGS_UNWRAP/ARGS_TYPE/PATH_SEPARATORS/KIND_CORRECTION label wording and
  rule 1's flag order (which decides which toggle a fix proposal names).

New healing rules, informed by the tool-failure literature (parameter-failure
taxonomies, verify-before-retry, tiered scope-limited recovery):

- **Rule 9 — schema-shaped arguments (`autoSchemaArgs`)**: `ARGS_UNWRAP`
  repairs payloads replayed as JSON strings (staged recovery: fences, prose
  slices, trailing commas, double-encoding) and one-key wrapper nesting;
  `ARGS_TYPE` coerces string values to the type the tool's own schema
  declares (number/integer/boolean/array/object, enum case/separator drift,
  null sentinels). Only unambiguous, parse-proven rewrites are adopted.
- **Rule 3 extension — path separators (`autoNormalizePaths`)**: tilde
  expansion and Windows↔POSIX separator normalization, host style derived
  from the session cwd (not `process.platform`).
- **Rule 4 extension — whitespace-tolerant edit (`autoFuzzyEdit`)**: on
  `old_string` not-found, retries once per whitespace-equivalent anchor
  spelling (CRLF↔LF, tab↔4-space flips); the host stays the match authority.
- **Rule 2 extension — tool-name canonicalization (under
  `autoBridgeDirectTools`)**: residual UNKNOWN_TOOL calls are retried under
  a registered name when the host's `tools.schemas()` enumeration yields
  EXACTLY ONE case- or namespace-affix match (`bash` ↔ `mcp__shell__bash`);
  ambiguity stands. New `core/tool-names.ts` is the single guarded call site.
- **Rule 10 — directory kind correction (`autoKindFixes`)**: a file-reader
  error on a directory ("not a regular file"/EISDIR) is re-dispatched to a
  listing tool the agent's plane actually offers, with arguments built from
  that tool's own definition. (The write-to-missing-directory twin needs no
  repair: the host's write already creates parent directories — probed.)
- **Truncation hint**: because the stop reason never reaches a plugin's tool
  plane (verified against the installed host), a cut-mid-token argument
  shape — not a claimed cause — appends one honest hint (`errorHints`).
- New categories `ARGS_UNWRAP`, `ARGS_TYPE`, `PATH_SEPARATORS`,
  `EDIT_WHITESPACE`, `TOOL_NAME`, `KIND_CORRECTION`; the client mirrors,
  locales, and `error-signatures` rule hints updated to match. Registry:
  16 stages (9 pre, 7 post), 20 categories, 13 toggles.

Review fixes for the response-side healing path (R1-R7):

- **R1** Sensitive values in argument previews are redacted before persistence or dashboard exposure; the 180-char cap is no longer treated as redaction (`support/preview.ts`).
- **R2** `[ARGS]` (pattern 5) is now a heal signal, so bare `name[ARGS]{...}` calls reach the parser in the stream hook; covered by an end-to-end `healTextBlock` test.
- **R3** Glued sibling bodies inside one marker are each promoted as their own call instead of only the last body surviving span coverage.
- **R4** Promoted tool-call ids use a per-stream nonce prefix plus a per-stream sequence, so they never collide across text blocks or with native `call_*` ids.
- **R5** The relaxed JSON fallback is now token-aware: Python literals (`None`/`True`/`False`) and unquoted keys are handled without rewriting literal text inside string values.
- **R6** Promotion success is tracked as its own `promoted` status/counter (server stats, persisted summary, dashboard KPI) instead of inflating healed-success before any execution outcome exists.
- **R7** Dashboard request bodies are capped at 10 MiB with proper error handling: over-limit -> 413, stream errors -> 500, runaway payloads destroyed; both call sites catch read failures.

## 1.0.0 (2026-11-13)

Ground-up rewrite of `dsh-tool-healer` as a new plugin with a clean architecture.
Replaces the healer's ~1,500-line god-file (`index.ts`) with small, self-contained
modules; every repair rule is now a stage in one registry.

### Architecture

- **`src/core/`** — pipeline engine: `pipeline.ts` (dispatch wrapper over the
  stage registry), `stage.ts` (`HealStage` / pre/post contracts + type guards),
  `breaker.ts` (per-category retry circuit breaker), `preview.ts`, `result.ts`,
  `util.ts`.
- **`src/stages/`** — the single source of truth. Each rule is one self-contained
  file (gate + mechanic + metadata) appended to `STAGES`; `PRE_STAGES`,
  `POST_STAGES`, `CATEGORY_META`, and the dashboard's `CATEGORY_LABELS` all derive
  from that array, so a new tracker category surfaces as a missing key instead of
  silently dropping.
  - Pre-dispatch: `run-code`, `editor-range`, `read-args`, `path-scope`,
    `path-quotes`, `mnemon-result`.
  - Post-dispatch: `bridge` (UNKNOWN_TOOL), `observe-retry` (FS_OBSERVED),
    `anchor-refresh`, `range-retry` (RANGE_CLAMP).
- **`src/repair/`** — pure repair mechanics: `run-code.ts`, `run-code-syntax.ts`
  (multi-stage syntax healing with its own lexer, `lexer.ts`),
  `inner-description.ts`, `path-arg-quotes.ts`, `range-clamper.ts`,
  `source-path-scope.ts`, `mnemon-result-schema.ts`.
- **`src/recovery/`** — nested-dispatch re-entry (`nested-dispatch.ts`) and the
  direct-tool bridge (`direct-bridge.ts`).
- **`src/support/`** — host-boundary services: `tracker.ts`, `stats-log.ts`
  (JSONL event log + summary), `config-overrides.ts` (durable DSH_HOME toggles
  merged over the cordis patch config at startup), `prompt.ts`,
  `error-signatures.ts`, `tool-healing.ts` (response-side text→tool-call
  promotion, ported from Unsloth Studio).
- **`src/client/`** — Tool Doctor dashboard section (`DoctorSection.tsx`) with
  scoped CSS module, English locale, and a store that persists stats.

### Behavior carried over from dsh-tool-healer v0.6.x

All pre-dispatch repair rules (run_code wrapping/description/syntax, editor range
clamping, read-args normalization, path scoping + quoting, mnemon result schema),
all post-dispatch recovery retries (unknown-tool bridge, observe-and-retry,
range retry with clamping), the response-side healing parser with its five data
guards (G1 think blocks — `think` / `thinking` / `[THINK]`, G2 code fences,
G3 inline-code tag mentions, G4 marker coverage tiling, G5 execution-class bare
names), prompt guidance injection, error hints, and the stats/trace pipeline.

### Identity

- Plugin id / row: `tool-doctor`; bundle name `dsh-tool-doctor`.
- Config overrides file: `<DSH_HOME>/tool-doctor-config.json`.
- Event log + summary under DSH_HOME (doctor-named files).
- `package.json` keywords keep `tool-healer` and `tool-normalizer` for search
  discoverability.

### Build & verification

- `npm run check` = typecheck (`tsc --noEmit`) + tests (`vitest`, 160/160) +
  build (`node scripts/build.mjs`).
- The build cleans `lib/` first (esbuild never deletes stale files), then emits
  exactly: `lib/index.js` (ESM host bundle), `lib/client.js` (CJS browser bundle
  with ModuleLoader wrapper + scoped CSS module inlining, validated by
  `scripts/css-guard.mjs`), and hand-written type declarations under
  `lib/types/`.

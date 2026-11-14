# Changelog — dsh-tool-doctor

## Unreleased (2026-11-14)

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

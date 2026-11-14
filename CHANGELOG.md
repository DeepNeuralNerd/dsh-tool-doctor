# Changelog — dsh-tool-doctor

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

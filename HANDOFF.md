# Handoff — dsh-tool-doctor: second-round review fixes (R1–R7 acceptance)

**Date:** 2026-11-14 · **Branch:** `main` @ `6076589` · **State:** source fixes applied, uncommitted; tests + check + changelog outstanding.

## Context
A read-only review of commit `6076589` ("Fix review items R1–R7 in response-side healing") returned four findings that must all be fixed before R1–R7 is accepted:

| # | Sev | Finding | Fix status |
|---|-----|---------|-----------|
| 1 | P1 | Quoted examples become real tool calls — pattern-5 (bare `[ARGS]`) path lacked the G3 backtick guard, so `` `read[ARGS]{...}` `` in inline code was promoted. | ✅ applied |
| 2 | P1 | R1 still exposed common secrets — `api_key` splits into segments `api`+`key`, neither in the secret-key set; no command-flag redaction existed (`--password plain-secret-value` survived). Previews are persisted to JSONL + dashboard. | ✅ applied |
| 3 | P2 | R5 broke single-quoted relaxed JSON — `readString` started on the opening quote and immediately treated it as closing → returned `["", true]`; single-quoted tool-call bodies no longer promoted (reviewer reproduced). | ✅ applied |
| 4 | P2 | R7 measured characters, not bytes — cap checked `body.length`, so multibyte UTF-8 could exceed 10 MiB while passing. | ✅ applied |

## What was changed (all uncommitted)

### 1. G3 guard on pattern-5 — `src/support/tool-healing.ts`
In the bare-bracket loop (~line 697), added after the G2 guard:
```ts
if (inSpan(m.index, tmSpans)) continue; // G3
```
Same idiom as pattern-4. `tmSpans` (single-backtick inline-code spans) was already in scope.

### 2. Secret redaction — `src/core/preview.ts`
- Added `"key"` to `SECRET_KEY_SEGMENTS` (line 30). Segment-based matching, so `api_key` → segments `["api","key"]` now matches; single-segment words like `keyboard` are unaffected.
- New flag-value redaction (lines 66–77):
```ts
const FLAG_VALUE_RE = /(^|\s)(-{1,2}[A-Za-z][\w.-]*)([= ])([^\s"',;)\]}>]+)/g;
function isSecretFlag(flag: string): boolean { /* strip dashes, lowercase, segment-check */ }
```
- Wired into `redactSensitive` right after the JSON-pair replacement (lines 92–96). Value char class stops at quotes/brackets so JSON structure isn't broken.
- `compactPreview` calls `redactSensitive` before truncation, so persisted previews are covered automatically — no other call-site changes needed.

### 3. Single-quote relaxed JSON — `src/support/tool-healing.ts`
Top of `readString(quote)` (~line 204):
```ts
i++; // Consume the opening quote before scanning for its close.
```
All callers position `i` ON the opening quote, so this one fix covers single-quoted keys AND values (and double-quoted strings).

### 4. Byte-based body cap — `src/index.ts`
Rewrote `readBody` (~lines 794–835):
- Accumulates `Buffer[]`, counts `buf.byteLength` against `MAX_BODY_BYTES` (`10 * 1024 * 1024`, line 784).
- Decodes once at the end: `Buffer.concat(chunks).toString("utf8")` — a code point split across chunk boundaries decodes correctly.
- On limit hit: rejects `BodySizeError` **without destroying the socket** and stops buffering (settled flag discards later chunks). The caller writes 413 first; `res.end()` then closes a connection whose request was never fully consumed, so the client still receives the intended 413.
- Both call sites (guidance PUT ~line 445, config POST ~line 481) already route through `.catch((e) => respondReadError(res, e))` — no caller changes.
- Added at end of file: `export { readBody, BodySizeError };` for tests.

## Remaining work (in order)

### A. Regression tests
**`tests/tool-healing.spec.ts`** (imports use explicit `.ts`; local helper `allow(...names): Set<string>` exists; reuse it):
1. Parse-level G3 backtick `[ARGS]` guard — insert after the existing "G3: skips a lone tag in backticks" test (~line 209). Use a **valid JSON body** so the test proves the guard, not parser failure:
   ```ts
   const text = 'Use `read[ARGS]{"file_path":"/a"}` as an example.'; // real backticks around the marker
   expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(0);
   ```
2. Stream-level case — inside `describe("healTextBlock — stream-hook transform (R2/R4)")` at end of file:
   ```ts
   expect(healTextBlock('Use `read[ARGS]{"file_path":"/a"}` as an example.', allow("read"), "heal_test")).toBeNull();
   ```
3. Single-quoted keys AND values (R5) — after the existing R5 regression test (~line 131):
   ```ts
   const calls = parseToolCallsFromText("Calling read[ARGS]{'file_path': '/a.txt'}", allow("read"));
   expect(calls.length).toBe(1);
   expect(JSON.parse(calls[0].arguments)).toEqual({ file_path: "/a.txt" });
   ```

**NEW `tests/preview.spec.ts`** (import from `"../src/core/preview.ts"`):
- JSON key spellings redacted in previews: `api_key`, `apiKey`, `API_KEY`, `password`, `passwd`, `token`, `access_token`, `client_secret`, `authorization`, `cookie`, `session_id`.
- Reviewer's exact repro: `compactPreview('{"api_key":"plain-secret-value"}')` must not contain `plain-secret-value`.
- Flag redaction: `'curl --password plain-secret-value https://x'` → contains `--password [redacted]`, no raw value; also a leading `-token=abc123` case.
- Negative: non-sensitive flags untouched, e.g. `--output out.txt` stays as-is.

**NEW `tests/body-limit.spec.ts`** (import `{ readBody, BodySizeError }` from `"../src/index.ts"`):
- Unit with a fake stream (`{ on(event, cb) }`, e.g. an EventEmitter subclass):
  - Multibyte: emit `Buffer.from("é".repeat(6_000_000), "utf8")` (12 MB bytes / 6M chars — old char-count code would have passed it) in **two chunks** to cover accumulation → rejects with `BodySizeError`.
  - UTF-8 split across chunk boundary: emit `[0xC3]` then `[0xA9]` + end → resolves `"é"`.
  - Small ASCII body under cap → resolves exact string.
- Integration (reviewer's explicit verification point): real `node:http` server whose handler does `readBody(req).then(body => res 200 JSON {len}).catch(e => e instanceof BodySizeError ? res 413 : res 500)` + global `fetch`:
  - Small POST → **200**.
  - Oversized multibyte POST (e.g. `"é".repeat(6_000_000)`) → **client receives 413** (proves no socket destroy before the response).

### B. Full check
`npm run check` in the plugin root = `tsc --noEmit` + vitest + `node scripts/build.mjs`. Was green at 167/167 before this round; new tests raise the count. Must be fully green (build cleans and re-emits `lib/index.js` ESM + `lib/client.js`).

### C. CHANGELOG
Add an entry under the unreleased section for the four second-round fixes (G3 on `[ARGS]`, preview key/flag redaction, single-quote relaxed JSON, byte-based 10 MiB cap with client-visible 413).

### D. Commit
Local commit on `main` only. **Never push/publish to GitHub without explicit user instruction.**

## Conventions & gotchas
- Vitest specs import sources with the explicit `.ts` extension (`from "../src/support/tool-healing.ts"`).
- `healTextBlock(text, enabledToolNames?, idPrefix = "call", idStart = 0)` is the exact transform the stream hook applies — "stream-level" tests go through this seam, not by mocking ctx.
- Pattern-5 span semantics: the tool name is part of the marker (`read[ARGS]{...}`) and strips with it; stripped prose may contain a double space (e.g. `"Calling  now."`).
- G3 guard tests must use valid JSON after `[ARGS]` so they prove the backtick guard, not parser failure.
- Harness quirk: think-family tags like `<thinking>` get silently sanitized out of tool-call arguments and file contents — build such content via char codes (pwsh `[char]60/[char]62`) if a test needs them.
- `promoted` is its own stats bucket (kept out of healedSuccess/healedFailed); `PersistedAggregate.promoted?` is optional so old summaries load at 0 — unchanged this round, but don't regress it.

## Key locations
| File | What / where |
|------|--------------|
| Plugin root | `C:\Users\Srini\Documents\deepseek-harness\default-workspace\dsh-tool-doctor` |
| `src/support/tool-healing.ts` | `readString` ~line 203 (fix in); pattern-5 loop ~lines 690–701 (G3 now present); `healTextBlock` ~line 745; `RE_INLINE_CODE` line 94 |
| `src/core/preview.ts` | `SECRET_KEY_SEGMENTS` lines 22–39 (`"key"` at 30); `FLAG_VALUE_RE`/`isSecretFlag` lines 66–77; `redactSensitive` lines 85–104; `compactPreview` lines 114–123 |
| `src/index.ts` | `MAX_BODY_BYTES` line 784; `BodySizeError` lines 786–791; `readBody` ~lines 794–835 (Buffer-based); named exports at end of file |
| `tests/tool-healing.spec.ts` | R5 tests ~115–131; G3 test ~209–212; healTextBlock describe lines 256–293 (end of file) |

## Definition of done for this round
All four findings fixed **and** covered by the regression tests above, `npm run check` green, CHANGELOG updated, local commit made. Reviewer's acceptance criterion: all four findings resolved before R1–R7 is accepted.

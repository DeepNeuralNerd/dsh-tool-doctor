# Changelog

All notable changes to **Tool doctor** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [semantic versioning](https://semver.org/).

## [1.1.0] — 2026-11-14

### Changed

- **Shipped rule tables stay host-neutral (publication decision).** The
  alias table and the path-quote tool family each carried one entry for a
  single host's MCP vision bridge (`modlens_read_image`) — a rule promoted
  from one operator's usage, not a research class. Published defaults now
  cover research-backed failure classes on DSH built-in tools only; site
  tools are each installation's own promotion. Tests repurposed to pin the
  boundary.

### Added

- **README "The rules" table.** Every dashboard rule documented publicly
  with what it does and the justification that admits it — published
  failure class, deterministic host contract, or standard — linking the
  research corpus and review record. Titles and flags match the dashboard.

- **`$ref`-declared properties get the narrowest coercion (rule 9 family 1).**
  A vLLM serving-stack report reproduces nested objects arriving as JSON
  strings exactly when the property uses `$ref` (the inline equivalent
  works); the plugin's schema reader previously ignored `$ref` entirely, so
  those properties were invisible to type coercion. A property declared ONLY
  via a local, acyclic `$ref` now coerces string→object/array — whole-value
  strict parse, duplicate-member-name guard included, no number/bool/enum
  coercion ever activated through a pointer. Insurance by construction: no
  built-in DSH tool uses `$ref`; the class arrives with MCP-served schemas.
  Fifteen tests added.

- **Promotion duplicate guard: a native call vetoes its text twin.** The
  Qwen3 parser report's duplicate-call class: a message carrying both a
  structured tool-call and the same call emitted as markup text used to
  dispatch twice. The stream hook now records native call identities
  (name + canonical key-sorted arguments) across the whole message and
  drops promoted twins at stream end — suppression works in either order;
  the stripped text still re-emits at its original position. Six tests.

- **Guard G6: example-bracketed markup stays text.** Quoted or parenthesized
  samples of tool-call markup in prose ("…`<function=read>…`…" class,
  Qwen3 parser report) are no longer promoted — both an example opener
  directly before AND a closer directly after must match; one-sided
  punctuation never suppresses a real call. Eight parser tests.

- **Ambiguous-payload guard: duplicate JSON member names are never adopted.**
  RFC 8259 §4 warns that repeated names produce unpredictable interoperability
  behavior; `JSON.parse` resolves them silently (last value wins), so a
  stringified payload like `{"file_path":"safe.txt","file_path":"other.txt"}`
  could be adopted by the args-JSON ladder while silently selecting a
  different target than the model intended. The stringified-args repair now
  scans every candidate JSON text before adopting it and abstains on any
  duplicate name at any object level — the payload passes through unrepaired.
  Found in the 2026-11-14 reviewer-model pass. Six tests added.

- **Canonical parameter rename (PARAM_ALIAS, rule-9 family, stage 17).** The
  parameter-filling taxonomies (arXiv 2507.15296; TALLM failure taxonomy,
  UW/AST 2025) rank parameter-NAME hallucination — `filename` for `file_path`,
  `regex` for `pattern` — among the top argument failure classes, and this
  host rejects the invented key outright. The new pre-dispatch stage renames a
  single unambiguous alias to the name the tool's OWN schema declares, gated
  by `autoSchemaArgs` alongside the other schema-aware repairs; ambiguity,
  missing schema, and unknown tools always pass through. Curated tables for
  read/write/edit/glob/grep/read_image/modlens_read_image. Eleven tests added.

### Changed

- **Path-quote unwrap is Windows-shaped only (review follow-up).** The
  absolute-path gate no longer fires on unix-root paths: the safety rationale
  ("no file name may contain a quote character") is a Windows rule — POSIX
  file names may legitimately contain quotes, so unwrapping `"/tmp/data.txt"`
  could change a file's identity rather than restore it, and this host's file
  tools never receive unix-root paths. One regression test added.

- **Path-quote unwrap now accepts matching curly pairs (“…”, ‘…’).** The
  production literature (OpenClaw's malformed-argument recovery) names
  smart-quoted arguments as a top emission class; this host only tolerates
  curly quotes on `read`/`write`/`edit` paths, so `glob`, `grep`, `read_image`
  and `modlens_read_image` now get the same heal. Mixed pairs still pass
  through; five tests added.

- **Whitespace edit-retry now strips trailing whitespace (rule 4).** Live probing
  found the one shape the generator abstained on: an `old_string` carrying
  per-line trailing spaces/tabs the file never had — a common emission artifact
  when a model copies an anchor with editor markers intact. `editAnchorVariants`
  gained a third spelling-equivalent variant (per-line trailing-whitespace
  strip, whitespace-only anchors left unvaried, the two-retry cap unchanged —
  the host remains the match authority). Five tests added (442 passing).
- **Path-quote unwrap now covers image readers.** The candidate ledger recorded a
  `read_image` call whose `file_path` arrived quote-wrapped (`"\"C:\…\f.md\""`)
  and passed through unrepaired — the same emission artifact the `path-quotes`
  rule already heals on `read`/`write`/`edit`/`glob`/`grep`. `read_image` and
  `modlens_read_image` joined that tool set, so the next such call is repaired
  before dispatch instead of surfacing as a candidate. The strict gate is
  unchanged: one matched outer quote pair, absolute-path interior only.
  Two regression tests added (437 passing).

## [1.0.0] — 2026-11-14

First public release.

### Added

- **Pre-dispatch argument repair.** Path separators, tildes, quoting, and workspace scope; stringified or double-encoded values with schema-aware coercion; `run_code` code-fence removal, description fill, and syntax checking; `mnemon` result-schema correction.
- **Post-dispatch recovery retries** through the host's own batch runtime: range requests retried at the bound the host reports, whitespace-tolerant `edit` anchor retry, file-observation refresh retry, safe unknown-tool bridging and tool-name canonicalization, and directory-read kind correction. Do-no-harm guarantee: a failed retry always keeps the original error verbatim.
- **Circuit breaker** that pauses a recovery class that repeatedly fails, so repair attempts can't cascade.
- **In-text tool-call recognition.** Supported call markup emitted as prose is promoted to a structured call; recognition is recorded separately from execution success.
- **Plugin Manager dashboard.** Recent call records with bounded, redacted argument previews, per-rule health with live pause switches, an editable model-guidance editor, and stats reset. All diagnostics stay in local files; no telemetry service.
- **HTTP API** for the dashboard and scripting under `/plugin-api/tool-doctor/` (`stats`, `candidates`, `config`, `guidance`, `guidance/reset`, `reset`).
- **Plugin identity and documentation:** icon, feature preview, detail page, and the full README with the verified-behavior contract.

---

_Pre-release engineering history (design rounds, live host-contract verification, and their fixes) lives in the git log; this changelog starts clean at the public release._

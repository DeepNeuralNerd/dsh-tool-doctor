# Changelog

All notable changes to **Tool doctor** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [semantic versioning](https://semver.org/).

## [Unreleased]

### Changed

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

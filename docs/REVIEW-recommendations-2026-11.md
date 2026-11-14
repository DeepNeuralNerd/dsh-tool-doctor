# Tool doctor — recommendation list for reviewer model (2026-11-14)

Self-contained review packet. A reviewing model: give each numbered item a verdict
(ACCEPT / REVISE + change / REJECT + reason), and answer Q1–Q5 in the last section.
Judge against the invariant below, not against generic best practice.

## 1. System context (read this first)

**What it is.** A plugin for the DeepSeek Harness agent host that intercepts every
LLM tool call and repairs mechanically-broken arguments before dispatch, or
recovers selected failures after dispatch, recording every outcome in a local
ledger with a dashboard. ~450 intercepted calls/day of live history; 458 tests;
TypeScript.

**Hard invariants (violating any = REJECT the recommendation):**
1. *Repair only what is unambiguous.* When in doubt, pass through and record an
   honest failure. A false heal that "succeeds" with wrong bytes is worse than a
   visible error (a real production incident in the literature: OpenClaw v2026.5.28
   — quote-repair corrupted a valid edit array ⇒ silent wrong file write).
2. *The host is the match/parse authority.* Doctor never claims success itself —
   it retries or rewrites; the host's verdict is what the ledger records.
3. *No model round-trips.* A repair must be deterministic pre-dispatch work or a
   single nested host re-dispatch. Validation-error retry loops (Instructor-style)
   are explicitly not available.
4. *Never mutate the caller's arguments object* (pure functions, stage contract).
5. *Every rule is flag-gated, categorized, metered* (round-trips saved feed a
   token-savings estimate). A circuit breaker pauses a class after repeated
   healed-failed outcomes — currently it gates the POST-dispatch stages;
   pre-dispatch rules are flag-gated but do not pass through the breaker
   (correction from the review pass, see §7 Q5).

**Current state.** 17 stages (10 pre-dispatch, 7 post). Pre: args-envelope unwrap +
stringified-args ladder (fence strip → prose slice → trailing-comma strip →
double-decode), schema-aware type coercion (string↔bool/number, enum trim/case/
dash-fold, sentinel "null"/"undefined"), canonical parameter rename (curated alias
tables, schema-confirmed), run_code formatting family, editor range family, read
offset family, path normalization/scope/quoting (straight + curly pairs),
result-schema sibling fill. Post: unknown-tool bridge, tool-name canonicalization,
wrong-kind correction, observe-then-retry, whitespace-variant edit retry, anchor
state-refresh, range re-dispatch. Response side: in-text tool-call promotion R1–R7.

## 2. Pending recommendations — verdicts requested

### REC-1 — Brace-completion step in the stringified-args ladder (RECOMMEND: accept)
- **Class.** "Almost-parsing JSON": the payload arrives as a string missing its
  closing braces/brackets. Evidence: vLLM issue #22885 (tool-call args lose the
  trailing `}`), streaming-fragment issues #10589/#9874; practitioner report
  (OpenClaw): top failure set includes "a JSON array that almost parsed"; survey
  (arXiv 2603.06847, 385 faults from 40 repos): "structured-output interpretation"
  is a top symptom class.
- **Mechanic.** New step after the existing ladder steps (all of which try strict
  JSON.parse first): stack-scan the string outside quoted regions; if the open
  stack is non-empty and appending exactly the demanded closers (in stack order)
  yields a strict-parse plain object, adopt it; else abstain. Never adds keys,
  never quotes/unquotes anything.
- **Risk argument.** Same all-or-nothing gate as every other ladder step: a wrong
  repair cannot parse. Content inside strings is never touched by the scanner.
- **Q for reviewer:** can you construct an input where the completed object parses
  but differs from the model's likely intent in a way that matters? (Our answer:
  truncation means content is already lost; completion only makes the remainder
  usable. If you disagree, REC-1 should be REVISE → record-only, no adopt.)

### REC-2 — Python-literal payload step (RECOMMEND: accept, bundled with REC-1)
- **Class.** Payload is a Python-style repr: `{'file_path': 'C:\\x', 'limit': True,
  'offset': None}`. Same stringified-args plane; seen from open-model parsers and
  legacy transports (same vLLM-era parser family; TALLM taxonomy lists type/literal
  mismatches under input-construction faults).
- **Mechanic.** After REC-1: single→double quotes when unambiguous, `True/False/None`
  → `true/false/null`, then strict parse must succeed and yield a plain object,
  else abstain.
- **Risk argument.** The parse gate rejects every ambiguous case (e.g. apostrophes
  inside string values usually break the conversion ⇒ parse fails ⇒ honest pass-
  through). Worst observed outcome is "no repair", never "wrong repair".
- **Q for reviewer:** acceptable to order this AFTER all straight-JSON steps (so a
  valid-JSON payload is never touched), or should conversion also run before
  prose-slice? (We argue after; earlier means more surfaces.)

### REC-3 — Value-level unescape repair (RECOMMEND: defer, reviewer to confirm)
- **Class.** Over-escaped values: `"old_string": "line1\\nline2"` (literal
  backslash-n) where the file has real newlines. OpenClaw names over-escaping
  among its top emitted classes.
- **Why deferred.** Ambiguity is genuine: a literal `\n` is sometimes intended
  (regex patterns, code-in-string tools). Their own fix history shows repair of
  *valid* content causing silent wrong writes — exactly the failure our invariant-1
  forbids. Proposed strict detector (only when the value contains NO single
  backslash-escapes that are valid JSON escapes, i.e. only double-escaped
  sequences) + hard exclusion of edit content fields.
- **Q for reviewer:** is there a reliable unambiguous detector, or is this class
  fundamentally intent-dependent and therefore correctly excluded? Verdict on the
  deferral, not the class.

### REC-4 — Long-path `\\?\` recovery on Windows (RECOMMEND: probe before deciding)
- **Class.** Path >260 chars failing ENOENT-style when the OS is not opted in to
  long paths (Microsoft docs: MAX_PATH still binds by default; `\\?\` bypasses but
  requires fully-normalized form: no forward slashes, no `.`/`..`).
- **Proposed shape.** Post-dispatch retry family (like range re-dispatch): on a
  path-not-found result where the absolute path length >260, one nested re-dispatch
  with the normalized `\\?\` form. Gate: only file-system tools; single retry; the
  host remains the authority.
- **Why only a probe.** On this machine long paths are very likely already enabled
  (modern Windows dev installs are) — then the class is empty locally and the rule
  would be dead weight. Probe: attempt one >260-char path read; if it succeeds,
  REC-4 is REJECT-for-now for this host (keep in docs for distribution installs).
- **Q for reviewer:** if the probe shows the host IS opted in, is there any
  residual >260 failure mode (e.g. tools that use non-Unicode Win32 calls) worth a
  rule, or is REJECT clean?

### REC-5 — Audit request: the curated alias table (no change proposed)
Shipped this week (schema-confirmed rename: canonical key present in the tool's own
schema, canonical absent from args, exactly one alias present, values moved
verbatim):
- read/write/write/edit: `file_path` ← path, filename, filepath, file (+ edit:
  target_file, targetFile); `old_string` ← old_str, oldText, old_text;
  `new_string` ← new_str, newText, new_text
- glob/grep: `path` ← dir, directory, dir_path; `pattern` ← regex, glob (grep),
  pattern_glob
- read_image: `file_path` ← path, image_path, image
- modlens_read_image: `path` ← file_path, image_path
- **Q for reviewer:** name hallucinations we should add for these seven tools, or
  remove (any alias that could collide with a real future parameter)? Should the
  table stay hand-curated per host tool (current) rather than schema-similarity
  guessing (deliberately rejected: Levenshtein/semantic rename would guess)?

### REC-6 — Audit request: curly-quote gate strictness (no change proposed)
Shipped: path values wrapped in a matched pair — straight identical (`"..."`,
`'...'`, `` `...` ``) or typographic (`“…”`, `‘…’`) — are unwrapped only when the
inner text is an absolute path; mixed pairs (curly open + straight close) abstain.
- **Q for reviewer:** is there a documented emission pattern of MIXED pairs from
  real models/tokenizers, or is strict pairing right? (Strict costs one missed
  heal; loose risks invariant 1.)

## 3. Rejected classes — challenge invited (we believe each is correctly OUT)

| # | Class | Why out | Evidence |
|---|---|---|---|
| X1 | Missing required parameters (generic) | Filling = guessing intent; quarantine honestly. Exception: schema-proven sibling fills only. | OpenClaw reject-row; Butterfly (arXiv 2507.15296) class "missing" shows no mechanical fix. |
| X2 | Semantic value drift (region/currency/wrong entity) | Schema checks cannot capture meaning; repair = speculation. | TechRxiv unified taxonomy ("schema checks cannot capture drift"); Butterfly "deviation". |
| X3 | Faithfulness failures (skip tool / ignore result / fabricate after call) | Model had valid data, misused it — no argument rewrite applies. | ToolFailBench (arXiv 2607.04686) 4-mode taxonomy; MAST (2503.13657); τ-bench. |
| X4 | Trailing dot/space in Windows paths | Win32 silently trims them — healing a non-failure. | Microsoft naming docs. |
| X5 | Enum case/separator variants | Already shipped inside type-coercion (trim, case-fold, dash/underscore-fold, unique-match only). | BFCL stringified-drift data drove it. |
| X6 | Agent-loop faults (stuck loops, coordination) | Host/loop plane, not argument plane. | OpenHands, MAST. |
| X7 | file:// URI and percent-encoded paths | Never occurred in ~450-call local ledger + candidate history; watch-list, not rule. | Local evidence only — weakest rejection; challenge this one first. |
| X8 | Regex-flavor faults (look-around on grep lacking pcre2 param) | Host tool gap, not argument corruption; feature-requested upstream. | Live ledger: 2 greps. |

## 4. Explicitly out of reach (FYI, no verdicts needed)
Model-capability errors (vision-less model on read_image), tool-internal errors
(asar "Invalid package"), bridge/provider downtime, permission/consent denials,
genuinely missing files, provider-transport retries. Doctor's role for these is
honest recording + actionable hints, not repair.

## 5. Questions for the reviewer

- **Q1.** Against invariant 1, do REC-1/REC-2 clear the bar, or is "cannot parse ⇒
  cannot mislead" weaker than we claim?
- **Q2.** What is the correct ledger behavior when a completed/converted payload
  parses but the ORIGINAL would also have failed anyway (repair was harmless)?
  Should the token-saving estimate count it? (Current: counts as healed if the
  repaired call succeeds.)
- **Q3.** Is there any class in §3 you would flip to IN, and with what gate?
- **Q4.** Given the 20-source corpus cited above and in
  docs/RESEARCH-tool-call-failures-2026-11.md, what credible tool-call failure
  class is MISSING from both the coverage and the rejection list?
- **Q5.** The breaker pauses a category after repeated healed-failed outcomes.
  Any argument that per-TOOL breakers (rather than per-category) are the safer
  default? We currently reason category = shared mechanic; tool = shared victim.

## 6. Ground rules for the review
Prefer REJECT with a named invariant violation over REVISE with generic advice.
Every ACCEPT/REVISE must name the failure evidence it relies on; new-rule
suggestions outside this packet should cite a source we have not already triaged
(the corpus file lists all 20).

## 7. Review outcome (reviewer model, 2026-11-14)

Central correction, adopted as doctrine: **“parses successfully” is a syntax
check, not proof that a repair preserves intent.**

| Item | Verdict | Disposition |
|---|---|---|
| REC-1 brace-completion | REVISE | Accepted: a truncated `content` becomes *valid* once `}` is appended — completion never restores missing bytes. Revised scope: read-only tools first (or record-only shadow mode); last value must already be complete; structural closers only; mutating calls (write/edit) excluded until evidence establishes safety. Not yet built. |
| REC-2 python-literals | REVISE | Global quote/`True`/`None` replacement rejected — it can rewrite text inside strings. Revised: token-aware parser over a deliberately small literal subset, complete input consumption, plain-object requirement, each decoded string preserved byte-exactly; still ordered after the JSON steps. Not yet built. |
| REC-3 value unescape | ACCEPT the deferral | Confirmed out of automatic repair: even double escaping cannot establish whether `\n` means two characters or a newline; regex/code arguments stay intent-dependent. |
| REC-4 long paths | REVISE the probe | Probe redesign: gather actual long-path errors **per tool** before adding any retry; do not infer “too long” from ENOENT + length alone; `\\?\` rules differ for drive vs UNC paths (Microsoft docs). |
| REC-5 alias table | REVISE narrowly | Hand-curated, schema-confirmed design kept; no similarity-added names. New rule adopted: broad aliases (`file` on write/edit) require an OBSERVED failure to stay — schema confirmation proves the destination key exists, not that the alias meant it. No new alias added. |
| REC-6 curly pairs | REVISE the platform gate | Strict pairing stays; mixed pairs stay excluded. **Shipped (c8f9322):** absolute-path gate narrowed to Windows shapes (drive/UNC) — quote-illegality is a Windows rule; POSIX names may contain quotes, so a unix-root unwrap could change identity. Regression test added. |
| Q1 | Answered | REC-1/REC-2 did NOT clear invariant 1 as originally written; parse success establishes neither completeness nor intended bytes. Only the revised scopes do. |
| Q2 | Adopted, queued (measurement change) | Ledger records only “rewritten call succeeded”. No counterfactual claims (“original would have failed”), no counted round-trip saves unless actually known; token savings labelled as an estimate from successful rewrites — or excluded — until shadow-mode comparisons support them. Current tracker adds `tokensSaved` on any healed success, so this needs a code change with its own tests. |
| Q3 | No flips | X1–X6 and X8 stay OUT. X7 (file:// URIs) stays on the watch list: percent-decoding can change path identity, so observed frequency alone would not make it safe. |
| Q4 | New class — SHIPPED (c8f9322) | Duplicate JSON member names (RFC 8259 §4: `JSON.parse` keeps one value silently ⇒ possible silent target swap). The stringified-args ladder now scans every candidate JSON text and abstains on any duplicate name at any object level. Six tests. |
| Q5 | Direction adopted, queued | Breaker granularity: **(category, tool)** for retry suppression — a tool with a persistent environment/schema problem should not pause recovery for sibling tools; add a category-wide cap when one mechanic fails across several tools. |

## 8. Second reviewer round (2026-11-14) — disposition

Second reviewer model, priorities as given; ledger/shadow-first policy applied
throughout (the plugin's own ledger probed before enabling anything by default).

| Priority | Recommendation | Disposition |
|---|---|---|
| 1 | Resolve local `$ref` types before coercing | **SHIPPED (5de2add)** — local + acyclic + depth-capped pointer resolution; string→object/array ONLY; whole-value strict parse with the RFC 8259 guard reused; number/bool/enum never activated through a pointer; host stays the success authority. Fifteen tests. Insurance by construction: zero DSH built-in tools use `$ref` today; the class arrives with MCP-served schemas. |
| 2 | Exact duplicated argument object `{"x":1}{"x":1}` | **Queued as shadow spec** — live probe first: the shape has **zero occurrences** in this host's candidate/stats feeds. Spec kept: scanner for exactly two adjacent byte-identical complete objects; read-only/shadow; abstain otherwise. Note the `$ref` narrow gate and the args ladder both already ABSTAIN on this shape (no wrong repair today); the open question is whether to actively heal it. |
| 3 | Tighten promotion against quoted examples | **SHIPPED (5de2add)** — audit result: (a) placeholder names were already covered by the declared-tools allowlist (`healGate` + `addCall`); (b) the structured-twin class was a REAL gap — now a native call anywhere in the message vetoes its promoted text twin (name + canonical key-sorted args), either order, six adapter tests; (c) new guard **G6**: markup bracketed by quotes/parens in prose stays text — both sides must match, one-sided punctuation never suppresses; brackets deliberately excluded (Mistral array tiling), eight parser tests. |
| 4 | Duplicate JSON keys → abstain | Already shipped in round one (`c8f9322`), six tests — same RFC 8259 basis. |
| — | Upstream findings (Ollama corrupted envelopes; llama.cpp parse failures surfaced as HTTP errors without the raw call) | Recorded as diagnostics-only, not rules: when the host never receives intact bytes, no argument repair is possible. Action kept: the error-hints surface names the provider/error shape when present; fix belongs to those parsers. |
| — | No typo/fuzzy matching for parameter names | Agreed and documented as policy: the per-tool curated table stays; a close spelling does not prove intent for a mutating call (same doctrine as §7 REC-5's observed-failure rule). |

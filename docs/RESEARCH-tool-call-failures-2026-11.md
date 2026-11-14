# Tool-call failures: online research synthesis (2026-11-14)

Deeper web+papers research to drive rule selection for Tool doctor. Method: five
rounds — diagnostic benchmarks → agent-failure taxonomies → structured-output /
JSON-repair literature → practitioner error-handling → platform (Windows) edge
cases — with primary-source fetches (Google Scholar via `intent:paper`,
DuckDuckGo fallback for walled sources). Every rule shipped this week cites from
here; future proposals should check this matrix before being called "new".

## 1. Sources

| # | Source | Key finding used |
|---|--------|------------------|
| S1 | [Butterfly Effects in Toolchains](https://arxiv.org/abs/2507.15296) (arXiv 2507.15296) | Five parameter-filling classes: **name hallucination, missing, redundant, deviation/specification, value hallucination**. Name errors recoverable; deviation/redundant derail the whole chain. Tool-doc quality (type descriptions, examples) measurably changes failure rates; better error feedback improves post-failure behavior. |
| S2 | [TALLM failure taxonomy](https://homes.cs.washington.edu/~rjust/publ/tallm_testing_ast_2025.pdf) (UW/AST 2025) | Root-cause map: tool selection (wrong/hallucinated/missing), input construction (type mismatch, hallucinated arg), decoding format breakage, output parsing, tool error. Observed repairs = quote-escape fixes, path substitution, type fixes. |
| S3 | [OpenClaw: recovering malformed tool arguments](https://openclawai.io/blog/ai-agent-tool-call-errors-malformed-arguments-recovery) | Production line: "most tool-call errors are malformed arguments, not bad decisions". Top classes: **smart quotes, over-escaped strings, almost-parsing JSON arrays**. Doctrine: repair only unambiguous+reversible; quarantine otherwise; guard that valid input survives untouched (worst bug = "silent, confident, wrong write"); reject malformed values at the boundary. |
| S4 | [BFCL](https://gorilla.cs.berkeley.edu/blogs/8_berkeley_function_calling_leaderboard.html) | Graders needed string→bool/int/float converters: stringified-primitive drift is endemic. Bool: "no leniency on string versions". List order exact; all-or-nothing scoring. |
| S5 | [Anthropic: writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) | Invalid-parameter tool errors are the signal to watch; actionable error text beats opaque codes; pagination/range parameters need sensible defaults (our clamp family's design basis). |
| S6 | [aider edit-format docs + issue corpus](https://aider.chat/docs/troubleshooting/edit-errors.html) | #1 failure = SEARCH/REPLACE match failure. Escalation ladder: whitespace tolerance → retry → whole-file. Third-party validation of the anchor-variant stage incl. trailing-whitespace tolerance. |
| S7 | [Tool Execution Hallucination survey](https://www.techrxiv.org/doi/pdf/10.36227/techrxiv.177219979.94060974) (TechRxiv) | Unified pipeline taxonomy: Tool-Selection Hallucinations (TSH) vs **Tool-Calling Hallucinations (TCH)**; single-turn TCH = schema/format errors + fabricated values + hallucinated tool. Schema checks cannot catch *semantic* drift ⇒ drift stays out of mechanical repair. |
| S8 | [MAST: Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) | 14 modes / 3 categories — all at agent-coordination level. Outside a call-level plugin's reach (non-goal anchor). |
| S9 | [τ-bench](https://arxiv.org/abs/2406.12045) | Tool-agent-user failures are decision/rule violations; pass^k instability. Supports honest pass-through over speculative repair. |
| S10 | [SWE-agent](https://arxiv.org/abs/2405.15793) | Agent-Computer Interface design changes failure rates — interfaces should match LM abilities. Error hints = the slice of "better interface" available to a plugin. |
| S11 | [OpenHands](https://arxiv.org/abs/2407.16741) | Runtime-error handling & stuck detection live in the agent loop (host plane), not the argument plane. |
| S12 | [DeFA](https://arxiv.org/abs/2610.01256) | Failure *attribution* (decisive error vs visible consequence) needs dependency graphs — motivates the ledger/audit trail, not a new repair rule. |
| S13 | [ToolFailBench](https://arxiv.org/abs/2607.04686) (ICML 2026; OpenReview JhaxRN8QDV) | Failure modes: Tool-Skip, **Result-Ignore**, Output-Fabrication, Unnecessary-Tool-Use — post-call *faithfulness*, not argument format. Their instruction "empty/error return: say so, don't retry same args" mirrors Doctor's anti-blind-retry rule. |
| S14 | [JSONSchemaBench](https://arxiv.org/abs/2501.10868) (Microsoft) | Constrained decoding is NOT solved: compile errors, over-constrained (blocks valid answers, hurts quality), under-constrained ⇒ "**necessitating additional post-processing or retry logic**" — the academic justification for a runtime repair layer. |
| S15 | [Structured-output training wiki](https://birgermoell.github.io/open-llm-training-wiki/specialization/structured-output/) | Real-world JSON failures are **systematic**: missing comma after last array element, unescaped quotes inside strings, trailing prose after the JSON. |
| S16 | [Instructor](https://python.useinstructor.com/) | Practitioner standard = validation-error retry loop (max_retries) — a model-round-trip repair; Doctor's deterministic pre-dispatch repair avoids the round trip when the fix is unambiguous. |
| S17 | [vLLM tool-parser bugs](https://github.com/vllm-project/vllm/issues/22885) (+ streaming #10589) | The TRANSPORT itself corrupts arguments: parsers dropping `}`, mangled stream fragments ⇒ "almost-parsing JSON" arrives at the tool even when the model was right. |
| S18 | [Characterizing Faults in Agentic AI](https://arxiv.org/abs/2603.06847) | Empirical SE study (13,602 issues → 385 faults, 40 repos, 145 practitioners): 34 fault types; symptoms concentrated in structured-output interpretation, tool calls, runtime execution; root causes: **data-schema mismatch, dependency drift, state-management complexity, model-interface instability**. |
| S19 | [Win32 naming](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file) + [MAX_PATH](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation) | 260-char limit still binds unless opted in; `\\?\` bypass requires a fully-normalized path (no `/`, `.`, `..`); Win32 silently trims trailing dots/spaces (⇒ a trailing-space path is NOT a failure class on Windows — rejection evidence). |
| S20 | [MixRoute API failure taxonomy](https://mixroute.ai/blog/llm-api-failure-taxonomy/) | Origin-based classes with a **retry-safety** column; ErrorAtlas (17 categories) and AgentErrorTaxonomy as upstream catalogues. Doctor's breaker + no-blind-retry align with its retry-safety discipline. |

## 2. Cross-source frequency picture

Where arguments fail (ranked by how many independent sources name each):

1. **Schema-value drift** — stringified primitives, enum case, types: S1, S2, S4, S18 (root cause "data-schema mismatch").
2. **Path/URL shape** — quotes, separators, cwd-relative: S2, S3, S5.
3. **Envelope/syntax corruption** — stringified args, fences, prose, trailing commas, truncated braces: S3, S14, S15, S17.
4. **Anchor/state mismatch (edit class)** — match failure, stale observation: S6, S18 ("state-management complexity").
5. **Parameter-name hallucination**: S1, S2, S7 (now covered — stage 17).
6. **Tool-name errors**: S2, S7 (covered — bridge/tool-name).

Everything else (S8, S9, S12, S13, S20) sits at agent/loop/provider level.

## 3. Coverage matrix — class × Doctor plane (baseline 5a277ae, 17 stages)

| Failure class | Doctor treatment | Status |
|---|---|---|
| Stringified/wrapped args, fences, prose, trailing commas, double-encode | args-json ladder (ARGS_UNWRAP) | ✅ (truncated-brace gap → C1) |
| String↔number/bool/enum drift, sentinel "null"/"undefined" | type-coercion (ARGS_TYPE; case/dash/trim enum match) | ✅ |
| Invented parameter names | **param-alias (PARAM_ALIAS)** NEW | ✅ |
| Path: separators, `~`, drive letters, cwd-relative | path-normalizer / path-scope | ✅ |
| Path: straight AND curly quote wrapping | path-quotes NEW curly pairs | ✅ |
| Ranges/offsets past bounds | editor-range / read-args / range-retry | ✅ |
| Wrong/hallucinated tool names | bridge / tool-name | ✅ |
| Wrong door (directory into file reader) | kind-fix | ✅ |
| Edit anchor near-misses (EOL/indent/trailing space) | anchor-whitespace | ✅ (aider-validated) |
| Stale/unobserved file state | observe-retry / anchor-refresh | ✅ (S18 root-cause class) |
| Tool markup emitted as text | response-side R1–R7 | ✅ |
| Unrecovered errors | error-hints (S5 "actionable errors"), breaker (S20 retry-safety) | ✅ |

## 4. Out of scope — with the citation that says why

- **Faithfulness failures** (Tool-Skip / Result-Ignore / Fabrication, S13): the model had valid data and misused it — no argument rewrite applies.
- **Semantic value drift** (region "US" vs "Australia", S1, S7): "schema checks cannot capture drift" — speculative repair would violate the never-guess rule.
- **Agent-loop failures** (MAST S8, OpenHands stuck-loops S11, τ-bench decision errors S9): host/loop plane.
- **Provider transport retries** (S20): gateway plane. Doctor's nested-dispatch breaker is the local analogue and already exists.
- **Trailing dot/space in paths**: Win32 trims them silently (S19) — would be a rule against a non-failure. (Rejected with evidence.)
- **Missing required parameters** (S1 class 2): filling = guessing intent → quarantine honestly (S3's reject row). Exception kept: schema-proven sibling fills only (mnemon-result).

## 5. Ranked candidates (next rules)

| Rank | Candidate | Evidence | Plane/risk |
|---|---|---|---|
| **C1** | **Brace-completion step in the args-JSON ladder**: stack-scan the string payload, append only the closers the open-stack demands, adopt iff strict parse now succeeds and yields a plain object. | S17 (transport drops `}`), S3 ("a JSON array that almost parsed"), S15 (systematic syntax drift). | New step f in `parseWithRecovery`; zero-risk gate (never touches parseable input; never invents keys). |
| **C2** | **Python-literal step** after C1: single-quoted keys/strings + `True/False/None` → JSON, parse must succeed. Same ladder. | S17-era parsers emit python reprs; S2 lists type mismatches incl. literal spellings; common in open-model tool outputs. | Same stage; low risk (all-or-nothing parse gate). |
| **C3** | **Value-level unescape repair** for over-escaped strings (`\\n` → newline etc.) — **never** on edit content fields (OpenClaw's own write-corruption bug). | S3 flagship class. | Medium risk: ambiguity with intentional backslashes. Needs a strict detector (value has only double-escaped sequences) + content-field exclusion; defer until candidates show it live. |
| **C4** | **Long-path `\\?\` retry** for >260-char path ENOENTs on Windows (post-stage, one retry with normalized `\\?\` form). | S19; S1 "tool return perturbation". | Medium: requires the host not already opted-in (verify empirically first — this host has long paths enabled ⇒ likely a non-rule locally). |

Explicit non-starters from this corpus: enum case folding (already in type-coercion), semantic-drift fixes (S7), missing-required fills (S3), anything agent-loop (S8/S11), file-URI percent-decoding (no occurrence in this host's ledgers or candidate lists yet — keep watching, don't build).

**Reviewer-pass addendum (2026-11-14; details in
[REVIEW-recommendations-2026-11.md](REVIEW-recommendations-2026-11.md) §7).**
C1/C2 were REVISED: successful parsing proves syntax, not intent — C1 is
re-scoped to read-only/shadow use (a completed `content` field is still
truncated), C2 requires a token-aware parser that preserves strings exactly. C3's
deferral confirmed; C4's probe redesigned to gather real per-tool long-path
errors. The pass contributed a NEW corpus class, RFC 8259 §4 duplicate JSON
member names ("unpredictable interoperability behavior"; `JSON.parse` last-wins
= silent target swap) — shipped the same day as an ambiguity guard in
`repairArgsPayload` (six tests). Ledger semantics also corrected by the review:
record only "rewritten call succeeded"; no counterfactual or counted round-trip
claims until shadow-mode data exists; the breaker gates post-dispatch stages
only (pre-dispatch rules are flag-gated).

## 6. Standing conclusions for the plugin's identity

- S14 gives the architecture its justification sentence: constrained decoding under-constrains or over-constrains in the wild, and the paper's own remedy is "additional post-processing" — a runtime repair layer is the recommended production pattern, not a hack.
- S3's quarantine doctrine + S20's retry-safety column = Doctor's ledger design (record honest failures; the breaker pauses classes that prove unreliable).
- S18's root-cause list is the strongest third-party statement that argument-plane + state-plane repair is where a plugin's leverage lives.

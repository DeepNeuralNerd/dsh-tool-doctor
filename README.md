# Tool doctor

[![release](https://img.shields.io/github/v/release/DeepNeuralNerd/dsh-tool-doctor?label=release&color=3E9EA0)](https://github.com/DeepNeuralNerd/dsh-tool-doctor/releases) [![downloads](https://img.shields.io/github/downloads/DeepNeuralNerd/dsh-tool-doctor/total?label=downloads&color=3E8E6A)](https://github.com/DeepNeuralNerd/dsh-tool-doctor/releases) [![license](https://img.shields.io/badge/license-MIT-64748B)](LICENSE)

**Fewer failed tool calls. Less backtracking.**

An AI assistant can understand your task and still stumble over a tool request: a line number past the end of a file, a number supplied as text, or an edit that misses because its spacing changed. Tool doctor catches **supported, mechanical mistakes** in DeepSeek Harness (DSH), corrects the request or retries a recoverable error, and records what happened. You spend less time watching the assistant repeat a call it could have fixed.

For example, if a tool rejects `limit: 5000` and reports a maximum of `2000`, Tool doctor can retry with `limit: 2000`. If that retry fails, the original error remains available to the assistant. The dashboard distinguishes a successful repair from an attempted repair, an ordinary failure, and a call merely recognized in text.

![Illustration of a tool call repaired and recorded](docs/preview.svg)

## Why use it

- **Keep work moving.** Repair recognized argument mistakes before dispatch and recover from selected errors after dispatch, without asking the model to work out every mechanical correction itself.
- **See what actually happened.** Review bounded argument previews, repair outcomes, recurring failures, and estimated token savings in the Plugin Manager dashboard. Recognizing a call in text does not count as a successful repair.
- **Stay in control.** Switch rules individually, inspect a rule's recent activity, try shadow mode to record potential pre-dispatch repairs while sending the original arguments, or disable the plugin. A circuit breaker pauses recovery classes that repeatedly fail.

Tool doctor is useful if you are new to DSH and want fewer avoidable interruptions. If you build long coding workflows, its schema-aware repairs, bounded retries, and local diagnostics also give you a way to inspect where tool calls go wrong.

## What it does

- **Repairs arguments before a call runs.** Supported cases include wrapped or stringified argument objects, values that conflict with an available tool schema, parameters sent under a well-known wrong name (renamed only when the tool's own schema confirms it), quoted paths (straight and curly), some path and range mistakes, and common `run_code` formatting errors.
- **Recovers from selected tool errors.** Depending on the error and available tools, it can retry a range request at the reported bound, refresh file observation, retry an edit with a whitespace-equivalent anchor, correct an unambiguous tool name, or list a directory sent to a file reader.
- **Recognizes in-text tool calls.** When the model emits supported call markup as text, the plugin can promote it to a structured tool call. Promotion is recorded separately from execution success.
- **Provides diagnostics and controls.** The dashboard shows recent calls, repair outcomes, recurring error patterns, rule switches, and editable model guidance. A circuit breaker temporarily pauses recovery classes that repeatedly fail.

The plugin handles mechanical patterns. It cannot infer a model's intent, make a missing file exist, or resolve every permission, tool, or command failure. A successful call after an argument rewrite is counted as a repair outcome; it does not prove that the original call would have failed. Token savings shown in the dashboard are estimates, not measured billing reductions.

## The rules

Each rule below is a switch in the dashboard — the switch column is its config flag, and titles match the dashboard cards. The plugin follows one adoption standard: **a rule exists only when a published failure class or a deterministic host contract justifies it, and the repair is provably mechanical** — the re-parse proves the value, the tool's own schema confirms the name, or the host stays the final authority on the retry. Repairs that would need to guess intent are not rules; they are left as honest failures. ([Research corpus and coverage matrix](docs/RESEARCH-tool-call-failures-2026-11.md); [design review record](docs/REVIEW-recommendations-2026-11.md).)

| Rule (switch) | What it does | Why it exists |
| --- | --- | --- |
| Schema-shaped arguments (`autoSchemaArgs`) | Repairs structurally wrong arguments only when re-parse proves it: a JSON payload delivered as a string, one-level `{"arguments": …}` wrapper nesting, Markdown fences around the payload, string↔number/boolean/array drift against the tool's declared type (including types reached through a local `$ref`), a canonical rename of a well-known wrong parameter name, and — never adopted — payloads with duplicate JSON member names. | Stringified/wrapped arguments and schema–value type drift are the largest classes in the published corpora (serving-stack reports from vLLM and others document string-encoded nested arguments and type coercion gaps). The duplicate-name abstention is RFC 8259 §4: `JSON.parse` silently keeps the last value, which can swap a target path. Renames fire only when the tool's own schema confirms the canonical name. |
| Path separator normalization (`autoNormalizePaths`) | Canonicalizes Windows↔POSIX separator drift where the rewrite is lossless, expands `~`, and unwraps paths wrapped in straight or curly quotes. | Path-shape mistakes are the second-largest reported class. Quote-unwrapping is restricted to Windows absolute-path shapes, where a quote cannot legally appear in a file name — so the unwrap is semantics-preserving; POSIX names may contain quotes, so those are left alone. |
| Whitespace-tolerant edit retry (`autoFuzzyEdit`) | When an edit reports `old_string` not found, retries once per whitespace-equivalent anchor spelling (CRLF↔LF, tabs↔spaces). | Anchor-match failure is the most-documented edit-tool failure (aider's troubleshooting corpus: #1 edit error; its own first escalation step is whitespace tolerance). The host remains the match authority: an ambiguous variant is rejected, never guessed. |
| Range & path normalization (`autoClampRanges`) | Clamps out-of-bounds ranges to the bound the tool itself reported, moves read offsets back from past-EOF, and drops out-of-workspace source paths. | A range past a maximum is a boundary error whose correct value the tool states in its own error — retrying at the reported bound is deterministic, not speculative. |
| Observe-then-retry (`autoObserveFiles`) | After `FS_NOT_OBSERVED` / `FS_STALE_VERSION` on an edit or write, reads the target once and retries through the host dispatcher; anchor-lost errors refresh observation state without a blind retry. | Stale/unobserved file state is a documented root-cause class of agent tool failures. One observation-then-retry is the bounded form of the "refresh state, don't blindly retry" rule the failure-attribution literature recommends. |
| Unknown-tool recovery (`autoBridgeDirectTools`) | Re-dispatches an unknown-tool result as a nested host call when the intended tool is registered in scope, including name drift (case, MCP-namespace segments) — but only when exactly one registered tool matches, and it fills a known schema wrapper gap for `mnemon_subagent_result` payloads. | Hallucinated or mis-namespaced tool names are a published failure class; ambiguity abstains by design. The `mnemon_*` fill repairs a documented required-field wrapper mismatch on a DSH built-in tool. |
| Subagent route casing (`autoSubagentRouteFixes`) | Replaces a subagent call's provider/model id with the host's exact spelling when the emitted casing matches exactly one configured route case-insensitively (case-copied-from-prose ids like `LMStudio` for `lmstudio`); zero or multiple candidates pass through untouched. | DSH resolves provider and model ids case-insensitively, so a casing slip is a pure emission fault with one correct fix — the host's own spelling. The route-allow-list rejection is a documented DSH failure the model cannot see its way around. |
| Directory kind correction (`autoKindFixes`) | When a file reader receives a directory ("not a regular file"/EISDIR), re-dispatches the call to a listing tool the agent can call, built from that tool's own schema. No listing tool in scope: the original error stands. | Sending a directory to a file reader has one unambiguous intent — listing — and wrong-tool-for-the-job is a documented root-cause class. The rewrite uses only the target tool's own definition. |
| `run_code` argument repair (`autoWrapRunCode`) | Fixes `run_code` schema slips (command→code, missing description, descriptions inside embedded tool() calls), strips Markdown fences, and heals common syntax errors. | Host-contract class: `run_code` rejects these shapes deterministically, and the correction is mechanical re-shaping of the same program text. |
| In-text tool-call promotion (`healResponseTools`) | Promotes recognized tool-call markup streamed as plain text into structured tool blocks. Guards treat markup as data when it sits in code fences, think blocks, backticks, or quoted/parenthesized examples, when a placeholder names a tool that is not declared, and when the same call already exists as a structured call in the reply. | Models served behind non-native parsers emit valid call markup as prose — documented in serving-stack and parser reports (the promotion parser is ported from the Unsloth Studio healing layer). Promotion is recorded separately from execution success, and the host dispatch decides. |
| Prompt guidance injection (`injectPrompt`) | Injects concise best-practice guidance into the system context to reduce tool-call errors at the source. | Error-shaped, actionable guidance is the recommended front line in the failure literature (actionable errors and retry-safety guidance); this is the one rule that prevents rather than repairs. |
| Failure hints (`errorHints`) | Appends an actionable recovery hint to otherwise-unrecovered errors, preserving the original text. | Benchmark guidance for agents on failure: state what to do instead, and do not retry the same arguments blindly. |
| Passthrough trace persistence (`persistPassthrough`) | Optionally persists successful untouched calls in the detailed local trace. | Diagnostic switch: a full call history makes a repair rule auditable; aggregate counters are unaffected. |
| Shadow mode (`shadowMode`) | Evaluates every pre-dispatch repair and records what the rules **would** fix — but dispatches the original arguments. | Measure a rule's coverage before trusting it to act. Adopted from external review as the plugin's promotion standard: "parses successfully" is a syntax check, not proof a repair preserves intent. |

Rules are enabled by default. The dashboard can turn them on or off without a restart.

## Use it in DSH

Install the published GitHub repository into your DSH web profile:

```bash
dsh plugin --profile web add github:DeepNeuralNerd/dsh-tool-doctor
```

Restart DSH after installation so the host loads the plugin. Then open **Settings → Plugins → Installed → Tool doctor** to review activity and adjust rules. Rule overrides are saved under the DSH home directory. Model guidance edits take effect immediately in the running process but return to the factory default after a plugin restart.

The dashboard's data comes from local files under `DSH_HOME` (or `~/.dsh` when that variable is unset): `tool-doctor-events.jsonl` for detailed diagnostic events and `tool-doctor-summary.json` for counters. Argument previews are bounded and redact common secret forms. Review exported records before sharing them because errors and paths can still contain sensitive information. The plugin does not add its own telemetry service.

## Dashboard API

The plugin registers these routes under `/plugin-api/tool-doctor/`:

| Route | Method | Purpose |
| --- | --- | --- |
| `stats` | GET | Counters, categories, and recent records |
| `candidates` | GET | Recurring unresolved error patterns |
| `config` | GET, POST | Read or update rule switches |
| `guidance` | GET, PUT | Read or update model guidance |
| `guidance/reset` | POST | Restore factory guidance |
| `reset` | POST | Clear diagnostic records and counters |

## Development and verification

```bash
npm run check
```

This runs TypeScript checking, the automated tests, and the build. The build emits `lib/index.js` for the host and `lib/client.js` for the dashboard. Tests cover the repair mechanics, pipeline, dashboard, and adapter contract with a simulated Cordis host. Check behavior against the installed DSH version before relying on a repair in a production workflow.

## License

MIT. See [LICENSE](LICENSE).


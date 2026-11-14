# Tool doctor

Mechanical tool-call failures are pure waste. A `read` offset past the end of a file, a `limit` above the schema maximum, an `edit` anchor one space off — the host correctly refuses, and the model then pays a full round-trip to notice the error, guess the fix, and resend. Across a long session those small taxes become visible latency, burned tokens, and stalled work, while the model does the job of a typo-corrector instead of the job you gave it.

Tool doctor removes that tax. It repairs mechanical argument mistakes before a call runs, and retries the recoverable failures after they happen — returning the result the call was meant to produce, or the original error completely untouched when nothing was safely fixable. Everything genuine stays exactly the host's behavior; only the trivia stops reaching the model.

## What it does

- **Repairs arguments before a call runs.** Supported cases include wrapped or stringified argument objects, values that conflict with an available tool schema, quoted paths, some path and range mistakes, and common `run_code` formatting errors.
- **Recovers from selected tool errors.** Depending on the error and available tools, it can retry a range request at the reported bound, refresh file observation, retry an edit with a whitespace-equivalent anchor, correct an unambiguous tool name, or list a directory sent to a file reader.
- **Recognizes in-text tool calls.** When the model emits supported call markup as text, the plugin can promote it to a structured tool call. Promotion is recorded separately from execution success.
- **Provides diagnostics and controls.** The dashboard shows recent calls, repair outcomes, recurring error patterns, rule switches, and editable model guidance. A circuit breaker temporarily pauses recovery classes that repeatedly fail.

The plugin handles mechanical patterns. It cannot infer a model's intent, make a missing file exist, or resolve every permission, tool, or command failure. A successful call after an argument rewrite is counted as a repair outcome; it does not prove that the original call would have failed. Token savings shown in the dashboard are estimates.

## Use it in DSH

Build the package with `npm run check`, then install and enable it in DSH Plugin Manager. Open **Tool doctor** there to review activity and adjust rules. If you replace the package while DSH is running, reload the plugin or restart DSH so the host uses the new bundle.

Rules are enabled by default. The dashboard can turn them on or off without a restart. Rule overrides are saved under the DSH home directory. Model guidance edits take effect immediately in the running process but return to the factory default after a plugin restart.

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


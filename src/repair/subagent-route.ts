/**
 * Model-argument canonicalization for subagent dispatches.
 *
 * DSH resolves a subagent's provider case-insensitively (provider ids and
 * model ids match across case), but an open model emits the two strings with
 * the casing it saw in prose: `LMStudio` vs `lmstudio`, `Qwen3.8-Next-NVFP4`
 * vs the route id. When the emitted casing matches exactly one provider id or
 * model id case-insensitively (and the exact casing is NOT that id), the value
 * is replaced with the host's spelling. Ambiguity (zero or multiple candidates)
 * abstains and the host error stays honest. Only `subagent` calls carrying a
 * `provider` are touched; pure text fields (prompt, name, description) are
 * never rewritten.
 *
 * Stdlib-only, side-effect-free, never mutates its input.
 *
 * @module dsh-tool-doctor/repair/subagent-route
 */

export interface SubagentRouteRepair {
  args: Record<string, unknown>;
  changes: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a non-empty (after trim) string. */
function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Canonicalize one emitted route component against the host's list of ids.
 * @returns the host's spelling when unique and different; undefined otherwise.
 */
function canonicalizeValue(emitted: string, candidates: readonly string[]): string | undefined {
  if (candidates.includes(emitted)) return undefined; // exact spelling already correct
  const lower = emitted.toLowerCase();
  const matches = candidates.filter((c) => c.toLowerCase() === lower);
  if (matches.length !== 1) return undefined; // zero or ambiguous: abstain
  return matches[0];
}

/**
 * Rewrites `provider` / `model` casing on a `subagent` call when the host's
 * visible model-route list contains a case-insensitive unique match.
 *
 * @param toolName - The dispatched tool name; only "subagent" is touched.
 * @param rawArgs - Raw model arguments.
 * @param providers - Provider ids visible through the host's model-route
 *   enumeration (empty/undefined ⇒ the stage is inert).
 * @param modelsByProvider - Model ids per provider id from the same enumeration.
 */
export function repairSubagentRouteArgs(
  toolName: string,
  rawArgs: unknown,
  providers: readonly string[] | undefined,
  modelsByProvider: Readonly<Record<string, readonly string[]>> | undefined,
): SubagentRouteRepair | undefined {
  if (toolName !== "subagent") return undefined;
  if (!isPlainObject(rawArgs)) return undefined;
  if (!providers || providers.length === 0) return undefined;

  const changes: string[] = [];
  let argsCopy: Record<string, unknown> | undefined;

  const provider = rawArgs["provider"];
  let resolvedProvider: string | undefined;
  if (hasText(provider)) {
    const canon = canonicalizeValue(provider, providers);
    if (canon !== undefined) {
      argsCopy ??= { ...rawArgs };
      argsCopy["provider"] = canon;
      resolvedProvider = canon;
      changes.push("Canonicalized provider casing to the host's spelling");
    } else if (providers.includes(provider)) {
      resolvedProvider = provider;
    }
  }

  const model = rawArgs["model"];
  if (hasText(model) && resolvedProvider !== undefined) {
    const modelIds = modelsByProvider?.[resolvedProvider];
    if (modelIds && modelIds.length > 0) {
      const canon = canonicalizeValue(model, modelIds);
      if (canon !== undefined) {
        argsCopy ??= { ...rawArgs };
        argsCopy["model"] = canon;
        changes.push("Canonicalized model casing to the host's spelling");
      }
    }
  }

  if (argsCopy === undefined) return undefined;
  return { args: argsCopy, changes };
}

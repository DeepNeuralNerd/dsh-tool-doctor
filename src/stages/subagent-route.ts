/**
 * Stage — subagent route casing canonicalization (SUBAGENT_ROUTE). Rule 11.
 *
 * The host resolves subagent provider/model ids case-insensitively, but models
 * emit route casing copied from prose ("LMStudio", "Qwen3.8-Next-NVFP4") and
 * the session's route allow-list then rejects the call outright. This stage
 * reads the host's model-route enumeration — the same data
 * `list_subagent_models` exposes, bound onto the tool-runtime view by the
 * adapter — and replaces the emitted casing with the host's spelling ONLY when
 * the match is unique and the exact casing is wrong. Zero or multiple
 * candidates abstain; hosts without the enumeration make the stage inert.
 *
 * Pre-stages never await: provider ids are cached at first read (sync API),
 * model lists are fetched once per provider without blocking the call — the
 * first subagent call naming a provider may run unrepaired, every later one
 * sees the cached list.
 *
 * Gated by its own `autoSubagentRouteFixes` flag: this canonicalizes a
 * model-visible route value against the llm service, not a tool name against
 * the tool registry, so it does not share the dispatch-routing family.
 *
 * @module dsh-tool-doctor/stages/subagent-route
 */

import type { PreStage, StageEnv, StageOutcome } from "../core/stage.ts";
import { repairSubagentRouteArgs } from "../repair/subagent-route.ts";

function asIds(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (typeof item === "string" ? item : (item as { id?: unknown })?.id))
    .filter((id): id is string => typeof id === "string");
}

let providerCache: readonly string[] | false | undefined;

/** Model ids per provider, fetched once per provider (async, non-blocking). */
const modelCache = new Map<string, readonly string[]>();
const inflight = new Set<string>();

/**
 * Provider ids from the host enumeration, cached for the process (the
 * configured set is static per process). Undefined while the plane is absent
 * keeps the stage inert.
 */
function providerIds(env: StageEnv): readonly string[] | undefined {
  if (providerCache !== undefined) return providerCache || undefined;
  const tools = env.tools;
  if (typeof tools?.listProviders !== "function") return undefined;
  let built: readonly string[] | false | undefined;
  try {
    const providers = asIds(tools.listProviders());
    built = providers.length > 0 ? providers : false;
  } catch {
    built = false;
  }
  providerCache = built;
  return built || undefined;
}

/**
 * Kick a model-list fetch for a provider when no entry exists yet. The FIRST
 * subagent call with that provider may run unrepaired (pre-stages never
 * await); every later one sees the cached list. Never throws.
 */
function refreshProviderModels(env: StageEnv, provider: string): void {
  if (modelCache.has(provider) || inflight.has(provider)) return;
  const tools = env.tools;
  if (typeof tools?.listModels !== "function") {
    modelCache.set(provider, []); // no model plane: inert without refetching
    return;
  }
  inflight.add(provider);
  void Promise.resolve(tools.listModels(provider))
    .then((models) => {
      modelCache.set(provider, asIds(models));
    })
    .catch(() => {
      modelCache.set(provider, []);
    })
    .finally(() => {
      inflight.delete(provider);
    });
}

export const subagentRouteStage: PreStage = {
  phase: "pre",
  id: "subagent-route",
  label: "Subagent route casing canonicalization (SUBAGENT_ROUTE)",
  ruleNumber: 11,
  enabledBy: "autoSubagentRouteFixes",
  category: "SUBAGENT_ROUTE",
  roundTrips: 1,
  matchesError: (_code, text) => /is not allowed for this session/i.test(text ?? ""),
  run(toolName, args, env): StageOutcome | undefined {
    if (!env.config.autoSubagentRouteFixes) return undefined;
    const providers = providerIds(env);
    if (providers === undefined) return undefined;
    // Warm the model list for the emitted provider (non-blocking first-time
    // fetch) so later calls can canonicalize the model id too.
    if (toolName === "subagent" && typeof (args as Record<string, unknown> | undefined)?.["provider"] === "string") {
      const emitted = (args as Record<string, unknown>)["provider"] as string;
      const hit = providers.find((p) => p.toLowerCase() === emitted.toLowerCase());
      if (hit !== undefined) refreshProviderModels(env, hit);
    }
    const repaired = repairSubagentRouteArgs(toolName, args, providers, Object.fromEntries(modelCache));
    if (repaired === undefined) return undefined;
    return { args: repaired.args, changes: repaired.changes, category: "SUBAGENT_ROUTE" };
  },
};

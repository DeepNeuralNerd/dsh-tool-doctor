/**
 * Stage 1 — `run_code` argument & body repair (multi-stage).
 *
 * One pre-dispatch stage that runs three internal passes in order and reports
 * which one owned the fix, so each event keeps its historical category:
 *   1. Argument normalization (command→code synthesis, missing description,
 *      markdown fences) → INVALID_ARGS / CODE_WRAP / RUN_CODE_DESC
 *   2. Preemptive inner-call description injection for tools whose active
 *      schema requires one → INNER_DESC (TypeScript runtimes only: the splice
 *      emits JS object syntax, invalid inside a Python dict)
 *   3. Body-syntax repair (truncated tails, triple-quoted strings, stray
 *      template backticks), every candidate re-parsed before acceptance →
 *      RUN_CODE_SYNTAX (owns the category when it fires; the summary keeps
 *      every change)
 *
 * The fence-only edge: stripping a fence is semantically equivalent, so the
 * repaired arguments are returned but no heal is claimed (`category` absent).
 * An empty program body returns undefined — left for the host to reject loudly
 * instead of being healed into a silent no-op.
 *
 * @module dsh-tool-doctor/stages/run-code
 */

import type { PreStage, StageEnv, StageOutcome } from "../core/stage.ts";
import type { HealCategory } from "../types.ts";
import { objectValue } from "../core/util.ts";
import { normalizeRunCodeArguments, stripMarkdownFences } from "../repair/run-code.ts";
import { injectInnerDescriptions } from "../repair/inner-description.ts";
import { repairRunCodeSyntax } from "../repair/run-code-syntax.ts";

/** Compare the semantic run_code fields instead of JSON property order. */
function runCodeArgsMatch(
  rawArgs: unknown,
  normalized: { code: string; description: string },
): boolean {
  const rawObject = objectValue(rawArgs);
  if (rawObject === undefined) return false;
  if (!Object.keys(rawObject).every((key) => key === "code" || key === "description")) {
    return false;
  }
  if (typeof rawObject["code"] !== "string" || typeof rawObject["description"] !== "string") {
    return false;
  }
  return (
    stripMarkdownFences(rawObject["code"]) === normalized.code &&
    rawObject["description"].trim() === normalized.description
  );
}

function includesString(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.some((item) => item === expected);
}

/**
 * Read the active tool schema without assuming one particular host version.
 * Current DSH definitions expose JSON Schema; the legacy property-map form is
 * accepted only as a compatibility fallback. True only when the active
 * definition declares `description` required.
 */
function toolRequiresDescription(
  tools: NonNullable<StageEnv["tools"]>,
  name: string,
  agent: unknown,
): boolean {
  try {
    const definition = objectValue(tools.get(name, agent));
    const parameters = objectValue(definition?.["parameters"]);
    if (parameters === undefined) return false;
    if (includesString(parameters["required"], "description")) return true;
    const properties = objectValue(parameters["properties"]);
    if (objectValue(properties?.["description"])?.["required"] === true) return true;
    return objectValue(parameters["description"])?.["required"] === true;
  } catch {
    // Schema inspection is an optional optimization; never break a call when
    // a legacy runtime exposes an incompatible definition object.
    return false;
  }
}

/** The full multi-stage pass over one run_code call's arguments. */
function repairRunCodeCall(
  rawArgs: unknown,
  env: StageEnv,
): { args: { code: string; description: string }; changes: string[]; category?: HealCategory } | undefined {
  const normalized = normalizeRunCodeArguments(rawArgs);

  // An empty program would succeed as a no-op and hide the model error; leave
  // the original arguments for the host to reject loudly.
  if (normalized.code.trim().length === 0) return undefined;

  const originalObj = objectValue(rawArgs);
  const isCmdPass =
    originalObj !== undefined && ("command" in originalObj || "cmd" in originalObj);
  const isMissingDesc =
    originalObj !== undefined &&
    (typeof originalObj["description"] !== "string" ||
      originalObj["description"].trim().length === 0);
  const rawCode = typeof originalObj?.["code"] === "string" ? originalObj["code"] : undefined;
  const hasMarkdownFence = rawCode !== undefined && stripMarkdownFences(rawCode) !== rawCode;

  const changes: string[] = [];
  let category: HealCategory | undefined;

  // Pass 1: argument normalization. Healthy calls (the common case) skip a
  // second full stringify of the program body.
  const runCodeChanged = !runCodeArgsMatch(rawArgs, normalized);
  if (isCmdPass) changes.push("Converted command/cmd to run_code.code");
  if (isMissingDesc) changes.push("Filled run_code.description");
  if (hasMarkdownFence) changes.push("Removed Markdown fence from code");
  if (runCodeChanged && changes.length === 0) changes.push("Normalized run_code arguments");
  if (runCodeChanged) {
    if (isCmdPass) category = "INVALID_ARGS";
    else if (hasMarkdownFence) category = "CODE_WRAP";
    else if (isMissingDesc) category = "RUN_CODE_DESC";
    else category = "INVALID_ARGS";
  }

  // Pass 2: preemptive inner-call repair — inject missing descriptions into
  // the program's tools.*() options objects before execution, but only for
  // tools whose active schema declares description as required. Skipped under
  // a Python runtime (JS splice syntax is not valid inside a Python dict).
  const isPython = (env.codeLanguage() ?? "").toLowerCase().startsWith("python");
  if (!isPython) {
    // One program can reference the same tool dozens of times; resolve each
    // distinct schema once per dispatch instead of per occurrence.
    const descriptionCache = new Map<string, boolean>();
    const inner = injectInnerDescriptions(
      normalized.code,
      normalized.description,
      (toolName) => {
        const cached = descriptionCache.get(toolName);
        if (cached !== undefined) return cached;
        const required =
          env.tools !== undefined && toolRequiresDescription(env.tools, toolName, env.agent);
        descriptionCache.set(toolName, required);
        return required;
      },
    );
    if (inner.injected > 0) {
      normalized.code = inner.code;
      if (category === undefined) category = "INNER_DESC";
      changes.push(`Filled inner description × ${inner.injected}`);
    }
  }

  // Pass 3: body-syntax repair — a program that does not parse fails before
  // any inner call runs, so the argument-level repairs above cannot help it.
  // TypeScript-only: under Python the triple-quoted shape is valid source and
  // AsyncFunction parsing does not describe Python at all.
  if (!isPython) {
    const repaired = repairRunCodeSyntax(normalized.code);
    if (repaired !== undefined) {
      normalized.code = repaired;
      // The body was the blocker, so the syntax repair owns the category; the
      // summary keeps every change.
      category = "RUN_CODE_SYNTAX";
      changes.push("Repaired run_code program syntax");
    }
  }

  // No change at all → no-op. A change without an owning stage (fence-only)
  // still returns the repaired arguments but claims no heal.
  if (changes.length === 0) return undefined;
  return { args: normalized, changes, category };
}

export const runCodeStage: PreStage = {
  phase: "pre",
  id: "run-code",
  label: "run_code argument & body repair",
  ruleNumber: 1,
  enabledBy: "autoWrapRunCode",
  roundTrips: 1,
  matchesError: (code) => code === "CODE_RUN_FAILED" || code === "INVALID_ARGS",
  run(toolName, args, env): StageOutcome | undefined {
    if (toolName !== "run_code" || !env.config.autoWrapRunCode) return undefined;
    const repaired = repairRunCodeCall(args, env);
    if (repaired === undefined) return undefined;
    return { args: repaired.args, changes: repaired.changes, category: repaired.category };
  },
};

/**
 * Schema-gap repair for `mnemon_subagent_result` payloads.
 *
 * Candidate evidence (tool-healer history, 2026-11-13): the tool's inner
 * `result` schema is per-request ("from its completion instructions"), so
 * models keep tripping over required fields they expressed under a sibling
 * name instead:
 *
 * - `result.suggestions[<n>].steps is required` — the suggestion carried a
 *   single `text` string where an array of step strings was expected.
 * - `result.answer is required` — the child reported its work as `steps` /
 *   `summary` but never filled the top-level answer field.
 *
 * The repair only moves content that already exists into the shape the host
 * demands; it never invents text:
 * 1. A suggestion missing `steps` gains `[text]` when its own non-empty string
 *    `text` is present (and a bare-string `steps` is wrapped in an array). No
 *    sibling content, no fill — the host rejection stays honest.
 * 2. A result missing `answer` gains one synthesized from its siblings: the
 *    joined `result.steps` strings when non-empty, else the non-empty
 *    `result.summary`. Neither present, no fill.
 *
 * Scope discipline mirrors the other argument repairs: only this tool is
 * touched, untouched fields pass through by reference (shallow copies only
 * where a value changed), and undefined means "no repair needed". Stdlib-only
 * and side-effect-free.
 *
 * @module dsh-tool-doctor/repair/mnemon-result-schema
 */

/** The only tool whose result payload this repair shapes. */
const TOOL_NAME = "mnemon_subagent_result";

/** One repair: the corrected arguments plus bounded change labels. */
export interface MnemonResultRepair {
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
 * Fill missing required fields of a `mnemon_subagent_result` payload from the
 * sibling content the model already supplied.
 * @param toolName - The dispatched tool name.
 * @param rawArgs - Raw arguments (`requestId`, `result`).
 * @returns A corrected copy with bounded change labels, or undefined when no
 *          repair applied (healthy payload or nothing to derive).
 */
export function repairMnemonResultArgs(
  toolName: string,
  rawArgs: unknown,
): MnemonResultRepair | undefined {
  if (toolName !== TOOL_NAME) return undefined;
  if (!isPlainObject(rawArgs)) return undefined;

  const result = rawArgs["result"];
  if (!isPlainObject(result)) return undefined;

  let argsCopy: Record<string, unknown> | undefined;
  let resultCopy: Record<string, unknown> | undefined;
  const changes: string[] = [];

  // 1. Suggestions: `steps` is the required array; a sibling `text` string or
  //    a bare-string `steps` both carry the same content in the wrong shape.
  if (Array.isArray(result["suggestions"])) {
    let suggestionsCopy: unknown[] | undefined;
    result["suggestions"].forEach((entry, index) => {
      if (!isPlainObject(entry)) return;

      let entryCopy: Record<string, unknown> | undefined;
      const steps = entry["steps"];
      if (steps === undefined && hasText(entry["text"])) {
        entryCopy ??= { ...entry };
        entryCopy["steps"] = [entry["text"]];
        changes.push(`Filled suggestions[${index}].steps from its text`);
      } else if (hasText(steps)) {
        entryCopy ??= { ...entry };
        entryCopy["steps"] = [steps];
        changes.push(`Wrapped string suggestions[${index}].steps in an array`);
      }

      if (entryCopy !== undefined) {
        suggestionsCopy ??= [...(result["suggestions"] as unknown[])];
        suggestionsCopy[index] = entryCopy;
      }
    });

    if (suggestionsCopy !== undefined) {
      resultCopy ??= { ...result };
      resultCopy["suggestions"] = suggestionsCopy;
    }
  }

  // 2. Top-level answer: synthesize from the child's own reported content,
  //    never from nothing. Steps first (the full report), summary as the
  //    condensed fallback. Neither field is rewritten above, so the original
  //    values are authoritative here.
  if (result["answer"] === undefined) {
    const steps = result["steps"];
    let answer: string | undefined;
    if (Array.isArray(steps)) {
      const lines = steps.filter((step): step is string => hasText(step));
      if (lines.length > 0) answer = lines.join("\n");
    }
    if (answer === undefined && hasText(result["summary"])) {
      answer = String(result["summary"]);
    }
    if (answer !== undefined) {
      resultCopy ??= { ...result };
      resultCopy["answer"] = answer;
      changes.push(
        Array.isArray(steps) && steps.length > 0
          ? "Filled result.answer from its steps"
          : "Filled result.answer from its summary",
      );
    }
  }

  if (resultCopy === undefined) return undefined;
  argsCopy ??= { ...rawArgs };
  argsCopy["result"] = resultCopy;
  return { args: argsCopy, changes };
}

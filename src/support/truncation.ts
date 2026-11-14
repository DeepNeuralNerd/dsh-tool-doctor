/**
 * Cut-off-arguments heuristic — the truncation surface for the hint layer.
 *
 * Why a heuristic and not gating: the agent loop DOES know when a response
 * hit the output limit (pi-ai's `stopReason === "length"`; a tool call cut
 * mid-JSON is even discarded there instead of dispatched), but the stop
 * reason never reaches a plugin's tool plane — `tools/execute` carries no
 * finish metadata. What the plugin CAN see is the SHAPE a cut payload
 * leaves behind: a string that ends mid-token. Gating would claim a cause;
 * this only recognizes a symptom, and the hint it feeds is phrased as
 * "possibly cut off", never as "was truncated".
 *
 * @module dsh-tool-doctor/support/truncation
 */

/**
 * Whether raw call arguments look like they were CUT OFF mid-generation:
 * only a string payload qualifies (a parsed object already survived), and
 * it must fail to end like a closed value while showing at least one
 * cut-mid-token mark:
 *  - unclosed code fence (a ``` opened but never closed),
 *  - an odd number of unescaped double quotes (cut inside a string),
 *  - unbalanced braces/brackets (cut inside an object/array),
 *  - a dangling trailing backslash (cut inside an escape),
 *  - a key with no value yet (`{"a":` / `{"a": ` at the very end).
 * Well-formed JSON object strings → false. Non-strings → false.
 */
export function looksTruncatedArgs(rawArgs: unknown): boolean {
  if (typeof rawArgs !== "string") return false;
  const text = rawArgs.trimEnd();
  if (text === "") return false;
  if (text.endsWith("}") || text.endsWith("]")) return false; // a closed value

  if (/```/.test(text) && !/```[\s\S]*```/.test(text)) return true; // open fence
  if (countUnescapedQuotes(text) % 2 === 1) return true;
  if (depthImbalance(text) !== 0) return true;
  if (/\\$/.test(text)) return true;
  if (/:\s*$/.test(text) && /[{["']/.test(text)) return true; // key without value
  return false;
}

/** Double quotes that are not escaped with a backslash. */
function countUnescapedQuotes(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) count++;
  }
  return count;
}

/** Brace/bracket nesting depth (outside double-quoted spans), or NaN-free sum. */
function depthImbalance(text: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return depth;
}

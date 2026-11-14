/**
 * Argument normalization for `run_code` calls.
 *
 * Handles the dominant model-side emission errors: a raw string instead of an
 * object, JSON-encoded arguments, bash-style `command`/`cmd` payloads,
 * markdown-fenced bodies and missing descriptions. An empty program is left
 * empty on purpose — synthesizing a no-op would hide the model error; the host
 * rejects it loudly instead.
 *
 * @module dsh-tool-doctor/repair/run-code
 */

/**
 * Strip one surrounding markdown code fence (```lang ... ```).
 * @param code - Raw body that may be fenced.
 * @returns The unfenced, trimmed body; the input unchanged when not fenced.
 */
export function stripMarkdownFences(code: string): string {
  const trimmed = code.trim();
  const match = /^```(?:[A-Za-z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  if (match && match[1]) return match[1].trim();
  // Unfenced input passes through completely unchanged: trimming it here would
  // make callers' fence tests (stripped !== original) report a fence where only
  // whitespace moved.
  return code;
}

/** Normalized `run_code` arguments: a body plus an honest description. */
export interface RunCodeArguments {
  code: string;
  description: string;
}

/**
 * Normalize raw `run_code` arguments into the host's accepted shape.
 * @param rawArgs - Raw model output (object, JSON string, or bare program text).
 */
export function normalizeRunCodeArguments(
  rawArgs: unknown,
): RunCodeArguments {
  let argsObj: Record<string, unknown> = {};

  if (typeof rawArgs === "string") {
    const trimmed = rawArgs.trim();
    try {
      const parsed: unknown = JSON.parse(trimmed);
      argsObj =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { code: trimmed };
    } catch {
      argsObj = { code: trimmed };
    }
  } else if (typeof rawArgs === "object" && rawArgs !== null) {
    argsObj = { ...(rawArgs as Record<string, unknown>) };
  }

  // Case 1: the model treated run_code like bash. Synthesize a real program
  // that runs the command through the host's own bash tool — but only when
  // there is something to run; an empty command stays empty so the host can
  // reject it loudly instead of us hiding the error in a no-op success.
  const rawCommand = argsObj["command"] ?? argsObj["cmd"];
  if (
    typeof rawCommand === "string" &&
    rawCommand.trim().length > 0 &&
    (!argsObj["code"] || typeof argsObj["code"] !== "string")
  ) {
    const cmdStr = rawCommand.trim();
    const description =
      typeof argsObj["description"] === "string" &&
      argsObj["description"].trim().length > 0
        ? argsObj["description"].trim()
        : `Execute command: ${cmdStr.slice(0, 50)}`;
    return {
      description,
      code: `const result = await tools.bash(${JSON.stringify({ command: cmdStr })});\nreturn result;`,
    };
  }

  // Case 2: extract and clean the body.
  const code = stripMarkdownFences(
    typeof argsObj["code"] === "string" ? argsObj["code"] : "",
  );

  // Case 3: ensure a non-empty description, preferring the program's own
  // leading comment over a generic label.
  let description =
    typeof argsObj["description"] === "string"
      ? argsObj["description"].trim()
      : "";
  if (!description) {
    const firstLine = code.split("\n")[0]?.trim() ?? "";
    if (
      firstLine.startsWith("//") ||
      firstLine.startsWith("#") ||
      firstLine.startsWith("/*")
    ) {
      description = firstLine.replace(/^[/#*\s]+/, "").slice(0, 60).trim();
    }
    if (!description) description = "Execute code script";
  }

  return { code, description };
}

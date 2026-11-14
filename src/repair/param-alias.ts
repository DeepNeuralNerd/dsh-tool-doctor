/**
 * Canonical parameter-name renaming (parameter-hallucination repair).
 *
 * Research basis (2026-11-14): the parameter-filling taxonomies (arXiv
 * 2507.15296 "Butterfly Effects in Toolchains"; TALLM failure taxonomy,
 * UW/AST 2025) rank parameter-NAME hallucination among the top argument
 * failure classes — the model means `file_path` but types `filename`, or
 * means `pattern` but types `regex`. This host rejects the invented key
 * outright ("unexpected property"), so one unambiguous rename turns a hard
 * validation failure into the call the model intended.
 *
 * Scope discipline (repair only what is unambiguous):
 *  - Only the curated per-tool tables below are consulted; unknown tools and
 *    unknown names pass through untouched.
 *  - The rename fires only when the alias key is present, the canonical key
 *    is absent, and the tool's OWN schema confirms the canonical name is a
 *    real property while the alias is not. No schema, no rename.
 *  - Two aliases of the same canonical at once is ambiguous: abstain.
 *  - Values are moved verbatim; this rule never reshapes a value.
 *
 * @module dsh-tool-doctor/repair/param-alias
 */

import { extractSchema } from "./type-coercion.ts";

/** One canonical parameter and the invented names models emit for it. */
interface AliasRule {
  readonly canonical: string;
  readonly aliases: readonly string[];
}

/** Curated tables — keys must be this host's real registered tool names. */
const TOOL_ALIASES: Readonly<Record<string, readonly AliasRule[]>> = {
  read: [{ canonical: "file_path", aliases: ["path", "filename", "filepath", "file"] }],
  write: [{ canonical: "file_path", aliases: ["path", "filename", "filepath", "file"] }],
  edit: [
    { canonical: "file_path", aliases: ["path", "filename", "filepath", "file", "target_file", "targetFile"] },
    { canonical: "old_string", aliases: ["old_str", "oldText", "old_text"] },
    { canonical: "new_string", aliases: ["new_str", "newText", "new_text"] },
  ],
  glob: [
    { canonical: "path", aliases: ["dir", "directory", "dir_path"] },
    { canonical: "pattern", aliases: ["glob", "pattern_glob"] },
  ],
  grep: [
    { canonical: "path", aliases: ["dir", "directory", "dir_path"] },
    { canonical: "pattern", aliases: ["regex", "search_pattern"] },
  ],
  read_image: [{ canonical: "file_path", aliases: ["path", "image_path", "image"] }],
};

/**
 * Rename invented parameter keys to their canonical names, schema-guarded.
 * @returns A corrected copy and change labels, or undefined when nothing
 *          applies (healthy call, unknown tool, ambiguous, or no schema).
 */
export function renameAliasArgs(
  toolName: string,
  rawArgs: unknown,
  toolDefinition: unknown,
): { args: Record<string, unknown>; changes: string[] } | undefined {
  const rules = TOOL_ALIASES[toolName];
  if (!rules) return undefined;
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return undefined;
  }
  const schema = extractSchema(toolDefinition);
  const properties = schema?.properties;
  if (!properties) return undefined; // no schema → no certainty → no rename

  const source = rawArgs as Record<string, unknown>;
  let copy: Record<string, unknown> | undefined;
  // Later rules in this pass must see earlier renames; the caller's object
  // is never mutated (PreStage contract), so renames read through `view`.
  let view: Record<string, unknown> = source;
  const changes: string[] = [];

  for (const rule of rules) {
    if (!(rule.canonical in properties)) continue; // not a property of this tool
    if (view[rule.canonical] !== undefined) continue; // canonical already set
    const present = rule.aliases.filter(
      (alias) => view[alias] !== undefined && !(alias in properties),
    );
    if (present.length !== 1) continue; // zero → nothing; two+ → ambiguous
    const alias = present[0];
    if (copy === undefined) {
      copy = { ...source };
      view = copy;
    }
    copy[rule.canonical] = copy[alias];
    delete copy[alias];
    changes.push(`Renamed "${alias}" to the tool's parameter "${rule.canonical}"`);
  }

  return changes.length > 0 ? { args: copy!, changes } : undefined;
}

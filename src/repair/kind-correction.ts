/**
 * Kind-correction mechanics — the KIND_CORRECTION rule (rule 10).
 *
 * "Wrong door" mistakes: the model knocks on a directory with the file
 * reader. Pure helpers only — no I/O, no dispatch: the stage owns the flow,
 * this module owns recognition and candidate choice.
 *
 * @module dsh-tool-doctor/repair/kind-correction
 */

/**
 * Error-text/code markers of a directory-vs-file kind mistake. Verified
 * against the host: `read` on a directory answers
 * `Error: cannot read "…": not a regular file`; Node surfaces EISDIR /
 * ENOTDIR codes for the same family.
 */
export function isDirectoryAccessError(
  code: string | undefined,
  text: string | undefined,
): boolean {
  if (code === "EISDIR" || code === "ENOTDIR") return true;
  return /not a regular file|is a directory|EISDIR|ENOTDIR|illegal operation on a directory/i.test(
    text ?? "",
  );
}

/** Argument keys whose string value may name the directory that was hit. */
const LOCATION_KEYS = [
  "path",
  "file_path",
  "file",
  "target_file",
  "target_path",
  "dir",
  "directory",
] as const;

/**
 * The directory path a failed call was addressed at: the first string value
 * under a location key. The failing path IS the directory (the model aimed a
 * file tool at one), so the value is used as-is — no parent-directory logic.
 */
export function directoryFromArgs(rawArgs: unknown): string | undefined {
  if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return undefined;
  }
  const args = rawArgs as Record<string, unknown>;
  for (const key of LOCATION_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** Listing-tool candidates, most common spelling first. */
const LISTING_TOOLS = [
  "list_directory",
  "read_dir",
  "list_dir",
  "list_files",
  "read_directory",
  "ls",
  "dir",
] as const;

/**
 * The listing tool to hand the directory to: the first candidate present in
 * the agent-visible enumeration (case-insensitive; the CALLER's spelling is
 * returned so dispatch uses the registered name). Undefined when the plane
 * offers none — the original error then stands.
 */
export function chooseListingTool(
  registeredNames: readonly string[],
): string | undefined {
  for (const wanted of LISTING_TOOLS) {
    const hit = registeredNames.find((name) => name.toLowerCase() === wanted);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Schema keys that declare "which directory to list", most common first. */
const DIRECTORY_PARAMS = ["path", "directory", "dir", "folder", "target_directory"] as const;

/**
 * Arguments for the listing tool, built from ITS OWN definition: the first
 * declared directory parameter receives `dir`; a REQUIRED `pattern` gets "*"
 * (listing everything). No usable directory parameter → undefined rather
 * than an invented argument shape. A definition without a readable schema
 * falls back to `{ path: dir }` — `path` is the host convention.
 */
export function listingArgsFor(
  toolDefinition: unknown,
  dir: string,
): Record<string, unknown> | undefined {
  const schema = readInputSchema(toolDefinition);
  if (schema === undefined) return { path: dir };
  const properties = schema.properties;
  if (properties === null || typeof properties !== "object") return { path: dir };
  const props = properties as Record<string, unknown>;
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as readonly unknown[]) : [],
  );
  const directoryKey = DIRECTORY_PARAMS.find((key) => key in props);
  if (directoryKey === undefined) return undefined;
  const args: Record<string, unknown> = { [directoryKey]: dir };
  if (required.has("pattern") && typeof props["pattern"] === "object") args["pattern"] = "*";
  return args;
}

/** The JSON-schema view of a tool definition, or undefined when absent. */
function readInputSchema(toolDefinition: unknown):
  | { properties?: unknown; required?: unknown }
  | undefined {
  if (toolDefinition === null || typeof toolDefinition !== "object") return undefined;
  const def = toolDefinition as Record<string, unknown>;
  const schema = def["inputSchema"] ?? def["parameters"];
  if (schema === null || typeof schema !== "object") return undefined;
  return schema as { properties?: unknown; required?: unknown };
}

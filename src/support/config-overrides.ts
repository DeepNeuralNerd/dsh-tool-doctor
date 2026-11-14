/**
 * Durable rule-toggle overrides for the tool doctor.
 *
 * Panel toggles are runtime state the user owns; the Cordis composition
 * config (cordis.patch.yml) stays the deployment default. Both meet here:
 * persisted overrides (JSON file under DSH_HOME) are merged OVER the
 * composition config at startup, so a deployment default and a personal
 * toggle never fight across restarts.
 *
 * @module dsh-tool-doctor/support/config-overrides
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DoctorConfig } from "../types.ts";

/** Boolean config keys the panel may toggle, mirroring {@link DoctorConfig}. */
export const TOGGLE_KEYS: ReadonlyArray<keyof DoctorConfig> = [
  "autoWrapRunCode",
  "autoBridgeDirectTools",
  "autoClampRanges",
  "autoObserveFiles",
  "injectPrompt",
  "errorHints",
  "persistPassthrough",
  "healResponseTools",
  "shadowMode",
];

/** Overrides file lives beside the event log, under the DSH home directory. */
export function overridesPath(): string {
  const home = process.env["DSH_HOME"] ?? join(homedir(), ".dsh");
  return join(home, "tool-doctor-config.json");
}

export type PatchResult =
  | { ok: true; patch: Partial<DoctorConfig> }
  | { ok: false; error: string };

/**
 * Validate a decoded JSON body as a rule-toggle patch: a plain object with at
 * least one known boolean flag key. Unknown keys are rejected so a typo cannot
 * silently do nothing, and an empty patch is rejected so the caller sees a
 * real error instead of a no-op success.
 */
export function validateTogglePatch(raw: unknown): PatchResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object of boolean flags" };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    return { ok: false, error: "patch is empty" };
  }
  const patch: Partial<DoctorConfig> = {};
  for (const [key, value] of entries) {
    if (!(TOGGLE_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown config key: ${key}` };
    }
    if (typeof value !== "boolean") {
      return { ok: false, error: `${key} must be a boolean` };
    }
    patch[key as keyof DoctorConfig] = value;
  }
  return { ok: true, patch };
}

/**
 * Load persisted overrides. Any read, parse, or shape problem degrades to "no
 * overrides" — a corrupt file must never take the plugin down, and the next
 * successful save rewrites it whole.
 */
export function loadOverrides(path: string = overridesPath()): Partial<DoctorConfig> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Partial<DoctorConfig> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if ((TOGGLE_KEYS as readonly string[]).includes(key) && typeof value === "boolean") {
        out[key as keyof DoctorConfig] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Merge a validated patch into the persisted file and write it. Throws on an
 * unwritable location so the route can report the failure honestly.
 */
export function saveOverrides(
  patch: Partial<DoctorConfig>,
  path: string = overridesPath(),
): Partial<DoctorConfig> {
  const merged: Partial<DoctorConfig> = { ...loadOverrides(path), ...patch };
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return merged;
}

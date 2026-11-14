/**
 * Error signature normalization and unhealed-error candidate grouping.
 *
 * Turns the tracker's failed records into a compact, deduplicated list of
 * recurring error patterns ("candidates"), each judged against the plugin's
 * existing healing rules:
 *
 * - `attempted-failed`     — a rule already recognized this anomaly class and
 *                            its repair attempt failed. Improve that rule.
 * - `possible-existing`    — the error text matches an existing rule's
 *                            territory but no rule ran on it: a coverage gap.
 * - `new-rule-candidate`   — no rule covers the pattern: raw material for a
 *                            new healing rule.
 *
 * Signatures collapse volatile parts (paths, ids, numbers, quoted payloads)
 * so one recurring mistake folds into one candidate row. Stdlib-only and
 * side-effect-free: shared by the dashboard client and the unit tests.
 *
 * @module dsh-tool-doctor/support/error-signatures
 */

import type { ConfigFlag, DoctorConfig, HealCategory } from "../types.ts";
import type { NormalizerRecord } from "./tracker.ts";
import { CATEGORY_META, CATEGORY_TO_FLAG } from "../stages/index.ts";

/** How the existing rule set relates to one error pattern. */
export type CandidateVerdict =
  | "attempted-failed"
  | "possible-existing"
  | "new-rule-candidate";

/**
 * What the panel can offer as a fix for one recurring pattern. `enable-flag`
 * is one-click actionable (the owning rule is switched off); the others are
 * guidance for the operator, not a runtime action.
 */
export type ProposedFixKind = "enable-flag" | "gate-gap" | "refine-rule" | "new-rule";

export interface ProposedFix {
  kind: ProposedFixKind;
  /** Toggle that resolves the fix, when one does. */
  flag?: ConfigFlag;
  /** Healing rule involved, when one is. */
  rule?: number;
}

/**
 * Fix-proposal eligibility. A single unlucky call is not a pattern: the panel
 * only offers fixes once the SAME signature has failed repeatedly AND over a
 * meaningful span of time — enough evidence that acting is justified rather
 * than reacting to noise.
 */
export const FIX_PROPOSE_MIN_COUNT = 3;
export const FIX_PROPOSE_MIN_SPAN_MS = 10 * 60 * 1000;

/** One recurring unhealed error pattern. */
export interface ErrorCandidate {
  /** Stable group key: tool + normalized signature. */
  key: string;
  toolName: string;
  signature: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  verdict: CandidateVerdict;
  /** 1-based healing-rule number the pattern maps to, when one does. */
  ruleHint?: number;
  /**
   * Whether enough evidence has accumulated (recurrence × elapsed span) to
   * offer a fix. Until true, the pattern is under observation only.
   */
  fixable: boolean;
  /** Offered fix, present once `fixable`. */
  proposedFix?: ProposedFix;
  /** Categories observed under this signature (deduplicated). */
  categories: HealCategory[];
  /** Evidence from the most recent matching record. */
  sample: {
    errorMessage: string;
    originalArgsPreview: string;
    recordIds: string[];
  };
}

/**
 * Healing-rule number each anomaly category's repair attempt belongs to.
 * Derived from the stage registry so a new rule carries its own number — no
 * second table to keep in sync here. PASSTHROUGH means no rule attempted the
 * call (absent, not zero).
 */
export const CATEGORY_TO_RULE: Partial<Record<HealCategory, number>> =
  Object.fromEntries(
    (Object.keys(CATEGORY_META) as HealCategory[])
      .map((category) => [category, CATEGORY_META[category].ruleNumber])
      .filter((entry): entry is [HealCategory, number] => entry[1] !== undefined),
  );

/**
 * Config flags whose stages carry each rule's repairs, in registry order.
 * Derived from the same registry as the categories; a rule spans several
 * stages (rule 1 covers run-code AND the clamp family), so a fix proposal
 * picks the first currently-DISABLED flag of the rule when one exists.
 */
export const RULE_FLAGS: ReadonlyMap<number, readonly ConfigFlag[]> = (() => {
  const map = new Map<number, ConfigFlag[]>();
  for (const category of Object.keys(CATEGORY_TO_RULE) as HealCategory[]) {
    const rule = CATEGORY_TO_RULE[category];
    const flag = CATEGORY_TO_FLAG[category];
    if (rule === undefined || flag === undefined) continue;
    const list = map.get(rule) ?? [];
    if (!list.includes(flag)) list.push(flag);
    map.set(rule, list);
  }
  return map;
})();

/**
 * The fix offered for one pattern given the effective config: a rule that is
 * switched off is a one-click fix; an on-but-skipped rule is a gate gap for
 * the operator to refine; a failed attempt asks for rule refinement; an
 * uncovered pattern is raw material for a new rule.
 */
export function proposeFix(
  verdict: CandidateVerdict,
  ruleHint: number | undefined,
  config?: DoctorConfig,
): ProposedFix {
  if (verdict === "attempted-failed") return { kind: "refine-rule", rule: ruleHint };
  if (verdict === "possible-existing" && ruleHint !== undefined) {
    const flags = RULE_FLAGS.get(ruleHint) ?? [];
    const off = config === undefined ? undefined : flags.find((f) => config[f] === false);
    if (off !== undefined) return { kind: "enable-flag", flag: off, rule: ruleHint };
    return { kind: "gate-gap", rule: ruleHint, ...(flags[0] ? { flag: flags[0] } : {}) };
  }
  if (verdict === "new-rule-candidate") return { kind: "new-rule" };
  return { kind: "gate-gap", ...(ruleHint !== undefined ? { rule: ruleHint } : {}) };
}

/** Enough recurrences over enough elapsed time to justify offering a fix. */
export function fixEligible(count: number, firstSeen: number, lastSeen: number): boolean {
  return count >= FIX_PROPOSE_MIN_COUNT && lastSeen - firstSeen >= FIX_PROPOSE_MIN_SPAN_MS;
}

/**
 * Error-text hints toward an existing rule for failures no rule processed.
 * Narrow by design: a hint claims "this rule's territory was skipped", so a
 * false hint is worse than none — a truly new pattern must read as new.
 * Exported for the client-mirror parity test (src/client/mirror.ts).
 */
export const TEXT_RULE_HINTS: ReadonlyArray<{ rule: number; test: RegExp }> = [
  { rule: 1, test: /\brun_code\b|run[- ]code\s+(?:code|description)/i },
  { rule: 2, test: /unknown tool|tool .*not (?:found|registered)/i },
  { rule: 3, test: /view_range|line (?:range|count)|out[- ]of[- ]range/i },
  { rule: 4, test: /FS_NOT_OBSERVED|FS_STALE_VERSION|not (?:been )?observed|string to replace|old_string/i },
  { rule: 7, test: /<tool_call|<function=|\[TOOL_CALLS\]/i },
  { rule: 9, test: /expected (?:a |an )?(?:number|boolean|array|object)|arguments (?:must|should) be|not (?:valid|parseable) JSON/i },
  { rule: 10, test: /not a regular file|is a directory|EISDIR|ENOTDIR|illegal operation on a directory/i },
];

/** Longest signature kept; longer text is clipped with an ellipsis. */
const SIGNATURE_MAX = 180;

/**
 * Collapse the volatile parts of an error message into stable placeholders so
 * the same recurring mistake produces one signature regardless of the paths,
 * ids, or numbers that happened to be in the failing call.
 */
export function normalizeErrorSignature(errorMessage: string): string {
  let text = (errorMessage || "").replace(/\s+/g, " ").trim();
  if (text.length === 0) return "(no error message)";
  // Quoted / backticked payloads first: they often embed paths and numbers,
  // and the quoting itself is the stable part of the pattern.
  text = text.replace(/"[^"]*"/g, "<str>");
  text = text.replace(/'[^']*'/g, "<str>");
  text = text.replace(/`[^`]*`/g, "<str>");
  // Windows paths (`C:\dir\file`), then unix-ish paths with two or more
  // segments. Both may carry escaped separators when lifted from JSON.
  text = text.replace(/[A-Za-z]:[\\/][^\s,;"']+/g, "<path>");
  text = text.replace(/(?:[\\/][\w.~-]+){2,}/g, "<path>");
  // UUIDs before bare numbers (a UUID contains digits between its dashes).
  text = text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "<id>",
  );
  text = text.replace(/\b[0-9a-f]{12,}\b/gi, "<id>");
  text = text.replace(/\b\d+(?:\.\d+)*\b/g, "<n>");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > SIGNATURE_MAX) {
    text = `${text.slice(0, SIGNATURE_MAX - 1)}…`;
  }
  return text;
}

/** Rule number whose territory the text hints at, when any does. */
export function hintRule(errorMessage: string): number | undefined {
  for (const { rule, test } of TEXT_RULE_HINTS) {
    if (test.test(errorMessage)) return rule;
  }
  return undefined;
}

interface CandidateGroup {
  key: string;
  toolName: string;
  signature: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  categories: Set<HealCategory>;
  healedCategories: HealCategory[];
  latest: NormalizerRecord;
  recordIds: string[];
}

/**
 * Group failed records into deduplicated recurring error candidates.
 * @param records - Tracker records (any status); only failures are grouped.
 * @param limit - Maximum candidates returned (default 60).
 * @param config - Effective flags, used to turn a coverage gap into a concrete
 *   "enable the owning rule" proposal; omitted means proposals are given
 *   without flag resolution.
 */
export function buildErrorCandidates(
  records: readonly NormalizerRecord[],
  limit = 60,
  config?: DoctorConfig,
): ErrorCandidate[] {
  const groups = new Map<string, CandidateGroup>();
  for (const record of records) {
    if (record.status !== "failed") continue;
    const signature = normalizeErrorSignature(record.errorMessage ?? "");
    const key = `${record.toolName} ${signature}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        toolName: record.toolName,
        signature,
        count: 0,
        firstSeen: record.time,
        lastSeen: record.time,
        categories: new Set(),
        healedCategories: [],
        latest: record,
        recordIds: [],
      };
      groups.set(key, group);
    }
    group.count += 1;
    if (record.time < group.firstSeen) group.firstSeen = record.time;
    if (record.time >= group.lastSeen) {
      group.lastSeen = record.time;
      group.latest = record;
    }
    group.categories.add(record.category);
    if (
      record.category !== "PASSTHROUGH" &&
      !group.healedCategories.includes(record.category)
    ) {
      group.healedCategories.push(record.category);
    }
    if (group.recordIds.length < 10) group.recordIds.push(record.id);
  }

  const candidates: ErrorCandidate[] = [];
  for (const group of groups.values()) {
    let verdict: CandidateVerdict;
    let ruleHint: number | undefined;
    if (group.healedCategories.length > 0) {
      // A healing rule ran on this pattern and the call still failed.
      verdict = "attempted-failed";
      ruleHint = CATEGORY_TO_RULE[group.healedCategories[0]!];
    } else {
      const hinted = hintRule(group.latest.errorMessage ?? "");
      verdict = hinted !== undefined ? "possible-existing" : "new-rule-candidate";
      ruleHint = hinted;
    }
    const fixable = fixEligible(group.count, group.firstSeen, group.lastSeen);
    candidates.push({
      key: group.key,
      toolName: group.toolName,
      signature: group.signature,
      count: group.count,
      firstSeen: group.firstSeen,
      lastSeen: group.lastSeen,
      verdict,
      ruleHint,
      fixable,
      ...(fixable ? { proposedFix: proposeFix(verdict, ruleHint, config) } : {}),
      categories: [...group.categories],
      sample: {
        errorMessage: group.latest.errorMessage ?? "",
        originalArgsPreview: group.latest.originalArgsPreview ?? "",
        recordIds: group.recordIds,
      },
    });
  }
  candidates.sort(
    (a, b) =>
      b.count - a.count || b.lastSeen - a.lastSeen || a.key.localeCompare(b.key),
  );
  return candidates.slice(0, limit);
}

/** Human verdict sentence for one candidate (English-only panel voice). */
export function verdictText(candidate: ErrorCandidate): string {
  switch (candidate.verdict) {
    case "attempted-failed":
      return `Healing rule ${candidate.ruleHint ?? "?"} attempted this and the call still failed — refine that rule.`;
    case "possible-existing":
      return `Matches healing rule ${candidate.ruleHint ?? "?"} territory, but no rule ran — check why it was skipped.`;
    default:
      return "No existing healing rule covers this pattern — candidate for a new rule.";
  }
}

/** One-line bounded preview of the sample arguments for the report. */
function clip(text: string, max = 400): string {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Markdown report of the current candidates, sized to paste into an agent
 * session so the model can evaluate them for new healing rules.
 */
export function candidateReportMarkdown(
  candidates: readonly ErrorCandidate[],
  now: Date = new Date(),
): string {
  const lines: string[] = [];
  lines.push("# Tool-doctor — unhealed error candidates");
  lines.push(`Generated: ${now.toISOString()}`);
  lines.push("");
  lines.push("| Tool | × | Verdict | Rule | Error signature |");
  lines.push("| --- | --: | --- | --- | --- |");
  for (const c of candidates) {
    const verdict =
      c.verdict === "attempted-failed"
        ? "rule attempted, failed"
        : c.verdict === "possible-existing"
          ? "rule coverage gap"
          : "new rule candidate";
    lines.push(
      `| ${c.toolName} | ${c.count} | ${verdict} | ${c.ruleHint ?? "-"} | ${c.signature.replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");
  lines.push("## Details");
  candidates.forEach((c, i) => {
    lines.push("");
    lines.push(`### ${i + 1}. ${c.toolName} — ${c.count}×`);
    lines.push(`- ${verdictText(c)}`);
    lines.push(`- Categories: ${c.categories.join(", ")}`);
    lines.push(`- First seen: ${new Date(c.firstSeen).toISOString()}`);
    lines.push(`- Last seen: ${new Date(c.lastSeen).toISOString()}`);
    lines.push(`- Sample error: ${clip(c.sample.errorMessage, 500)}`);
    if (c.sample.originalArgsPreview) {
      lines.push(`- Sample args: ${clip(c.sample.originalArgsPreview)}`);
    }
  });
  return lines.join("\n");
}

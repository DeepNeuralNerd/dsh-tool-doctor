/**
 * Localization strings for the tool-doctor client UI.
 *
 * Every user-visible string in the dashboard resolves through this dictionary;
 * `en` is the fallback voice and the only locale shipped with the plugin. The
 * host may register other locales under the same namespace — the section's
 * translator falls back to these strings key by key.
 *
 * @module dsh-tool-doctor/client/locales
 */

export const en = {
  nav: "Tool Doctor",
  title: "Tool Doctor — call diagnostics & healing dashboard",
  subtitle:
    "Inspect intercepted tool calls, review repairs and failures, and tune the healing rules.",

  refresh: "Refresh",
  autoRefresh: "Auto-refresh (5s)",
  clear: "Clear records",
  apiErrorStats: "Could not load stats from the plugin API — showing last saved data.",
  apiErrorReset: "Reset request failed — data was kept as-is.",
  apiErrorConfig: "Could not reach the config endpoint — toggles may be stale.",
  apiErrorGuidance: "Could not reach the guidance endpoint.",

  // Tabs
  tabLive: "Live",
  tabAnalytics: "Analytics",
  tabErrors: "Errors",
  tabRules: "Rules",

  // KPI hero row
  kpiTotal: "Intercepted calls",
  kpiTotalDesc: "Cumulative tool dispatches captured by the doctor.",
  kpiRate: "Healing success rate",
  kpiRateDesc: "Share of repair attempts that ended in a successful call.",
  kpiHealed: "Healed calls",
  kpiHealedFailedSuffix: "failed repairs",
  kpiPromoted: "Promoted calls",
  kpiPromotedDesc:
    "Tool-call markup lifted out of streamed text (no execution outcome yet).",
  kpiSavedTokens: "Estimated tokens saved",
  kpiSavedTokensDesc:
    "Metered input tokens avoided across successful repairs (estimate).",
  estimateBadge: "Estimate",
  kpiUnrecovered: "Unrecovered errors",
  kpiUnrecoveredDesc:
    "Failed calls the doctor could not resolve — both after a failed repair and without one. Matches the Errors tab.",
  kpiShadow: "Would repair (shadow)",
  kpiShadowDesc:
    "Shadow mode matched these rules but dispatched the original arguments — measured coverage, not applied repairs.",

  // Status labels
  statusHealed: "Healed",
  statusFailed: "Failed",
  statusPassthrough: "Passed through",
  statusPromoted: "Promoted",

  // Live table & filters
  filterAll: "All events",
  filterHealed: "Healed only",
  filterFailed: "Failed only",
  filterPromoted: "Promoted only",
  searchPlaceholder: "Search tool, category, or args…",
  colTime: "Time",
  colTool: "Tool",
  colCategory: "Category",
  colStatus: "Status",
  noData: "No records yet",
  noDataDesc:
    "When the agent calls tools, interception and repair details appear here in real time.",

  // Diff view
  beforeInput: "Original args (before)",
  afterInput: "Repaired args (after)",
  afterUnchanged: "(unchanged)",
  changeSummary: "Changes",
  diffDetails: "Show diff",
  hideDetails: "Hide diff",
  errorDetail: "Error",

  // Analytics
  healthScoreTitle: "Tool-call health",
  healthGood: "Excellent — most anomalies are absorbed by the healing rules.",
  healthFair:
    "Good — occasional uncaught errors; review the model's prompt conventions.",
  healthWarn:
    "Needs attention — many unrecovered anomalies; check the environment and local dependencies.",
  toolRankTitle: "Intercepted calls by tool",
  categoryRankTitle: "Events by repair category",
  failuresToolTitle: "Failed calls by tool",
  failuresCategoryTitle: "Failures by category",
  rankEmpty: "No data yet",

  // Errors tab
  errorsIntro:
    "Unrecovered tool-call errors, grouped into recurring patterns. Each candidate is judged against the existing healing rules.",
  errorsPatternsTitle: "Error patterns",
  errorsUnrecoveredTitle: "Unrecovered failures",
  errorsNewTitle: "New-rule candidates",
  errorsEmptyTitle: "No unrecovered errors",
  errorsEmptyDesc:
    "Every recorded failure was repaired or has not recurred yet. New patterns will appear here for rule evaluation.",
  verdictAttempted: "Rule attempted, failed",
  verdictGap: "Coverage gap",
  verdictNew: "New rule candidate",
  verdictAttemptedText:
    "Healing rule {rule} attempted this and the call still failed — refine that rule.",
  verdictGapText:
    "Matches healing rule {rule} territory, but no rule ran — check why it was skipped.",
  verdictNewText:
    "No existing healing rule covers this pattern — candidate for a new rule.",
  errorsSample: "Latest failing call",
  errorsShowSample: "Evidence",
  errorsHideSample: "Hide evidence",
  firstSeen: "First seen",
  lastSeen: "Last seen",

  // Rules tab
  rulesTitle: "Healing rules & diagnostics",
  rule1Title: "run_code argument repair",
  rule1Desc:
    "Fixes run_code schema mismatches (command→code, missing description — including descriptions inside embedded tool() calls), strips Markdown fences, and heals common syntax slips.",
  rule2Title: "Unknown-tool recovery",
  rule2Desc:
    "Re-dispatches UNKNOWN_TOOL results as nested host calls when the target tool is registered in scope, and retries name drift (case, MCP-namespace segments like bash↔mcp__shell__bash) when the tool plane holds exactly one matching name; direct calls rejected early by the host cannot be intercepted.",
  rule3Title: "Range & path normalization",
  rule3Desc:
    "Clamps out-of-bounds ranges (view_range, read offset past EOF), resolves session-relative paths against the working directory, drops out-of-workspace sourcePaths, and unwraps quoted paths.",
  rule4Title: "Observe-then-retry",
  rule4Desc:
    "After an edit/write hits FS_NOT_OBSERVED or FS_STALE_VERSION, reads the target once and retries through the host dispatcher; anchor-lost errors only refresh observation state without a blind retry.",
  rule5Title: "Prompt guidance injection",
  rule5Desc:
    "Injects concise best-practice guidance into the model's system context to reduce tool-call errors at the source (see editor below).",
  rule6Title: "Failure hints",
  rule6Desc:
    "Appends an actionable recovery hint to otherwise-unrecovered error results; the original error text is preserved so the model can self-correct in the same turn.",
  rule7Title: "In-text tool-call promotion",
  rule7Desc:
    "Promotes recognized tool-call markup written inside streamed replies into real structured tool blocks, leaving markers inside code fences and think blocks untouched.",
  rule8Title: "Passthrough trace persistence",
  rule8Desc:
    "Also persists successful untouched calls in the detailed JSONL trace; aggregate counters are unaffected either way.",
  ruleSchemaTitle: "Schema-shaped arguments (rule 9)",
  ruleSchemaDesc:
    "Repairs structurally wrong arguments only when re-parse proves it: a JSON payload replayed as a string, one-level {\"arguments\":…} wrapper nesting, and string↔number/boolean/array drift where the tool's schema declares the real type.",
  rulePathsTitle: "Path separator normalization",
  rulePathsDesc:
    "Canonicalizes Windows↔POSIX separator drift where the rewrite is lossless and expands ~ home prefixes in path arguments, before the scope and quote rules see them.",
  ruleFuzzyTitle: "Whitespace-tolerant edit retry",
  ruleFuzzyDesc:
    "When an edit reports old_string not found, retries it once per whitespace-equivalent anchor spelling (CRLF↔LF, tabs↔spaces). The host stays the match authority: an ambiguous variant is rejected, never guessed.",
  ruleKindTitle: "Directory kind correction (rule 10)",
  ruleKindDesc:
    'When a file reader hits a directory ("not a regular file"/EISDIR), the intent is unambiguous — the model wants the folder\'s contents — so the call is re-dispatched to a listing tool the agent can actually call, with arguments built from that tool\'s own definition. No listing tool in scope: the original error stands.',
  ruleShadowTitle: "Shadow mode (measure only)",
  ruleShadowDesc:
    "Evaluates every pre-dispatch repair and records what the rules WOULD fix, but dispatches the original arguments and runs no retries or hints — measure a rule's coverage before trusting it to act.",
  statusActive: "On",
  statusInactive: "Off",
  ruleTagActiveHint: "On — click to turn this rule off",
  ruleTagInactiveHint: "Off — click to turn this rule on",
  ruleToggleFailed: "Could not change the rule",
  ruleHealthTitle: "Rule health by category",
  ruleHealthTotal: "events",
  ruleHealthFailed: "failed",
  lastFiredPrefix: "last",
  breakerOpen: "retries paused",
  breakerOpenHint:
    "This category failed its recoveries too often inside the window; retries stay paused until the circuit closes.",

  // Error-candidate fix proposals
  proposedFixLabel: "Proposed fix",
  fixEnableFlag:
    "Healing rule {rule} owns this error class and is currently OFF — turning it on should absorb this pattern.",
  fixGateGap:
    "Healing rule {rule} is ON but its gate skipped this variant — inspect the sample; likely a gate case the rule does not cover yet.",
  fixRefineRule:
    "Healing rule {rule} attempted this and the call still failed — the sample shows a variant the repair does not cover.",
  fixNewRule:
    "No healing rule covers this pattern yet — keep collecting samples, then author a stage for it.",
  fixApplyButton: "Turn on {rule}",
  watchNeedMore:
    "Under observation — {n} more failures of this exact pattern, spread over 10+ minutes, unlock a fix proposal.",
  watchNeedTime:
    "Under observation — this pattern needs about {m} more minutes of recurrence before a fix is offered.",
  errorsFixableTitle: "fixes offered",
  exportCsv: "Export CSV",
  exportJson: "Export JSON",

  // Guidance editor
  guidanceTitle: "Model prompt guidance",
  guidanceDesc:
    "Injected into the model's system context every turn. Changes apply immediately, no restart needed.",
  guidancePlaceholder: "Enter prompt content…",
  guidanceSaveBtn: "Save changes",
  guidanceDefaultBtn: "Restore default",
  guidanceSaveSuccess: "Guidance updated",
  guidanceSaveError: "Save failed — the host rejected or missed the request.",
  guidanceResetSuccess: "Factory default restored",
  guidanceDirty: "Unsaved changes",
  guidanceLines: "lines",
  guidanceChars: "chars",
  guidanceDefaultTitle: "Factory default (read-only)",
  guidanceEmpty: "(empty)",

  times: "×",
};

/** Every translatable key in the dashboard. */
export type NormalizerKey = keyof typeof en;

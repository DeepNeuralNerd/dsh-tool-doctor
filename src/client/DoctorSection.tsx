/**
 * Tool Doctor dashboard rendered into the Settings panel.
 *
 * Every displayed number comes from the store's adopted snapshots; there is no
 * seeded demo data, so an unpopulated deployment renders the designed empty
 * state until real events arrive through the host API. The error-signature
 * helpers below are client-local mirrors of src/support/error-signatures.ts —
 * the browser bundle must stay self-contained and never import server modules.
 *
 * @module dsh-tool-doctor/client/DoctorSection
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { HealCategory } from "../types.ts";
import { en, type NormalizerKey } from "./locales.ts";
import { JsonBlock } from "./JsonBlock.tsx";
import { previewsUnchanged } from "./json-format.ts";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  CATEGORY_TO_RULE,
  FIX_PROPOSE_MIN_COUNT,
  FIX_PROPOSE_MIN_SPAN_MS,
  RULES,
  RULE_GROUPS,
  fixEligible,
  hintRule,
  normalizeErrorSignature,
  proposeFix,
  type CandidateVerdict,
  type ProposedFix,
} from "./mirror.ts";
import {
  createEmptyStats,
  type DoctorErrorSource,
  type DoctorState,
  type DoctorStore,
  type NormalizerRecord,
} from "./store.ts";
import styles from "./DoctorSection.module.css";

type TFn = (key: NormalizerKey) => string;

/** One recurring unhealed error pattern. */
interface ErrorCandidate {
  key: string;
  toolName: string;
  signature: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  verdict: CandidateVerdict;
  ruleHint?: number;
  fixable: boolean;
  proposedFix?: ProposedFix;
  categories: string[];
  sample: { errorMessage: string; originalArgsPreview: string };
}

interface CandidateGroup {
  key: string;
  toolName: string;
  signature: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  categories: Set<string>;
  healedCategories: string[];
  latest: NormalizerRecord;
}

/**
 * Group failed records into deduplicated recurring error candidates, judged
 * against the existing rule set. Mirrors buildErrorCandidates on the server.
 */
function buildErrorCandidates(
  records: readonly NormalizerRecord[],
  limit = 60,
  config?: Record<string, boolean> | null,
): ErrorCandidate[] {
  const groups = new Map<string, CandidateGroup>();
  for (const record of records) {
    if (record.status !== "failed") continue;
    const signature = normalizeErrorSignature(record.errorMessage ?? "");
    const key = `${record.toolName} ${signature}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key, toolName: record.toolName, signature, count: 0,
        firstSeen: record.time, lastSeen: record.time,
        categories: new Set(), healedCategories: [], latest: record,
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
  }

  const candidates: ErrorCandidate[] = [];
  for (const group of groups.values()) {
    let verdict: CandidateVerdict;
    let ruleHint: number | undefined;
    if (group.healedCategories.length > 0) {
      // A healing rule ran on this pattern and the call still failed.
      verdict = "attempted-failed";
      ruleHint = CATEGORY_TO_RULE[group.healedCategories[0] as HealCategory];
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
      },
    });
  }
  candidates.sort(
    (a, b) =>
      b.count - a.count || b.lastSeen - a.lastSeen || a.key.localeCompare(b.key),
  );
  return candidates.slice(0, limit);
}

// ── Registration contract ────────────────────────────────────────────────────

/** Inject face supplied by the plugin registration. */
export interface DoctorSectionInjected {
  controller: DoctorStore;
  t: TFn;
}

/**
 * Full component props. The host may spread the inject face as top-level props
 * or pass it nested under `injected`; both shapes are accepted so bare renders
 * (no controller) still work for previews and tests.
 */
export interface DoctorSectionProps extends Partial<DoctorSectionInjected> {
  injected?: DoctorSectionInjected;
}

// ── Icons: one 16px stroke voice, currentColor everywhere ───────────────────

function Icon(props: { children: ReactNode }): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {props.children}
    </svg>
  );
}

const PulseIcon = (): ReactElement => (
  <Icon><path d="M1.5 8h2.8l1.4-3.8 3 7.6 1.4-3.8h4.4" /></Icon>
);
const RefreshIcon = (): ReactElement => (
  <Icon><path d="M13.5 8a5.5 5.5 0 1 1-1.8-4.1" /><path d="M13.6 1.9v3.2h-3.2" /></Icon>
);
const TrashIcon = (): ReactElement => (
  <Icon><path d="M2.4 4.2h11.2" /><path d="M6.2 4.2V2.6h3.6v1.6" /><path d="M3.9 4.2 4.6 13a.8.8 0 0 0 .8.7h5.2a.8.8 0 0 0 .8-.7l.7-8.8" /></Icon>
);
const SearchIcon = (): ReactElement => (
  <Icon><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></Icon>
);
const ChevronIcon = (): ReactElement => (<Icon><path d="M4 6.2 8 10.2l4-4" /></Icon>);
const CopyIcon = (): ReactElement => (
  <Icon><rect x="5.6" y="5.6" width="8.2" height="8.2" rx="1.8" /><path d="M10.4 5.6V4a1.8 1.8 0 0 0-1.8-1.8H4a1.8 1.8 0 0 0-1.8 1.8v4.6A1.8 1.8 0 0 0 4 10.4h1.6" /></Icon>
);
const CheckIcon = (): ReactElement => (<Icon><path d="M3.2 8.4 6.4 11.6l6.4-7.2" /></Icon>);

// ── Small presentational pieces ──────────────────────────────────────────────

function StatusPill(props: { record: NormalizerRecord; t: TFn }): ReactElement {
  const { record, t } = props;
  if (record.status === "failed") {
    return <span className={`${styles.statusPill} ${styles.statusPillFail}`}>{t("statusFailed")}</span>;
  }
  if (record.status === "promoted") {
    // Its own honest state: markup became a tool call, execution is ahead.
    return <span className={`${styles.statusPill} ${styles.statusPillPromoted}`}>{t("statusPromoted")}</span>;
  }
  if (record.wasHealed) {
    return <span className={`${styles.statusPill} ${styles.statusPillOk}`}>{t("statusHealed")}</span>;
  }
  return <span className={`${styles.statusPill} ${styles.statusPillPass}`}>{t("statusPassthrough")}</span>;
}

function RankList(props: {
  title: string;
  entries: Array<[string, number]>;
  tone: "accent" | "ok" | "err";
  t: TFn;
}): ReactElement {
  const max = props.entries.length > 0 ? Math.max(...props.entries.map((e) => e[1])) : 1;
  const barClass =
    props.tone === "accent" ? styles.barAccent : props.tone === "ok" ? styles.barOk : styles.barErr;
  return (
    <div className={styles.rankCard}>
      <div className={styles.cardTitle}>{props.title}</div>
      {props.entries.length === 0 ? (
        <p className={styles.rankEmpty}>{props.t("rankEmpty")}</p>
      ) : (
        <div className={styles.rankList}>
          {props.entries.map(([name, count]) => (
            <div key={name} className={styles.rankItem}>
              <div className={styles.rankLabelRow}>
                <span className={styles.rankName} title={name}>{categoryLabel(name)}</span>
                <span className={styles.rankValue}>{count} {props.t("times")}</span>
              </div>
              <div className={styles.barBg}>
                <div
                  className={`${styles.barFill} ${barClass}`}
                  style={{ width: `${Math.max(6, Math.round((count / max) * 100))}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DiffDetail(props: {
  record: NormalizerRecord;
  t: TFn;
  copiedKey: string | null;
  onCopy: (key: string, text: string) => void;
}): ReactElement {
  const { record, t } = props;
  const unchanged = previewsUnchanged(record.originalArgsPreview, record.normalizedArgsPreview);
  return (
    <div className={styles.detailGrid}>
      {record.normalizationSummary && (
        <div className={styles.changeSummary}>
          <span className={styles.changeSummaryLabel}>{t("changeSummary")}</span>
          <span>{record.normalizationSummary}</span>
        </div>
      )}
      <div className={styles.diffColumns}>
        <div className={styles.diffBlock}>
          <div className={styles.diffLabelRow}>
            <span className={`${styles.diffLabel} ${styles.diffLabelBefore}`}>{t("beforeInput")}</span>
            <button
              type="button"
              className={styles.copyBtn}
              title={t("beforeInput")}
              aria-label={t("beforeInput")}
              onClick={() => props.onCopy(`${record.id}:before`, record.originalArgsPreview || "{}")}
            >
              {props.copiedKey === `${record.id}:before` ? <CheckIcon /> : <CopyIcon />}
            </button>
          </div>
          <JsonBlock code={record.originalArgsPreview || "{}"} className={`${styles.codeBox} ${styles.codeBefore}`} />
        </div>
        <div className={styles.diffBlock}>
          <div className={styles.diffLabelRow}>
            <span className={`${styles.diffLabel} ${styles.diffLabelAfter}`}>{t("afterInput")}</span>
            {!unchanged && (
              <button
                type="button"
                className={styles.copyBtn}
                title={t("afterInput")}
                aria-label={t("afterInput")}
                onClick={() => props.onCopy(`${record.id}:after`, record.normalizedArgsPreview ?? "")}
              >
                {props.copiedKey === `${record.id}:after` ? <CheckIcon /> : <CopyIcon />}
              </button>
            )}
          </div>
          {unchanged ? (
            <pre className={`${styles.codeBox} ${styles.codeUnchanged}`}>{t("afterUnchanged")}</pre>
          ) : (
            <JsonBlock code={record.normalizedArgsPreview ?? ""} className={`${styles.codeBox} ${styles.codeAfter}`} />
          )}
        </div>
      </div>
      {record.errorMessage && (
        <div className={styles.errorBlock}>
          <span className={styles.diffLabel}>{t("errorDetail")}</span>
          <pre className={`${styles.codeBox} ${styles.codeError}`}>{record.errorMessage}</pre>
        </div>
      )}
    </div>
  );
}

// ── Main section ─────────────────────────────────────────────────────────────

function KpiCard(props: {
  title: string;
  value: ReactNode;
  desc?: ReactNode;
  toneClass?: string;
  badge?: string;
  extra?: ReactNode;
  /** Secondary tier: smaller number, used below the outcome hero card. */
  small?: boolean;
}): ReactElement {
  return (
    <div className={`${styles.kpiCard} ${props.small ? styles.kpiCardSmall : ""}`}>
      <span className={styles.kpiTitle}>
        {props.title}
        {props.badge && <span className={styles.estimateBadge}>{props.badge}</span>}
      </span>
      <span className={`${styles.kpiValue} ${props.toneClass ?? ""}`}>{props.value}</span>
      {props.extra}
      {props.desc !== undefined && <span className={styles.kpiDesc}>{props.desc}</span>}
    </div>
  );
}

/**
 * Small time trend of ACTUAL outcomes from the recorded events: one stacked
 * mini-bar per time bucket, repaired under failed. Shadow matches are
 * excluded — nothing was dispatched for them, so they have no outcome.
 */
function OutcomeTrend({ records, t }: { records: NormalizerRecord[]; t: TFn }): ReactElement {
  const BUCKETS = 14;
  const actual = records.filter((r) => r.shadow !== true);
  const buckets = Array.from({ length: BUCKETS }, () => ({ ok: 0, bad: 0 }));
  let from = Infinity;
  let to = 0;
  for (const r of actual) {
    if (r.time < from) from = r.time;
    if (r.time > to) to = r.time;
  }
  if (actual.length > 0 && to > from) {
    for (const r of actual) {
      const i = Math.min(BUCKETS - 1, Math.floor(((r.time - from) / (to - from)) * BUCKETS));
      if (r.wasHealed && r.status === "success") buckets[i]!.ok += 1;
      else if (r.status === "failed") buckets[i]!.bad += 1;
    }
  }
  const max = Math.max(1, ...buckets.map((b) => b.ok + b.bad));
  const W = 280;
  const H = 48;
  const slot = W / BUCKETS;
  const hasAny = buckets.some((b) => b.ok + b.bad > 0);
  if (!hasAny) {
    return <p className={styles.trendEmpty}>{t("trendEmpty")}</p>;
  }
  const okTotal = buckets.reduce((s, b) => s + b.ok, 0);
  const badTotal = buckets.reduce((s, b) => s + b.bad, 0);
  return (
    <div className={styles.trendWrap}>
      <svg
        className={styles.trendSvg}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${new Date(from).toLocaleTimeString()} – ${new Date(to).toLocaleTimeString()}: ${okTotal} ${t("trendRepaired")}, ${badTotal} ${t("trendFailed")}`}
      >
        {buckets.map((b, i) => {
          const x = i * slot + slot * 0.18;
          const w = slot * 0.64;
          const okH = (b.ok / max) * H;
          const badH = (b.bad / max) * H;
          return (
            <g key={i}>
              {b.ok > 0 && <rect className={styles.trendBarOk} x={x} y={H - okH} width={w} height={okH} rx="1" />}
              {b.bad > 0 && <rect className={styles.trendBarErr} x={x} y={H - okH - badH} width={w} height={badH} rx="1" />}
            </g>
          );
        })}
      </svg>
      <div className={styles.trendLegend}>
        <span>
          <span className={`${styles.trendDot} ${styles.trendDotOk}`} aria-hidden="true" />
          {t("trendRepaired")}
        </span>
        <span>
          <span className={`${styles.trendDot} ${styles.trendDotErr}`} aria-hidden="true" />
          {t("trendFailed")}
        </span>
        <span className={styles.trendSpan}>
          {new Date(from).toLocaleTimeString()} – {new Date(to).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}

/** Human name for a config flag, reusing the rule-card titles. */
function flagLabel(flag: string): { titleKey: NormalizerKey } | undefined {
  const rule = RULES.find((r) => r.flag === flag);
  return rule !== undefined ? { titleKey: rule.titleKey } : undefined;
}

/** Which locale line to show for a store error, by failing surface. */
const ERROR_LINE: Record<DoctorErrorSource, NormalizerKey> = {
  stats: "apiErrorStats",
  reset: "apiErrorReset",
  config: "apiErrorConfig",
  guidance: "apiErrorGuidance",
};

function categoryLabel(category: string): string {
  return (CATEGORY_LABELS as Readonly<Record<string, string | undefined>>)[category] ?? category;
}

function idleState(): DoctorState {
  return {
    status: "idle",
    stats: createEmptyStats(),
    activeTab: "live",
    searchQuery: "",
    statusFilter: "all",
    config: null,
    candidates: null,
    polling: false,
    guidance: { text: null, defaultText: null },
    guidanceLoading: false,
    error: null,
  };
}

export function DoctorSection(props: DoctorSectionProps): ReactElement {
  const nested = props.injected;
  const controller = props.controller ?? nested?.controller;
  const t: TFn = (k) => {
    const v = (props.t ?? nested?.t)?.(k);
    if (v && v !== k) return v;
    return en[k] || k;
  };

  const [state, setState] = useState<DoctorState>(
    () => controller?.getSnapshot() ?? idleState(),
  );
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // Guidance editor local state (draft lives in the component; truth in store).
  const [draftText, setDraftText] = useState("");
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [savingGuidance, setSavingGuidance] = useState(false);
  const [guidanceMsg, setGuidanceMsg] = useState<{ ok: boolean; key: NormalizerKey } | null>(null);

  useEffect(() => {
    if (!controller) return;
    const unsubscribe = controller.subscribe(() => setState(controller.getSnapshot()));
    void controller.loadStats();
    void controller.loadCandidates();
    void controller.getConfig();
    void controller.getGuidance();
    return () => {
      unsubscribe();
    };
  }, [controller]);

  // Seed the draft once the host answers (initial load only; saves and resets
  // adopt the store's text explicitly in their handlers).
  useEffect(() => {
    if (!draftLoaded && state.guidance.text !== null) {
      setDraftText(state.guidance.text);
      setDraftLoaded(true);
    }
  }, [state.guidance.text, draftLoaded]);

  const stats = state.stats;
  const hasData = stats.totalIntercepted > 0;
  const unrecoveredTotal = stats.healedFailed + stats.passThroughFailed;

  const filteredRecords = useMemo(
    () =>
      stats.recentRecords.filter((record) => {
        if (state.statusFilter === "healed" && !(record.wasHealed && record.status === "success")) return false;
        if (state.statusFilter === "failed" && record.status !== "failed") return false;
        if (state.statusFilter === "promoted" && record.status !== "promoted") return false;
        const q = state.searchQuery.trim().toLowerCase();
        if (!q) return true;
        return [
          record.toolName,
          record.category,
          record.originalArgsPreview ?? "",
          record.normalizedArgsPreview ?? "",
          record.normalizationSummary ?? "",
        ].some((field) => field.toLowerCase().includes(q));
      }),
    [stats.recentRecords, state.statusFilter, state.searchQuery],
  );

  // Server-grouped candidates (durable signature aggregates) when available;
  // the local ring grouping only covers the window, so it is the fallback for
  // an old server or the pre-first-poll interval.
  const localCandidates = useMemo(
    () => buildErrorCandidates(stats.recentRecords, 60, state.config),
    [stats.recentRecords, state.config],
  );
  const candidates = state.candidates ?? localCandidates;
  const newRuleCount = candidates.filter((c) => c.verdict === "new-rule-candidate").length;
  const fixableCount = candidates.filter((c) => c.fixable).length;

  /** Latest observed record per category, for the rules-tab scoreboard. */
  const lastFiredByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const record of stats.recentRecords) {
      const seen = map.get(record.category);
      if (seen === undefined || record.time > seen) map.set(record.category, record.time);
    }
    return map;
  }, [stats.recentRecords]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const toggleExpand = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyText = (key: string, text: string): void => {
    if (!text) return;
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      window.setTimeout(
        () => setCopiedKey((current) => (current === key ? null : current)),
        1500,
      );
    }).catch(() => {
      /* Clipboard unavailable — the button simply stays inert. */
    });
  };

  const flashGuidance = (key: NormalizerKey, ok: boolean): void => {
    setGuidanceMsg({ key, ok });
    window.setTimeout(() => setGuidanceMsg(null), 2500);
  };

  const onSaveGuidance = async (): Promise<void> => {
    if (!controller) return;
    setSavingGuidance(true);
    const ok = await controller.saveGuidance(draftText);
    setSavingGuidance(false);
    if (ok) {
      setDraftDirty(false);
      flashGuidance("guidanceSaveSuccess", true);
    } else {
      flashGuidance("guidanceSaveError", false);
    }
  };

  const onResetGuidance = async (): Promise<void> => {
    if (!controller) return;
    const ok = await controller.resetGuidance();
    if (ok) {
      const guidance = controller.getSnapshot().guidance;
      setDraftText(guidance.text ?? "");
      setDraftDirty(false);
      flashGuidance("guidanceResetSuccess", true);
    } else {
      flashGuidance("guidanceSaveError", false);
    }
  };

  const onToggleRule = (flag: string, next: boolean): void => {
    if (!controller) return;
    setPendingToggle(flag);
    setToggleError(null);
    void controller.setConfig({ [flag]: next }).then((result) => {
      setPendingToggle(null);
      if (!result.ok) setToggleError(`${t("ruleToggleFailed")}: ${result.error}`);
    });
  };

  /** One-click adoption of an enable-flag proposal (also jumps to Rules). */
  const onApplyFix = (flag: string): void => {
    onToggleRule(flag, true);
  };

  // ── Record export (client-side; the filtered list is already local) ───────
  const download = (filename: string, mime: string, text: string): void => {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const exportRecords = (kind: "csv" | "json"): void => {
    if (filteredRecords.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    if (kind === "json") {
      download(
        `tool-doctor-records-${stamp}.json`,
        "application/json",
        JSON.stringify(filteredRecords, null, 2),
      );
      return;
    }
    const cell = (v: string): string => `"${v.replace(/"/g, '""')}"`;
    const lines = [
      "time,tool,category,wasHealed,status,tokensSaved,errorMessage,originalArgs,normalizedArgs,summary",
    ];
    for (const r of filteredRecords) {
      lines.push(
        [
          new Date(r.time).toISOString(),
          cell(r.toolName),
          cell(r.category),
          String(r.wasHealed),
          cell(r.status),
          r.tokensSaved !== undefined ? String(r.tokensSaved) : "",
          cell(r.errorMessage ?? ""),
          cell(r.originalArgsPreview),
          cell(r.normalizedArgsPreview ?? ""),
          cell(r.normalizationSummary ?? ""),
        ].join(","),
      );
    }
    download(`tool-doctor-records-${stamp}.csv`, "text/csv", lines.join("\n"));
  };

  // ── Derived display values ─────────────────────────────────────────────────

  const formatTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  };

  const healthText = (): string => {
    if (!hasData) return t("noDataDesc");
    if (stats.healingSuccessRate >= 90) return t("healthGood");
    if (stats.healingSuccessRate >= 75) return t("healthFair");
    return t("healthWarn");
  };

  const rankEntries = (source: Record<string, number>): Array<[string, number]> =>
    Object.entries(source).sort((a, b) => b[1] - a[1]);

  const verdictClass = (verdict: CandidateVerdict): string =>
    verdict === "new-rule-candidate" ? styles.verdictNew
      : verdict === "possible-existing" ? styles.verdictGap
        : styles.verdictTried;

  const verdictLabel = (verdict: CandidateVerdict): string =>
    verdict === "new-rule-candidate" ? t("verdictNew")
      : verdict === "possible-existing" ? t("verdictGap")
        : t("verdictAttempted");

  const verdictSentence = (candidate: ErrorCandidate): string => {
    const rule = candidate.ruleHint !== undefined ? String(candidate.ruleHint) : "?";
    if (candidate.verdict === "attempted-failed") return t("verdictAttemptedText").replace("{rule}", rule);
    if (candidate.verdict === "possible-existing") return t("verdictGapText").replace("{rule}", rule);
    return t("verdictNewText");
  };

  const fixSentence = (fix: ProposedFix): string => {
    const rule = fix.rule !== undefined ? String(fix.rule) : "?";
    switch (fix.kind) {
      case "enable-flag":
        return t("fixEnableFlag").replace("{rule}", rule);
      case "gate-gap":
        return t("fixGateGap").replace("{rule}", rule);
      case "refine-rule":
        return t("fixRefineRule").replace("{rule}", rule);
      default:
        return t("fixNewRule");
    }
  };

  const fixActionLabel = (fix: ProposedFix): string => {
    const named = fix.flag !== undefined ? flagLabel(fix.flag) : undefined;
    const name = named !== undefined ? t(named.titleKey) : "?";
    return t("fixApplyButton").replace("{rule}", name);
  };

  /** Why a pattern is still under observation, phrased by whichever bar is higher. */
  const watchSentence = (candidate: ErrorCandidate): string => {
    const needCount = Math.max(0, FIX_PROPOSE_MIN_COUNT - candidate.count);
    if (needCount > 0) {
      return t("watchNeedMore").replace("{n}", String(needCount));
    }
    const remainMin = Math.max(
      1,
      Math.ceil((FIX_PROPOSE_MIN_SPAN_MS - (candidate.lastSeen - candidate.firstSeen)) / 60000),
    );
    return t("watchNeedTime").replace("{m}", String(remainMin));
  };

  const rowToneClass = (record: NormalizerRecord): string => {
    if (record.status === "failed") return styles.logRowFail;
    if (record.wasHealed && record.status === "success") return styles.logRowOk;
    return "";
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={styles.container}>
      {/* Hero header */}
      <header className={styles.hero}>
        <div className={styles.heroMain}>
          <span className={styles.heroMark} aria-hidden="true"><PulseIcon /></span>
          <div className={styles.titleGroup}>
            <h2 className={styles.title}>{t("title")}</h2>
            <p className={styles.subtitle}>{t("subtitle")}</p>
          </div>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.btnGhost}
            onClick={() => {
              void controller?.loadStats();
              void controller?.loadCandidates();
              void controller?.getConfig();
            }}
          >
            <span className={styles.btnIcon}><RefreshIcon /></span>
            {t("refresh")}
          </button>
          <button
            type="button"
            aria-pressed={state.polling}
            className={`${styles.btnGhost} ${state.polling ? styles.btnGhostActive : ""}`}
            onClick={() => controller?.setPolling(!state.polling)}
          >
            {t("autoRefresh")}
          </button>
          <button
            type="button"
            className={styles.btnDanger}
            disabled={!hasData}
            onClick={() => void controller?.reset()}
          >
            <span className={styles.btnIcon}><TrashIcon /></span>
            {t("clear")}
          </button>
        </div>
      </header>

      {/* Non-blocking API error line */}
      {state.error && (
        <p className={styles.apiError} role="alert">{t(ERROR_LINE[state.error.source])}</p>
      )}

      {/* Overview: one outcome card leads (what actually happened to calls);
          everything secondary sits smaller beneath it. */}
      <section className={styles.overview}>
        <div className={styles.outcomeCard}>
          <div className={styles.outcomePrimary}>
            <span className={styles.kpiTitle}>{t("outcomeTitle")}</span>
            <span className={`${styles.outcomeValue} ${stats.healedSuccess > 0 ? styles.kpiValueSuccess : ""}`}>
              {stats.healedSuccess}
            </span>
            <span className={styles.outcomeRateRow}>
              <span className={styles.kpiMeter} aria-hidden="true">
                <span className={styles.kpiMeterFill} style={{ width: `${Math.min(100, stats.healingSuccessRate)}%` }} />
              </span>
              <span className={styles.kpiDesc}>
                {t("outcomeRepairedNote")} {stats.healingSuccessRate}% {t("kpiRateSuffix")}
              </span>
            </span>
          </div>
          <div className={styles.outcomeSplit}>
            <div className={styles.outcomeSplitItem}>
              <span className={`${styles.outcomeSplitValue} ${stats.healedFailed > 0 ? styles.kpiValueDanger : ""}`}>
                {stats.healedFailed}
              </span>
              <span className={styles.outcomeSplitLabel}>{t("outcomeFailedRepairs")}</span>
            </div>
            <div className={styles.outcomeSplitItem}>
              <span className={`${styles.outcomeSplitValue} ${stats.passThroughFailed > 0 ? styles.kpiValueDanger : ""}`}>
                {stats.passThroughFailed}
              </span>
              <span className={styles.outcomeSplitLabel}>{t("outcomePassThroughFailed")}</span>
            </div>
          </div>
        </div>
        <div className={styles.kpiGrid}>
          <KpiCard small title={t("kpiTotal")} value={stats.totalIntercepted} />
          <KpiCard small title={t("kpiPromoted")} value={stats.promoted} toneClass={styles.kpiValueAccent} />
          <KpiCard
            small
            title={t("kpiSavedTokens")}
            badge={t("estimateBadge")}
            value={formatTokens(stats.estimatedTokensSaved)}
            toneClass={styles.kpiValueSuccess}
          />
          {(stats.shadowMatches > 0 || state.config?.["shadowMode"] === true) && (
            <KpiCard small title={t("kpiShadow")} value={stats.shadowMatches} toneClass={styles.kpiValueAccent} />
          )}
        </div>
      </section>

      {/* Tabs */}
      <nav className={styles.tabsBar} role="tablist">
        {(
          [
            ["live", t("tabLive"), stats.recentRecords.length],
            ["analytics", t("tabAnalytics"), 0],
            ["errors", t("tabErrors"), unrecoveredTotal],
            ["rules", t("tabRules"), 0],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={state.activeTab === key}
            className={`${styles.tabItem} ${state.activeTab === key ? styles.tabActive : ""}`}
            onClick={() => controller?.setActiveTab(key)}
          >
            {label}
            {count > 0 && <span className={styles.tabCount}>{count}</span>}
          </button>
        ))}
      </nav>

      {/* TAB: live execution log */}
      {state.activeTab === "live" && (
        <section className={styles.livePane}>
          {(stats.shadowMatches > 0 || state.config?.["shadowMode"] === true) && (
            <div className={styles.shadowBanner} role="status">
              <span className={styles.shadowBannerLead}>{t("shadowBanner")}</span>
              <span className={styles.shadowBannerCount}>
                {stats.shadowMatches} {t("kpiShadow")}
              </span>
            </div>
          )}
          {hasData ? (
            <>
              <div className={styles.toolbar}>
                <span className={styles.searchWrap}>
                  <span className={styles.searchIcon} aria-hidden="true"><SearchIcon /></span>
                  <input
                    type="search"
                    className={styles.searchInput}
                    placeholder={t("searchPlaceholder")}
                    aria-label={t("searchPlaceholder")}
                    value={state.searchQuery}
                    onChange={(e) => controller?.setSearchQuery(e.target.value)}
                  />
                </span>
                <div className={styles.pills}>
                  {(
                    [
                      ["all", t("filterAll"), stats.recentRecords.length],
                      ["healed", t("filterHealed"), stats.recentRecords.filter((r) => r.wasHealed && r.status === "success").length],
                      ["failed", t("filterFailed"), stats.recentRecords.filter((r) => r.status === "failed").length],
                      ["promoted", t("filterPromoted"), stats.recentRecords.filter((r) => r.status === "promoted").length],
                    ] as const
                  ).map(([key, label, count]) => (
                    <button
                      key={key}
                      type="button"
                      className={`${styles.pill} ${state.statusFilter === key ? styles.pillActive : ""}`}
                      onClick={() => controller?.setStatusFilter(key)}
                    >
                      {label}
                      <span className={styles.countBadge}>{count}</span>
                    </button>
                  ))}
                </div>
                <div className={styles.exportGroup}>
                  <button
                    type="button"
                    className={styles.btnGhost}
                    disabled={filteredRecords.length === 0}
                    onClick={() => exportRecords("csv")}
                  >
                    {t("exportCsv")}
                  </button>
                  <button
                    type="button"
                    className={styles.btnGhost}
                    disabled={filteredRecords.length === 0}
                    onClick={() => exportRecords("json")}
                  >
                    {t("exportJson")}
                  </button>
                </div>
              </div>

              {filteredRecords.length === 0 ? (
                <div className={styles.emptyState}>
                  <div className={styles.emptyTitle}>{t("noData")}</div>
                </div>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.logTable}>
                  <thead>
                    <tr>
                      <th>{t("colTime")}</th>
                      <th>{t("colTool")}</th>
                      <th>{t("colCategory")}</th>
                      <th>{t("colStatus")}</th>
                      <th aria-hidden="true" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRecords.map((record) => {
                      const open = expandedIds.has(record.id);
                      return (
                        <Fragment key={record.id}>
                          <tr
                            className={`${styles.logRow} ${rowToneClass(record)}`}
                            onClick={() => toggleExpand(record.id)}
                          >
                            <td className={styles.timeText}>{new Date(record.time).toLocaleTimeString()}</td>
                            <td><span className={styles.badgeTool} title={record.toolName}>{record.toolName}</span></td>
                            <td><span className={styles.badgeCategory} title={categoryLabel(record.category)}>{categoryLabel(record.category)}</span></td>
                            <td><StatusPill record={record} t={t} /></td>
                            <td onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                className={`${styles.expandBtn} ${open ? styles.expandBtnOpen : ""}`}
                                aria-expanded={open}
                                aria-controls={`doctor-detail-${record.id}`}
                                onClick={() => toggleExpand(record.id)}
                              >
                                {open ? t("hideDetails") : t("diffDetails")}
                                <span className={styles.chevron}><ChevronIcon /></span>
                              </button>
                            </td>
                          </tr>
                          {open && (
                            <tr id={`doctor-detail-${record.id}`} className={styles.detailRow}>
                              <td colSpan={5}>
                                <DiffDetail record={record} t={t} copiedKey={copiedKey} onCopy={copyText} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <div className={styles.emptyState}>
              <span className={styles.emptyMark} aria-hidden="true"><PulseIcon /></span>
              <div className={styles.emptyTitle}>{t("noData")}</div>
              <p className={styles.emptyDesc}>{t("noDataDesc")}</p>
            </div>
          )}
        </section>
      )}

      {/* TAB: analytics */}
      {state.activeTab === "analytics" && (
        <section className={styles.analyticsPane}>
          <div className={styles.trendCard}>
            <div className={styles.trendHead}>
              <div className={styles.cardTitle}>{t("trendTitle")}</div>
              <p className={styles.kpiDesc}>{t("trendDesc")}</p>
            </div>
            <OutcomeTrend records={stats.recentRecords} t={t} />
          </div>
          <div className={`${styles.healthCard} ${hasData ? "" : styles.healthCardMuted}`}>
            <div>
              <div className={styles.healthTitle}>{t("healthScoreTitle")}</div>
              <p className={styles.healthDesc}>{healthText()}</p>
            </div>
          </div>
          <div className={styles.rankGrid}>
            <RankList title={t("toolRankTitle")} entries={rankEntries(stats.byTool)} tone="accent" t={t} />
            <RankList title={t("categoryRankTitle")} entries={rankEntries(stats.byCategory)} tone="ok" t={t} />
            <RankList title={t("failuresToolTitle")} entries={rankEntries(stats.failuresByTool)} tone="err" t={t} />
            <RankList title={t("failuresCategoryTitle")} entries={rankEntries(stats.failuresByCategory)} tone="err" t={t} />
          </div>
        </section>
      )}

      {/* TAB: errors & rule candidates */}
      {state.activeTab === "errors" && (
        <section className={styles.errorsPane}>
          <div className={styles.errorsIntro}>
            <p className={styles.errorsIntroText}>{t("errorsIntro")}</p>
          </div>

          <div className={styles.errorsStats}>
            <div className={styles.errorsStat}>
              <span className={styles.errorsStatValue}>{candidates.length}</span>
              <span className={styles.errorsStatLabel}>{t("errorsPatternsTitle")}</span>
            </div>
            <div className={styles.errorsStat}>
              <span className={`${styles.errorsStatValue} ${unrecoveredTotal > 0 ? styles.errorsStatDanger : ""}`}>
                {unrecoveredTotal}
              </span>
              <span className={styles.errorsStatLabel}>{t("errorsUnrecoveredTitle")}</span>
            </div>
            <div className={styles.errorsStat}>
              <span className={`${styles.errorsStatValue} ${newRuleCount > 0 ? styles.errorsStatAccent : ""}`}>
                {newRuleCount}
              </span>
              <span className={styles.errorsStatLabel}>{t("errorsNewTitle")}</span>
            </div>
            <div className={styles.errorsStat}>
              <span className={`${styles.errorsStatValue} ${fixableCount > 0 ? styles.errorsStatOk : ""}`}>
                {fixableCount}
              </span>
              <span className={styles.errorsStatLabel}>{t("errorsFixableTitle")}</span>
            </div>
          </div>

          {candidates.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyTitle}>{t("errorsEmptyTitle")}</div>
              <p className={styles.emptyDesc}>{t("errorsEmptyDesc")}</p>
            </div>
          ) : (
            <div className={styles.candList}>
              {candidates.map((candidate) => {
                const candKey = `cand:${candidate.key}`;
                const open = expandedIds.has(candKey);
                return (
                  <article key={candidate.key} className={styles.candCard}>
                    <button
                      type="button"
                      className={styles.candHead}
                      aria-expanded={open}
                      aria-controls={`doctor-cand-${candidate.key}`}
                      onClick={() => toggleExpand(candKey)}
                    >
                      <div className={styles.candMetaCol}>
                        <span className={styles.badgeTool} title={candidate.toolName}>{candidate.toolName}</span>
                        <span className={`${styles.statusPill} ${verdictClass(candidate.verdict)}`}>
                          {verdictLabel(candidate.verdict)}
                        </span>
                        <span className={styles.candSig} title={candidate.signature}>{candidate.signature}</span>
                      </div>
                      <div className={styles.candSide}>
                        <span className={styles.countBadge}>{candidate.count} {t("times")}</span>
                        <span className={`${styles.expandLabel} ${open ? styles.expandLabelOpen : ""}`}>
                          {open ? t("errorsHideSample") : t("errorsShowSample")}
                          <span className={styles.chevron}><ChevronIcon /></span>
                        </span>
                      </div>
                    </button>
                    {open && (
                      <div id={`doctor-cand-${candidate.key}`} className={styles.candBody}>
                        <p className={styles.candVerdict}>{verdictSentence(candidate)}</p>
                        {candidate.fixable && candidate.proposedFix !== undefined ? (
                          <div className={styles.fixBlock}>
                            <div className={styles.fixCol}>
                              <span className={styles.fixLabel}>{t("proposedFixLabel")}</span>
                              <span className={styles.fixText}>{fixSentence(candidate.proposedFix)}</span>
                            </div>
                            {candidate.proposedFix.kind === "enable-flag" && candidate.proposedFix.flag !== undefined && (
                              <button
                                type="button"
                                className={styles.fixBtn}
                                disabled={pendingToggle !== null}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onApplyFix(candidate.proposedFix!.flag!);
                                }}
                              >
                                {pendingToggle === candidate.proposedFix.flag ? "…" : fixActionLabel(candidate.proposedFix)}
                              </button>
                            )}
                          </div>
                        ) : (
                          <p className={styles.watchNote}>{watchSentence(candidate)}</p>
                        )}
                        <div className={styles.candMeta}>
                          <span>{t("firstSeen")}: {new Date(candidate.firstSeen).toLocaleString()}</span>
                          <span>{t("lastSeen")}: {new Date(candidate.lastSeen).toLocaleString()}</span>
                        </div>
                        <div className={styles.errorBlock}>
                          <div className={styles.diffLabelRow}>
                            <span className={styles.diffLabel}>{t("errorDetail")}</span>
                            <button
                              type="button"
                              className={styles.copyBtn}
                              onClick={() => copyText(`candErr:${candidate.key}`, candidate.sample.errorMessage)}
                            >
                              {copiedKey === `candErr:${candidate.key}` ? <CheckIcon /> : <CopyIcon />}
                            </button>
                          </div>
                          <pre className={`${styles.codeBox} ${styles.codeError}`}>
                            {candidate.sample.errorMessage || "—"}
                          </pre>
                        </div>
                        <div className={styles.diffBlock}>
                          <div className={styles.diffLabelRow}>
                            <span className={styles.diffLabel}>{t("errorsSample")}</span>
                            <button
                              type="button"
                              className={styles.copyBtn}
                              onClick={() => copyText(`candArgs:${candidate.key}`, candidate.sample.originalArgsPreview)}
                            >
                              {copiedKey === `candArgs:${candidate.key}` ? <CheckIcon /> : <CopyIcon />}
                            </button>
                          </div>
                          <JsonBlock code={candidate.sample.originalArgsPreview || "{}"} className={`${styles.codeBox} ${styles.codeBefore}`} />
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* TAB: rules, category health & guidance */}
      {state.activeTab === "rules" && (
        <section className={styles.rulesPane}>
          {/* Paused breakers first: what is stopped right now outranks the
              full toggle inventory. */}
          {stats.breakerOpen.length > 0 && (
            <div className={styles.breakerBar} role="status">
              <span className={styles.breakerBarTitle}>{t("breakerBarTitle")}</span>
              {stats.breakerOpen.map((category) => (
                <span key={category} className={styles.openPill} title={t("breakerOpenHint")}>
                  {categoryLabel(category)}
                </span>
              ))}
            </div>
          )}
          {toggleError && (
            <p className={styles.toggleError} role="alert">{toggleError}</p>
          )}

          {RULE_GROUPS.map((group) => {
            const cards = RULES.filter((rule) => group.flags.includes(rule.flag));
            if (cards.length === 0) return null;
            return (
              <div key={group.titleKey} className={styles.ruleGroup}>
                <h3 className={styles.ruleGroupTitle}>{t(group.titleKey)}</h3>
                <div className={styles.rulesGrid}>
                  {cards.map(({ flag, titleKey, descKey }) => {
                    const on = state.config ? state.config[flag] !== false : true;
                    const pending = pendingToggle === flag;
                    return (
                      <article key={flag} className={styles.ruleCard}>
                        <div className={styles.ruleHead}>
                          <h3 className={styles.ruleTitle}>{t(titleKey)}</h3>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={on}
                            className={`${styles.ruleToggle} ${on ? styles.ruleToggleOn : ""}`}
                            title={t(on ? "ruleTagActiveHint" : "ruleTagInactiveHint")}
                            disabled={pendingToggle !== null}
                            onClick={() => onToggleRule(flag, !on)}
                          >
                            <span className={styles.ruleToggleTrack} aria-hidden="true">
                              <span className={styles.ruleToggleKnob} />
                            </span>
                            {pending ? "…" : on ? t("statusActive") : t("statusInactive")}
                          </button>
                        </div>
                        <p className={styles.kpiDesc}>{t(descKey)}</p>
                      </article>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Per-category rule health from the 14 recordable categories */}
          <div className={styles.rankCard}>
            <div className={styles.cardTitle}>{t("ruleHealthTitle")}</div>
            <ul className={styles.catList}>
              {CATEGORY_ORDER.map((category) => {
                const total = stats.byCategory[category] ?? 0;
                const failed = stats.failuresByCategory[category] ?? 0;
                return (
                  <li key={category} className={`${styles.catRow} ${total === 0 ? styles.catRowMuted : ""}`}>
                    <span className={styles.catName}>{CATEGORY_LABELS[category]}</span>
                    {stats.breakerOpen.includes(category) && (
                      <span className={styles.openPill} title={t("breakerOpenHint")}>{t("breakerOpen")}</span>
                    )}
                    <span className={styles.catCounts}>
                      {total} {t("ruleHealthTotal")}
                      {failed > 0 && (
                        <span className={styles.catFailed}> · {failed} {t("ruleHealthFailed")}</span>
                      )}
                      {lastFiredByCategory.has(category) && (
                        <span className={styles.lastFired}>
                          {" · "}{t("lastFiredPrefix")} {new Date(lastFiredByCategory.get(category)!).toLocaleTimeString()}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Guidance editor */}
          <section className={styles.guidanceEditor}>
            <header className={styles.guidanceHeader}>
              <div className={styles.guidanceTitleGroup}>
                <span className={styles.guidanceIcon} aria-hidden="true"><PulseIcon /></span>
                <div>
                  <h3 className={styles.guidanceTitle}>{t("guidanceTitle")}</h3>
                  <p className={styles.guidanceDesc}>{t("guidanceDesc")}</p>
                </div>
              </div>
              <div className={styles.guidanceActions}>
                <button
                  type="button"
                  className={styles.btnGhost}
                  disabled={!draftLoaded || draftText === (state.guidance.defaultText ?? "")}
                  onClick={() => void onResetGuidance()}
                >
                  {t("guidanceDefaultBtn")}
                </button>
                <button
                  type="button"
                  className={styles.guidanceSaveBtn}
                  disabled={!draftDirty || savingGuidance}
                  onClick={() => void onSaveGuidance()}
                >
                  {savingGuidance ? "…" : ""}{t("guidanceSaveBtn")}
                </button>
              </div>
            </header>

            <div className={styles.guidanceBody}>
              {guidanceMsg && (
                <div className={`${styles.guidanceMsg} ${guidanceMsg.ok ? styles.guidanceMsgOk : styles.guidanceMsgError}`}>
                  {t(guidanceMsg.key)}
                </div>
              )}

              {!draftLoaded ? (
                <div className={styles.guidanceLoading}>{state.guidanceLoading ? t("noData") : t("apiErrorGuidance")}</div>
              ) : (
                <>
                  <textarea
                    className={styles.guidanceTextarea}
                    value={draftText}
                    onChange={(e) => {
                      setDraftText(e.target.value);
                      setDraftDirty(true);
                    }}
                    placeholder={t("guidancePlaceholder")}
                    rows={10}
                    spellCheck={false}
                    aria-label={t("guidanceTitle")}
                  />
                  <div className={styles.guidanceFooter}>
                    <span>
                      {draftText.split("\n").length} {t("guidanceLines")} ·{" "}
                      {draftText.length} {t("guidanceChars")}
                    </span>
                    {draftDirty && (
                      <span className={styles.dirtyBadge}>{t("guidanceDirty")}</span>
                    )}
                  </div>
                  <details className={styles.defaultPreview}>
                    <summary>{t("guidanceDefaultTitle")}</summary>
                    <pre className={`${styles.codeBox} ${styles.codeUnchanged}`}>
                      {state.guidance.defaultText ?? t("guidanceEmpty")}
                    </pre>
                  </details>
                </>
              )}
            </div>
          </section>
        </section>
      )}
    </div>
  );
}

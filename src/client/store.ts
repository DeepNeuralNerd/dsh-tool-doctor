/**
 * Reactive store + API client for the tool-doctor dashboard.
 *
 * The browser never fabricates events: every statistic and record comes from
 * a server snapshot adopted into the store through structural validation. When
 * nothing has been adopted yet (fresh install, offline host) the store reports
 * its last persisted snapshot — or an empty state — and the UI renders its
 * designed empty face. Every fetch failure degrades gracefully: the previous
 * state is kept and a non-blocking error line is surfaced to the panel.
 *
 * @module dsh-tool-doctor/client/store
 */

// ── Server contract mirrors (the client bundle stays self-contained) ────────

import type { CandidateVerdict, ProposedFix } from "./mirror.ts";

/** One recorded tool-healing event, as served by GET /stats. */
export interface NormalizerRecord {
  id: string;
  time: number;
  toolName: string;
  category: string;
  wasHealed: boolean;
  originalArgsPreview: string;
  normalizedArgsPreview?: string;
  normalizationSummary?: string;
  /** "promoted" = response-side markup became a tool call (no execution outcome yet). */
  status: "success" | "failed" | "passthrough" | "promoted";
  errorMessage?: string;
  tokensSaved?: number;
  /** Shadow-mode would-repair match (original args dispatched; not a heal). */
  shadow?: boolean;
}

/** Aggregated statistics across all recorded tool executions. */
export interface NormalizerStats {
  totalIntercepted: number;
  healedSuccess: number;
  healedFailed: number;
  /** Response-side promotions, counted separately from dispatch outcomes. */
  promoted: number;
  passThrough: number;
  passThroughFailed: number;
  /** Shadow-mode would-repair matches — never counted as heals or savings. */
  shadowMatches: number;
  estimatedTokensSaved: number;
  /** 0–100, one decimal. */
  healingSuccessRate: number;
  byTool: Record<string, number>;
  byCategory: Record<string, number>;
  failuresByTool: Record<string, number>;
  failuresByCategory: Record<string, number>;
  recentRecords: NormalizerRecord[];
  /** Categories whose retry circuit breaker is currently open (retries paused). */
  breakerOpen: string[];
}

/** Effective doctor configuration — the eight boolean rule flags. */
export type DoctorConfigFlags = Readonly<Record<string, boolean>>;

/**
 * One recurring error pattern from GET /candidates — grouped SERVER-side
 * from the tracker's durable signature aggregates, so counts span the whole
 * history, not just the record ring the stats snapshot carries.
 */
export interface DoctorCandidate {
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

const VERDICTS = new Set<CandidateVerdict>([
  "attempted-failed",
  "possible-existing",
  "new-rule-candidate",
]);

/** Structural validation for one candidate payload entry. */
function coerceCandidate(raw: unknown): DoctorCandidate | null {
  if (raw === null || typeof raw !== "object") return null;
  const c = raw as Partial<DoctorCandidate> & { sample?: unknown };
  if (
    typeof c.key !== "string" ||
    typeof c.toolName !== "string" ||
    typeof c.signature !== "string" ||
    !VERDICTS.has(c.verdict as CandidateVerdict) ||
    typeof c.fixable !== "boolean"
  ) {
    return null;
  }
  const sample =
    c.sample !== null && typeof c.sample === "object"
      ? (c.sample as { errorMessage?: unknown; originalArgsPreview?: unknown })
      : {};
  return {
    key: c.key,
    toolName: c.toolName,
    signature: c.signature,
    count: coerceNumber(c.count),
    firstSeen: coerceNumber(c.firstSeen),
    lastSeen: coerceNumber(c.lastSeen),
    verdict: c.verdict as CandidateVerdict,
    ruleHint: typeof c.ruleHint === "number" ? c.ruleHint : undefined,
    fixable: c.fixable,
    proposedFix:
      c.proposedFix !== undefined && c.proposedFix !== null && typeof c.proposedFix === "object"
        ? c.proposedFix
        : undefined,
    categories: Array.isArray(c.categories)
      ? c.categories.filter((v): v is string => typeof v === "string")
      : [],
    sample: {
      errorMessage: typeof sample.errorMessage === "string" ? sample.errorMessage : "",
      originalArgsPreview:
        typeof sample.originalArgsPreview === "string" ? sample.originalArgsPreview : "",
    },
  };
}

// ── Store state ──────────────────────────────────────────────────────────────

export type DoctorTab = "live" | "analytics" | "errors" | "rules";
export type StatusFilter = "all" | "healed" | "failed" | "promoted";

/** Which API surface the last non-blocking error came from. */
export type DoctorErrorSource = "stats" | "reset" | "config" | "guidance";

/** Guidance text pair served by GET /guidance. */
export interface GuidanceState {
  text: string | null;
  defaultText: string | null;
}

export interface DoctorState {
  status: "idle" | "ready";
  stats: NormalizerStats;
  activeTab: DoctorTab;
  searchQuery: string;
  statusFilter: StatusFilter;
  /** Effective rule toggles mirrored from the host; `null` until it answers. */
  config: DoctorConfigFlags | null;
  /**
   * Recurring-error candidates from GET /candidates (durable server-side
   * counts); `null` until the endpoint answers — the UI then falls back to
   * grouping the record window locally.
   */
  candidates: DoctorCandidate[] | null;
  polling: boolean;
  guidance: GuidanceState;
  guidanceLoading: boolean;
  error: { source: DoctorErrorSource; detail: string } | null;
}

const API_BASE = "/plugin-api/tool-doctor";
const STORAGE_KEY = "dsh_tool_doctor_stats_v1";
const POLL_INTERVAL_MS = 5000;

/** Fresh zeroed statistics; shared by construction, reset, and bare renders. */
export function createEmptyStats(): NormalizerStats {
  return {
    totalIntercepted: 0,
    healedSuccess: 0,
    healedFailed: 0,
    promoted: 0,
    passThrough: 0,
    passThroughFailed: 0,
    shadowMatches: 0,
    estimatedTokensSaved: 0,
    healingSuccessRate: 0,
    byTool: {},
    byCategory: {},
    failuresByTool: {},
    failuresByCategory: {},
    recentRecords: [],
    breakerOpen: [],
  };
}

// ── Structural validation (server payloads and localStorage are untrusted) ──

function isNumberMap(value: unknown): value is Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(
    (v) => typeof v === "number",
  );
}

function coerceNumberMap(value: unknown): Record<string, number> {
  if (!isNumberMap(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(value)) out[key] = n;
  return out;
}

function isRecordShape(value: unknown): value is NormalizerRecord {
  if (value === null || typeof value !== "object") return false;
  const r = value as Partial<NormalizerRecord>;
  return (
    typeof r.id === "string" &&
    typeof r.time === "number" &&
    typeof r.toolName === "string" &&
    typeof r.category === "string"
  );
}

function coerceNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Validate and normalize a stats payload (server or persisted). Returns null
 * for foreign JSON so the store never adopts garbage.
 */
export function coerceStats(raw: unknown): NormalizerStats | null {
  if (raw === null || typeof raw !== "object") return null;
  const s = raw as Partial<NormalizerStats>;
  if (!Array.isArray(s.recentRecords)) return null;

  const records: NormalizerRecord[] = [];
  for (const entry of s.recentRecords) {
    if (!isRecordShape(entry)) continue;
    records.push({
      id: entry.id,
      time: coerceNumber(entry.time),
      toolName: entry.toolName,
      category: entry.category,
      wasHealed: entry.wasHealed === true,
      originalArgsPreview:
        typeof entry.originalArgsPreview === "string"
          ? entry.originalArgsPreview
          : "",
      normalizedArgsPreview:
        typeof entry.normalizedArgsPreview === "string"
          ? entry.normalizedArgsPreview
          : undefined,
      normalizationSummary:
        typeof entry.normalizationSummary === "string"
          ? entry.normalizationSummary
          : undefined,
      // Preserve "promoted" faithfully; unknown values fall back to success.
      status:
        entry.status === "failed" ||
        entry.status === "passthrough" ||
        entry.status === "promoted"
          ? entry.status
          : "success",
      errorMessage:
        typeof entry.errorMessage === "string" ? entry.errorMessage : undefined,
      tokensSaved:
        typeof entry.tokensSaved === "number" ? entry.tokensSaved : undefined,
      shadow: entry.shadow === true ? true : undefined,
    });
  }

  return {
    totalIntercepted: coerceNumber(s.totalIntercepted),
    healedSuccess: coerceNumber(s.healedSuccess),
    healedFailed: coerceNumber(s.healedFailed),
    // Optional on the wire: payloads from an older server load as 0.
    promoted: coerceNumber(s.promoted),
    passThrough: coerceNumber(s.passThrough),
    passThroughFailed: coerceNumber(s.passThroughFailed),
    // Optional on the wire: payloads from an older server load as 0.
    shadowMatches: coerceNumber(s.shadowMatches),
    estimatedTokensSaved: coerceNumber(s.estimatedTokensSaved),
    healingSuccessRate: Math.min(100, Math.max(0, coerceNumber(s.healingSuccessRate))),
    byTool: coerceNumberMap(s.byTool),
    byCategory: coerceNumberMap(s.byCategory),
    failuresByTool: coerceNumberMap(s.failuresByTool),
    failuresByCategory: coerceNumberMap(s.failuresByCategory),
    recentRecords: records,
    // Optional on the wire: older servers and persisted snapshots read as none.
    breakerOpen: Array.isArray(s.breakerOpen)
      ? s.breakerOpen.filter((v): v is string => typeof v === "string")
      : [],
  };
}

/** Accept only boolean-valued objects as the mirrored rule-toggle config. */
function isConfigFlags(value: unknown): value is DoctorConfigFlags {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    entries.length > 0 &&
    entries.every(([, v]) => typeof v === "boolean")
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "network error";
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, { cache: "no-store", ...init });
}

// ── Store ────────────────────────────────────────────────────────────────────

function loadPersisted(): NormalizerStats | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return coerceStats(JSON.parse(raw));
  } catch {
    // Corrupt or unavailable storage degrades to the empty state.
    return null;
  }
}

function persist(stats: NormalizerStats): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // Quota or privacy-mode failures must not break rendering.
  }
}

/**
 * Reactive dashboard store: subscribe/notify state plus the plugin-API client.
 * One instance is created at registration time and shared with every render of
 * the section; all mutations flow through `patch` so listeners see immutable
 * snapshots.
 */
export class DoctorStore {
  private current: DoctorState;

  private readonly listeners = new Set<() => void>();

  private pollTimer: number | null = null;

  /** Single-flight guard: at most one refresh in flight, ever. */
  private pollInFlight = false;

  private visibilityHandler: (() => void) | null = null;

  constructor() {
    this.current = {
      status: "idle",
      stats: loadPersisted() ?? createEmptyStats(),
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

  // ── Reactivity ────────────────────────────────────────────────────────────

  public getSnapshot = (): DoctorState => this.current;

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private patch(partial: Partial<DoctorState>): void {
    this.current = { ...this.current, ...partial };
    for (const listener of this.listeners) listener();
  }

  // ── UI state setters ──────────────────────────────────────────────────────

  public setActiveTab(tab: DoctorTab): void {
    if (tab !== this.current.activeTab) this.patch({ activeTab: tab });
  }

  public setSearchQuery(query: string): void {
    if (query !== this.current.searchQuery) this.patch({ searchQuery: query });
  }

  public setStatusFilter(filter: StatusFilter): void {
    if (filter !== this.current.statusFilter) this.patch({ statusFilter: filter });
  }

  /** Toggle the optional 5-second refresh loop (stats + candidates). */
  public setPolling(on: boolean): void {
    if (on === this.current.polling) return;
    this.patch({ polling: on });
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.visibilityHandler !== null && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (on && typeof window !== "undefined") {
      this.pollTimer = window.setInterval(this.pollTick, POLL_INTERVAL_MS);
      if (typeof document !== "undefined") {
        // Coming back into view refreshes immediately instead of waiting out
        // the interval that kept running (and skipping) while hidden.
        this.visibilityHandler = (): void => {
          if (document.visibilityState === "visible") this.pollTick();
        };
        document.addEventListener("visibilitychange", this.visibilityHandler);
      }
    }
  }

  /**
   * One poll refresh: single-flight, so a slow response can never pile up
   * behind its own interval nor have an older reply overwrite a newer one;
   * paused while the panel is hidden, which is traffic nobody sees.
   */
  private pollTick = (): void => {
    if (this.pollInFlight) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    this.pollInFlight = true;
    Promise.allSettled([this.loadStats(), this.loadCandidates()]).finally(() => {
      this.pollInFlight = false;
    });
  };

  // ── Stats ─────────────────────────────────────────────────────────────────

  /** Pull the stats snapshot from the host; keeps previous state on failure. */
  public loadStats = async (): Promise<void> => {
    if (typeof fetch !== "function") return;
    try {
      const res = await apiFetch("/stats");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const stats = coerceStats(await res.json());
      if (!stats) throw new Error("malformed payload");
      this.patch({ stats, status: "ready", error: null });
      persist(stats);
    } catch (err) {
      this.patch({ error: { source: "stats", detail: describeError(err) } });
    }
  };

  /**
   * Pull the server-grouped recurring-error candidates. Auxiliary view: a
   * failure keeps the previous set (or the local window grouping) without an
   * error banner, so a transient 500 never covers the panel in red.
   */
  public loadCandidates = async (): Promise<void> => {
    if (typeof fetch !== "function") return;
    try {
      const res = await apiFetch("/candidates");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { candidates?: unknown };
      if (!Array.isArray(data.candidates)) throw new Error("malformed payload");
      const candidates: DoctorCandidate[] = [];
      for (const entry of data.candidates) {
        const candidate = coerceCandidate(entry);
        if (candidate !== null) candidates.push(candidate);
      }
      this.patch({ candidates });
    } catch {
      // Keep the previous view; the endpoint may also be absent on an old
      // server, which is exactly the case the local fallback grouping serves.
    }
  };

  /** Clear the tracker and durable log on the host; then zero the local view. */
  public reset = async (): Promise<void> => {
    if (typeof fetch === "function") {
      try {
        const res = await apiFetch("/reset", { method: "POST" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        this.patch({ error: { source: "reset", detail: describeError(err) } });
        return; // Failure keeps the previous state intact.
      }
    }
    const cleared = createEmptyStats();
    this.patch({
      stats: cleared,
      searchQuery: "",
      statusFilter: "all",
      candidates: null,
      error: null,
    });
    persist(cleared);
  };

  // ── Config (rule toggles) ─────────────────────────────────────────────────

  /** Pull the effective config once; silent no-op when the route is absent. */
  public getConfig = async (): Promise<void> => {
    if (typeof fetch !== "function") return;
    try {
      const res = await apiFetch("/config");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: unknown = await res.json();
      if (isConfigFlags(data)) this.patch({ config: data, error: null });
    } catch (err) {
      this.patch({ error: { source: "config", detail: describeError(err) } });
    }
  };

  /**
   * Flip one or more rule flags on the host and adopt the returned effective
   * config. The optimistic flip is reverted when the host rejects (400/500)
   * or is unreachable, so the switches always mirror host truth.
   */
  public setConfig = async (
    patchBody: Record<string, boolean>,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (typeof fetch !== "function") {
      return { ok: false, error: "fetch unavailable" };
    }
    const previous = this.current.config;
    if (previous) {
      this.patch({ config: { ...previous, ...patchBody } });
    }
    try {
      const res = await apiFetch("/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      if (!res.ok) {
        let error = `host rejected the change (HTTP ${res.status})`;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string" && body.error) error = body.error;
        } catch {
          // Non-JSON error body: keep the status-line message.
        }
        this.patch({ config: previous, error: { source: "config", detail: error } });
        return { ok: false, error };
      }
      const data: unknown = await res.json();
      if (isConfigFlags(data)) this.patch({ config: data, error: null });
      else this.patch({ error: null });
      return { ok: true };
    } catch (err) {
      const detail = describeError(err);
      this.patch({ config: previous, error: { source: "config", detail } });
      return { ok: false, error: detail };
    }
  };

  // ── Guidance editor ───────────────────────────────────────────────────────

  /** Fetch the current guidance text and its factory default. */
  public getGuidance = async (): Promise<void> => {
    if (typeof fetch !== "function") return;
    this.patch({ guidanceLoading: true });
    try {
      const res = await apiFetch("/guidance");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { text?: unknown; defaultText?: unknown };
      if (typeof data.text === "string" && typeof data.defaultText === "string") {
        this.patch({
          guidance: { text: data.text, defaultText: data.defaultText },
          error: null,
        });
      }
    } catch (err) {
      this.patch({ error: { source: "guidance", detail: describeError(err) } });
    } finally {
      this.patch({ guidanceLoading: false });
    }
  };

  /** Save updated guidance text; adopts the host's `current` on success. */
  public saveGuidance = async (text: string): Promise<boolean> => {
    if (typeof fetch !== "function") return false;
    try {
      const res = await apiFetch("/guidance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { current?: unknown };
      if (typeof data.current === "string") {
        this.patch({ guidance: { ...this.current.guidance, text: data.current } });
      }
      return true;
    } catch {
      // Endpoint unavailable or rejected — the editor keeps its draft.
      return false;
    }
  };

  /** Reset guidance to the factory default; adopts the returned text. */
  public resetGuidance = async (): Promise<boolean> => {
    if (typeof fetch !== "function") return false;
    try {
      const res = await apiFetch("/guidance/reset", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { text?: unknown };
      if (typeof data.text === "string") {
        this.patch({ guidance: { ...this.current.guidance, text: data.text } });
      }
      return true;
    } catch {
      return false;
    }
  };
}

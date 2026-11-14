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
  status: "success" | "failed" | "passthrough";
  errorMessage?: string;
  tokensSaved?: number;
}

/** Aggregated statistics across all recorded tool executions. */
export interface NormalizerStats {
  totalIntercepted: number;
  healedSuccess: number;
  healedFailed: number;
  passThrough: number;
  passThroughFailed: number;
  estimatedTokensSaved: number;
  /** 0–100, one decimal. */
  healingSuccessRate: number;
  byTool: Record<string, number>;
  byCategory: Record<string, number>;
  failuresByTool: Record<string, number>;
  failuresByCategory: Record<string, number>;
  recentRecords: NormalizerRecord[];
}

/** Effective doctor configuration — the eight boolean rule flags. */
export type DoctorConfigFlags = Readonly<Record<string, boolean>>;

// ── Store state ──────────────────────────────────────────────────────────────

export type DoctorTab = "live" | "analytics" | "errors" | "rules";
export type StatusFilter = "all" | "healed" | "failed";

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
    passThrough: 0,
    passThroughFailed: 0,
    estimatedTokensSaved: 0,
    healingSuccessRate: 0,
    byTool: {},
    byCategory: {},
    failuresByTool: {},
    failuresByCategory: {},
    recentRecords: [],
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
      status:
        entry.status === "failed" || entry.status === "passthrough"
          ? entry.status
          : "success",
      errorMessage:
        typeof entry.errorMessage === "string" ? entry.errorMessage : undefined,
      tokensSaved:
        typeof entry.tokensSaved === "number" ? entry.tokensSaved : undefined,
    });
  }

  return {
    totalIntercepted: coerceNumber(s.totalIntercepted),
    healedSuccess: coerceNumber(s.healedSuccess),
    healedFailed: coerceNumber(s.healedFailed),
    passThrough: coerceNumber(s.passThrough),
    passThroughFailed: coerceNumber(s.passThroughFailed),
    estimatedTokensSaved: coerceNumber(s.estimatedTokensSaved),
    healingSuccessRate: Math.min(100, Math.max(0, coerceNumber(s.healingSuccessRate))),
    byTool: coerceNumberMap(s.byTool),
    byCategory: coerceNumberMap(s.byCategory),
    failuresByTool: coerceNumberMap(s.failuresByTool),
    failuresByCategory: coerceNumberMap(s.failuresByCategory),
    recentRecords: records,
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

  constructor() {
    this.current = {
      status: "idle",
      stats: loadPersisted() ?? createEmptyStats(),
      activeTab: "live",
      searchQuery: "",
      statusFilter: "all",
      config: null,
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

  /** Toggle the optional 5-second stats polling loop. */
  public setPolling(on: boolean): void {
    if (on === this.current.polling) return;
    this.patch({ polling: on });
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (on && typeof window !== "undefined") {
      this.pollTimer = window.setInterval(() => {
        void this.loadStats();
      }, POLL_INTERVAL_MS);
    }
  }

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
    this.patch({ stats: cleared, searchQuery: "", statusFilter: "all", error: null });
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

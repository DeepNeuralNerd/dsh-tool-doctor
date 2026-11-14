/**
 * Per-category circuit breaker for recovery retries.
 *
 * Best practice (resilience engineering): bound retry effort on persistent
 * failures instead of paying the same nested-dispatch cost forever. A category
 * that fails to recover `threshold` times inside a sliding window opens: while
 * open, the pipeline skips further retries for that category but still records
 * the failure and appends hints, so the model keeps actionable feedback. Any
 * successful recovery closes the circuit immediately.
 *
 * Pure and clock-injected: trivially unit-testable, zero host dependencies.
 *
 * @module dsh-tool-doctor/core/breaker
 */

export interface CircuitBreakerOptions {
  /** Unrecovered attempts inside the window that open the circuit. Default 5. */
  threshold?: number;
  /** Sliding window length in milliseconds. Default 10 minutes. */
  windowMs?: number;
  /** Clock for testability. Defaults to Date.now. */
  now?: () => number;
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  /** Failure timestamps per category, oldest first. */
  private readonly failures = new Map<string, number[]>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.windowMs = options.windowMs ?? 10 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** Drop failure timestamps that have slid out of the window. */
  private prune(category: string): number[] {
    const list = this.failures.get(category) ?? [];
    const cutoff = this.now() - this.windowMs;
    let start = 0;
    while (start < list.length && list[start]! <= cutoff) start++;
    if (start > 0) list.splice(0, start);
    return list;
  }

  /**
   * Whether a recovery attempt for this category may proceed.
   * @param category - Healing category the retry belongs to.
   */
  allow(category: string): boolean {
    const recent = this.prune(category);
    return recent.length < this.threshold;
  }

  /** Record an unrecovered attempt; opens the circuit at the threshold. */
  recordFailure(category: string): void {
    const list = this.failures.get(category) ?? [];
    list.push(this.now());
    this.failures.set(category, list);
  }

  /** A successful recovery closes the circuit for its category immediately. */
  recordSuccess(category: string): void {
    this.failures.delete(category);
  }

  /** Diagnostic view of open circuits (for the stats feed). */
  openCategories(): string[] {
    return [...this.failures.entries()]
      .filter(([category, list]) => this.prune(category).length >= this.threshold)
      .map(([category]) => category);
  }
}

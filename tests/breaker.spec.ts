import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/core/breaker.ts";

describe("CircuitBreaker", () => {
  function clock(start = 0) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it("allows attempts below the threshold", () => {
    const c = clock();
    const breaker = new CircuitBreaker({ threshold: 3, windowMs: 1000, now: c.now });
    for (let i = 0; i < 2; i++) {
      expect(breaker.allow("cat")).toBe(true);
      breaker.recordFailure("cat");
    }
  });

  it("opens at the threshold and blocks further attempts", () => {
    const c = clock();
    const breaker = new CircuitBreaker({ threshold: 3, windowMs: 1000, now: c.now });
    for (let i = 0; i < 3; i++) breaker.recordFailure("cat");
    expect(breaker.allow("cat")).toBe(false);
    expect(breaker.openCategories()).toContain("cat");
  });

  it("closes immediately on a successful recovery", () => {
    const c = clock();
    const breaker = new CircuitBreaker({ threshold: 3, windowMs: 1000, now: c.now });
    for (let i = 0; i < 3; i++) breaker.recordFailure("cat");
    expect(breaker.allow("cat")).toBe(false);
    breaker.recordSuccess("cat");
    expect(breaker.allow("cat")).toBe(true);
    expect(breaker.openCategories()).not.toContain("cat");
  });

  it("re-opens after the window slides past old failures", () => {
    const c = clock();
    const breaker = new CircuitBreaker({ threshold: 3, windowMs: 1000, now: c.now });
    for (let i = 0; i < 3; i++) breaker.recordFailure("cat");
    expect(breaker.allow("cat")).toBe(false);
    c.advance(1500); // all failures slide out of the window
    expect(breaker.allow("cat")).toBe(true);
  });

  it("keeps categories independent", () => {
    const c = clock();
    const breaker = new CircuitBreaker({ threshold: 2, windowMs: 1000, now: c.now });
    breaker.recordFailure("a");
    breaker.recordFailure("a");
    expect(breaker.allow("a")).toBe(false);
    expect(breaker.allow("b")).toBe(true);
  });

  it("uses the default threshold of five", () => {
    const c = clock();
    const breaker = new CircuitBreaker({ now: c.now });
    for (let i = 0; i < 5; i++) breaker.recordFailure("x");
    expect(breaker.allow("x")).toBe(false);
  });
});

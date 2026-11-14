/**
 * The host's durable tool-result projection rejects lossy values (class
 * instances, -0, cycles, undefined members) with a serialization TypeError
 * that replaces the WHOLE result — so the doctor checks and repairs outgoing
 * results with the same rules before they cross the boundary.
 */
import { describe, expect, it } from "vitest";
import { isPlainJsonValue, projectForHost } from "../src/core/result.ts";
import { resultHasCode } from "../src/core/result.ts";
import type { ToolExecutionResult } from "../src/types.ts";

describe("isPlainJsonValue — the host's lossless-JSON rules", () => {
  it("accepts JSON data", () => {
    for (const value of [
      null,
      true,
      "text",
      0,
      42,
      [],
      [1, { a: null }],
      { a: 1, b: { c: "d" } },
      Object.create(null),
    ]) {
      expect(isPlainJsonValue(value)).toBe(true);
    }
  });

  it("rejects everything JSON cannot round-trip", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const arrayWithKey = [1, 2];
    (arrayWithKey as unknown as Record<string, unknown>).extra = true;
    for (const value of [
      undefined,
      () => 1,
      Symbol("s"),
      10n,
      -0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Error("boom"),
      new Date(),
      new Map(),
      cyclic,
      arrayWithKey,
      { a: undefined },
    ]) {
      expect(isPlainJsonValue(value)).toBe(false);
    }
  });
});

describe("projectForHost — a result the durable projection accepts", () => {
  it("passes a plain result through untouched", () => {
    const result: ToolExecutionResult = {
      content: [{ type: "text", text: "ok" }],
      meta: { lineCount: 3 },
    };
    expect(projectForHost(result)).toBe(result);
  });

  it("swaps a live Error for its plain identity, keeping content and failure state", () => {
    const result: ToolExecutionResult = {
      isError: true,
      content: [{ type: "text", text: "nested recovery failed" }],
      error: new Error("nested recovery failed"),
    };
    const projected = projectForHost(result);
    expect(projected).not.toBe(result);
    expect(projected.content).toEqual(result.content);
    expect(projected.isError).toBe(true);
    expect(projected.error).toEqual({ message: "nested recovery failed" });
    expect(isPlainJsonValue(projected.error)).toBe(true);
  });

  it("keeps a host error code across the swap (resultHasCode still matches)", () => {
    const result: ToolExecutionResult = {
      isError: true,
      content: [{ type: "text", text: "bad" }],
      error: Object.assign(new Error("bad input"), { code: "INVALID_ARGS" }),
    };
    const projected = projectForHost(result);
    expect(resultHasCode(projected, "INVALID_ARGS")).toBe(true);
  });

  it("drops lossy meta but keeps lossless meta", () => {
    const lossy: ToolExecutionResult = {
      content: [{ type: "text", text: "body" }],
      meta: { mtime: new Date(0) },
    };
    const projected = projectForHost(lossy);
    expect(projected.meta).toBeUndefined();
    expect(projected.content).toEqual(lossy.content);

    const clean: ToolExecutionResult = { content: [{ type: "text", text: "body" }], meta: { n: 2 } };
    expect(projectForHost(clean).meta).toEqual({ n: 2 });
  });

  it("falls back to a text block when content itself is unprojectable", () => {
    const result: ToolExecutionResult = {
      isError: true,
      content: [{ type: "text", text: "real message", when: new Date() } as never],
      error: { message: "real message" },
    };
    const projected = projectForHost(result);
    expect(projected.content).toEqual([{ type: "text", text: "real message" }]);
    expect(isPlainJsonValue(projected.content)).toBe(true);
  });

  it("a projected result never trips the projection check itself", () => {
    const result: ToolExecutionResult = {
      isError: true,
      content: [{ type: "text", text: "x" }],
      error: new TypeError("tool result must be losslessly JSON-serializable"),
      meta: { cause: new Map() },
    };
    const projected = projectForHost(result);
    expect(isPlainJsonValue(projected)).toBe(true);
  });
});

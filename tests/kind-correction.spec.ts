/**
 * Adversarial tests for the KIND_CORRECTION mechanics: directory-error
 * recognition (against the VERBATIM host message), directory extraction,
 * listing-tool preference, and schema-driven listing arguments.
 */
import { describe, expect, it } from "vitest";
import {
  chooseListingTool,
  directoryFromArgs,
  isDirectoryAccessError,
  listingArgsFor,
} from "../src/repair/kind-correction.ts";

describe("isDirectoryAccessError", () => {
  it("recognizes the verbatim host read-on-directory message", () => {
    expect(
      isDirectoryAccessError(
        undefined,
        'Error: cannot read "C:\\Users\\x\\src": not a regular file',
      ),
    ).toBe(true);
  });

  it("recognizes the EISDIR and ENOTDIR codes without text", () => {
    expect(isDirectoryAccessError("EISDIR", undefined)).toBe(true);
    expect(isDirectoryAccessError("ENOTDIR", undefined)).toBe(true);
  });

  it("recognizes EISDIR surfacing only inside Node's message text", () => {
    expect(
      isDirectoryAccessError(undefined, "EISDIR: illegal operation on a directory, read"),
    ).toBe(true);
  });

  it("stays false for unrelated failures and for missing information", () => {
    expect(isDirectoryAccessError("ENOENT", "no such file or directory, open '/x'")).toBe(false);
    expect(isDirectoryAccessError(undefined, undefined)).toBe(false);
    expect(isDirectoryAccessError(undefined, "permission denied")).toBe(false);
  });
});

describe("directoryFromArgs", () => {
  it("takes the path from the first present location key", () => {
    expect(directoryFromArgs({ file_path: "/proj/src" })).toBe("/proj/src");
    expect(directoryFromArgs({ path: "/a", file_path: "/b" })).toBe("/a");
  });

  it("skips non-string and blank values", () => {
    expect(directoryFromArgs({ file_path: 7, path: "   ", dir: "/real" })).toBe("/real");
  });

  it("is undefined for non-objects, arrays, null, and keyless objects", () => {
    expect(directoryFromArgs("C:\\proj\\src")).toBeUndefined();
    expect(directoryFromArgs(["/a"])).toBeUndefined();
    expect(directoryFromArgs(null)).toBeUndefined();
    expect(directoryFromArgs({ command: "ls" })).toBeUndefined();
  });
});

describe("chooseListingTool", () => {
  it("prefers list_directory over read_dir over the rest", () => {
    expect(chooseListingTool(["read_dir", "list_directory", "ls"])).toBe("list_directory");
    expect(chooseListingTool(["ls", "read_dir"])).toBe("read_dir");
  });

  it("returns the REGISTERED spelling, not its own lowercase", () => {
    expect(chooseListingTool(["Read_Dir"])).toBe("Read_Dir");
  });

  it("is undefined when the plane offers nothing listable", () => {
    expect(chooseListingTool(["read", "write", "glob"])).toBeUndefined();
    expect(chooseListingTool([])).toBeUndefined();
  });

  it('"dir" is refused — mkdir-semantics planes must not be dispatched blind', () => {
    expect(chooseListingTool(["dir"])).toBeUndefined();
    expect(chooseListingTool(["Dir", "read_dir"])).toBe("read_dir");
  });
});

describe("listingArgsFor", () => {
  it("uses the tool's own directory parameter", () => {
    const def = {
      inputSchema: {
        type: "object",
        properties: { directory: { type: "string" } },
        required: ["directory"],
      },
    };
    expect(listingArgsFor(def, "/tmp/x")).toEqual({ directory: "/tmp/x" });
  });

  it("adds pattern \"*\" only when pattern is REQUIRED", () => {
    const withPattern = {
      parameters: {
        properties: { path: { type: "string" }, pattern: { type: "string" } },
        required: ["path", "pattern"],
      },
    };
    expect(listingArgsFor(withPattern, "/d")).toEqual({ path: "/d", pattern: "*" });
    const optionalPattern = {
      inputSchema: { properties: { path: { type: "string" }, pattern: { type: "string" } } },
    };
    expect(listingArgsFor(optionalPattern, "/d")).toEqual({ path: "/d" });
  });

  it("falls back to { path } when the definition has no readable schema", () => {
    expect(listingArgsFor(undefined, "/tmp/x")).toEqual({ path: "/tmp/x" });
    expect(listingArgsFor({ name: "read_dir" }, "/tmp/x")).toEqual({ path: "/tmp/x" });
  });

  it("is undefined when the declared schema names no usable directory parameter", () => {
    const def = { inputSchema: { properties: { query: { type: "string" } } } };
    expect(listingArgsFor(def, "/tmp/x")).toBeUndefined();
  });

  it("counts boolean-form property schemas for a required pattern", () => {
    const def = {
      inputSchema: { properties: { path: true, pattern: true }, required: ["path", "pattern"] },
    };
    expect(listingArgsFor(def, "/d")).toEqual({ path: "/d", pattern: "*" });
  });
});

import { describe, expect, it } from "vitest";
import { renameAliasArgs } from "../src/repair/param-alias.ts";

/** A minimal tool definition carrying the schema shape extractSchema reads. */
const def = (properties: Record<string, unknown>) => ({
  inputSchema: { type: "object", properties },
});

const READ_DEF = def({ file_path: { type: "string" }, offset: { type: "number" } });
const GREP_DEF = def({ pattern: { type: "string" }, path: { type: "string" } });

describe("renameAliasArgs — canonical parameter rename", () => {
  it("renames filename to file_path when the schema confirms file_path", () => {
    const out = renameAliasArgs("read", { filename: "C:\\a\\b.md" }, READ_DEF);
    expect(out?.args).toEqual({ file_path: "C:\\a\\b.md" });
    expect(out?.changes[0]).toContain('"filename"');
  });

  it("renames regex to pattern on grep", () => {
    const out = renameAliasArgs("grep", { regex: "dsh", path: "C:\\p" }, GREP_DEF);
    expect(out?.args).toEqual({ pattern: "dsh", path: "C:\\p" });
  });

  it("leaves the canonical key untouched", () => {
    expect(renameAliasArgs("read", { file_path: "C:\\a" }, READ_DEF)).toBeUndefined();
  });

  it("abstains when both the alias and the canonical are set", () => {
    expect(
      renameAliasArgs("read", { file_path: "C:\\a", filename: "C:\\b" }, READ_DEF),
    ).toBeUndefined();
  });

  it("abstains when two aliases of one canonical are both present", () => {
    expect(
      renameAliasArgs("read", { filename: "C:\\a", filepath: "C:\\b" }, READ_DEF),
    ).toBeUndefined();
  });

  it("never invents: unknown tool, unknown name, or no schema all pass through", () => {
    expect(renameAliasArgs("pwsh", { filename: "x" }, def({ command: { type: "string" } }))).toBeUndefined();
    expect(renameAliasArgs("read", { nothing_like: "x" }, READ_DEF)).toBeUndefined();
    expect(renameAliasArgs("read", { filename: "x" }, undefined)).toBeUndefined();
  });

  it("respects a tool that legitimately owns the alias name itself", () => {
    // modlens_read_image's own parameter is `path` — grep's dir→path alias
    // must not fire where `path` is a real property in its own right.
    const MODLENS_DEF = def({ path: { type: "string" }, prompt: { type: "string" } });
    expect(renameAliasArgs("modlens_read_image", { path: "C:\\a.png" }, MODLENS_DEF)).toBeUndefined();
    // …while file_path is an ALIAS there, so it renames to path.
    const out = renameAliasArgs("modlens_read_image", { file_path: "C:\\a.png" }, MODLENS_DEF);
    expect(out?.args).toEqual({ path: "C:\\a.png" });
  });

  it("never mutates the caller's arguments object", () => {
    const args = { filename: "C:\\a" };
    renameAliasArgs("read", args, READ_DEF);
    expect(args).toEqual({ filename: "C:\\a" });
  });

  it("passes values verbatim — numbers included", () => {
    const out = renameAliasArgs("read", { filename: "C:\\a", offset: 40 }, READ_DEF);
    expect(out?.args).toEqual({ file_path: "C:\\a", offset: 40 });
  });

  it("ignores non-object payloads", () => {
    expect(renameAliasArgs("read", "string-payload", READ_DEF)).toBeUndefined();
    expect(renameAliasArgs("read", null, READ_DEF)).toBeUndefined();
  });

  it("renames edit's old_str to old_string", () => {
    const EDIT_DEF = def({
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
    });
    const out = renameAliasArgs(
      "edit",
      { file_path: "C:\\a", old_str: "x", new_string: "y" },
      EDIT_DEF,
    );
    expect(out?.args).toEqual({ file_path: "C:\\a", old_string: "x", new_string: "y" });
  });
});

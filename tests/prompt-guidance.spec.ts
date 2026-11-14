/**
 * Guidance module behavior: what getGuidanceText() serves through its whole
 * lifecycle (factory default → user edit → reset), and how the registered
 * prompt section reacts to the injectPrompt toggle at assemble time.
 * Deliberately NOT asserting individual sentences of the constant — the
 * factory text is copy the user owns and may reword; the guarantee under
 * test is that the default appears, edits stick, and reset restores.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_GUIDANCE_HEADING,
  DEFAULT_GUIDANCE_TEXT,
  TOOL_DOCTOR_PROMPT_SECTION,
  getGuidanceText,
  registerPromptGuidance,
  resetGuidanceText,
  setGuidanceText,
} from "../src/support/prompt.ts";

interface CapturedSection {
  name: string;
  order: number;
  text: string | (() => string);
}

/** Fake systemPrompt host capturing every section registration. */
function fakeHost() {
  const sections: CapturedSection[] = [];
  const ctx = {
    get: (name: string) =>
      name === "systemPrompt"
        ? {
            section: (def: CapturedSection) => {
              sections.push(def);
            },
          }
        : undefined,
  };
  const byName = (name: string) => sections.find((s) => s.name === name);
  const render = (name: string) => {
    const def = byName(name);
    expect(def, `section ${name} registered`).toBeDefined();
    return typeof def!.text === "function" ? def!.text() : def!.text;
  };
  return { ctx, sections, byName, render };
}

beforeEach(() => {
  resetGuidanceText();
});

describe("guidance lifecycle", () => {
  it("serves the factory default through getGuidanceText", () => {
    const text = getGuidanceText();
    expect(text).toBe(DEFAULT_GUIDANCE_TEXT);
    expect(text.startsWith(DEFAULT_GUIDANCE_HEADING)).toBe(true);
    expect(DEFAULT_GUIDANCE_HEADING).toBe("## Reliable tool calls");
    // The previous factory heading is gone from the default text.
    expect(text).not.toContain("Tool Call Reliability");
  });

  it("keeps a user edit intact until reset", () => {
    const edited = "## My rules\n- only my own wording";
    const prev = setGuidanceText(edited);
    expect(prev).toBe(DEFAULT_GUIDANCE_TEXT); // old text returned for undo
    expect(getGuidanceText()).toBe(edited); // edit sticks
    expect(getGuidanceText()).not.toContain(DEFAULT_GUIDANCE_HEADING);
    // Whitespace cannot wipe the guidance: it falls back to the default.
    setGuidanceText("   ");
    expect(getGuidanceText()).toBe(DEFAULT_GUIDANCE_TEXT);
    // The user edit survives until an explicit reset.
    setGuidanceText(edited);
    resetGuidanceText();
    expect(getGuidanceText()).toBe(DEFAULT_GUIDANCE_TEXT);
    expect(getGuidanceText()).toContain("## Reliable tool calls");
  });
});

describe("prompt section assembly", () => {
  it("renders current guidance while enabled and empty when disabled", () => {
    const host = fakeHost();
    let enabled = true;
    registerPromptGuidance(host.ctx, () => enabled);
    const guidance = host.byName(TOOL_DOCTOR_PROMPT_SECTION);
    expect(guidance?.order).toBe(400);
    expect(host.render(TOOL_DOCTOR_PROMPT_SECTION)).toBe(DEFAULT_GUIDANCE_TEXT);
    // Toggling injectPrompt off empties the section WITHOUT re-registering:
    // the text is function-backed and read per assemble.
    enabled = false;
    expect(host.render(TOOL_DOCTOR_PROMPT_SECTION)).toBe("");
    setGuidanceText("## Edited\n- x");
    expect(host.render(TOOL_DOCTOR_PROMPT_SECTION)).toBe("");
    enabled = true;
    expect(host.render(TOOL_DOCTOR_PROMPT_SECTION)).toBe("## Edited\n- x");
    resetGuidanceText();
  });
});

/**
 * Syntax-level repair for `run_code` program bodies.
 *
 * The host executes the program as the body of an async function, so a body
 * that does not parse fails before any inner call can run — and the dominant
 * model-side failure classes are mechanical, not semantic: truncated tails
 * (the emitted code ends inside an unterminated string or an unclosed call),
 * Python-style triple-quoted strings written into TypeScript programs, and
 * unescaped backticks inside template literals. Every repair applies only to
 * code that fails to parse and must yield a parseable program, so valid code
 * is never touched and a wrong guess is rejected by re-parsing.
 *
 * @module dsh-tool-doctor/repair/run-code-syntax
 */

import {
  LEXER,
  isRegexStart,
  skipBlockComment,
  skipLineComment,
  skipRegex,
  skipStringOrTemplate,
  walkStructure,
} from "./lexer.ts";

const BACKTICK = LEXER.BACKTICK;

/**
 * Whether the program parses exactly as the host will evaluate it: the body
 * of an async function prefixed with the host's strict-mode directive. The
 * parse is synchronous and never executes the body.
 */
export function parseProgram(code: string): boolean {
  try {
    // Reached through an instance because `AsyncFunction` is not a global,
    // mirroring the host worker's bootstrap.
    const AsyncFunction = (async () => {}).constructor as new (
      ...args: string[]
    ) => Function;
    new AsyncFunction(`'use strict';\n${code}`);
    return true;
  } catch {
    return false;
  }
}

const OPEN_CLOSERS: Record<string, string> = {
  "(": ")",
  "{": "}",
  "[": "]",
};

/**
 * Closing delimiters the program tail still needs: the chain of unclosed
 * brackets, or undefined when the tail is not a simple truncation (an
 * unbalanced closer, an unterminated construct in the middle, or nothing open).
 * An unterminated trailing quote/template is the caller's first repair step.
 */
export function missingTailClosers(code: string): string | undefined {
  const stack: string[] = [];
  let stoppedAt = -1;
  let unterminatedNode = false;
  const walk = walkStructure(code, (ch, index) => {
    if (ch === "(" || ch === "{" || ch === "[") {
      stack.push(ch);
      return undefined;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      const open = stack.pop();
      if (open === undefined || OPEN_CLOSERS[open] !== ch) {
        stoppedAt = index;
        return index;
      }
      return undefined;
    }
    if (ch === "\0") {
      // An unterminated string/template: if the stack is non-empty the tail
      // is a plain cut and the quote is closed by the caller; otherwise the
      // corruption is elsewhere.
      unterminatedNode = true;
      return undefined;
    }
    return undefined;
  });
  if (walk === undefined || stoppedAt >= 0) return undefined;
  if (stack.length === 0) return undefined;
  if (unterminatedNode && stack.length === 1) return undefined;
  const closers: string[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    closers.push(OPEN_CLOSERS[stack[i]!]!);
  }
  return closers.join("");
}

/** Number of unescaped occurrences of the quote at `start` from `start` to EOF. */
function countQuotesFrom(code: string, start: number): number {
  const quote = code[start]!;
  let count = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] !== quote) continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && code[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) count++;
  }
  return count;
}

/**
 * Simple tail-truncation repair: append the character that closes the final
 * unterminated construct (quotes and backticks first, then the bracket chain),
 * accepting only a result that parses.
 */
export function repairTruncatedTail(code: string): string | undefined {
  const tail = code.replace(/\s+$/u, "");

  // Case A — the last quoted construct is unterminated at EOF. The program
  // cannot parse no matter what follows, so closing just it (plus any open
  // bracket chain) is the fix.
  const lastQuote = Math.max(
    tail.lastIndexOf(LEXER.DOUBLE_QUOTE),
    tail.lastIndexOf(LEXER.SINGLE_QUOTE),
    tail.lastIndexOf(BACKTICK),
  );
  if (lastQuote >= 0) {
    const scanned = skipStringOrTemplate(tail, lastQuote);
    const isUnterminated = !("end" in scanned);
    // A quote parity check distinguishes a cut inside a literal (odd count of
    // that kind of quote from the tail start) from a lone closing quote.
    if (isUnterminated && countQuotesFrom(tail, lastQuote) % 2 === 1) {
      const closed = tail + tail[lastQuote]!;
      const balanced = missingTailClosers(closed);
      if (balanced === undefined) {
        // Nothing else open: the closed program may already be complete.
        return parseProgram(closed) ? closed : undefined;
      }
      const candidate = closed + balanced;
      return parseProgram(candidate) ? candidate : undefined;
    }
  }

  // Case B — no trailing quote cut: a plain bracket truncation at EOF.
  const closers = missingTailClosers(tail);
  if (closers !== undefined) {
    const candidate = tail + closers;
    return parseProgram(candidate) ? candidate : undefined;
  }
  return undefined;
}

/**
 * Rewrite Python-style triple-quoted strings (`'''` / `"""`) that carry a
 * newline inside their span into template literals, escaping the characters
 * that would terminate a template. A triple quote whose span contains no
 * newline can be legitimate JS (e.g. `''` + `'x'`), so it is left alone; the
 * result must parse or the repair is abandoned.
 */
export function rewriteTripleQuotedStrings(code: string): string | undefined {
  const spans: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === LEXER.SINGLE_QUOTE || ch === LEXER.DOUBLE_QUOTE) {
      const triple = code.slice(i, i + 3);
      if (triple === ch.repeat(3)) {
        // Only a span that contains a newline is a Python-style multiline
        // string; a one-line `'''x'''` can be legitimate `''` + `'x'`.
        const close = code.indexOf(triple, i + 3);
        if (close > 0 && code.slice(i + 3, close).includes("\n")) {
          spans.push({ start: i, end: close + 3 });
          i = close + 3;
          continue;
        }
      }
      const scanned = skipStringOrTemplate(code, i);
      if (!("end" in scanned)) return undefined;
      i = scanned.end;
      continue;
    }
    if (ch === BACKTICK) {
      const scanned = skipStringOrTemplate(code, i);
      if (!("end" in scanned)) return undefined;
      i = scanned.end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      i = skipLineComment(code, i);
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const end = skipBlockComment(code, i);
      if (end < 0) return undefined;
      i = end;
      continue;
    }
    if (
      ch === "/" &&
      code[i + 1] !== "/" &&
      code[i + 1] !== "*" &&
      isRegexStart(code, i)
    ) {
      const scanned = skipRegex(code, i);
      if (!("end" in scanned)) return undefined;
      i = scanned.end;
      continue;
    }
    i++;
  }
  if (spans.length === 0) return undefined;

  let out = "";
  let cursor = 0;
  for (const span of spans) {
    const content = code.slice(span.start + 3, span.end - 3);
    const escaped = content.replace(/`/gu, "\\`").replace(/\$\{/gu, "\\${");
    out += `${code.slice(cursor, span.start)}\`${escaped}\``;
    cursor = span.end;
  }
  out += code.slice(cursor);
  return parseProgram(out) ? out : undefined;
}

/**
 * Escape stray unescaped backticks inside template literals whose pairing the
 * model broke. Two shapes are repaired, each parse-verified and bounded: one
 * template running to the end of the program (escape every backtick except the
 * first opener and one candidate closer, tried from the tail backwards), then
 * single-escape each backtick for exotic pairings. Backticks the model already
 * escaped (`\``) are collected as content, never re-escaped. The collection cap
 * bounds the repair's work (candidates are tried from the tail), not the count
 * of backticks it may escape — document-heavy programs embed dozens of spans.
 */
export function escapeStrayTemplateBackticks(code: string): string | undefined {
  // Unescaped backtick positions over the raw source. Nothing is skipped:
  // backticks inside strings, comments and regex literals tolerate the same
  // `\`` escape without changing meaning (comments ignore it; in strings and
  // regexes `\`` == `` ` ``), and every candidate is re-parsed before
  // acceptance, so an over-broad collection only costs failed candidates.
  const backticks: number[] = [];
  for (let i = 0; i < code.length && backticks.length <= 256; i++) {
    if (code[i] === BACKTICK) {
      let escaped = false;
      let j = i - 1;
      while (j >= 0 && code[j] === "\\") j--;
      const run = i - 1 - j; // backslashes directly before the backtick
      if (run % 2 === 1) escaped = true;
      if (!escaped) backticks.push(i);
    }
  }
  const opener = backticks[0];
  if (opener === undefined || backticks.length < 3) return undefined;

  // One template running to the tail: keep the first opener and one candidate
  // closer, escape every other backtick. Try the tail-most closers first — a
  // truncated or content-heavy template closes at its last backtick, and a
  // wrong closer that happens to parse is still a parseable program.
  const lastBacktick = backticks[backticks.length - 1]!;
  const closestTail = Math.max(backticks[0]!, lastBacktick - 16);
  for (let n = lastBacktick; n > closestTail; n--) {
    if (!backticks.includes(n)) continue;
    const candidate = escapeBackticksExcept(code, backticks, new Set([opener, n]));
    if (parseProgram(candidate)) return candidate;
  }
  // Exotic pairing: escape one backtick at a time and keep the first winner.
  for (const index of backticks) {
    const candidate = `${code.slice(0, index)}\\${code.slice(index)}`;
    if (parseProgram(candidate)) return candidate;
  }
  return undefined;
}

/** Escape every collected backtick except the kept positions. */
function escapeBackticksExcept(
  code: string,
  backticks: number[],
  kept: Set<number>,
): string {
  let out = "";
  let cursor = 0;
  for (const index of backticks) {
    if (kept.has(index)) continue;
    // Backslash BEFORE the backtick: inside a template `\`` is a literal
    // backtick, while the escape must never pair with the following char.
    out += `${code.slice(cursor, index)}\\${BACKTICK}`;
    cursor = index + 1;
  }
  return out + code.slice(cursor);
}

/**
 * Repair a program that does not parse, in a fixed order of mechanical fixes:
 * truncated tail, Python triple-quoted strings, stray template backticks. Each
 * candidate must parse; unparseable candidates are skipped and valid programs
 * are returned untouched (undefined).
 */
export function repairRunCodeSyntax(code: string): string | undefined {
  if (parseProgram(code)) return undefined;
  const repairers: Array<(source: string) => string | undefined> = [
    repairTruncatedTail,
    rewriteTripleQuotedStrings,
    escapeStrayTemplateBackticks,
  ];
  for (const repairer of repairers) {
    const candidate = repairer(code);
    if (candidate !== undefined && candidate !== code) return candidate;
  }
  return undefined;
}

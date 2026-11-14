/**
 * Syntax-highlighted rendering of an argument preview.
 *
 * Complete tokens on each pretty-printed line are wrapped in spans; truncated
 * fragments match nothing and fall through as plain text, so broken payloads
 * degrade to readable indentation instead of breaking the view. Content stays
 * in React text nodes — no HTML is ever injected.
 *
 * @module dsh-tool-doctor/client/JsonBlock
 */

import type { ReactElement, ReactNode } from "react";
import { ELLIPSIS_MARKER, prettyPrintJson } from "./json-format.ts";
import styles from "./DoctorSection.module.css";

const TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false)\b|\b(null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/**
 * Highlight one pretty-printed line: keys, strings, booleans, nulls, numbers.
 */
function highlightLine(line: string, keyBase: string): ReactNode {
  const nodes: ReactNode[] = [];
  // The omission marker is structural, not data: give it its own quiet voice.
  const segments = line.split(ELLIPSIS_MARKER);
  segments.forEach((segment, segIndex) => {
    if (segIndex > 0) {
      nodes.push(
        <span key={`${keyBase}:ellipsis:${segIndex}`} className={styles.jsonEllipsis}>
          {ELLIPSIS_MARKER.trim()}
        </span>,
      );
    }
    let last = 0;
    let spanIndex = 0;
    TOKEN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOKEN.exec(segment)) !== null) {
      if (match.index > last) nodes.push(segment.slice(last, match.index));
      const [full, quoted, colon, bool, nullWord] = match;
      const key = `${keyBase}:${segIndex}:${spanIndex++}`;
      if (quoted) {
        nodes.push(
          <span key={key} className={colon ? styles.jsonKey : styles.jsonString}>
            {full}
          </span>,
        );
      } else if (bool) {
        nodes.push(
          <span key={key} className={styles.jsonBool}>{full}</span>,
        );
      } else if (nullWord) {
        nodes.push(
          <span key={key} className={styles.jsonNull}>{full}</span>,
        );
      } else {
        nodes.push(
          <span key={key} className={styles.jsonNumber}>{full}</span>,
        );
      }
      last = match.index + full.length;
    }
    if (last < segment.length) nodes.push(segment.slice(last));
  });
  return nodes;
}

/**
 * Render a code-box body with JSON pretty-printing and highlighting.
 * @param props.code - Raw preview text.
 * @param props.className - The surrounding `pre` styling (before/after tone).
 */
export function JsonBlock(props: {
  code: string;
  className?: string;
}): ReactElement {
  const pretty = prettyPrintJson(props.code);
  return (
    <pre className={props.className || styles.codeBox}>
      {pretty.split("\n").map((line, index, all) => (
        <span key={index}>
          {highlightLine(line, `l${index}`)}
          {index < all.length - 1 ? "\n" : null}
        </span>
      ))}
    </pre>
  );
}

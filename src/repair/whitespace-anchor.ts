/**
 * Whitespace-equivalent anchor variants for the EDIT_WHITESPACE rule (rule 4).
 *
 * Pure text mechanics — no I/O, no file knowledge: produces at most two
 * variants of an edit anchor (line-ending flip and leading-indentation flip)
 * so the retrying stage can re-dispatch them and let the HOST adjudicate
 * which spelling actually exists in the file.
 *
 * @module dsh-tool-doctor/repair/whitespace-anchor
 */

export function editAnchorVariants(needle: string): string[] {
  const variants: string[] = [];

  // Split into lines for indentation analysis.
  const lines = needle.split("\n");

  // Rule 1: Line-ending flip.
  if (needle.includes("\r\n")) {
    const lfVariant = needle.replace(/\r\n/g, "\n");
    if (lfVariant !== needle) {
      variants.push(lfVariant);
    }
  } else if (needle.includes("\n")) {
    const crlfVariant = needle.replace(/\n/g, "\r\n");
    if (crlfVariant !== needle) {
      variants.push(crlfVariant);
    }
  }

  // Rule 2: Indentation flip.
  const hasMultipleLines = lines.length > 1;
  const firstLineStartsWithWhitespace = lines[0].length > 0 && /[ \t]/.test(lines[0][0]);

  if ((hasMultipleLines || firstLineStartsWithWhitespace) && variants.length < 2) {
    // Analyze leading whitespace per line to determine conversion direction.
    const tabFound: boolean[] = [];
    const allSpacesMod4: boolean[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      let wsLen = 0;
      while (wsLen < line.length && /[ \t]/.test(line[wsLen])) {
        wsLen++;
      }

      if (wsLen === 0) continue;

      const wsSegment = line.slice(0, wsLen);
      const hasTabInLeadingWs = /\t/.test(wsSegment);
      tabFound.push(hasTabInLeadingWs);

      const spaceCount = wsSegment.length;
      allSpacesMod4.push(spaceCount % 4 === 0);
    }

    let indentVariant: string | undefined;

    // If any line's leading whitespace contains a tab → convert leading tabs to four spaces each.
    if (tabFound.some((hasTab) => hasTab)) {
      const convertedLines = lines.map((line) => {
        const ws = line.match(/^[ \t]+/);
        if (ws === null) return line;
        return ws[0].replace(/\t/g, "    ") + line.slice(ws[0].length);
      });
      indentVariant = convertedLines.join("\n");
    } else if (allSpacesMod4.every((isMod4) => isMod4)) {
      // Every indented line's leading spaces count is a multiple of 4 →
      // convert each leading group of four spaces into one tab.
      const convertedLines = lines.map((line) => {
        const ws = line.match(/^ +/);
        if (ws === null || ws[0].length < 4) return line;
        const groups = Math.floor(ws[0].length / 4);
        return "\t".repeat(groups) + line.slice(groups * 4);
      });
      indentVariant = convertedLines.join("\n");
    }

    if (indentVariant !== undefined && indentVariant !== needle) {
      variants.push(indentVariant);
    }
  }

  // Deduplicate and exclude the original.
  return Array.from(new Set(variants));
}

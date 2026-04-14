/**
 * Mnemos — privacy tag redaction
 *
 * Memories may arrive containing `<private>...</private>` blocks that must
 * never be embedded, stored, or sent to any downstream LLM. We strip them
 * at the entry point (memory_remember) and again defensively in the
 * consolidation job (in case legacy rows still contain them).
 *
 * Semantics:
 *   - A closed `<private>...</private>` block becomes `[redacted]`.
 *   - Tags are matched case-insensitively and span newlines.
 *   - Nested `<private>` blocks are treated as a single outer block.
 *   - An unclosed `<private>` is treated as literal text (NOT redacted),
 *     so a typo like "use <private> data" in a valid memory doesn't
 *     silently swallow the remainder.
 *   - HTML attributes on the opening tag are tolerated, e.g.
 *     `<private data-owner="josh">...</private>`.
 *
 * The function is deterministic and free of I/O — safe to call anywhere.
 */

const OPEN_TAG = /<private\b[^>]*>/gi;
const CLOSE_TAG = /<\/private\s*>/gi;

export interface StripPrivateResult {
  text: string;
  hadPrivate: boolean;
}

/**
 * Strip `<private>...</private>` blocks from `text`, replacing each with
 * `[redacted]`. Returns the cleaned text and a flag indicating whether
 * any redaction happened.
 */
export function stripPrivate(text: string): StripPrivateResult {
  if (!text || text.indexOf('<') === -1) {
    return { text, hadPrivate: false };
  }

  let hadPrivate = false;
  let out = '';
  let i = 0;

  while (i < text.length) {
    OPEN_TAG.lastIndex = i;
    const open = OPEN_TAG.exec(text);
    if (!open) {
      out += text.slice(i);
      break;
    }

    // Copy everything up to the open tag.
    out += text.slice(i, open.index);

    // Find the matching close tag, tolerating nested opens.
    let depth = 1;
    let cursor = open.index + open[0].length;

    while (depth > 0 && cursor < text.length) {
      OPEN_TAG.lastIndex = cursor;
      CLOSE_TAG.lastIndex = cursor;
      const nextOpen = OPEN_TAG.exec(text);
      const nextClose = CLOSE_TAG.exec(text);

      if (!nextClose) {
        // Unclosed block — preserve the original text verbatim starting at
        // the open tag and stop processing further replacements.
        out += text.slice(open.index);
        return { text: out, hadPrivate };
      }

      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        cursor = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        cursor = nextClose.index + nextClose[0].length;
      }
    }

    out += '[redacted]';
    hadPrivate = true;
    i = cursor;
  }

  return { text: out, hadPrivate };
}

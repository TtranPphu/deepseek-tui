// Layout math for the fullscreen shell, kept pure so the viewport contract is
// testable without a terminal. Offset convention: lines from the bottom of the
// transcript — 0 pins the view to the latest line.

/**
 * Clamp a scroll offset to the reachable range.
 * @param offset - requested lines-from-bottom.
 * @param total - total transcript lines.
 * @param viewport - visible transcript rows.
 * @returns the clamped offset; 0 when everything fits.
 */
export function clampScroll(offset: number, total: number, viewport: number): number {
  return Math.min(Math.max(0, offset), Math.max(0, total - viewport))
}

/**
 * Slice the visible transcript window.
 * @param items - all transcript lines.
 * @param viewport - visible rows.
 * @param offset - lines-from-bottom scroll offset.
 * @returns the window ending `offset` lines before the tail.
 */
export function scrollWindow<T>(items: readonly T[], viewport: number, offset: number): readonly T[] {
  const end = items.length - clampScroll(offset, items.length, viewport)
  return items.slice(Math.max(0, end - viewport), end)
}

/**
 * Clamp a top-anchored scroll offset (help overlay) into reachable range.
 * @param top - first visible row from the top of the content.
 * @param total - total content lines.
 * @param viewport - visible rows.
 * @returns the clamped offset; 0 when everything fits.
 */
export function clampTop(top: number, total: number, viewport: number): number {
  return Math.min(Math.max(0, top), Math.max(0, total - viewport))
}

/**
 * Slice the visible window of a top-anchored scrollable list.
 * @param items - all content lines.
 * @param viewport - visible rows.
 * @param top - first visible row index.
 * @returns the window starting at `top` (clamped).
 */
export function topWindow<T>(items: readonly T[], viewport: number, top: number): readonly T[] {
  const start = clampTop(top, items.length, viewport)
  return items.slice(start, start + viewport)
}

/**
 * Composer content height in terminal rows for a wrapped, possibly multiline
 * input. Chrome inside the border: 2 border columns, 2 padding columns, 2
 * prompt columns (`❯ `); the cursor block needs one cell beyond the input text.
 * @param input - composer text, `\n`-separated logical lines.
 * @param cols - terminal width.
 * @returns wrapped content line count, at least 1.
 */
export function composerRows(input: string, cols: number): number {
  const contentWidth = Math.max(1, cols - 6)
  let rows = 0
  for (const line of input.split('\n')) {
    rows += Math.max(1, Math.ceil((line.length + 1) / contentWidth))
  }
  return rows
}

/**
 * Greedy word wrap at `width` columns; a word longer than the width hard-breaks.
 * @param text - one logical line (no newlines).
 * @param width - maximum cells per output line.
 * @returns wrapped lines, at least one (empty input wraps to one empty line).
 */
export function wrapText(text: string, width: number): string[] {
  const limit = Math.max(1, width)
  if (text.length <= limit) return [text]
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`
    if (candidate.length <= limit) {
      line = candidate
      continue
    }
    if (line !== '') out.push(line)
    line = word
    while (line.length > limit) {
      out.push(line.slice(0, limit))
      line = line.slice(limit)
    }
  }
  out.push(line)
  return out
}

/**
 * Transcript viewport height: terminal rows minus header (1), footer (1), and
 * the composer box (content lines + 2 border rows).
 * @param rows - terminal height.
 * @param composerLineCount - wrapped composer content rows.
 * @returns visible transcript rows, at least 1.
 */
export function transcriptViewport(rows: number, composerLineCount: number): number {
  return Math.max(1, rows - 4 - composerLineCount)
}

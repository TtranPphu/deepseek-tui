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
 * Composer content height in terminal rows for a wrapped single-line input.
 * Chrome inside the border: 2 border columns, 2 padding columns, 2 prompt
 * columns (`❯ `); the cursor block needs one cell beyond the input text.
 * @param inputLength - composer text length in cells.
 * @param cols - terminal width.
 * @returns wrapped content line count, at least 1.
 */
export function composerRows(inputLength: number, cols: number): number {
  const contentWidth = Math.max(1, cols - 6)
  return Math.max(1, Math.ceil((inputLength + 1) / contentWidth))
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

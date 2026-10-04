/**
 * Text in terminal cells. A frame row must be exactly as wide as the screen:
 * a wider one wraps and pushes every row below it down, a narrower one leaves
 * the previous frame showing. Colours are SGR codes, which take no cells.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR colour codes are what the frame is made of.
const SGR = /(\u001b\[[0-9;:]*m)/;
const RESET = '\u001b[0m';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** East Asian wide and fullwidth blocks, and emoji: two cells each. */
const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

function graphemeCells(grapheme: string): number {
  const code = grapheme.codePointAt(0) ?? 0;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (/^\p{Mark}+$/u.test(grapheme)) return 0;
  if (grapheme.includes('️') && /\p{Extended_Pictographic}/u.test(grapheme)) return 2;
  return WIDE.some(([from, to]) => code >= from && code <= to) ? 2 : 1;
}

/** Cells the text takes on screen, colour codes aside. */
export function cells(text: string): number {
  let total = 0;
  for (const part of text.split(SGR)) {
    if (part.startsWith('\u001b[')) continue;
    for (const { segment } of graphemes.segment(part)) total += graphemeCells(segment);
  }
  return total;
}

/**
 * Exactly `width` cells: a longer text is cut with `…`, a shorter one padded.
 * A colour cut off in the middle is reset at the end, so it does not run on
 * into the next row.
 */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  const size = cells(text);
  if (size <= width) return text + ' '.repeat(width - size);
  let out = '';
  let used = 0;
  let coloured = false;
  outer: for (const part of text.split(SGR)) {
    if (part.startsWith('\u001b[')) {
      out += part;
      coloured = true;
      continue;
    }
    for (const { segment } of graphemes.segment(part)) {
      const size = graphemeCells(segment);
      if (used + size > width - 1) break outer;
      out += segment;
      used += size;
    }
  }
  return `${out}…${' '.repeat(Math.max(0, width - 1 - used))}${coloured ? RESET : ''}`;
}

/**
 * Text from outside (a session title, a CLI's message, a folder) on one line
 * and harmless: colours stay, but no other escape sequence or control
 * character reaches the terminal — a title must not move the cursor.
 */
export function clean(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what goes, colours aside.
      .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[\s\S]?)/g, (sequence) =>
        sequence.endsWith('m') && SGR.test(sequence) ? sequence : '',
      )
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what goes.
      .replace(/[\u0000-\u001a\u001c-\u001f\u007f-\u009f]+/g, ' ')
  );
}

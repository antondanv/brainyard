/**
 * Bytes from a terminal in raw mode, as keys by name: `up`, `enter`, `esc`,
 * `ctrl-c`, `shift-tab`, or the character itself. One read can hold several
 * keys (a paste, a held arrow), so a chunk gives a list.
 */

const CSI: Readonly<Record<string, string>> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'shift-tab',
};

const TILDE: Readonly<Record<string, string>> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
};

/** A shortcut by its place on the keyboard: `й` is `q` on a Russian layout. */
const RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const SHIFT_EN = 'QWERTYUIOP{}ASDFGHJKL:"ZXCVBNM<>~';
const LAYOUT = new Map(
  [...RU].flatMap((letter, index) => [
    [letter, EN[index]!],
    [letter.toUpperCase(), SHIFT_EN[index]!],
  ]),
);

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function parseKeys(data: string): string[] {
  const keys: string[] = [];
  let at = 0;
  while (at < data.length) {
    const char = data[at]!;
    if (char === '\u001b') {
      const next = data[at + 1];
      // A sequence: ESC [ params final, or ESC O final (arrows in application mode).
      if (next === '[') {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what a terminal sends.
        const match = /^\u001b\[([<?]?[0-9;:]*)([@-~])/.exec(data.slice(at));
        if (match) {
          const [whole, params = '', final = ''] = match;
          at += whole.length;
          // A mouse report (SGR) is not a key.
          if (params.startsWith('<')) continue;
          const key = final === '~' ? TILDE[params.split(';')[0] ?? ''] : CSI[final];
          if (key) keys.push(key);
          continue;
        }
      }
      if (next === 'O' && at + 2 < data.length) {
        const key = CSI[data[at + 2]!];
        if (key) keys.push(key);
        at += 3;
        continue;
      }
      // Alt+key arrives as ESC and the key: Esc alone is what the app knows.
      keys.push('esc');
      at += 1;
      continue;
    }
    const code = char.charCodeAt(0);
    if (char === '\r' || char === '\n') {
      keys.push('enter');
      // A terminal may send CR LF for one Enter.
      at += char === '\r' && data[at + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (char === '\t') keys.push('tab');
    else if (code === 0x7f || code === 0x08) keys.push('backspace');
    else if (code === 0) keys.push('ctrl-space');
    else if (code < 0x20) keys.push(`ctrl-${String.fromCharCode(code + 96)}`);
    else {
      const [{ segment } = { segment: char }] = graphemes.segment(data.slice(at, at + 8));
      keys.push(LAYOUT.get(segment) ?? segment);
      at += segment.length;
      continue;
    }
    at += 1;
  }
  return keys;
}

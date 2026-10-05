import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (name: string) => readFileSync(join(root, name), 'utf8');
const READMES = ['README.md', 'README.ru.md'];

/** Every link and picture outside fenced code, Markdown and HTML alike, in order. */
function targets(markdown: string): string[] {
  const prose = markdown
    .split(/^```.*$/m)
    .filter((_, index) => index % 2 === 0)
    .join('\n');
  const found: [number, string][] = [];
  // `](…)` also catches a link around a picture: `[![licence](badge)](LICENSE)`.
  for (const match of prose.matchAll(/\]\(([^)\s]+)\)/g)) found.push([match.index, match[1] ?? '']);
  for (const match of prose.matchAll(/\s(?:src|href)="([^"]+)"/g)) found.push([match.index, match[1] ?? '']);
  return found.sort((a, b) => a[0] - b[0]).map(([, target]) => target);
}

const relative = (target: string) => !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
const pictures = (markdown: string) => targets(markdown).filter((target) => target.startsWith('docs/assets/'));

/** The anchors GitHub gives the headings. */
function anchors(markdown: string): Set<string> {
  const prose = markdown
    .split(/^```.*$/m)
    .filter((_, index) => index % 2 === 0)
    .join('\n');
  return new Set(
    [...prose.matchAll(/^#+ (.+)$/gm)].map((match) =>
      (match[1] ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s/g, '-'),
    ),
  );
}

describe('README', () => {
  it.each(READMES)('%s: every relative link and picture leads somewhere', (name) => {
    const markdown = read(name);
    const broken = targets(markdown)
      .filter(relative)
      .filter((target) =>
        target.startsWith('#') ? !anchors(markdown).has(target.slice(1)) : !existsSync(join(root, target)),
      );
    expect(broken).toEqual([]);
  });

  it('the Russian one shows the same pictures, in Russian where there is one', () => {
    const russian = (picture: string) => {
      const translated = picture.replace(/\.png$/, '.ru.png');
      return existsSync(join(root, translated)) ? translated : picture;
    };
    expect(pictures(read('README.ru.md'))).toEqual(pictures(read('README.md')).map(russian));
  });

  it('every picture in docs/assets is shown', () => {
    const shown = new Set(READMES.flatMap((name) => pictures(read(name))));
    // Hidden files are the system's (.DS_Store), not pictures.
    const unused = readdirSync(join(root, 'docs/assets')).filter(
      (file) => !file.startsWith('.') && !shown.has(`docs/assets/${file}`),
    );
    expect(unused).toEqual([]);
  });

  it('npm gets the English one, pointing into the repository at the release tag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brainyard-pack-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '9.8.7' }));
      execFileSync(process.execPath, [join(root, 'scripts/package-files.mjs')], { cwd: dir });
      expect(readdirSync(dir).sort()).toEqual(['CHANGELOG.md', 'LICENSE', 'README.md', 'package.json']);
      const readme = readFileSync(join(dir, 'README.md'), 'utf8');
      expect(
        targets(readme)
          .filter(relative)
          .filter((target) => !target.startsWith('#')),
      ).toEqual([]);
      expect(readme).toContain(
        'src="https://raw.githubusercontent.com/antondanv/brainyard/v9.8.7/docs/assets/app-terminal.png"',
      );
      expect(readme).toContain('[Русский](https://github.com/antondanv/brainyard/blob/v9.8.7/README.ru.md)');
      expect(readme).toContain('](https://github.com/antondanv/brainyard/blob/v9.8.7/LICENSE)');
      // Code is left as it is.
      expect(readme).toContain('```console\n$ brainyard status');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

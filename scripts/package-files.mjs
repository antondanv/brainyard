// npm packs only what is inside a package's folder: the README, the changelog and
// the licence live once at the repository root and are copied in before packing.
// The README goes in English alone, since npm shows whichever README.* it finds
// first, and with its links pointing into the repository at the release's tag:
// on the package's page a relative link or picture leads nowhere.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'antondanv/brainyard';

/** The README with each relative link and picture outside code pointing into the repository at `v<version>`. */
export function forNpm(markdown, version) {
  // A picture is served as itself; anything else as GitHub's page for it.
  const absolute = (path) => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(path)) return path;
    const file = path.replace(/^\.\//, '');
    return /\.(png|svg|jpe?g|gif|webp)$/i.test(file)
      ? `https://raw.githubusercontent.com/${REPOSITORY}/v${version}/${file}`
      : `https://github.com/${REPOSITORY}/blob/v${version}/${file}`;
  };
  // Prose, a fence, code, a fence, prose…: only prose has links.
  return markdown
    .split(/^(```.*)$/m)
    .map((part, index) =>
      index % 4 === 0
        ? part
            // `](…)` also catches a link around a picture: `[![licence](badge)](LICENSE)`.
            .replace(/\]\(([^)\s]+)\)/g, (_, path) => `](${absolute(path)})`)
            .replace(/(\s(?:src|href)=")([^"]+)"/g, (_, before, path) => `${before}${absolute(path)}"`)
        : part,
    )
    .join('');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  writeFileSync('README.md', forNpm(readFileSync(join(root, 'README.md'), 'utf8'), version));
  for (const name of ['CHANGELOG.md', 'LICENSE']) copyFileSync(join(root, name), name);
}

/**
 * The board's markup lives in web/board.html as a fragment, because that is
 * what the Claude artifact host expects — it supplies the document shell.
 * GitHub Pages serves plain files, so this wraps the same fragment into a
 * complete page at docs/index.html. One source, two homes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'web', 'board.html');
const target = path.join(root, 'docs', 'index.html');

const fragment = fs.readFileSync(source, 'utf8');
const title = fragment.match(/<title>([^<]*)<\/title>/)?.[1] ?? 'Plant Load Board';

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="Capacity and order tracking across partner plants." />
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>🏭</text></svg>" />
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; }
  img { max-width: 100%; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
${fragment}
</body>
</html>
`;

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, page, 'utf8');
console.log(`Wrote ${path.relative(root, target)} (${(page.length / 1024).toFixed(1)} KB) from ${path.relative(root, source)}`);

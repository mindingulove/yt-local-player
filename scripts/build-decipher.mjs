import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

await build({
  entryPoints: ['scripts/decipher-entry.mjs'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'safari16',
  minify: true,
  outfile: 'extension/lib/decipher.js',
});

const licenses = [
  ['YouTube.js 18.1.0', 'node_modules/youtubei.js/LICENSE'],
  ['Sval 0.6.12', 'node_modules/sval/LICENSE'],
  ['Acorn', 'node_modules/acorn/LICENSE'],
  ['Meriyah', 'node_modules/meriyah/LICENSE.md'],
  ['fflate', 'node_modules/fflate/LICENSE'],
  ['Protobuf-ES', 'vendor/protobuf-es.LICENSE'],
  ['Protobuf upstream', 'vendor/protobuf-upstream.LICENSE'],
];
const notices = await Promise.all(licenses.map(async ([name, path]) => `${name}\n${await readFile(path, 'utf8')}`));
await writeFile('extension/lib/decipher.LICENSE.txt', notices.join('\n\n--------------------\n\n'));

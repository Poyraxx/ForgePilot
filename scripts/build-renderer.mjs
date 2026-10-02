import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'src', 'renderer', 'app.js')],
  outfile: path.join(root, 'src', 'renderer', 'bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome134',
  minify: true,
  sourcemap: false,
});

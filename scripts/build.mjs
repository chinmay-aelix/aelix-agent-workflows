// Generates workflows/*.json from src/workflows/*.mjs.
// Usage: node scripts/build.mjs           write the JSON files
//        node scripts/build.mjs --check   fail if a committed JSON file is out of date with its source

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src', 'workflows');
const outDir = path.join(root, 'workflows');
const check = process.argv.includes('--check');
fs.mkdirSync(outDir, { recursive: true });

let stale = 0;
for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.mjs')).sort()) {
  const { default: build } = await import(pathToFileURL(path.join(srcDir, file)).href);
  const wf = build();
  const out = path.join(outDir, file.replace(/\.mjs$/, '.json'));
  const json = JSON.stringify(wf.toJSON(), null, 2) + '\n';
  const rel = path.relative(root, out);
  if (check) {
    const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
    if (current === json) console.log(`ok    ${rel}`);
    else { console.log(`STALE ${rel}  (run npm run build and commit the result)`); stale++; }
    continue;
  }
  fs.writeFileSync(out, json);
  const counts = wf.nodes.reduce((acc, n) => ((acc[n.type === 'n8n-nodes-base.stickyNote' ? 'stickies' : 'nodes']++), acc), { nodes: 0, stickies: 0 });
  console.log(`${rel}  ${counts.nodes} nodes, ${counts.stickies} stickies`);
}
process.exit(stale ? 1 : 0);

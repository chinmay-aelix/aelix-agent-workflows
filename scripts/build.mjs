// Generates workflows/*.json from scripts/workflows/*.mjs.
// Usage: node scripts/build.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'scripts', 'workflows');
const outDir = path.join(root, 'workflows');
fs.mkdirSync(outDir, { recursive: true });

for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.mjs')).sort()) {
  const { default: build } = await import(pathToFileURL(path.join(srcDir, file)).href);
  const wf = build();
  const out = path.join(outDir, file.replace(/\.mjs$/, '.json'));
  fs.writeFileSync(out, JSON.stringify(wf.toJSON(), null, 2) + '\n');
  const counts = wf.nodes.reduce((acc, n) => ((acc[n.type === 'n8n-nodes-base.stickyNote' ? 'stickies' : 'nodes']++), acc), { nodes: 0, stickies: 0 });
  console.log(`${path.relative(root, out)}  ${counts.nodes} nodes, ${counts.stickies} stickies`);
}

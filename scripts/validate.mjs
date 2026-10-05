// Validates workflows/*.json two ways:
//  1. n8n's own validator (@n8n/workflow-sdk validateWorkflow) against the node
//     parameter schemas shipped with n8n-nodes-base and @n8n/n8n-nodes-langchain.
//  2. Layout checks: every node sits inside exactly one sticky, stickies don't overlap.
//
// Usage: node scripts/validate.mjs
// Needs the n8n packages. Either `npm install` in this folder, or point
// N8N_MODULES at a node_modules folder that has n8n installed.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = process.env.N8N_MODULES ?? path.join(root, 'node_modules');
const require = createRequire(path.join(modules, 'noop.js'));
const sdk = require('@n8n/workflow-sdk');

const defDirs = ['n8n-nodes-base', '@n8n/n8n-nodes-langchain']
  .map((p) => path.join(path.dirname(require.resolve(`${p}/package.json`)), 'dist', 'node-definitions'))
  .filter((d) => fs.existsSync(d));
sdk.setSchemaBaseDirs(defDirs);

const STICKY = 'n8n-nodes-base.stickyNote';
const SIZE = {
  '@n8n/n8n-nodes-langchain.agent': [220, 100],
};
const inside = (n, s) => {
  const [w, h] = SIZE[n.type] ?? [100, 100];
  const [sx, sy] = s.position;
  const { width, height } = s.parameters;
  return n.position[0] >= sx && n.position[1] >= sy && n.position[0] + w <= sx + width && n.position[1] + h <= sy + height;
};
const overlap = (a, b) =>
  a.position[0] < b.position[0] + b.parameters.width && b.position[0] < a.position[0] + a.parameters.width &&
  a.position[1] < b.position[1] + b.parameters.height && b.position[1] < a.position[1] + a.parameters.height;

let failed = false;
const dir = path.join(root, 'workflows');
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const wf = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const problems = [];

  const result = sdk.validateWorkflow(wf, { validateSchema: true });
  for (const e of result.errors) problems.push(`error ${e.code}: ${e.nodeName ? e.nodeName + ': ' : ''}${e.message}`);
  for (const w of result.warnings) {
    if (w.severity === 'informational') continue;
    problems.push(`warning ${w.code}: ${w.nodeName ? w.nodeName + ': ' : ''}${w.message}`);
  }

  const stickies = wf.nodes.filter((n) => n.type === STICKY);
  const nodes = wf.nodes.filter((n) => n.type !== STICKY);
  for (const n of nodes) {
    const hits = stickies.filter((s) => inside(n, s));
    if (hits.length !== 1) problems.push(`layout: "${n.name}" is inside ${hits.length} stickies (${hits.map((s) => s.name).join(', ') || 'none'})`);
  }
  for (let i = 0; i < stickies.length; i++)
    for (let j = i + 1; j < stickies.length; j++)
      if (overlap(stickies[i], stickies[j])) problems.push(`layout: stickies "${stickies[i].name}" and "${stickies[j].name}" overlap`);

  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [from, types] of Object.entries(wf.connections)) {
    if (!names.has(from)) problems.push(`graph: connection from unknown node "${from}"`);
    for (const outs of Object.values(types))
      for (const out of outs) for (const c of out) if (!names.has(c.node)) problems.push(`graph: "${from}" connects to unknown node "${c.node}"`);
  }

  if (JSON.stringify(wf).includes('—')) problems.push('style: contains an em-dash');

  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${file}  (${nodes.length} nodes, ${stickies.length} stickies)`);
  for (const p of problems) console.log('     ' + p);
  if (result.errors.length || problems.some((p) => !p.startsWith('warning'))) failed = true;
}
process.exit(failed ? 1 : 0);

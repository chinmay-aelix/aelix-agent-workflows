// Runs the deterministic Code nodes (guardrails, verification, safety screen, hand-off)
// from the built workflow JSON against fixed scenarios. No n8n, no model, no network.
// Usage: node scripts/test-guardrails.mjs

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => JSON.parse(fs.readFileSync(path.join(root, 'workflows', f), 'utf8'));

// Minimal stand-ins for the n8n Code node globals used in these nodes.
function run(wf, nodeName, { json = {}, nodes = {} }) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  assert.ok(node, `node ${nodeName} not found`);
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`no paired item for ${name}`);
    return { item: { json: nodes[name] }, first: () => ({ json: nodes[name] }) };
  };
  const fn = new Function('$json', '$', '$execution', node.parameters.jsCode);
  return fn(json, $, { id: 'test-exec' }).json;
}

const days = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let passed = 0;
const test = (name, f) => {
  try { f(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

// ---------------- FinTech ----------------
{
  const wf = load('01-fintech-refund-handler.json');
  console.log('FinTech · Refund handler');
  const Config = { refund_window_days: 30, auto_refund_max_cents: 25000, min_confidence: 0.85 };
  const req = { business_key: 'RR-1', request_id: 'RR-1', order_number: 'ATX-44102', customer_email: 'jo@example.com', requested_amount: null, currency: 'usd' };
  const agent = (o = {}) => ({ output: { decision: 'refund_full', payment_intent_id: 'pi_1', refund_amount_cents: 14820, currency: 'usd', confidence: 0.95, eligibility: { identity_match: true }, ...o }, intermediateSteps: [] });
  const pi = (o = {}) => ({ id: 'pi_1', status: 'succeeded', currency: 'usd', created: Date.now() / 1000 - 4 * 86400, receipt_email: 'jo@example.com', latest_charge: { amount_captured: 14820, amount_refunded: 0, disputed: false }, ...o });
  const g = (json, a = agent(), r = req) => run(wf, 'Guardrails', { json, nodes: { Config, 'Normalize request': r, 'Refund agent': a } });

  test('eligible refund routes auto', () => {
    const out = g(pi());
    assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
    assert.deepEqual(out.refund, { payment_intent: 'pi_1', amount_cents: 14820, currency: 'usd' });
  });
  test('over auto limit escalates', () => assert.equal(g(pi({ latest_charge: { amount_captured: 90000, amount_refunded: 0 } }), agent({ refund_amount_cents: 90000 })).route, 'escalate'));
  test('more than refundable escalates', () => assert.equal(g(pi({ latest_charge: { amount_captured: 14820, amount_refunded: 10000 } })).route, 'escalate'));
  test('disputed charge escalates', () => assert.equal(g(pi({ latest_charge: { amount_captured: 14820, amount_refunded: 0, disputed: true } })).route, 'escalate'));
  test('outside window escalates', () => assert.equal(g(pi({ created: Date.now() / 1000 - 45 * 86400 })).route, 'escalate'));
  test('email mismatch escalates', () => assert.equal(g(pi({ receipt_email: 'someone@else.com' })).route, 'escalate'));
  test('low confidence escalates', () => assert.equal(g(pi(), agent({ confidence: 0.6 })).route, 'escalate'));
  test('refund above requested amount escalates', () => assert.equal(g(pi(), agent(), { ...req, requested_amount: 50 }).route, 'escalate'));
  test('verify accepts matching refund', () => {
    const v = run(wf, 'Verify refund', { json: { id: 're_1', status: 'succeeded', amount: 14820, payment_intent: 'pi_1' }, nodes: { Guardrails: { refund: { payment_intent: 'pi_1', amount_cents: 14820 } } } });
    assert.equal(v.verified, true);
  });
  test('verify rejects wrong amount', () => {
    const v = run(wf, 'Verify refund', { json: { id: 're_1', status: 'succeeded', amount: 100, payment_intent: 'pi_1' }, nodes: { Guardrails: { refund: { payment_intent: 'pi_1', amount_cents: 14820 } } } });
    assert.equal(v.verified, false);
  });
  test('hand-off explains a denial', () => {
    const ex = run(wf, 'Build exception', { json: { output: agent({ decision: 'deny' }).output }, nodes: { 'Normalize request': req, 'Refund agent': agent({ decision: 'deny' }) } });
    assert.match(ex.reasons.join(' '), /deny/);
    assert.match(ex.summary, /ATX-44102/);
  });
  test('hand-off carries a system error', () => {
    const ex = run(wf, 'Build exception', { json: { error: { message: 'Stripe 500' } }, nodes: { 'Normalize request': req } });
    assert.match(ex.reasons.join(' '), /Stripe 500/);
  });
}

// ---------------- Healthcare ----------------
{
  const wf = load('02-healthcare-prior-auth-triage.json');
  console.log('Healthcare · Prior-auth triage');
  const Config = { min_confidence: 0.8 };
  const req = { business_key: 'PA-1', request_id: 'PA-1', requested_urgency: 'standard' };
  const agent = (o = {}) => ({ output: {
    patient_found: true, coverage_active: true, pa_required: 'yes', urgency_assessment: 'standard', route_queue: 'needs_documents',
    packet: [{ item: 'MRI order', status: 'present', source: 'ServiceRequest/1' }, { item: 'PT notes', status: 'missing', source: '' }], confidence: 0.9, ...o } });
  const g = (a) => run(wf, 'Guardrails', { json: a, nodes: { Config, 'Normalize request': req, 'Prior-auth agent': a } });
  test('complete triage routes auto', () => assert.equal(g(agent()).route, 'auto'));
  test('urgency disagreement escalates', () => assert.equal(g(agent({ urgency_assessment: 'expedited' })).route, 'escalate'));
  test('ready with gaps escalates', () => assert.equal(g(agent({ route_queue: 'ready_for_submission_review' })).route, 'escalate'));
  test('present without source escalates', () => assert.equal(g(agent({ packet: [{ item: 'x', status: 'present', source: '' }] })).route, 'escalate'));
  test('unknown PA need escalates', () => assert.equal(g(agent({ pa_required: 'unknown' })).route, 'escalate'));
}

// ---------------- Manufacturing ----------------
{
  const wf = load('03-manufacturing-invoice-exception.json');
  console.log('Manufacturing · Invoice exception');
  const Config = { price_tolerance_pct: 2, max_auto_variance_amount: 500, min_confidence: 0.85 };
  const req = { business_key: 'INV-1', invoice_id: 'INV-1' };
  const lines = [{ line: '1', received_qty: 100, invoiced_qty: 100, po_unit_price: 10, invoiced_unit_price: 10.15 }];
  const agent = (o = {}) => ({ output: { recommended_action: 'approve_within_tolerance', total_variance_amount: 15, duplicate_of_invoice_id: null, confidence: 0.92, ...o } });
  const g = (m, a = agent()) => run(wf, 'Guardrails', { json: m, nodes: { Config, 'Normalize exception': req, 'Invoice exception agent': a } });
  test('1.5% price variance approves', () => {
    const out = g({ status: 'match_exception', lines });
    assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
    assert.equal(out.variance, 15);
  });
  test('quantity over receipt escalates', () => assert.equal(g({ status: 'match_exception', lines: [{ ...lines[0], received_qty: 90 }] }).route, 'escalate'));
  test('5% variance escalates', () => assert.equal(g({ status: 'match_exception', lines: [{ ...lines[0], invoiced_unit_price: 10.5 }] }, agent({ total_variance_amount: 50 })).route, 'escalate'));
  test('agent arithmetic mismatch escalates', () => assert.equal(g({ status: 'match_exception', lines }, agent({ total_variance_amount: 5 })).route, 'escalate'));
  test('status changed underneath escalates', () => assert.equal(g({ status: 'approved', lines }).route, 'escalate'));
}

// ---------------- Logistics ----------------
{
  const wf = load('04-logistics-shipment-exceptions.json');
  console.log('Logistics · Shipment exceptions');
  const Config = { max_rebook_cost_delta: 300, min_confidence: 0.85 };
  const req = { business_key: 'S-1:E-1', event_code: 'DELAYED' };
  const promised = new Date(Date.now() + 3 * 86400000).toISOString();
  const agent = (o = {}) => ({ output: {
    root_cause: 'weather', recommend_escalate: false, promised_delivery: promised, recommended_option_id: 'opt-2',
    options: [
      { option_id: 'opt-1', type: 'wait', quote_id: null, cost_delta: 0, eta: new Date(Date.now() + 5 * 86400000).toISOString(), carrier: 'A' },
      { option_id: 'opt-2', type: 'rebook', quote_id: 'Q-9', cost_delta: 180, eta: new Date(Date.now() + 2 * 86400000).toISOString(), carrier: 'B' },
    ], confidence: 0.9, ...o } });
  const shp = { status: 'in_transit', promised_delivery: promised, customer: { email: 'c@example.com' } };
  const g = (a, j = shp, r = req) => run(wf, 'Guardrails', { json: j, nodes: { Config, 'Normalize event': r, 'Shipment exception agent': a } });
  test('rebook within budget routes auto', () => {
    const out = g(agent());
    assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
    assert.equal(out.plan.quote_id, 'Q-9');
  });
  test('rebook over budget escalates', () => assert.equal(g(agent({ options: agent().output.options.map((o) => ({ ...o, cost_delta: 900 })) })).route, 'escalate'));
  test('damage always escalates', () => assert.equal(g(agent(), shp, { ...req, event_code: 'DAMAGED' }).route, 'escalate'));
  test('wait option routes auto', () => assert.equal(g(agent({ recommended_option_id: 'opt-1' })).route, 'auto'));
  test('delivered shipment escalates', () => assert.equal(g(agent(), { ...shp, status: 'delivered' }).route, 'escalate'));
}

// ---------------- LegalTech ----------------
{
  const wf = load('05-legaltech-contract-intake.json');
  console.log('LegalTech · Contract intake');
  const Config = { min_confidence: 0.8, min_text_chars: 800, max_text_chars: 200000, queue_by_type: { nda: 'commercial', dpa: 'privacy' } };
  const req = { business_key: 'CI-1', counterparty_stated: 'Northwind Traders' };
  const agent = (o = {}) => ({ output: { contract_type: 'nda', suggested_queue: 'commercial', counterparty_name: 'Northwind Traders, Inc.', risk_tier: 'low', confidence: 0.9, ...o } });
  const g = (a, r = req) => run(wf, 'Guardrails', { json: a, nodes: { Config, 'Normalize intake': r, 'Contract intake agent': a } });
  test('mapped type and matching counterparty routes auto', () => {
    const out = g(agent());
    assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
    assert.equal(out.queue, 'commercial');
  });
  test('queue disagreement escalates', () => assert.equal(g(agent({ suggested_queue: 'privacy' })).route, 'escalate'));
  test('different counterparty escalates', () => assert.equal(g(agent({ counterparty_name: 'Contoso Ltd' })).route, 'escalate'));
  test('high risk still routes, high priority', () => assert.equal(g(agent({ risk_tier: 'high' })).priority, 'high'));
  test('scanned PDF is flagged for OCR', () => {
    const q = run(wf, 'Check text quality', { json: { text: 'Page 1' }, nodes: { Config } });
    assert.equal(q.readable, false);
    assert.match(q.handoff_reason, /OCR/);
  });
}

// ---------------- Energy ----------------
{
  const wf = load('06-energy-outage-ticket-triage.json');
  console.log('Energy & Utilities · Outage triage');
  const Config = { min_confidence: 0.85 };
  const t = { business_key: 'T-1', ticket_id: 'T-1', description: 'Power out since 7pm, neighbours too' };
  test('plain outage report passes the safety screen', () => assert.equal(run(wf, 'Safety screen', { nodes: { 'Normalize ticket': t } }).hazard, false));
  test('wires down trips the safety screen', () => {
    const s = run(wf, 'Safety screen', { nodes: { 'Normalize ticket': { ...t, description: 'Tree fell, wires down across the road, sparking' } } });
    assert.equal(s.hazard, true);
    assert.match(s.handoff_reason, /SAFETY/);
  });
  const agent = (o = {}) => ({ output: { classification: 'part_of_known_outage', matched_outage_id: 'O-7', premise_feeder_id: 'F12', critical_customer: false, priority: 'P3', confidence: 0.9, ...o } });
  const g = (a, outage = { outage_id: 'O-7', status: 'crew_assigned', feeder_id: 'F12', etr: '2026-09-28T22:00:00Z' }) =>
    run(wf, 'Guardrails', { json: outage, nodes: { Config, 'Normalize ticket': t, 'Outage triage agent': a } });
  test('known outage on same feeder links automatically', () => assert.equal(g(agent()).route, 'auto'));
  test('different feeder escalates', () => assert.equal(g(agent({ premise_feeder_id: 'F99' })).route, 'escalate'));
  test('critical customer escalates', () => assert.equal(g(agent({ critical_customer: true })).route, 'escalate'));
  test('restored outage escalates', () => assert.equal(g(agent(), { outage_id: 'O-7', status: 'restored', feeder_id: 'F12' }).route, 'escalate'));
}

// ---------------- Real estate ----------------
{
  const wf = load('07-realestate-vendor-onboarding.json');
  console.log('Real Estate & Construction · Vendor onboarding');
  const Config = { min_confidence: 0.85, min_gl_each_occurrence: 1000000, coi_min_days_valid: 30, required_docs_by_trade: { default: ['w9', 'coi'], electrical: ['w9', 'coi', 'license', 'safety_program'] } };
  const req = { business_key: 'VA-1', trade: 'electrical' };
  const docs = (o = {}) => ['w9', 'coi', 'license', 'safety_program'].map((d) => ({ document: d, status: 'valid', expires_on: d === 'coi' ? days(200) : null, detail: '', ...(o[d] ?? {}) }));
  const agent = (o = {}) => ({ output: {
    documents: docs(), coi: { gl_each_occurrence: 2000000, gl_aggregate: 4000000, auto_limit: 1000000, workers_comp: true, additional_insured: true, expires_on: days(200) },
    license: { status: 'active', expires_on: days(400), holder_matches: true }, sanctions: 'clear', sanctions_detail: '', ready_for_approval: true, confidence: 0.92, ...o } });
  const g = (a) => run(wf, 'Guardrails', { json: a, nodes: { Config, 'Normalize application': req, 'Vendor onboarding agent': a } });
  test('complete file goes to procurement', () => {
    const out = g(agent());
    assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
    assert.equal(out.portal_status, 'pending_approval');
  });
  test('certificate expiring in 10 days asks the vendor', () => {
    const out = g(agent({ documents: docs({ coi: { expires_on: days(10) } }), ready_for_approval: false }));
    assert.equal(out.route, 'auto', out.guardrail_reasons.join('; '));
    assert.equal(out.portal_status, 'action_required');
    assert.match(out.vendor_items.join(' '), /expires/);
  });
  test('missing safety program asks the vendor', () => {
    const out = g(agent({ documents: docs({ safety_program: { status: 'missing' } }), ready_for_approval: false }));
    assert.equal(out.portal_status, 'action_required');
  });
  test('low liability limit asks the vendor', () => {
    const out = g(agent({ coi: { ...agent().output.coi, gl_each_occurrence: 500000 }, ready_for_approval: false }));
    assert.match(out.vendor_items.join(' '), /general liability/);
  });
  test('sanctions possible match escalates', () => assert.equal(g(agent({ sanctions: 'possible_match' })).route, 'escalate'));
  test('agent says ready but checks disagree escalates', () => assert.equal(g(agent({ documents: docs({ w9: { status: 'missing' } }) })).route, 'escalate'));
}

console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}`);

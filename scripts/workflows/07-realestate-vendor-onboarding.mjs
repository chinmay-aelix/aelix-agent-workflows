import {
  Workflow, COLOR, S, COMMON_OUTPUT, SYSTEM_TAIL, guardPreamble,
  webhook, config, code, ifTrue, http, gmail, slack, setFields,
  agentBlock, handoffTail, auditTail, overviewStickies,
} from '../lib.mjs';

const DOCS = ['w9', 'coi', 'license', 'safety_program', 'bank_letter'];

export default function build() {
  const wf = new Workflow('Real Estate & Construction · Vendor onboarding agent', 'realestate-vendor-onboarding');
  const AGENT = 'Vendor onboarding agent';
  const INTAKE = 'Normalize application';
  const GUARD = 'Guardrails';
  const cfg = `$('Config').first().json`;
  const api = { kind: 'header' };

  // ---------- intake ----------
  wf.add(webhook('Vendor application submitted', [0, 0], 'aelix/realestate/vendor-onboarding', wf.slug));
  wf.add(config('Config', [220, 0], {
    portal_base_url: 'https://vendors.YOUR-COMPANY.example/api/v1',
    document_service_url: 'https://docs.YOUR-COMPANY.example/api',
    license_api_url: 'https://license-lookup.YOUR-COMPANY.example/api',
    screening_api_url: 'https://screening.YOUR-COMPANY.example/api',
    required_docs_by_trade: {
      default: ['w9', 'coi'],
      electrical: ['w9', 'coi', 'license', 'safety_program'],
      plumbing: ['w9', 'coi', 'license', 'safety_program'],
      hvac: ['w9', 'coi', 'license', 'safety_program'],
      roofing: ['w9', 'coi', 'license', 'safety_program'],
      general_contractor: ['w9', 'coi', 'license', 'safety_program'],
    },
    min_gl_each_occurrence: 1000000,
    coi_min_days_valid: 30,
    min_confidence: 0.85,
    slack_channel_approvals: '#vendor-approvals',
    slack_channel_exceptions: '#vendor-onboarding-exceptions',
  }));
  wf.add(code(INTAKE, [440, 0], `
const b = $json.body ?? $json;
const missing = ['vendor_application_id', 'legal_name', 'contact'].filter((k) => !b[k]);
if (missing.length) throw new Error('Vendor application missing fields: ' + missing.join(', '));
return {
  json: {
    business_key: String(b.vendor_application_id),
    application_id: String(b.vendor_application_id),
    legal_name: String(b.legal_name),
    trade: String(b.trade ?? 'default').toLowerCase().replace(/[^a-z_]/g, '_'),
    state: String(b.state ?? '').toUpperCase(),
    license_number: String(b.license_number ?? ''),
    contact_name: String(b.contact?.name ?? ''),
    contact_email: String(b.contact?.email ?? '').toLowerCase(),
    project_id: b.project_id ? String(b.project_id) : null,
    documents: (b.documents ?? []).map((d) => ({ type: String(d.type ?? 'unknown'), url: String(d.url ?? '') })),
  },
};
`));
  wf.chain('Vendor application submitted', 'Config', INTAKE);

  // ---------- observe & plan ----------
  const block = agentBlock(wf, {
    name: AGENT,
    left: 700,
    prompt: `=Vendor application {{ $json.application_id }}
Legal name: {{ $json.legal_name }}
Trade: {{ $json.trade }} · State: {{ $json.state }} · License number given: {{ $json.license_number || 'none' }}
Project: {{ $json.project_id ?? 'none (general vendor list)' }}
Documents required for this trade: {{ (${cfg}.required_docs_by_trade[$json.trade] ?? ${cfg}.required_docs_by_trade.default).join(', ') }}
Documents uploaded: {{ JSON.stringify($json.documents) }}
Today: {{ $now.toISODate() }}

Check every uploaded document, verify the license and screen the company, and report what is valid, missing or needs fixing.`,
    system: `
You run document collection for vendor onboarding at a real estate and construction company. You check what a vendor uploaded against what their trade and project require, verify their license, screen them against sanctions lists, and report precisely what is valid and what the vendor still needs to provide. Procurement approves every vendor; you never approve one.

For each document:
- W-9 (w9): legal name matches the application, a TIN is present, it is signed and dated. Never repeat the full TIN in your output.
- Certificate of insurance (coi): named insured matches the legal name; record general liability each-occurrence and aggregate limits, auto liability limit, whether workers' compensation is shown, whether the certificate holder is named as additional insured, and the earliest policy expiration date.
- Contractor license (license): compare with the state license lookup, which is the source of truth. The uploaded copy alone is not enough.
- Safety program (safety_program): a written program specific to this company, not a blank template.
- Bank letter (bank_letter): note only that it is present and on bank letterhead. Do not extract account numbers.

Status per document: valid, missing, expired, insufficient (present but does not meet a requirement, say which), or unreadable. Use the project's insurance requirements when a project is given.

Sanctions: screen the legal name. Report clear, possible_match or match, and the list name for any hit.

Tools:
- "Read document": extracted text of an uploaded file.
- "Get project requirements": insurance limits and endorsements for a project.
- "Verify contractor license": state license lookup.
- "Screen sanctions": sanctions and denied-party screening.
${SYSTEM_TAIL}`,
    tools: [
      {
        name: 'Read document',
        description: 'Get the extracted text of one uploaded vendor document by its URL.',
        url: `={{ ${cfg}.document_service_url }}/extract`,
        auth: api,
        query: { url: `={{ $fromAI('document_url', 'URL of the uploaded document, from the application', 'string') }}` },
      },
      {
        name: 'Get project requirements',
        description: 'Get insurance requirements for a project: minimum limits by coverage and required endorsements (additional insured, waiver of subrogation).',
        url: `={{ ${cfg}.portal_base_url }}/projects/{{ $fromAI('project_id', 'Project id', 'string') }}/requirements`,
        auth: api,
      },
      {
        name: 'Verify contractor license',
        description: 'Look up a contractor license with the state licensing board. Returns holder name, classification, status and expiration.',
        url: `={{ ${cfg}.license_api_url }}/licenses`,
        auth: api,
        query: {
          state: `={{ $fromAI('state', 'Two-letter state code', 'string') }}`,
          number: `={{ $fromAI('license_number', 'License number', 'string') }}`,
        },
      },
      {
        name: 'Screen sanctions',
        description: 'Screen a company name against sanctions and denied-party lists (OFAC SDN and others). Returns matches with list name and score.',
        url: `={{ ${cfg}.screening_api_url }}/screen`,
        auth: api,
        query: { name: `={{ $fromAI('legal_name', 'Company legal name', 'string') }}`, type: 'organization' },
      },
    ],
    schema: S.obj({
      documents: S.arr(S.obj({
        document: S.enum(DOCS, 'Document type.'),
        status: S.enum(['valid', 'missing', 'expired', 'insufficient', 'unreadable'], 'Status.'),
        expires_on: S.nullable(S.str('ISO date, or null.')),
        detail: S.str('One sentence on what you checked or what is wrong.'),
      }), 'One entry for every required document and every uploaded one.'),
      coi: S.nullable(S.obj({
        gl_each_occurrence: S.num('General liability each occurrence.'),
        gl_aggregate: S.num('General liability aggregate.'),
        auto_limit: S.num('Auto liability combined single limit, 0 if none.'),
        workers_comp: S.bool('Workers compensation shown.'),
        additional_insured: S.bool('Certificate holder named as additional insured.'),
        expires_on: S.str('Earliest policy expiration, ISO date.'),
      })),
      license: S.obj({
        status: S.enum(['active', 'inactive', 'expired', 'not_found', 'not_required'], 'Per the state lookup.'),
        expires_on: S.nullable(S.str('ISO date, or null.')),
        holder_matches: S.bool('License holder name matches the legal name.'),
      }),
      sanctions: S.enum(['clear', 'possible_match', 'match'], 'Screening result.'),
      sanctions_detail: S.str('List name and matched entity, or empty.'),
      ready_for_approval: S.bool('Every required document is valid and screening is clear.'),
      ...COMMON_OUTPUT,
    }),
  });
  wf.link(INTAKE, AGENT);

  // ---------- guardrails ----------
  const gx = block.right + 140;
  wf.add(code(GUARD, [gx, 0], `
${guardPreamble(AGENT)}
const req = $('${INTAKE}').item.json;
const LABEL = { w9: 'W-9', coi: 'Certificate of insurance', license: 'Contractor license', safety_program: 'Safety program', bank_letter: 'Bank letter' };
const required = cfg.required_docs_by_trade[req.trade] ?? cfg.required_docs_by_trade.default;
const byType = Object.fromEntries((out?.documents ?? []).map((d) => [d.document, d]));
const minValid = Date.now() + cfg.coi_min_days_valid * 86400000;
const items = []; // what the vendor must fix, built from fixed labels only

for (const r of required) {
  const d = byType[r];
  if (!d || d.status === 'missing') items.push(LABEL[r] + ': not received');
  else if (d.status !== 'valid') items.push(LABEL[r] + ': ' + d.status);
  else if (d.expires_on && Date.parse(d.expires_on) < minValid) items.push(LABEL[r] + ': expires ' + d.expires_on + ', we need at least ' + cfg.coi_min_days_valid + ' days of cover');
}
if (required.includes('coi') && byType.coi?.status === 'valid' && out?.coi) {
  if (out.coi.gl_each_occurrence < cfg.min_gl_each_occurrence) items.push('Certificate of insurance: general liability must be at least ' + cfg.min_gl_each_occurrence.toLocaleString('en-US') + ' per occurrence');
  if (!out.coi.additional_insured) items.push('Certificate of insurance: add us as additional insured');
  if (!out.coi.workers_comp) items.push('Certificate of insurance: workers compensation coverage not shown');
}
if (required.includes('license')) {
  if (out?.license?.status === 'not_found') reasons.push('license not found in state lookup');
  else if (out?.license?.status !== 'active') items.push('Contractor license: state lookup shows ' + out?.license?.status);
  if (out?.license && !out.license.holder_matches) reasons.push('license holder name does not match the legal name');
}
if (out && out.sanctions !== 'clear') reasons.push('sanctions screening: ' + out.sanctions + ' ' + (out.sanctions_detail ?? ''));
if (out && out.ready_for_approval !== (items.length === 0)) reasons.push('agent readiness (' + out.ready_for_approval + ') disagrees with the checks (' + items.length + ' open items)');

const ok = reasons.length === 0;
return {
  json: {
    business_key: req.business_key,
    route: ok ? 'auto' : 'escalate',
    guardrail_reasons: reasons,
    portal_status: items.length ? 'action_required' : 'pending_approval',
    vendor_items: items,
    planned_actions: ok ? [{ action: 'portal.set_status', status: items.length ? 'action_required' : 'pending_approval', items }] : [],
  },
};
`));
  wf.add(ifTrue('Proceed automatically?', [gx + 220, 0], `={{ $json.route === 'auto' }}`));
  wf.link(AGENT, GUARD);
  wf.link(GUARD, 'Proceed automatically?');

  // ---------- act & verify ----------
  const ax = gx + 480;
  wf.add(http('Update application status', [ax, 0], {
    method: 'PATCH',
    url: `={{ ${cfg}.portal_base_url }}/applications/{{ $('${INTAKE}').item.json.application_id }}`,
    auth: api,
    json: `={{ JSON.stringify({ status: $json.portal_status, open_items: $json.vendor_items, checklist: $('${AGENT}').item.json.output.documents, reviewed_by: 'aelix-vendor-agent' }) }}`,
    errorOutput: true,
  }));
  wf.add(http('Read back application', [ax + 220, 0], {
    url: `={{ ${cfg}.portal_base_url }}/applications/{{ $('${INTAKE}').item.json.application_id }}`,
    auth: api,
    errorOutput: true,
  }));
  wf.add(code('Verify status', [ax + 440, 0], `
const planned = $('${GUARD}').item.json.portal_status;
const ok = $json.status === planned;
return {
  json: {
    verified: ok,
    verify_failed: !ok,
    verify_detail: ok ? '' : 'portal shows ' + $json.status + ', expected ' + planned,
    status: $json.status,
  },
};
`));
  wf.add(ifTrue('Verified?', [ax + 660, 0], '={{ $json.verified }}'));
  wf.add(ifTrue('Ready for approval?', [ax + 880, 0], `={{ $json.status === 'pending_approval' }}`));
  wf.add(slack('Ask procurement to approve', [ax + 1100, -130], `={{ ${cfg}.slack_channel_approvals }}`,
    `={{ ':white_check_mark: ' + $('${INTAKE}').item.json.legal_name + ' (' + $('${INTAKE}').item.json.trade + ') has every required document verified and screening clear. Application ' + $('${INTAKE}').item.json.application_id + ' is ready for your approval. Confirm bank details by callback before the first payment.' }}`));
  wf.add(gmail('Request documents from vendor', [ax + 1100, 130], {
    to: `={{ $('${INTAKE}').item.json.contact_email }}`,
    subject: `=Action needed on your vendor application ({{ $('${INTAKE}').item.json.application_id }})`,
    message: `=Hello {{ $('${INTAKE}').item.json.contact_name.split(' ')[0] || 'there' }},

Thanks for applying to work with us. We reviewed your documents and need the following before we can continue:

{{ $('${GUARD}').item.json.vendor_items.map((i) => '- ' + i).join('\\n') }}

You can upload them in the vendor portal. We'll review them as soon as they arrive.`,
  }));
  wf.add(setFields('Mark completed', [ax + 1320, 0], { outcome: `={{ $('${GUARD}').item.json.portal_status === 'pending_approval' ? 'ready_for_approval' : 'documents_requested' }}` }));
  wf.link('Proceed automatically?', 'Update application status', 0);
  wf.link('Update application status', 'Read back application', 0);
  wf.link('Read back application', 'Verify status', 0);
  wf.link('Verify status', 'Verified?');
  wf.link('Verified?', 'Ready for approval?', 0);
  wf.link('Ready for approval?', 'Ask procurement to approve', 0);
  wf.link('Ready for approval?', 'Request documents from vendor', 1);
  wf.link('Ask procurement to approve', 'Mark completed');
  wf.link('Request documents from vendor', 'Mark completed');

  // ---------- hand off ----------
  const h = handoffTail(wf, {
    x: ax, y: 600, agentName: AGENT, intakeName: INTAKE, guardName: GUARD,
    team: 'vendor compliance', channel: `={{ ${cfg}.slack_channel_exceptions }}`,
    summary: `'Vendor ' + intake.legal_name + ' (' + intake.trade + ') · application ' + intake.application_id + ' · sanctions: ' + (agent?.output?.sanctions ?? 'not screened')`,
  });
  wf.link(AGENT, h.first, 1);
  wf.link('Proceed automatically?', h.first, 1);
  wf.link('Update application status', h.first, 1);
  wf.link('Read back application', h.first, 1);
  wf.link('Verified?', h.first, 1);

  // ---------- audit ----------
  const a = auditTail(wf, { x: ax + 1580, y: 300, agentName: AGENT, intakeName: INTAKE, guardName: GUARD });
  wf.link('Mark completed', a.first);
  wf.link(h.last, a.first);

  // ---------- stickies ----------
  wf.group({ name: 'Stage: intake', title: '1 · Intake', color: COLOR.intake, nodes: ['Vendor application submitted', 'Config', INTAKE], body: `
The vendor portal posts each submission or re-submission. **Config** holds required documents by trade, the insurance minimums and how many days of cover a certificate must still have.` });
  wf.group({ name: 'Stage: observe and plan', title: '2 · Check documents (agent)', color: COLOR.plan, nodes: block.nodes, body: `
Claude reads each upload (W-9, insurance certificate, license, safety program, bank letter), checks it against project requirements, verifies the license with the state board and screens sanctions lists.
It never repeats a full TIN or bank details, and **never approves a vendor**.` });
  wf.group({ name: 'Stage: guardrails', title: '3 · Guardrails', color: COLOR.guard, nodes: [GUARD, 'Proceed automatically?'], body: `
Code rebuilds the open-items list from the agent's per-document statuses: expiry windows, liability minimum, additional insured, workers' comp, license status.
Sanctions hits, license-holder mismatches and any disagreement with the agent's own verdict go to compliance.` });
  wf.group({ name: 'Stage: act and verify', title: '4 · Collect documents', color: COLOR.act, nodes: ['Update application status', 'Read back application', 'Verify status', 'Verified?', 'Ready for approval?', 'Ask procurement to approve', 'Request documents from vendor', 'Mark completed'], body: `
Sets the portal status, reads it back, then either asks the vendor for exactly what's missing (**fixed wording**, items built in code) or asks procurement to approve. Procurement confirms bank details by callback.` });
  wf.group({ name: 'Stage: hand off', title: '5 · Compliance review', color: COLOR.handoff, nodes: h.nodes, body: `
Sanctions matches, license problems and failed writes go to vendor compliance with the checklist and the tool trace.` });
  wf.group({ name: 'Stage: audit', title: '6 · Audit', color: COLOR.audit, nodes: a.nodes, body: `
One **agent_runs** row per submission.` });
  wf.alignTops(['Stage: intake', 'Stage: observe and plan', 'Stage: guardrails', 'Stage: act and verify']);

  overviewStickies(wf, {
    overview: `## Real Estate & Construction · Vendor onboarding agent
**Job:** take vendor document collection off the procurement desk. Check every upload against trade and project requirements, verify the license, screen sanctions, chase the vendor for exactly what's missing, and put complete files in front of procurement.

**Flow:** submission → agent checks documents (read-only) → guardrails rebuild the checklist → set portal status, read back → ask vendor or ask procurement → compliance for the rest → audit.

**Never does**
- Approves a vendor or creates one in the ERP
- Stores or repeats TINs or bank account numbers
- Handles sanctions matches

**Model:** Claude Opus 5, adaptive thinking, effort high.`,
    setup: `## Setup
1. Run **sql/schema.sql**. Select the Postgres credential on *Queue exception* and *Write audit record*.
2. Credentials: **Anthropic**, **Header Auth** for the portal, document service, license lookup and screening APIs, **Gmail**, **Slack**.
3. **Service contracts**: portal applications and projects, document text extraction, state license lookup, sanctions screening. Map to your vendor portal (Procore, Oracle Textura, a custom portal) and screening provider.
4. Edit **Config**: required documents by trade, insurance minimums, days of cover, channels.
5. Test: \`curl -X POST <test webhook URL> -H 'Content-Type: application/json' -d @samples/realestate-vendor-onboarding.json\``,
  });

  return wf;
}

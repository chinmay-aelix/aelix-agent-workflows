import {
  Workflow, COLOR, S, COMMON_OUTPUT, SYSTEM_TAIL, guardPreamble,
  webhook, config, code, ifTrue, postgres, slack, setFields,
  agentBlock, handoffTail, auditTail, overviewStickies,
} from '../lib.mjs';

export default function build() {
  const wf = new Workflow('Healthcare · Prior-auth triage agent', 'healthcare-prior-auth-triage');
  const AGENT = 'Prior-auth agent';
  const INTAKE = 'Normalize request';
  const GUARD = 'Guardrails';
  const cfg = `$('Config').first().json`;
  const fhir = { kind: 'header' };

  // ---------- intake ----------
  wf.add(webhook('Prior-auth request received', [0, 0], 'aelix/healthcare/prior-auth', wf.slug));
  wf.add(config('Config', [220, 0], {
    fhir_base_url: 'https://fhir.YOUR-EHR.example/R4',
    payer_rules_url: 'https://payer-rules.internal.example/api',
    min_confidence: 0.8,
    slack_channel_exceptions: '#pa-intake-exceptions',
    slack_channel_expedited: '#um-expedited',
  }));
  wf.add(code(INTAKE, [440, 0], `
// Only identifiers and codes travel into the prompt. Clinical detail is fetched
// by the agent from the EHR, so nothing extra is copied around.
const b = $json.body ?? $json;
const missing = ['request_id', 'patient_id', 'coverage_id'].filter((k) => !b[k]);
if (missing.length) throw new Error('Prior-auth request missing fields: ' + missing.join(', '));
const svc = b.service ?? {};
if (!Array.isArray(svc.cpt_codes) || !svc.cpt_codes.length) throw new Error('Prior-auth request has no CPT codes');

return {
  json: {
    business_key: String(b.request_id),
    request_id: String(b.request_id),
    patient_id: String(b.patient_id),
    coverage_id: String(b.coverage_id),
    ordering_provider_npi: String(b.ordering_provider?.npi ?? ''),
    cpt_codes: svc.cpt_codes.map(String),
    icd10_codes: (svc.icd10_codes ?? []).map(String),
    service_description: String(svc.description ?? '').slice(0, 500),
    requested_date: svc.requested_date ?? null,
    requested_urgency: b.urgency === 'expedited' ? 'expedited' : 'standard',
    documents: (b.documents ?? []).map((d) => ({ type: String(d.type ?? 'unknown'), url: String(d.url ?? '') })),
  },
};
`));
  wf.chain('Prior-auth request received', 'Config', INTAKE);

  // ---------- observe & plan ----------
  const block = agentBlock(wf, {
    name: AGENT,
    left: 700,
    prompt: `=Prior-authorization request {{ $json.request_id }}
Patient id (FHIR): {{ $json.patient_id }}
Coverage id (FHIR): {{ $json.coverage_id }}
Ordering provider NPI: {{ $json.ordering_provider_npi }}
CPT codes: {{ $json.cpt_codes.join(', ') }}
ICD-10 codes on the order: {{ $json.icd10_codes.join(', ') || 'none given' }}
Service: {{ $json.service_description }}
Requested date: {{ $json.requested_date ?? 'not given' }}
Urgency requested by the ordering office: {{ $json.requested_urgency }}
Documents attached to the request: {{ JSON.stringify($json.documents) }}

Work out whether prior authorization is needed, assemble the packet checklist against the payer's criteria, and say which worklist queue this belongs in.`,
    system: `
You triage prior-authorization requests for a hospital utilization management team. You do not submit anything to a payer and you do not make clinical judgments about whether the service is appropriate. You assemble what a PA coordinator needs and route the request to the right queue.

What a good triage looks like:
- Confirm the patient and coverage exist and the coverage is active on the requested date.
- Use the payer criteria for each CPT code to learn whether PA is required and which documents the payer expects (for example, recent clinical notes, imaging, prior conservative treatment, lab results).
- Build the packet checklist from those criteria. Mark an item "present" only when you found it in the EHR or in the attached documents, and name where (FHIR resource reference or document URL). Mark "unclear" when something related exists but may not satisfy the criterion.
- Assess urgency. Expedited review is for cases where the standard timeframe could seriously jeopardize the patient's life, health or ability to regain maximum function. Say why in expedite_reason. If your assessment differs from what the office requested, keep your own assessment and explain the difference.

Queues:
- ready_for_submission_review: PA required and every required item is present.
- needs_documents: PA required and one or more items are missing.
- clinical_review: the criteria turn on clinical judgment you should not make, or the documents conflict.
- no_pa_required_confirm: payer criteria say PA is not required; a coordinator confirms before the order proceeds.

Minimum necessary: reviewer_summary should say what the reviewer needs to act, in two to four sentences, without restating the full record.

Tools:
- "Get patient (FHIR)", "Get coverage (FHIR)", "List active conditions (FHIR)", "List clinical documents (FHIR)": read the EHR.
- "Get payer criteria": PA requirement and documentation criteria for one payer and one CPT code.
${SYSTEM_TAIL}`,
    tools: [
      {
        name: 'Get patient (FHIR)',
        description: 'Read a FHIR Patient resource by id. Returns demographics needed to confirm identity.',
        url: `={{ ${cfg}.fhir_base_url }}/Patient/{{ $fromAI('patient_id', 'FHIR Patient id', 'string') }}`,
        auth: fhir,
      },
      {
        name: 'Get coverage (FHIR)',
        description: 'Read a FHIR Coverage resource by id. Returns payer, plan, status and period.',
        url: `={{ ${cfg}.fhir_base_url }}/Coverage/{{ $fromAI('coverage_id', 'FHIR Coverage id', 'string') }}`,
        auth: fhir,
      },
      {
        name: 'List active conditions (FHIR)',
        description: 'Search active FHIR Condition resources for a patient.',
        url: `={{ ${cfg}.fhir_base_url }}/Condition`,
        auth: fhir,
        query: { patient: `={{ $fromAI('patient_id', 'FHIR Patient id', 'string') }}`, 'clinical-status': 'active', _count: '50' },
      },
      {
        name: 'List clinical documents (FHIR)',
        description: 'Search FHIR DocumentReference resources for a patient, newest first. Use the type filter (LOINC code) when looking for something specific, or leave it empty for all recent documents.',
        url: `={{ ${cfg}.fhir_base_url }}/DocumentReference`,
        auth: fhir,
        query: {
          patient: `={{ $fromAI('patient_id', 'FHIR Patient id', 'string') }}`,
          type: `={{ $fromAI('loinc_type', 'Optional LOINC document type code, empty string for all', 'string') }}`,
          _sort: '-date',
          _count: '25',
        },
      },
      {
        name: 'Get payer criteria',
        description: 'Get prior-authorization requirement and documentation criteria for one payer and one CPT code. Call once per CPT code.',
        url: `={{ ${cfg}.payer_rules_url }}/criteria`,
        auth: { kind: 'header' },
        query: {
          payer_id: `={{ $fromAI('payer_id', 'Payer identifier from the Coverage resource', 'string') }}`,
          cpt: `={{ $fromAI('cpt_code', 'One CPT code', 'string') }}`,
        },
      },
    ],
    schema: S.obj({
      patient_found: S.bool('The patient record exists.'),
      coverage_active: S.bool('Coverage is active on the requested date.'),
      payer_name: S.nullable(S.str('Payer name from coverage.')),
      pa_required: S.enum(['yes', 'no', 'unknown'], 'Whether the payer requires PA for these codes.'),
      packet: S.arr(S.obj({
        item: S.str('What the payer expects, for example "PT notes covering 6 weeks of conservative treatment".'),
        required_by: S.str('Which payer criterion asks for it.'),
        status: S.enum(['present', 'missing', 'unclear'], 'Whether you found it.'),
        source: S.str('FHIR reference or document URL where it was found, empty when missing.'),
      }), 'Packet checklist built from payer criteria.'),
      missing_items: S.arr(S.str(), 'Plain-language list of items still needed.'),
      urgency_assessment: S.enum(['standard', 'expedited'], 'Your urgency assessment.'),
      expedite_reason: S.str('Why expedited, or empty.'),
      route_queue: S.enum(['ready_for_submission_review', 'needs_documents', 'clinical_review', 'no_pa_required_confirm'], 'Worklist queue.'),
      reviewer_summary: S.str('Two to four sentences for the coordinator. Minimum necessary.'),
      ...COMMON_OUTPUT,
    }),
  });
  wf.link(INTAKE, AGENT);

  // ---------- guardrails ----------
  const gx = block.right + 140;
  wf.add(code(GUARD, [gx, 0], `
${guardPreamble(AGENT)}
const req = $('${INTAKE}').item.json;
if (out) {
  if (!out.patient_found) reasons.push('patient not found');
  if (!out.coverage_active) reasons.push('coverage not active on requested date');
  if (out.pa_required === 'unknown') reasons.push('could not determine whether PA is required');
  if (out.urgency_assessment !== req.requested_urgency) {
    reasons.push('urgency: office asked ' + req.requested_urgency + ', agent assessed ' + out.urgency_assessment);
  }
  const unsourced = (out.packet ?? []).filter((p) => p.status === 'present' && !p.source);
  if (unsourced.length) reasons.push(unsourced.length + ' packet items marked present without a source');
  if (out.route_queue === 'ready_for_submission_review' && (out.packet ?? []).some((p) => p.status !== 'present')) {
    reasons.push('marked ready but packet has missing or unclear items');
  }
}

const ok = reasons.length === 0;
return {
  json: {
    business_key: req.business_key,
    route: ok ? 'auto' : 'escalate',
    guardrail_reasons: reasons,
    planned_actions: ok ? [{ action: 'worklist.insert', queue: out.route_queue, urgency: out.urgency_assessment }] : [],
  },
};
`));
  wf.add(ifTrue('Route automatically?', [gx + 220, 0], `={{ $json.route === 'auto' }}`));
  wf.link(AGENT, GUARD);
  wf.link(GUARD, 'Route automatically?');

  // ---------- act & verify ----------
  const ax = gx + 480;
  const o = `$('${AGENT}').item.json.output`;
  wf.add(postgres('Add to PA worklist', [ax, 0], `
INSERT INTO pa_worklist (request_id, queue, urgency, payer_name, packet, missing_items, reviewer_summary, confidence, n8n_execution_id)
VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
ON CONFLICT (request_id) DO UPDATE SET
  queue = EXCLUDED.queue, urgency = EXCLUDED.urgency, payer_name = EXCLUDED.payer_name,
  packet = EXCLUDED.packet, missing_items = EXCLUDED.missing_items,
  reviewer_summary = EXCLUDED.reviewer_summary, confidence = EXCLUDED.confidence,
  n8n_execution_id = EXCLUDED.n8n_execution_id, updated_at = now()
RETURNING id;`,
    `={{ [ $('${INTAKE}').item.json.request_id, ${o}.route_queue, ${o}.urgency_assessment, ${o}.payer_name ?? null, JSON.stringify(${o}.packet ?? []), JSON.stringify(${o}.missing_items ?? []), ${o}.reviewer_summary ?? '', ${o}.confidence ?? null, $execution.id ] }}`,
    { errorOutput: true },
  ));
  wf.add(postgres('Read back worklist item', [ax + 220, 0],
    'SELECT id, queue, urgency FROM pa_worklist WHERE request_id = $1;',
    `={{ [ $('${INTAKE}').item.json.request_id ] }}`,
    { errorOutput: true, alwaysOutput: true },
  ));
  wf.add(code('Verify worklist item', [ax + 440, 0], `
const planned = $('${AGENT}').item.json.output;
const ok = !!$json.id && $json.queue === planned.route_queue && $json.urgency === planned.urgency_assessment;
return {
  json: {
    verified: ok,
    verify_failed: !ok,
    verify_detail: ok ? '' : 'worklist row does not match the planned queue and urgency',
    worklist_id: $json.id,
    queue: $json.queue,
    urgency: $json.urgency,
  },
};
`));
  wf.add(ifTrue('Verified?', [ax + 660, 0], '={{ $json.verified }}'));
  wf.add(ifTrue('Expedited?', [ax + 880, 0], `={{ $json.urgency === 'expedited' }}`));
  wf.add(slack('Alert UM nurses', [ax + 1100, -140], `={{ ${cfg}.slack_channel_expedited }}`,
    `={{ ':rotating_light: Expedited prior-auth ' + $('${INTAKE}').item.json.request_id + ' is in ' + $json.queue + ' (worklist #' + $json.worklist_id + '). Open the worklist for details.' }}`));
  wf.add(setFields('Mark completed', [ax + 1320, 0], { outcome: 'completed' }));
  wf.link('Route automatically?', 'Add to PA worklist', 0);
  wf.link('Add to PA worklist', 'Read back worklist item', 0);
  wf.link('Read back worklist item', 'Verify worklist item', 0);
  wf.link('Verify worklist item', 'Verified?');
  wf.link('Verified?', 'Expedited?', 0);
  wf.link('Expedited?', 'Alert UM nurses', 0);
  wf.link('Expedited?', 'Mark completed', 1);
  wf.link('Alert UM nurses', 'Mark completed');

  // ---------- hand off ----------
  const h = handoffTail(wf, {
    x: ax, y: 560, agentName: AGENT, intakeName: INTAKE, guardName: GUARD,
    team: 'PA intake coordinators', channel: `={{ ${cfg}.slack_channel_exceptions }}`,
    summary: `'PA request ' + intake.request_id + ' · proposed queue: ' + (agent?.output?.route_queue ?? 'none') + ' · urgency: ' + (agent?.output?.urgency_assessment ?? intake.requested_urgency)`,
  });
  wf.link(AGENT, h.first, 1);
  wf.link('Route automatically?', h.first, 1);
  wf.link('Add to PA worklist', h.first, 1);
  wf.link('Read back worklist item', h.first, 1);
  wf.link('Verified?', h.first, 1);

  // ---------- audit ----------
  const a = auditTail(wf, { x: ax + 1580, y: 280, agentName: AGENT, intakeName: INTAKE, guardName: GUARD });
  wf.link('Mark completed', a.first);
  wf.link(h.last, a.first);

  // ---------- stickies ----------
  wf.group({ name: 'Stage: intake', title: '1 · Intake', color: COLOR.intake, nodes: ['Prior-auth request received', 'Config', INTAKE], body: `
The EHR or scheduling system posts a PA request with patient, coverage, CPT and ICD-10 codes, urgency and attached document links.
Only identifiers and codes go into the prompt. The agent fetches clinical detail itself.` });
  wf.group({ name: 'Stage: observe and plan', title: '2 · Observe and plan (agent)', color: COLOR.plan, nodes: block.nodes, body: `
Claude reads Patient, Coverage, Conditions and DocumentReferences over FHIR, pulls the payer's criteria per CPT code, and builds the packet checklist: present, missing or unclear, each with its source.
It proposes a worklist queue and an urgency. **It never submits to a payer and never makes the medical-necessity call.**` });
  wf.group({ name: 'Stage: guardrails', title: '3 · Guardrails', color: COLOR.guard, nodes: [GUARD, 'Route automatically?'], body: `
Escalate when the patient or coverage isn't found, PA need is unknown, the agent's urgency differs from the office's, a "present" item has no source, or a "ready" packet still has gaps.` });
  wf.group({ name: 'Stage: act and verify', title: '4 · Packet assembly and routing', color: COLOR.act, nodes: ['Add to PA worklist', 'Read back worklist item', 'Verify worklist item', 'Verified?', 'Expedited?', 'Alert UM nurses', 'Mark completed'], body: `
Upserts the packet into **pa_worklist** keyed on request id (safe to re-run), reads it back, checks queue and urgency.
Expedited cases page the UM nurses. **Slack messages carry ids only, no PHI.**` });
  wf.group({ name: 'Stage: hand off', title: '5 · Hand off', color: COLOR.handoff, nodes: h.nodes, body: `
Anything the guardrails stop, or any failed write, goes to a PA intake coordinator with the agent's checklist, its questions and its full tool trace.` });
  wf.group({ name: 'Stage: audit', title: '6 · Audit', color: COLOR.audit, nodes: a.nodes, body: `
One **agent_runs** row per request: outcome, queue, guardrail reasons, tool-call count, model, execution id.` });
  wf.alignTops(['Stage: intake', 'Stage: observe and plan', 'Stage: guardrails', 'Stage: act and verify']);

  overviewStickies(wf, {
    overview: `## Healthcare · Prior-auth triage agent
**Job:** take prior-authorization intake off the UM desk. Check coverage, match the order against payer criteria, assemble the packet checklist, and put the request in the right worklist queue with a short reviewer summary.

**Flow:** intake → agent reads the EHR and payer criteria (read-only) → guardrails → upsert to PA worklist, read back, page on expedited → hand off anything unclear → audit.

**Never does**
- Submits to a payer
- Decides medical necessity
- Downgrades urgency on its own. Any disagreement goes to a person.
- Puts PHI in Slack

**Model:** Claude Opus 5, adaptive thinking, effort high.`,
    setup: `## Setup
1. **PHI:** only send PHI to Claude under a signed BAA with Anthropic, on a self-hosted n8n you control. Set execution-data retention to match your policy (Settings → Executions pruning).
2. Run **sql/schema.sql** (creates **pa_worklist**, **agent_exceptions**, **agent_runs**). Select the Postgres credential on every Postgres node.
3. Credentials: **Anthropic**, **Header Auth** for FHIR (Bearer token from your EHR's SMART backend-services flow), **Header Auth** for the payer-rules service, **Slack**.
4. Edit **Config**: FHIR base URL, payer-rules URL, confidence floor, Slack channels.
5. Test: \`curl -X POST <test webhook URL> -H 'Content-Type: application/json' -d @samples/healthcare-prior-auth.json\``,
  });

  return wf;
}

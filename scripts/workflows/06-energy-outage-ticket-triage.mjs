import {
  Workflow, COLOR, S, COMMON_OUTPUT, SYSTEM_TAIL, guardPreamble,
  schedule, config, code, ifTrue, http, splitOut, setFields,
  agentBlock, handoffTail, auditTail, overviewStickies,
} from '../lib.mjs';

// Words that mean a person, not a model, looks at the ticket first.
const HAZARD_TERMS = [
  'wire down', 'wires down', 'line down', 'lines down', 'downed', 'sparking', 'sparks', 'arcing', 'fire', 'smoke',
  'burning', 'explosion', 'gas smell', 'smell gas', 'pole down', 'pole broken', 'tree on line', 'tree on the line',
  'shock', 'electrocut', 'injur', 'hurt', 'trapped', 'life support', 'oxygen', 'ventilator', 'dialysis',
];

export default function build() {
  const wf = new Workflow('Energy & Utilities · Outage ticket triage agent', 'energy-outage-ticket-triage');
  const AGENT = 'Outage triage agent';
  const INTAKE = 'Normalize ticket';
  const GUARD = 'Guardrails';
  const cfg = `$('Config').first().json`;
  const ops = { kind: 'header' };

  // ---------- intake ----------
  wf.add(schedule('Every 2 minutes', [0, 0], 2));
  wf.add(config('Config', [220, 0], {
    ops_gateway_url: 'https://ops-gateway.YOUR-UTILITY.example/api',
    batch_size: 25,
    min_confidence: 0.85,
    slack_channel: '#dispatch-desk',
  }));
  wf.add(http('Fetch new outage tickets', [440, 0], {
    url: `={{ ${cfg}.ops_gateway_url }}/tickets`,
    auth: ops,
    query: { status: 'new', category: 'outage', limit: `={{ ${cfg}.batch_size }}` },
  }));
  wf.add(splitOut('One item per ticket', [660, 0], 'tickets'));
  wf.add(code(INTAKE, [880, 0], `
const t = $json;
return {
  json: {
    business_key: String(t.ticket_id),
    ticket_id: String(t.ticket_id),
    premise_id: String(t.premise_id ?? ''),
    meter_id: String(t.meter_id ?? ''),
    address: String(t.address ?? ''),
    lat: t.lat ?? null,
    lon: t.lon ?? null,
    reported_at: t.reported_at ?? null,
    channel: String(t.channel ?? ''),
    description: String(t.description ?? '').slice(0, 1500),
  },
};
`));
  wf.add(http('Claim ticket', [1100, 0], {
    method: 'PATCH',
    url: `={{ ${cfg}.ops_gateway_url }}/tickets/{{ $json.ticket_id }}`,
    auth: ops,
    json: `={{ JSON.stringify({ status: 'triaging', triaged_by: 'aelix-outage-agent', expected_status: 'new' }) }}`,
    errorOutput: true,
  }));
  wf.add(code('Safety screen', [1320, 0], `
// Deterministic, runs before the model. Anything that sounds like a hazard or a
// medically dependent customer goes straight to a dispatcher.
const TERMS = ${JSON.stringify(HAZARD_TERMS)};
const t = $('${INTAKE}').item.json;
const text = t.description.toLowerCase();
const hits = TERMS.filter((w) => text.includes(w));
return {
  json: {
    hazard: hits.length > 0,
    hazard_terms: hits,
    handoff_reason: hits.length ? 'SAFETY: customer report mentions ' + hits.join(', ') : '',
  },
};
`));
  wf.add(ifTrue('Hazard reported?', [1540, 0], '={{ $json.hazard }}'));
  wf.chain('Every 2 minutes', 'Config', 'Fetch new outage tickets', 'One item per ticket', INTAKE, 'Claim ticket');
  wf.link('Claim ticket', 'Safety screen', 0);
  wf.link('Safety screen', 'Hazard reported?');

  // ---------- observe & plan ----------
  const block = agentBlock(wf, {
    name: AGENT,
    left: 1780,
    effort: 'medium',
    prompt: `=Outage ticket {{ $('${INTAKE}').item.json.ticket_id }}
Premise: {{ $('${INTAKE}').item.json.premise_id }} · meter {{ $('${INTAKE}').item.json.meter_id }}
Address: {{ $('${INTAKE}').item.json.address }} ({{ $('${INTAKE}').item.json.lat }}, {{ $('${INTAKE}').item.json.lon }})
Reported: {{ $('${INTAKE}').item.json.reported_at }} via {{ $('${INTAKE}').item.json.channel }}

Customer's description, as written by the customer:
<customer_report>
{{ $('${INTAKE}').item.json.description }}
</customer_report>

Correlate this ticket with what the network shows, and recommend how it should be handled.`,
    system: `
You triage outage tickets for an electric utility's dispatch desk. A customer reported no power or partial power. You correlate the ticket with the outage management system, meter data and the network model, and recommend handling. Dispatchers make every crew decision; you prepare it.

How to correlate:
- Check active outages near the premise. A ticket belongs to a known outage when the premise is downstream of that outage's device on the network model, not merely nearby.
- Check the meter. A recent last-gasp event or failed ping supports a real outage at the premise; a meter that answers normally suggests a single-premise issue behind the meter or no outage.
- Use the network model to name the likely device (transformer, fuse, recloser, feeder breaker) and estimate customers affected when several nearby meters are dark on the same device.
- Check premise flags for critical customers (hospitals, medical-baseline, water and sewer, emergency services).

Classifications:
- part_of_known_outage: downstream of an active outage's device. Give matched_outage_id.
- new_outage_probable: meter evidence of loss and no active outage covers it.
- single_premise_issue: meter or neighbours suggest the problem is at this premise only.
- not_an_outage: meter healthy and nothing on the network.
- hazard_suspected: anything in the report or data that suggests danger.

Priority: P1 hazard or critical customer affected; P2 new outage over 50 customers; P3 other new outages; P4 single premise or no outage. If you recommend a crew, it must come from the crew tool.

Tools:
- "Find active outages nearby (OMS)", "Check meter status (AMI)", "Trace network (GIS)", "Get premise flags (CIS)", "Find available crews (WFM)".
${SYSTEM_TAIL}`,
    tools: [
      {
        name: 'Find active outages nearby (OMS)',
        description: 'List active outages within a radius of a point: outage id, status, device id and type, feeder, customers out, ETR.',
        url: `={{ ${cfg}.ops_gateway_url }}/oms/outages`,
        auth: ops,
        query: {
          lat: `={{ $fromAI('lat', 'Latitude of the premise', 'number') }}`,
          lon: `={{ $fromAI('lon', 'Longitude of the premise', 'number') }}`,
          radius_m: `={{ $fromAI('radius_m', 'Search radius in metres, 300 to 3000', 'number') }}`,
          status: 'active',
        },
      },
      {
        name: 'Check meter status (AMI)',
        description: 'Get recent AMI events for a meter (last gasp, power restore, ping result) and its current connectivity.',
        url: `={{ ${cfg}.ops_gateway_url }}/ami/meters/{{ $fromAI('meter_id', 'Meter id', 'string') }}/status`,
        auth: ops,
        query: { lookback_minutes: '180' },
      },
      {
        name: 'Trace network (GIS)',
        description: 'Trace upstream from a premise: service transformer, protective devices, feeder and substation, with the meters that share each device.',
        url: `={{ ${cfg}.ops_gateway_url }}/gis/premises/{{ $fromAI('premise_id', 'Premise id', 'string') }}/upstream`,
        auth: ops,
      },
      {
        name: 'Get premise flags (CIS)',
        description: 'Get customer flags for a premise: medical baseline, critical facility type, life-support registration.',
        url: `={{ ${cfg}.ops_gateway_url }}/cis/premises/{{ $fromAI('premise_id', 'Premise id', 'string') }}/flags`,
        auth: ops,
      },
      {
        name: 'Find available crews (WFM)',
        description: 'List crews available now near a point, with crew id, type (troubleshooter, line, tree), distance and current assignment.',
        url: `={{ ${cfg}.ops_gateway_url }}/wfm/crews/available`,
        auth: ops,
        query: {
          lat: `={{ $fromAI('lat', 'Latitude', 'number') }}`,
          lon: `={{ $fromAI('lon', 'Longitude', 'number') }}`,
          crew_type: `={{ $fromAI('crew_type', 'troubleshooter, line or tree', 'string') }}`,
        },
      },
    ],
    schema: S.obj({
      classification: S.enum(['part_of_known_outage', 'new_outage_probable', 'single_premise_issue', 'not_an_outage', 'hazard_suspected'], 'Classification.'),
      matched_outage_id: S.nullable(S.str('Active outage this ticket belongs to, or null.')),
      suspected_device: S.nullable(S.obj({ type: S.str('Device type.'), id: S.str('Device id.') })),
      premise_feeder_id: S.nullable(S.str('Feeder serving the premise, from the network trace.')),
      affected_estimate: S.int('Estimated customers affected.'),
      critical_customer: S.bool('A critical or medically dependent customer is affected.'),
      priority: S.enum(['P1', 'P2', 'P3', 'P4'], 'Priority.'),
      ami_evidence: S.str('What the meter data showed, one or two sentences.'),
      recommended_crew_id: S.nullable(S.str('Crew from the crew tool, or null.')),
      ...COMMON_OUTPUT,
    }),
  });
  wf.link('Hazard reported?', AGENT, 1);

  // ---------- guardrails ----------
  const gx = block.right + 140;
  wf.add(ifTrue('Matches a known outage?', [gx, 0], `={{ $json.output?.classification === 'part_of_known_outage' && !!$json.output?.matched_outage_id }}`));
  wf.add(http('Re-read outage (OMS)', [gx + 220, 0], {
    url: `={{ ${cfg}.ops_gateway_url }}/oms/outages/{{ $('${AGENT}').item.json.output.matched_outage_id }}`,
    auth: ops,
    errorOutput: true,
  }));
  wf.add(code(GUARD, [gx + 440, 0], `
${guardPreamble(AGENT)}
const t = $('${INTAKE}').item.json;
const outage = $json; // fresh OMS read

if (!['active', 'assessing', 'crew_assigned', 'crew_on_site'].includes(outage.status)) reasons.push('outage ' + outage.outage_id + ' is ' + outage.status);
if (out?.premise_feeder_id && outage.feeder_id && out.premise_feeder_id !== outage.feeder_id) reasons.push('premise feeder ' + out.premise_feeder_id + ' differs from outage feeder ' + outage.feeder_id);
if (out?.critical_customer) reasons.push('critical customer: dispatcher confirms');
if (out?.priority === 'P1') reasons.push('P1: dispatcher confirms');

const ok = reasons.length === 0;
return {
  json: {
    business_key: t.business_key,
    route: ok ? 'auto' : 'escalate',
    guardrail_reasons: reasons,
    outage_id: outage.outage_id,
    etr: outage.etr ?? null,
    planned_actions: ok ? [{ action: 'ticket.link_outage', outage_id: outage.outage_id }, { action: 'notify.etr' }] : [],
  },
};
`));
  wf.add(ifTrue('Link automatically?', [gx + 660, 0], `={{ $json.route === 'auto' }}`));
  wf.link(AGENT, 'Matches a known outage?');
  wf.link('Matches a known outage?', 'Re-read outage (OMS)', 0);
  wf.link('Re-read outage (OMS)', GUARD, 0);
  wf.link(GUARD, 'Link automatically?');

  // ---------- act & verify ----------
  const ax = gx + 920;
  wf.add(http('Link ticket to outage', [ax, 0], {
    method: 'PATCH',
    url: `={{ ${cfg}.ops_gateway_url }}/tickets/{{ $('${INTAKE}').item.json.ticket_id }}`,
    auth: ops,
    json: `={{ JSON.stringify({ status: 'linked', outage_id: $json.outage_id, triage_note: 'Linked by aelix-outage-agent: ' + $('${AGENT}').item.json.output.ami_evidence }) }}`,
    errorOutput: true,
  }));
  wf.add(http('Read back ticket', [ax + 220, 0], {
    url: `={{ ${cfg}.ops_gateway_url }}/tickets/{{ $('${INTAKE}').item.json.ticket_id }}`,
    auth: ops,
    errorOutput: true,
  }));
  wf.add(code('Verify link', [ax + 440, 0], `
const planned = $('${GUARD}').item.json.outage_id;
const ok = $json.status === 'linked' && $json.outage_id === planned;
return {
  json: {
    verified: ok,
    verify_failed: !ok,
    verify_detail: ok ? '' : 'ticket shows status ' + $json.status + ' and outage ' + $json.outage_id,
  },
};
`));
  wf.add(ifTrue('Verified?', [ax + 660, 0], '={{ $json.verified }}'));
  wf.add(http('Send ETR notice', [ax + 880, 0], {
    method: 'POST',
    url: `={{ ${cfg}.ops_gateway_url }}/notifications`,
    auth: ops,
    headers: { 'Idempotency-Key': `=etr-{{ $('${INTAKE}').item.json.ticket_id }}` },
    json: `={{ JSON.stringify({ template: 'outage_known_etr', premise_id: $('${INTAKE}').item.json.premise_id, outage_id: $('${GUARD}').item.json.outage_id, ticket_id: $('${INTAKE}').item.json.ticket_id }) }}`,
  }));
  wf.add(setFields('Mark completed', [ax + 1100, 0], { outcome: 'completed' }));
  wf.link('Link automatically?', 'Link ticket to outage', 0);
  wf.link('Link ticket to outage', 'Read back ticket', 0);
  wf.link('Read back ticket', 'Verify link', 0);
  wf.link('Verify link', 'Verified?');
  wf.link('Verified?', 'Send ETR notice', 0);
  wf.link('Send ETR notice', 'Mark completed');
  wf.node('Send ETR notice').onError = 'continueRegularOutput';

  // ---------- hand off ----------
  const h = handoffTail(wf, {
    x: ax, y: 600, agentName: AGENT, intakeName: INTAKE, guardName: GUARD,
    team: 'dispatch desk', channel: `={{ ${cfg}.slack_channel }}`,
    summary: `(($json.hazard) ? ':warning: HAZARD · ' : '') + 'Ticket ' + intake.ticket_id + ' · ' + intake.address + ' · ' + (agent?.output?.classification ?? 'not triaged') + ' · ' + (agent?.output?.priority ?? 'P1') + (agent?.output?.recommended_crew_id ? ' · suggested crew ' + agent.output.recommended_crew_id : '')`,
  });
  wf.link('Claim ticket', h.first, 1);
  wf.link('Hazard reported?', h.first, 0);
  wf.link(AGENT, h.first, 1);
  wf.link('Matches a known outage?', h.first, 1);
  wf.link('Re-read outage (OMS)', h.first, 1);
  wf.link('Link automatically?', h.first, 1);
  wf.link('Link ticket to outage', h.first, 1);
  wf.link('Read back ticket', h.first, 1);
  wf.link('Verified?', h.first, 1);

  // ---------- audit ----------
  const a = auditTail(wf, { x: ax + 1360, y: 300, agentName: AGENT, intakeName: INTAKE, guardName: GUARD });
  wf.link('Mark completed', a.first);
  wf.link(h.last, a.first);

  // ---------- stickies ----------
  wf.group({ name: 'Stage: intake', title: '1 · Intake and safety screen', color: COLOR.intake, nodes: ['Every 2 minutes', 'Config', 'Fetch new outage tickets', 'One item per ticket', INTAKE, 'Claim ticket', 'Safety screen', 'Hazard reported?'], body: `
Every two minutes, new outage tickets are pulled and **claimed** (status new → triaging) so the next poll can't pick them up twice.
A **keyword safety screen runs before the model**: wires down, sparking, fire, gas, injuries, life support. Any hit goes straight to a dispatcher.` });
  wf.group({ name: 'Stage: observe and plan', title: '2 · Correlate (agent)', color: COLOR.plan, nodes: block.nodes, body: `
Claude checks active outages, the premise meter (last gasp, ping), the upstream network trace and critical-customer flags. It classifies the ticket, names the likely device, sets a priority and suggests a crew.
Effort is **medium** here: high volume, well-bounded reasoning.` });
  wf.group({ name: 'Stage: guardrails', title: '3 · Guardrails', color: COLOR.guard, nodes: ['Matches a known outage?', 'Re-read outage (OMS)', GUARD, 'Link automatically?'], body: `
Only "part of a known outage" can be automated. The outage is **re-read** from OMS: it must still be open and on the same feeder. Critical customers and P1s always go to a dispatcher.` });
  wf.group({ name: 'Stage: act and verify', title: '4 · Link and notify', color: COLOR.act, nodes: ['Link ticket to outage', 'Read back ticket', 'Verify link', 'Verified?', 'Send ETR notice', 'Mark completed'], body: `
Links the ticket to the outage, reads it back, then sends the customer the **templated ETR notice** from your notification service (idempotent per ticket).` });
  wf.group({ name: 'Stage: hand off', title: '5 · Dispatch desk', color: COLOR.handoff, nodes: h.nodes, body: `
Hazards, new outages, single-premise issues and anything stopped land here with classification, suspected device, priority, suggested crew and the tool trace. **A dispatcher makes every crew decision.**` });
  wf.group({ name: 'Stage: audit', title: '6 · Audit', color: COLOR.audit, nodes: a.nodes, body: `
One **agent_runs** row per ticket.` });
  wf.alignTops(['Stage: intake', 'Stage: observe and plan', 'Stage: guardrails', 'Stage: act and verify']);

  overviewStickies(wf, {
    x: -1000,
    overview: `## Energy & Utilities · Outage ticket triage agent
**Job:** take outage-ticket triage off the dispatch desk. Correlate each ticket with OMS, AMI and the network model, attach tickets to known outages automatically, and hand dispatchers a prepared recommendation for everything else.

**Flow:** poll and claim → safety screen (no model) → agent correlates (read-only) → guardrails re-read OMS → link, read back, send ETR → dispatch desk for the rest → audit.

**Never does**
- Dispatches a crew
- Handles a hazard report without a person
- Auto-handles critical or medically dependent customers

**Model:** Claude Opus 5, adaptive thinking, effort medium.`,
    setup: `## Setup
1. Run **sql/schema.sql**. Select the Postgres credential on *Queue exception* and *Write audit record*.
2. Credentials: **Anthropic**, **Header Auth** for the ops gateway, **Slack**.
3. **Ops gateway contract**: tickets (list, patch, get), oms/outages, ami/meters, gis/premises upstream, cis/premises flags, wfm/crews, notifications. Map to your OMS/ADMS (Oracle NMS, GE ADMS), head-end, GIS and CIS.
4. *Claim ticket* must fail if the ticket is no longer **new** (expected_status). That is what stops double processing.
5. Edit **Config**: gateway URL, batch size, confidence floor, channel. Review the hazard terms in *Safety screen* with your safety team.
6. Test with *Execute workflow* against a staging gateway; sample response in **samples/energy-tickets-response.json**.`,
  });

  return wf;
}

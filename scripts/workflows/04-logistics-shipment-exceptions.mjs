import {
  Workflow, COLOR, S, COMMON_OUTPUT, SYSTEM_TAIL, guardPreamble,
  webhook, config, code, ifTrue, http, gmail, setFields,
  agentBlock, handoffTail, auditTail, overviewStickies,
} from '../lib.mjs';

export default function build() {
  const wf = new Workflow('Logistics · Shipment exception agent', 'logistics-shipment-exceptions');
  const AGENT = 'Shipment exception agent';
  const INTAKE = 'Normalize event';
  const GUARD = 'Guardrails';
  const cfg = `$('Config').first().json`;
  const tms = { kind: 'header' };

  // ---------- intake ----------
  wf.add(webhook('Carrier exception event', [0, 0], 'aelix/logistics/shipment-exception', wf.slug));
  wf.add(config('Config', [220, 0], {
    tms_base_url: 'https://tms.YOUR-COMPANY.example/api/v2',
    max_rebook_cost_delta: 300,
    min_confidence: 0.85,
    slack_channel: '#shipment-exceptions',
  }));
  wf.add(code(INTAKE, [440, 0], `
const b = $json.body ?? $json;
const missing = ['event_id', 'shipment_id', 'event_code'].filter((k) => !b[k]);
if (missing.length) throw new Error('Carrier event missing fields: ' + missing.join(', '));
return {
  json: {
    business_key: String(b.shipment_id) + ':' + String(b.event_id),
    event_id: String(b.event_id),
    shipment_id: String(b.shipment_id),
    carrier: String(b.carrier ?? ''),
    tracking_number: String(b.tracking_number ?? ''),
    event_code: String(b.event_code).toUpperCase(),
    event_description: String(b.event_description ?? '').slice(0, 1000),
    event_time: b.event_time ?? null,
    location: String(b.location ?? ''),
  },
};
`));
  wf.chain('Carrier exception event', 'Config', INTAKE);

  // ---------- observe & plan ----------
  const block = agentBlock(wf, {
    name: AGENT,
    left: 700,
    prompt: `=Carrier exception on shipment {{ $json.shipment_id }}
Carrier: {{ $json.carrier }} · tracking {{ $json.tracking_number }}
Event code: {{ $json.event_code }} at {{ $json.event_time ?? 'unknown time' }}, {{ $json.location || 'unknown location' }}
Rebooking cost limit for this run: {{ ${cfg}.max_rebook_cost_delta }} (in the shipment's currency)

Carrier's description, as sent by the carrier:
<carrier_event>
{{ $json.event_description }}
</carrier_event>

Trace what happened, decide whether the delivery promise is at risk, and re-plan.`,
    system: `
You handle shipment exceptions for a logistics operations team. A carrier reported an exception. You trace what happened, work out whether the customer's delivery promise is at risk, and propose a re-plan.

How to work it:
- Read the shipment (lane, service level, promised delivery, customer) and its tracking history. Establish the root cause from the events, not from the event code alone.
- Read the order to see the SLA and whether the customer is flagged as priority.
- Estimate a realistic new ETA on the current carrier.
- If the new ETA misses the promise, get quotes for alternatives (rebook on another carrier or expedite on the same one). Keep the options that recover the promise, with their cost difference against the current booking.

Options you can propose:
- wait: stay with the current carrier, update the ETA, tell the customer.
- rebook: move to another carrier using a quote you obtained.
- expedite: upgrade service on the current carrier using a quote you obtained.
Every rebook or expedite option must carry the quote_id from the quote tool.

Damage, customs holds, hazmat and address problems need a person: say so and recommend escalate. Draft the customer notice in plain words, with the new ETA. A person reviews it when the case escalates.

Tools:
- "Get shipment (TMS)", "Get tracking history (TMS)", "Get order and SLA (TMS)": read records.
- "Quote alternatives (TMS)": returns priced options with quote ids. Quoting books nothing.
${SYSTEM_TAIL}`,
    tools: [
      {
        name: 'Get shipment (TMS)',
        description: 'Get a shipment: lane, carrier, service level, current booking and cost, promised delivery date, current ETA, customer contact.',
        url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $fromAI('shipment_id', 'TMS shipment id', 'string') }}`,
        auth: tms,
      },
      {
        name: 'Get tracking history (TMS)',
        description: 'Get all tracking events for a shipment, oldest first, with codes, descriptions, times and locations.',
        url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $fromAI('shipment_id', 'TMS shipment id', 'string') }}/events`,
        auth: tms,
      },
      {
        name: 'Get order and SLA (TMS)',
        description: 'Get the customer order behind a shipment: SLA, priority flag, delivery window, penalties.',
        url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $fromAI('shipment_id', 'TMS shipment id', 'string') }}/order`,
        auth: tms,
      },
      {
        name: 'Quote alternatives (TMS)',
        description: 'Get priced alternatives for moving a shipment from its current location: other carriers and faster services. Returns quote_id, carrier, service, cost, cost_delta vs the current booking, and ETA for each. Read-only; nothing is booked.',
        method: 'POST',
        url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $fromAI('shipment_id', 'TMS shipment id', 'string') }}/quotes`,
        auth: tms,
        json: `={{ JSON.stringify({ deliver_by: $fromAI('deliver_by', 'ISO date the shipment must arrive by', 'string') }) }}`,
      },
    ],
    schema: S.obj({
      root_cause: S.enum(['weather', 'carrier_capacity', 'missed_pickup', 'mechanical', 'address_issue', 'customs_hold', 'damage', 'other'], 'Cause established from tracking.'),
      sla_at_risk: S.bool('Current ETA misses the promised delivery.'),
      promised_delivery: S.str('ISO date promised to the customer.'),
      options: S.arr(S.obj({
        option_id: S.str('Short id, for example opt-1.'),
        type: S.enum(['wait', 'rebook', 'expedite'], 'Kind of re-plan.'),
        carrier: S.str('Carrier.'),
        service: S.str('Service level.'),
        quote_id: S.nullable(S.str('Quote id for rebook or expedite. Null for wait.')),
        cost_delta: S.num('Extra cost against current booking. 0 for wait.'),
        eta: S.str('ISO date-time of expected delivery.'),
      }), 'Options considered.'),
      recommended_option_id: S.nullable(S.str('option_id to take, or null when recommending escalate.')),
      recommend_escalate: S.bool('A person must handle this case.'),
      customer_notice: S.str('Plain-language draft for the customer.'),
      ...COMMON_OUTPUT,
    }),
  });
  wf.link(INTAKE, AGENT);

  // ---------- guardrails ----------
  const gx = block.right + 140;
  wf.add(http('Re-read shipment (TMS)', [gx, 0], {
    url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $('${INTAKE}').item.json.shipment_id }}`,
    auth: tms,
    errorOutput: true,
  }));
  wf.add(code(GUARD, [gx + 220, 0], `
${guardPreamble(AGENT)}
const req = $('${INTAKE}').item.json;
const shp = $json; // fresh read
const pick = (out?.options ?? []).find((o) => o.option_id === out?.recommended_option_id) ?? null;
const promised = Date.parse(shp.promised_delivery ?? out?.promised_delivery ?? '');

if (out?.recommend_escalate) reasons.push('agent recommends a person handles it');
if (['damage', 'customs_hold', 'address_issue'].includes(out?.root_cause)) reasons.push('root cause ' + out.root_cause + ' always goes to a person');
if (['DAMAGED', 'CUSTOMS_HOLD', 'HAZMAT', 'ADDRESS_ISSUE'].includes(req.event_code)) reasons.push('event code ' + req.event_code + ' always goes to a person');
if (!pick) reasons.push('no recommended option');
if (shp.status === 'delivered' || shp.status === 'cancelled') reasons.push('shipment is now ' + shp.status);
if (pick && pick.type !== 'wait') {
  if (!pick.quote_id) reasons.push('rebook/expedite without a quote id');
  if (pick.cost_delta > cfg.max_rebook_cost_delta) reasons.push('cost delta ' + pick.cost_delta + ' above ' + cfg.max_rebook_cost_delta);
  if (Number.isFinite(promised) && Date.parse(pick.eta) > promised) reasons.push('paid option still misses the promised date');
}
if (pick && Number.isNaN(Date.parse(pick.eta))) reasons.push('option ETA is not a valid date');

const ok = reasons.length === 0;
return {
  json: {
    business_key: req.business_key,
    route: ok ? 'auto' : 'escalate',
    guardrail_reasons: reasons,
    plan: pick ? { type: pick.type, quote_id: pick.quote_id, new_eta: pick.eta, carrier: pick.carrier } : null,
    customer_email: shp.customer?.email ?? null,
    planned_actions: ok ? [{ action: pick.type === 'wait' ? 'tms.update_eta' : 'tms.rebook', quote_id: pick.quote_id, eta: pick.eta }] : [],
  },
};
`));
  wf.add(ifTrue('Auto re-plan?', [gx + 440, 0], `={{ $json.route === 'auto' }}`));
  wf.link(AGENT, 'Re-read shipment (TMS)');
  wf.link('Re-read shipment (TMS)', GUARD, 0);
  wf.link(GUARD, 'Auto re-plan?');

  // ---------- act & verify ----------
  const ax = gx + 700;
  const plan = `$('${GUARD}').item.json.plan`;
  wf.add(ifTrue('Rebooking needed?', [ax, 0], `={{ $json.plan.type !== 'wait' }}`));
  wf.add(http('Book alternative (TMS)', [ax + 220, -130], {
    method: 'POST',
    url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $('${INTAKE}').item.json.shipment_id }}/rebook`,
    auth: tms,
    headers: { 'Idempotency-Key': `=rebook-{{ $('${INTAKE}').item.json.business_key }}` },
    json: `={{ JSON.stringify({ quote_id: $json.plan.quote_id, reason: 'carrier_exception', source_event_id: $('${INTAKE}').item.json.event_id, requested_by: 'aelix-shipment-agent' }) }}`,
    errorOutput: true,
  }));
  wf.add(http('Update ETA (TMS)', [ax + 220, 130], {
    method: 'PATCH',
    url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $('${INTAKE}').item.json.shipment_id }}`,
    auth: tms,
    json: `={{ JSON.stringify({ eta: $json.plan.new_eta, exception_note: 'Carrier exception ' + $('${INTAKE}').item.json.event_code + ', ETA updated by aelix-shipment-agent' }) }}`,
    errorOutput: true,
  }));
  wf.add(http('Read back shipment (TMS)', [ax + 440, 0], {
    url: `={{ ${cfg}.tms_base_url }}/shipments/{{ $('${INTAKE}').item.json.shipment_id }}`,
    auth: tms,
    errorOutput: true,
  }));
  wf.add(code('Verify re-plan', [ax + 660, 0], `
const plan = ${plan};
const s = $json;
const sameTime = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) < 60 * 1000;
const ok = plan.type === 'wait'
  ? sameTime(s.eta, plan.new_eta)
  : s.current_booking?.quote_id === plan.quote_id;
return {
  json: {
    verified: ok,
    verify_failed: !ok,
    verify_detail: ok ? '' : 'TMS does not show the planned ' + (plan.type === 'wait' ? 'ETA' : 'booking'),
  },
};
`));
  wf.add(ifTrue('Verified?', [ax + 880, 0], '={{ $json.verified }}'));
  wf.add(gmail('Notify customer', [ax + 1100, 0], {
    to: `={{ $('${GUARD}').item.json.customer_email }}`,
    subject: `=Update on your shipment {{ $('${INTAKE}').item.json.tracking_number }}`,
    message: `=Hello,

Your shipment {{ $('${INTAKE}').item.json.tracking_number }} ran into a delay in transit. It is now expected to arrive on {{ new Date(${plan}.new_eta).toUTCString().slice(0, 16) }}.{{ ${plan}.type !== 'wait' ? ' We have moved it to ' + ${plan}.carrier + ' to keep it on schedule, at no cost to you.' : '' }}

We will let you know if anything changes. Reply to this email if you need to talk to someone.`,
  }));
  wf.add(setFields('Mark completed', [ax + 1320, 0], { outcome: 'completed' }));
  wf.link('Auto re-plan?', 'Rebooking needed?', 0);
  wf.link('Rebooking needed?', 'Book alternative (TMS)', 0);
  wf.link('Rebooking needed?', 'Update ETA (TMS)', 1);
  wf.link('Book alternative (TMS)', 'Read back shipment (TMS)', 0);
  wf.link('Update ETA (TMS)', 'Read back shipment (TMS)', 0);
  wf.link('Read back shipment (TMS)', 'Verify re-plan', 0);
  wf.link('Verify re-plan', 'Verified?');
  wf.link('Verified?', 'Notify customer', 0);
  wf.link('Notify customer', 'Mark completed');

  // ---------- hand off ----------
  const h = handoffTail(wf, {
    x: ax + 220, y: 600, agentName: AGENT, intakeName: INTAKE, guardName: GUARD,
    team: 'logistics ops', channel: `={{ ${cfg}.slack_channel }}`,
    summary: `'Shipment ' + intake.shipment_id + ' · ' + intake.event_code + ' · cause: ' + (agent?.output?.root_cause ?? 'unknown') + (agent?.output?.sla_at_risk ? ' · SLA at risk' : '')`,
  });
  wf.link(AGENT, h.first, 1);
  wf.link('Re-read shipment (TMS)', h.first, 1);
  wf.link('Auto re-plan?', h.first, 1);
  wf.link('Book alternative (TMS)', h.first, 1);
  wf.link('Update ETA (TMS)', h.first, 1);
  wf.link('Read back shipment (TMS)', h.first, 1);
  wf.link('Verified?', h.first, 1);

  // ---------- audit ----------
  const a = auditTail(wf, { x: ax + 1580, y: 300, agentName: AGENT, intakeName: INTAKE, guardName: GUARD });
  wf.link('Mark completed', a.first);
  wf.link(h.last, a.first);

  // ---------- stickies ----------
  wf.group({ name: 'Stage: intake', title: '1 · Intake', color: COLOR.intake, nodes: ['Carrier exception event', 'Config', INTAKE], body: `
Your visibility platform or carrier integration posts exception events (delay, missed pickup, damage, customs hold). One event is one run.` });
  wf.group({ name: 'Stage: observe and plan', title: '2 · Trace and re-plan (agent)', color: COLOR.plan, nodes: block.nodes, body: `
Claude reads the shipment, tracking history and SLA, names the root cause, estimates a new ETA, and when the promise is at risk gets **quotes** (quoting books nothing).
It recommends wait, rebook or expedite, and drafts the customer notice.` });
  wf.group({ name: 'Stage: guardrails', title: '3 · Guardrails', color: COLOR.guard, nodes: ['Re-read shipment (TMS)', GUARD, 'Auto re-plan?'], body: `
Shipment is **re-read**. Damage, customs, hazmat and address issues always go to a person. A paid option needs a quote id, a cost under the limit, and an ETA that recovers the promise.` });
  wf.group({ name: 'Stage: act and verify', title: '4 · Act and verify', color: COLOR.act, nodes: ['Rebooking needed?', 'Book alternative (TMS)', 'Update ETA (TMS)', 'Read back shipment (TMS)', 'Verify re-plan', 'Verified?', 'Notify customer', 'Mark completed'], body: `
Rebooks on the quoted option (idempotent), or just updates the ETA. The TMS is read back and must show the planned booking or ETA before the customer gets the **templated** notice.` });
  wf.group({ name: 'Stage: hand off', title: '5 · Escalate', color: COLOR.handoff, nodes: h.nodes, body: `
Ops gets the root cause, the options with quotes, the drafted customer notice and the tool trace. They pick an option or open a claim.` });
  wf.group({ name: 'Stage: audit', title: '6 · Audit', color: COLOR.audit, nodes: a.nodes, body: `
One **agent_runs** row per carrier event.` });
  wf.alignTops(['Stage: intake', 'Stage: observe and plan', 'Stage: guardrails', 'Stage: act and verify']);

  overviewStickies(wf, {
    overview: `## Logistics · Shipment exception agent
**Job:** take carrier exceptions off the ops desk. Trace what happened, re-plan when the delivery promise is at risk, carry out small re-plans, and escalate the rest with options already priced.

**Flow:** carrier event → agent traces and quotes (read-only) → guardrails re-read and check → rebook or update ETA, read back, notify the customer → escalate the rest → audit.

**Never does**
- Books above the cost limit, or an option that still misses the promise
- Handles damage, customs, hazmat or address problems
- Sends model-written text to customers

**Model:** Claude Opus 5, adaptive thinking, effort high.`,
    setup: `## Setup
1. Run **sql/schema.sql**. Select the Postgres credential on *Queue exception* and *Write audit record*.
2. Credentials: **Anthropic**, **Header Auth** for the TMS API, **Gmail**, **Slack**.
3. **TMS endpoints are a gateway contract**: shipments, events, order, quotes, rebook. Map them to your TMS (Oracle OTM, Blue Yonder, MercuryGate, e2open) or to project44 / FourKites for tracking.
4. Edit **Config**: TMS URL, cost limit, confidence floor, channel.
5. Test: \`curl -X POST <test webhook URL> -H 'Content-Type: application/json' -d @samples/logistics-shipment-exception.json\``,
  });

  return wf;
}

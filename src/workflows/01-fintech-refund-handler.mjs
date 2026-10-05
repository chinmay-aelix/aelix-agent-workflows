import {
  Workflow, COLOR, S, COMMON_OUTPUT, SYSTEM_TAIL, guardPreamble,
  webhook, config, code, ifTrue, http, gmail, setFields,
  agentBlock, handoffTail, auditTail, overviewStickies,
} from '../lib.mjs';

export default function build() {
  const wf = new Workflow('FinTech · Refund handler agent', 'fintech-refund-handler');
  const AGENT = 'Refund agent';
  const INTAKE = 'Normalize request';
  const GUARD = 'Guardrails';
  const cfg = `$('Config').first().json`;
  const stripe = { kind: 'predefined', type: 'stripeApi' };
  const salesforce = { kind: 'predefined', type: 'salesforceOAuth2Api' };

  // ---------- intake ----------
  wf.add(webhook('Refund request received', [0, 0], 'aelix/fintech/refund-request', wf.slug));
  wf.add(config('Config', [220, 0], {
    sf_instance_url: 'https://YOUR-DOMAIN.my.salesforce.com',
    sf_api_version: 'v61.0',
    refund_window_days: 30,
    auto_refund_max_cents: 25000,
    min_confidence: 0.85,
    slack_channel: '#refund-exceptions',
  }));
  wf.add(code(INTAKE, [440, 0], `
// Validate the request up front so the agent never starts on a half-formed case.
const b = $json.body ?? $json;
const missing = ['request_id', 'order_number', 'customer_email'].filter((k) => !b[k]);
if (missing.length) throw new Error('Refund request missing fields: ' + missing.join(', '));

return {
  json: {
    business_key: String(b.request_id),
    request_id: String(b.request_id),
    order_number: String(b.order_number).trim(),
    customer_email: String(b.customer_email).trim().toLowerCase(),
    reason: String(b.reason ?? '').slice(0, 2000),
    requested_amount: b.requested_amount != null ? Number(b.requested_amount) : null,
    currency: String(b.currency ?? 'usd').toLowerCase(),
    channel: String(b.channel ?? 'support'),
  },
};
`));
  wf.chain('Refund request received', 'Config', INTAKE);

  // ---------- observe & plan ----------
  const block = agentBlock(wf, {
    name: AGENT,
    left: 700,
    prompt: `=Refund request {{ $json.request_id }}
Order number: {{ $json.order_number }}
Customer email on the request: {{ $json.customer_email }}
Requested amount: {{ $json.requested_amount ?? 'not stated (means the full paid amount)' }} {{ $json.currency.toUpperCase() }}
Channel: {{ $json.channel }}
Refund window for this run: {{ ${cfg}.refund_window_days }} days from payment

Customer's reason, as written by the customer:
<customer_reason>
{{ $json.reason }}
</customer_reason>

Establish whether this refund should be issued and for how much.`,
    system: `
You are the refund handling agent for a payments team. You decide whether a customer refund request is eligible and propose the exact refund, using Salesforce for the order and Stripe for the payment.

What makes a refund eligible:
- The order exists in Salesforce and its payment is linked (Payment_Intent_Id__c).
- The Stripe payment succeeded and is not disputed.
- The payment is inside the refund window stated in the request.
- There is money left to refund: amount received minus amount already refunded.
- The email on the request matches the order's bill-to contact or the Stripe receipt email.

How much to refund:
- If the customer states an amount, refund that amount when it is within what remains refundable.
- If no amount is stated, refund what remains refundable.
- Amounts are in the currency's smallest unit (cents for USD).

Choose "escalate" when identities do not match, more than one order matches, the payment link is missing, the charge is disputed, or anything in the records contradicts the request. Choose "deny" only when the records clearly show the request is ineligible (outside the window, already fully refunded). A person reviews every denial before the customer hears it, so write customer_message as a draft for that person.

Tools:
- "Look up order (Salesforce)": order by order number. Returns status, amount, effective date, payment intent id, bill-to email.
- "Look up payment (Stripe)": PaymentIntent with its latest charge. Returns amounts received and refunded, dispute flag, receipt email, created time (unix seconds).
- "List refunds (Stripe)": refunds already issued against a PaymentIntent.
${SYSTEM_TAIL}`,
    tools: [
      {
        name: 'Look up order (Salesforce)',
        description: 'Find a Salesforce Order by its order number. Returns Id, OrderNumber, Status, TotalAmount, EffectiveDate, Payment_Intent_Id__c and the bill-to contact email.',
        url: `={{ ${cfg}.sf_instance_url }}/services/data/{{ ${cfg}.sf_api_version }}/query`,
        auth: salesforce,
        query: {
          q: `=SELECT Id, OrderNumber, Status, TotalAmount, EffectiveDate, Payment_Intent_Id__c, BillToContact.Email, Account.Name FROM Order WHERE OrderNumber = '{{ $fromAI('order_number', 'The order number exactly as given, for example ATX-44102', 'string').replace(/[^A-Za-z0-9-]/g, '') }}' LIMIT 5`,
        },
      },
      {
        name: 'Look up payment (Stripe)',
        description: 'Get a Stripe PaymentIntent with its latest charge expanded. Use the payment intent id from the Salesforce order (starts with pi_).',
        url: `=https://api.stripe.com/v1/payment_intents/{{ $fromAI('payment_intent_id', 'Stripe PaymentIntent id, starts with pi_', 'string') }}`,
        auth: stripe,
        query: { 'expand[]': 'latest_charge' },
      },
      {
        name: 'List refunds (Stripe)',
        description: 'List refunds already issued against a Stripe PaymentIntent.',
        url: 'https://api.stripe.com/v1/refunds',
        auth: stripe,
        query: { payment_intent: `={{ $fromAI('payment_intent_id', 'Stripe PaymentIntent id, starts with pi_', 'string') }}`, limit: '20' },
      },
    ],
    schema: S.obj({
      decision: S.enum(['refund_full', 'refund_partial', 'deny', 'escalate'], 'What should happen to this request.'),
      order_id: S.nullable(S.str('Salesforce Order Id, or null if not found.')),
      payment_intent_id: S.nullable(S.str('Stripe PaymentIntent id, or null if not found.')),
      refund_amount_cents: S.int('Refund amount in the smallest currency unit. 0 when not refunding.'),
      currency: S.str('Three-letter lowercase currency code.'),
      eligibility: S.obj({
        within_window: S.bool('Payment is inside the refund window.'),
        days_since_payment: S.num('Days between payment and now.'),
        identity_match: S.bool('Request email matches the order or payment email.'),
        already_refunded_cents: S.int('Amount already refunded.'),
        disputed: S.bool('The charge has an open or closed dispute.'),
      }),
      customer_message: S.str('Short draft reply to the customer. Used only by a reviewer, never sent automatically.'),
      ...COMMON_OUTPUT,
    }),
  });
  wf.link(INTAKE, AGENT);

  // ---------- guardrails ----------
  const gx = block.right + 140;
  wf.add(ifTrue('Proposes a refund?', [gx, 0], `={{ ['refund_full', 'refund_partial'].includes($json.output?.decision) && !!$json.output?.payment_intent_id }}`));
  wf.add(http('Re-read payment (Stripe)', [gx + 220, 0], {
    url: `=https://api.stripe.com/v1/payment_intents/{{ $('${AGENT}').item.json.output.payment_intent_id }}`,
    auth: stripe,
    query: { 'expand[]': 'latest_charge' },
    errorOutput: true,
  }));
  wf.add(code(GUARD, [gx + 440, 0], `
${guardPreamble(AGENT)}
const req = $('${INTAKE}').item.json;
const pi = $json; // fresh read, not what the agent saw
const charge = pi.latest_charge ?? {};
const amount = Number(out?.refund_amount_cents ?? 0);
const received = charge.amount_captured ?? pi.amount_received ?? 0;
const refundable = received - (charge.amount_refunded ?? 0);
const daysSincePayment = (Date.now() / 1000 - (pi.created ?? 0)) / 86400;
const paidEmail = (pi.receipt_email ?? charge.billing_details?.email ?? '').toLowerCase();

if (pi.status !== 'succeeded') reasons.push('payment status is ' + pi.status);
if (charge.disputed) reasons.push('charge is disputed');
if (!(amount > 0)) reasons.push('refund amount missing or zero');
if (amount > refundable) reasons.push('refund ' + amount + ' exceeds refundable ' + refundable);
if (amount > cfg.auto_refund_max_cents) reasons.push('refund ' + amount + ' above auto limit ' + cfg.auto_refund_max_cents);
if (daysSincePayment > cfg.refund_window_days) reasons.push('payment is ' + Math.floor(daysSincePayment) + ' days old, window is ' + cfg.refund_window_days);
if (pi.currency !== req.currency) reasons.push('currency ' + pi.currency + ' differs from request ' + req.currency);
if (paidEmail && paidEmail !== req.customer_email) reasons.push('request email does not match payment email');
if (req.requested_amount != null && amount > Math.round(req.requested_amount * 100)) reasons.push('refund exceeds the amount the customer asked for');
if (out?.eligibility?.identity_match !== true) reasons.push('agent could not confirm identity');

const ok = reasons.length === 0;
return {
  json: {
    business_key: req.business_key,
    route: ok ? 'auto' : 'escalate',
    guardrail_reasons: reasons,
    planned_actions: ok ? [{ action: 'stripe.refund', payment_intent: pi.id, amount_cents: amount }] : [],
    refund: { payment_intent: pi.id, amount_cents: amount, currency: pi.currency },
  },
};
`));
  wf.add(ifTrue('Within policy?', [gx + 660, 0], `={{ $json.route === 'auto' }}`));
  wf.link(AGENT, 'Proposes a refund?');
  wf.link('Proposes a refund?', 'Re-read payment (Stripe)', 0);
  wf.link('Re-read payment (Stripe)', GUARD, 0);
  wf.link(GUARD, 'Within policy?');

  // ---------- act & verify ----------
  const ax = gx + 920;
  wf.add(http('Issue refund (Stripe)', [ax, 0], {
    method: 'POST',
    url: 'https://api.stripe.com/v1/refunds',
    auth: stripe,
    headers: { 'Idempotency-Key': `=refund-{{ $('${INTAKE}').item.json.request_id }}` },
    form: {
      payment_intent: '={{ $json.refund.payment_intent }}',
      amount: '={{ $json.refund.amount_cents }}',
      reason: 'requested_by_customer',
      'metadata[request_id]': `={{ $('${INTAKE}').item.json.request_id }}`,
      'metadata[order_number]': `={{ $('${INTAKE}').item.json.order_number }}`,
      'metadata[issued_by]': 'aelix-refund-agent',
    },
    errorOutput: true,
  }));
  wf.add(http('Read back refund (Stripe)', [ax + 220, 0], {
    url: '=https://api.stripe.com/v1/refunds/{{ $json.id }}',
    auth: stripe,
    errorOutput: true,
  }));
  wf.add(code('Verify refund', [ax + 440, 0], `
// The refund counts as done only if Stripe reports it with the amount we planned.
const planned = $('${GUARD}').item.json.refund;
const r = $json;
const ok = ['succeeded', 'pending'].includes(r.status)
  && r.amount === planned.amount_cents
  && r.payment_intent === planned.payment_intent;
return {
  json: {
    verified: ok,
    verify_failed: !ok,
    verify_detail: ok ? '' : 'refund ' + r.id + ' has status ' + r.status + ' and amount ' + r.amount,
    refund_id: r.id,
    refund_status: r.status,
  },
};
`));
  wf.add(ifTrue('Verified?', [ax + 660, 0], '={{ $json.verified }}'));
  wf.add(gmail('Confirm to customer', [ax + 880, 0], {
    to: `={{ $('${INTAKE}').item.json.customer_email }}`,
    subject: `=Your refund for order {{ $('${INTAKE}').item.json.order_number }}`,
    message: `=Hello,

We have refunded {{ ($('${GUARD}').item.json.refund.amount_cents / 100).toFixed(2) }} {{ $('${GUARD}').item.json.refund.currency.toUpperCase() }} for order {{ $('${INTAKE}').item.json.order_number }} to your original payment method. Depending on your bank, it can take 5 to 10 business days to appear.

Refund reference: {{ $json.refund_id }}

If anything looks wrong, reply to this email and a member of our team will pick it up.`,
  }));
  wf.add(setFields('Mark completed', [ax + 1100, 0], { outcome: 'completed' }));
  wf.link('Within policy?', 'Issue refund (Stripe)', 0);
  wf.link('Issue refund (Stripe)', 'Read back refund (Stripe)', 0);
  wf.link('Read back refund (Stripe)', 'Verify refund', 0);
  wf.link('Verify refund', 'Verified?');
  wf.link('Verified?', 'Confirm to customer', 0);
  wf.link('Confirm to customer', 'Mark completed');

  // ---------- hand off ----------
  const h = handoffTail(wf, {
    x: ax, y: 560, agentName: AGENT, intakeName: INTAKE, guardName: GUARD,
    team: 'refunds team', channel: `={{ ${cfg}.slack_channel }}`,
    summary: `'Order ' + intake.order_number + ' · proposed: ' + (agent?.output?.decision ?? 'none') + (agent?.output?.refund_amount_cents ? ' ' + (agent.output.refund_amount_cents / 100).toFixed(2) + ' ' + (agent.output.currency ?? '').toUpperCase() : '')`,
  });
  wf.link(AGENT, h.first, 1);                        // agent failed
  wf.link('Proposes a refund?', h.first, 1);         // deny / escalate / no payment found
  wf.link('Re-read payment (Stripe)', h.first, 1);   // Stripe read failed
  wf.link('Within policy?', h.first, 1);             // guardrail stopped it
  wf.link('Issue refund (Stripe)', h.first, 1);      // refund call failed
  wf.link('Read back refund (Stripe)', h.first, 1);  // could not confirm
  wf.link('Verified?', h.first, 1);                  // Stripe disagrees with the plan

  // ---------- audit ----------
  const a = auditTail(wf, { x: ax + 1360, y: 280, agentName: AGENT, intakeName: INTAKE, guardName: GUARD });
  wf.link('Mark completed', a.first);
  wf.link(h.last, a.first);

  // ---------- stickies ----------
  wf.group({ name: 'Stage: intake', title: '1 · Intake', color: COLOR.intake, nodes: ['Refund request received', 'Config', INTAKE], body: `
Support posts a refund request to the webhook. **Config** holds every tunable: Salesforce instance, refund window, auto-refund limit, confidence floor, Slack channel.
**Normalize request** rejects anything missing request_id, order_number or customer_email.` });
  wf.group({ name: 'Stage: observe and plan', title: '2 · Observe and plan (agent)', color: COLOR.plan, nodes: block.nodes, body: `
Claude reads the order in Salesforce and the payment in Stripe, then proposes: refund in full, refund part, deny, or escalate.
**Read-only tools.** The agent cannot move money. Its answer is a structured proposal (see *output schema*). The customer's reason is passed as quoted data, not instructions.` });
  wf.group({ name: 'Stage: guardrails', title: '3 · Guardrails (deterministic)', color: COLOR.guard, nodes: ['Proposes a refund?', 'Re-read payment (Stripe)', GUARD, 'Within policy?'], body: `
Only refund proposals continue. Stripe is **read again**, then plain code checks: payment succeeded, not disputed, inside the window, amount within what's refundable and under the auto limit, same currency, email matches, confidence above the floor.
Any failed check goes to hand-off with the reason.` });
  wf.group({ name: 'Stage: act and verify', title: '4 · Act and verify', color: COLOR.act, nodes: ['Issue refund (Stripe)', 'Read back refund (Stripe)', 'Verify refund', 'Verified?', 'Confirm to customer', 'Mark completed'], body: `
Refund is issued with an **idempotency key** (request id), so a retry never refunds twice. Stripe is read back and the refund must match the plan before the customer hears anything.
The confirmation email is a fixed template. Model-written text is never sent to customers.` });
  wf.group({ name: 'Stage: hand off', title: '5 · Hand off', color: COLOR.handoff, nodes: h.nodes, body: `
Every path that stops lands here: denials, escalations, failed checks, Stripe errors, failed verification.
The exception row carries the request, the agent's proposal and confidence, the questions it wants answered, and every tool call it made, so the reviewer starts with the homework done.` });
  wf.group({ name: 'Stage: audit', title: '6 · Audit', color: COLOR.audit, nodes: a.nodes, body: `
One row per run in **agent_runs**: outcome, route, the agent's decision, guardrail reasons, actions taken, tool-call count, model and n8n execution id.` });

  wf.alignTops(['Stage: intake', 'Stage: observe and plan', 'Stage: guardrails', 'Stage: act and verify']);

  overviewStickies(wf, {
    overview: `## FinTech · Refund handler agent
**Job:** take a refund request off the support desk. Check eligibility in Salesforce and Stripe, issue the refund when it's inside policy, confirm with the customer, and hand everything else to the refunds team with the full trace.

**Flow:** intake → agent proposes (read-only) → guardrails re-read Stripe and check policy → refund, read back, confirm → hand off anything that stops → audit.

**Never does**
- Refunds above the auto limit or outside the window
- Refunds on disputed charges or mismatched identities
- Denials. A person sends every "no".
- Sends model-written text to a customer

**Model:** Claude Opus 5, adaptive thinking, effort high. Change it on the *Claude* node.`,
    setup: `## Setup
1. Run **sql/schema.sql** on your Postgres. Pick that credential on *Queue exception* and *Write audit record*.
2. Credentials to create and select: **Anthropic** (Claude node), **Salesforce OAuth2** (order lookup), **Stripe** (all Stripe nodes), **Gmail**, **Slack**.
3. Salesforce: the Order object needs a **Payment_Intent_Id__c** field. If yours is named differently, edit the SOQL in *Look up order*.
4. Edit **Config**: instance URL, refund window, auto limit (cents), confidence floor, Slack channel.
5. Start with **Stripe test-mode keys**.
6. Test: \`curl -X POST <test webhook URL> -H 'Content-Type: application/json' -d @samples/fintech-refund-request.json\``,
  });

  return wf;
}

# Aelix Echo agent workflows for n8n

Seven n8n workflows, one for each industry card on [aelixecho.com/ai-agents](https://aelixecho.com/ai-agents). Each one runs the loop the page describes: observe, plan, act, verify, hand off.

| # | File | Industry | Work taken off the desk | Trigger |
|---|---|---|---|---|
| 1 | `workflows/01-fintech-refund-handler.json` | FinTech | Refund handling: eligibility check and refund | Webhook |
| 2 | `workflows/02-healthcare-prior-auth-triage.json` | Healthcare | Prior-auth triage: packet assembly and routing | Webhook |
| 3 | `workflows/03-manufacturing-invoice-exception.json` | Manufacturing | Invoice exceptions: match, draft, escalate | Webhook |
| 4 | `workflows/04-logistics-shipment-exceptions.json` | Logistics | Shipment exceptions: trace, re-plan, escalate | Webhook |
| 5 | `workflows/05-legaltech-contract-intake.json` | LegalTech | Contract intake: classify and route | Webhook |
| 6 | `workflows/06-energy-outage-ticket-triage.json` | Energy & Utilities | Outage ticket triage: correlate and dispatch | Every 2 min |
| 7 | `workflows/07-realestate-vendor-onboarding.json` | Real Estate & Construction | Vendor onboarding: document collection | Webhook |

Built and tested against **n8n 2.40.7**. All seven import cleanly and pass n8n's own workflow validator.

## How every workflow is built

Every canvas has the same six stages, each inside a colour-coded sticky note. An Overview and a Setup sticky sit on the left of each canvas.

```
1 Intake ─▶ 2 Observe & plan ─▶ 3 Guardrails ─▶ 4 Act & verify ─▶ 6 Audit
             (agent, read-only)   (plain code)    (write, read back)    ▲
                  │                    │                 │               │
                  └────────────────────┴─────────────────┴──▶ 5 Hand off ┘
```

- **The agent only reads.** Every tool attached to the AI Agent node is a GET (or a read-only quote). The agent returns a structured proposal validated against a JSON schema. It cannot change a system of record.
- **Guardrails are deterministic.** A Code node re-reads the system of record where it matters (Stripe payment, ERP match view, OMS outage, TMS shipment) and checks the proposal against the limits in **Config**. The model's arithmetic is recomputed, not trusted.
- **Writes are idempotent and verified.** Write calls carry an idempotency key. The record is read back, and the run counts as done only when the system shows the planned result.
- **Every stop goes to one hand-off.** Agent errors, guardrail stops, failed writes and failed verification all land in the same place. It writes an `agent_exceptions` row with the reasons, the proposal, the agent's questions for a person, and every tool call and observation, then posts to Slack.
- **Every run is audited** in `agent_runs`.
- **Customers and vendors only get fixed templates.** Model-written text goes to reviewers, never straight to an outside party.
- **Untrusted text is data.** Customer reasons, carrier notes, contract text and ticket descriptions are passed inside tags and labelled as data, not instructions.

Model: **Claude Opus 5** (`claude-opus-5`) with adaptive thinking. Effort is high everywhere except Energy, which uses medium for high-volume triage. Prompt caching is on (5 minutes). Change the model on each workflow's `… · Claude` node.

## What each one will not do

| Workflow | Always goes to a person |
|---|---|
| Refund handler | Denials; refunds above the auto limit, outside the window, on disputed charges or with mismatched identity |
| Prior-auth triage | Every payer submission; urgency disagreements; unknown PA requirement. It never decides medical necessity. |
| Invoice exception | Quantity variances, anything outside tolerance, under-billing, duplicates. Vendor emails are drafts only. |
| Shipment exceptions | Damage, customs, hazmat and address issues; paid re-plans over the cost limit or that still miss the promise |
| Contract intake | Every approval, redline and signature; routing disagreements; counterparty mismatches; scanned PDFs |
| Outage triage | Every crew dispatch; hazard reports (caught by a keyword screen before the model runs); critical customers |
| Vendor onboarding | Every vendor approval; sanctions hits; license-holder mismatches |

## Setting up

1. **Database.** Run `sql/schema.sql` on a Postgres database. It creates `agent_runs`, `agent_exceptions` and `pa_worklist`.
2. **Import.** In n8n: *Workflows → Import from file*, one file at a time. Or with the CLI: `n8n import:workflow --separate --input=workflows/`.
3. **Credentials.** Open each workflow and connect the credentials its Setup sticky lists: Anthropic, Postgres, Slack, and Gmail where used. FinTech also needs Stripe and Salesforce OAuth2. The rest use Header Auth for your internal APIs.
4. **Config.** Each workflow has a **Config** node with every tunable in one place: base URLs, limits, tolerances, the confidence floor and Slack channels.
5. **Test.** Each Setup sticky has a `curl` line that posts the matching file from `samples/` to the test webhook URL.

### Integrations you have to map

FinTech calls the real Salesforce and Stripe APIs. The other six call a **thin gateway contract** (for example `GET /invoices/{id}/match` or `POST /shipments/{id}/rebook`), because every client's ERP, TMS, EHR, CLM or OMS is different. Each Setup sticky names the systems the contract usually maps to (SAP, Oracle, D365; OTM, Blue Yonder; Ironclad; Oracle NMS; and so on). Either stand that contract up in your integration layer, or edit the URLs on the tool and HTTP nodes.

### Healthcare and PHI

Only send PHI to Claude under a signed BAA with Anthropic, on a self-hosted n8n you control. Set execution-data pruning to match your retention policy. The workflow keeps PHI out of Slack; messages carry request ids only.

## Changing the workflows

The JSON files are generated from `scripts/`, so the seven stay consistent. You can edit the imported workflows in the n8n editor directly. To change the source instead:

```bash
npm install                       # pulls n8n 2.40.7 for validation (large)
npm run build                     # scripts/workflows/*.mjs -> workflows/*.json
npm test                          # 44 guardrail and verification scenarios, no network
npm run validate                  # n8n's validator + sticky layout checks
```

- `scripts/lib.mjs`: shared builders (agent block, hand-off, audit, stickies)
- `scripts/workflows/0N-*.mjs`: one file per workflow: prompts, tools, schema, guardrail code, sticky text
- `scripts/test-guardrails.mjs`: runs the Guardrails, Verify, Safety screen and hand-off Code nodes from the built JSON against fixed scenarios

## What has and hasn't been tested

- **Tested:** all seven import into n8n 2.40.7 and render correctly on the canvas. Node parameters pass n8n's schema validator. Every Code node compiles. The guardrail, verification, safety-screen and hand-off logic passes 44 scenarios.
- **Not tested:** live runs against Claude, Stripe, Salesforce or the gateway APIs, because no credentials were available. Run each workflow first with test-mode keys and staging endpoints, and read the first few `agent_exceptions` rows before raising any limits.

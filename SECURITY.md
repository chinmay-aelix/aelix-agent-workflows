# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository (*Security → Report a vulnerability*).

## How the workflows limit risk

- **No secrets in the repository.** Credentials are created in n8n and referenced by name. CI scans the full git history for secrets on every push.
- **Read-only agent.** The model can only call read tools. Every write happens after deterministic guardrails, carries an idempotency key and is verified by a read-back.
- **Prompt injection.** Untrusted text (customer messages, contract text, carrier notes, tickets) is wrapped in tags and labelled as data. Outbound messages to customers and vendors are fixed templates, never model-written text.
- **Human in the loop.** High-impact actions (denials, payer submissions, crew dispatch, vendor approval, signatures) always go to a person. See [docs/architecture.md](docs/architecture.md).
- **Audit.** Every run writes an `agent_runs` row, and every stop writes an `agent_exceptions` row with the full tool-call trace.

## Deployment guidance

- **PHI:** only send PHI to Claude under a signed BAA with Anthropic, on a self-hosted n8n you control. Restrict access to `pa_worklist`, and set n8n execution-data pruning to match your retention policy.
- Start with test-mode keys and staging endpoints, and keep auto-action limits low until the first `agent_exceptions` rows have been reviewed.
- Give each credential the least privilege the workflow needs (for example a Stripe restricted key with refund and read access only).

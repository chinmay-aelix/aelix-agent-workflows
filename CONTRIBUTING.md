# Contributing

## How the code is organised

The JSON files in `workflows/` are **generated**. Edit the source in `src/`, then rebuild. CI fails if the committed JSON does not match its source.

| Path | What it is |
|---|---|
| `src/lib.mjs` | Shared builders: agent block, hand-off, audit, stickies, stable ids |
| `src/workflows/0N-*.mjs` | One file per workflow: prompts, tools, output schema, guardrail code, sticky text |
| `scripts/build.mjs` | Writes `workflows/*.json` from `src/workflows/`; `--check` verifies without writing |
| `scripts/validate.mjs` | n8n's own validator plus layout and graph checks |
| `test/guardrails.test.mjs` | Runs the Guardrails, Verify, Safety screen and hand-off Code nodes from the built JSON against fixed scenarios |

You can also edit imported workflows directly in the n8n editor. Changes made that way are not reflected here until they are ported back to `src/`.

## Workflow

Requires Node 24 or later (see `.nvmrc`), which n8n 2.40.7 needs. The build check and tests alone also run on Node 22.

```bash
npm run build        # src/workflows/*.mjs -> workflows/*.json
npm test             # 44 guardrail and verification scenarios; no install, no network
npm ci               # pulls the pinned n8n 2.40.7 for validation (large)
npm run validate     # n8n's validator + layout checks
npm run check        # all of the above, as CI runs it
```

## What CI checks

Every push and pull request runs `.github/workflows/ci.yml`:

1. **Build check** on Node 22 and 24: the committed JSON matches `src/`.
2. **Guardrail tests** on Node 22 and 24: the 44 scenarios pass.
3. **n8n validation**: node parameters pass n8n's schema validator; every node sits in exactly one stage sticky; stickies do not overlap; every connection points at a real node; no em-dashes in sticky or prompt text.
4. **Secret scan** of the full history with gitleaks.

## Rules for changes

- Any new escalation or guardrail rule gets a test scenario in `test/guardrails.test.mjs`.
- The agent stays read-only. Writes belong in stage 4, after Guardrails, with an idempotency key and a read-back.
- Model-written text never goes directly to a customer or vendor.
- No credentials, real customer data or PHI anywhere in the repository, including `samples/`. Use `example.com` style placeholders.
- Record notable changes in `CHANGELOG.md`.

## What has and has not been tested

- **Tested:** all seven import into n8n 2.40.7 and render correctly on the canvas. Node parameters pass n8n's schema validator. Every Code node compiles. The guardrail, verification, safety-screen and hand-off logic passes 44 scenarios.
- **Not tested:** live runs against Claude, Stripe, Salesforce or the gateway APIs, because no credentials were available. Run each workflow first with test-mode keys and staging endpoints.

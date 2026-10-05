## What changed

<!-- Which workflows, and why. -->

## Checklist

- [ ] Edited the source in `src/`, not the generated JSON in `workflows/`
- [ ] Ran `npm run build` and committed the regenerated JSON
- [ ] `npm test` passes, with a new scenario for any new guardrail or escalation rule
- [ ] `npm run validate` passes (or CI's validate job is green)
- [ ] No credentials, real customer data or PHI in code, samples or sticky text
- [ ] Updated `CHANGELOG.md` and the docs if behaviour changed

# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-05

### Added

- Seven n8n agent workflows: FinTech refund handler, Healthcare prior-auth triage, Manufacturing invoice exception, Logistics shipment exceptions, LegalTech contract intake, Energy outage ticket triage, Real Estate vendor onboarding.
- Postgres schema for `agent_runs`, `agent_exceptions` and `pa_worklist`.
- Sample request payloads for every workflow.
- 44 guardrail, verification, safety-screen and hand-off test scenarios.
- CI: source and JSON drift check, tests on Node 22 and 24, n8n schema and layout validation, secret scan.
- Architecture, setup, contributing and security documentation.

### Changed

- Workflow source moved from `scripts/` to `src/`, and tests to `test/`. Generated JSON is unchanged.

-- Tables used by the Aelix Echo agent workflows. Postgres 13+.
-- Run once against the database selected in the workflows' Postgres credential.

-- One row per workflow run, whichever way it ended.
CREATE TABLE IF NOT EXISTS agent_runs (
  id                bigserial PRIMARY KEY,
  workflow          text        NOT NULL,           -- e.g. fintech-refund-handler
  business_key      text,                           -- request id, invoice id, ticket id...
  outcome           text        NOT NULL,           -- completed | escalated | documents_requested | ready_for_approval
  route             text        NOT NULL,           -- auto | escalate
  decision          jsonb,                          -- the agent's structured output
  guardrail_reasons jsonb       NOT NULL DEFAULT '[]',
  actions           jsonb       NOT NULL DEFAULT '[]',
  tool_calls        integer     NOT NULL DEFAULT 0,
  model             text,
  n8n_execution_id  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_runs_workflow_created ON agent_runs (workflow, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_business_key ON agent_runs (business_key);

-- The exception queue: everything a person needs to decide, in one row.
CREATE TABLE IF NOT EXISTS agent_exceptions (
  id                bigserial PRIMARY KEY,
  workflow          text        NOT NULL,
  business_key      text,
  team              text        NOT NULL,
  status            text        NOT NULL DEFAULT 'open',   -- open | in_review | resolved
  reasons           jsonb       NOT NULL DEFAULT '[]',     -- why it stopped
  proposed_action   jsonb,                                  -- what the agent proposed
  confidence        numeric,
  questions         jsonb       NOT NULL DEFAULT '[]',     -- what the agent wants a person to answer
  trace             jsonb       NOT NULL DEFAULT '[]',     -- every tool call and observation
  summary           text,
  resolution        text,
  resolved_by       text,
  resolved_at       timestamptz,
  n8n_execution_id  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_exceptions_open ON agent_exceptions (team, status, created_at);

-- Healthcare prior-auth worklist. Holds PHI: restrict access accordingly.
CREATE TABLE IF NOT EXISTS pa_worklist (
  id                bigserial PRIMARY KEY,
  request_id        text        NOT NULL UNIQUE,
  queue             text        NOT NULL,   -- ready_for_submission_review | needs_documents | clinical_review | no_pa_required_confirm
  urgency           text        NOT NULL,   -- standard | expedited
  payer_name        text,
  packet            jsonb       NOT NULL DEFAULT '[]',
  missing_items     jsonb       NOT NULL DEFAULT '[]',
  reviewer_summary  text,
  confidence        numeric,
  assigned_to       text,
  status            text        NOT NULL DEFAULT 'open',
  n8n_execution_id  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pa_worklist_queue ON pa_worklist (queue, urgency, created_at);

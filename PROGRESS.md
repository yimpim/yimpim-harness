# Active Plan

**Goal:** Implement authenticated user agent telemetry tracking in broker.ts to record aggregated session, prompt, worker, phase, and abort metrics in Supabase.

## Assumptions

- Atomic increments in Supabase use the increment_user_agent_metrics RPC function when available, with direct upsert on public.user_agent_metrics as a compatible fallback for test stubs.
- Events and commands sent over WebSocket tunnel or HTTP endpoints may include unencrypted diagnostic metadata or structured event/command objects that can be parsed for telemetry without breaking end-to-end payload routing.

## Phases

- [x] **1. Add user agent telemetry tracking and session user binding to broker.ts**
      Extend broker.ts Session model and request handlers to bind authenticated user_id, record atomic metric upserts to public.user_agent_metrics, and export recordUserAgentMetrics.
      files: src/remote/broker.ts
      verify: TypeScript compilation via npx tsc --noEmit succeeds without type errors in src/remote/broker.ts.
      verify: Existing device link and broker unit tests in test/brokerDeviceLink.test.ts continue to pass with npm test.

- [x] **2. Add unit and regression tests for broker telemetry in test/brokerTelemetry.test.ts**
      Create comprehensive test suite verifying user agent telemetry increments, user binding, unauthenticated session bypass, phase timings, worker run mapping, and manual aborts.
      files: test/brokerTelemetry.test.ts (new)
      verify: Running node --test test/brokerTelemetry.test.ts completes successfully with 100% passing tests.
      verify: Full test suite execution via npm test passes with zero regressions.

## Before this is live

Steps you need to do outside this repo — credentials or console access this agent does not have:

1. **In the production Supabase project, create the `public.user_agent_metrics` table (columns: `user_id text primary key`, `total_sessions`, `total_prompts`, `advisor_runs`, `editor_runs`, `discovery_runs`, `repair_runs`, `qa_runs`, `phases_completed`, `phases_failed`, `user_aborts`, `total_files_changed`, `total_execution_seconds` as `bigint`/`int8` defaulting to 0, plus `last_failure_reason text` and `last_active_at timestamptz`) and the `public.increment_user_agent_metrics(p_user_id text, p_increments jsonb, p_last_failure_reason text, p_last_active_at timestamptz)` SQL function that performs a single `INSERT ... ON CONFLICT (user_id) DO UPDATE SET col = user_agent_metrics.col + COALESCE((EXCLUDED-style value)::bigint, 0)` upsert.**  _(from: 1/2 Add user agent telemetry tracking and session user binding to broker.ts)_
   why: Requires production Supabase dashboard/DB credentials the agent does not have; the code calls the RPC and the `.upsert(..., { onConflict: 'user_id' })` fallback, but neither table nor function exists in this repo.

# FV AI Workforce

A private, free-first coordination foundation for the FlipTop Vault AI Workforce project.

## Current stage: dispatcher and approval foundation

The current branch contains a protected task-coordination API with:
- Worker registry and capability-based task assignment.
- Task creation, priority updates, and restricted status transitions.
- Approval requests with single-use `task_execution` approvals.
- Human review of work submissions before a task can be marked completed.
- Task-event audit records for key workflow changes.
- Request-body size limits and bearer-token authentication.

This is **not yet connected** to the FlipTop Vault website, Firebase/Firestore, Facebook, Shopee, or external social accounts. It does not run scheduled monitoring jobs or publish content.

## Important security boundaries

- `WORKFORCE_API_TOKEN` is a manager/control-plane secret. Treat it as an administrator credential; do not give it to an AI worker, browser client, or public website.
- Worker records and role labels are not a substitute for individual worker authentication. Before external workers are allowed to call this API, add per-worker identity and scoped permissions.
- AI execution is disabled unless `AI_EXECUTION_ENABLED` is explicitly set to `true`. The test Wrangler configuration intentionally has no Workers AI binding.
- Every AI task run requires a currently approved, unused `task_execution` approval for that exact task.
- Task completion can only happen through accepting a submitted work item.
- Human approval is still required before public posts, live website changes, database writes, or other external actions.
- The current automated API tests use mocked D1 interfaces. The SQLite compatibility tests exercise the migration SQL and transaction logic, but they are not a substitute for integration tests against the actual Cloudflare D1 service.

**Do not treat this branch as production-ready.** Production readiness still requires per-worker authentication/authorization, actual isolated TEST D1 integration tests, operational monitoring/rate limiting, and a reviewed deployment procedure.

## Test-only Cloudflare configuration

`wrangler.test.example.jsonc` targets only:
- Worker: `fv-ai-workforce-dispatcher-test`
- D1: `fv-ai-workforce-test-db`

It does not bind Workers AI. The production Worker and production D1 configuration are kept separate.

Commands:
```bash
npm install
npm test
python3 test/migrations_test.py
npm run check
```

`npm run check` is a Wrangler dry run. `npm run deploy` uses the test configuration, but do not run it unless a test deployment is explicitly intended and the TEST D1 migration state has been checked first.

## Free-first policy

Use Cloudflare's free tier where practical. Check current plan limits before deploying. Do not enable a paid plan, add billing details, buy AI credits, or use paid services without explicit approval.

## Safety principles

- Read-only research and summarization before any external integrations.
- Human approval before publishing content or changing live website/database data.
- No unrestricted Firebase credentials.
- Keep an audit trail for task and approval decisions.
- Keep this workforce repository separate from the FlipTop Vault website repository.
- Never merge this pull request or deploy to production without explicit approval.

## Planned milestones

1. Finish workflow and security hardening on the feature branch.
2. Verify migrations and task/approval behavior against the isolated TEST D1 database.
3. Add scoped manager and per-worker authentication.
4. Add a simple manager dashboard and worker task protocol.
5. Add read-only FlipTop Vault monitoring and content preparation.
6. Add human-approved social publishing and merch updates only after separate permission and integration reviews.

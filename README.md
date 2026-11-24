# FV AI Workforce

A private, free-first cloud foundation for the FlipTop Vault AI Workforce project.

## Current stage: foundation

This starter provides:
- `GET /` — service status
- `GET /health` — JSON health check
- JSON 404 responses for unknown routes
- JSON 405 responses for unsupported methods

It does **not** connect to FlipTop Vault, Firebase, Facebook, or an AI provider. It does not store user data or run background jobs.

## Free-first policy

The initial deployment target is Cloudflare Workers Free. Check current Cloudflare plan limits before deploying. Do not enable a paid plan, add billing details, or use paid services without explicit approval.

## Run locally

Requires Node.js.

```bash
npm install
npm run dev
```

Open the local URL printed by Wrangler and visit `/` or `/health`.

## Deploy

Review the code and confirm the intended Cloudflare account and plan before deploying:

```bash
npm run deploy
```

No API keys or secrets are required for this starter. Never commit credentials, tokens, or API keys to GitHub.

## Safety principles

- Read-only integrations by default.
- Human approval before publishing content or changing live website/database data.
- No unrestricted Firebase credentials.
- Keep an audit trail for future agent actions.
- Keep this workforce repository separate from the FlipTop Vault website repository.

## Planned milestones

1. Deploy and verify the health-check endpoint.
2. Design the AI Manager and worker task protocol.
3. Choose the simplest suitable free storage for tasks and audit logs.
4. Add Gemini through a securely stored Cloudflare secret, only after approval.
5. Add specialist workers with explicit permissions and human approval gates.

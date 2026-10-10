# Project: api-registry-service

Aggregates OpenAPI specs from multiple microservices into a single queryable registry. Provides REST endpoints and an MCP server for LLM-powered service discovery.

## Commands

- `npm run dev` — local dev server (tsx watch)
- `npm run build` — compile TypeScript + generate OpenAPI spec
- `npm start` — run compiled server

## Architecture

- `src/index.ts` — Express server, route handlers, service loading from env vars
- `src/schemas.ts` — Zod schemas + OpenAPI registry (source of truth for validation + spec generation)
- `src/mcp.ts` — MCP (Model Context Protocol) endpoint for LLM tool access
- `src/catalog.ts` — agent discovery logic (pure): service one-liners, endpoint -> run task linking, stats merge
- `src/run-stats.ts` — runs-service `/internal/stats/task-outcomes` client, stale-while-revalidate cache
- `src/discovery.ts` — the 3 discovery levels shared by `GET /discover/*` and the `discover_*` MCP tools

## Rules

- A service added on the box needs a line in `SERVICE_DESCRIPTIONS` and, if its runs-service `service_name` is not `<name>-service`, an entry in `RUNS_SERVICE_NAME_OVERRIDES` (`src/catalog.ts`). Box env: `/root/distribute/env/api-registry-service.env` (`<NAME>_SERVICE_URL` + `<NAME>_SERVICE_API_KEY`).
- Never invent a stat: an endpoint with no run reads `"no runs yet"`; one with no linked run task reads "opens no run" (valid only because every run-creating path of every run-recording service was read and linked in `ENDPOINT_TASKS`: a service that adds a run task MUST add its line or declare `x-run-task`). Merge task stats from sums (`mergeOutcomes`), never average averages.
- ROI = step `valueUsd` (features-service `/internal/catalogue/steps`) / `avgCostUsd`, only for an endpoint whose output IS one step per call (`x-produces-step`, a declared step's `producedBy` "<service> METHOD /path", or `ENDPOINT_STEPS`). A page of results is not one step.
- Existing MCP tools (`list_services`, `search_endpoints`, `get_endpoint_details`, `call_api`, ...) are used by other sessions: extend additively, never change their shape.
- `src/auth.ts` — API key authentication middleware
- `scripts/generate-openapi.ts` — Generates `openapi.json` from Zod schemas
- `openapi.json` — Auto-generated, do NOT edit manually

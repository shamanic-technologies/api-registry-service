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
- `src/auth.ts` — API key authentication middleware
- `scripts/generate-openapi.ts` — Generates `openapi.json` from Zod schemas
- `openapi.json` — Auto-generated, do NOT edit manually

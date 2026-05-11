# API Registry Service

Open-source service that aggregates OpenAPI specs from multiple microservices into a single queryable registry. Designed for LLM-powered service-to-service discovery.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     API Registry Service                         │
│              https://your-registry.railway.app                   │
│                                                                  │
│  Aggregates OpenAPI specs from all registered services.          │
│  Provides discovery via REST endpoints and MCP tools.            │
│                                                                  │
│  REST: GET /llm-context                                          │
│  MCP:  POST /mcp (tools: list_services, search_endpoints, etc.) │
└──────────────────────────┬──────────────────────────────────────┘
                           │ fetches /openapi.json from each service
                           │
     ┌─────────┬───────────┼───────────┬──────────┬──────────┐
     ▼         ▼           ▼           ▼          ▼          ▼
  service-a  service-b  service-c  service-d  service-e  ... (N total)
```

## Quick Start

```bash
npm install
npm run dev
```

## Configuration

Register your services via environment variables:

### Option 1: Single env var (comma-separated)

```bash
SERVICES="api-service=https://api.example.com,campaign-service=https://campaign.example.com"
```

### Option 2: Individual env vars

Use the `<NAME>_SERVICE_URL` suffix convention. Each service is keyed by the lowercased prefix (underscores become hyphens):

```bash
API_SERVICE_URL=https://api.example.com
CAMPAIGN_SERVICE_URL=https://campaign.example.com
EMAILGEN_SERVICE_URL=https://emailgen.example.com
```

Optionally pair each with `<NAME>_SERVICE_API_KEY` to forward an API key when calling that service.

Each registered service must expose `GET /openapi.json` returning an OpenAPI 3.0 spec.

## Authentication

Protect the registry with an API key:

```bash
API_REGISTRY_SERVICE_API_KEY=your-secret-key-here
```

All endpoints except `/health` require authentication via:
- Header: `X-API-Key: your-secret-key-here`
- Or: `Authorization: Bearer your-secret-key-here`

If `API_REGISTRY_SERVICE_API_KEY` is not set, all routes are open (development mode).

## REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/services` | List all registered services |
| `GET` | `/openapi/:service` | Fetch spec for one service |
| `GET` | `/llm-context` | LLM-friendly overview of all services |
| `GET` | `/llm-context/:service` | LLM-friendly endpoint list for one service (supports `?method`, `?group`, `?pathPrefix` filters) |
| `GET` | `/search?q=...` | Ranked full-text search across all endpoints (supports `?service`, `?method`, `?pathPrefix`, `?limit`) |
| `POST` | `/call/:service` | Proxy a call to a registered service (auto-injects API key and identity headers) |

### `/llm-context` Response Format

Optimized for LLM consumption — compact, no header params, includes body fields:

```json
{
  "_description": "API Registry - Use this to discover available services and their endpoints.",
  "_usage": "To call an endpoint: send HTTP request to {baseUrl}{path}",
  "services": [
    {
      "service": "api-service",
      "baseUrl": "https://api.example.com",
      "title": "My API",
      "endpoints": [
        {
          "method": "POST",
          "path": "/v1/campaigns",
          "summary": "Create a campaign",
          "bodyFields": ["name", "brandUrl"]
        }
      ]
    }
  ]
}
```

## MCP Server

The registry exposes an MCP (Model Context Protocol) endpoint at `/mcp` so LLMs can discover and call APIs directly.

### MCP Tools

| Tool | What it does | When to use |
|------|-------------|-------------|
| `list_services` | Returns all service names + base URLs | First step — see what exists |
| `get_all_endpoints` | Lightweight overview of every service (name, description, endpoint count) | You need a high-level map of the full API surface |
| `list_service_endpoints` | List endpoints for one service, with optional method/group/pathPrefix filters | You've picked a service and want to see its endpoints |
| `search_endpoints` | Search by keyword (e.g. "campaign", "email", "brand") | You know what you need but not which service has it |
| `get_endpoint_details` | Full request + response schema for one endpoint, with `$ref`s resolved | You're about to call an endpoint and need exact field names |
| `call_api` | Actually call an endpoint on any service | Execute an API call through the registry |

### Connect from Claude Desktop / Claude Code

Add to your MCP client config:

```json
{
  "mcpServers": {
    "api-registry": {
      "url": "https://your-registry.railway.app/mcp",
      "headers": {
        "X-API-Key": "your-secret-key-here",
        "x-org-id": "your-org-uuid",
        "x-user-id": "your-user-uuid"
      }
    }
  }
}
```

The `x-org-id` and `x-user-id` headers are optional for MCP connections. When provided, they are forwarded to downstream services via the `call_api` tool. Without them, discovery tools (`list_services`, `search_endpoints`, etc.) still work normally.

## How to Discover Services

### Option 1: MCP (Recommended for LLMs)

Connect to the registry's MCP endpoint and use its tools:

```
MCP endpoint: https://your-registry.railway.app/mcp
```

### Option 2: REST

```bash
# Get a compact summary of all services and endpoints (LLM-optimized)
curl -H "X-API-Key: your-key" https://your-registry.railway.app/llm-context

# Get the full OpenAPI spec for a specific service
curl -H "X-API-Key: your-key" https://your-registry.railway.app/openapi/campaign-service

# List all registered services
curl -H "X-API-Key: your-key" https://your-registry.railway.app/services
```

## Registering Services

Each registered service must expose `GET /openapi.json` returning an OpenAPI 3.0 spec (without authentication on that route).

## Deploy on Railway

1. Connect this repo to Railway
2. Set `SERVICES` env var with your service URLs
3. Set `API_REGISTRY_SERVICE_API_KEY` for auth
4. Deploy

## Caching

The registry keeps an in-memory endpoint search index with a 1-minute TTL. The index is rebuilt on the next request after expiry by re-fetching `/openapi.json` from every registered service. There is no manual refresh endpoint — updates from a redeployed service propagate within at most 1 minute.

## License

MIT

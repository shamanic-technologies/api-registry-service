# API Registry Service

Open-source service that aggregates OpenAPI specs from multiple microservices into a single queryable registry. Designed for LLM-powered service-to-service discovery.

## Quick Start

```bash
npm install
npm run dev
```

## Configuration

## Authentication

Protect the registry with an API key:

```bash
API_REGISTRY_SERVICE_API_KEY=your-secret-key-here
```

All endpoints except `/health` require authentication via:
- Header: `X-API-Key: your-secret-key-here`
- Or: `Authorization: Bearer your-secret-key-here`

If `API_REGISTRY_SERVICE_API_KEY` is not set, all routes are open (development mode).

For MCP clients (Claude Desktop), add the key to your config:

```json
{
  "mcpServers": {
    "api-registry": {
      "url": "https://your-registry.railway.app/mcp",
      "headers": {
        "X-API-Key": "your-secret-key-here"
      }
    }
  }
}
```

Register your services via environment variables:

### Option 1: Single env var (comma-separated)

```bash
SERVICES="api-service=https://api.example.com,campaign-service=https://campaign.example.com"
```

### Option 2: Individual env vars

```bash
SERVICE_API_URL=https://api.example.com
SERVICE_CAMPAIGN_URL=https://campaign.example.com
SERVICE_EMAIL_GEN_URL=https://emailgen.example.com
```

Each registered service must expose `GET /openapi.json` returning an OpenAPI 3.0 spec.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/services` | List all registered services |
| `GET` | `/openapi` | Fetch all OpenAPI specs |
| `GET` | `/openapi/:service` | Fetch spec for one service |
| `GET` | `/llm-context` | LLM-friendly summary of all endpoints |
| `POST` | `/refresh` | Refresh all cached specs |
| `POST` | `/refresh/:service` | Refresh one service's spec |

## `/llm-context` Response Format

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

## Deploy on Railway

1. Connect this repo to Railway
2. Set `SERVICES` env var with your service URLs
3. Deploy

## Caching

Specs are cached for 5 minutes. Use `POST /refresh` to force a cache refresh (useful as a CI/CD webhook after deployments).

## Adding OpenAPI to Your Services

Each service needs to expose `GET /openapi.json`. For Express.js services, use [swagger-autogen](https://www.npmjs.com/package/swagger-autogen):

```bash
npm install swagger-autogen
```

```typescript
// scripts/generate-openapi.ts
import swaggerAutogen from "swagger-autogen";

const doc = {
  info: { title: "My Service", version: "1.0.0" },
};

swaggerAutogen({ openapi: "3.0.0" })("./openapi.json", ["./src/index.ts"], doc);
```

```json
// package.json
{
  "scripts": {
    "build": "tsc && pnpm generate:openapi",
    "generate:openapi": "tsx scripts/generate-openapi.ts"
  }
}
```

Then serve it:

```typescript
import spec from "../openapi.json" assert { type: "json" };
app.get("/openapi.json", (req, res) => res.json(spec));
```

## MCP Server

The registry also exposes an MCP (Model Context Protocol) endpoint at `/mcp` so LLMs can discover and call APIs directly.

### MCP Tools

| Tool | Description |
|------|-------------|
| `list_services` | List all registered API services |
| `get_service_spec` | Get the full OpenAPI spec for a service |
| `get_all_endpoints` | Get a compact summary of all endpoints (LLM-optimized) |
| `search_endpoints` | Search for endpoints by keyword across all services |
| `call_api` | Call an API endpoint on any registered service |

### Connect from Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "api-registry": {
      "url": "https://your-registry.railway.app/mcp"
    }
  }
}
```
## LLM Agent Guide

A comprehensive guide for LLM agents is available at [`templates/SERVICE_COMMUNICATION.md`](templates/SERVICE_COMMUNICATION.md). Copy this file into the `.context/` directory (or root) of each service repo so that LLM agents know how to discover and call other services.

```bash
# Copy to your service repo
cp templates/SERVICE_COMMUNICATION.md /path/to/your-service/.context/SERVICE_COMMUNICATION.md
```
## License

MIT

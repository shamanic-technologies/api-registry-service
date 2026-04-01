import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Express, Request, Response } from "express";
import { z } from "zod";
import { EndpointSearchIndex, derivePathGroup, type IndexedEndpoint } from "./search.js";

interface ServiceRegistry {
  getServices(): Record<string, { baseUrl: string; apiKey?: string }>;
  fetchSpec(url: string): Promise<{ spec: unknown; error?: string }>;
}

export function resolveRefs(
  value: unknown,
  schemas: Record<string, unknown>,
  visited: Set<string> = new Set()
): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveRefs(item, schemas, visited));
  }

  const obj = value as Record<string, unknown>;
  if (typeof obj["$ref"] === "string") {
    const ref = obj["$ref"];
    const prefix = "#/components/schemas/";
    if (!ref.startsWith(prefix)) return obj;
    const schemaName = ref.slice(prefix.length);
    if (visited.has(schemaName)) return { $ref: `circular:${schemaName}` };
    const schema = schemas[schemaName];
    if (!schema) return obj;
    return resolveRefs(schema, schemas, new Set([...visited, schemaName]));
  }

  const resolved: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    resolved[key] = resolveRefs(val, schemas, visited);
  }
  return resolved;
}

export async function getEndpointDetails(
  registry: ServiceRegistry,
  service: string,
  method: string,
  path: string,
  options?: { includeErrors?: boolean }
): Promise<Record<string, unknown>> {
  const services = registry.getServices();
  const entry = services[service];
  if (!entry) {
    return {
      error: `Service "${service}" not found`,
      available: Object.keys(services),
    };
  }

  const result = await registry.fetchSpec(entry.baseUrl);
  if (result.error || !result.spec) {
    return { error: result.error || "Failed to fetch spec" };
  }

  const spec = result.spec as {
    paths?: Record<string, Record<string, unknown>>;
    components?: { schemas?: Record<string, unknown> };
  };

  const pathEntry = spec.paths?.[path];
  if (!pathEntry) {
    return {
      error: `Path "${path}" not found in ${service}`,
      availablePaths: Object.keys(spec.paths || {}),
    };
  }

  const operation = pathEntry[method.toLowerCase()] as Record<string, unknown> | undefined;
  if (!operation) {
    return {
      error: `Method ${method.toUpperCase()} not found for ${path}`,
      availableMethods: Object.keys(pathEntry)
        .filter((m) => ["get", "post", "put", "patch", "delete"].includes(m))
        .map((m) => m.toUpperCase()),
    };
  }

  const schemas = spec.components?.schemas || {};

  // Extract parameters (exclude headers)
  const rawParams = operation.parameters as Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: unknown;
  }> | undefined;
  const parameters = rawParams
    ?.filter((p) => p.in !== "header")
    .map((p) => ({
      name: p.name,
      in: p.in,
      required: p.required || false,
      description: p.description,
      schema: resolveRefs(p.schema, schemas),
    }));

  // Extract request body schema
  const requestBody = operation.requestBody as {
    required?: boolean;
    description?: string;
    content?: Record<string, { schema?: unknown }>;
  } | undefined;
  let requestSchema: unknown = undefined;
  if (requestBody?.content) {
    const jsonContent = requestBody.content["application/json"];
    if (jsonContent?.schema) {
      requestSchema = {
        required: requestBody.required,
        description: requestBody.description,
        schema: resolveRefs(jsonContent.schema, schemas),
      };
    }
  }

  // Extract response schemas
  const rawResponses = operation.responses as Record<string, {
    description?: string;
    content?: Record<string, { schema?: unknown }>;
  }> | undefined;
  let responses: Record<string, unknown> | undefined;
  if (rawResponses) {
    responses = {};
    for (const [status, resp] of Object.entries(rawResponses)) {
      // By default, only include success responses (2xx)
      if (!options?.includeErrors && !status.startsWith("2")) continue;
      const jsonContent = resp.content?.["application/json"];
      responses[status] = {
        description: resp.description,
        schema: jsonContent?.schema
          ? resolveRefs(jsonContent.schema, schemas)
          : undefined,
      };
    }
  }

  return {
    service,
    method: method.toUpperCase(),
    path,
    summary: operation.summary,
    description: operation.description,
    parameters: parameters && parameters.length > 0 ? parameters : undefined,
    requestBody: requestSchema,
    responses,
  };
}

// Shared types for spec parsing
interface ParsedSpec {
  info?: { title?: string; description?: string };
  paths?: Record<string, Record<string, {
    summary?: string;
    description?: string;
    requestBody?: {
      content?: {
        "application/json"?: {
          schema?: { properties?: Record<string, unknown> };
        };
      };
    };
    responses?: Record<string, {
      content?: {
        "application/json"?: {
          schema?: {
            properties?: Record<string, unknown>;
            $ref?: string;
          };
        };
      };
    }>;
  }>>;
  components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
}

function extractEndpointsFromSpec(
  serviceName: string,
  spec: ParsedSpec
): IndexedEndpoint[] {
  const schemas = spec.components?.schemas || {};
  const endpoints: IndexedEndpoint[] = [];

  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [method, details] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;

      const bodyProps = details.requestBody?.content?.["application/json"]?.schema?.properties
        ? Object.keys(details.requestBody.content["application/json"].schema.properties)
        : undefined;

      // Extract response field names from 200/201
      let responseFieldNames: string[] | undefined;
      const successResp = details.responses?.["200"] || details.responses?.["201"];
      if (successResp) {
        const respSchema = successResp.content?.["application/json"]?.schema;
        if (respSchema) {
          if (respSchema.properties) {
            responseFieldNames = Object.keys(respSchema.properties);
          } else if (respSchema.$ref) {
            const refName = respSchema.$ref.replace("#/components/schemas/", "");
            const resolved = schemas[refName];
            if (resolved?.properties) {
              responseFieldNames = Object.keys(resolved.properties);
            }
          }
        }
      }

      endpoints.push({
        service: serviceName,
        method: method.toUpperCase(),
        path,
        summary: details.summary || details.description || "",
        bodyFields: bodyProps?.length ? bodyProps : undefined,
        responseFields: responseFieldNames?.length ? responseFieldNames : undefined,
        pathGroup: derivePathGroup(path),
      });
    }
  }

  return endpoints;
}

// Search index with TTL cache
const SEARCH_INDEX_TTL_MS = 60_000; // 1 minute
let searchIndex: EndpointSearchIndex | null = null;
let searchIndexBuiltAt = 0;

async function getOrBuildSearchIndex(registry: ServiceRegistry): Promise<EndpointSearchIndex> {
  const now = Date.now();
  if (searchIndex && now - searchIndexBuiltAt < SEARCH_INDEX_TTL_MS) {
    return searchIndex;
  }

  const idx = new EndpointSearchIndex();
  const services = registry.getServices();

  await Promise.all(
    Object.entries(services).map(async ([name, { baseUrl }]) => {
      const result = await registry.fetchSpec(baseUrl);
      if (result.error || !result.spec) return;
      const endpoints = extractEndpointsFromSpec(name, result.spec as ParsedSpec);
      idx.addEndpoints(endpoints);
    })
  );

  searchIndex = idx;
  searchIndexBuiltAt = now;
  return idx;
}

// Group endpoints by pathGroup for better navigation
function groupEndpoints(
  endpoints: Array<{ method: string; path: string; summary: string; pathGroup: string }>
): Record<string, Array<{ method: string; path: string; summary: string }>> {
  const groups: Record<string, Array<{ method: string; path: string; summary: string }>> = {};
  for (const ep of endpoints) {
    if (!groups[ep.pathGroup]) groups[ep.pathGroup] = [];
    groups[ep.pathGroup].push({
      method: ep.method,
      path: ep.path,
      summary: ep.summary,
    });
  }
  return groups;
}

interface SessionIdentity {
  orgId: string;
  userId: string;
}

export function registerMcpEndpoint(app: Express, registry: ServiceRegistry) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const sessionIdentities = new Map<string, SessionIdentity>();

  function createMcpServer(identity: SessionIdentity): McpServer {
    const server = new McpServer({
      name: "API Registry",
      version: "1.0.0",
    });

    // Tool: list all registered services
    server.tool(
      "list_services",
      "List all registered API services. START HERE to discover available services, then use list_service_endpoints to explore a specific service's endpoints.",
      {},
      async () => {
        const services = registry.getServices();
        const list = Object.entries(services).map(([name, { baseUrl }]) => ({
          name,
          baseUrl,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
        };
      }
    );

    // Tool: list endpoints for a specific service (progressive disclosure)
    server.tool(
      "list_service_endpoints",
      "List endpoints for a service. Supports filtering by method, path prefix, or path group. For large services (50+ endpoints), returns grouped by path prefix for easier navigation. Use get_endpoint_details for full schemas.",
      {
        service: z.string().describe("Service name from list_services (e.g. 'campaign')"),
        method: z.string().optional().describe("Filter by HTTP method (e.g. 'POST')"),
        pathPrefix: z.string().optional().describe("Filter by path prefix (e.g. '/v1/campaigns')"),
        group: z.string().optional().describe("Filter by path group (e.g. 'campaigns', 'brands'). Groups are derived from the first meaningful path segment."),
      },
      async ({ service, method, pathPrefix, group }) => {
        const services = registry.getServices();
        const entry = services[service];
        if (!entry) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: `Service "${service}" not found`,
                available: Object.keys(services),
              }),
            }],
          };
        }

        const result = await registry.fetchSpec(entry.baseUrl);
        if (result.error || !result.spec) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: result.error || "Failed to fetch spec" }),
            }],
          };
        }

        const spec = result.spec as ParsedSpec;
        let endpoints = extractEndpointsFromSpec(service, spec);

        // Apply filters
        if (method) {
          endpoints = endpoints.filter(ep => ep.method === method.toUpperCase());
        }
        if (pathPrefix) {
          endpoints = endpoints.filter(ep => ep.path.startsWith(pathPrefix));
        }
        if (group) {
          endpoints = endpoints.filter(ep => ep.pathGroup === group.toLowerCase());
        }

        // For large unfiltered result sets, return grouped format
        const isFiltered = !!(method || pathPrefix || group);
        const useGrouped = !isFiltered && endpoints.length > 30;

        if (useGrouped) {
          const groups = groupEndpoints(endpoints);
          const groupSummary = Object.entries(groups).map(([name, eps]) => ({
            group: name,
            endpointCount: eps.length,
            endpoints: eps,
          }));

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                service,
                title: spec.info?.title,
                description: spec.info?.description,
                totalEndpoints: endpoints.length,
                groupCount: groupSummary.length,
                groups: groupSummary,
                _hint: "Filter by group name: list_service_endpoints(service, group='campaigns'). Use get_endpoint_details(service, method, path) for full schemas.",
              }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              service,
              title: spec.info?.title,
              description: spec.info?.description,
              endpointCount: endpoints.length,
              endpoints: endpoints.map(ep => ({
                method: ep.method,
                path: ep.path,
                summary: ep.summary,
              })),
              _hint: "Use get_endpoint_details(service, method, path) for full request/response schemas.",
            }, null, 2),
          }],
        };
      }
    );

    // Tool: get a lightweight overview of all services (LLM-optimized)
    server.tool(
      "get_all_endpoints",
      "Get a lightweight overview of ALL services: name, description, and endpoint count. Use list_service_endpoints to drill into a specific service.",
      {},
      async () => {
        const services = registry.getServices();
        const summaries = await Promise.all(
          Object.entries(services).map(async ([name, { baseUrl }]) => {
            const result = await registry.fetchSpec(baseUrl);
            if (result.error || !result.spec) {
              return { service: name, error: result.error, endpointCount: 0 };
            }

            const spec = result.spec as ParsedSpec;
            const endpoints = extractEndpointsFromSpec(name, spec);

            return {
              service: name,
              title: spec.info?.title,
              description: spec.info?.description,
              endpointCount: endpoints.length,
            };
          })
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              _workflow: "1. get_all_endpoints (you are here) → 2. list_service_endpoints(service) → 3. get_endpoint_details(service, method, path) → 4. call_api(service, method, path, body)",
              serviceCount: summaries.length,
              services: summaries,
            }, null, 2),
          }],
        };
      }
    );

    // Tool: search for endpoints matching a query (MiniSearch-powered)
    server.tool(
      "search_endpoints",
      "Search for API endpoints across all services using ranked full-text search. Supports fuzzy matching and prefix search. Filter by service, method, or path prefix. Returns top results ranked by relevance.",
      {
        query: z.string().describe("Search query (e.g. 'send email', 'brand extract', 'campaign stats')"),
        service: z.string().optional().describe("Filter results to a specific service (e.g. 'campaign')"),
        method: z.string().optional().describe("Filter by HTTP method (e.g. 'POST')"),
        pathPrefix: z.string().optional().describe("Filter by path prefix (e.g. '/v1/')"),
        limit: z.number().optional().describe("Max results to return (default: 15, max: 50)"),
      },
      async ({ query, service, method, pathPrefix, limit }) => {
        const idx = await getOrBuildSearchIndex(registry);
        const maxLimit = Math.min(limit || 15, 50);

        const results = idx.search({
          query,
          service,
          method,
          pathPrefix,
          limit: maxLimit,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              query,
              resultCount: results.length,
              indexSize: idx.size,
              results: results.map(r => ({
                service: r.service,
                method: r.method,
                path: r.path,
                summary: r.summary,
                score: r.score,
                ...(r.bodyFields?.length ? { bodyFields: r.bodyFields } : {}),
                ...(r.responseFields?.length ? { responseFields: r.responseFields } : {}),
              })),
              _hint: "Use get_endpoint_details(service, method, path) for full request/response schemas.",
            }, null, 2),
          }],
        };
      }
    );

    // Tool: get detailed schema for a specific endpoint
    server.tool(
      "get_endpoint_details",
      "Get the full request AND response schema for a specific endpoint, with all $refs resolved. By default returns only success (2xx) responses. Set includeErrors=true for error schemas too.",
      {
        service: z.string().describe("Service name (e.g. 'api')"),
        method: z.string().describe("HTTP method (e.g. 'POST')"),
        path: z.string().describe("Endpoint path (e.g. '/v1/brand/scrape')"),
        includeErrors: z.boolean().optional().describe("Include error response schemas (4xx, 5xx). Default: false"),
      },
      async ({ service, method, path, includeErrors }) => {
        const details = await getEndpointDetails(registry, service, method, path, { includeErrors });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(details, null, 2),
          }],
        };
      }
    );

    // Tool: call an API endpoint directly
    server.tool(
      "call_api",
      "Call an API endpoint on a registered service. API keys and identity headers are injected automatically. Use get_endpoint_details first to understand the request/response format.",
      {
        service: z.string().describe("Service name (e.g. 'api')"),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method"),
        path: z.string().describe("Endpoint path (e.g. '/v1/campaigns')"),
        body: z.record(z.string(), z.unknown()).optional().describe("Request body (for POST/PUT/PATCH)"),
        headers: z.record(z.string(), z.string()).optional().describe("Additional headers to send"),
      },
      async ({ service, method, path, body, headers: extraHeaders }) => {
        const services = registry.getServices();
        const entry = services[service];
        if (!entry) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: `Service "${service}" not found`,
                available: Object.keys(services),
              }),
            }],
          };
        }

        try {
          const url = `${entry.baseUrl}${path}`;
          const fetchHeaders: Record<string, string> = {
            "Content-Type": "application/json",
            ...extraHeaders,
          };

          // Forward identity headers (force-overwrite to prevent spoofing)
          fetchHeaders["x-org-id"] = identity.orgId;
          fetchHeaders["x-user-id"] = identity.userId;

          // Inject API key if available (force-overwrite any caller-provided key)
          if (entry.apiKey) {
            fetchHeaders["x-api-key"] = entry.apiKey;
          }

          const response = await fetch(url, {
            method,
            headers: fetchHeaders,
            body: body && ["POST", "PUT", "PATCH"].includes(method) ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(30_000),
          });

          const responseBody = await response.text();
          let parsed: unknown;
          try {
            parsed = JSON.parse(responseBody);
          } catch {
            parsed = responseBody;
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: response.status,
                ok: response.ok,
                data: parsed,
              }, null, 2),
            }],
          };
        } catch (err: unknown) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: err instanceof Error ? err.message : "Request failed",
              }),
            }],
          };
        }
      }
    );

    return server;
  }

  // MCP endpoint - POST for JSON-RPC requests
  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId) {
        // Client provided a session ID — look it up
        const transport = sessions.get(sessionId);
        if (!transport) {
          // Session expired or server restarted — tell client to re-initialize
          return res.status(404).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found. Re-initialize." },
            id: null,
          });
        }
        res.setHeader("mcp-session-id", sessionId);
        await transport.handleRequest(req, res, req.body);
      } else {
        // No session ID — create a new session (expects initialize request)
        const newSessionId = crypto.randomUUID();
        const sessionIdentity: SessionIdentity = {
          orgId: (req.headers["x-org-id"] as string) || "",
          userId: (req.headers["x-user-id"] as string) || "",
        };
        const mcpServer = createMcpServer(sessionIdentity);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
          },
        });

        sessions.set(newSessionId, transport);
        sessionIdentities.set(newSessionId, sessionIdentity);
        await mcpServer.connect(transport);

        res.setHeader("mcp-session-id", newSessionId);
        await transport.handleRequest(req, res, req.body);
      }
    } catch (error) {
      console.error("MCP request error:", error);
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal error",
        },
        id: null,
      });
    }
  });

  // MCP endpoint - GET for SSE
  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Missing mcp-session-id header" },
        id: null,
      });
    }
    const transport = sessions.get(sessionId);
    if (!transport) {
      return res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Session not found" },
        id: null,
      });
    }
    await transport.handleRequest(req, res);
  });

  // MCP endpoint - DELETE to close session
  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId);
      if (transport) await transport.close();
      sessions.delete(sessionId);
      sessionIdentities.delete(sessionId);
    }
    res.status(200).json({ success: true });
  });
}

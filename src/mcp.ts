import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Express, Request, Response } from "express";
import { z } from "zod";

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
  path: string
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

export function registerMcpEndpoint(app: Express, registry: ServiceRegistry) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  function createMcpServer(): McpServer {
    const server = new McpServer({
      name: "API Registry",
      version: "1.0.0",
    });

    // Tool: list all registered services
    server.tool(
      "list_services",
      "List all registered API services with their base URLs",
      {},
      async () => {
        const services = registry.getServices();
        const list = Object.entries(services).map(([name, { baseUrl }]) => ({
          name,
          baseUrl,
          openapiUrl: `${baseUrl}/openapi.json`,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
        };
      }
    );

    // Tool: get OpenAPI spec for a specific service
    server.tool(
      "get_service_spec",
      "Get the full OpenAPI specification for a specific service",
      {
        service: z.string().describe("Service name (e.g. 'api-service', 'campaign-service')"),
      },
      async ({ service }) => {
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
        if (result.error) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: result.error }),
            }],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result.spec, null, 2) }],
        };
      }
    );

    // Tool: get a compact summary of all services and endpoints (LLM-optimized)
    server.tool(
      "get_all_endpoints",
      "Get a compact LLM-friendly summary of all services and their endpoints. Use this to discover what APIs are available before calling them.",
      {},
      async () => {
        const services = registry.getServices();
        const summaries = await Promise.all(
          Object.entries(services).map(async ([name, { baseUrl }]) => {
            const result = await registry.fetchSpec(baseUrl);
            if (result.error || !result.spec) {
              return { service: name, baseUrl, error: result.error, endpoints: [] };
            }

            const spec = result.spec as {
              info?: { title?: string; description?: string };
              paths?: Record<string, Record<string, {
                summary?: string;
                description?: string;
                parameters?: Array<{
                  name: string;
                  in: string;
                  required?: boolean;
                  schema?: { type?: string };
                }>;
                requestBody?: {
                  content?: {
                    "application/json"?: {
                      schema?: { properties?: Record<string, unknown> };
                    };
                  };
                };
              }>>;
            };

            const endpoints = Object.entries(spec.paths || {}).flatMap(
              ([path, methods]) =>
                Object.entries(methods)
                  .filter(([method]) =>
                    ["get", "post", "put", "patch", "delete"].includes(method)
                  )
                  .map(([method, details]) => {
                    const params = (details.parameters || [])
                      .filter((p) => p.in !== "header")
                      .map((p) => ({
                        name: p.name,
                        in: p.in,
                        required: p.required || false,
                        type: p.schema?.type,
                      }));

                    const bodyProps = details.requestBody?.content?.[
                      "application/json"
                    ]?.schema?.properties
                      ? Object.keys(
                          details.requestBody.content["application/json"].schema.properties
                        )
                      : [];

                    return {
                      method: method.toUpperCase(),
                      path,
                      summary: details.summary || details.description || "",
                      params: params.length > 0 ? params : undefined,
                      bodyFields: bodyProps.length > 0 ? bodyProps : undefined,
                    };
                  })
            );

            return {
              service: name,
              baseUrl,
              title: spec.info?.title,
              description: spec.info?.description,
              endpoints,
            };
          })
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              _usage: "To call an endpoint, use the call_api tool with the service name, method, path, and optional body/headers. API keys are injected automatically.",
              services: summaries,
            }, null, 2),
          }],
        };
      }
    );

    // Tool: search for endpoints matching a keyword
    server.tool(
      "search_endpoints",
      "Search for API endpoints across all services matching a keyword (searches path, summary, and body fields)",
      {
        query: z.string().describe("Keyword to search for (e.g. 'campaign', 'email', 'brand')"),
      },
      async ({ query }) => {
        const services = registry.getServices();
        const q = query.toLowerCase();
        const matches: Array<{
          service: string;
          baseUrl: string;
          method: string;
          path: string;
          summary: string;
          bodyFields?: string[];
        }> = [];

        await Promise.all(
          Object.entries(services).map(async ([name, { baseUrl }]) => {
            const result = await registry.fetchSpec(baseUrl);
            if (result.error || !result.spec) return;

            const spec = result.spec as {
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
              }>>;
            };

            for (const [path, methods] of Object.entries(spec.paths || {})) {
              for (const [method, details] of Object.entries(methods)) {
                if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;

                const summary = details.summary || details.description || "";
                const bodyProps = details.requestBody?.content?.["application/json"]?.schema?.properties
                  ? Object.keys(details.requestBody.content["application/json"].schema.properties)
                  : [];

                const searchText = `${path} ${summary} ${bodyProps.join(" ")}`.toLowerCase();
                if (searchText.includes(q)) {
                  matches.push({
                    service: name,
                    baseUrl,
                    method: method.toUpperCase(),
                    path,
                    summary,
                    bodyFields: bodyProps.length > 0 ? bodyProps : undefined,
                  });
                }
              }
            }
          })
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              query,
              matchCount: matches.length,
              matches,
            }, null, 2),
          }],
        };
      }
    );

    // Tool: get detailed schema for a specific endpoint
    server.tool(
      "get_endpoint_details",
      "Get the full request/response schema for a specific endpoint. Use search_endpoints first to find the service, method, and path.",
      {
        service: z.string().describe("Service name (e.g. 'api-service')"),
        method: z.string().describe("HTTP method (e.g. 'POST')"),
        path: z.string().describe("Endpoint path (e.g. '/v1/brand/scrape')"),
      },
      async ({ service, method, path }) => {
        const details = await getEndpointDetails(registry, service, method, path);
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
      "Call an API endpoint on a registered service. Use get_all_endpoints first to discover available endpoints.",
      {
        service: z.string().describe("Service name (e.g. 'api-service')"),
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
        const mcpServer = createMcpServer();

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
          },
        });

        sessions.set(newSessionId, transport);
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
    }
    res.status(200).json({ success: true });
  });
}

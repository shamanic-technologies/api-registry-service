import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Express, Request, Response } from "express";
import { z } from "zod";

interface ServiceRegistry {
  getServices(): Record<string, string>;
  fetchSpec(url: string): Promise<{ spec: unknown; error?: string }>;
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
        const list = Object.entries(services).map(([name, url]) => ({
          name,
          baseUrl: url,
          openapiUrl: `${url}/openapi.json`,
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
        const url = services[service];
        if (!url) {
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
        const result = await registry.fetchSpec(url);
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
          Object.entries(services).map(async ([name, url]) => {
            const result = await registry.fetchSpec(url);
            if (result.error || !result.spec) {
              return { service: name, baseUrl: url, error: result.error, endpoints: [] };
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
              baseUrl: url,
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
              _usage: "To call an endpoint: send HTTP request to {baseUrl}{path} with the documented method, params, and body fields.",
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
          Object.entries(services).map(async ([name, url]) => {
            const result = await registry.fetchSpec(url);
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
                    baseUrl: url,
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
        const baseUrl = services[service];
        if (!baseUrl) {
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
          const url = `${baseUrl}${path}`;
          const fetchHeaders: Record<string, string> = {
            "Content-Type": "application/json",
            ...extraHeaders,
          };

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
      let sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? sessions.get(sessionId) : undefined;

      if (!transport) {
        sessionId = crypto.randomUUID();
        const mcpServer = createMcpServer();

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId!,
          onsessioninitialized: (id) => {
            sessions.set(id, transport!);
          },
        });

        sessions.set(sessionId, transport);
        await mcpServer.connect(transport);
      }

      res.setHeader("mcp-session-id", sessionId!);
      await transport.handleRequest(req, res, req.body);
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

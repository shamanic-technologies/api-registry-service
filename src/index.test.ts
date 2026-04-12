import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

// Set env vars BEFORE importing app (loadServices runs on import)
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("API_REGISTRY_SERVICE_API_KEY", "test-registry-key");
vi.stubEnv("CAMPAIGN_SERVICE_URL", "https://campaign.example.com");
vi.stubEnv("CAMPAIGN_SERVICE_API_KEY", "secret-campaign-key");
vi.stubEnv("RUNS_SERVICE_URL", "https://runs.example.com");
// RUNS_SERVICE_API_KEY intentionally NOT set — tests no-key scenario

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Dynamic import after env setup (auth.ts reads API_KEY at module load time)
const { default: app } = await import("./index.js");
const { resolveRefs, getEndpointDetails } = await import("./mcp.js");
const { cleanHeader } = await import("./auth.js");

const AUTH_HEADER = {
  "x-api-key": "test-registry-key",
  "x-org-id": "test-org-uuid",
  "x-user-id": "test-user-uuid",
};

describe("GET /health", () => {
  it("returns health status without auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.registeredServices).toBeGreaterThanOrEqual(2);
  });
});

describe("GET /services", () => {
  it("returns 401 without API key", async () => {
    const res = await request(app).get("/services");
    expect(res.status).toBe(401);
  });

  it("works without identity headers (read-only discovery)", async () => {
    const res = await request(app)
      .get("/services")
      .set({ "x-api-key": "test-registry-key" });
    expect(res.status).toBe(200);
    expect(res.body.services).toBeInstanceOf(Array);
  });

  it("lists services without exposing API keys", async () => {
    const res = await request(app).get("/services").set(AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.services).toBeInstanceOf(Array);
    expect(res.body.services.length).toBeGreaterThanOrEqual(2);

    const campaign = res.body.services.find(
      (s: { name: string }) => s.name === "campaign"
    );
    expect(campaign).toBeDefined();
    expect(campaign.baseUrl).toBe("https://campaign.example.com");
    expect(campaign.openapiUrl).toBe(
      "https://campaign.example.com/openapi.json"
    );

    // API keys must NEVER appear in the response
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("secret-campaign-key");
    expect(json).not.toContain("apiKey");
  });
});

describe("read-only endpoints without identity headers", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const API_KEY_ONLY = { "x-api-key": "test-registry-key" };

  it("GET /openapi/:service works without identity headers", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ openapi: "3.0.0" }),
    });

    const res = await request(app)
      .get("/openapi/campaign")
      .set(API_KEY_ONLY);
    expect(res.status).toBe(200);
  });

  it("GET /search works without identity headers", async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        openapi: "3.0.0",
        paths: {
          "/campaigns": {
            get: { summary: "List campaigns" },
          },
        },
      }),
    });

    const res = await request(app)
      .get("/search?q=campaign")
      .set(API_KEY_ONLY);
    expect(res.status).toBe(200);
    expect(res.body.results).toBeInstanceOf(Array);
  });

  it("GET /llm-context works without identity headers", async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ openapi: "3.0.0", info: { title: "Test" }, paths: { "/health": { get: { summary: "Health" } } } }),
    });

    const res = await request(app)
      .get("/llm-context")
      .set(API_KEY_ONLY);
    expect(res.status).toBe(200);
    expect(res.body.services).toBeInstanceOf(Array);
    // Should be lightweight overview — no endpoints array, just endpointCount
    expect(res.body.serviceCount).toBeGreaterThanOrEqual(2);
    for (const svc of res.body.services) {
      expect(svc).toHaveProperty("endpointCount");
      expect(svc).not.toHaveProperty("endpoints");
    }
  });

  it("GET /llm-context/:service works without identity headers", async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        openapi: "3.0.0",
        info: { title: "Campaign Service", description: "Manages campaigns" },
        paths: {
          "/v1/campaigns": {
            get: { summary: "List campaigns" },
            post: { summary: "Create campaign" },
          },
        },
      }),
    });

    const res = await request(app)
      .get("/llm-context/campaign")
      .set(API_KEY_ONLY);
    expect(res.status).toBe(200);
    expect(res.body.service).toBe("campaign");
    expect(res.body.title).toBe("Campaign Service");
    expect(res.body.endpointCount).toBe(2);
    expect(res.body.endpoints).toHaveLength(2);
    expect(res.body.endpoints[0]).toHaveProperty("method");
    expect(res.body.endpoints[0]).toHaveProperty("path");
    expect(res.body.endpoints[0]).toHaveProperty("summary");
  });

  it("GET /llm-context/:service returns 404 for unknown service", async () => {
    const res = await request(app)
      .get("/llm-context/nonexistent")
      .set(API_KEY_ONLY);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("nonexistent");
    expect(res.body.available).toBeInstanceOf(Array);
  });

  it("POST /call/:service still requires identity headers", async () => {
    const res = await request(app)
      .post("/call/campaign")
      .set(API_KEY_ONLY)
      .send({ method: "GET", path: "/health" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });
});

describe("POST /call/:service", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/call/campaign")
      .send({ method: "GET", path: "/health" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown service", async () => {
    const res = await request(app)
      .post("/call/nonexistent")
      .set(AUTH_HEADER)
      .send({ method: "GET", path: "/health" });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("nonexistent");
    expect(res.body.available).toBeInstanceOf(Array);
  });

  it("returns 400 for missing method/path", async () => {
    const res = await request(app)
      .post("/call/campaign")
      .set(AUTH_HEADER)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("method");
  });

  it("returns 400 for invalid method", async () => {
    const res = await request(app)
      .post("/call/campaign")
      .set(AUTH_HEADER)
      .send({ method: "TRACE", path: "/health" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("TRACE");
  });

  it("returns 400 for path not starting with /", async () => {
    const res = await request(app)
      .post("/call/campaign")
      .set(AUTH_HEADER)
      .send({ method: "GET", path: "health" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Path must start with /");
  });

  it("proxies GET request with auto API key injection", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ status: "ok" }),
    });

    const res = await request(app)
      .post("/call/campaign")
      .set(AUTH_HEADER)
      .send({ method: "GET", path: "/health" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 200,
      ok: true,
      data: { status: "ok" },
    });

    // Verify fetch was called with the right URL and API key
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://campaign.example.com/health");
    expect(opts.method).toBe("GET");
    expect(opts.headers["x-api-key"]).toBe("secret-campaign-key");
  });

  it("proxies POST request with body", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 201,
      ok: true,
      text: async () => JSON.stringify({ id: "123" }),
    });

    const res = await request(app)
      .post("/call/campaign")
      .set(AUTH_HEADER)
      .send({
        method: "POST",
        path: "/v1/campaigns",
        body: { name: "Test Campaign" },
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(201);
    expect(res.body.data).toEqual({ id: "123" });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ name: "Test Campaign" });
    expect(opts.headers["x-api-key"]).toBe("secret-campaign-key");
  });

  it("force-overwrites caller-provided x-api-key", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => "{}",
    });

    await request(app)
      .post("/call/campaign")
      .set(AUTH_HEADER)
      .send({
        method: "GET",
        path: "/health",
        headers: { "x-api-key": "attacker-key" },
      });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-api-key"]).toBe("secret-campaign-key");
    expect(opts.headers["x-api-key"]).not.toBe("attacker-key");
  });

  it("works without API key for services that have none", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ ok: true }),
    });

    const res = await request(app)
      .post("/call/runs")
      .set(AUTH_HEADER)
      .send({ method: "GET", path: "/health" });

    expect(res.status).toBe(200);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://runs.example.com/health");
    // No x-api-key header should be set for services without a key
    expect(opts.headers["x-api-key"]).toBeUndefined();
  });

  it("returns 502 when downstream fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

    const res = await request(app)
      .post("/call/campaign")
      .set(AUTH_HEADER)
      .send({ method: "GET", path: "/health" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Connection refused");
  });

  it("returns downstream error status correctly", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 403,
      ok: false,
      text: async () => JSON.stringify({ error: "Forbidden" }),
    });

    const res = await request(app)
      .post("/call/campaign")
      .set(AUTH_HEADER)
      .send({ method: "GET", path: "/admin" });

    expect(res.status).toBe(200); // proxy always returns 200
    expect(res.body.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.data).toEqual({ error: "Forbidden" });
  });

  it("forwards extra headers alongside injected API key", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => "{}",
    });

    await request(app)
      .post("/call/campaign")
      .set(AUTH_HEADER)
      .send({
        method: "GET",
        path: "/health",
        headers: { "X-Custom": "value123" },
      });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["X-Custom"]).toBe("value123");
    expect(opts.headers["x-api-key"]).toBe("secret-campaign-key");
  });

  it("forwards x-org-id and x-user-id to downstream service", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => "{}",
    });

    await request(app)
      .post("/call/campaign")
      .set(AUTH_HEADER)
      .send({ method: "GET", path: "/health" });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-org-id"]).toBe("test-org-uuid");
    expect(opts.headers["x-user-id"]).toBe("test-user-uuid");
  });

  it("force-overwrites caller-provided identity headers", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => "{}",
    });

    await request(app)
      .post("/call/campaign")
      .set(AUTH_HEADER)
      .send({
        method: "GET",
        path: "/health",
        headers: { "x-org-id": "spoofed-org", "x-user-id": "spoofed-user" },
      });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-org-id"]).toBe("test-org-uuid");
    expect(opts.headers["x-user-id"]).toBe("test-user-uuid");
  });

  it("forwards workflow tracking headers when present", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => "{}",
    });

    await request(app)
      .post("/call/campaign")
      .set({
        ...AUTH_HEADER,
        "x-campaign-id": "camp-123",
        "x-brand-id": "brand-456,brand-789",
        "x-workflow-slug": "outreach-v2",
        "x-feature-slug": "press-outreach",
      })
      .send({ method: "GET", path: "/health" });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-campaign-id"]).toBe("camp-123");
    expect(opts.headers["x-brand-id"]).toBe("brand-456,brand-789");
    expect(opts.headers["x-workflow-slug"]).toBe("outreach-v2");
    expect(opts.headers["x-feature-slug"]).toBe("press-outreach");
  });

  it("strips trailing commas from identity headers before forwarding", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => "{}",
    });

    await request(app)
      .post("/call/campaign")
      .set({
        "x-api-key": "test-registry-key",
        "x-org-id": "b645207b-d8e9-40b0-9391-072b777cd9a9,",
        "x-user-id": "user-uuid,",
      })
      .send({ method: "GET", path: "/health" });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-org-id"]).toBe("b645207b-d8e9-40b0-9391-072b777cd9a9");
    expect(opts.headers["x-user-id"]).toBe("user-uuid");
  });

  it("strips trailing commas from workflow tracking headers", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => "{}",
    });

    await request(app)
      .post("/call/campaign")
      .set({
        ...AUTH_HEADER,
        "x-campaign-id": "camp-123,",
        "x-brand-id": "brand-456,brand-789,",
      })
      .send({ method: "GET", path: "/health" });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-campaign-id"]).toBe("camp-123");
    expect(opts.headers["x-brand-id"]).toBe("brand-456,brand-789");
  });

  it("omits workflow tracking headers when not provided", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => "{}",
    });

    await request(app)
      .post("/call/campaign")
      .set(AUTH_HEADER)
      .send({ method: "GET", path: "/health" });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-campaign-id"]).toBeUndefined();
    expect(opts.headers["x-brand-id"]).toBeUndefined();
    expect(opts.headers["x-workflow-slug"]).toBeUndefined();
    expect(opts.headers["x-feature-slug"]).toBeUndefined();
  });

  it("handles non-JSON downstream responses", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => "plain text response",
    });

    const res = await request(app)
      .post("/call/campaign")
      .set(AUTH_HEADER)
      .send({ method: "GET", path: "/raw" });

    expect(res.status).toBe(200);
    expect(res.body.data).toBe("plain text response");
  });
});

describe("POST /mcp", () => {
  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", method: "initialize", id: 1 });
    expect(res.status).toBe(401);
  });

  it("returns 404 for stale session ID", async () => {
    const res = await request(app)
      .post("/mcp")
      .set({ ...AUTH_HEADER, "mcp-session-id": "nonexistent-session-id" })
      .send({
        jsonrpc: "2.0",
        method: "tools/list",
        id: 1,
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(-32001);
    expect(res.body.error.message).toContain("Session not found");
  });

  it("works without identity headers (x-org-id, x-user-id)", async () => {
    const res = await request(app)
      .post("/mcp")
      .set({
        "x-api-key": "test-registry-key",
        Accept: "application/json, text/event-stream",
      })
      .send({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
        id: 1,
      });
    // Should NOT return 400 for missing identity headers
    expect(res.status).not.toBe(400);
    // Should return 200 (SSE) with a valid MCP response
    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeDefined();
  });
});

describe("GET /mcp", () => {
  it("returns 400 without session ID header", async () => {
    const res = await request(app).get("/mcp").set(AUTH_HEADER);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("mcp-session-id");
  });

  it("returns 404 for unknown session ID", async () => {
    const res = await request(app)
      .get("/mcp")
      .set({ ...AUTH_HEADER, "mcp-session-id": "unknown-session" });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain("Session not found");
  });
});

describe("DELETE /mcp", () => {
  it("returns 200 even for unknown session", async () => {
    const res = await request(app)
      .delete("/mcp")
      .set({ ...AUTH_HEADER, "mcp-session-id": "nonexistent" });
    expect(res.status).toBe(200);
  });
});

describe("cleanHeader", () => {
  it("returns undefined for undefined input", () => {
    expect(cleanHeader(undefined)).toBeUndefined();
  });

  it("passes through clean values unchanged", () => {
    expect(cleanHeader("b645207b-d8e9-40b0-9391-072b777cd9a9")).toBe("b645207b-d8e9-40b0-9391-072b777cd9a9");
  });

  it("strips trailing comma", () => {
    expect(cleanHeader("b645207b-d8e9-40b0-9391-072b777cd9a9,")).toBe("b645207b-d8e9-40b0-9391-072b777cd9a9");
  });

  it("strips trailing comma and whitespace", () => {
    expect(cleanHeader("b645207b-d8e9-40b0-9391-072b777cd9a9, ")).toBe("b645207b-d8e9-40b0-9391-072b777cd9a9");
  });

  it("strips multiple trailing commas", () => {
    expect(cleanHeader("uuid,,")).toBe("uuid");
  });

  it("handles array input (duplicate headers)", () => {
    expect(cleanHeader(["uuid", ""])).toBe("uuid");
  });

  it("returns undefined for empty string", () => {
    expect(cleanHeader("")).toBeUndefined();
  });

  it("returns undefined for comma-only input", () => {
    expect(cleanHeader(",")).toBeUndefined();
  });

  it("preserves comma-separated brand IDs (no trailing comma)", () => {
    expect(cleanHeader("brand-1,brand-2")).toBe("brand-1,brand-2");
  });
});

describe("resolveRefs", () => {
  it("returns primitives as-is", () => {
    expect(resolveRefs("hello", {})).toBe("hello");
    expect(resolveRefs(42, {})).toBe(42);
    expect(resolveRefs(null, {})).toBe(null);
    expect(resolveRefs(undefined, {})).toBe(undefined);
  });

  it("resolves a simple $ref", () => {
    const schemas = {
      Foo: { type: "object", properties: { name: { type: "string" } } },
    };
    const input = { $ref: "#/components/schemas/Foo" };
    expect(resolveRefs(input, schemas)).toEqual(schemas.Foo);
  });

  it("resolves nested $ref in object properties", () => {
    const schemas = {
      Bar: { type: "string", enum: ["a", "b"] },
    };
    const input = {
      type: "object",
      properties: {
        status: { $ref: "#/components/schemas/Bar" },
        count: { type: "number" },
      },
    };
    expect(resolveRefs(input, schemas)).toEqual({
      type: "object",
      properties: {
        status: { type: "string", enum: ["a", "b"] },
        count: { type: "number" },
      },
    });
  });

  it("resolves $ref inside arrays", () => {
    const schemas = {
      Item: { type: "object", properties: { id: { type: "string" } } },
    };
    const input = {
      type: "array",
      items: { $ref: "#/components/schemas/Item" },
    };
    expect(resolveRefs(input, schemas)).toEqual({
      type: "array",
      items: { type: "object", properties: { id: { type: "string" } } },
    });
  });

  it("handles circular references", () => {
    const schemas: Record<string, unknown> = {
      Node: {
        type: "object",
        properties: {
          child: { $ref: "#/components/schemas/Node" },
        },
      },
    };
    const result = resolveRefs(
      { $ref: "#/components/schemas/Node" },
      schemas
    ) as Record<string, unknown>;
    const props = (result as { properties: Record<string, unknown> }).properties;
    expect(props.child).toEqual({ $ref: "circular:Node" });
  });

  it("leaves unknown $ref targets unchanged", () => {
    const input = { $ref: "#/components/schemas/Missing" };
    expect(resolveRefs(input, {})).toEqual(input);
  });

  it("leaves non-schema $ref unchanged", () => {
    const input = { $ref: "#/other/location" };
    expect(resolveRefs(input, {})).toEqual(input);
  });
});

describe("getEndpointDetails", () => {
  const MOCK_SPEC = {
    openapi: "3.0.0",
    info: { title: "Campaign Service", version: "1.0.0" },
    paths: {
      "/v1/campaigns": {
        get: {
          summary: "List campaigns",
          parameters: [
            { name: "limit", in: "query", required: false, schema: { type: "integer" } },
            { name: "x-api-key", in: "header", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Campaign list",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Campaign" },
                  },
                },
              },
            },
          },
        },
        post: {
          summary: "Create campaign",
          description: "Creates a new campaign",
          requestBody: {
            required: true,
            description: "Campaign data",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateCampaignRequest" },
              },
            },
          },
          responses: {
            "201": {
              description: "Campaign created",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Campaign" },
                },
              },
            },
            "400": {
              description: "Validation error",
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Campaign: {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            status: { $ref: "#/components/schemas/CampaignStatus" },
          },
        },
        CampaignStatus: {
          type: "string",
          enum: ["draft", "active", "paused"],
        },
        CreateCampaignRequest: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
          },
        },
      },
    },
  };

  function makeRegistry(spec?: unknown, fetchError?: string) {
    return {
      getServices: () => ({
        campaign: { baseUrl: "https://campaign.example.com", apiKey: "key" },
        runs: { baseUrl: "https://runs.example.com" },
      }),
      fetchSpec: async () => fetchError
        ? { spec: undefined, error: fetchError }
        : { spec: spec ?? MOCK_SPEC },
    };
  }

  it("returns error for unknown service", async () => {
    const result = await getEndpointDetails(
      makeRegistry(), "nonexistent", "GET", "/foo"
    );
    expect(result.error).toContain("nonexistent");
    expect(result.available).toContain("campaign");
  });

  it("returns error when spec fetch fails", async () => {
    const result = await getEndpointDetails(
      makeRegistry(undefined, "Connection refused"), "campaign", "GET", "/v1/campaigns"
    );
    expect(result.error).toBe("Connection refused");
  });

  it("returns error for unknown path with available paths", async () => {
    const result = await getEndpointDetails(
      makeRegistry(), "campaign", "GET", "/v1/unknown"
    );
    expect(result.error).toContain("/v1/unknown");
    expect(result.availablePaths).toContain("/v1/campaigns");
  });

  it("returns error for unknown method with available methods", async () => {
    const result = await getEndpointDetails(
      makeRegistry(), "campaign", "DELETE", "/v1/campaigns"
    );
    expect(result.error).toContain("DELETE");
    expect(result.availableMethods).toContain("GET");
    expect(result.availableMethods).toContain("POST");
  });

  it("returns only success responses by default (no includeErrors)", async () => {
    const result = await getEndpointDetails(
      makeRegistry(), "campaign", "POST", "/v1/campaigns"
    );

    expect(result.service).toBe("campaign");
    expect(result.method).toBe("POST");
    expect(result.path).toBe("/v1/campaigns");
    expect(result.summary).toBe("Create campaign");
    expect(result.description).toBe("Creates a new campaign");

    // Request body should be resolved (no $ref)
    const body = result.requestBody as { required: boolean; schema: { properties: Record<string, { type: string }> } };
    expect(body.required).toBe(true);
    expect(body.schema.properties.name.type).toBe("string");
    expect(body.schema.properties.description.type).toBe("string");

    // Only 2xx responses should be present
    const responses = result.responses as Record<string, {
      description: string;
      schema?: { properties: Record<string, unknown> };
    }>;
    expect(responses["201"]).toBeDefined();
    expect(responses["201"].description).toBe("Campaign created");
    expect(responses["201"].schema!.properties.id).toEqual({ type: "string" });
    // Nested $ref (CampaignStatus inside Campaign) should also be resolved
    expect(responses["201"].schema!.properties.status).toEqual({
      type: "string",
      enum: ["draft", "active", "paused"],
    });
    // 400 response should be EXCLUDED by default
    expect(responses["400"]).toBeUndefined();
  });

  it("includes error responses when includeErrors is true", async () => {
    const result = await getEndpointDetails(
      makeRegistry(), "campaign", "POST", "/v1/campaigns", { includeErrors: true }
    );

    const responses = result.responses as Record<string, { description: string }>;
    expect(responses["201"]).toBeDefined();
    expect(responses["400"]).toBeDefined();
    expect(responses["400"].description).toBe("Validation error");
  });

  it("filters out header parameters", async () => {
    const result = await getEndpointDetails(
      makeRegistry(), "campaign", "GET", "/v1/campaigns"
    );

    const params = result.parameters as Array<{ name: string; in: string }>;
    expect(params).toHaveLength(1);
    expect(params[0].name).toBe("limit");
    expect(params[0].in).toBe("query");
  });
});

const { EndpointSearchIndex, derivePathGroup } = await import("./search.js");

describe("EndpointSearchIndex", () => {

  describe("derivePathGroup", () => {
    it("extracts group from /v1/campaigns/{id}", () => {
      expect(derivePathGroup("/v1/campaigns/{id}")).toBe("campaigns");
    });

    it("extracts group from /brands/{brandId}/extract-fields", () => {
      expect(derivePathGroup("/brands/{brandId}/extract-fields")).toBe("brands");
    });

    it("handles /health", () => {
      expect(derivePathGroup("/health")).toBe("health");
    });

    it("handles root path", () => {
      expect(derivePathGroup("/")).toBe("root");
    });
  });

  describe("search", () => {
    let idx: InstanceType<typeof EndpointSearchIndex>;

    beforeAll(() => {
      idx = new EndpointSearchIndex();
      idx.addEndpoints([
        {
          service: "campaign",
          method: "GET",
          path: "/campaigns",
          summary: "List campaigns for org",
          pathGroup: "campaigns",
        },
        {
          service: "campaign",
          method: "POST",
          path: "/campaigns",
          summary: "Create a new campaign",
          bodyFields: ["name", "featureSlug", "brandIds"],
          pathGroup: "campaigns",
        },
        {
          service: "email-gateway",
          method: "POST",
          path: "/send",
          summary: "Send an email",
          bodyFields: ["to", "subject", "body", "campaignId"],
          pathGroup: "send",
        },
        {
          service: "brand",
          method: "POST",
          path: "/brands/extract-fields",
          summary: "Extract fields from brand via AI",
          bodyFields: ["fields", "key", "description"],
          pathGroup: "brands",
        },
        {
          service: "brand",
          method: "GET",
          path: "/brands/{id}",
          summary: "Get a single brand by ID",
          pathGroup: "brands",
        },
      ]);
    });

    it("finds endpoints by keyword", () => {
      const results = idx.search({ query: "campaign" });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].service).toBe("campaign");
    });

    it("ranks summary matches higher than body field matches", () => {
      const results = idx.search({ query: "brand extract" });
      expect(results[0].path).toBe("/brands/extract-fields");
    });

    it("filters by service", () => {
      const results = idx.search({ query: "send", service: "email-gateway" });
      expect(results.every(r => r.service === "email-gateway")).toBe(true);
    });

    it("filters by method", () => {
      const results = idx.search({ query: "brand", method: "GET" });
      expect(results.every(r => r.method === "GET")).toBe(true);
    });

    it("respects limit", () => {
      const results = idx.search({ query: "campaign", limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it("returns all results when limit is omitted", () => {
      const withLimit = idx.search({ query: "campaign", limit: 1 });
      const withoutLimit = idx.search({ query: "campaign" });
      expect(withoutLimit.length).toBeGreaterThan(withLimit.length);
    });

    it("supports fuzzy matching", () => {
      const results = idx.search({ query: "campain" }); // typo
      expect(results.length).toBeGreaterThan(0);
    });

    it("returns scores", () => {
      const results = idx.search({ query: "campaign" });
      for (const r of results) {
        expect(typeof r.score).toBe("number");
        expect(r.score).toBeGreaterThan(0);
      }
    });

    it("skips duplicate documents", () => {
      const idx2 = new EndpointSearchIndex();
      idx2.addEndpoint({
        service: "test",
        method: "GET",
        path: "/foo",
        summary: "Test",
        pathGroup: "foo",
      });
      idx2.addEndpoint({
        service: "test",
        method: "GET",
        path: "/foo",
        summary: "Test",
        pathGroup: "foo",
      });
      expect(idx2.size).toBe(1);
    });
  });
});

describe("GET /search", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const API_KEY_ONLY = { "x-api-key": "test-registry-key" };

  it("returns 400 without query parameter", async () => {
    const res = await request(app).get("/search").set(API_KEY_ONLY);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("q");
  });

  it("returns ranked results for a query", async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        openapi: "3.0.0",
        paths: {
          "/campaigns": {
            get: { summary: "List campaigns" },
            post: { summary: "Create campaign" },
          },
          "/health": {
            get: { summary: "Health check" },
          },
        },
      }),
    });

    const res = await request(app)
      .get("/search?q=campaign")
      .set(API_KEY_ONLY);
    expect(res.status).toBe(200);
    expect(res.body.query).toBe("campaign");
    expect(res.body.resultCount).toBeGreaterThan(0);
    expect(res.body.results[0]).toHaveProperty("score");
    expect(res.body.results[0]).toHaveProperty("service");
    expect(res.body.results[0]).toHaveProperty("method");
    expect(res.body.results[0]).toHaveProperty("path");
  });
});

describe("GET /llm-context/:service filters", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const API_KEY_ONLY = { "x-api-key": "test-registry-key" };
  const MOCK_SPEC = {
    openapi: "3.0.0",
    info: { title: "Test API", description: "Test" },
    paths: {
      "/v1/campaigns": {
        get: { summary: "List campaigns" },
        post: { summary: "Create campaign" },
      },
      "/v1/campaigns/{id}": {
        get: { summary: "Get campaign" },
      },
      "/v1/brands": {
        get: { summary: "List brands" },
      },
      "/health": {
        get: { summary: "Health check" },
      },
    },
  };

  it("filters by method", async () => {
    mockFetch.mockResolvedValue({
      status: 200, ok: true,
      json: async () => MOCK_SPEC,
    });

    const res = await request(app)
      .get("/llm-context/campaign?method=POST")
      .set(API_KEY_ONLY);
    expect(res.status).toBe(200);
    expect(res.body.endpoints.every((e: { method: string }) => e.method === "POST")).toBe(true);
  });

  it("filters by group", async () => {
    mockFetch.mockResolvedValue({
      status: 200, ok: true,
      json: async () => MOCK_SPEC,
    });

    const res = await request(app)
      .get("/llm-context/campaign?group=campaigns")
      .set(API_KEY_ONLY);
    expect(res.status).toBe(200);
    expect(res.body.endpoints.length).toBe(3);
    expect(res.body.endpoints.every((e: { path: string }) => e.path.includes("campaign"))).toBe(true);
  });

  it("filters by pathPrefix", async () => {
    mockFetch.mockResolvedValue({
      status: 200, ok: true,
      json: async () => MOCK_SPEC,
    });

    const res = await request(app)
      .get("/llm-context/campaign?pathPrefix=/v1/campaigns")
      .set(API_KEY_ONLY);
    expect(res.status).toBe(200);
    expect(res.body.endpoints.length).toBe(3);
  });
});

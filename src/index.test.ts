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

// Dynamic import after env setup
const { default: app } = await import("./index.js");

const AUTH_HEADER = { "x-api-key": "test-registry-key" };

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

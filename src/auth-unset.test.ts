import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// SSRF-1127: with no registry key configured, every route but /health and /openapi.json is refused.
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("API_REGISTRY_SERVICE_API_KEY", "");
vi.stubEnv("CAMPAIGN_SERVICE_URL", "https://campaign.example.com");
vi.stubEnv("CAMPAIGN_SERVICE_API_KEY", "secret-campaign-key");

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { default: app } = await import("./index.js");

describe("requireApiKey fails closed when API_REGISTRY_SERVICE_API_KEY is unset", () => {
  it.each([
    ["GET", "/services"],
    ["GET", "/openapi/campaign"],
    ["GET", "/discover/services"],
    ["POST", "/call/campaign"],
    ["POST", "/mcp"],
    ["GET", "/mcp"],
    ["DELETE", "/mcp"],
  ])("%s %s answers 503 even with a key", async (method, path) => {
    const req = method === "GET" ? request(app).get(path) : method === "POST" ? request(app).post(path) : request(app).delete(path);
    const res = await req.set({ "x-api-key": "anything", "x-org-id": "o", "x-user-id": "u" }).send({ method: "GET", path: "/health" });
    expect(res.status).toBe(503);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("keeps /health public", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});

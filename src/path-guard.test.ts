import { describe, it, expect } from "vitest";
import { assertSafeProxyPath, buildProxyUrl, sanitizeCallerHeaders, ProxyPathRefusedError } from "./path-guard.js";

const BASE = "http://campaign-service:8080";

describe("assertSafeProxyPath (SSRF-1127)", () => {
  it.each([
    "/v1/campaigns",
    "/v1/campaigns/abc-123",
    "/v1/campaigns?status=ongoing&q=50%25",
    "/orgs/audiences/1/preview?name=a%20b",
    "/v1/files/report.v2.json",
    "/v1/items/..foo",
  ])("accepts a normal route %s", (p) => {
    expect(assertSafeProxyPath(p)).toBe(p);
  });

  it.each([
    ["plain dot-dot", "/v1/../internal/keys"],
    ["trailing dot-dot", "/v1/campaigns/.."],
    ["single dot", "/v1/./campaigns"],
    ["percent-encoded dot-dot", "/v1/%2e%2e/internal"],
    ["uppercase encoded dot-dot", "/v1/%2E%2E/x"],
    ["mixed encoded dot", "/v1/.%2e/x"],
    ["encoded slash + dots", "/v1/..%2finternal"],
    ["double-encoded dot-dot", "/v1/%252e%252e/x"],
    ["double-encoded slash", "/v1/..%252fx"],
    ["triple-encoded", "/v1/%25252e%25252e/x"],
    ["backslash", "/v1\\..\\internal"],
    ["encoded backslash", "/v1/..%5cinternal"],
    ["double-encoded backslash", "/v1/%255c"],
    ["internal route", "/internal/keys"],
    ["internal route uppercase", "/INTERNAL/keys"],
    ["internal nested", "/v1/internal/keys"],
    ["encoded internal", "/%69nternal/keys"],
    ["admin route", "/admin/users"],
    ["staff route", "/v1/staff/requests"],
    ["platform route", "/internal/platform-complete"],
    ["platform-* segment", "/platform-keys/x"],
    ["protocol-relative", "//evil.example.com/x"],
    ["encoded protocol-relative", "/%2fevil.example.com/x"],
    ["userinfo", "/@127.0.0.1/x"],
    ["fragment", "/v1/x#frag"],
    ["no leading slash", "v1/campaigns"],
    ["absolute url", "http://127.0.0.1:2019/config/"],
    ["null byte", "/v1/x%00"],
    ["newline injection", "/v1/x%0d%0aHost:%20key-service"],
    ["raw space", "/v1/x HTTP/1.1"],
    ["malformed escape", "/v1/%zz"],
  ])("refuses %s", (_label, p) => {
    expect(() => assertSafeProxyPath(p)).toThrow(ProxyPathRefusedError);
  });

  it("refuses non-strings", () => {
    expect(() => assertSafeProxyPath(undefined)).toThrow(ProxyPathRefusedError);
    expect(() => assertSafeProxyPath(42)).toThrow(ProxyPathRefusedError);
  });
});

describe("buildProxyUrl", () => {
  it("joins onto the service origin", () => {
    expect(buildProxyUrl(BASE, "/v1/campaigns?x=1")).toBe("http://campaign-service:8080/v1/campaigns?x=1");
    expect(buildProxyUrl(`${BASE}/`, "/v1/campaigns")).toBe("http://campaign-service:8080/v1/campaigns");
  });

  it.each([
    "/@127.0.0.1:2019/config/",
    "//key-service:8080/internal/keys",
    "/../../internal/keys",
  ])("never leaves the origin for %s", (p) => {
    expect(() => buildProxyUrl(BASE, p)).toThrow(ProxyPathRefusedError);
  });
});

describe("sanitizeCallerHeaders", () => {
  it("drops connection-steering headers, keeps the rest", () => {
    expect(sanitizeCallerHeaders({ Host: "key-service:8080", "x-run-id": "r1", "Content-Length": "9", Connection: "close" })).toEqual({ "x-run-id": "r1" });
    expect(sanitizeCallerHeaders(undefined)).toEqual({});
  });

  it("refuses non-string values", () => {
    expect(() => sanitizeCallerHeaders({ a: 1 })).toThrow(ProxyPathRefusedError);
    expect(() => sanitizeCallerHeaders("x")).toThrow(ProxyPathRefusedError);
  });
});

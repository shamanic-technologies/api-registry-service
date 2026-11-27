/**
 * Guard for the proxy surfaces (`POST /call/:service`, MCP `call_api`) (SSRF-1127).
 *
 * Both join a CALLER-chosen path onto a registered service base URL and inject that
 * service's own API key. chat-service relays customer-chosen paths here (Copilot
 * `test_endpoint`, Outcome reads), so the path is untrusted input:
 * - no dot segment in any spelling (decoded, percent-encoded, double-encoded, backslash),
 *   so a path can never climb out of the route it names;
 * - no `/internal`, `/admin`, `/staff`, `/platform-*` route: those trust the service key
 *   we inject, never the caller;
 * - the final URL keeps the service's own origin (no `//host`, no `@`, no scheme).
 * Caller headers that steer the connection (`host`, hop-by-hop, length) are dropped.
 */

export class ProxyPathRefusedError extends Error {
  readonly code = "proxy_path_refused";
  constructor(message: string) {
    super(message);
    this.name = "ProxyPathRefusedError";
  }
}

const FORBIDDEN_SEGMENT = /^(internal|admin|staff|platform-[a-z0-9-]*)$/i;
const MAX_DECODE_ROUNDS = 5;

/** Percent-decodes until stable; a malformed escape is a refusal, never a pass-through. */
function fullyDecode(path: string): string {
  let current = path;
  for (let i = 0; i < MAX_DECODE_ROUNDS; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      throw new ProxyPathRefusedError(`path has a malformed percent-escape: ${path}`);
    }
    if (next === current) return current;
    current = next;
  }
  throw new ProxyPathRefusedError(`path is encoded too many times: ${path}`);
}

/**
 * Returns the path unchanged when it is safe to append to a service base URL,
 * throws ProxyPathRefusedError otherwise.
 */
export function assertSafeProxyPath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0) throw new ProxyPathRefusedError("path must be a non-empty string");
  if (path.length > 4096) throw new ProxyPathRefusedError("path is longer than 4096 characters");
  if (!path.startsWith("/")) throw new ProxyPathRefusedError("Path must start with /");
  if (path.startsWith("//")) throw new ProxyPathRefusedError(`path must not start with //: ${path}`);
  if (path.includes("#")) throw new ProxyPathRefusedError(`path must not carry a fragment: ${path}`);

  // The route part (before `?`) is decoded until stable and checked; the query string is the
  // service's business (a value may legitimately carry `%25`), only raw control chars are refused there.
  if (/[\x00-\x20\x7f]/.test(path)) throw new ProxyPathRefusedError(`path must not contain spaces or control characters: ${path}`);
  const rawRoute = path.split("?")[0]!;
  const route = fullyDecode(rawRoute);
  if (/[\x00-\x1f\x7f\\]/.test(route)) throw new ProxyPathRefusedError(`path must not contain control characters or backslashes: ${path}`);
  if (route.includes("@")) throw new ProxyPathRefusedError(`path must not contain @: ${path}`);
  if (route.startsWith("//")) throw new ProxyPathRefusedError(`path must not start with //: ${path}`);
  if (route.includes("?") || route.includes("#")) throw new ProxyPathRefusedError(`path must not hide an encoded ? or #: ${path}`);

  for (const segment of route.split("/")) {
    if (segment === "." || segment === "..") throw new ProxyPathRefusedError(`path must not contain dot segments: ${path}`);
    if (FORBIDDEN_SEGMENT.test(segment)) {
      throw new ProxyPathRefusedError(`internal, admin, staff and platform routes are never proxied: ${path}`);
    }
  }
  return path;
}

/** Builds the downstream URL and proves it stays on the service's own origin. */
export function buildProxyUrl(baseUrl: string, path: unknown): string {
  const safe = assertSafeProxyPath(path);
  const base = new URL(baseUrl);
  const url = new URL(`${baseUrl.replace(/\/$/, "")}${safe}`);
  if (url.origin !== base.origin) throw new ProxyPathRefusedError(`path leaves the service origin: ${safe}`);
  if (url.username || url.password) throw new ProxyPathRefusedError(`path must not carry credentials: ${safe}`);
  return url.toString();
}

const STRIPPED_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-length",
  "expect",
]);

/** Caller headers minus anything that steers the connection itself. */
export function sanitizeCallerHeaders(headers: unknown): Record<string, string> {
  if (headers === undefined || headers === null) return {};
  if (typeof headers !== "object" || Array.isArray(headers)) throw new ProxyPathRefusedError("headers must be an object of strings");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof v !== "string") throw new ProxyPathRefusedError(`header ${k} must be a string`);
    if (STRIPPED_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

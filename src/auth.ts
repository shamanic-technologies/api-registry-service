import { createHash, timingSafeEqual } from "node:crypto";
import { Request, Response, NextFunction } from "express";

/**
 * Strips trailing commas and whitespace from a header value.
 * Node.js joins duplicate HTTP headers with ", " — if the duplicate value is empty,
 * the result is "uuid," which corrupts downstream WHERE clauses.
 */
export function cleanHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const str = Array.isArray(value) ? value.join(",") : value;
  const cleaned = str.replace(/[,\s]+$/, "");
  return cleaned || undefined;
}

const API_KEY = process.env.API_REGISTRY_SERVICE_API_KEY;
if (!API_KEY) {
  console.error("[api-registry] FATAL CONFIG: API_REGISTRY_SERVICE_API_KEY is not set: every authenticated route answers 503 until it is (SSRF-1127, fail closed).");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Timing-safe equality: both sides hashed to a fixed length first, so length leaks nothing either. */
export function keysMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

function providedKey(req: Request): string | undefined {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim() || undefined;
  return undefined;
}

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) {
    // Fail CLOSED: an unset key never opens the registry (it proxies with every service's own key).
    console.error(`[api-registry] refused ${req.method} ${req.path}: API_REGISTRY_SERVICE_API_KEY is not set`);
    return res.status(503).json({ error: "Registry authentication is not configured" });
  }

  const provided = providedKey(req);
  if (!provided || !keysMatch(provided, API_KEY)) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }

  next();
}

export function requireIdentity(req: Request, res: Response, next: NextFunction) {
  const orgId = req.headers["x-org-id"];
  const userId = req.headers["x-user-id"];

  if (!orgId || !userId) {
    return res.status(400).json({ error: "Missing required headers: x-org-id, x-user-id" });
  }

  next();
}

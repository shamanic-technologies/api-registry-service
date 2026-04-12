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

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) {
    // No API key configured = no auth required (development mode)
    return next();
  }

  const provided =
    req.headers["x-api-key"] as string ||
    req.headers.authorization?.replace("Bearer ", "");

  if (!provided || provided !== API_KEY) {
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

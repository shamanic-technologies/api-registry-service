import { Request, Response, NextFunction } from "express";

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

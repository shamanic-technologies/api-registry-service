import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas.js";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outputFile = join(__dirname, "..", "openapi.json");

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "API Registry Service",
    description:
      "Aggregates OpenAPI specs from multiple microservices into a single queryable registry. Provides REST endpoints and MCP tools for LLM-powered service discovery.",
    version: "1.0.0",
  },
  servers: [{ url: process.env.SERVICE_URL || "http://localhost:3000" }],
});

writeFileSync(outputFile, JSON.stringify(document, null, 2));
console.log("openapi.json generated");

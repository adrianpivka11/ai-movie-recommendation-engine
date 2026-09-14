import cors from "cors";
import express from "express";
import type { McpWarmupResult } from "./mcp/mcpClient.js";
import type { AgentOutput } from "./types.js";

// A small interface for the recommendation use case
// In production this calls the real AI agent, but tests can pass a fake handler.
type RecommendationHandler = (query: string) => Promise<AgentOutput>;

// A small interface for waking/checking remote MCP services.
// In production this pings MCP /health endpoints, but tests can pass a fake handler.
type WarmupHandler = () => Promise<McpWarmupResult[]>;

/**
 * Creates and configures the Express application.
 *
 * Keeping this separate from server.ts makes the app easier to test:
 * tests can import createApp() and call routes without opening a real network port.
 */
export function createApp(
  recommendationHandler: RecommendationHandler = runMovieChoiceAgent,
  warmupHandler: WarmupHandler = runWarmupMcpServices
) {
  const app = express();

  // Enables requests from the Vite frontend running on a different local port.
  app.use(cors());

  // Parses incoming JSON request bodies and makes them available on req.body.
  app.use(express.json());

  // Lightweight endpoint used to verify that the backend process is alive.
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Lightweight endpoint called by the frontend when the app opens.
  // It lets the main backend wake/check both MCP services before the user searches.
  app.get("/api/warmup", async (_req, res) => {
    try {
      const services = await warmupHandler();
      const allServicesReady = services.every((service) => service.ok);

      res.json({
        status: allServicesReady ? "ok" : "partial",
        services,
      });
    } catch (error) {
      console.error("[Warmup Error]", error);
      res.json({
        status: "failed",
        services: [],
        error: "Warm-up request failed.",
      });
    }
  });

  // Main recommendation endpoint called by the React frontend.
  app.post("/api/recommend", async (req, res, next) => {
    try {
      const userQuery = req.body.movieOrSerieUserRequest;

      // Validate client input before calling expensive external services.
      if (!isNonEmptyString(userQuery)) {
        throw new HttpError(
          400,
          "Please describe what kind of movie or series you want."
        );
      }

      console.log(
        `[SERVER - RECEIVED REQUESTED] with type of recommendation:`,
        userQuery
      );

      // The handler hides the implementation detail of where recommendations come from.
      // It can be the real AI agent or a mocked function in integration tests.
      const structuredData = await recommendationHandler(userQuery.trim());

      res.json({ agenticStructuredData: structuredData });
      console.log(`[SERVER - SENDING RESPONSE] sending recommandations`);
    } catch (error) {
      // Passing errors to next() lets the shared error middleware format the response.
      next(error);
    }
  });

  // Central Express error handler.
  // Every route can call next(error), and this middleware decides the HTTP status
  // and the safe message that should be returned to the frontend.
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const statusCode = getStatusCode(error);
      const message = getPublicErrorMessage(error);

      console.error(`[API Error] ${statusCode}`, error);
      res.status(statusCode).json({ error: message });
    }
  );

  return app;
}

// Default app instance used by server.ts in normal local development/production.
const app = createApp();

export default app;

// Dynamically imports the real agent only when the production handler runs.
// This keeps tests lightweight because createApp(mockHandler) does not need
// to import OpenAI/Supabase-dependent modules.
async function runMovieChoiceAgent(query: string) {
  const { movieChoiceAgentLatestVersion } = await import("./agentLatestVersion.js");
  return movieChoiceAgentLatestVersion (query);
}

// Dynamically imports the MCP warmup client only when the warmup endpoint runs.
async function runWarmupMcpServices() {
  const { warmupMcpServices } = await import("./mcp/mcpClient.js");
  return warmupMcpServices();
}

// Custom error type for errors where we intentionally choose the HTTP status
// and the public message returned to the client.
class HttpError extends Error {
  constructor(
    public statusCode: number,
    public publicMessage: string
  ) {
    super(publicMessage);
  }
}

// Type guard for validating that an unknown input is a non-empty string.
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Converts unknown errors into an HTTP status code.
// Unknown/unexpected errors become 500 Internal Server Error.
function getStatusCode(error: unknown) {
  if (error instanceof HttpError) {
    return error.statusCode;
  }

  return 500;
}

// Returns a frontend-safe error message.
// Internal server details are hidden for unexpected errors.
function getPublicErrorMessage(error: unknown) {
  if (error instanceof HttpError) {
    return error.publicMessage;
  }

  return "Recommendation service is temporarily unavailable. Please try again.";
}

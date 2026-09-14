import cors from "cors";
import express from "express";
import { createRequire } from "node:module";
import { z } from "zod";
import {
  MOVIE_RAG_TOOL_NAME,
  type MovieRagToolInput,
  type MovieRagToolResponse,
} from "./sharedTypes.js";
import { requireMcpApiKey } from "./mcpAuth.js";

type MovieRagHandler = (query: string) => Promise<MovieRagToolResponse>;

type McpServerConstructor = new (config: {
  name: string;
  version: string;
}) => {
  tool: (...args: unknown[]) => void;
  connect: (transport: unknown) => Promise<void>;
};

type StreamableHttpTransportConstructor = new (config: {
  sessionIdGenerator: undefined;
  enableJsonResponse: boolean;
}) => {
  handleRequest: (
    req: express.Request,
    res: express.Response,
    parsedBody?: unknown
  ) => Promise<void>;
};

const require = createRequire(import.meta.url);
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as {
  McpServer: McpServerConstructor;
};
const { StreamableHTTPServerTransport } = require(
  "@modelcontextprotocol/sdk/server/streamableHttp.js"
) as {
  StreamableHTTPServerTransport: StreamableHttpTransportConstructor;
};

export function createMovieRagMcpApp(
  movieRagHandler: MovieRagHandler = searchMoviesBySimilarity
) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "movie-rag-mcp" });
  });

  app.post("/mcp", requireMcpApiKey, async (req, res, next) => {
    console.log("[Movie RAG MCP] POST /mcp received");
    const server = createMovieRagMcpServer(movieRagHandler);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      next(error);
    }
  });

  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      console.error("[Movie RAG MCP Error]", error);
      res.status(500).json({ error: "Movie RAG MCP request failed." });
    }
  );

  return app;
}

function createMovieRagMcpServer(movieRagHandler: MovieRagHandler) {
  const server = new McpServer({
    name: "Movie RAG MCP Server",
    version: "1.0.0",
  });

  server.tool(
    MOVIE_RAG_TOOL_NAME,
    "Search the Supabase movie vector database and return personalized movie recommendations.",
    {
      query: z
        .string()
        .min(1)
        .describe(
          "A semantic movie recommendation request, for example: 'Recommend hopeful sci-fi movies about survival.'"
        ),
    },
    async ({ query }: MovieRagToolInput) => {
      const result = await movieRagHandler(query);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );

  return server;
}

async function searchMoviesBySimilarity(
  query: string
): Promise<MovieRagToolResponse> {
  const { retrieveSimilarMoviesByRAG } = await import("../rag.js");
  const movies = await retrieveSimilarMoviesByRAG(query);

  return {
    movies,
  };
}

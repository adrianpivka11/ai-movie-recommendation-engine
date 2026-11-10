import { createRequire } from "node:module";
import type {
  MovieRagToolResponse,
  SeriesSearchToolResponse,
} from "./sharedTypes.js";
import {
  MOVIE_RAG_TOOL_NAME,
  SERIES_SEARCH_TOOL_NAME,
} from "./sharedTypes.js";

/**
 * Minimal local TypeScript shape for the MCP SDK Client instance.
 *
 * We keep this small on purpose because importing the full SDK types made
 * TypeScript memory usage very high in this project.
 */
type McpClientInstance = {
  connect: (transport: unknown, options?: McpRequestOptions) => Promise<void>;
  callTool: (
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: McpRequestOptions
  ) => Promise<McpToolResult>;
  close: () => Promise<void>;
};

/**
 * Constructor shape for the MCP SDK Client class loaded at runtime.
 */
type McpClientConstructor = new (
  clientInfo: { name: string; version: string },
  options?: unknown
) => McpClientInstance;

/**
 * Constructor shape for the Streamable HTTP MCP transport.
 *
 * This transport sends MCP protocol messages over HTTP, which fits the planned
 * Render deployment where each MCP capability is a separate web service.
 */
type StreamableHttpClientTransportConstructor = new (
  url: URL,
  options?: {
    requestInit?: RequestInit;
  }
) => unknown;

/**
 * Per-request MCP options used for cancellation and timeout control.
 *
 * The timeout values matter for Render free-tier cold starts: the backend
 * should wait long enough for sleeping MCP services to wake up, but not forever.
 */
type McpRequestOptions = {
  signal?: AbortSignal;
  timeout?: number;
  maxTotalTimeout?: number;
};

/**
 * Minimal shape of the MCP tool result returned by our MCP servers.
 *
 * Our tools return JSON as text content, so the client extracts the first
 * text item and parses it back into strongly typed application data.
 */
type McpToolResult = {
  isError?: boolean;
  content?: Array<
    | {
        type: "text";
        text: string;
      }
    | {
        type: string;
        [key: string]: unknown;
      }
  >;
};

/**
 * Internal service identifier used for logs and error messages.
 */
type McpServiceName = "movie-rag" | "series-search";

/**
 * Result returned by warmupMcpServices().
 *
 * A warmup call is not a recommendation request. It only checks /health
 * endpoints so sleeping Render services can start before the user clicks Search.
 */
export type McpWarmupResult = {
  service: McpServiceName;
  ok: boolean;
  statusCode?: number;
  error?: string;
};

const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as {
  Client: McpClientConstructor;
};
const { StreamableHTTPClientTransport } = require(
  "@modelcontextprotocol/sdk/client/streamableHttp.js"
) as {
  StreamableHTTPClientTransport: StreamableHttpClientTransportConstructor;
};

/**
 * Calls the Movie RAG MCP server and returns its typed response.
 *
 * Used by agent.ts inside the LLM tool implementation for movie recommendations.
 * Default local URL: http://localhost:3002/mcp
 */
export async function callMovieRagMcp(
  query: string
): Promise<MovieRagToolResponse> {
  return callMcpTool<MovieRagToolResponse>({
    serviceName: "movie-rag",
    serverUrl: getEnvWithDefault(
      "MOVIE_RAG_MCP_URL",
      "http://localhost:3002/mcp"
    ),
    toolName: MOVIE_RAG_TOOL_NAME,
    query,
  });
}

/**
 * Calls the Series Search MCP server and returns its typed response.
 *
 * Used by agent.ts inside the LLM tool implementation for TV series
 * recommendations. Default local URL: http://localhost:3003/mcp
 */
export async function callSeriesSearchMcp(
  query: string
): Promise<SeriesSearchToolResponse> {
  return callMcpTool<SeriesSearchToolResponse>({
    serviceName: "series-search",
    serverUrl: getEnvWithDefault(
      "SERIES_SEARCH_MCP_URL",
      "http://localhost:3003/mcp"
    ),
    toolName: SERIES_SEARCH_TOOL_NAME,
    query,
  });
}

/**
 * Pings both MCP service health endpoints in parallel.
 *
 * This is intended for a future frontend-triggered warmup flow: when the user
 * opens the app, the main backend can wake up both Render MCP services while
 * the user is still typing their recommendation request.
 */
export async function warmupMcpServices(): Promise<McpWarmupResult[]> {
  const timeoutMs = getNumberEnvWithDefault("MCP_WARMUP_TIMEOUT_MS", 60_000);

  const warmups = [
    warmupMcpService(
      "movie-rag",
      getEnvWithDefault(
        "MOVIE_RAG_MCP_HEALTH_URL",
        createHealthUrl(getEnvWithDefault("MOVIE_RAG_MCP_URL", "http://localhost:3002/mcp"))
      ),
      timeoutMs
    ),
    warmupMcpService(
      "series-search",
      getEnvWithDefault(
        "SERIES_SEARCH_MCP_HEALTH_URL",
        createHealthUrl(
          getEnvWithDefault("SERIES_SEARCH_MCP_URL", "http://localhost:3003/mcp")
        )
      ),
      timeoutMs
    ),
  ];

  return Promise.all(warmups);
}

/**
 * Generic helper that connects to one MCP server, calls one tool, parses the
 * JSON text result, and closes the MCP client.
 *
 * This is the central place where MCP timeout behavior is enforced.
 */
async function callMcpTool<TResponse>({
  serviceName,
  serverUrl,
  toolName,
  query,
}: {
  serviceName: McpServiceName;
  serverUrl: string;
  toolName: string;
  query: string;
}): Promise<TResponse> {
  const timeoutMs = getNumberEnvWithDefault("MCP_REQUEST_TIMEOUT_MS", 90_000);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  const client = new Client({
    name: "movie-choice-backend",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: {
      headers: createMcpHeaders(),
    },
  });

  try {
    const requestOptions = {
      signal: abortController.signal,
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
    };

    await client.connect(transport, requestOptions);

    const result = await client.callTool(
      {
        name: toolName,
        arguments: { query },
      },
      undefined,
      requestOptions
    );

    return parseMcpTextJson<TResponse>(result, serviceName, toolName);
  } catch (error) {
    throw createMcpClientError(error, serviceName, timeoutMs);
  } finally {
    clearTimeout(timeout);
    await client.close().catch(() => undefined);
  }
}

/**
 * Sends a simple HTTP GET request to an MCP service health endpoint.
 *
 * It intentionally does not call an MCP tool, so it does not spend OpenAI or
 * Supabase resources. Its only job is to wake/check the service process.
 */
async function warmupMcpService(
  service: McpServiceName,
  url: string,
  timeoutMs: number
): Promise<McpWarmupResult> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: createMcpHeaders(),
      signal: abortController.signal,
    });

    return {
      service,
      ok: response.ok,
      statusCode: response.status,
    };
  } catch (error) {
    return {
      service,
      ok: false,
      error: getErrorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extracts the first text content item from an MCP tool result and parses it
 * as JSON into the expected application-level response type.
 */
function parseMcpTextJson<TResponse>(
  result: McpToolResult,
  serviceName: McpServiceName,
  toolName: string
): TResponse {
  const textContent = result.content?.find(
    (item): item is { type: "text"; text: string } => item.type === "text"
  );

  // Failed tools return an error message, not the expected JSON response.
  if (result.isError) {
    throw new Error(
      textContent?.text || `MCP tool "${toolName}" failed without an error message.`
    );
  }

  if (!textContent) {
    throw new Error(
      `MCP service "${serviceName}" tool "${toolName}" did not return text content.`
    );
  }

  return JSON.parse(textContent.text) as TResponse;
}

/**
 * Creates optional authentication headers for MCP service requests.
 *
 * If MCP_API_KEY is configured, the main backend sends it as a Bearer token.
 * This prepares the services for being exposed as separate Render web services.
 */
function createMcpHeaders(): HeadersInit {
  const apiKey = process.env.MCP_API_KEY;

  if (!apiKey) {
    return {};
  }

  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

/**
 * Converts unknown MCP/transport errors into clearer application errors.
 *
 * Timeout errors get a specific message so the API layer can log and surface
 * them differently from ordinary network or protocol failures.
 */
function createMcpClientError(
  error: unknown,
  serviceName: McpServiceName,
  timeoutMs: number
) {
  if (error instanceof DOMException && error.name === "AbortError") {
    return new Error(
      `MCP service "${serviceName}" timed out after ${timeoutMs} ms.`
    );
  }

  return new Error(
    `MCP service "${serviceName}" request failed: ${getErrorMessage(error)}`
  );
}

/**
 * Converts an MCP endpoint URL such as http://localhost:3002/mcp into its
 * matching health endpoint URL: http://localhost:3002/health.
 */
function createHealthUrl(mcpUrl: string) {
  const url = new URL(mcpUrl);
  url.pathname = "/health";
  url.search = "";
  url.hash = "";

  return url.toString();
}

/**
 * Reads an environment variable and falls back to a local development default.
 */
function getEnvWithDefault(name: string, fallback: string) {
  return process.env[name] || fallback;
}

/**
 * Reads a positive numeric environment variable with a safe fallback.
 */
function getNumberEnvWithDefault(name: string, fallback: number) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Normalizes unknown thrown values into readable strings for logs/errors.
 */
function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

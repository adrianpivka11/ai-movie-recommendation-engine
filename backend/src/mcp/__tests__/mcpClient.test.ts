import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callMovieRagMcp,
  callSeriesSearchMcp,
} from "../mcpClient.js";
import { createMovieRagMcpApp } from "../movieRagMcpApp.js";
import { createSeriesSearchMcpApp } from "../seriesSearchMcpApp.js";
import { startTestServer } from "./testServer.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MCP client", () => {
  it("preserves the tool error message instead of parsing it as JSON", async () => {
    const message = "The model `example-model` has been deprecated.";
    const app = createMovieRagMcpApp(async () => {
      throw new Error(message);
    });
    const server = await startTestServer(app);
    vi.stubEnv("MOVIE_RAG_MCP_URL", `${server.baseUrl}/mcp`);

    try {
      await expect(callMovieRagMcp("Recommend WW2 movies.")).rejects.toThrow(
        `MCP service "movie-rag" request failed: ${message}`
      );
    } finally {
      await server.close();
    }
  });

  it("calls the movie RAG MCP server and returns movies", async () => {
    const app = createMovieRagMcpApp(async () => ({
      movies: [
        {
          title: "Arrival",
          year: "2016",
          poster_path: "/arrival.jpg",
          index: 0,
          isLast: true,
          recommendation: "A thoughtful science fiction recommendation.",
        },
      ],
    }));
    const server = await startTestServer(app);
    vi.stubEnv("MOVIE_RAG_MCP_URL", `${server.baseUrl}/mcp`);

    try {
      const result = await callMovieRagMcp("Recommend thoughtful sci-fi.");

      expect(result.movies).toHaveLength(1);
      expect(result.movies[0]?.title).toBe("Arrival");
    } finally {
      await server.close();
    }
  });

  it("sends the configured MCP API key when calling protected MCP services", async () => {
    const app = createMovieRagMcpApp(async () => ({
      movies: [
        {
          title: "Blade Runner 2049",
          year: "2017",
          poster_path: "/blade-runner-2049.jpg",
          index: 0,
          isLast: true,
          recommendation: "A moody sci-fi recommendation.",
        },
      ],
    }));
    const server = await startTestServer(app);
    vi.stubEnv("MCP_API_KEY", "test-secret");
    vi.stubEnv("MOVIE_RAG_MCP_URL", `${server.baseUrl}/mcp`);

    try {
      const result = await callMovieRagMcp("Recommend atmospheric sci-fi.");

      expect(result.movies[0]?.title).toBe("Blade Runner 2049");
    } finally {
      await server.close();
    }
  });

  it("calls the series search MCP server and returns series", async () => {
    const app = createSeriesSearchMcpApp(async () => ({
      series: [
        {
          title: "Dark",
          year: 2017,
          recommendation: "A serious time-travel mystery.",
        },
      ],
    }));
    const server = await startTestServer(app);
    vi.stubEnv("SERIES_SEARCH_MCP_URL", `${server.baseUrl}/mcp`);

    try {
      const result = await callSeriesSearchMcp("Recommend mystery series.");

      expect(result.series).toHaveLength(1);
      expect(result.series[0]?.title).toBe("Dark");
    } finally {
      await server.close();
    }
  });

  it("returns a readable timeout error when an MCP service is too slow", async () => {
    const app = createMovieRagMcpApp(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ movies: [] }), 500);
        })
    );
    const server = await startTestServer(app);
    vi.stubEnv("MOVIE_RAG_MCP_URL", `${server.baseUrl}/mcp`);
    vi.stubEnv("MCP_REQUEST_TIMEOUT_MS", "50");

    try {
      await expect(callMovieRagMcp("Recommend a slow movie.")).rejects.toThrow(
        /MCP service "movie-rag"/
      );
    } finally {
      await server.close();
    }
  });
});

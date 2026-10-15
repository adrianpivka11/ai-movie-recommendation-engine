import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { callMovieRagMcp, callSeriesSearchMcp } from "./mcp/mcpClient.js";
import { movieChoiceAgentSystemPrompt } from "./systemPromptAgent.js";
import type {
  AgentOutput,
  MovieRecommendation,
  SeriesRecommendation,
} from "./types.js";

const MAX_TOOL_STEPS = 3;
const TOOL_CALLING_MODEL = getRequiredEnv("TOOL_CALLING_MODEL");

/**
 * Main recommendation agent used by the Express API.
 *
 * The LLM still decides which tools should be used, but the tool
 * implementations no longer call local functions directly. Instead, each tool
 * calls a dedicated MCP server through the MCP client layer.
 *
 * Final output must stay compatible with the frontend contract:
 * { movies: MovieRecommendation[], series: SeriesRecommendation[] }.
 */
export async function movieChoiceAgent(query: string): Promise<AgentOutput> {
  console.log(`[MCP Agent] Received question: ${query}`);

  /**
   * Tool definitions exposed to the LLM during this agent run.
   *
   * The names are intentionally kept the same as the old local-agent version
   * so the system prompt and result extraction logic remain familiar.
   */
  const tools = {
    movieRagTool: tool({
      description: `
        MCP-backed movie recommendation tool.
        Search the Movie RAG MCP server for movie recommendations.
        Use this tool only when the user asks for movies.
        The movie database contains movies, not TV series.
      `,
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "A semantic search query containing the user's movie preferences."
          ),
      }),
      execute: async ({ query }) => {
        // Calls the remote/local Movie RAG MCP service and unwraps its movies array.
        const result = await callMovieRagMcp(query);
        return result.movies;
      },
    }),

    webSearchTool: tool({
      description: `
        MCP-backed TV series recommendation tool.
        Search the Series Search MCP server for TV series recommendations.
        Use this tool only when the user asks for series, TV shows, or miniseries.
      `,
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "A semantic search query containing the user's TV series preferences."
          ),
      }),
      execute: async ({ query }) => {
        // Calls the remote/local Series Search MCP service and unwraps its series array
        const result = await callSeriesSearchMcp(query);
        return result.series;
      },
    }),
  };

  try {
    const result = await generateText({
      model: openai.responses(TOOL_CALLING_MODEL),
      tools,
      toolChoice: "required",
      stopWhen: stepCountIs(MAX_TOOL_STEPS),
      system: movieChoiceAgentSystemPrompt,
      prompt: query,
    });

    let movieResults: MovieRecommendation[] = [];
    let seriesResults: SeriesRecommendation[] = [];

    /**
     * AI SDK stores tool call outputs inside generation steps.
     * This loop extracts the latest result produced by each MCP-backed tool
     * and normalizes everything into the stable AgentOutput shape.
     */
    for (const [i, step] of result.steps.entries()) {
      const movieToolResult = step.content.find(
        (content) =>
          content.type === "tool-result" && content.toolName === "movieRagTool"
      );
      const seriesToolResult = step.content.find(
        (content) =>
          content.type === "tool-result" && content.toolName === "webSearchTool"
      );

      if (movieToolResult && movieToolResult.type === "tool-result") {
        movieResults = movieToolResult.output as MovieRecommendation[];
        console.log(`[MCP Agent] movieRagTool used in step ${i}`);
      }

      if (seriesToolResult && seriesToolResult.type === "tool-result") {
        seriesResults = seriesToolResult.output as SeriesRecommendation[];
        console.log(`[MCP Agent] webSearchTool used in step ${i}`);
      }
    }

    const answer: AgentOutput = {
      movies: movieResults,
      series: seriesResults,
    };

    console.log("[MCP Agent] Agentic recommendation successful:", answer);

    return answer;
  } catch (error) {
    console.error("[MCP Agent] Agentic recommendation flow failed, either on movieRagTool or webSearchTool:", error);
    throw error;
  }
}

/**
 * Reads a required environment variable and throws a clear startup/runtime
 * error when it is missing.
 */
function getRequiredEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[ERROR] Missing environment variable: ${name}`);
  }

  return value;
}

import { callMovieRagMcp, callSeriesSearchMcp } from "./mcp/mcpClient.js";
import type { AgentOutput } from "./types.js";

type RecommendationIntent = "movies" | "series" | "both";

const MOVIE_KEYWORDS = [
  /\bmovie\b/i,
  /\bmovies\b/i,
  /\bfilm\b/i,
  /\bfilms\b/i,
  /\bfilmy\b/i,
  /\bfilmou\b/i,
  /\bfilmov\b/i,
];

const SERIES_KEYWORDS = [
  /\bseries\b/i,
  /\bshow\b/i,
  /\bshows\b/i,
  /\btv\b/i,
  /\bminiseries\b/i,
  /\bserial\b/i,
  /\bserialy\b/i,
  /\bserialov\b/i,
  /\bseri[aá]l\b/i,
  /\bseri[aá]ly\b/i,
  /\bseri[aá]lov\b/i,
];

/**
 * Latest production recommendation agent.
 *
 * This version keeps the MCP architecture but removes the expensive and
 * unstable LLM tool-router step. A small deterministic router decides which
 * MCP service should be called, then the backend calls the MCP client directly.
 */
export async function movieChoiceAgentLatestVersion(
  query: string
): Promise<AgentOutput> {
  const intent = detectRecommendationIntent(query);
  console.log(`[MCP Router Agent] Received question: ${query}`);
  console.log(`[MCP Router Agent] Detected intent: ${intent}`);

  if (intent === "movies") {
    const movieResult = await callMovieRagMcp(query);

    console.log(
      `[MCP Router Agent] movie-rag MCP returned ${movieResult.movies.length} movies.`
    );

    return {
      movies: movieResult.movies,
      series: [],
    };
  }

  if (intent === "series") {
    const seriesResult = await callSeriesSearchMcp(query);

    console.log(
      `[MCP Router Agent] series-search MCP returned ${seriesResult.series.length} series.`
    );

    return {
      movies: [],
      series: seriesResult.series,
    };
  }

  const [movieResult, seriesResult] = await Promise.all([
    callMovieRagMcp(query),
    callSeriesSearchMcp(query),
  ]);

  console.log(
    `[MCP Router Agent] MCP services returned movies=${movieResult.movies.length}, series=${seriesResult.series.length}.`
  );

  return {
    movies: movieResult.movies,
    series: seriesResult.series,
  };
}

/**
 * Detects which recommendation services are needed for a user request.
 *
 * Ambiguous requests intentionally call both MCP services so the app can still
 * return useful results when the user does not clearly say movie or series.
 */
export function detectRecommendationIntent(query: string): RecommendationIntent {
  const asksForMovies = MOVIE_KEYWORDS.some((pattern) => pattern.test(query));
  const asksForSeries = SERIES_KEYWORDS.some((pattern) => pattern.test(query));

  if (asksForMovies && !asksForSeries) {
    return "movies";
  }

  if (asksForSeries && !asksForMovies) {
    return "series";
  }

  return "both";
}

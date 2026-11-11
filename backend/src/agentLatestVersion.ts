import { retrieveSimilarMoviesByRAG } from "./rag.js";
import { webSearchTool } from "./seriesWebSearch.js";
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
 * A small deterministic router selects the local recommendation functions.
 * RAG and series search run in the backend process without MCP requests.
 */
export async function movieChoiceAgentLatestVersion(
  query: string
): Promise<AgentOutput> {
  const intent = detectRecommendationIntent(query);
  console.log(`[Router Agent] Received question: ${query}`);
  console.log(`[Router Agent] Detected intent: ${intent}`);

  if (intent === "movies") {
    const movies = await retrieveSimilarMoviesByRAG(query);

    console.log(
      `[Router Agent] RAG returned ${movies.length} movies.`
    );

    return {
      movies,
      series: [],
    };
  }

  if (intent === "series") {
    const series = await webSearchTool(query);

    console.log(
      `[Router Agent] Web search returned ${series.length} series.`
    );

    return {
      movies: [],
      series,
    };
  }

  // Wait for both tools before releasing a worker lease, even if one fails.
  const results = await Promise.allSettled([
    retrieveSimilarMoviesByRAG(query),
    webSearchTool(query),
  ]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length === 1) throw failures[0].reason;
  if (failures.length > 1) throw new AggregateError(failures.map((result) => result.reason), "Both recommendation tools failed");
  const [movieResult, seriesResult] = results;
  if (movieResult.status !== "fulfilled" || seriesResult.status !== "fulfilled") {
    throw new Error("Missing recommendation tool result");
  }
  const movies = movieResult.value;
  const series = seriesResult.value;

  console.log(
    `[Router Agent] Local functions returned movies=${movies.length}, series=${series.length}.`
  );

  return {
    movies,
    series,
  };
}

/**
 * Detects which recommendation functions are needed for a user request.
 *
 * Ambiguous requests intentionally call both functions so the app can still
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

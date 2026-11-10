import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectRecommendationIntent, movieChoiceAgentLatestVersion } from "../agentLatestVersion.js";
import { retrieveSimilarMoviesByRAG } from "../rag.js";
import { webSearchTool } from "../seriesWebSearch.js";
import type { MovieRecommendation, SeriesRecommendation } from "../types.js";

vi.mock("../rag.js", () => ({ retrieveSimilarMoviesByRAG: vi.fn() }));
vi.mock("../seriesWebSearch.js", () => ({ webSearchTool: vi.fn() }));

const movies: MovieRecommendation[] = [{
  title: "Arrival",
  year: "2016",
  poster_path: "/arrival.jpg",
  index: 0,
  isLast: true,
  recommendation: "A thoughtful science fiction movie.",
}];
const series: SeriesRecommendation[] = [{
  title: "Dark",
  year: 2017,
  recommendation: "A mystery series about time travel.",
}];

describe("latest local router agent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(retrieveSimilarMoviesByRAG).mockResolvedValue(movies);
    vi.mocked(webSearchTool).mockResolvedValue(series);
  });

  it("recognizes movie requests", () => {
    expect(detectRecommendationIntent("Recommend WW2 movies")).toBe("movies");
    expect(detectRecommendationIntent("Odporuc mi historicke filmy")).toBe(
      "movies"
    );
  });

  it("recognizes series requests", () => {
    expect(detectRecommendationIntent("Recommend romantic series")).toBe(
      "series"
    );
    expect(detectRecommendationIntent("Odporuc mi mysteriozne serialy")).toBe(
      "series"
    );
  });

  it("routes mixed or ambiguous requests to both categories", () => {
    expect(
      detectRecommendationIntent("Recommend WW2 movies and romantic series")
    ).toBe("both");
    expect(detectRecommendationIntent("Recommend something dark")).toBe("both");
  });

  it("calls only local RAG for movies and preserves the output shape", async () => {
    const query = "Recommend thoughtful movies";

    expect(await movieChoiceAgentLatestVersion(query)).toEqual({ movies, series: [] });
    expect(retrieveSimilarMoviesByRAG).toHaveBeenCalledExactlyOnceWith(query);
    expect(webSearchTool).not.toHaveBeenCalled();
  });

  it("calls only local web search for series", async () => {
    const query = "Recommend mystery series";

    expect(await movieChoiceAgentLatestVersion(query)).toEqual({ movies: [], series });
    expect(webSearchTool).toHaveBeenCalledExactlyOnceWith(query);
    expect(retrieveSimilarMoviesByRAG).not.toHaveBeenCalled();
  });

  it.each(["Recommend movies and series", "Recommend something dark"])(
    "combines local results for: %s",
    async (query) => {
      expect(await movieChoiceAgentLatestVersion(query)).toEqual({ movies, series });
      expect(retrieveSimilarMoviesByRAG).toHaveBeenCalledExactlyOnceWith(query);
      expect(webSearchTool).toHaveBeenCalledExactlyOnceWith(query);
    }
  );

  it("preserves empty results", async () => {
    vi.mocked(retrieveSimilarMoviesByRAG).mockResolvedValue([]);
    vi.mocked(webSearchTool).mockResolvedValue([]);

    expect(await movieChoiceAgentLatestVersion("Recommend something")).toEqual({
      movies: [],
      series: [],
    });
  });

  it.each(["movies", "series", "movies and series"])(
    "propagates a local tool failure for %s instead of returning empty results",
    async (category) => {
      const error = new Error("Recommendation provider unavailable");
      const failingTool = category === "series" ? webSearchTool : retrieveSimilarMoviesByRAG;
      vi.mocked(failingTool).mockRejectedValue(error);

      await expect(movieChoiceAgentLatestVersion(`Recommend ${category}`)).rejects.toBe(error);
    }
  );
});

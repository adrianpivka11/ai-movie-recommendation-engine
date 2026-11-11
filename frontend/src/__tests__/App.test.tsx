import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { RecommendApiResponse } from "../types";

function mockFetchResponse(body: RecommendApiResponse, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      json: vi.fn().mockResolvedValue(body),
    })
  );
}

async function submitSearch(query: string) {
  const user = userEvent.setup();

  render(<App />);

  await user.type(screen.getByRole("textbox"), query);
  await user.click(screen.getByRole("button", { name: /search/i }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("keeps loading until the AWS job completes, then renders its result", async () => {
    let finishStatus!: (response: Response) => void;
    const status = new Promise<Response>(resolve => { finishStatus = resolve; });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: "job-1", accessToken: "secret" }), { status: 202 }))
      .mockReturnValueOnce(status));
    await submitSearch("Recommend series");
    expect(screen.getByRole("button", { name: /loading/i })).toBeDisabled();
    expect(fetch).toHaveBeenCalledTimes(2);
    finishStatus(new Response(JSON.stringify({ jobId: "job-1", status: "completed", result: {
      movies: [], series: [{ title: "Dark", year: 2017, recommendation: "A mystery." }],
    } })));
    expect(await screen.findByText("Dark (2017)")).toBeVisible();
  });

  it("shows an error message when the API returns an error response", async () => {
    mockFetchResponse(
      { error: "Recommendation service is temporarily unavailable." },
      false
    );

    await submitSearch("Recommend a thriller.");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Recommendation service is temporarily unavailable."
    );
  });

  it("renders a movie recommendation when the API returns movies", async () => {
    mockFetchResponse({
      agenticStructuredData: {
        movies: [
          {
            title: "Arrival",
            year: "2016",
            poster_path: "/arrival.jpg",
            index: 0,
            isLast: true,
            recommendation: "A thoughtful science fiction story about language.",
          },
        ],
        series: [],
      },
    });

    await submitSearch("Recommend thoughtful sci-fi.");

    expect(await screen.findByRole("heading", { name: /arrival/i })).toBeVisible();
    expect(
      screen.getByText("A thoughtful science fiction story about language.")
    ).toBeInTheDocument();
  });

  it("renders series recommendations when the API returns series", async () => {
    mockFetchResponse({
      agenticStructuredData: {
        movies: [],
        series: [
          {
            title: "Dark",
            year: 2017,
            recommendation: "A serious time-travel mystery.",
          },
        ],
      },
    });

    await submitSearch("Recommend a mystery series.");

    expect(await screen.findByText("Dark (2017)")).toBeVisible();
    expect(screen.getByText("A serious time-travel mystery.")).toBeInTheDocument();
  });

  it("sends the user's request to the API", async () => {
    mockFetchResponse({
      agenticStructuredData: {
        movies: [],
        series: [],
      },
    });

    await submitSearch("Recommend survival movies.");

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/recommend$/),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            movieOrSerieUserRequest: "Recommend survival movies.",
          }),
          signal: expect.any(AbortSignal),
        }
      );
    });
  });
});

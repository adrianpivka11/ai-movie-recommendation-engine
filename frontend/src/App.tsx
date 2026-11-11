import { useState, useEffect, useRef } from "react";
import SearchForm from "./SearchForm";
import Movie from "./Movie";
import Series from "./Series";
import type { FormAnswers, MoviesFromServer, SeriesFromServer } from "./types";
import { requestRecommendations } from "./recommendationApi";

export default function App() {
  const [moviesArr, setMoviesArr] = useState<MoviesFromServer[]>([]);
  const [seriesArr, setSeriesArr] = useState<SeriesFromServer[]>([]);
  const [movieIndex, setMovieIndex] = useState(0);
  const [favoriteMovie, setFavoriteMovie] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => () => { activeRequest.current?.abort(); }, []);

  async function getMovies(formAnswers: FormAnswers) {
    if (activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setFavoriteMovie(formAnswers.movieOrSerieUserRequest);
    setErrorMessage("");
    setIsLoading(true);
    try {
      const result = await requestRecommendations(formAnswers, controller.signal);
      if (controller.signal.aborted) return;
      setMoviesArr(result.movies);
      setSeriesArr(result.series);
      setMovieIndex(0);
      if (!result.movies.length && !result.series.length) {
        setErrorMessage("No matching recommendations found. Try a different request.");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setMoviesArr([]);
      setSeriesArr([]);
      setMovieIndex(0);
      setErrorMessage(error instanceof Error ? error.message : "Something went wrong. Please try again.");
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }
  }

  function newSearchRefreshPage() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setMoviesArr([]);
    setSeriesArr([]);
    setMovieIndex(0);
    setErrorMessage("");
    setIsLoading(false);
  }

  if (!moviesArr.length && !seriesArr.length) {
    return <SearchForm getMovies={getMovies} favoriteMovie={favoriteMovie} isLoading={isLoading} errorMessage={errorMessage} />;
  }

  return (
    <>
      {moviesArr.length > 0 && (
        <Movie
          moviesObj={moviesArr[movieIndex]}
          increaseIndex={() => setMovieIndex(index => index + 1)}
          decreaseIndex={() => setMovieIndex(index => index - 1)}
          newSearchRefreshPage={newSearchRefreshPage}
        />
      )}
      {seriesArr.length > 0 && <Series series={seriesArr} newSearchRefreshPage={newSearchRefreshPage} />}
    </>
  );
}

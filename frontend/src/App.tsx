import { useState, useEffect } from "react";
import SearchForm from "./SearchForm";
import Movie from "./Movie";
import type { FormAnswers, MoviesFromServer, RecommendApiResponse, SeriesFromServer } from "./types";
import Series from "./Series";

const API_BASE_URL=""



export default function App() {
  const [moviesArr, setMoviesArr] = useState<MoviesFromServer[]>([]);
  const [seriesArr, setSeriesArr] = useState<SeriesFromServer[]>([])
  const [movieIndex, setMovieIndex] = useState(0);
  const [favoriteMovie, setFavoriteMovie] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  
  useEffect(() => {
    const abortController = new AbortController();

    const warmUpServers = async () => {
      try {
        console.log("[CLIENT] Warm-up request to backend has been sent.");
        const response = await fetch(`${API_BASE_URL}/api/warmup`, {
          signal: abortController.signal,
        });

        if (!response.ok) {
          console.warn("[CLIENT] Warm-up endpoint returned an error status.");
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        console.warn("[CLIENT] Warm-up request failed.", error);
      }
    };

    warmUpServers();


    return () => {
      // stops frontend from waitting for response from server
      abortController.abort();
    };
  }, []);


  async function getMovies(formAnswers: FormAnswers) {
    setFavoriteMovie(formAnswers.movieOrSerieUserRequest);
    setErrorMessage("");
    setIsLoading(true)

    try {
      // send fetch request to /api/recommend
      const response = await fetch(`${API_BASE_URL}/api/recommend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formAnswers),
      });

      const data = await response.json() as RecommendApiResponse
      console.log('[CLIENT] Data received on client side', data)

      if (!response.ok) {
        throw new Error(data.error ?? "Request failed")
      }

      const structuredData = data.agenticStructuredData;

      if (!structuredData) {
        throw new Error("Server returned an invalid response.")
      }

      // set received data to React State - Movies or Series. They will be set to Array with values, which will change the state.
      // Or they will be set to empty array which will maintain default state and conditional rendering on default.
      const moviesFromServer: MoviesFromServer[] = structuredData.movies
      const seriesFromServer: SeriesFromServer[] = structuredData.series
      setMoviesArr(moviesFromServer);
      setSeriesArr(seriesFromServer)
      // Convert Markdown to HTML
      

      // Sanitize the HTML to prevent XSS attacks
      

      // Render the result
      
  } catch (error) {
      // Log the error for debugging
      console.error(error);

      // Display friendly error message
      setMoviesArr([]);
      setSeriesArr([]);
      setMovieIndex(0);
      setIsLoading(false);
      setErrorMessage(getFriendlyErrorMessage(error));
  
    } finally {
    setIsLoading(false)
  }} 



  function increaseIndex() {
    setMovieIndex((prevMovieIndex) => prevMovieIndex + 1);
  }

  function decreaseIndex() {
    setMovieIndex((prevMovieIndex) => prevMovieIndex - 1);
  }

  function newSearchRefreshPage() {
    setMoviesArr([]);
    setSeriesArr([])
    setMovieIndex(0);
    setErrorMessage("");
    setIsLoading(false)
  }

  // conditional rendering of React components - Movies and Series

  return  moviesArr.length !== 0  && seriesArr.length === 0 ?
        
                (<Movie
                  moviesObj={moviesArr[movieIndex]}
                  increaseIndex={increaseIndex}
                  decreaseIndex={decreaseIndex}
                  newSearchRefreshPage={newSearchRefreshPage}
                />)

          : seriesArr.length !== 0 && moviesArr.length === 0 ? 

                (<Series
                  series={seriesArr}
                  newSearchRefreshPage={newSearchRefreshPage}
                />) 

          
          : seriesArr.length !== 0 && moviesArr.length !== 0 ? 
                (
                  <>
                    <Movie
                      moviesObj={moviesArr[movieIndex]}
                      increaseIndex={increaseIndex}
                      decreaseIndex={decreaseIndex}
                      newSearchRefreshPage={newSearchRefreshPage}
                    />
                    <Series 
                      series={seriesArr}
                      newSearchRefreshPage={newSearchRefreshPage}
                     />
                  </>
                )
                  
          : 

            (<SearchForm getMovies={getMovies} favoriteMovie={favoriteMovie} isLoading={isLoading} errorMessage={errorMessage} />) 
}

function getFriendlyErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
}

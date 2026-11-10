import "dotenv/config";
import app from "./app.js";

const port = Number(process.env.PORT ?? 3001);

validateRuntimeEnv();

app.listen(port, () => {
  console.log(`Movie app backend listening on http://localhost:${port}`);
});

function validateRuntimeEnv() {
  const requiredEnvVars = [
    "OPENAI_API_KEY",
    "SUPABASE_URL",
    "SUPABASE_API_KEY",
    "EMBEDDING_MODEL",
    "RECOMMENDATION_MODEL",
    "OPENAI_MODEL",
    "OPENAI_MODEL_NON_REASONING",
  ];

  const missingEnvVars = requiredEnvVars.filter((name) => !process.env[name]);

  if (missingEnvVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingEnvVars.join(", ")}.`
    );
  }
}

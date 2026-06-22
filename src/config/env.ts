import dotenv from "dotenv";

dotenv.config();

export const env = {
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://llmedu:llmedu@127.0.0.1:15432/llmedu",
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  autoSeed: process.env.AUTO_SEED === "true" || (process.env.AUTO_SEED !== "false" && process.env.NODE_ENV !== "production"),
  llm: {
    baseUrl: process.env.LLM_BASE_URL ?? "",
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "gpt-4.1-mini"
  }
};

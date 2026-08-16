import { z } from "zod";

/**
 * Environment is validated once at import time and then frozen. If a required
 * var is missing the process exits immediately with a readable message rather
 * than failing later at the first request.
 */
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(5545),
  DATABASE_PATH: z.string().default("./data/splitsmart.db"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be >= 32 chars"),
  APP_ORIGIN: z.string().url().default("http://localhost:5545"),

  SPLITWISE_API_KEY: z.string().optional(),

  // Email is not wired up yet (docs/PLAN.md phase 4). Absence must be a no-op,
  // never a boot failure — that is why these are optional.
  POSTMARK_SERVER_TOKEN: z.string().optional(),
  POSTMARK_FROM_ADDRESS: z.string().email().optional(),
});

function load() {
  // In test runs we don't want to require a real .env file.
  if (process.env.NODE_ENV === "test" && !process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-ok";
  }

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`Invalid environment:\n${issues}\n\nSee .env.example.`);
    process.exit(1);
  }
  return Object.freeze(parsed.data);
}

export const env = load();

export const emailEnabled = Boolean(
  env.POSTMARK_SERVER_TOKEN && env.POSTMARK_FROM_ADDRESS,
);

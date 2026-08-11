import { z } from "zod";

const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const idList = z
  .string()
  .default("")
  .transform((value, context) => {
    if (value.trim() === "") return [] as number[];

    const ids = value.split(",").map((item) => Number(item.trim()));
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      context.addIssue({
        code: "custom",
        message: "ID lists must contain positive integer IDs separated by commas",
      });
      return z.NEVER;
    }
    return ids;
  });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_NAME: z.string().min(1).default("Discord & Telegram Voice Bot"),
  BOT_MODE: z.enum(["polling", "webhook", "http-only"]).default("polling"),
  TELEGRAM_BOT_TOKEN: optionalText,
  TELEGRAM_CHAT_ID: optionalText,
  TELEGRAM_API_ROOT: z.string().url().default("https://api.telegram.org"),
  DISCORD_TOKEN: optionalText,
  STEAM_API_KEY: optionalText,
  TELEGRAM_WEBHOOK_SECRET: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
  PUBLIC_WEBHOOK_URL: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().url().optional(),
  ),
  ALLOWED_USERS: idList,
  ADMIN_USER_IDS: idList,
  DATABASE_URL: z.string().min(1).default("./data/voice_stats.db"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  BIND_HOST: z.string().min(1).default("127.0.0.1"),
  WORKER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  TZ: z.string().default("Europe/Moscow"),
});

export type AppConfig = z.infer<typeof envSchema>;

export const QUIET_HOURS = { start: 2, end: 10 } as const;
export const ACHIEVEMENTS = {
  3600: "Beginner",
  36000: "Regular",
  360000: "Resident",
  3600000: "Veteran",
} as const;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`).join("; ");
    throw new ConfigurationError(`Invalid environment configuration — ${details}`);
  }

  const config = parsed.data;
  if (config.BOT_MODE !== "http-only") {
    if (!config.TELEGRAM_BOT_TOKEN) throw new ConfigurationError("TELEGRAM_BOT_TOKEN is required");
    if (!config.TELEGRAM_CHAT_ID) throw new ConfigurationError("TELEGRAM_CHAT_ID is required");
    if (!config.DISCORD_TOKEN) throw new ConfigurationError("DISCORD_TOKEN is required");
    if (config.ALLOWED_USERS.length === 0) {
      throw new ConfigurationError("ALLOWED_USERS must list at least one Telegram user ID");
    }
  }
  if (config.BOT_MODE === "webhook") {
    if (!config.TELEGRAM_WEBHOOK_SECRET) {
      throw new ConfigurationError("TELEGRAM_WEBHOOK_SECRET is required in webhook mode");
    }
    if (!config.PUBLIC_WEBHOOK_URL) {
      throw new ConfigurationError("PUBLIC_WEBHOOK_URL is required in webhook mode");
    }
  }
  return config;
}

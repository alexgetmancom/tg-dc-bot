import { describe, expect, test } from "bun:test";
import { ConfigurationError, loadConfig } from "../src/config.js";

const base = {
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_CHAT_ID: "-100123",
  DISCORD_TOKEN: "discord-token",
  ALLOWED_USERS: "42",
};

describe("loadConfig", () => {
  test("applies boilerplate defaults", () => {
    const config = loadConfig(base);
    expect(config.BOT_MODE).toBe("polling");
    expect(config.DATABASE_URL).toBe("./data/voice_stats.db");
    expect(config.ALLOWED_USERS).toEqual([42]);
  });

  test("rejects malformed Telegram IDs", () => {
    expect(() => loadConfig({ ...base, ALLOWED_USERS: "42,nope" })).toThrow(ConfigurationError);
  });

  test("requires bot credentials and an allowlist", () => {
    expect(() => loadConfig({})).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...base, ALLOWED_USERS: "" })).toThrow(ConfigurationError);
    expect(loadConfig({ BOT_MODE: "http-only" }).BOT_MODE).toBe("http-only");
  });

  test("requires webhook settings in webhook mode", () => {
    expect(() => loadConfig({ ...base, BOT_MODE: "webhook" })).toThrow(ConfigurationError);
    const config = loadConfig({
      ...base,
      BOT_MODE: "webhook",
      TELEGRAM_WEBHOOK_SECRET: "s".repeat(32),
      PUBLIC_WEBHOOK_URL: "https://example.com",
    });
    expect(config.PUBLIC_WEBHOOK_URL).toBe("https://example.com");
  });
});

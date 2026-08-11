import { describe, expect, test } from "bun:test";
import { redact } from "../src/logger.js";

describe("redact", () => {
  test("masks nested secrets", () => {
    expect(redact({ TELEGRAM_BOT_TOKEN: "123:abc", nested: { apiKey: "x", keep: 1 } })).toEqual({
      TELEGRAM_BOT_TOKEN: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", keep: 1 },
    });
  });

  test("serializes errors and leaves primitives intact", () => {
    const result = redact(new Error("boom")) as { message: string };
    expect(result.message).toBe("boom");
    expect(redact(null)).toBeNull();
  });
});

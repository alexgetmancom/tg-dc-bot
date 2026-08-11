import { describe, expect, test } from "bun:test";
import { escapeMarkdown, formatDuration, getDayStartTime } from "../src/utils.js";

describe("utils", () => {
  test("formats durations like the original bot", () => {
    expect(formatDuration(20)).toBe("less than a minute");
    expect(formatDuration(3_661)).toBe("1 h 1 min");
    expect(formatDuration(90_061)).toBe("1 d 1 h 1 min");
  });

  test("escapes Telegram Markdown characters", () => {
    expect(escapeMarkdown("A_game [test]!")).toBe("A\\_game \\[test\\]\\!");
  });

  test("calculates Moscow midnight", () => {
    expect(getDayStartTime(new Date("2026-08-11T12:00:00.000Z")).toISOString()).toBe("2026-08-10T21:00:00.000Z");
  });
});

import { describe, expect, test } from "bun:test";
import {
  endActiveSession,
  getAllActiveSessions,
  getState,
  getUserStats,
  migrateDatabase,
  openDatabase,
  setState,
  startActiveSession,
  updateStats,
} from "../src/storage/database.js";

function freshDatabase() {
  const database = openDatabase(":memory:");
  migrateDatabase(database);
  return database;
}

describe("database", () => {
  test("stores state and active sessions", () => {
    const database = freshDatabase();
    setState(database, "cursor", "1");
    expect(getState(database, "cursor")).toBe("1");

    const joinTime = new Date("2026-08-11T10:00:00.000Z");
    startActiveSession(database, "123456789012345678", joinTime);
    expect(getAllActiveSessions(database)).toEqual([{ userId: "123456789012345678", joinTime }]);
    expect(endActiveSession(database, "123456789012345678")).toEqual(joinTime);
    expect(getAllActiveSessions(database)).toEqual([]);
    database.close();
  });

  test("accumulates statistics for a Discord snowflake", () => {
    const database = freshDatabase();
    updateStats(database, "123456789012345678", "Alice", 90, "Game");
    updateStats(database, "123456789012345678", "Alice", 30, "Game");
    expect(getUserStats(database, "123456789012345678")).toEqual({ total_seconds: 120, name: "Alice" });
    database.close();
  });
});

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type OpenDatabase = {
  sqlite: Database;
  close: () => void;
};

export type SteamApp = { appid: number; name: string };
export type ActiveSession = { userId: string; joinTime: Date };
export type DailyStat = { userId: string; name: string; telegramId: number | null; seconds: number };
export type DetailedSession = {
  userId: string;
  name: string;
  telegramId: number | null;
  startTime: Date;
  seconds: number;
  gameName: string | null;
};

type DateRow = { join_time: string };
type ActiveSessionRow = { user_id: string; join_time: string };
type SteamAppIdRow = { appid: number };
type AchievementRow = { achievement: string };
type UserStatsRow = { total_seconds: number; name: string };
type TopUserRow = { name: string; total_seconds: number; telegram_id: number | null };
type TopGameRow = { name: string; total_seconds: number };
type DailyStatRow = { id: string; name: string; telegram_id: number | null; seconds: number };
type DetailedSessionRow = {
  id: string;
  name: string;
  telegram_id: number | null;
  start_time: string;
  duration_seconds: number;
  game_name: string | null;
};
type StateRow = { value: string };

export function openDatabase(url: string): OpenDatabase {
  if (url !== ":memory:") mkdirSync(dirname(url), { recursive: true });
  const sqlite = new Database(url, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return { sqlite, close: () => sqlite.close() };
}

export function migrateDatabase(database: OpenDatabase): void {
  database.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      total_seconds INTEGER DEFAULT 0,
      steam_id TEXT,
      telegram_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS games (
      name TEXT PRIMARY KEY,
      total_seconds INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS achievements (
      user_id TEXT,
      achievement TEXT,
      UNIQUE(user_id, achievement)
    );
    CREATE TABLE IF NOT EXISTS linking_codes (
      code TEXT PRIMARY KEY,
      discord_id TEXT,
      expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS voice_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      start_time TEXT,
      duration_seconds INTEGER,
      game_name TEXT
    );
    CREATE TABLE IF NOT EXISTS key_value_store (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS steam_apps (
      appid INTEGER PRIMARY KEY,
      name TEXT COLLATE NOCASE
    );
    CREATE INDEX IF NOT EXISTS idx_steam_apps_name ON steam_apps(name);
    CREATE TABLE IF NOT EXISTS cache_info (
      key TEXT PRIMARY KEY,
      last_updated TEXT
    );
    CREATE TABLE IF NOT EXISTS active_sessions (
      user_id TEXT PRIMARY KEY,
      join_time TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const columns = database.sqlite
    .query<{ name: string }, []>("PRAGMA table_info(voice_sessions)")
    .all()
    .map((column) => column.name);
  if (!columns.includes("game_name")) database.sqlite.exec("ALTER TABLE voice_sessions ADD COLUMN game_name TEXT");
}

export function startActiveSession(database: OpenDatabase, userId: string, joinTime: Date): void {
  database.sqlite
    .query("INSERT OR REPLACE INTO active_sessions (user_id, join_time) VALUES (?, ?)")
    .run(userId, joinTime.toISOString());
}

export function endActiveSession(database: OpenDatabase, userId: string): Date | null {
  const row = database.sqlite
    .query<DateRow, [string]>("SELECT join_time FROM active_sessions WHERE user_id = ?")
    .get(userId);
  if (!row) return null;
  database.sqlite.query("DELETE FROM active_sessions WHERE user_id = ?").run(userId);
  return new Date(row.join_time);
}

export function getAllActiveSessions(database: OpenDatabase): ActiveSession[] {
  return database.sqlite
    .query<ActiveSessionRow, []>("SELECT CAST(user_id AS TEXT) AS user_id, join_time FROM active_sessions")
    .all()
    .map((row) => ({ userId: row.user_id, joinTime: new Date(row.join_time) }));
}

export function getCacheLastUpdated(database: OpenDatabase, key: string): Date | null {
  const row = database.sqlite
    .query<DateRow, [string]>("SELECT last_updated AS join_time FROM cache_info WHERE key = ?")
    .get(key);
  return row ? new Date(row.join_time) : null;
}

export function setCacheLastUpdated(database: OpenDatabase, key: string, date = new Date()): void {
  database.sqlite
    .query("INSERT OR REPLACE INTO cache_info (key, last_updated) VALUES (?, ?)")
    .run(key, date.toISOString());
}

export function updateSteamApps(database: OpenDatabase, apps: readonly SteamApp[]): void {
  const insert = database.sqlite.query("INSERT OR IGNORE INTO steam_apps (appid, name) VALUES (?, ?)");
  database.sqlite.exec("BEGIN");
  try {
    database.sqlite.exec("DELETE FROM steam_apps");
    for (const app of apps) insert.run(app.appid, app.name);
    database.sqlite.exec("COMMIT");
  } catch (error) {
    database.sqlite.exec("ROLLBACK");
    throw error;
  }
}

export function getSteamAppId(database: OpenDatabase, gameName: string): number | null {
  const row = database.sqlite
    .query<SteamAppIdRow, [string]>("SELECT appid FROM steam_apps WHERE name = ? LIMIT 1")
    .get(gameName);
  return row?.appid ?? null;
}

export function grantAchievement(database: OpenDatabase, userId: string, achievement: string): boolean {
  const result = database.sqlite
    .query("INSERT OR IGNORE INTO achievements (user_id, achievement) VALUES (?, ?)")
    .run(userId, achievement);
  return result.changes > 0;
}

export function getTopGamesForUser(database: OpenDatabase, userId: string, limit = 3): Array<[string, number]> {
  return database.sqlite
    .query<{ game_name: string; total_time: number }, [string, number]>(
      "SELECT game_name, SUM(duration_seconds) AS total_time FROM voice_sessions " +
        "WHERE user_id = ? AND game_name IS NOT NULL AND game_name != 'Unknown' " +
        "GROUP BY game_name ORDER BY total_time DESC LIMIT ?",
    )
    .all(userId, limit)
    .map((row) => [row.game_name, row.total_time]);
}

export function getTopUsers(database: OpenDatabase, limit = 15): TopUserRow[] {
  return database.sqlite
    .query<TopUserRow, [number]>(
      "SELECT name, total_seconds, telegram_id FROM users " +
        "WHERE total_seconds > 0 ORDER BY total_seconds DESC LIMIT ?",
    )
    .all(limit);
}

export function getTotalVoiceTime(database: OpenDatabase): number {
  const row = database.sqlite
    .query<{ total: number | null }, []>("SELECT SUM(total_seconds) AS total FROM users")
    .get();
  return row?.total ?? 0;
}

export function getDetailedDailySessions(database: OpenDatabase, dayStartTime: Date): DetailedSession[] {
  return database.sqlite
    .query<DetailedSessionRow, [string]>(
      "SELECT CAST(u.id AS TEXT) AS id, u.name, u.telegram_id, vs.start_time, vs.duration_seconds, vs.game_name " +
        "FROM voice_sessions vs JOIN users u ON u.id = vs.user_id " +
        "WHERE vs.start_time >= ? ORDER BY u.name, vs.start_time",
    )
    .all(dayStartTime.toISOString())
    .map((row) => ({
      userId: row.id,
      name: row.name,
      telegramId: row.telegram_id,
      startTime: new Date(row.start_time),
      seconds: row.duration_seconds,
      gameName: row.game_name,
    }));
}

export function getUserAchievements(database: OpenDatabase, userId: string): string[] {
  return database.sqlite
    .query<AchievementRow, [string]>("SELECT DISTINCT achievement FROM achievements WHERE user_id = ?")
    .all(userId)
    .map((row) => row.achievement);
}

export function setState(database: OpenDatabase, key: string, value: string): void {
  database.sqlite
    .query(
      "INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .run(key, value, new Date().toISOString());
}

export function getState(database: OpenDatabase, key: string): string | null {
  const row = database.sqlite.query<StateRow, [string]>("SELECT value FROM app_state WHERE key = ?").get(key);
  return row?.value ?? null;
}

export function addVoiceSession(
  database: OpenDatabase,
  userId: string,
  startTime: Date,
  durationSeconds: number,
  gameName: string,
): void {
  database.sqlite
    .query("INSERT INTO voice_sessions (user_id, start_time, duration_seconds, game_name) VALUES (?, ?, ?, ?)")
    .run(userId, startTime.toISOString(), Math.max(0, Math.floor(durationSeconds)), gameName);
}

export function getDailyStats(database: OpenDatabase, dayStartTime: Date): DailyStat[] {
  return database.sqlite
    .query<DailyStatRow, [string]>(
      "SELECT CAST(u.id AS TEXT) AS id, u.name, u.telegram_id, SUM(vs.duration_seconds) AS seconds " +
        "FROM voice_sessions vs JOIN users u ON vs.user_id = u.id " +
        "WHERE vs.start_time >= ? GROUP BY vs.user_id ORDER BY seconds DESC",
    )
    .all(dayStartTime.toISOString())
    .map((row) => ({
      userId: row.id,
      name: row.name,
      telegramId: row.telegram_id,
      seconds: row.seconds,
    }));
}

export function getTelegramIdByDiscordId(database: OpenDatabase, discordId: string): number | null {
  const row = database.sqlite
    .query<{ telegram_id: number | null }, [string]>("SELECT telegram_id FROM users WHERE id = ?")
    .get(discordId);
  return row?.telegram_id ?? null;
}

export function linkSteamAccount(database: OpenDatabase, discordId: string, steamId: string): void {
  database.sqlite.query("INSERT OR IGNORE INTO users (id, name) VALUES (?, ?)").run(discordId, `user_${discordId}`);
  database.sqlite.query("UPDATE users SET steam_id = ? WHERE id = ?").run(steamId, discordId);
}

export function getSteamId(database: OpenDatabase, discordId: string): string | null {
  const row = database.sqlite
    .query<{ steam_id: string | null }, [string]>("SELECT steam_id FROM users WHERE id = ?")
    .get(discordId);
  return row?.steam_id ?? null;
}

export function createLinkingCode(database: OpenDatabase, code: string, discordId: string): void {
  database.sqlite
    .query("INSERT OR REPLACE INTO linking_codes (code, discord_id, expires_at) VALUES (?, ?, ?)")
    .run(code, discordId, new Date(Date.now() + 5 * 60_000).toISOString());
}

export function findDiscordIdByCode(database: OpenDatabase, code: string): string | null {
  const row = database.sqlite
    .query<{ discord_id: string; expires_at: string }, [string]>(
      "SELECT CAST(discord_id AS TEXT) AS discord_id, expires_at FROM linking_codes WHERE code = ?",
    )
    .get(code);
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row.discord_id;
}

export function linkTelegramAccount(database: OpenDatabase, discordId: string, telegramId: number): void {
  database.sqlite.query("UPDATE users SET telegram_id = ? WHERE id = ?").run(telegramId, discordId);
}

export function getDiscordIdByTelegramId(database: OpenDatabase, telegramId: number): string | null {
  const row = database.sqlite
    .query<{ id: string }, [number]>("SELECT CAST(id AS TEXT) AS id FROM users WHERE telegram_id = ?")
    .get(telegramId);
  return row?.id ?? null;
}

export function deleteLinkingCode(database: OpenDatabase, code: string): void {
  database.sqlite.query("DELETE FROM linking_codes WHERE code = ?").run(code);
}

export function updateStats(
  database: OpenDatabase,
  userId: string,
  userName: string,
  sessionSeconds: number,
  gameName: string,
): void {
  const seconds = Math.max(0, Math.floor(sessionSeconds));
  database.sqlite.query("INSERT OR IGNORE INTO users (id, name) VALUES (?, ?)").run(userId, userName);
  database.sqlite
    .query("UPDATE users SET total_seconds = total_seconds + ?, name = ? WHERE id = ?")
    .run(seconds, userName, userId);
  if (gameName && gameName !== "Unknown") {
    database.sqlite.query("INSERT OR IGNORE INTO games (name) VALUES (?)").run(gameName);
    database.sqlite.query("UPDATE games SET total_seconds = total_seconds + ? WHERE name = ?").run(seconds, gameName);
  }
}

export function getUserStats(database: OpenDatabase, userId: string): UserStatsRow | null {
  return (
    database.sqlite.query<UserStatsRow, [string]>("SELECT total_seconds, name FROM users WHERE id = ?").get(userId) ??
    null
  );
}

export function getTopGames(database: OpenDatabase, limit = 5): TopGameRow[] {
  return database.sqlite
    .query<TopGameRow, [number]>(
      "SELECT name, total_seconds FROM games WHERE total_seconds > 0 ORDER BY total_seconds DESC LIMIT ?",
    )
    .all(limit);
}

export function getWeeklyKing(database: OpenDatabase): string | null {
  const row = database.sqlite
    .query<{ name: string }, []>("SELECT name FROM users ORDER BY total_seconds DESC LIMIT 1")
    .get();
  return row?.name ?? null;
}

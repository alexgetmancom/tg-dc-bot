import type { AppConfig } from "./config.js";
import { log } from "./logger.js";
import type { OpenDatabase } from "./storage/database.js";
import { getCacheLastUpdated, getSteamAppId, setCacheLastUpdated, updateSteamApps } from "./storage/database.js";

const MOSCOW_TIME_ZONE = "Europe/Moscow";
const MARKDOWN_SPECIAL_CHARACTERS = /([\\_*[\]()~`>#+\-.=|{}!])/g;

type SteamAppListResponse = { applist?: { apps?: Array<{ appid?: number; name?: string }> } };
type SteamSummaryResponse = { response?: { players?: Array<{ gameextrainfo?: string }> } };

export function getDayStartTime(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MOSCOW_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  return new Date(Date.UTC(year, month - 1, day) - 3 * 60 * 60 * 1000);
}

export function formatDuration(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  if (totalSeconds < 60) return "less than a minute";
  const [days, dayRemainder] = divmod(totalSeconds, 86_400);
  const [hours, hourRemainder] = divmod(dayRemainder, 3_600);
  const [minutes] = divmod(hourRemainder, 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} d`);
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0) parts.push(`${minutes} min`);
  return parts.length > 0 ? parts.join(" ") : "less than a minute";
}

export function isQuietHours(now = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: MOSCOW_TIME_ZONE, hour: "numeric", hour12: false }).format(now),
  );
  return hour >= 2 && hour < 10;
}

export function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIAL_CHARACTERS, "\\$1");
}

export function steamAppUrl(database: OpenDatabase, gameName: string | undefined): string | null {
  if (!gameName || gameName === "Unknown") return null;
  const appId = getSteamAppId(database, gameName);
  return appId === null ? null : `https://store.steampowered.com/app/${appId}/`;
}

export async function fetchSteamAppListToDatabase(database: OpenDatabase): Promise<void> {
  const lastUpdated = getCacheLastUpdated(database, "steam_apps");
  if (lastUpdated && Date.now() - lastUpdated.getTime() <= 7 * 86_400_000) {
    log("info", "Steam app cache is current");
    return;
  }

  log("info", "Refreshing Steam app cache");
  try {
    const response = await fetch("https://api.steampowered.com/ISteamApps/GetAppList/v2/", {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Steam returned HTTP ${response.status}`);
    const payload = (await response.json()) as SteamAppListResponse;
    const apps = (payload.applist?.apps ?? [])
      .filter(
        (app): app is { appid: number; name: string } => Number.isInteger(app.appid) && typeof app.name === "string",
      )
      .map((app) => ({ appid: app.appid, name: app.name }));
    if (apps.length === 0) throw new Error("Steam returned an empty app list");
    updateSteamApps(database, apps);
    setCacheLastUpdated(database, "steam_apps");
    log("info", "Steam app cache refreshed", { count: apps.length });
  } catch (error) {
    log("error", "Failed to refresh Steam app cache", { error });
  }
}

export async function getGameFromSteam(config: AppConfig, steamId: string | null): Promise<string | null> {
  if (!steamId || !config.STEAM_API_KEY) return null;
  const params = new URLSearchParams({ key: config.STEAM_API_KEY, steamids: steamId });
  try {
    const response = await fetch(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?${params.toString()}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as SteamSummaryResponse;
    const game = payload.response?.players?.[0]?.gameextrainfo;
    if (game) return game;
  } catch (error) {
    log("debug", "Steam game lookup failed", { error, steamId });
  }
  return null;
}

export async function measurePing(url: string): Promise<number> {
  const startedAt = performance.now();
  try {
    await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return performance.now() - startedAt;
  } catch {
    return -1;
  }
}

export function formatLastSeen(value: string | null, now = new Date()): string {
  if (!value) return "never";
  const seconds = (now.getTime() - new Date(value).getTime()) / 1_000;
  return seconds < 60 ? `${Math.max(0, Math.floor(seconds))} sec. ago` : `${formatDuration(seconds)} ago`;
}

function divmod(value: number, divisor: number): [number, number] {
  return [Math.floor(value / divisor), value % divisor];
}

import type { AppConfig } from "../config.js";

export interface RuntimeStatus {
  botReady: boolean;
  botError: string | null;
  discordReady: boolean;
  discordError: string | null;
}

export function createRuntimeStatus(mode: AppConfig["BOT_MODE"]): RuntimeStatus {
  return {
    botReady: mode !== "polling",
    botError: null,
    discordReady: mode === "http-only",
    discordError: null,
  };
}

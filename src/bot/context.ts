import type { Context } from "grammy";
import type { AppConfig } from "../config.js";
import type { VoiceMonitor } from "../monitor.js";
import type { OpenDatabase } from "../storage/database.js";

export type AppContext = Context & {
  config: AppConfig;
  database: OpenDatabase;
  monitor: VoiceMonitor;
};

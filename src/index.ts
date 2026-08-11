import { configureTelegramBot, createTelegramBot, registerTelegramHandlers, type TelegramRuntime } from "./bot/bot.js";
import { loadConfig } from "./config.js";
import { createDiscordRuntime, type DiscordRuntime } from "./discord.js";
import { createHttpApp } from "./http.js";
import { log } from "./logger.js";
import { VoiceMonitor } from "./monitor.js";
import { stopServerGracefully } from "./runtime/shutdown.js";
import { createRuntimeStatus } from "./runtime/status.js";
import { RuntimeSupervisor } from "./runtime/supervisor.js";
import { startIntervalWorker } from "./runtime/worker.js";
import { migrateDatabase, openDatabase, setState } from "./storage/database.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const database = openDatabase(config.DATABASE_URL);
  migrateDatabase(database);

  const telegram: TelegramRuntime | null = config.BOT_MODE === "http-only" ? null : createTelegramBot(config, database);
  let discord: DiscordRuntime | null = null;
  const monitor = new VoiceMonitor(database, telegram?.bot.api ?? null, config, () => discord?.ping() ?? -1);
  if (telegram) discord = createDiscordRuntime(config, database, monitor);
  if (telegram && discord) registerTelegramHandlers(telegram, config, database, monitor);

  const status = createRuntimeStatus(config.BOT_MODE);
  const app = createHttpApp(config, telegram, database, status);
  const server = Bun.serve({ fetch: app.fetch, hostname: config.BIND_HOST, port: config.PORT });
  const supervisor = new RuntimeSupervisor();
  supervisor.register(
    startIntervalWorker("voice-status", config.WORKER_INTERVAL_SECONDS * 1_000, () => {
      if (monitor.voiceUserCount > 0) monitor.scheduleUpdate();
    }),
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log("info", "Stopping service", { signal });
    await supervisor.stop();
    if (discord) await discord.stop();
    if (telegram?.bot.isRunning()) await telegram.bot.stop();
    await stopServerGracefully(server);
    database.close();
    log("info", "Service stopped");
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  if (telegram) {
    try {
      await configureTelegramBot(telegram);
    } catch (error) {
      log("error", "Failed to configure Telegram commands", { error });
    }
  }

  if (discord) {
    void discord
      .start()
      .then(() => {
        status.discordReady = true;
        status.discordError = null;
        log("info", "Discord client is ready");
      })
      .catch(async (error) => {
        status.discordReady = false;
        status.discordError = error instanceof Error ? error.message : String(error);
        log("error", "Discord client stopped unexpectedly", { error });
        await shutdown("DISCORD_FAILED");
        process.exitCode = 1;
      });
  }

  if (config.BOT_MODE === "polling" && telegram) {
    void telegram.bot
      .start({
        drop_pending_updates: true,
        onStart: () => {
          status.botReady = true;
          status.botError = null;
          log("info", "Telegram polling started");
        },
      })
      .catch(async (error) => {
        status.botReady = false;
        status.botError = error instanceof Error ? error.message : String(error);
        log("error", "Telegram polling stopped unexpectedly", { error });
        await shutdown("TELEGRAM_POLLING_FAILED");
        process.exitCode = 1;
      });
  } else if (config.BOT_MODE === "webhook" && telegram) {
    const webhookSecret = config.TELEGRAM_WEBHOOK_SECRET;
    const publicUrl = config.PUBLIC_WEBHOOK_URL;
    if (!webhookSecret || !publicUrl) throw new Error("Webhook configuration is incomplete");
    await telegram.bot.api.setWebhook(`${publicUrl}/telegram/webhook`, { secret_token: webhookSecret });
    log("info", "Telegram webhook registered", { url: `${publicUrl}/telegram/webhook` });
  } else {
    log("info", "HTTP-only mode enabled");
  }

  setState(database, "last_worker_run", new Date().toISOString());
  log("info", "HTTP server listening", {
    address: `http://${config.BIND_HOST}:${config.PORT}`,
    mode: config.BOT_MODE,
  });
}

void main().catch((error) => {
  log("error", "Service startup failed", { error });
  process.exitCode = 1;
});

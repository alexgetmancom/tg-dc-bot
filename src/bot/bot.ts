import { Bot, type Context } from "grammy";
import type { AppConfig } from "../config.js";
import { log } from "../logger.js";
import type { VoiceMonitor } from "../monitor.js";
import {
  deleteLinkingCode,
  findDiscordIdByCode,
  getState,
  getTopGames,
  getTopUsers,
  getTotalVoiceTime,
  getUserAchievements,
  getWeeklyKing,
  linkTelegramAccount,
  type OpenDatabase,
} from "../storage/database.js";
import { escapeMarkdown, formatDuration, formatLastSeen, measurePing, steamAppUrl } from "../utils.js";
import type { AppContext } from "./context.js";

export type TelegramRuntime = { bot: Bot<AppContext> };

export function createTelegramBot(config: AppConfig, database: OpenDatabase): TelegramRuntime {
  if (!config.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required to create the Telegram bot");

  const bot = new Bot<AppContext>(config.TELEGRAM_BOT_TOKEN, {
    client: { apiRoot: config.TELEGRAM_API_ROOT },
  });
  bot.use(async (context, next) => {
    context.config = config;
    context.database = database;
    await next();
  });
  bot.catch((error) => {
    log("error", "Unhandled Telegram update", { error: error.error, updateId: error.ctx.update.update_id });
  });
  return { bot };
}

export function registerTelegramHandlers(
  runtime: TelegramRuntime,
  config: AppConfig,
  database: OpenDatabase,
  monitor: VoiceMonitor,
): void {
  const { bot } = runtime;

  bot.use(async (context, next) => {
    const userId = context.from?.id;
    if (userId === undefined || !config.ALLOWED_USERS.includes(userId)) {
      log("warn", "Rejected Telegram update from unauthorized user", { userId });
      return;
    }
    context.monitor = monitor;
    await next();
  });

  bot.command("start", async (context) => {
    await sendAndAnimateDelete(
      context,
      "👋 Hello! I notify you about voice activity. Use /help to see available commands.",
    );
  });

  bot.command("help", async (context) => {
    const help =
      "📜 *Available commands:*\n\n" +
      "`/time` - Hall of fame\n" +
      "`/games` - Top 5 games\n" +
      "`/mystats` - My stats\n" +
      "`/king` - Voice king\n" +
      "`/status` - Technical status (admins only)\n" +
      "`/up` - Recreate the status message";
    await sendAndAnimateDelete(context, help, "Markdown");
  });

  bot.command("time", async (context) => {
    const users = getTopUsers(database);
    if (users.length === 0) return deleteIncomingMessage(context);
    const lines = ["*🏆 Hall of fame (Top 15):*", ""];
    users.forEach((user, index) => {
      const link = user.telegram_id
        ? `[${escapeMarkdown(user.name)}](tg://user?id=${user.telegram_id})`
        : escapeMarkdown(user.name);
      lines.push(`*${index + 1}.* ${link} - ${formatDuration(user.total_seconds)}`);
    });
    await sendAndAnimateDelete(context, lines.join("\n"), "Markdown");
  });

  bot.command("games", async (context) => {
    const games = getTopGames(database);
    if (games.length === 0) return deleteIncomingMessage(context);
    const lines = ["*🎮 Top 5 server games:*", ""];
    for (const [index, game] of games.entries()) {
      const url = steamAppUrl(database, game.name);
      const link = url ? `[${escapeMarkdown(game.name)}](${url})` : escapeMarkdown(game.name);
      lines.push(`*${index + 1}.* ${link} - ${formatDuration(game.total_seconds)}`);
    }
    await sendAndAnimateDelete(context, lines.join("\n"), "Markdown");
  });

  bot.command("king", async (context) => {
    const king = getWeeklyKing(database);
    if (!king) return deleteIncomingMessage(context);
    await sendAndAnimateDelete(context, `👑 Current voice king: *${escapeMarkdown(king)}*!`, "Markdown");
  });

  bot.command("mystats", async (context) => {
    const telegramId = context.from?.id;
    if (telegramId === undefined) return deleteIncomingMessage(context);
    const discordId = monitor.getUserByTelegramId(telegramId);
    let text: string;
    if (!discordId) text = "❌ Your Telegram account is not linked.";
    else {
      const stats = monitor.getUserStats(discordId);
      if (!stats) text = "📊 You do not have any stats yet.";
      else {
        const lines = [
          `📊 *Stats for ${escapeMarkdown(stats.name)}:*`,
          "",
          `*Total time:* ${formatDuration(stats.total_seconds)}`,
        ];
        const achievements = getUserAchievements(database, discordId);
        if (achievements.length > 0) {
          lines.push("", "*Achievements:*");
          lines.push(...achievements.map((achievement) => `🏅 ${escapeMarkdown(achievement)}`));
        }
        const games = monitor.getTopGamesForUser(discordId);
        if (games.length > 0) {
          lines.push("", "*Favorite games:*");
          for (const [gameName, seconds] of games) {
            const url = steamAppUrl(database, gameName);
            const link = url ? `[${escapeMarkdown(gameName)}](${url})` : escapeMarkdown(gameName);
            lines.push(`• ${link} - ${formatDuration(seconds)}`);
          }
        }
        text = lines.join("\n");
      }
    }
    await sendAndAnimateDelete(context, text, "Markdown");
  });

  bot.command("confirm", async (context) => {
    const code = context.match?.trim().toUpperCase();
    let text: string;
    if (!code) text = "⚠️ Enter a code. `/confirm ABC-123`";
    else {
      const discordId = findDiscordIdByCode(database, code);
      if (!discordId) text = "❌ The code is invalid or expired.";
      else {
        if (!context.from) return;
        linkTelegramAccount(database, discordId, context.from.id);
        deleteLinkingCode(database, code);
        text = "✅ Success! The accounts are linked.";
      }
    }
    await sendAndAnimateDelete(context, text);
  });

  bot.command("status", async (context) => {
    if (!context.from || !config.ADMIN_USER_IDS.includes(context.from.id)) {
      return deleteIncomingMessage(context);
    }
    const startTime = getState(database, "start_time");
    const uptime = formatDuration((Date.now() - new Date(startTime ?? Date.now()).getTime()) / 1_000);
    const memory = process.memoryUsage().rss / (1024 * 1024);
    const cpu = process.cpuUsage();
    const cpuPercent = ((cpu.user + cpu.system) / 1_000_000) * 100;
    const discordPing = monitor.getDiscordPing();
    const telegramPing = config.TELEGRAM_BOT_TOKEN
      ? await measurePing(`${config.TELEGRAM_API_ROOT}/bot${config.TELEGRAM_BOT_TOKEN}/getMe`)
      : -1;
    const steamPing = await measurePing("https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/");
    const lines = [
      "🤖 *Bot status (v2.0)*",
      "",
      "*Technical data:*",
      `- Uptime: ${uptime}`,
      `- CPU since startup: ${cpuPercent.toFixed(1)}%`,
      `- RAM: ${memory.toFixed(2)} MB`,
      "",
      "*API:*",
      `- Discord: ${discordPing < 0 ? "Disconnected" : `${Math.round(discordPing)} ms`}\n  ${formatLastSeen(getState(database, "last_discord_success"))}`,
      `- Telegram: ${telegramPing < 0 ? "Error" : `${Math.round(telegramPing)} ms`}\n  ${formatLastSeen(getState(database, "last_telegram_success"))}`,
      `- Steam: ${steamPing < 0 ? "Error" : `${Math.round(steamPing)} ms`}`,
      "",
      "*Database stats:*",
      `- Total voice time: ${formatDuration(getTotalVoiceTime(database))}`,
    ];
    await sendAndAnimateDelete(context, lines.join("\n"), "Markdown");
  });

  bot.command("up", async (context) => {
    await deleteIncomingMessage(context);
    await monitor.repostMessage();
  });

  bot.callbackQuery("coming_soon", async (context) => {
    const telegramId = context.from.id;
    const discordId = monitor.getUserByTelegramId(telegramId);
    if (!discordId) {
      await context.answerCallbackQuery({
        text: "❌ Your Telegram account is not linked to Discord.",
        show_alert: true,
      });
      return;
    }
    const stats = monitor.getUserStats(discordId);
    monitor.addComingSoonUser(discordId, stats?.name ?? context.from.first_name);
    await context.answerCallbackQuery("✅ You have been added to the 30-minute waiting list!");
    monitor.scheduleUpdate();
  });

  bot.callbackQuery("daily_stats", async (context) => {
    await context.answerCallbackQuery("Loading daily stats...");
    await monitor.sendOrEditMessage(null, "daily_stats");
  });

  bot.callbackQuery("back_to_main", async (context) => {
    await context.answerCallbackQuery("Returning to monitoring...");
    await monitor.sendOrEditMessage();
  });
}

export async function configureTelegramBot(runtime: TelegramRuntime): Promise<void> {
  await runtime.bot.api.setMyCommands([
    { command: "start", description: "Show the welcome message" },
    { command: "help", description: "List available commands" },
    { command: "time", description: "Show the hall of fame" },
    { command: "games", description: "Show the top games" },
    { command: "mystats", description: "Show my stats" },
    { command: "king", description: "Show the voice king" },
    { command: "confirm", description: "Link Telegram account" },
    { command: "status", description: "Show bot status" },
    { command: "up", description: "Recreate the status message" },
  ]);
}

async function sendAndAnimateDelete(context: Context, text: string, parseMode?: "Markdown"): Promise<void> {
  const chatId = context.chat?.id;
  if (chatId === undefined) return;
  await deleteIncomingMessage(context);
  const message = await context.api.sendMessage(chatId, `${text}\n\n*🗑️ This message will disappear in 60 seconds...*`, {
    ...(parseMode ? { parse_mode: parseMode } : {}),
    link_preview_options: { is_disabled: true },
  });
  const baseOptions = {
    chat_id: message.chat.id,
    message_id: message.message_id,
    base_text: text,
  };
  setTimeout(() => {
    void context.api
      .editMessageText(
        message.chat.id,
        message.message_id,
        `${baseOptions.base_text}\n\n*🗑️ This message will disappear in 30 seconds...*`,
        {
          ...(parseMode ? { parse_mode: parseMode } : {}),
          link_preview_options: { is_disabled: true },
        },
      )
      .catch(() => undefined);
  }, 30_000);
  setTimeout(() => {
    void context.api
      .editMessageText(
        message.chat.id,
        message.message_id,
        `${baseOptions.base_text}\n\n*🗑️ This message will disappear in 10 seconds...*`,
        {
          ...(parseMode ? { parse_mode: parseMode } : {}),
          link_preview_options: { is_disabled: true },
        },
      )
      .catch(() => undefined);
  }, 50_000);
  setTimeout(() => {
    void context.api.deleteMessage(message.chat.id, message.message_id).catch(() => undefined);
  }, 60_000);
}

async function deleteIncomingMessage(context: Context): Promise<void> {
  if (context.chat && context.msg)
    await context.api.deleteMessage(context.chat.id, context.msg.message_id).catch(() => undefined);
}

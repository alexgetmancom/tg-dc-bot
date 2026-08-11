import { type Api, InlineKeyboard } from "grammy";
import { ACHIEVEMENTS, type AppConfig, QUIET_HOURS } from "./config.js";
import { log } from "./logger.js";
import {
  addVoiceSession,
  endActiveSession,
  getDailyStats,
  getDetailedDailySessions,
  getDiscordIdByTelegramId,
  getTelegramIdByDiscordId,
  getTopGamesForUser,
  getUserStats,
  grantAchievement,
  type OpenDatabase,
  setState,
  startActiveSession,
  updateStats,
} from "./storage/database.js";
import { escapeMarkdown, formatDuration, getDayStartTime, isQuietHours, steamAppUrl } from "./utils.js";

export type VoiceActivity = {
  name: string;
  joinTime: Date;
  game: string;
  streaming: boolean;
  video: boolean;
};
export type VoiceStatus = Omit<VoiceActivity, "joinTime" | "name">;

type ComingSoonUser = { name: string; expiresAt: Date };
type StatusMode = "main" | "daily_stats";

export class VoiceMonitor {
  private readonly voiceUsers = new Map<string, VoiceActivity>();
  private readonly comingSoonUsers = new Map<string, ComingSoonUser>();
  private statusMessageId: number | null = null;
  private scheduledTimer: ReturnType<typeof setTimeout> | undefined;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly database: OpenDatabase,
    private readonly telegramApi: Api | null,
    private readonly config: AppConfig,
    private readonly discordPing: (() => number) | undefined = undefined,
  ) {}

  get voiceUserCount(): number {
    return this.voiceUsers.size;
  }

  hasVoiceUser(userId: string): boolean {
    return this.voiceUsers.has(userId);
  }

  startUser(userId: string, name: string, activity: VoiceStatus, joinTime = new Date()): void {
    startActiveSession(this.database, userId, joinTime);
    this.voiceUsers.set(userId, { ...activity, name, joinTime });
  }

  restoreUser(userId: string, name: string, activity: VoiceStatus, joinTime: Date): void {
    this.voiceUsers.set(userId, { ...activity, name, joinTime });
  }

  updateUserStatus(userId: string, name: string, activity: VoiceStatus): boolean {
    const current = this.voiceUsers.get(userId);
    if (!current) return false;
    const changed =
      current.name !== name ||
      current.game !== activity.game ||
      current.streaming !== activity.streaming ||
      current.video !== activity.video;
    this.voiceUsers.set(userId, { ...activity, name, joinTime: current.joinTime });
    return changed;
  }

  async finishUser(userId: string, name: string): Promise<void> {
    const joinTime = endActiveSession(this.database, userId);
    const current = this.voiceUsers.get(userId);
    if (joinTime) {
      const duration = Math.max(0, (Date.now() - joinTime.getTime()) / 1_000);
      const game = current?.game ?? "Unknown";
      addVoiceSession(this.database, userId, joinTime, duration, game);
      updateStats(this.database, userId, name, duration, game);
      await this.checkAchievements(userId, name);
    }
    this.voiceUsers.delete(userId);
  }

  addComingSoonUser(userId: string, name: string): void {
    if (this.voiceUsers.has(userId)) return;
    this.comingSoonUsers.set(userId, { name, expiresAt: new Date(Date.now() + 30 * 60_000) });
    log("info", "User added to coming-soon list", { userId, name });
  }

  async repostMessage(): Promise<void> {
    if (this.telegramApi && this.statusMessageId !== null) {
      const chatId = this.config.TELEGRAM_CHAT_ID;
      if (chatId) {
        try {
          await this.telegramApi.deleteMessage(chatId, this.statusMessageId);
        } catch {
          // The message may have already been deleted by a user.
        }
      }
    }
    this.statusMessageId = null;
    await this.sendOrEditMessage(null, "main", true);
  }

  scheduleUpdate(textOverride: string | null = null, mode: StatusMode = "main", forceCreation = false): void {
    if (this.scheduledTimer) clearTimeout(this.scheduledTimer);
    this.scheduledTimer = setTimeout(() => {
      this.scheduledTimer = undefined;
      this.updateQueue = this.updateQueue
        .then(() => this.sendOrEditMessage(textOverride, mode, forceCreation))
        .catch((error) => log("error", "Status message update failed", { error }));
    }, 2_000);
  }

  async sendOrEditMessage(
    textOverride: string | null = null,
    mode: StatusMode = "main",
    forceCreation = false,
  ): Promise<void> {
    if (!this.telegramApi) return;

    setState(this.database, "voice_users_count", String(this.voiceUsers.size));
    const needsCreation = this.statusMessageId === null;
    if (needsCreation && isQuietHours() && !forceCreation && textOverride === null && mode === "main") {
      log("info", `Quiet hours (${QUIET_HOURS.start}:00–${QUIET_HOURS.end}:00), status creation skipped`);
      return;
    }

    const keyboard = new InlineKeyboard();
    if (mode === "main" && this.voiceUsers.size > 0) {
      keyboard.text("🚶‍♂️ Coming soon", "coming_soon");
    } else if (mode === "main") {
      keyboard.text("📊 Daily stats", "daily_stats");
    } else {
      keyboard.text("⬅️ Back to monitoring", "back_to_main");
    }

    const text = textOverride ?? (mode === "daily_stats" ? this.formatDailyStats() : this.formatStatusMessage());
    const options = {
      parse_mode: "Markdown" as const,
      reply_markup: keyboard,
      disable_notification: true,
      link_preview_options: { is_disabled: true },
    };

    try {
      const chatId = this.config.TELEGRAM_CHAT_ID;
      if (!chatId) return;
      if (this.statusMessageId === null) {
        const message = await this.telegramApi.sendMessage(chatId, text, options);
        this.statusMessageId = message.message_id;
        log("info", "Status message created", { messageId: message.message_id });
      } else {
        await this.telegramApi.editMessageText(chatId, this.statusMessageId, text, options);
        log("debug", "Status message edited", { messageId: this.statusMessageId });
      }
      setState(this.database, "last_telegram_success", new Date().toISOString());
    } catch (error) {
      const errorText = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (errorText.includes("message is not modified")) return;
      if (errorText.includes("message to edit not found") || errorText.includes("message_id_invalid")) {
        this.statusMessageId = null;
        await this.sendOrEditMessage(text, mode, true);
        return;
      }
      this.statusMessageId = null;
      log("error", "Telegram status message failed", { error });
    }
  }

  private formatStatusMessage(): string {
    const now = new Date();
    const lines = [this.voiceUsers.size > 0 ? "🟢 **Online:**" : "🔴 **Offline**"];
    const sortedUsers = [...this.voiceUsers.entries()].sort(
      ([, left], [, right]) => left.joinTime.getTime() - right.joinTime.getTime(),
    );

    for (const [userId, user] of sortedUsers) {
      this.comingSoonUsers.delete(userId);
      const telegramId = getTelegramIdByDiscordId(this.database, userId);
      const link = this.userLink(user.name, telegramId);
      const status = `${user.video ? " 🎥" : ""}${user.streaming ? " 🔴" : ""}`;
      const gameUrl = steamAppUrl(this.database, user.game);
      const game = gameUrl
        ? ` (playing [${escapeMarkdown(user.game)}](${gameUrl}))`
        : user.game !== "Unknown"
          ? ` (playing *${escapeMarkdown(user.game)}*)`
          : "";
      const duration = formatDuration((now.getTime() - user.joinTime.getTime()) / 1_000);
      lines.push(`• ${link}${status} - ${duration}${game}`);
    }

    for (const [userId, user] of this.comingSoonUsers) {
      if (now > user.expiresAt) {
        this.comingSoonUsers.delete(userId);
        log("info", "Coming-soon entry expired", { userId, name: user.name });
      }
    }

    const todayStats = getDailyStats(this.database, getDayStartTime());
    const finishedUsers = todayStats.filter((stat) => !this.voiceUsers.has(stat.userId));
    if (this.voiceUsers.size === 0 && (this.comingSoonUsers.size > 0 || finishedUsers.length > 0)) lines.push("");
    if (this.comingSoonUsers.size > 0) {
      lines.push("🚶‍♂️ **Coming soon:**");
      for (const [userId, user] of this.comingSoonUsers) {
        lines.push(`• ${this.userLink(user.name, getTelegramIdByDiscordId(this.database, userId))}`);
      }
      lines.push("");
    }
    if (finishedUsers.length > 0) {
      lines.push("🗓 **Earlier today:**");
      for (const stat of finishedUsers) {
        lines.push(`• ${this.userLink(stat.name, stat.telegramId)} - ${formatDuration(stat.seconds)}`);
      }
    }
    return lines.join("\n").trim();
  }

  private formatDailyStats(): string {
    const sessions = getDetailedDailySessions(this.database, getDayStartTime());
    if (sessions.length === 0) return "📊 **Daily stats**\n\nThere are no completed sessions today yet.";

    const lines = ["📊 **Daily stats**", ""];
    let currentUserId: string | null = null;
    for (const session of sessions) {
      if (session.userId !== currentUserId) {
        currentUserId = session.userId;
        lines.push(`**${this.userLink(session.name, session.telegramId)}**`);
      }
      if (session.seconds >= 15 * 60) {
        const game = session.gameName && session.gameName !== "Unknown" ? ` — ${escapeMarkdown(session.gameName)}` : "";
        lines.push(`• ${formatDuration(session.seconds)}${game}`);
      }
    }
    return lines.join("\n");
  }

  private userLink(name: string, telegramId: number | null): string {
    return telegramId ? `[${escapeMarkdown(name)}](tg://user?id=${telegramId})` : escapeMarkdown(name);
  }

  private async checkAchievements(userId: string, name: string): Promise<void> {
    const stats = getUserStats(this.database, userId);
    const chatId = this.config.TELEGRAM_CHAT_ID;
    if (!stats || !this.telegramApi || !chatId) return;
    for (const [requiredSecondsText, achievementName] of Object.entries(ACHIEVEMENTS)) {
      if (
        stats.total_seconds < Number(requiredSecondsText) ||
        !grantAchievement(this.database, userId, achievementName)
      ) {
        continue;
      }
      await this.telegramApi.sendMessage(
        chatId,
        `🎉 **New achievement!**\nUser **${escapeMarkdown(name)}** unlocked: **${achievementName}**`,
        { parse_mode: "Markdown", link_preview_options: { is_disabled: true } },
      );
      setState(this.database, "last_telegram_success", new Date().toISOString());
    }
  }

  getUserByTelegramId(telegramId: number): string | null {
    return getDiscordIdByTelegramId(this.database, telegramId);
  }

  getDiscordPing(): number {
    return this.discordPing ? this.discordPing() : -1;
  }

  getUserStats(userId: string) {
    return getUserStats(this.database, userId);
  }

  getTopGamesForUser(userId: string, limit = 3): Array<[string, number]> {
    return getTopGamesForUser(this.database, userId, limit);
  }
}

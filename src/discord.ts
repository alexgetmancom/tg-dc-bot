import {
  ActivityType,
  ApplicationCommandOptionType,
  Client,
  type Client as DiscordClient,
  Events,
  GatewayIntentBits,
  type GuildMember,
  type Interaction,
  type Presence,
  type VoiceState,
} from "discord.js";
import type { AppConfig } from "./config.js";
import { log } from "./logger.js";
import type { VoiceMonitor, VoiceStatus } from "./monitor.js";
import {
  addVoiceSession,
  createLinkingCode,
  endActiveSession,
  getAllActiveSessions,
  getSteamId,
  linkSteamAccount,
  type OpenDatabase,
  setState,
  updateStats,
} from "./storage/database.js";
import { fetchSteamAppListToDatabase, getGameFromSteam } from "./utils.js";

export type DiscordRuntime = {
  client: Client;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  ping: () => number;
};

export function createDiscordRuntime(config: AppConfig, database: OpenDatabase, monitor: VoiceMonitor): DiscordRuntime {
  if (!config.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN is required to create the Discord bot");

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildPresences,
    ],
  });

  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  client.once(Events.ClientReady, (readyClient) => {
    void restoreVoiceState(readyClient)
      .then(() => resolveReady())
      .catch((error) => {
        log("error", "Discord state restoration failed", { error });
        rejectReady(error);
      });
  });
  client.on(Events.Error, (error) => log("error", "Discord client error", { error }));
  client.on(Events.InteractionCreate, (interaction) => void handleInteraction(interaction));
  client.on(Events.VoiceStateUpdate, (before, after) => void handleVoiceStateUpdate(before, after));
  client.on(Events.PresenceUpdate, (before, after) => void handlePresenceUpdate(before, after));

  async function start(): Promise<void> {
    setState(database, "start_time", new Date().toISOString());
    await client.login(config.DISCORD_TOKEN);
    await ready;
  }

  async function stop(): Promise<void> {
    client.destroy();
  }

  async function restoreVoiceState(readyClient: DiscordClient<true>): Promise<void> {
    await readyClient.application.commands.set([
      {
        name: "link",
        description: "Link Steam and Telegram accounts",
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: "steam_id",
            description: "Your unique SteamID64",
            required: true,
          },
        ],
      },
    ]);

    const membersInVoice = new Map<string, GuildMember>();
    for (const guild of readyClient.guilds.cache.values()) {
      try {
        await guild.members.fetch();
      } catch (error) {
        log("warn", "Could not fetch all Discord guild members", { guildId: guild.id, error });
      }
      for (const member of guild.members.cache.values()) {
        if (member.voice.channel && !member.user.bot) membersInVoice.set(member.id, member);
      }
    }

    setState(database, "last_discord_success", new Date().toISOString());
    for (const session of getAllActiveSessions(database)) {
      const member = membersInVoice.get(session.userId);
      if (member) {
        monitor.restoreUser(session.userId, member.displayName, await readActivity(member), session.joinTime);
      } else {
        const endedAt = endActiveSession(database, session.userId);
        if (endedAt) {
          const duration = Math.max(0, (Date.now() - endedAt.getTime()) / 1_000);
          addVoiceSession(database, session.userId, endedAt, duration, "Unknown");
          updateStats(database, session.userId, `user_${session.userId}`, duration, "Unknown");
        }
      }
    }

    for (const member of membersInVoice.values()) {
      if (monitor.hasVoiceUser(member.id)) continue;
      await monitor.startUser(member.id, member.displayName, await readActivity(member));
    }

    log("info", "Discord voice state restored", { users: monitor.voiceUserCount });
    monitor.scheduleUpdate(null, "main", true);
    void fetchSteamAppListToDatabase(database);
  }

  async function handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "link") return;

    const steamId = interaction.options.getString("steam_id", true);
    const code = `${randomCode(3)}-${randomCode(3)}`;
    linkSteamAccount(database, interaction.user.id, steamId);
    createLinkingCode(database, code, interaction.user.id);
    try {
      await interaction.user.send(
        `👋 Hello! Your Steam account \`${steamId}\` has been linked successfully.\n\n` +
          "Now send `/confirm` with this code to the Telegram bot:\n\n" +
          `**${code}**\n\nThe code is valid for 5 minutes.`,
      );
      await interaction.reply({
        content: "✅ The Telegram linking code was sent in a direct message.",
        ephemeral: true,
      });
    } catch {
      await interaction.reply({
        content: "❌ I cannot send you a direct message. Enable direct messages in your privacy settings.",
        ephemeral: true,
      });
    }
  }

  async function handleVoiceStateUpdate(before: VoiceState, after: VoiceState): Promise<void> {
    const member = after.member ?? before.member;
    if (!member || member.user.bot) return;
    setState(database, "last_discord_success", new Date().toISOString());

    if (!before.channel && after.channel) {
      await monitor.startUser(member.id, member.displayName, await readActivity(member));
      monitor.scheduleUpdate();
      return;
    }
    if (before.channel && !after.channel) {
      await monitor.finishUser(member.id, member.displayName);
      monitor.scheduleUpdate();
      return;
    }
    if (before.channelId !== after.channelId) monitor.scheduleUpdate();
  }

  async function handlePresenceUpdate(_before: Presence | null, after: Presence): Promise<void> {
    const member = after.member;
    if (!member || !monitor.hasVoiceUser(member.id)) return;
    const changed = monitor.updateUserStatus(member.id, member.displayName, await readActivity(member));
    if (changed) monitor.scheduleUpdate();
  }

  async function readActivity(member: GuildMember): Promise<VoiceStatus> {
    const playingGame =
      member.presence?.activities.find((activity) => activity.type === ActivityType.Playing)?.name ?? "Unknown";
    const steamGame = await getGameFromSteam(config, getSteamId(database, member.id));
    if (steamGame) setState(database, "last_steam_success", new Date().toISOString());
    return {
      game: steamGame ?? playingGame,
      streaming: member.voice.streaming ?? false,
      video: member.voice.selfVideo ?? false,
    };
  }

  return {
    client,
    start,
    stop,
    ping: () => (client.isReady() ? client.ws.ping : -1),
  };
}

function randomCode(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)] ?? "A").join("");
}

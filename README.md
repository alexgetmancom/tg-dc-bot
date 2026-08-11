# Discord & Telegram Voice Activity Bot

A TypeScript/Bun bot that tracks members in Discord voice channels and updates a single status message in Telegram.

## Features

- restores active voice sessions after a restart;
- tracks time by user and game in SQLite;
- Discord `/link` command for linking Steam and Telegram accounts;
- Telegram commands `/time`, `/games`, `/mystats`, `/king`, `/confirm`, `/status`, and `/up`;
- coming-soon list, achievements, and daily statistics;
- Steam app cache and links to game pages;
- quiet hours for creating a new status message: 02:00–10:00 Moscow time;
- Hono `/healthz` and `/readyz`, graceful shutdown, and JSON logs in production.

## Getting started

Bun 1.3.14 or newer is required.

```bash
cp .env.example .env
bun install
bun run dev
```

For production:

```bash
bun run check
docker compose up --build -d
docker compose logs -f
```

Set these values in `.env`:

```dotenv
BOT_MODE=polling
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCORD_TOKEN=
ALLOWED_USERS=12345678,98765432
ADMIN_USER_IDS=12345678
STEAM_API_KEY=
```

`ALLOWED_USERS` is required when the bots are enabled. It is the closed list of Telegram users allowed to use commands. `ADMIN_USER_IDS` is a separate list for `/status`. Webhook mode also requires `TELEGRAM_WEBHOOK_SECRET` and `PUBLIC_WEBHOOK_URL`.

The Discord application needs the `Guild Members`, `Guild Presences`, and `Guild Voice States` intents. Without them, member restoration and game updates will not work.

## Data

SQLite is stored at `./data/voice_stats.db` by default. Compose mounts `./data` to `/app/data`. The schema keeps the tables from the former Python bot, so an existing database can be used by setting `DATABASE_URL`. Discord identifiers are handled as strings to preserve Snowflake precision.

## Structure

```text
src/
  config.ts              env → Zod → typed AppConfig
  index.ts               composition, startup, and shutdown
  discord.ts             Discord.js events and the /link slash command
  monitor.ts             voice state, statistics, and the Telegram status message
  utils.ts               Steam integration, formatting, and time zone helpers
  bot/bot.ts             grammY commands, callbacks, and auth middleware
  storage/database.ts    SQLite schema and data operations
  http.ts                health, readiness, and webhook endpoints
  runtime/               supervisor, worker, status, and graceful shutdown
```

Run individual checks with `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run build`, or run them all with `bun run check`.

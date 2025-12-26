# Local Setup Guide

## Prerequisites
- Node.js 22.12+
- `yt-dlp` and `ffmpeg` available in PATH
- A Discord application with a bot token

## Discord Portal Checklist
1) Copy the bot token (Bot tab) and Application ID.
2) Enable "Message Content Intent" (needed for mention commands).
3) Create an OAuth2 URL with `bot` + `applications.commands` scopes and invite the bot.

## Install and Run
1) Create `.env` from `.env.example`:
   - `DISCORD_TOKEN=...`
   - `CLIENT_ID=...` (Application ID)
   - `GUILD_ID=...` (optional, speeds up command registration)
   - `LOG_LEVEL=info` (optional)
   - `DEFAULT_VOLUME=100` (optional)
   - `IDLE_DISCONNECT_SECONDS=300` (optional)
2) Install dependencies:

```sh
npm install
```

3) Register slash commands:

```sh
npm run register-commands
```

4) Start the bot:

```sh
npm start
```

## Quick Test
1) Join a voice channel in your test server.
2) Run `/play <url>` or mention the bot:

```text
@Danny the DJ play https://www.youtube.com/shorts/QlKRD2bqTiQ
```

## Troubleshooting
- If slash commands do not appear, re-run `npm run register-commands`.
- If audio fails, confirm `yt-dlp` and `ffmpeg` run in your terminal.

## Docker Notes
Docker files are included and install `yt-dlp` + `ffmpeg`.

Build and run:

```sh
docker build -t musicbot .
docker run --env-file .env musicbot
```

Or via Compose:

```sh
docker compose up --build
```

# Danny the DJ

[![CI](https://github.com/deanyo/dannythedj/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/deanyo/dannythedj/actions/workflows/ci.yml)
[![Docker](https://github.com/deanyo/dannythedj/actions/workflows/docker.yml/badge.svg?branch=main)](https://github.com/deanyo/dannythedj/actions/workflows/docker.yml)
[![Publish](https://github.com/deanyo/dannythedj/actions/workflows/publish.yml/badge.svg?branch=main)](https://github.com/deanyo/dannythedj/actions/workflows/publish.yml)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

![Danny the DJ icon](https://cdn.discordapp.com/app-icons/721847654186745958/fe00576377c406e8fd327eb3e722b145.png?size=512)

Discord YT music bot focused on YouTube playback via `yt-dlp`. Supports
single videos, Shorts, and playlist URLs. Commands work as slash commands
(`/play`) or by mentioning the bot (e.g. `@Danny the DJ play <url>`).

## Requirements

- Node.js 22.12+
- `yt-dlp` in PATH
- `ffmpeg` in PATH
- Discord bot token + application client ID
- Message Content intent enabled in the Discord dev portal (for mention commands)

## Setup

1) Copy `.env.example` to `.env` and fill in:
   - `DISCORD_TOKEN` (Bot token from the Discord portal)
   - `CLIENT_ID` (Application ID)
   - `GUILD_ID` (optional, for faster command registration in a test server)
2) Install dependencies:

```sh
npm install
```

3) Register slash commands:

```sh
npm run register-commands
```

4) Run the bot:

```sh
npm start
```

## Quick Local Test

1) Install runtime deps:

```sh
brew install yt-dlp ffmpeg
```

2) Add the bot to your server (OAuth2 URL with `bot` and `applications.commands` scopes).
3) Enable "Message Content Intent" in the Discord portal (for mention commands).
4) Register commands and start the bot:

```sh
npm run register-commands
npm start
```

5) In a voice channel, run:
   - `/play https://www.youtube.com/watch?v=...`
   - or `@Danny the DJ play https://www.youtube.com/shorts/QlKRD2bqTiQ`

## Usage

- Slash commands: `/play <url>`, `/skip`, `/pause`, `/resume`, `/stop`, `/queue`, `/now`, `/pump`, `/lulaye`, `/about`, `/debug`
- Mention commands: `@Bot play <url>`, `@Bot skip`, `@Bot queue`

If you pass text instead of a URL, the bot uses `yt-dlp` search (`ytsearch1:`)
and queues the first result.

`/debug` requires Manage Server permissions and responds ephemerally.

## Optional Configuration

- `LOG_LEVEL`: `info` (default) or `debug`
- `HEALTHCHECK_PATH`: file updated by the bot for container healthchecks
- `HEALTHCHECK_MAX_AGE_SECONDS`: max age before healthcheck fails (default 120)

## Additional Docs

- `docs/SETUP.md` for a full local setup checklist and troubleshooting notes.
- `docs/PORTAINER.md` for Portainer deployment steps on an x86_64 NAS.

## Docker

Build and run the bot with Docker:

```sh
docker build -t musicbot .
docker run --env-file .env musicbot
```

Or use Docker Compose:

```sh
docker compose up --build
```

To pull the published image (GHCR):

```sh
docker pull ghcr.io/deanyo/dannythedj:latest
docker run --env-file .env ghcr.io/deanyo/dannythedj:latest
```

To publish a versioned image, create a git tag like `v1.0.0` and push it.
GHCR will receive both `v1.0.0` and the commit SHA tags automatically.

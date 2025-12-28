# Local Setup Guide

## Prerequisites
- Node.js 22.12+
- `yt-dlp` and `ffmpeg` available in PATH
- `deno` available in PATH (required for reliable YouTube extraction)
- A Discord application with a bot token

Example (macOS):
```sh
brew install yt-dlp ffmpeg deno
```

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
   - `IDLE_DISCONNECT_SECONDS=5` (optional)
   - `STREAM_START_TIMEOUT_MS=15000` (optional)
   - `PLAYLIST_LIMIT=50` (optional, 0 = unlimited)
   - `YTDLP_COOKIES_PATH=/path/to/youtube-cookies.txt` (optional)
   - `YTDLP_COOKIES_FROM_BROWSER=chrome` (optional)
   - `YTDLP_PROXY=http://user:pass@host:port` (optional)
   - `YTDLP_REMOTE_COMPONENTS=ejs:github` (optional, recommended)
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

## YouTube Cookies (age/region/private videos)
yt-dlp can use your logged-in YouTube session cookies to unlock age-restricted,
private, or region-locked content (if your account has access).

Option A: Export cookies to a file
1) Sign into YouTube in your browser.
2) Use a cookies export extension (for example: "Get cookies.txt" on Chrome,
   or "cookies.txt" on Firefox).
3) Export cookies for `youtube.com` and save the file locally.
4) Set `YTDLP_COOKIES_PATH` to the file path and restart the bot.

Option B: Import cookies from a browser profile
1) Sign into YouTube in your browser.
2) Set `YTDLP_COOKIES_FROM_BROWSER` to a supported browser name such as
   `chrome`, `edge`, or `firefox`.
3) (Optional) Use a specific profile: `chrome:Profile 1`.

Notes
- Keep cookies private; they grant access to your account.
- yt-dlp writes back to the cookie jar; the file must be writable by the bot.
- For Docker, mount the cookies file and point `YTDLP_COOKIES_PATH` to the
  mounted path in the container.
- If you set both `YTDLP_COOKIES_PATH` and `YTDLP_COOKIES_FROM_BROWSER`, the
  bot prefers `YTDLP_COOKIES_PATH`.
- If you see "Signature solving failed", set `YTDLP_REMOTE_COMPONENTS=ejs:github`
  so yt-dlp can download the solver scripts it needs.

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

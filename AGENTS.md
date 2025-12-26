# Repository Guidelines

## Project Structure & Module Organization
- `src/index.js` boots the Discord client and wires commands.
- `src/player.js` owns the guild queue and voice playback.
- `src/yt.js` wraps `yt-dlp` for resolving tracks and streaming audio.
- `src/commands.js` defines slash command schemas.
- `scripts/register-commands.js` registers commands with Discord.
- Configuration lives in `.env` (see `.env.example`).

## Build, Test, and Development Commands
- `npm install` installs dependencies.
- `npm run dev` starts the bot with hot reload (nodemon).
- `npm start` runs the bot normally.
- `npm run register-commands` publishes slash commands (set `CLIENT_ID` and optional `GUILD_ID`).
- `npm test` runs Node's built-in test runner (no tests yet).

## Coding Style & Naming Conventions
- Use 2-space indentation and CommonJS (`require`/`module.exports`).
- Prefer `camelCase` for variables/functions and `PascalCase` for classes (e.g. `GuildQueue`).
- Keep file names lowercase with hyphens if multi-word.

## Testing Guidelines
- No automated tests are in place yet.
- If you add tests, place them under `test/` and name them `*.test.js`, then update `npm test` if needed.

## Commit & Pull Request Guidelines
- No established commit history; use concise, imperative subjects (e.g. `add queue display`).
- Keep PRs focused, include a short summary, and note any manual test steps (e.g. `/play` with a playlist URL).

## Security & Configuration Tips
- Never commit tokens; use `.env` locally and keep `.env.example` updated.
- Runtime dependencies (`yt-dlp`, `ffmpeg`) must exist in PATH; include them in any Docker image.

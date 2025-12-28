# Portainer Deployment Guide

This guide targets an x86_64 NAS (UGREEN DXP2800) and uses Docker Compose in Portainer.
No ports are exposed because the bot only makes outbound connections to Discord.

## Prerequisites
- Docker + Portainer running on the NAS.
- A Discord bot token and Application ID.
- `DISCORD_TOKEN`, `CLIENT_ID`, and optional `GUILD_ID` ready.

## Optional Env File (recommended)
To avoid pasting variables one-by-one in Portainer:
1) Copy `portainer.env.example` to `portainer.env` and fill in values.
2) In the stack editor, use the Environment variables section to load the file.

## Option A: Local Upload + Stack Build
1) In Portainer, open **Stacks** -> **Add stack**.
2) Name the stack (e.g., `musicbot`).
3) Paste the compose file:

```yaml
version: "3.8"

services:
  musicbot:
    build: /path/to/musicbot
    environment:
      DISCORD_TOKEN: ${DISCORD_TOKEN}
      CLIENT_ID: ${CLIENT_ID}
      GUILD_ID: ${GUILD_ID}
    restart: unless-stopped
```

4) Upload the project folder (containing `Dockerfile` and `src/`) to your NAS.
   Example path: `/volume1/docker/musicbot`.
   Update the `build` path above to match your upload location.
5) Under **Environment variables**, add:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `GUILD_ID` (optional)
   - `LOG_LEVEL` (optional, `info` or `debug`)
   - `DEFAULT_VOLUME` (optional, 0-200)
   - `IDLE_DISCONNECT_SECONDS` (optional, seconds)
   - `STREAM_START_TIMEOUT_MS` (optional, ms)
6) Deploy the stack.

## Option B: Private GitHub Repo (Portainer Git Stack)
1) Create a GitHub fine-grained PAT with **Read access** to this repo.
2) In Portainer, open **Stacks** -> **Add stack** -> **Git repository**.
3) Repo URL: `https://github.com/deanyo/dannythedj.git` (branch `main`).
4) Provide Git credentials (username + token) in Portainer.
5) Compose file path: `docker-compose.yml`.
6) Add environment variables in Portainer:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `GUILD_ID` (optional)
   - `LOG_LEVEL` (optional, `info` or `debug`)
   - `DEFAULT_VOLUME` (optional, 0-200)
   - `IDLE_DISCONNECT_SECONDS` (optional, seconds)
   - `STREAM_START_TIMEOUT_MS` (optional, ms)
7) Deploy the stack.

## Option C: GHCR Image (recommended)
1) Ensure the GHCR image exists (published by GitHub Actions).
2) In Portainer, open **Stacks** -> **Add stack**.
3) Paste this compose file (or use `docker-compose.ghcr.yml`):

```yaml
version: "3.8"

services:
  musicbot:
    image: ghcr.io/deanyo/dannythedj:${IMAGE_TAG:-latest}
    environment:
      DISCORD_TOKEN: ${DISCORD_TOKEN}
      CLIENT_ID: ${CLIENT_ID}
      GUILD_ID: ${GUILD_ID}
    restart: unless-stopped
```

4) If the package is private, add **Registry credentials** for GHCR:
   - Registry: `ghcr.io`
   - Username: your GitHub username
   - Password: a PAT with **read:packages**
5) Add environment variables:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `GUILD_ID` (optional)
   - `IMAGE_TAG` (optional, defaults to `latest`; use `v1.2.3` for pinned releases)
   - `LOG_LEVEL` (optional, `info` or `debug`)
   - `DEFAULT_VOLUME` (optional, 0-200)
   - `IDLE_DISCONNECT_SECONDS` (optional, seconds)
   - `STREAM_START_TIMEOUT_MS` (optional, ms)
6) Deploy the stack.

## Option D: Prebuild on Mac, Run on NAS
1) Build and tag locally:

```sh
docker build -t musicbot:latest .
```

2) Save and transfer the image to the NAS:

```sh
docker save musicbot:latest | gzip > musicbot.tar.gz
```

3) On the NAS:

```sh
gunzip -c musicbot.tar.gz | docker load
```

4) In Portainer, create a container from `musicbot:latest` and set env vars.

## Runtime Notes
- No volume mounts are required.
- If you use playlist-heavy queues, ensure enough CPU headroom for `yt-dlp`.
- If you mount a cookies file for yt-dlp, mount it read-write so it can update
  the cookie jar.
- To update: rebuild the image and redeploy the stack.

## Updating the Stack
Choose the path that matches how you deployed:

GHCR image (Option C)
1) Open the stack in Portainer and click **Update the stack**.
2) If you use `latest`, check **Pull latest image** and deploy.
3) If you pin a release, update `IMAGE_TAG` (e.g., `v1.2.3`) and deploy.

Git repository stack (Option B)
1) Open the stack and click **Update the stack**.
2) Ensure **Pull latest changes** is enabled, then deploy.

Local build/upload (Option A)
1) Rebuild the image on the NAS or re-upload the repo.
2) Click **Update the stack** to redeploy.

## Troubleshooting
- Bot shows "application did not respond": verify it is running and has
  `Send Messages` + `Use Application Commands` in the channel.
- Audio fails: ensure `yt-dlp` and `ffmpeg` installed inside the container
  (already included in `Dockerfile`).

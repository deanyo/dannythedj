FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV HEALTHCHECK_PATH=/tmp/musicbot-healthcheck
ENV HEALTHCHECK_MAX_AGE_SECONDS=120

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
  && python3 -m pip install --no-cache-dir --break-system-packages yt-dlp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "scripts/healthcheck.js"]

CMD ["node", "src/index.js"]

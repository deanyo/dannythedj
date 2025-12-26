const { readFile } = require('node:fs/promises');

const HEALTHCHECK_PATH =
  process.env.HEALTHCHECK_PATH || '/tmp/musicbot-healthcheck';
const MAX_AGE_SECONDS = Number(process.env.HEALTHCHECK_MAX_AGE_SECONDS) || 120;

async function run() {
  try {
    const contents = await readFile(HEALTHCHECK_PATH, 'utf8');
    const timestamp = Number(contents.trim());
    if (!Number.isFinite(timestamp)) {
      throw new Error('invalid timestamp');
    }
    const ageMs = Date.now() - timestamp;
    if (ageMs > MAX_AGE_SECONDS * 1000) {
      throw new Error(`stale: ${Math.round(ageMs / 1000)}s old`);
    }
    process.exit(0);
  } catch (error) {
    console.error(`Healthcheck failed: ${error.message}`);
    process.exit(1);
  }
}

run();

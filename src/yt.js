const { spawn } = require('node:child_process');
const {
  StreamType,
  createAudioResource,
  demuxProbe
} = require('@discordjs/voice');
const logger = require('./logger');

const URL_PATTERN = /^(https?:\/\/|www\.)/i;

function isLikelyUrl(input) {
  if (!input) {
    return false;
  }
  return URL_PATTERN.test(input) || /youtu\.?be/i.test(input);
}

function isPlaylistEntry(entry) {
  return entry?._type === 'playlist' || entry?.ie_key === 'YoutubePlaylist';
}

function getPlayableUrl(entry) {
  if (!entry) {
    return null;
  }
  if (entry.webpage_url) {
    return entry.webpage_url;
  }
  if (entry.url && /^https?:\/\//i.test(entry.url)) {
    return entry.url;
  }
  if (entry.id) {
    return `https://www.youtube.com/watch?v=${entry.id}`;
  }
  if (entry.url) {
    return `https://www.youtube.com/watch?v=${entry.url}`;
  }
  return null;
}

function toTrack(entry) {
  if (isPlaylistEntry(entry) && !Array.isArray(entry.entries)) {
    return null;
  }
  const url = getPlayableUrl(entry);
  if (!url) {
    return null;
  }
  return {
    title: entry.title || entry.fulltitle || url,
    url,
    duration: Number.isFinite(entry.duration) ? entry.duration : null
  };
}

function runYtDlpJson(input) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--no-call-home',
      input
    ];
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(
        new Error(
          `Failed to start yt-dlp (${error.message}). Is yt-dlp installed and in PATH?`
        )
      );
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`.trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Failed to parse yt-dlp output: ${error.message}`));
      }
    });
  });
}

async function resolveTracks(input) {
  const query = isLikelyUrl(input) ? input : `ytsearch1:${input}`;
  const info = await runYtDlpJson(query);
  const tracks = extractTracks(info);
  if (tracks.length > 0) {
    return tracks;
  }
  const playlistUrl = info?.webpage_url || info?.url;
  if (playlistUrl && /[?&]list=/.test(playlistUrl)) {
    const playlistInfo = await runYtDlpJson(playlistUrl);
    return extractTracks(playlistInfo);
  }
  return [];
}

function getNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const DEFAULT_STREAM_TIMEOUT_MS = getNumberEnv(
  'STREAM_START_TIMEOUT_MS',
  15_000
);

async function createAudioResourceFromUrl(url, volume, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : DEFAULT_STREAM_TIMEOUT_MS;
    const args = [
      '-f',
      'bestaudio',
      '-o',
      '-',
      '--no-warnings',
      '--no-playlist',
      '--quiet',
      url
    ];
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let stderr = '';
    let receivedData = false;
    let timeoutId = null;

    logger.debug(`[yt-dlp] starting for ${url} (timeout ${timeoutMs}ms)`);

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (child && !child.killed) {
        child.kill('SIGKILL');
      }
      reject(error);
    };

    child.on('error', (error) => {
      fail(
        new Error(
          `Failed to start yt-dlp (${error.message}). Is yt-dlp installed and in PATH?`
        )
      );
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2000) {
        stderr = stderr.slice(-2000);
      }
    });

    child.stdout.on('data', () => {
      if (!receivedData) {
        receivedData = true;
        logger.debug(`[yt-dlp] received audio data for ${url}`);
      }
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        const extra = stderr ? ` ${stderr.trim()}` : '';
        fail(new Error(`yt-dlp exited with code ${code}.${extra}`));
        return;
      }
      if (!receivedData) {
        fail(new Error('yt-dlp exited before producing audio data.'));
      }
    });

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        fail(new Error(`yt-dlp timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    }

    demuxProbe(child.stdout)
      .then(({ stream, type }) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        logger.debug(`[yt-dlp] demux probe resolved (${type})`);
        const resource = createAudioResource(stream, {
          inputType: type,
          inlineVolume: true
        });
        if (resource.volume && Number.isFinite(volume)) {
          resource.volume.setVolume(volume);
        }
        resolve({ resource, process: child });
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        logger.warn(
          `[yt-dlp] demux probe failed, falling back to ffmpeg: ${error.message}`
        );
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        const resource = createAudioResource(child.stdout, {
          inputType: StreamType.Arbitrary,
          inlineVolume: true
        });
        if (resource.volume && Number.isFinite(volume)) {
          resource.volume.setVolume(volume);
        }
        settled = true;
        resolve({ resource, process: child });
      });
  });
}

module.exports = {
  createAudioResourceFromUrl,
  resolveTracks
};

function flattenEntries(entries) {
  return entries.flatMap((entry) => {
    if (Array.isArray(entry?.entries)) {
      return flattenEntries(entry.entries);
    }
    return [entry];
  });
}

function extractTracks(info) {
  if (Array.isArray(info?.entries)) {
    return flattenEntries(info.entries).map(toTrack).filter(Boolean);
  }
  const track = toTrack(info);
  return track ? [track] : [];
}

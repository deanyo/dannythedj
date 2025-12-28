const { spawn } = require('node:child_process');
const {
  StreamType,
  createAudioResource,
  demuxProbe
} = require('@discordjs/voice');
const logger = require('./logger');

const URL_PATTERN = /^(https?:\/\/|www\.)/i;
const YTDLP_COOKIES_PATH = process.env.YTDLP_COOKIES_PATH;
const YTDLP_COOKIES_FROM_BROWSER = process.env.YTDLP_COOKIES_FROM_BROWSER;
const YTDLP_PROXY = process.env.YTDLP_PROXY;
const YTDLP_REMOTE_COMPONENTS = process.env.YTDLP_REMOTE_COMPONENTS;
const YTDLP_EXTRA_ARGS = buildYtDlpExtraArgs();

function buildYtDlpExtraArgs() {
  const args = [];
  if (YTDLP_COOKIES_PATH && YTDLP_COOKIES_FROM_BROWSER) {
    logger.warn(
      'Both YTDLP_COOKIES_PATH and YTDLP_COOKIES_FROM_BROWSER are set. Using YTDLP_COOKIES_PATH.'
    );
  }
  if (YTDLP_COOKIES_PATH) {
    args.push('--cookies', YTDLP_COOKIES_PATH);
  } else if (YTDLP_COOKIES_FROM_BROWSER) {
    args.push('--cookies-from-browser', YTDLP_COOKIES_FROM_BROWSER);
  }
  if (YTDLP_PROXY) {
    args.push('--proxy', YTDLP_PROXY);
  }
  if (YTDLP_REMOTE_COMPONENTS) {
    args.push('--remote-components', YTDLP_REMOTE_COMPONENTS);
  }
  return args;
}

function buildYtDlpArgs(args) {
  if (YTDLP_EXTRA_ARGS.length === 0) {
    return args;
  }
  return [...YTDLP_EXTRA_ARGS, ...args];
}

function hasPlaylistParam(url) {
  return /[?&]list=/.test(url);
}

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

function runYtDlpJson(input, options = {}) {
  return new Promise((resolve, reject) => {
    const ignoreErrors = options.ignoreErrors === true;
    const flatPlaylist = options.flatPlaylist === true;
    const playlistStart = normalizePlaylistIndex(options.playlistStart);
    const playlistEnd = normalizePlaylistIndex(options.playlistEnd);
    const args = buildYtDlpArgs([
      '--dump-single-json',
      '--no-warnings',
      ...(flatPlaylist ? ['--flat-playlist'] : []),
      ...(playlistStart ? ['--playlist-start', String(playlistStart)] : []),
      ...(playlistEnd ? ['--playlist-end', String(playlistEnd)] : []),
      ...(ignoreErrors ? ['--ignore-errors'] : []),
      input
    ]);
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
      const trimmedStderr = stderr.trim();
      if (code !== 0) {
        if (ignoreErrors && stdout.trim()) {
          try {
            const parsed = JSON.parse(stdout);
            logger.warn(
              `[yt-dlp] exited with code ${code} but returned partial data. ${trimmedStderr}`
            );
            resolve(parsed);
            return;
          } catch (error) {
            reject(
              new Error(`Failed to parse yt-dlp output: ${error.message}`)
            );
            return;
          }
        }
        reject(
          new Error(
            `yt-dlp exited with code ${code}: ${trimmedStderr || stderr}`.trim()
          )
        );
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

function normalizePlaylistIndex(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const index = Math.floor(value);
  return index > 0 ? index : null;
}

async function resolveTracks(input) {
  const query = isLikelyUrl(input) ? input : `ytsearch1:${input}`;
  const isPlaylistQuery = isLikelyUrl(input) && hasPlaylistParam(input);
  const info = await runYtDlpJson(query, { ignoreErrors: isPlaylistQuery });
  const tracks = extractTracks(info);
  if (tracks.length > 0) {
    return tracks;
  }
  const playlistUrl = info?.webpage_url || info?.url;
  if (playlistUrl && hasPlaylistParam(playlistUrl)) {
    return resolvePlaylistTracks(playlistUrl);
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
    const child = spawn('yt-dlp', buildYtDlpArgs(args), {
      stdio: ['ignore', 'pipe', 'pipe']
    });
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
  resolveTracks,
  resolvePlaylistTracks
};

async function resolvePlaylistTracks(url, options = {}) {
  logger.info(
    '[yt-dlp] resolving playlist with --flat-playlist and --ignore-errors.'
  );
  const playlistInfo = await runYtDlpJson(url, {
    ignoreErrors: true,
    flatPlaylist: options.flatPlaylist !== false,
    playlistStart: options.playlistStart,
    playlistEnd: options.playlistEnd
  });
  return extractTracks(playlistInfo);
}

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

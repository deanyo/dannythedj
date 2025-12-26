const { spawn } = require('node:child_process');
const { createAudioResource, demuxProbe } = require('@discordjs/voice');

const URL_PATTERN = /^(https?:\/\/|www\.)/i;

function isLikelyUrl(input) {
  if (!input) {
    return false;
  }
  return URL_PATTERN.test(input) || /youtu\.?be/i.test(input);
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
  if (Array.isArray(info.entries)) {
    return info.entries.map(toTrack).filter(Boolean);
  }
  const track = toTrack(info);
  return track ? [track] : [];
}

async function createAudioResourceFromUrl(url) {
  return new Promise((resolve, reject) => {
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

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
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

    child.on('close', (code) => {
      if (code !== 0) {
        fail(new Error(`yt-dlp exited with code ${code}.`));
      }
    });

    demuxProbe(child.stdout)
      .then(({ stream, type }) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          resource: createAudioResource(stream, { inputType: type }),
          process: child
        });
      })
      .catch(fail);
  });
}

module.exports = {
  createAudioResourceFromUrl,
  resolveTracks
};

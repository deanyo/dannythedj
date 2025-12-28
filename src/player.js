const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel
} = require('@discordjs/voice');
const { EmbedBuilder, Colors } = require('discord.js');
const { createAudioResourceFromUrl } = require('./yt');
const { getUserFacingError, summarizeError } = require('./errors');
const logger = require('./logger');

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) {
    return '';
  }
  const total = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function buildNowPlayingEmbed(track) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle('Now playing');
  const title = track.title || track.url || 'Unknown';
  const safeTitle = title.length > 200 ? `${title.slice(0, 197)}...` : title;
  const label = track.url ? `[${safeTitle}](${track.url})` : safeTitle;
  embed.setDescription(label);
  const fields = [];
  if (Number.isFinite(track.duration)) {
    fields.push({
      name: 'Duration',
      value: formatDuration(track.duration),
      inline: true
    });
  }
  if (track.requestedBy) {
    fields.push({
      name: 'Requested by',
      value: track.requestedBy,
      inline: true
    });
  }
  if (fields.length) {
    embed.addFields(fields);
  }
  return embed;
}

class GuildQueue {
  constructor(guildId, options = {}) {
    this.guildId = guildId;
    this.queue = [];
    this.current = null;
    this.currentProcess = null;
    this.currentResource = null;
    this.textChannel = null;
    this.processing = false;
    this.connection = null;
    this.idleTimer = null;
    this.idleDisconnectMs = Number.isFinite(options.idleDisconnectMs)
      ? options.idleDisconnectMs
      : 0;
    this.onError = typeof options.onError === 'function' ? options.onError : null;
    this.lastError = null;
    this.volume = Number.isFinite(options.defaultVolume)
      ? options.defaultVolume
      : 1;
    this.streamTimeoutMs = Number.isFinite(options.streamTimeoutMs)
      ? options.streamTimeoutMs
      : 15_000;
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });

    this.player.on(AudioPlayerStatus.Playing, () => {
      logger.debug(`[queue:${this.guildId}] audio player status: playing`);
    });

    this.player.on(AudioPlayerStatus.AutoPaused, () => {
      logger.warn(`[queue:${this.guildId}] audio player auto-paused`);
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this._cleanupProcess();
      this.current = null;
      this._playNext()
        .then(() => {
          if (!this.current && this.queue.length === 0) {
            this._scheduleIdleDisconnect();
          }
        })
        .catch((error) => {
          logger.error(`[queue:${this.guildId}] idle handler failed`, error);
          if (!this.current && this.queue.length === 0) {
            this._scheduleIdleDisconnect();
          }
        });
    });

    this.player.on('error', (error) => {
      logger.error(`[queue:${this.guildId}] audio player error`, error);
      this.recordError('player', error, this.current);
      this._cleanupProcess();
      this.current = null;
      this._playNext().catch((nextError) => {
        logger.error(`[queue:${this.guildId}] recovery failed`, nextError);
      });
    });
  }

  async connect(voiceChannel) {
    if (
      this.connection &&
      this.connection.joinConfig.channelId === voiceChannel.id
    ) {
      return;
    }

    this._clearIdleTimer();
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true
    });
    this.connection.subscribe(this.player);
    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
  }

  setTextChannel(channel) {
    this.textChannel = channel;
  }

  enqueue(tracks, requestedBy) {
    const enriched = tracks.map((track) => ({
      ...track,
      requestedBy: requestedBy?.tag || 'unknown'
    }));
    this.queue.push(...enriched);
    this._clearIdleTimer();
    this._playNext().catch((error) => {
      logger.error(`[queue:${this.guildId}] enqueue failed`, error);
    });
    return enriched.length;
  }

  recordError(context, error, track) {
    const summary = summarizeError(error);
    this.lastError = {
      timestamp: Date.now(),
      context,
      summary,
      track: track
        ? {
            title: track.title,
            url: track.url
          }
        : null
    };
    if (this.onError) {
      this.onError(this.lastError);
    }
  }

  skip() {
    this.player.stop(true);
  }

  pause() {
    return this.player.pause();
  }

  resume() {
    return this.player.unpause();
  }

  stop() {
    this.queue = [];
    this.player.stop(true);
    this._cleanupProcess();
    this.current = null;
  }

  destroy() {
    this.stop();
    this._clearIdleTimer();
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
  }

  async _playNext() {
    if (this.processing) {
      return;
    }
    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }

    this.processing = true;
    let shouldContinue = false;
    try {
      this._clearIdleTimer();
      logger.debug(`[queue:${this.guildId}] starting: ${next.title}`);
      const { resource, process } = await createAudioResourceFromUrl(
        next.url,
        this.volume,
        { timeoutMs: this.streamTimeoutMs }
      );
      this.currentProcess = process;
      this.currentResource = resource;
      this.current = next;
      this.player.play(resource);
      if (this.textChannel) {
        this.textChannel.send({ embeds: [buildNowPlayingEmbed(next)] })
          .catch(() => null);
      }
    } catch (error) {
      logger.error(`[queue:${this.guildId}] failed to play`, error);
      this.recordError('playback', error, next);
      this.current = null;
      this._cleanupProcess();
      if (this.textChannel) {
        const reason = getUserFacingError(error);
        this.textChannel
          .send(
            reason
              ? `Failed to play **${next.title}**. ${reason}`
              : `Failed to play **${next.title}**. Skipping.`
          )
          .catch(() => null);
      }
      shouldContinue = true;
    } finally {
      this.processing = false;
      if (shouldContinue) {
        this._playNext().catch((nextError) => {
          logger.error(`[queue:${this.guildId}] recovery failed`, nextError);
        });
      }
    }
  }

  _cleanupProcess() {
    if (this.currentProcess && !this.currentProcess.killed) {
      this.currentProcess.kill('SIGKILL');
    }
    this.currentProcess = null;
    this.currentResource = null;
  }

  setVolume(volume) {
    if (!Number.isFinite(volume)) {
      return this.volume;
    }
    this.volume = volume;
    if (this.currentResource?.volume) {
      this.currentResource.volume.setVolume(volume);
    }
    return this.volume;
  }

  getVolume() {
    return this.volume;
  }

  _scheduleIdleDisconnect() {
    if (!this.idleDisconnectMs || this.idleTimer || !this.connection) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.queue.length > 0 || this.current) {
        return;
      }
      if (this.textChannel) {
        this.textChannel
          .send('Queue idle. Leaving voice channel.')
          .catch(() => null);
      }
      this.destroy();
    }, this.idleDisconnectMs);
  }

  _clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

module.exports = {
  GuildQueue
};

const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel
} = require('@discordjs/voice');
const { createAudioResourceFromUrl } = require('./yt');
const logger = require('./logger');

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
    this.volume = Number.isFinite(options.defaultVolume)
      ? options.defaultVolume
      : 1;
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this._cleanupProcess();
      this.current = null;
      this._playNext().catch((error) => {
        logger.error(`[queue:${this.guildId}] idle handler failed`, error);
      });
      if (!this.current && this.queue.length === 0) {
        this._scheduleIdleDisconnect();
      }
    });

    this.player.on('error', (error) => {
      logger.error(`[queue:${this.guildId}] audio player error`, error);
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
      const { resource, process } = await createAudioResourceFromUrl(
        next.url,
        this.volume
      );
      this.currentProcess = process;
      this.currentResource = resource;
      this.current = next;
      this.player.play(resource);
      if (this.textChannel) {
        this.textChannel
          .send(
            `Now playing: **${next.title}** (requested by ${next.requestedBy})`
          )
          .catch(() => null);
      }
    } catch (error) {
      logger.error(`[queue:${this.guildId}] failed to play`, error);
      this.current = null;
      this._cleanupProcess();
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

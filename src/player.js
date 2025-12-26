const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel
} = require('@discordjs/voice');
const { createAudioResourceFromUrl } = require('./yt');

class GuildQueue {
  constructor(guildId) {
    this.guildId = guildId;
    this.queue = [];
    this.current = null;
    this.currentProcess = null;
    this.textChannel = null;
    this.processing = false;
    this.connection = null;
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this._cleanupProcess();
      this.current = null;
      this._playNext().catch((error) => {
        console.error(`[queue:${this.guildId}] idle handler failed`, error);
      });
    });

    this.player.on('error', (error) => {
      console.error(`[queue:${this.guildId}] audio player error`, error);
      this._cleanupProcess();
      this.current = null;
      this._playNext().catch((nextError) => {
        console.error(`[queue:${this.guildId}] recovery failed`, nextError);
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
    this._playNext().catch((error) => {
      console.error(`[queue:${this.guildId}] enqueue failed`, error);
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
      const { resource, process } = await createAudioResourceFromUrl(next.url);
      this.currentProcess = process;
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
      console.error(`[queue:${this.guildId}] failed to play`, error);
      this.current = null;
      this._cleanupProcess();
      shouldContinue = true;
    } finally {
      this.processing = false;
      if (shouldContinue) {
        this._playNext().catch((nextError) => {
          console.error(`[queue:${this.guildId}] recovery failed`, nextError);
        });
      }
    }
  }

  _cleanupProcess() {
    if (this.currentProcess && !this.currentProcess.killed) {
      this.currentProcess.kill('SIGKILL');
    }
    this.currentProcess = null;
  }
}

module.exports = {
  GuildQueue
};

require('dotenv').config();

const { writeFile } = require('node:fs/promises');
const {
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField
} = require('discord.js');
const { GuildQueue } = require('./player');
const { resolveTracks } = require('./yt');
const logger = require('./logger');
const packageInfo = require('../package.json');

const PUMP_PLAYLIST_URL =
  'https://www.youtube.com/watch?v=mpG0ax0uAdo&list=PL0nMuMH24oIbUUo0BCFWcPRnQh2zdx2pP';
const LULAYE_URL = 'https://www.youtube.com/watch?v=VKAv2AHIKEw';
const HEALTHCHECK_PATH =
  process.env.HEALTHCHECK_PATH || '/tmp/musicbot-healthcheck';
const DEFAULT_VOLUME_RAW = Number(process.env.DEFAULT_VOLUME);
const DEFAULT_VOLUME_PERCENT = clamp(
  Number.isFinite(DEFAULT_VOLUME_RAW) ? DEFAULT_VOLUME_RAW : 100,
  0,
  200
);
const DEFAULT_VOLUME = DEFAULT_VOLUME_PERCENT / 100;
const IDLE_DISCONNECT_RAW = Number(process.env.IDLE_DISCONNECT_SECONDS);
const IDLE_DISCONNECT_SECONDS = Number.isFinite(IDLE_DISCONNECT_RAW)
  ? IDLE_DISCONNECT_RAW
  : 300;
const IDLE_DISCONNECT_MS =
  Number.isFinite(IDLE_DISCONNECT_SECONDS) && IDLE_DISCONNECT_SECONDS > 0
    ? IDLE_DISCONNECT_SECONDS * 1000
    : 0;

const token = process.env.DISCORD_TOKEN;
if (!token) {
  logger.error('Missing DISCORD_TOKEN in environment.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const queues = new Map();

function getQueue(guildId) {
  let queue = queues.get(guildId);
  if (!queue) {
    queue = new GuildQueue(guildId, {
      idleDisconnectMs: IDLE_DISCONNECT_MS,
      defaultVolume: DEFAULT_VOLUME
    });
    queues.set(guildId, queue);
  }
  return queue;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

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

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) {
    return 'unknown';
  }
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const parts = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0 || parts.length > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || parts.length > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${secs}s`);
  return parts.join(' ');
}

function formatVolumePercent(volume) {
  if (!Number.isFinite(volume)) {
    return 'unknown';
  }
  return Math.round(volume * 100);
}

function formatTrackLine(track, index, options = {}) {
  const duration = formatDuration(track.duration);
  const durationLabel = duration ? ` [${duration}]` : '';
  const requester = options.showRequester && track.requestedBy
    ? ` - requested by ${track.requestedBy}`
    : '';
  const prefix = typeof index === 'number' ? `${index + 1}. ` : '';
  return `${prefix}${track.title}${durationLabel}${requester}`;
}

function buildRequesterSummary(tracks) {
  const counts = new Map();
  tracks.forEach((track) => {
    const key = track.requestedBy || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  if (counts.size === 0) {
    return '';
  }
  const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const parts = entries.map(([name, count]) => `${name} x${count}`);
  return `Requesters: ${parts.join(', ')}`;
}

function buildDurationSummary(tracks) {
  const knownDurations = tracks
    .map((track) => track.duration)
    .filter((duration) => Number.isFinite(duration));
  const totalSeconds = knownDurations.reduce((sum, duration) => sum + duration, 0);
  const unknownCount = tracks.length - knownDurations.length;

  if (totalSeconds <= 0 && unknownCount <= 0) {
    return '';
  }
  if (totalSeconds > 0 && unknownCount > 0) {
    return `Total remaining: ${formatDuration(totalSeconds)} + ${unknownCount} unknown`;
  }
  if (totalSeconds > 0) {
    return `Total remaining: ${formatDuration(totalSeconds)}`;
  }
  return `Total remaining: ${unknownCount} unknown`;
}

function parseVolumePercent(input) {
  if (!Number.isFinite(input)) {
    return null;
  }
  return clamp(input, 0, 200);
}

function buildQueueMessage(queue) {
  if (!queue.current && queue.queue.length === 0) {
    return 'Queue is empty.';
  }

  const lines = [];
  const allTracks = [];
  if (queue.current) {
    lines.push(
      `Now: **${formatTrackLine(queue.current, null, { showRequester: true })}**`
    );
    allTracks.push(queue.current);
  }

  if (queue.queue.length > 0) {
    lines.push('Up next:');
    const upcoming = queue.queue.slice(0, 10);
    upcoming.forEach((track, index) => {
      lines.push(formatTrackLine(track, index, { showRequester: true }));
    });
    allTracks.push(...queue.queue);
    if (queue.queue.length > upcoming.length) {
      lines.push(`...and ${queue.queue.length - upcoming.length} more`);
    }
  }

  const requesterSummary = buildRequesterSummary(allTracks);
  if (requesterSummary) {
    lines.push(requesterSummary);
  }
  const durationSummary = buildDurationSummary(allTracks);
  if (durationSummary) {
    lines.push(durationSummary);
  }

  return lines.join('\n');
}

function createMessageResponder(message) {
  return (content) =>
    message.reply({
      content,
      allowedMentions: { repliedUser: false }
    });
}

function createInteractionResponder(interaction) {
  return (content) => {
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content });
    }
    return interaction.reply({ content });
  };
}

async function handlePlay({ guild, member, channel, reply, input }) {
  if (!guild) {
    return reply('This command only works in a server.');
  }
  if (!input) {
    return reply('Provide a YouTube URL or search text.');
  }
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    return reply('Join a voice channel first.');
  }

  const queue = getQueue(guild.id);
  queue.setTextChannel(channel);

  try {
    await queue.connect(voiceChannel);
  } catch (error) {
    logger.error(`[queue:${guild.id}] failed to connect`, error);
    return reply('Failed to join your voice channel.');
  }

  let tracks;
  try {
    tracks = await resolveTracks(input);
  } catch (error) {
    logger.error(`[queue:${guild.id}] failed to resolve`, error);
    return reply('Could not resolve that YouTube input.');
  }

  if (!tracks.length) {
    return reply('No tracks found.');
  }

  const added = queue.enqueue(tracks, member.user);
  if (added === 1) {
    return reply(`Queued: **${tracks[0].title}**`);
  }
  return reply(`Queued ${added} tracks.`);
}

function handlePump(payload) {
  return handlePlay({ ...payload, input: PUMP_PLAYLIST_URL });
}

function handleVolume({ guild, reply, percent }) {
  if (!guild) {
    return reply('This command only works in a server.');
  }
  const queue = getQueue(guild.id);
  const normalized = parseVolumePercent(percent);
  if (normalized === null) {
    return reply(`Volume: ${formatVolumePercent(queue.getVolume())}%`);
  }
  const volume = normalized / 100;
  queue.setVolume(volume);
  return reply(`Volume set to ${normalized}%.`);
}

function handleAbout({ reply }) {
  const lines = [
    `Danny the DJ v${packageInfo.version}`,
    `Uptime: ${formatUptime(process.uptime())}`,
    `Log level: ${logger.getLevel()}`,
    `Node: ${process.version}`
  ];
  const commit = process.env.GIT_SHA || process.env.SOURCE_VERSION;
  if (commit) {
    lines.push(`Commit: ${commit.slice(0, 12)}`);
  }
  return reply(lines.join('\n'));
}

async function handleDebug(interaction) {
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    return interaction.reply({
      content: 'You need Manage Server to change debug logging.',
      flags: MessageFlags.Ephemeral
    });
  }

  const mode = interaction.options.getString('mode') || 'toggle';
  const current = logger.getLevel();
  let next = current;

  switch (mode) {
    case 'on':
      next = 'debug';
      break;
    case 'off':
      next = 'info';
      break;
    case 'toggle':
      next = current === 'debug' ? 'info' : 'debug';
      break;
    case 'status':
      break;
    default:
      next = current;
  }

  if (next !== current) {
    logger.setLevel(next);
    logger.info(`Log level set to ${next} by ${interaction.user.tag}`);
  }

  return interaction.reply({
    content: `Log level: ${logger.getLevel()}`,
    flags: MessageFlags.Ephemeral
  });
}

async function handleLulaye(interaction) {
  try {
    await interaction.user.send(`Here you go: ${LULAYE_URL}`);
    await interaction.reply({
      content: 'Sent you a DM.',
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    logger.error('Failed to DM lulaye link', error);
    const message = 'I could not DM you. Please enable DMs from server members.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: message });
    } else {
      await interaction.reply({
        content: message,
        flags: MessageFlags.Ephemeral
      });
    }
  }
}

async function touchHealthcheck() {
  try {
    await writeFile(HEALTHCHECK_PATH, `${Date.now()}`);
  } catch (error) {
    logger.debug('Failed to write healthcheck file', error);
  }
}

function startHealthcheck() {
  touchHealthcheck();
  setInterval(() => {
    touchHealthcheck();
  }, 30_000);
}

function handleSkip({ guild, reply }) {
  const queue = queues.get(guild.id);
  if (!queue || (!queue.current && queue.queue.length === 0)) {
    return reply('Nothing is playing.');
  }
  queue.skip();
  return reply('Skipped.');
}

function handlePause({ guild, reply }) {
  const queue = queues.get(guild.id);
  if (!queue || (!queue.current && queue.queue.length === 0)) {
    return reply('Nothing is playing.');
  }
  const paused = queue.pause();
  return reply(paused ? 'Paused.' : 'Already paused.');
}

function handleResume({ guild, reply }) {
  const queue = queues.get(guild.id);
  if (!queue || (!queue.current && queue.queue.length === 0)) {
    return reply('Nothing is playing.');
  }
  const resumed = queue.resume();
  return reply(resumed ? 'Resumed.' : 'Already playing.');
}

function handleStop({ guild, reply }) {
  const queue = queues.get(guild.id);
  if (!queue) {
    return reply('Nothing to stop.');
  }
  queue.destroy();
  queues.delete(guild.id);
  return reply('Stopped and cleared the queue.');
}

function handleQueue({ guild, reply }) {
  const queue = queues.get(guild.id);
  if (!queue) {
    return reply('Queue is empty.');
  }
  return reply(buildQueueMessage(queue));
}

function handleNow({ guild, reply }) {
  const queue = queues.get(guild.id);
  if (!queue || !queue.current) {
    return reply('Nothing is playing.');
  }
  return reply(`Now playing: **${formatTrackLine(queue.current)}**`);
}

function parseMentionCommand(content) {
  const cleaned = content.replace(/<@!?\d+>/g, '').trim();
  if (!cleaned) {
    return null;
  }
  const [command, ...args] = cleaned.split(/\s+/);
  return {
    command: command.toLowerCase(),
    args: args.join(' ')
  };
}

client.once('clientReady', (readyClient) => {
  logger.info(`Logged in as ${readyClient.user.tag}`);
  startHealthcheck();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  const reply = createInteractionResponder(interaction);
  if (!interaction.guild) {
    await reply('This command only works in a server.');
    return;
  }
  try {
    switch (interaction.commandName) {
      case 'play': {
        await interaction.deferReply();
        const input = interaction.options.getString('query');
        await handlePlay({
          guild: interaction.guild,
          member: interaction.member,
          channel: interaction.channel,
          reply,
          input
        });
        break;
      }
      case 'pump': {
        await interaction.deferReply();
        await handlePump({
          guild: interaction.guild,
          member: interaction.member,
          channel: interaction.channel,
          reply
        });
        break;
      }
      case 'skip':
        await handleSkip({ guild: interaction.guild, reply });
        break;
      case 'pause':
        await handlePause({ guild: interaction.guild, reply });
        break;
      case 'resume':
        await handleResume({ guild: interaction.guild, reply });
        break;
      case 'stop':
        await handleStop({ guild: interaction.guild, reply });
        break;
      case 'queue':
        await handleQueue({ guild: interaction.guild, reply });
        break;
      case 'now':
        await handleNow({ guild: interaction.guild, reply });
        break;
      case 'lulaye':
        await handleLulaye(interaction);
        break;
      case 'volume': {
        const percent = interaction.options.getInteger('percent');
        await handleVolume({
          guild: interaction.guild,
          reply,
          percent: typeof percent === 'number' ? percent : null
        });
        break;
      }
      case 'about':
        await handleAbout({ reply });
        break;
      case 'debug':
        await handleDebug(interaction);
        break;
      default:
        await reply('Unknown command.');
    }
  } catch (error) {
    logger.error('Interaction handler error', error);
    await reply('Something went wrong handling that command.');
  }
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) {
    return;
  }
  if (!message.mentions.has(client.user)) {
    return;
  }

  const parsed = parseMentionCommand(message.content);
  if (!parsed) {
    return;
  }

  const reply = createMessageResponder(message);
  const { command, args } = parsed;
  try {
    switch (command) {
      case 'play':
        await handlePlay({
          guild: message.guild,
          member: message.member,
          channel: message.channel,
          reply,
          input: args
        });
        break;
      case 'skip':
        await handleSkip({ guild: message.guild, reply });
        break;
      case 'pause':
        await handlePause({ guild: message.guild, reply });
        break;
      case 'resume':
        await handleResume({ guild: message.guild, reply });
        break;
      case 'stop':
      case 'leave':
        await handleStop({ guild: message.guild, reply });
        break;
      case 'queue':
        await handleQueue({ guild: message.guild, reply });
        break;
      case 'now':
        await handleNow({ guild: message.guild, reply });
        break;
      case 'volume': {
        const raw = args ? Number(args) : NaN;
        await handleVolume({
          guild: message.guild,
          reply,
          percent: Number.isFinite(raw) ? raw : null
        });
        break;
      }
      case 'about':
        await handleAbout({ reply });
        break;
      case 'debug':
        await reply('Use `/debug` (Manage Server permission required).');
        break;
      default:
        await reply('Try `@Bot play <url>` or `/play <url>`.');
    }
  } catch (error) {
    logger.error('Message handler error', error);
    await reply('Something went wrong handling that command.');
  }
});

client.login(token);

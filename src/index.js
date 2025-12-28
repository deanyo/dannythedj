require('dotenv').config();

const { writeFile } = require('node:fs/promises');
const {
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField,
  EmbedBuilder,
  Colors
} = require('discord.js');
const { GuildQueue } = require('./player');
const { resolvePlaylistTracks, resolveTracks, searchTracks } = require('./yt');
const { getUserFacingError } = require('./errors');
const logger = require('./logger');
const packageInfo = require('../package.json');

const PUMP_PLAYLIST_URL =
  'https://www.youtube.com/watch?v=mpG0ax0uAdo&list=PL0nMuMH24oIbUUo0BCFWcPRnQh2zdx2pP';
const LULAYE_URL = 'https://www.youtube.com/watch?v=VKAv2AHIKEw';
const HEALTHCHECK_PATH =
  process.env.HEALTHCHECK_PATH || '/tmp/musicbot-healthcheck';
function getNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const DEFAULT_VOLUME_PERCENT = clamp(
  getNumberEnv('DEFAULT_VOLUME', 100),
  0,
  200
);
const DEFAULT_VOLUME = DEFAULT_VOLUME_PERCENT / 100;
const IDLE_DISCONNECT_SECONDS = getNumberEnv(
  'IDLE_DISCONNECT_SECONDS',
  5
);
const IDLE_DISCONNECT_MS =
  Number.isFinite(IDLE_DISCONNECT_SECONDS) && IDLE_DISCONNECT_SECONDS > 0
    ? IDLE_DISCONNECT_SECONDS * 1000
    : 0;
const STREAM_TIMEOUT_MS = getNumberEnv(
  'STREAM_START_TIMEOUT_MS',
  15_000
);
const PLAYLIST_LIMIT = getNumberEnv('PLAYLIST_LIMIT', 50);
const PLAYLIST_PREFETCH_COUNT = 5;
const DEBUG_LOG_CHANNEL_ID = process.env.DEBUG_LOG_CHANNEL_ID;
const DEBUG_LOG_THROTTLE_SECONDS = getNumberEnv(
  'DEBUG_LOG_THROTTLE_SECONDS',
  60
);

const debugLogState = {
  lastSentByGuild: new Map()
};

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
      defaultVolume: DEFAULT_VOLUME,
      streamTimeoutMs: STREAM_TIMEOUT_MS,
      onError: (entry) => notifyDebugChannel(guildId, entry, client)
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

function truncateText(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function formatQueueItem(track, number) {
  const duration = formatDuration(track.duration);
  const durationLabel = duration ? ` [${duration}]` : '';
  const requester = track.requestedBy ? ` - ${track.requestedBy}` : '';
  const title = truncateText(track.title || track.url || 'Unknown', 80);
  const prefix = typeof number === 'number' ? `${number}. ` : '';
  return `${prefix}${title}${durationLabel}${requester}`;
}

function isPlaylistInput(input) {
  return /[?&]list=/.test(input || '');
}

function getPlaylistLimit() {
  if (!Number.isFinite(PLAYLIST_LIMIT)) {
    return 50;
  }
  if (PLAYLIST_LIMIT <= 0) {
    return 0;
  }
  return Math.floor(PLAYLIST_LIMIT);
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

function buildQueuedEmbed(track, requester, options = {}) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(options.title || 'Queued');
  const safeTitle = truncateText(track.title || track.url || 'Unknown', 200);
  const label = track.url ? `[${safeTitle}](${track.url})` : safeTitle;
  embed.setDescription(label);
  const fields = [];
  if (Number.isFinite(track.duration)) {
    fields.push({ name: 'Duration', value: formatDuration(track.duration), inline: true });
  }
  if (requester) {
    fields.push({ name: 'Requested by', value: requester, inline: true });
  }
  if (fields.length) {
    embed.addFields(fields);
  }
  if (options.footer) {
    embed.setFooter({ text: options.footer });
  }
  return { embeds: [embed] };
}

function buildPlaylistStatusEmbed(message, options = {}) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(options.title || 'Playlist')
    .setDescription(message);
  if (options.footer) {
    embed.setFooter({ text: options.footer });
  }
  return { embeds: [embed] };
}

function buildQueueEmbed(queue, page) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle('Queue');

  if (queue.current) {
    embed.addFields({
      name: 'Now playing',
      value: formatQueueItem(queue.current)
    });
  } else {
    embed.addFields({ name: 'Now playing', value: 'Nothing playing.' });
  }

  const upcomingCount = queue.queue.length;
  if (upcomingCount > 0) {
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(upcomingCount / pageSize));
    const currentPage = clamp(Number(page) || 1, 1, totalPages);
    const start = (currentPage - 1) * pageSize;
    const upcoming = queue.queue.slice(start, start + pageSize);
    const lines = upcoming.map((track, index) =>
      formatQueueItem(track, start + index + 1)
    );
    embed.addFields({
      name: `Up next (page ${currentPage}/${totalPages})`,
      value: lines.join('\n')
    });
  } else {
    embed.addFields({ name: 'Up next', value: 'Queue is empty.' });
  }

  const allTracks = [];
  if (queue.current) {
    allTracks.push(queue.current);
  }
  if (queue.queue.length > 0) {
    allTracks.push(...queue.queue);
  }
  const requesterSummary = buildRequesterSummary(allTracks);
  const durationSummary = buildDurationSummary(allTracks);
  const summaryParts = [];
  if (requesterSummary) {
    summaryParts.push(requesterSummary);
  }
  if (durationSummary) {
    summaryParts.push(durationSummary);
  }
  if (summaryParts.length > 0) {
    embed.addFields({ name: 'Summary', value: summaryParts.join('\n') });
  }

  embed.setFooter({
    text: `Up next: ${upcomingCount} track${upcomingCount === 1 ? '' : 's'}`
  });

  return { embeds: [embed] };
}

function buildNowPlayingEmbed(track) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle('Now playing');
  const safeTitle = truncateText(track.title || track.url || 'Unknown', 200);
  const label = track.url ? `[${safeTitle}](${track.url})` : safeTitle;
  embed.setDescription(label);
  const fields = [];
  if (Number.isFinite(track.duration)) {
    fields.push({ name: 'Duration', value: formatDuration(track.duration), inline: true });
  }
  if (track.requestedBy) {
    fields.push({ name: 'Requested by', value: track.requestedBy, inline: true });
  }
  if (fields.length) {
    embed.addFields(fields);
  }
  return { embeds: [embed] };
}

function buildErrorEmbed(title, description) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle(title)
    .setDescription(description);
  return { embeds: [embed] };
}

function buildSearchResultsEmbed(query, results) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle('Search results');
  const lines = results.map((track, index) => {
    const duration = formatDuration(track.duration);
    const durationLabel = duration ? ` [${duration}]` : '';
    const title = truncateText(track.title || track.url || 'Unknown', 80);
    const label = track.url ? `[${title}](${track.url})` : title;
    return `${index + 1}. ${label}${durationLabel}`;
  });
  if (query) {
    embed.setDescription(`Results for **${truncateText(query, 80)}**\n${lines.join('\n')}`);
  } else {
    embed.setDescription(lines.join('\n'));
  }
  embed.setFooter({ text: 'Use /play <url> to queue a result.' });
  return { embeds: [embed] };
}

function normalizeReplyPayload(payload) {
  if (typeof payload === 'string') {
    return { content: payload };
  }
  return payload;
}

function createMessageResponder(message) {
  return (payload) => {
    const messageOptions = normalizeReplyPayload(payload);
    return message.reply({
      ...messageOptions,
      allowedMentions: { repliedUser: false }
    });
  };
}

function createInteractionResponder(interaction) {
  return (payload) => {
    const messageOptions = normalizeReplyPayload(payload);
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(messageOptions);
    }
    return interaction.reply(messageOptions);
  };
}

function buildDebugErrorEmbed(entry, guildId) {
  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle('Musicbot error')
    .setDescription(entry.summary || 'Unknown error');
  const fields = [
    { name: 'Context', value: entry.context || 'unknown', inline: true },
    { name: 'Guild', value: guildId || 'unknown', inline: true }
  ];
  if (entry.track?.title) {
    const trackLabel = entry.track.url
      ? `[${entry.track.title}](${entry.track.url})`
      : entry.track.title;
    fields.push({ name: 'Track', value: trackLabel });
  }
  embed.addFields(fields);
  embed.setTimestamp(entry.timestamp ? new Date(entry.timestamp) : new Date());
  return embed;
}

function notifyDebugChannel(guildId, entry, client) {
  if (!DEBUG_LOG_CHANNEL_ID || !entry || !client) {
    return;
  }
  const now = Date.now();
  const lastSent = debugLogState.lastSentByGuild.get(guildId) || 0;
  const throttleMs = Math.max(0, DEBUG_LOG_THROTTLE_SECONDS) * 1000;
  if (throttleMs > 0 && now - lastSent < throttleMs) {
    return;
  }
  debugLogState.lastSentByGuild.set(guildId, now);
  const payload = { embeds: [buildDebugErrorEmbed(entry, guildId)] };
  const cached = client.channels.cache.get(DEBUG_LOG_CHANNEL_ID);
  if (cached && cached.isTextBased()) {
    cached.send(payload).catch(() => null);
    return;
  }
  client.channels.fetch(DEBUG_LOG_CHANNEL_ID)
    .then((fetched) => {
      if (!fetched || !fetched.isTextBased()) {
        return;
      }
      fetched.send(payload).catch(() => null);
    })
    .catch(() => null);
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

  const playlistLimit = getPlaylistLimit();
  if (isPlaylistInput(input)) {
    const prefetch = Math.max(
      1,
      playlistLimit > 0
        ? Math.min(PLAYLIST_PREFETCH_COUNT, playlistLimit)
        : PLAYLIST_PREFETCH_COUNT
    );
    let tracks = [];
    try {
      tracks = await resolvePlaylistTracks(input, {
        playlistStart: 1,
        playlistEnd: prefetch
      });
    } catch (error) {
      logger.error(`[queue:${guild.id}] failed to resolve`, error);
      queue.recordError('resolve', error);
      const reason = getUserFacingError(error);
      return reply(
        buildErrorEmbed(
          'Could not resolve playlist',
          reason || 'Try a different playlist or check your cookies.'
        )
      );
    }

    if (!tracks.length) {
      return reply(buildErrorEmbed('No tracks found', 'Try a different playlist.'));
    }

    const added = queue.enqueue(tracks, member.user);
    const limitLabel =
      playlistLimit > 0 ? `Limit: ${playlistLimit} tracks` : null;
    const message =
      added === 1
        ? `Queued **${tracks[0].title}**`
        : `Queued ${added} tracks.`;

    if (playlistLimit === 1) {
      return reply(
        buildPlaylistStatusEmbed(`${message} (playlist limit reached).`, {
          title: 'Playlist queued',
          footer: limitLabel
        })
      );
    }

    const replyPromise = reply(
      buildPlaylistStatusEmbed(`${message} Loading the rest of the playlist...`, {
        title: 'Playlist queued',
        footer: limitLabel
      })
    );

    if (playlistLimit > 0 && playlistLimit <= prefetch) {
      return replyPromise;
    }

    const playlistStart = prefetch + 1;
    const playlistEnd = playlistLimit > 0 ? playlistLimit : null;
    resolvePlaylistTracks(input, {
      playlistStart,
      playlistEnd
    })
      .then((remaining) => {
        if (!remaining.length) {
          return;
        }
        const addedRemaining = queue.enqueue(remaining, member.user);
        if (queue.textChannel) {
          queue.textChannel
            .send(
              buildPlaylistStatusEmbed(
                `Queued ${addedRemaining} more tracks from the playlist.`,
                { title: 'Playlist update' }
              )
            )
            .catch(() => null);
        }
      })
      .catch((error) => {
        logger.error(
          `[queue:${guild.id}] failed to resolve playlist remainder`,
          error
        );
        queue.recordError('resolve', error);
        if (queue.textChannel) {
          queue.textChannel
            .send(
              buildErrorEmbed(
                'Playlist update failed',
                'Failed to load the rest of the playlist. Some tracks may be missing.'
              )
            )
            .catch(() => null);
        }
      });
    return replyPromise;
  }

  let tracks;
  try {
    tracks = await resolveTracks(input);
  } catch (error) {
    logger.error(`[queue:${guild.id}] failed to resolve`, error);
    queue.recordError('resolve', error);
    const reason = getUserFacingError(error);
    return reply(
      buildErrorEmbed(
        'Could not resolve',
        reason || 'Try a different URL or search query.'
      )
    );
  }

  if (!tracks.length) {
    return reply(buildErrorEmbed('No tracks found', 'Try a different search.'));
  }

  const added = queue.enqueue(tracks, member.user);
  if (added === 1) {
    return reply(buildQueuedEmbed(tracks[0], member.user.tag));
  }
  return reply(
    buildPlaylistStatusEmbed(`Queued ${added} tracks.`, { title: 'Queued' })
  );
}

async function handleSearch({ reply, input }) {
  if (!input) {
    return reply('Provide search text.');
  }
  let results;
  try {
    results = await searchTracks(input);
  } catch (error) {
    logger.error('Search failed', error);
    const reason = getUserFacingError(error);
    return reply(
      buildErrorEmbed(
        'Search failed',
        reason || 'Try again in a moment.'
      )
    );
  }

  if (!results.length) {
    return reply(buildErrorEmbed('No results found', 'Try a different query.'));
  }

  return reply(buildSearchResultsEmbed(input, results));
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

  if (mode === 'status') {
    const queue = queues.get(interaction.guild.id);
    const lastError = queue?.lastError;
    const embed = new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle('Debug status')
      .addFields({
        name: 'Log level',
        value: logger.getLevel(),
        inline: true
      });
    if (lastError) {
      const when = Math.floor(lastError.timestamp / 1000);
      let details = lastError.summary || 'Unknown error';
      details += lastError.context ? `\nContext: ${lastError.context}` : '';
      details += `\nWhen: <t:${when}:R>`;
      if (lastError.track?.title) {
        const trackLabel = lastError.track.url
          ? `[${lastError.track.title}](${lastError.track.url})`
          : lastError.track.title;
        details += `\nTrack: ${trackLabel}`;
      }
      embed.addFields({ name: 'Last error', value: details });
    } else {
      embed.addFields({ name: 'Last error', value: 'None recorded.' });
    }
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
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

function handleQueue({ guild, reply, page }) {
  const queue = queues.get(guild.id);
  if (!queue) {
    return reply('Queue is empty.');
  }
  if (!queue.current && queue.queue.length === 0) {
    return reply('Queue is empty.');
  }
  return reply(buildQueueEmbed(queue, page));
}

function handleNow({ guild, reply }) {
  const queue = queues.get(guild.id);
  if (!queue || !queue.current) {
    return reply('Nothing is playing.');
  }
  return reply(buildNowPlayingEmbed(queue.current));
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
      case 'search': {
        await interaction.deferReply();
        const input = interaction.options.getString('query');
        await handleSearch({ reply, input });
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
        await handleQueue({
          guild: interaction.guild,
          reply,
          page: interaction.options.getInteger('page')
        });
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
      case 'search':
        await handleSearch({ reply, input: args });
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
        {
          const rawPage = args ? Number(args) : NaN;
          await handleQueue({
            guild: message.guild,
            reply,
            page: Number.isFinite(rawPage) ? rawPage : null
          });
        }
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

client.on('voiceStateUpdate', (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild) {
    return;
  }
  const queue = queues.get(guild.id);
  if (!queue || !queue.connection) {
    return;
  }

  const channelId = queue.connection.joinConfig.channelId;
  if (!channelId) {
    return;
  }

  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isVoiceBased()) {
    return;
  }

  const nonBotMembers = channel.members.filter((member) => !member.user.bot)
    .size;
  if (nonBotMembers > 0) {
    return;
  }

  queue.textChannel
    ?.send('Voice channel is empty. Leaving.')
    .catch(() => null);
  queue.destroy();
  queues.delete(guild.id);
});

client.login(token);

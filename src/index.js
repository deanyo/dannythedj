require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const { GuildQueue } = require('./player');
const { resolveTracks } = require('./yt');

const PUMP_PLAYLIST_URL =
  'https://www.youtube.com/watch?v=mpG0ax0uAdo&list=PL0nMuMH24oIbUUo0BCFWcPRnQh2zdx2pP';
const LULAYE_URL = 'https://www.youtube.com/watch?v=VKAv2AHIKEw';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Missing DISCORD_TOKEN in environment.');
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
    queue = new GuildQueue(guildId);
    queues.set(guildId, queue);
  }
  return queue;
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
    console.error(`[queue:${guild.id}] failed to connect`, error);
    return reply('Failed to join your voice channel.');
  }

  let tracks;
  try {
    tracks = await resolveTracks(input);
  } catch (error) {
    console.error(`[queue:${guild.id}] failed to resolve`, error);
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

async function handleLulaye(interaction) {
  try {
    await interaction.user.send(`Here you go: ${LULAYE_URL}`);
    await interaction.reply({ content: 'Sent you a DM.', ephemeral: true });
  } catch (error) {
    console.error('Failed to DM lulaye link', error);
    const message = 'I could not DM you. Please enable DMs from server members.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: message });
    } else {
      await interaction.reply({ content: message, ephemeral: true });
    }
  }
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

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
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
      default:
        await reply('Unknown command.');
    }
  } catch (error) {
    console.error('Interaction handler error', error);
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
      default:
        await reply('Try `@Bot play <url>` or `/play <url>`.');
    }
  } catch (error) {
    console.error('Message handler error', error);
    await reply('Something went wrong handling that command.');
  }
});

client.login(token);

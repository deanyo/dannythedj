const { SlashCommandBuilder } = require('discord.js');

const commandBuilders = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a YouTube URL or playlist')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('YouTube URL (or search text)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current track'),
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause playback'),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume playback'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current queue'),
  new SlashCommandBuilder()
    .setName('now')
    .setDescription('Show what is playing right now'),
  new SlashCommandBuilder()
    .setName('pump')
    .setDescription('Play the Pump playlist'),
  new SlashCommandBuilder()
    .setName('lulaye')
    .setDescription('Get a lulaye DM link')
];

module.exports = {
  commands: commandBuilders.map((command) => command.toJSON())
};

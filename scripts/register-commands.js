require('dotenv').config();

const { REST, Routes } = require('discord.js');
const { commands } = require('../src/commands');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in environment.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

async function register() {
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands
    });
    console.log(`Registered guild commands for ${guildId}.`);
    return;
  }

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log('Registered global commands.');
}

register().catch((error) => {
  console.error('Failed to register commands', error);
  process.exit(1);
});

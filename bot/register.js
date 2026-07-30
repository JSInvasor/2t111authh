'use strict';

// Registers the slash commands with Discord. Run after changing commands:
//   npm run bot:register

const { REST, Routes } = require('discord.js');
const botConfig = require('./config');
const commands = require('./commands');

if (!botConfig.token || !botConfig.clientId) {
  console.error('[bot] Missing DISCORD_TOKEN / DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const body = commands.map((c) => c.data.toJSON());
const rest = new REST({ version: '10' }).setToken(botConfig.token);

(async () => {
  try {
    if (botConfig.guildId) {
      await rest.put(Routes.applicationGuildCommands(botConfig.clientId, botConfig.guildId), { body });
      console.log(`[bot] Registered ${body.length} commands to guild ${botConfig.guildId} (instant).`);
    } else {
      await rest.put(Routes.applicationCommands(botConfig.clientId), { body });
      console.log(`[bot] Registered ${body.length} global commands (may take up to 1 hour to appear).`);
    }
  } catch (err) {
    console.error('[bot] Command registration failed:', err);
    process.exit(1);
  }
})();

'use strict';

const { Client, GatewayIntentBits, Events } = require('discord.js');
const botConfig = require('./config');
const commands = require('./commands');
const logger = require('./log');
const { getScript } = require('../src/services/scripts');

if (!botConfig.token || !botConfig.clientId) {
  console.error('[bot] Missing DISCORD_TOKEN / DISCORD_CLIENT_ID in .env');
  process.exit(1);
}
if (!botConfig.scriptId) {
  console.error('[bot] Missing DISCORD_SCRIPT_ID in .env (set it to a script id from the dashboard)');
  process.exit(1);
}
if (!getScript(botConfig.scriptId)) {
  console.warn(`[bot] WARNING: script "${botConfig.scriptId}" not found in the database yet.`);
}

const registry = new Map(commands.map((c) => [c.data.name, c]));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] Logged in as ${c.user.tag}. Serving script ${botConfig.scriptId}.`);
  logger.init(client, botConfig.logChannelId);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = registry.get(interaction.commandName);
  if (!cmd) return;
  try {
    await cmd.execute(interaction);
  } catch (err) {
    console.error(`[bot] error in /${interaction.commandName}:`, err);
    const msg = { content: '⚠️ Something went wrong running that command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(msg).catch(() => {});
    else interaction.reply(msg).catch(() => {});
  }
});

client.login(botConfig.token);

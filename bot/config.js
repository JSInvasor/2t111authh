'use strict';

require('dotenv').config();

const num = (v) => (v !== undefined && v !== '' ? Number(v) : null);

module.exports = {
  token: process.env.DISCORD_TOKEN || '',
  clientId: process.env.DISCORD_CLIENT_ID || '',
  // If set, commands register instantly to this guild; otherwise globally (~1h).
  guildId: process.env.DISCORD_GUILD_ID || null,
  // The script/project this bot hands out keys for (an id from the dashboard).
  scriptId: process.env.DISCORD_SCRIPT_ID || '',
  // Role required to use /getkey (empty = everyone allowed).
  whitelistRoleId: process.env.DISCORD_WHITELIST_ROLE_ID || null,
  // Role allowed to use admin commands (server admins/owner always allowed).
  adminRoleId: process.env.DISCORD_ADMIN_ROLE_ID || null,
  // Optional channel to log key/reset events to.
  logChannelId: process.env.DISCORD_LOG_CHANNEL_ID || null,
  // Optional default expiry for keys handed out via /getkey (days).
  keyExpiresInDays: num(process.env.DISCORD_KEY_EXPIRES_DAYS),
};

'use strict';

const botConfig = require('./config');

const BRAND = 0x7c6cff;

/** Human-readable duration from seconds, e.g. 90000 -> "1d 1h". */
function fmtDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!parts.length) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function memberHasRole(interaction, roleId) {
  return !!(roleId && interaction.member && interaction.member.roles?.cache?.has(roleId));
}

/** Server owner, users with Administrator, or the configured admin role. */
function isAdmin(interaction) {
  if (interaction.guild && interaction.guild.ownerId === interaction.user.id) return true;
  if (interaction.memberPermissions && interaction.memberPermissions.has('Administrator')) return true;
  return memberHasRole(interaction, botConfig.adminRoleId);
}

/** Whitelisted for /getkey — everyone if no whitelist role is configured. */
function hasWhitelist(interaction) {
  if (!botConfig.whitelistRoleId) return true;
  return memberHasRole(interaction, botConfig.whitelistRoleId) || isAdmin(interaction);
}

module.exports = { BRAND, fmtDuration, isAdmin, hasWhitelist };

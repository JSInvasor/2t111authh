'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const appConfig = require('../src/config');
const botConfig = require('./config');
const { getScript } = require('../src/services/scripts');
const {
  createKeys,
  getKeyByValue,
  getKeyByDiscord,
  updateKey,
  userResetHwid,
} = require('../src/services/keys');
const { BRAND, fmtDuration, isAdmin, hasWhitelist } = require('./util');
const { log } = require('./log');

const ephem = (content) => ({ content, ephemeral: true });

function requireScript(interaction) {
  const script = getScript(botConfig.scriptId);
  if (!script) {
    interaction.reply(ephem('⚠️ Bot is misconfigured: DISCORD_SCRIPT_ID does not match any script.'));
    return null;
  }
  return script;
}

function loaderSnippet(script, keyValue) {
  return (
    `script_key = "${keyValue}";\n` +
    `loadstring(game:HttpGet("${appConfig.baseUrl}/loader/${script.id}.lua"))()`
  );
}

function expiryField(key) {
  return key.expires_at ? `<t:${key.expires_at}:R>` : 'Lifetime';
}

/* ============================ USER COMMANDS ============================ */

const getkey = {
  data: new SlashCommandBuilder().setName('getkey').setDescription('Get your license key (creates one if you have none)'),
  async execute(interaction) {
    if (!hasWhitelist(interaction)) return interaction.reply(ephem('❌ You are not whitelisted to get a key.'));
    const script = requireScript(interaction);
    if (!script) return;

    let key = getKeyByDiscord(script.id, interaction.user.id);
    let created = false;
    if (!key) {
      [key] = createKeys(script.id, {
        count: 1,
        discordId: interaction.user.id,
        note: `discord:${interaction.user.tag}`,
        expiresInDays: botConfig.keyExpiresInDays,
      });
      created = true;
    }

    const embed = new EmbedBuilder()
      .setColor(BRAND)
      .setTitle(`🔑 Your key — ${script.name}`)
      .setDescription(`\`\`\`\n${key.value}\n\`\`\``)
      .addFields(
        { name: 'Status', value: key.status, inline: true },
        { name: 'Expires', value: expiryField(key), inline: true },
      )
      .addFields({ name: 'Loader', value: `\`\`\`lua\n${loaderSnippet(script, key.value)}\n\`\`\`` })
      .setFooter({ text: created ? 'A new key was generated for you.' : 'This is your existing key.' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
    if (created) log(`🔑 **${interaction.user.tag}** claimed a key for **${script.name}**.`);
  },
};

const resethwid = {
  data: new SlashCommandBuilder().setName('resethwid').setDescription('Reset the device (HWID) your key is locked to'),
  async execute(interaction) {
    const script = requireScript(interaction);
    if (!script) return;

    const key = getKeyByDiscord(script.id, interaction.user.id);
    if (!key) return interaction.reply(ephem('❌ You don’t have a key yet. Use `/getkey` first.'));

    const res = userResetHwid(key, script);
    if (!res.ok) {
      if (res.reason === 'no_hwid') return interaction.reply(ephem('ℹ️ Your key has no HWID bound yet — nothing to reset.'));
      if (res.reason === 'limit') return interaction.reply(ephem(`❌ You’ve reached the HWID reset limit (${res.limit}). Please contact an admin.`));
      if (res.reason === 'cooldown') return interaction.reply(ephem(`⏳ Please wait **${fmtDuration(res.wait)}** before resetting again.`));
      return interaction.reply(ephem('❌ Could not reset HWID.'));
    }

    await interaction.reply(ephem('✅ HWID reset. You can now run the script on a new device.'));
    log(`♻️ **${interaction.user.tag}** reset their HWID for **${script.name}**.`);
  },
};

const info = {
  data: new SlashCommandBuilder().setName('info').setDescription('Show your key status'),
  async execute(interaction) {
    const script = requireScript(interaction);
    if (!script) return;

    const key = getKeyByDiscord(script.id, interaction.user.id);
    if (!key) return interaction.reply(ephem('❌ You don’t have a key. Use `/getkey`.'));

    const embed = new EmbedBuilder()
      .setColor(BRAND)
      .setTitle(`📄 Key info — ${script.name}`)
      .addFields(
        { name: 'Key', value: `\`${key.value}\`` },
        { name: 'Status', value: key.status, inline: true },
        { name: 'HWID', value: key.hwid ? `\`${key.hwid}\`` : 'not bound', inline: true },
        { name: 'Expires', value: expiryField(key), inline: true },
        { name: 'Executions', value: String(key.total_executions), inline: true },
        { name: 'HWID resets', value: `${key.hwid_reset_count}/${script.hwid_reset_limit}`, inline: true },
      );
    interaction.reply({ embeds: [embed], ephemeral: true });
  },
};

/* ============================ ADMIN COMMANDS ============================ */

const generate = {
  data: new SlashCommandBuilder()
    .setName('generate')
    .setDescription('(admin) Generate keys')
    .addIntegerOption((o) => o.setName('count').setDescription('How many keys').setMinValue(1).setMaxValue(100).setRequired(true))
    .addIntegerOption((o) => o.setName('days').setDescription('Expires in N days (0 = lifetime)').setMinValue(0))
    .addStringOption((o) => o.setName('note').setDescription('Optional note')),
  async execute(interaction) {
    if (!isAdmin(interaction)) return interaction.reply(ephem('❌ Admins only.'));
    const script = requireScript(interaction);
    if (!script) return;

    const count = interaction.options.getInteger('count');
    const days = interaction.options.getInteger('days') || 0;
    const note = interaction.options.getString('note') || '';
    const keys = createKeys(script.id, { count, expiresInDays: days > 0 ? days : null, note });

    const list = keys.map((k) => k.value).join('\n');
    const body = `✅ Generated **${keys.length}** key(s) for **${script.name}**:\n\`\`\`\n${list}\n\`\`\``;
    interaction.reply({ content: body.slice(0, 1990), ephemeral: true });
  },
};

const lookup = {
  data: new SlashCommandBuilder()
    .setName('lookup')
    .setDescription('(admin) Look up a key')
    .addStringOption((o) => o.setName('key').setDescription('Key value').setRequired(true)),
  async execute(interaction) {
    if (!isAdmin(interaction)) return interaction.reply(ephem('❌ Admins only.'));
    const key = getKeyByValue(interaction.options.getString('key'));
    if (!key) return interaction.reply(ephem('❌ Key not found.'));

    const embed = new EmbedBuilder()
      .setColor(BRAND)
      .setTitle('🔍 Key lookup')
      .addFields(
        { name: 'Key', value: `\`${key.value}\`` },
        { name: 'Status', value: key.status, inline: true },
        { name: 'HWID', value: key.hwid ? `\`${key.hwid}\`` : 'not bound', inline: true },
        { name: 'Expires', value: expiryField(key), inline: true },
        { name: 'Executions', value: String(key.total_executions), inline: true },
        { name: 'Linked Discord', value: key.discord_id ? `<@${key.discord_id}>` : '—', inline: true },
        { name: 'Note', value: key.note || '—', inline: true },
      );
    interaction.reply({ embeds: [embed], ephemeral: true });
  },
};

function makeStatusCmd(name, description, status, verb) {
  return {
    data: new SlashCommandBuilder()
      .setName(name)
      .setDescription(description)
      .addStringOption((o) => o.setName('key').setDescription('Key value').setRequired(true)),
    async execute(interaction) {
      if (!isAdmin(interaction)) return interaction.reply(ephem('❌ Admins only.'));
      const key = getKeyByValue(interaction.options.getString('key'));
      if (!key) return interaction.reply(ephem('❌ Key not found.'));
      updateKey(key.id, { status });
      await interaction.reply(ephem(`✅ Key \`${key.value}\` ${verb}.`));
      log(`🛡️ **${interaction.user.tag}** ${verb} key \`${key.value}\`.`);
    },
  };
}

const ban = makeStatusCmd('ban', '(admin) Ban a key', 'banned', 'banned');
const unban = makeStatusCmd('unban', '(admin) Unban a key', 'active', 'unbanned');

module.exports = [getkey, resethwid, info, generate, lookup, ban, unban];

'use strict';

// Optional logging to a Discord channel. No-op until init() is called with a client.
let client = null;
let channelId = null;

function init(c, chId) {
  client = c;
  channelId = chId || null;
}

async function log(payload) {
  if (!client || !channelId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    if (ch && ch.isTextBased()) await ch.send(payload);
  } catch {
    /* logging must never break a command */
  }
}

module.exports = { init, log };

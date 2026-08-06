'use strict';

// Renders the Lua bootstrap that /loader/<id>.lua serves.
//
// Kept out of the route so tests can build the exact bytes a user's executor
// receives and run them in a Lua VM.

const path = require('path');
const fs = require('fs');
const config = require('../config');
const { obfuscateChunk } = require('./obfuscator');

const LUA_DIR = path.join(__dirname, '..', '..', 'lua');
const TEMPLATE = fs.readFileSync(path.join(LUA_DIR, 'loader_template.lua'), 'utf8');
const SHA256 = fs.readFileSync(path.join(LUA_DIR, 'sha256.lua'), 'utf8');

/**
 * @param {object} script  script row (needs id, name)
 * @param {{obfuscate?:boolean}} [opts]  override the configured loader obfuscation
 * @returns {string} Lua source
 */
function renderLoader(script, { obfuscate = config.antiTamper && config.obfuscateLoader } = {}) {
  // Function replacements: a "$&"/"$1" inside a name or URL must stay literal.
  // The name lands inside a --[==[ ]==] comment, so bracket runs are stripped
  // too — otherwise a script called "a]==]" would close the comment early and
  // inject Lua into every loader we hand out.
  const name = String(script.name || '').replace(/[\r\n"[\]]/g, ' ');

  const lua = TEMPLATE.replace(/\{\{API_URL\}\}/g, () => config.baseUrl)
    .replace(/\{\{SCRIPT_ID\}\}/g, () => script.id)
    .replace(/\{\{SCRIPT_NAME\}\}/g, () => name)
    .replace(/\{\{HARD_STOP\}\}/g, () => (config.tamperHardStop ? 'true' : 'false'))
    .replace(/\{\{SHA256\}\}/g, () => SHA256);

  // Ship the bootstrap encrypted as well, so there is no stable plaintext for an
  // attacker to diff, patch and re-host. Each delivery is byte-unique.
  return obfuscate ? obfuscateChunk(lua) : lua;
}

module.exports = { renderLoader };

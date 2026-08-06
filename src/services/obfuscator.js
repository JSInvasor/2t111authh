'use strict';

// Delivery-time obfuscation for protected scripts.
//
// Pipeline:
//   1. (optional) luamin minify + local-variable mangle — skipped safely if the
//      source doesn't parse as Lua 5.x (e.g. Luau-only syntax), so it never breaks a script.
//   2. RC4 encrypt.
//   3. base64 the ciphertext and embed it in a small Lua decryptor stub with
//      randomized identifier names, so each delivery is byte-unique.
//
// Two key modes:
//   • session (default when anti-tamper is on) — the key is derived by BOTH
//     sides from the live handshake (salt|nonce|script|key|hwid) and is passed
//     into the stub as a vararg. It is never written into the payload, so a
//     captured/shared response decrypts to nothing without that exact session.
//   • inline — the key travels inside the stub. Self-contained, so it is what
//     the loader bootstrap itself uses (there is no session yet at that point)
//     and what ANTI_TAMPER=0 falls back to for debugging.
//
// Source is stored in plaintext; obfuscation happens only here, at delivery.

const crypto = require('crypto');
const config = require('../config');

let luamin = null;
try {
  luamin = require('luamin');
} catch {
  /* optional — encryption still works without it */
}

/* ------------------------------- RC4 ------------------------------- */

function rc4(key, data) {
  const S = new Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 255;
    b = (b + S[a]) & 255;
    [S[a], S[b]] = [S[b], S[a]];
    out[k] = data[k] ^ S[(S[a] + S[b]) & 255];
  }
  return out;
}

/* --------------------------- minify (cached) --------------------------- */

const MINIFY_CACHE_MAX = 200;
const minifyCache = new Map(); // scriptId -> { updatedAt, code }

/** Minify, or hand back the original if it isn't Lua 5.x-parseable (Luau syntax). */
function minifyCode(code) {
  if (!luamin) return code;
  try {
    return luamin.minify(code);
  } catch {
    return code;
  }
}

function minifySource(script) {
  if (!luamin) return script.source;
  const cached = minifyCache.get(script.id);
  if (cached && cached.updatedAt === script.updated_at) return cached.code;

  const code = minifyCode(script.source);
  // Bounded: drop the oldest entry rather than growing once per script forever
  // (deleted scripts would otherwise keep their minified copy alive for good).
  if (!minifyCache.has(script.id) && minifyCache.size >= MINIFY_CACHE_MAX) {
    minifyCache.delete(minifyCache.keys().next().value);
  }
  minifyCache.set(script.id, { updatedAt: script.updated_at, code });
  return code;
}

/* ----------------------------- stub builder ----------------------------- */

function randName() {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  // Cryptographically random so stub identifiers can't be predicted.
  const len = 4 + crypto.randomInt(4); // 4..7 chars
  let n = '';
  for (let i = 0; i < len; i++) n += a[crypto.randomInt(a.length)];
  return n;
}
function distinctNames(count) {
  const set = new Set();
  while (set.size < count) set.add(randName());
  return [...set];
}

/**
 * Two independent rolling hashes over the plaintext. Cheap on both sides and
 * strong enough that a flipped byte can't slip through; the stub refuses to run
 * anything that doesn't hash to the same pair.
 */
function checksum(str) {
  const buf = Buffer.from(str, 'utf8');
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < buf.length; i++) {
    h1 = (h1 * 31 + buf[i]) % 1000000007;
    h2 = (h2 * 131 + buf[i]) % 999999937;
  }
  return { h1, h2 };
}

/**
 * @param {{dataB64:string, keyB64?:string|null, chk:{h1:number,h2:number}}} parts
 *   keyB64 omitted ⇒ session mode: the stub expects the key as its first vararg.
 */
function buildStub({ dataB64, keyB64 = null, chk }) {
  const [KEY, DATA, B64, XOR, RC4, SRC, LD, FN, H1, H2, IC, BYTE] = distinctNames(12);

  // How the stub obtains its RC4 key.
  const keyInit = keyB64
    ? `local ${KEY}=${B64}("${keyB64}")`
    : `local ${KEY}=...
if type(${KEY})~="string" or #${KEY}==0 then return end`;

  return `local ${DATA}="${dataB64}"
local ${BYTE}=string.byte
local function ${B64}(d)
local b='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
local t={}
for i=1,64 do t[${BYTE}(b,i)]=i-1 end
local o,n,acc,bits={},0,0,0
for i=1,#d do
local v=t[${BYTE}(d,i)]
if v then
acc=acc*64+v
bits=bits+6
if bits>=8 then
bits=bits-8
local p=2^bits
local c=math.floor(acc/p)
acc=acc-c*p
n=n+1
o[n]=string.char(c)
end
end
end
return table.concat(o)
end
${keyInit}
local ${XOR}=(bit32 and bit32.bxor) or (bit and bit.bxor)
if not ${XOR} then
${XOR}=function(a,b)
local r,p=0,1
for _=1,8 do
local x,y=a%2,b%2
if x~=y then r=r+p end
a=(a-x)/2;b=(b-y)/2;p=p*2
end
return r
end
end
local function ${RC4}(k,d)
local S={}
for i=0,255 do S[i]=i end
local j=0
for i=0,255 do
j=(j+S[i]+${BYTE}(k,(i%#k)+1))%256
S[i],S[j]=S[j],S[i]
end
local o={}
local a,c=0,0
for m=1,#d do
a=(a+1)%256
c=(c+S[a])%256
S[a],S[c]=S[c],S[a]
o[m]=string.char(${XOR}(${BYTE}(d,m),S[(S[a]+S[c])%256]))
end
return table.concat(o)
end
local ${SRC}=${RC4}(${KEY},${B64}(${DATA}))
if #${SRC}==0 then return end
local ${H1},${H2}=0.0,0.0
for i=1,#${SRC} do
local v=${BYTE}(${SRC},i)
${H1}=(${H1}*31+v)%1000000007
${H2}=(${H2}*131+v)%999999937
end
if ${H1}~=${chk.h1} or ${H2}~=${chk.h2} then return end
local ${LD}=loadstring or load
${
  config.tamperHardStop
    ? `local ${IC}=iscclosure or is_c_closure
if ${IC} then
local ok,isC=pcall(${IC},${LD})
if ok and isC==false then return end
end`
    : ''
}
local ${FN}=${LD}(${SRC})
if ${FN} then return ${FN}() end`;
}

/**
 * Obfuscate a script for delivery. Pass the script row (needs id, source, updated_at).
 * @param {object} script
 * @param {{minify?:boolean, key?:Buffer|null}} [opts]
 *   key — session key both sides derived. Given, it is used but NOT embedded
 *   (the stub reads it from `...`). Omitted, a random key is generated and
 *   shipped inside the stub.
 * @returns {string} Lua decryptor stub
 */
function obfuscate(script, { minify = true, key = null } = {}) {
  return pack(minify ? minifySource(script) : script.source, key);
}

/**
 * Obfuscate a standalone chunk of Lua — used for the loader bootstrap, which has
 * no session yet and so is always inline-key. Not cached: the chunk is different
 * on every request anyway.
 */
function obfuscateChunk(source, { minify = true } = {}) {
  return pack(minify ? minifyCode(source) : source, null);
}

/** Encrypt `source` and wrap it in a stub, session-key mode when `key` is given. */
function pack(source, key) {
  const useSessionKey = !!(key && key.length);
  const rc4Key = useSessionKey ? Buffer.from(key) : crypto.randomBytes(16);
  const cipher = rc4(rc4Key, Buffer.from(source, 'utf8'));
  return buildStub({
    dataB64: cipher.toString('base64'),
    keyB64: useSessionKey ? null : rc4Key.toString('base64'),
    chk: checksum(source),
  });
}

module.exports = {
  obfuscate,
  obfuscateChunk,
  rc4,
  checksum,
  _buildStub: buildStub,
  _minifyCacheSize: () => minifyCache.size,
};

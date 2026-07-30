'use strict';

// Delivery-time obfuscation for protected scripts.
//
// Pipeline:
//   1. (optional) luamin minify + local-variable mangle — skipped safely if the
//      source doesn't parse as Lua 5.x (e.g. Luau-only syntax), so it never breaks a script.
//   2. RC4 encrypt with a fresh random key on every delivery.
//   3. base64 the ciphertext + key and embed them in a small Lua decryptor stub
//      with randomized identifier names, so each delivery is byte-unique.
//
// The stub decrypts in memory and loadstring()s the real source. Source is stored
// in plaintext; obfuscation happens only here, at the single delivery point.

const crypto = require('crypto');

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

const minifyCache = new Map(); // scriptId -> { updatedAt, code }

function minifySource(script) {
  if (!luamin) return script.source;
  const cached = minifyCache.get(script.id);
  if (cached && cached.updatedAt === script.updated_at) return cached.code;

  let code = script.source;
  try {
    code = luamin.minify(script.source);
  } catch {
    // Not parseable (likely Luau-specific syntax) — keep original, still get encrypted.
    code = script.source;
  }
  minifyCache.set(script.id, { updatedAt: script.updated_at, code });
  return code;
}

/* ----------------------------- stub builder ----------------------------- */

function randName() {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  const len = 3 + Math.floor(Math.random() * 4);
  let n = a[Math.floor(Math.random() * 26)];
  for (let i = 0; i < len; i++) n += a[Math.floor(Math.random() * 26)];
  return n;
}
function distinctNames(count) {
  const set = new Set();
  while (set.size < count) set.add(randName());
  return [...set];
}

function checksum(str) {
  const buf = Buffer.from(str, 'utf8');
  let h = 0;
  for (let i = 0; i < buf.length; i++) h = (h * 31 + buf[i]) % 1000000007;
  return h;
}

function buildStub(keyB64, dataB64, chk) {
  const [KEY, DATA, B64, XOR, RC4, SRC, LD, FN, H] = distinctNames(9);
  return `local ${KEY}="${keyB64}"
local ${DATA}="${dataB64}"
local function ${B64}(d)
local b='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
d=string.gsub(d,'[^'..b..'=]','')
return (d:gsub('.',function(x)
if x=='=' then return '' end
local r,f='',(b:find(x)-1)
for i=6,1,-1 do r=r..(f%2^i-f%2^(i-1)>0 and '1' or '0') end
return r
end):gsub('%d%d%d?%d?%d?%d?%d?%d?',function(x)
if #x~=8 then return '' end
local c=0
for i=1,8 do c=c+(x:sub(i,i)=='1' and 2^(8-i) or 0) end
return string.char(c)
end))
end
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
j=(j+S[i]+string.byte(k,(i%#k)+1))%256
S[i],S[j]=S[j],S[i]
end
local o={}
local a,c=0,0
for m=1,#d do
a=(a+1)%256
c=(c+S[a])%256
S[a],S[c]=S[c],S[a]
o[m]=string.char(${XOR}(string.byte(d,m),S[(S[a]+S[c])%256]))
end
return table.concat(o)
end
local ${SRC}=${RC4}(${B64}(${KEY}),${B64}(${DATA}))
local ${H}=0.0
for i=1,#${SRC} do ${H}=(${H}*31+string.byte(${SRC},i))%1000000007 end
if ${H}~=${chk} then return warn("[2t1auth] integrity check failed") end
local ${LD}=loadstring or load
local ${FN}=${LD}(${SRC})
if ${FN} then return ${FN}() end`;
}

/**
 * Obfuscate a script for delivery. Pass the script row (needs id, source, updated_at).
 * @param {object} script
 * @param {{minify?:boolean}} [opts]
 * @returns {string} Lua decryptor stub
 */
function obfuscate(script, { minify = true } = {}) {
  const source = minify ? minifySource(script) : script.source;
  const key = crypto.randomBytes(16);
  const cipher = rc4(key, Buffer.from(source, 'utf8'));
  return buildStub(key.toString('base64'), cipher.toString('base64'), checksum(source));
}

module.exports = { obfuscate, rc4, _buildStub: buildStub };

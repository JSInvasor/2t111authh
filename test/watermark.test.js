'use strict';
// Traitor tracing: every protected delivery carries the identity of the key that
// asked for it, readable only by this server.
//
// Two things have to hold, and the second matters more than the first. It has to
// name the right key — and it has to refuse to name anybody when it doesn't
// actually know. A watermark that accuses the wrong customer is worse than none.

const path = require('node:path');
const os = require('node:os');
const nodeCrypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.DB_PATH = path.join(
  os.tmpdir(),
  `2t1auth-watermark-${process.pid}-${nodeCrypto.randomBytes(4).toString('hex')}.db`
);

const test = require('node:test');
const assert = require('node:assert');

const scripts = require('../src/services/scripts');
const keys = require('../src/services/keys');
const watermark = require('../src/services/watermark');
const { deliverySource, obfuscate, rc4 } = require('../src/services/obfuscator');

let luaparse = null;
try {
  luaparse = require('luaparse');
} catch {
  /* the feature is a no-op without it — see the last test */
}
const skip = !luaparse;

// Enough locals, strings and numbers to carry a full 32-bit mark.
const SOURCE = `
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local player = Players.LocalPlayer
local walkSpeed = 16
local jumpPower = 50
local targets = { "alpha", "beta", "gamma", "delta" }
local settings = { aim = true, smooth = 12, fov = 120 }

local function boost(multiplier)
  local total = walkSpeed * multiplier
  for index = 1, #targets do
    print("boosting " .. targets[index] .. " to " .. total)
  end
  return total
end

local function reset()
  walkSpeed = 16
  jumpPower = 50
  settings.smooth = 12
  return walkSpeed, jumpPower
end

local function watch(callback)
  RunService.RenderStepped:Connect(function(delta)
    if settings.aim and delta < 1 then callback(delta * 60) end
  end)
end

boost(2)
reset()
watch(print)
`;

function mk(count = 200) {
  const script = scripts.createScript({ name: 'Traceable', source: SOURCE, hwid_lock: 0, obfuscate: 1 });
  const made = keys.createKeys(script.id, { count });
  return { script, made, plan: watermark.planFor(script.id, deliverySource(script)) };
}

/** The bytes a dumper ends up with: the stub's payload, decrypted. */
function dumpOf(script, keyId) {
  const stub = obfuscate(script, { keyId });
  const blobs = [...stub.matchAll(/"([A-Za-z0-9+/=]{16,})"/g)].map((m) => m[1]);
  for (const keyB64 of blobs) {
    for (const dataB64 of blobs) {
      try {
        const out = rc4(Buffer.from(keyB64, 'base64'), Buffer.from(dataB64, 'base64')).toString('utf8');
        if (out.includes('GetService')) return out;
      } catch {
        /* wrong pairing */
      }
    }
  }
  throw new Error('could not recover the delivered source from the stub');
}

const traceOf = (plan, sample, script, made) =>
  watermark.trace(plan, sample, script.id, keys.allKeysForTrace(script.id));

/* ------------------------------ it names them ------------------------------ */

test('a dumped copy names the key it was delivered to', { skip }, () => {
  const { script, made, plan } = mk(200);
  const leaker = made[137];

  const t = traceOf(plan, dumpOf(script, leaker.id), script, made);

  assert.strictEqual(t.matches[0].value, leaker.value, 'named the wrong key');
  assert.ok(t.confident, `not confident: expected_false=${t.matches[0].expected_false}`);
  assert.ok(t.matches[0].expected_false < 0.01);
  assert.ok(t.matches[1].matched < t.matches[0].matched, 'the runner-up was not left behind');
});

test('it works for any key, not just a lucky one', { skip }, () => {
  const { script, made, plan } = mk(120);
  for (const i of [0, 1, 41, 99, 119]) {
    const t = traceOf(plan, dumpOf(script, made[i].id), script, made);
    assert.strictEqual(t.matches[0].value, made[i].value, `key #${i} traced to the wrong owner`);
    assert.ok(t.confident, `key #${i} was not confident`);
  }
});

test('the mark survives a fragment of the leak', { skip }, () => {
  const { script, made, plan } = mk(150);
  const leaker = made[64];
  const full = dumpOf(script, leaker.id);

  // Someone pastes the middle third of what they found.
  const third = Math.floor(full.length / 3);
  const t = traceOf(plan, full.slice(third, third * 2), script, made);
  assert.strictEqual(t.matches[0].value, leaker.value);
  assert.ok(t.carriers_read < t.carriers_total, 'the fragment should not carry every carrier');
});

test('the mark survives reformatting and pasted-in code', { skip }, () => {
  const { script, made, plan } = mk(150);
  const leaker = made[88];
  const mangled =
    '-- cracked by someone\nlocal junk = 1\n' +
    dumpOf(script, leaker.id).replace(/\n/g, '\n\n').replace(/  +/g, ' ') +
    '\nprint("skidded")\n';

  const t = traceOf(plan, mangled, script, made);
  assert.strictEqual(t.matches[0].value, leaker.value);
});

/* --------------------------- it refuses to guess --------------------------- */

test('unmarked source accuses nobody', { skip }, () => {
  // The master copy. It carries no mark, so nothing should read as one — this is
  // the case that would otherwise always finger whichever key sits near zero.
  const { script, made, plan } = mk(200);
  const t = traceOf(plan, deliverySource(script), script, made);
  assert.ok(!t.confident, `unmarked source produced a confident accusation of ${t.matches[0].value}`);
});

test('a stranger\'s script accuses nobody', { skip }, () => {
  const { script, made, plan } = mk(200);
  const stranger = `
    local a = game:GetService("Workspace")
    local speed = 42
    local list = { "one", "two" }
    for i = 1, #list do print(list[i], speed, a) end
  `.repeat(4);
  const t = traceOf(plan, stranger, script, made);
  assert.ok(!t.confident, 'an unrelated script produced a confident accusation');
});

test('too little to read means no verdict, not a wrong one', { skip }, () => {
  const { script, made, plan } = mk(200);
  const t = traceOf(plan, 'local x = 1\nprint(x)\n', script, made);
  assert.ok(!t.confident);
  assert.ok(t.bits_recovered < watermark.TAG_BITS);
});

/* ------------------------------ it stays safe ------------------------------ */

test('the marked copy is still the same program', { skip }, () => {
  const { script, made } = mk(20);
  const original = deliverySource(script);
  const marked = watermark.apply(original, { scriptId: script.id, keyId: made[3].id });

  assert.notStrictEqual(marked, original, 'nothing was marked at all');
  // Parses, and to the same shape — the mark rides on choices Lua does not care
  // about, so the tree either side of it has to be identical.
  const shape = (src) =>
    JSON.stringify(luaparse.parse(src, { scope: false, ranges: false, comments: false }), (k, v) =>
      k === 'name' || k === 'value' || k === 'raw' ? undefined : v
    );
  assert.strictEqual(shape(marked), shape(original), 'the mark changed the structure of the program');
});

test('two keys get different bytes, the same key gets the same bytes', { skip }, () => {
  const { script, made } = mk(20);
  const a1 = watermark.apply(deliverySource(script), { scriptId: script.id, keyId: made[1].id });
  const a2 = watermark.apply(deliverySource(script), { scriptId: script.id, keyId: made[1].id });
  const b = watermark.apply(deliverySource(script), { scriptId: script.id, keyId: made[2].id });

  assert.strictEqual(a1, a2, 'the same key produced two different copies');
  assert.notStrictEqual(a1, b, 'two keys produced identical copies');
});

test('a mark for one script cannot be read by another', { skip }, () => {
  const a = mk(100);
  const b = mk(100);
  // Same source, same key index, different script id.
  const t = watermark.trace(b.plan, dumpOf(a.script, a.made[9].id), b.script.id, keys.allKeysForTrace(b.script.id));
  assert.ok(!t.confident, "one script's mark was read as another's");
});

test('source that will not parse is delivered untouched rather than broken', { skip }, () => {
  // Luau syntax luaparse cannot read. Marking must decline, not corrupt.
  const src = 'local a: number = 1\na += 2\nfor i=1,3 do continue end\nprint(a)\n';
  const script = scripts.createScript({ name: 'Luau', source: src, hwid_lock: 0, obfuscate: 1 });
  keys.createKeys(script.id, { count: 2 });

  assert.strictEqual(watermark.planFor(script.id, src), null, 'claimed it could mark unparseable source');
  assert.strictEqual(
    watermark.apply(src, { scriptId: script.id, keyId: 1 }),
    src,
    'unparseable source was altered anyway'
  );
});

test('watermarking never takes down a delivery', () => {
  // Whatever happens in here, the customer still gets their script.
  const script = scripts.createScript({ name: 'Resilient', source: SOURCE, hwid_lock: 0, obfuscate: 1 });
  const [key] = keys.createKeys(script.id, { count: 1 });
  assert.doesNotThrow(() => obfuscate(script, { keyId: key.id }));
  assert.doesNotThrow(() => obfuscate(script, { keyId: 999999 })); // key that does not exist
  assert.doesNotThrow(() => obfuscate(script, { keyId: null })); // unmarked path
});

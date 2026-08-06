'use strict';
// Per-key watermarking: that a marked copy runs identically to an unmarked one,
// that a leaked copy names the key it came from, and — the part that matters —
// that nothing else ever gets named.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.DB_PATH = path.join(os.tmpdir(), `2t1auth-wm-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);

const test = require('node:test');
const assert = require('node:assert');
const luamin = require('luamin');
const wm = require('../src/services/watermark');
const { obfuscate, deliverySource, rc4 } = require('../src/services/obfuscator');

let luaparse = null;
try {
  luaparse = require('luaparse');
} catch {
  /* the parser is what makes any of this possible; without it every test below
     is asserting the fail-safe path, which is checked explicitly anyway */
}
let fengari = null;
try {
  fengari = require('fengari');
} catch {
  /* optional — the behavioural-equivalence test is skipped without it */
}

/* ------------------------------- fixtures ------------------------------- */

// A real-sized protected script — the one capacity and tracing are measured
// against, since how much evidence survives an attack depends on how much
// script there was to carry it. Parsed and marked, never run.
const HUB = luamin.minify(fs.readFileSync(path.join(__dirname, 'helpers', 'hub.lua'), 'utf8'));

// Small, self-contained, and full of scoping traps — shadowing, an upvalue, a
// colon method, a local named like a table field. This is the one that gets
// executed, so a careless rename shows up as a different answer.
const SRC = `
local Config = { speed = 16, jump = 4096, label = "player-hub" }
local Cache = {}
local function clamp(value, low, high)
  if value < low then return low end
  if value > high then return high end
  return value
end
local Session = {}
Session.__index = Session
function Session.new(owner)
  return setmetatable({ owner = owner, hits = 0, tag = "session" }, Session)
end
function Session:record(amount)
  local amount = clamp(amount, 1, 8192)
  self.hits = self.hits + amount
  Cache[self.owner] = self.hits
  return self.hits
end
local function summarize(list)
  local out = {}
  for index, entry in ipairs(list) do
    out[#out + 1] = entry.tag .. "=" .. tostring(entry.hits) .. "/" .. tostring(index)
  end
  return table.concat(out, ",")
end
local a = Session.new("alpha")
local b = Session.new("beta")
a:record(1024)
b:record(65536)
local total = a.hits + b.hits + Config.speed + Config.jump
return summarize({ a, b }) .. "|" .. tostring(total) .. "|" .. Config.label
`;

const MIN = luamin.minify(SRC);
const SID = 'sc_watermark_test';
const HUB_ID = 'sc_watermark_hub';

// A different script entirely — the innocent bystander in every false-positive
// check below.
const OTHER = luamin.minify(`
local Registry = { retries = 32, window = 2048, name = "other-project" }
local function connect(host, port, retries)
  local attempts = 0
  while attempts < retries do
    attempts = attempts + 1
    if host ~= nil and port > 1024 then return attempts, "connected" end
  end
  return attempts, "failed"
end
local tries, state = connect("example", 8080, Registry.retries)
return Registry.name .. "/" .. tostring(tries) .. "/" .. state
`);

const plan = luaparse ? wm.planFor(SID, MIN) : null;
const hubPlan = luaparse ? wm.planFor(HUB_ID, HUB) : null;
const marked = (id) => wm.apply(MIN, { scriptId: SID, keyId: id });
const markedHub = (id) => wm.apply(HUB, { scriptId: HUB_ID, keyId: id });
const candidates = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1 }));
const traceOf = (sample) => wm.trace(hubPlan, sample, HUB_ID, candidates);

/* --------------------------- shape and safety --------------------------- */

test('a plan covers every tag bit with room to spare', { skip: !luaparse }, () => {
  assert.ok(hubPlan, 'no plan built for the fixture');
  assert.strictEqual(hubPlan.coverage, wm.TAG_BITS, 'some tag bits have no carrier');
  // Redundancy is what survives a partial leak; without it a fragment decodes to
  // nothing. Each bit should be spoken for more than once.
  assert.ok(hubPlan.sites.length >= wm.TAG_BITS * 2, `only ${hubPlan.sites.length} carriers`);
  for (const kind of ['ident', 'str', 'num']) {
    assert.ok(hubPlan.sites.some((s) => s.kind === kind), `no ${kind} carriers`);
  }
});

test('marked copies are deterministic and differ per key', { skip: !luaparse }, () => {
  assert.strictEqual(marked(1), marked(1), 'same key produced two different copies');
  const seen = new Set();
  for (let id = 1; id <= 50; id++) seen.add(marked(id));
  assert.strictEqual(seen.size, 50, 'two keys got byte-identical copies');
  assert.ok(!seen.has(MIN), 'a key got the unmarked source');
});

test('every marked copy still parses as Lua', { skip: !luaparse }, () => {
  for (let id = 1; id <= 50; id++) {
    assert.doesNotThrow(() => luaparse.parse(marked(id)), `key ${id} produced unparseable Lua`);
  }
});

test('marking never changes what the script does', { skip: !luaparse || !fengari }, () => {
  const { lua, lauxlib, lualib, to_luastring } = fengari;
  const run = (code) => {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const buf = to_luastring(code);
    // Named the way the delivery stub names it, so an error message can't echo
    // the chunk's own (per-key) source text back at us.
    if (lauxlib.luaL_loadbuffer(L, buf, buf.length, to_luastring('=script')) !== lua.LUA_OK) {
      return 'load: ' + lua.lua_tojsstring(L, -1);
    }
    if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) return 'run: ' + lua.lua_tojsstring(L, -1);
    return String(lua.lua_tojsstring(L, -1));
  };

  const want = run(MIN);
  assert.ok(want && !want.startsWith('load:') && !want.startsWith('run:'), `fixture broken: ${want}`);
  for (let id = 1; id <= 40; id++) {
    assert.strictEqual(run(marked(id)), want, `key ${id} changed the result`);
  }
});

/* -------------------------------- tracing -------------------------------- */

test('a verbatim dump names the key it came from', { skip: !luaparse }, () => {
  for (const id of [1, 7, 42, 1234, 5000]) {
    const t = traceOf(markedHub(id));
    assert.strictEqual(t.matches[0].id, id, `key ${id} misattributed`);
    assert.strictEqual(t.bits_recovered, wm.TAG_BITS, 'lost bits on a clean sample');
    assert.strictEqual(t.matches[0].matched, wm.TAG_BITS);
    assert.ok(t.confident, `not confident about key ${id}`);
    assert.ok(t.matches[0].expected_false < 1e-4, `weak evidence: ${t.matches[0].expected_false}`);
  }
});

test('the mark survives what a thief actually does to it', { skip: !luaparse }, () => {
  const id = 777;
  const copy = markedHub(id);
  const mangled = {
    'reformatted onto many lines': copy.replace(/;/g, ';\n').replace(/\bend\b/g, '\nend\n'),
    'only the first half': copy.slice(0, Math.floor(copy.length / 2)),
    'only the last third': copy.slice(Math.floor((copy.length * 2) / 3)),
    'pasted into their own code': `-- cracked by nobody\nlocal Hook = {}\n${copy}\nprint(Hook)`,
    're-minified through a mangler': luamin.minify(copy),
  };
  for (const [what, sample] of Object.entries(mangled)) {
    const t = traceOf(sample);
    assert.strictEqual(t.matches[0].id, id, `misattributed after: ${what}`);
    assert.ok(t.confident, `not confident after: ${what} (${t.bits_recovered} bits)`);
  }
});

test('a re-minified copy still reads, on the channels renaming cannot touch', { skip: !luaparse }, () => {
  const t = traceOf(luamin.minify(markedHub(31)));
  // Locals are gone — that is exactly what re-minifying does — but the string
  // and number channels are untouched by a rename, so the mark still decodes.
  assert.strictEqual(t.carriers_by_kind.read.ident, 0, 'renamed locals should not read back');
  assert.ok(t.carriers_by_kind.read.str > 0, 'string channel died');
  assert.ok(t.carriers_by_kind.read.num > 0, 'number channel died');
  assert.strictEqual(t.matches[0].id, 31);
  assert.ok(t.confident);
});

test('an intact copy reads back on all three channels', { skip: !luaparse }, () => {
  const t = traceOf(markedHub(9));
  for (const kind of ['ident', 'str', 'num']) {
    assert.strictEqual(
      t.carriers_by_kind.read[kind],
      t.carriers_by_kind.total[kind],
      `${kind} carriers went missing from an untouched copy`
    );
  }
  assert.strictEqual(t.carriers_read, t.carriers_total);
});

/* ------------------------- the false-positive line ------------------------- */
// The governing constraint: never name an innocent key. Each of these samples
// belongs to nobody, and each must come back unconfident.

test('unmarked and unrelated samples accuse no one', { skip: !luaparse }, () => {
  const nobody = {
    'the unmarked master copy': HUB,
    'a different script entirely': OTHER,
    'a fragment of someone else’s code': OTHER.slice(0, 200),
    'another script of ours, marked for one of its own keys': marked(4321),
    'plain prose': 'this is not lua at all, just some words in a file '.repeat(20),
  };
  for (const [what, sample] of Object.entries(nobody)) {
    const t = traceOf(sample);
    assert.ok(!t.confident, `named a key from: ${what} (best ${JSON.stringify(t.matches[0])})`);
  }
});

test('no key is systematically favoured by unmarked text', { skip: !luaparse }, () => {
  // The bug this guards against: if every site's bit 0 were the "natural"
  // spelling, any Lua text at all would vote all-zeros and forever implicate
  // whichever key happens to hash to zeros. A blank vote must look like noise.
  const t = traceOf(HUB);
  assert.ok(
    t.matches[0].matched < wm.TAG_BITS * 0.9,
    `unmarked source matched ${t.matches[0].matched}/${wm.TAG_BITS} bits of key ${t.matches[0].id}`
  );
  assert.ok(t.matches[0].expected_false > 0.01, 'chance explains this too well to be a real hit');
});

test('too little evidence means no answer, never a wrong one', { skip: !luaparse }, () => {
  // Walk a copy down to nothing. Confidence has to fall away as the evidence
  // does — the one outcome that must never happen is a confident wrong name.
  const id = 4242;
  const copy = markedHub(id);
  let sawUnconfident = false;
  for (let take = copy.length; take > 0; take = Math.floor(take / 2)) {
    const t = traceOf(copy.slice(0, take));
    if (t.confident) assert.strictEqual(t.matches[0].id, id, `confidently wrong on ${take} bytes`);
    else sawUnconfident = true;
  }
  assert.ok(sawUnconfident, 'a near-empty sample still claimed a key');
});

test('a key that never got a copy is never the answer', { skip: !luaparse }, () => {
  // 200 real deliveries, scored against a 20k key list each time.
  const pool = Array.from({ length: 20000 }, (_, i) => ({ id: i + 1 }));
  for (let n = 0; n < 200; n++) {
    const id = 1 + ((n * 97 + 13) % 20000);
    const t = wm.trace(hubPlan, markedHub(id), HUB_ID, pool);
    assert.strictEqual(t.matches[0].id, id, `attributed a copy of key ${id} to key ${t.matches[0].id}`);
    assert.ok(t.confident);
  }
});

/* -------------------------------- fail-safe -------------------------------- */

test('anything missing leaves the source untouched', () => {
  assert.strictEqual(wm.apply(MIN, { scriptId: SID, keyId: null }), MIN, 'marked without a key');
  assert.strictEqual(wm.apply(MIN, { scriptId: null, keyId: 1 }), MIN, 'marked without a script');
});

test('source that does not parse is passed through, not mangled', { skip: !luaparse }, () => {
  // Luau-only syntax luaparse cannot read. Better no watermark than a broken script.
  const luau = 'local x: number = 5\nlocal function f(a: string): string return a end\nreturn f("hi") .. x';
  assert.strictEqual(wm.planFor('sc_luau', luau), null, 'built a plan for unparseable source');
  assert.strictEqual(wm.apply(luau, { scriptId: 'sc_luau', keyId: 1 }), luau);
});

test('a script with nothing to carry a mark is left alone', { skip: !luaparse }, () => {
  assert.strictEqual(wm.planFor('sc_bare', 'return 1'), null);
  assert.strictEqual(wm.apply('return 1', { scriptId: 'sc_bare', keyId: 1 }), 'return 1');
});

test('editing a script invalidates its cached plan', { skip: !luaparse }, () => {
  wm._resetPlanCache();
  const before = wm.planFor('sc_edit', MIN);
  assert.strictEqual(wm.planFor('sc_edit', MIN), before, 'plan was rebuilt for identical source');
  const after = wm.planFor('sc_edit', OTHER);
  assert.notStrictEqual(after, before, 'stale plan reused after the source changed');
  assert.strictEqual(wm._planCacheSize(), 1);
});

test('the plan cache stays bounded', { skip: !luaparse }, () => {
  wm._resetPlanCache();
  for (let i = 0; i < 150; i++) wm.planFor('sc_bulk_' + i, MIN);
  assert.ok(wm._planCacheSize() <= 100, `cache grew to ${wm._planCacheSize()}`);
});

/* --------------------------- through the pipeline --------------------------- */

test('the mark reaches the delivered stub and traces back out of it', { skip: !luaparse }, () => {
  const script = { id: 'sc_pipeline', source: SRC, updated_at: 1, obfuscate: 1 };
  const body = deliverySource(script);
  const p = wm.planFor(script.id, body);
  assert.ok(p, 'delivery source could not be watermarked');

  // Two keys, decrypted back out of their own stubs — this is what a thief who
  // dumps the loaded chunk ends up holding.
  const dumped = (keyId) => {
    const stub = obfuscate(script, { keyId });
    const data = stub.match(/^local \w+="([A-Za-z0-9+/=]*)"/m);
    const key = stub.match(/=\w+\("([A-Za-z0-9+/=]+)"\)/);
    return rc4(Buffer.from(key[1], 'base64'), Buffer.from(data[1], 'base64')).toString('utf8');
  };

  const pool = Array.from({ length: 3000 }, (_, i) => ({ id: i + 1 }));
  for (const id of [3, 2999]) {
    const t = wm.trace(p, dumped(id), script.id, pool);
    assert.strictEqual(t.matches[0].id, id);
    assert.ok(t.confident);
  }
  assert.notStrictEqual(dumped(3), dumped(2999), 'two keys got the same payload');
});

test('the stub names its inner chunk, so errors cannot echo the mark', () => {
  // Unnamed, Lua titles the chunk with a slice of its own source — which, once
  // that source is watermarked, means every error message quotes part of the
  // mark. The name given has to be generic enough to identify nothing.
  const script = { id: 'sc_chunkname', source: 'error("boom")', updated_at: 1, obfuscate: 1 };
  const stub = obfuscate(script, { keyId: 1 });
  assert.match(stub, /\(\w+,"=script"\)/, 'inner chunk is loaded unnamed');
  assert.ok(!/2t1|auth/i.test(stub.slice(stub.indexOf('"='))), 'chunk name identifies the product');
});

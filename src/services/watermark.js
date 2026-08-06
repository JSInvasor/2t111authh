'use strict';

/**
 * Per-key watermarking — traitor tracing for delivered scripts.
 *
 * Every delivery is already byte-unique, but only *randomly* so. This makes it
 * *identifiably* so: the copy handed to key A differs from the copy handed to
 * key B in a way only this server can read back, so a dump posted in a Discord
 * server names the key it was taken from.
 *
 * It does not stop a dump — nothing running inside the attacker's own executor
 * can — but it removes the anonymity that makes leaking free.
 *
 * The mark rides on choices Lua does not care about, so it costs nothing at
 * runtime and is invisible in a diff against a normal minified build:
 *
 *   • which name each local variable gets (2 bits each, 4 candidates)
 *   • whether a string literal is single- or double-quoted (1 bit each)
 *   • whether an integer is written decimal or hex (1 bit each)
 *
 * Identifiers carry the most, but die if the thief re-minifies. Strings and
 * numbers survive a re-mangle, so the three together degrade gracefully.
 * Each carrier decodes on its own — no ordering, no framing — so a leak that is
 * only part of the script, reformatted, or has the thief's own code pasted in
 * still reads back the bits it kept.
 *
 * Safety is the whole game here: a watermark that corrupts one script in a
 * thousand is worse than no watermark. See buildPlan/verify below — a plan is
 * only used after the rewritten source has been re-parsed and proved
 * structurally identical to the original.
 */

const crypto = require('crypto');
const config = require('../config');

let luaparse = null;
try {
  luaparse = require('luaparse');
} catch {
  /* optional — delivery still works, it just can't be traced */
}

/* ------------------------------- shape ------------------------------- */

// Bits of key identity a delivery carries. At 32, a wrong key's odds of
// matching a fully recovered mark are 1 in 4.3 billion, so even a six-figure
// key list stays a long way from an accidental accusation.
const TAG_BITS = 32;
// Bits each renamed local carries — 2 means 4 candidate names per local.
const IDENT_WIDTH = 2;
// Shorter strings turn up by chance in unrelated code, so they aren't trusted.
const MIN_STRING = 3;
const PLAN_CACHE_MAX = 100;

const PARSE_OPTS = { scope: true, ranges: true, comments: false };

const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto',
  'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true',
  'until', 'while',
]);

/* ------------------------------ key stream ------------------------------ */

/** Deterministic 32-byte pseudorandom block. Secret-keyed, so nothing about the
 *  layout of a mark can be worked out from the delivered file alone. */
function prf(...parts) {
  return crypto.createHmac('sha256', config.sessionSecret).update(parts.join('\u0000')).digest();
}

/**
 * The 32 bits that identify one key. Recovering them is a search over the
 * script's own keys (one HMAC each) — they can't be inverted, and they can't be
 * forged onto someone else without the server secret.
 */
function tagBits(scriptId, keyId) {
  const d = prf('tag', String(scriptId), String(keyId));
  const bits = new Uint8Array(TAG_BITS);
  for (let i = 0; i < TAG_BITS; i++) bits[i] = (d[i >> 3] >> (7 - (i & 7))) & 1;
  return bits;
}

/** Read the value a site encodes out of a tag: its bits, most significant first. */
function valueAt(bits, positions) {
  let v = 0;
  for (const p of positions) v = (v << 1) | bits[p];
  return v;
}

/**
 * Where a content-addressed carrier (a string, a number) sits: which tag bit it
 * speaks for, and whether its two spellings are listed in the natural order.
 *
 * The flip matters. Without it, bit 0 would always be the spelling Lua source is
 * normally written in, so *any* unmarked code — our own master, a sibling
 * script, a stranger's — would read back as an all-zero mark and forever name
 * whichever key happens to sit closest to zero. Flipped per site, unmarked text
 * reads as noise, which is what it is.
 */
function slotFor(scriptId, kind, content) {
  const d = prf('slot', String(scriptId), kind, content);
  return { bit: d.readUInt32BE(0) % TAG_BITS, flip: d[4] & 1 };
}

/** Order a carrier's two spellings as its slot dictates. */
const ordered = (pair, flip) => (flip ? [pair[1], pair[0]] : pair);

/** Fisher-Yates over a keyed stream — reproducible from the secret, unguessable without it. */
function shuffle(arr, seed) {
  let block = null;
  let off = 32;
  let ctr = 0;
  const next = () => {
    if (off + 4 > 32) {
      block = prf('shuffle', seed, String(ctr++));
      off = 0;
    }
    const v = block.readUInt32BE(off);
    off += 4;
    return v;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Candidate names for renamed locals, in a per-script secret order.
 *
 * Every entry is *fresh*: it appears nowhere in the source, as an identifier,
 * a field, a table key, or even inside a string. That is what makes renaming
 * provably safe — see buildPlan.
 */
function namePool(scriptId, used, count) {
  const L = 'abcdefghijklmnopqrstuvwxyz';
  const out = [];
  const take = (n) => {
    if (!used.has(n) && !KEYWORDS.has(n)) out.push(n);
  };
  for (const a of L) for (const b of L) take(a + b);
  if (out.length < count) {
    outer: for (const a of L) {
      for (const b of L) {
        for (const c of L) {
          take(a + b + c);
          if (out.length >= count + 64) break outer;
        }
      }
    }
  }
  shuffle(out, `pool|${scriptId}`);
  return out.slice(0, count);
}

/* -------------------------------- walking -------------------------------- */

/** Visit every AST node, telling the visitor which property it hung off. */
function walk(node, visit, key) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit, key);
    return;
  }
  if (typeof node.type === 'string') visit(node, key);
  for (const k of Object.keys(node)) {
    if (k === 'range' || k === 'loc') continue;
    walk(node[k], visit, k);
  }
}

/**
 * Canonical form of an AST for comparison: positions and literal spellings
 * dropped (those are exactly what we change), renamed locals mapped back.
 * Two sources with the same skeleton are the same program.
 */
function skeleton(ast, unmap) {
  return JSON.stringify(ast, (k, v) => {
    if (k === 'range' || k === 'loc' || k === 'raw') return undefined;
    if (unmap && v && v.type === 'Identifier' && unmap.has(v.name)) {
      return { ...v, name: unmap.get(v.name) };
    }
    return v;
  });
}

/* ------------------------------ plan building ------------------------------ */

/**
 * Work out every place this source can carry a bit, and what the alternatives
 * are. Expensive (it parses), so it is cached per script version and reused for
 * every key — stamping an actual key into it is then just string splicing.
 *
 * @returns {object|null} null when the source can't be marked safely
 */
function buildPlan(source, scriptId) {
  if (!luaparse) return null;

  let ast;
  try {
    ast = luaparse.parse(source, PARSE_OPTS);
  } catch {
    return null; // Luau-only syntax, or not Lua at all — leave it alone
  }

  const occ = new Map(); // local name -> [[start,end], ...]
  const globals = new Set();
  const labels = new Set();
  const strings = new Map(); // value -> { ok, ranges: [[start,end], ...] }
  const numbers = new Map(); // value -> { ok, ranges: [[start,end], ...] }

  const note = (map, value, range, ok) => {
    let e = map.get(value);
    if (!e) map.set(value, (e = { ok: true, ranges: [] }));
    if (ok) e.ranges.push(range);
    else e.ok = false; // one awkward spelling disqualifies the value everywhere
  };

  walk(ast, (n, key) => {
    if (n.type === 'Identifier') {
      // `::top::` and `goto top` are a namespace of their own — luaparse marks
      // the declaration local and the jump not, so renaming would split them.
      if (key === 'label') return labels.add(n.name);
      if (n.isLocal === true) {
        if (!occ.has(n.name)) occ.set(n.name, []);
        occ.get(n.name).push(n.range);
      } else if (n.isLocal === false) {
        globals.add(n.name);
      }
      // isLocal undefined = a field or table key, not a variable. Left alone.
    } else if (n.type === 'StringLiteral') {
      const raw = n.raw || '';
      const q = raw[0];
      const plain =
        (q === '"' || q === "'") &&
        raw.length >= 2 &&
        raw[raw.length - 1] === q &&
        !/["'\\]/.test(raw.slice(1, -1));
      note(strings, n.value, n.range, plain && String(n.value).length >= MIN_STRING);
    } else if (n.type === 'NumericLiteral') {
      // Only plain decimal integers big enough that a hex spelling is unambiguous.
      const plain = /^\d+$/.test(n.raw || '') && Number.isSafeInteger(n.value);
      note(numbers, n.value, n.range, plain && n.value >= 16 && n.value <= 0x7fffffff);
    }
  });

  // Every word anywhere in the file — identifiers, fields, and the contents of
  // strings, so a name reached through `_G["ab"]` can't be shadowed either.
  const used = new Set(source.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []);

  // A name used both as a local and as a global (or as a label) is ambiguous;
  // skip it rather than guess. What's left can be renamed by a plain bijection
  // onto fresh names, which provably preserves every binding: distinct names
  // stay distinct, shadowing stays shadowing, and no global can be captured
  // because no pool name occurs anywhere in the original.
  //
  // `self` is the one name Lua binds without writing it down: `function t:m()`
  // declares it invisibly, so the parser reports the uses as local but there is
  // no declaration to rename alongside them. It is also the only such name in
  // the language — everything else, loop variables included, is declared where
  // you can see it.
  const renamable = [...occ.keys()]
    .filter((n) => n !== 'self' && !globals.has(n) && !labels.has(n))
    .sort((a, b) => Math.min(...occ.get(a).map((r) => r[0])) - Math.min(...occ.get(b).map((r) => r[0])));

  const variantCount = 1 << IDENT_WIDTH;
  const pool = namePool(scriptId, used, renamable.length * variantCount);
  const nIdent = Math.min(renamable.length, Math.floor(pool.length / variantCount));

  const sites = [];
  const edits = [];
  const addSite = (site, ranges) => {
    const i = sites.push(site) - 1;
    for (const r of ranges) edits.push({ start: r[0], end: r[1], site: i });
  };

  for (let i = 0; i < nIdent; i++) {
    const name = renamable[i];
    addSite(
      {
        kind: 'ident',
        orig: name,
        positions: [(i * IDENT_WIDTH) % TAG_BITS, (i * IDENT_WIDTH + 1) % TAG_BITS],
        variants: pool.slice(i * variantCount, i * variantCount + variantCount),
      },
      occ.get(name)
    );
  }

  for (const [value, e] of strings) {
    if (!e.ok || !e.ranges.length) continue;
    const slot = slotFor(scriptId, 's', value);
    addSite(
      { kind: 'str', positions: [slot.bit], variants: ordered([`"${value}"`, `'${value}'`], slot.flip) },
      e.ranges
    );
  }

  for (const [value, e] of numbers) {
    if (!e.ok || !e.ranges.length) continue;
    const slot = slotFor(scriptId, 'n', String(value));
    addSite(
      {
        kind: 'num',
        positions: [slot.bit],
        variants: ordered([String(value), `0x${value.toString(16)}`], slot.flip),
      },
      e.ranges
    );
  }

  if (!sites.length) return null;

  edits.sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].start < edits[i - 1].end) return null; // overlapping spans — bail
  }

  const plan = {
    base: source,
    sites,
    edits,
    renamed: new Set(renamable.slice(0, nIdent)),
    coverage: new Set(sites.flatMap((s) => s.positions)).size,
  };

  return verify(plan, ast) ? plan : null;
}

/**
 * Prove the rewrite is a no-op to Lua before anyone runs it.
 *
 * Renders the plan at both ends of its range, re-parses each result and demands
 * a byte-identical skeleton, plus that no renamed local survived under its old
 * name anywhere — which is what would happen if the parser under-reported a use
 * and left it pointing at a name we moved.
 */
function verify(plan, baseAst) {
  const want = skeleton(baseAst, null);

  for (const pick of [() => 0, (s) => s.variants.length - 1]) {
    const out = renderWith(plan, pick);
    let ast;
    try {
      ast = luaparse.parse(out, PARSE_OPTS);
    } catch {
      return false;
    }
    const unmap = new Map();
    for (const s of plan.sites) if (s.kind === 'ident') unmap.set(s.variants[pick(s)], s.orig);
    if (skeleton(ast, unmap) !== want) return false;

    let stranded = false;
    walk(ast, (n) => {
      if (n.type === 'Identifier' && n.isLocal !== undefined && plan.renamed.has(n.name)) stranded = true;
    });
    if (stranded) return false;
  }
  return true;
}

/* -------------------------------- rendering -------------------------------- */

function renderWith(plan, pick) {
  const parts = [];
  let pos = 0;
  for (const e of plan.edits) {
    const site = plan.sites[e.site];
    parts.push(plan.base.slice(pos, e.start), site.variants[pick(site)]);
    pos = e.end;
  }
  parts.push(plan.base.slice(pos));
  return parts.join('');
}

/** Stamp one key's tag into the source. */
function render(plan, bits) {
  return renderWith(plan, (s) => valueAt(bits, s.positions));
}

/* ------------------------------- plan cache ------------------------------- */

const planCache = new Map(); // scriptId -> { sig, plan }

/** Cheap, collision-free-enough stamp of exactly what we are about to mark. */
function signature(source) {
  return `${source.length}:${crypto.createHash('sha1').update(source).digest('hex')}`;
}

function planFor(scriptId, source) {
  const sig = signature(source);
  const hit = planCache.get(scriptId);
  if (hit && hit.sig === sig) return hit.plan;

  const plan = buildPlan(source, scriptId);
  if (!planCache.has(scriptId) && planCache.size >= PLAN_CACHE_MAX) {
    planCache.delete(planCache.keys().next().value);
  }
  planCache.set(scriptId, { sig, plan });
  return plan;
}

/**
 * Watermark `source` for one key. Falls back to the source untouched whenever
 * anything is off — no watermark is always better than a broken script.
 */
function apply(source, { scriptId, keyId }) {
  if (!config.watermark || !scriptId || keyId == null) return source;
  const plan = planFor(scriptId, source);
  if (!plan) return source;
  return render(plan, tagBits(scriptId, keyId));
}

/* -------------------------------- tracing -------------------------------- */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Is this variant the one that's actually in the leaked text? */
function present(site, variant, words, sample) {
  if (site.kind === 'ident') return words.has(variant);
  if (site.kind === 'str') return sample.includes(variant);
  // A number has to stand alone: `42` must not match inside `142`, `4.2` or `0x42`.
  return new RegExp(`(?<![\\w.])${escapeRe(variant)}(?![\\w.])`).test(sample);
}

/**
 * Read whatever of the mark survived in a leaked sample.
 * @returns {{bits: Int8Array, covered: number[], sites: number, byKind: object}}
 *   bits[p] is -1 where the sample said nothing (or said both). `byKind` splits
 *   the readable carriers by channel, which is what tells the two failure modes
 *   apart: no identifier marks at all means the sample was renamed (or isn't
 *   ours), while intact identifier marks say it came off this server as-is.
 */
function readMark(plan, sample) {
  const words = new Set(sample.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []);
  const votes = Array.from({ length: TAG_BITS }, () => [0, 0]);
  const byKind = { ident: 0, str: 0, num: 0 };
  let observed = 0;

  for (const site of plan.sites) {
    const hits = [];
    for (let v = 0; v < site.variants.length; v++) {
      if (present(site, site.variants[v], words, sample)) hits.push(v);
    }
    // Two variants of the same site can't both be genuine, and neither present
    // means the carrier is gone. Either way the site tells us nothing.
    if (hits.length !== 1) continue;
    observed++;
    byKind[site.kind]++;
    const width = site.positions.length;
    site.positions.forEach((p, i) => {
      votes[p][(hits[0] >> (width - 1 - i)) & 1]++;
    });
  }

  const bits = new Int8Array(TAG_BITS).fill(-1);
  const covered = [];
  for (let p = 0; p < TAG_BITS; p++) {
    const [zero, one] = votes[p];
    if (zero === one) continue; // silent, or evidence split down the middle
    bits[p] = one > zero ? 1 : 0;
    covered.push(p);
  }
  return { bits, covered, sites: observed, byKind };
}

/** How many carriers of each kind the plan laid down, to read `byKind` against. */
function kindTotals(plan) {
  const t = { ident: 0, str: 0, num: 0 };
  for (const s of plan.sites) t[s.kind]++;
  return t;
}

/** P(at least `hits` of `n` fair coin flips come up heads) — exact, n ≤ 32. */
function tailProbability(n, hits) {
  if (hits > n) return 0;
  let c = 1;
  let sum = 0;
  for (let k = 0; k <= n; k++) {
    if (k >= hits) sum += c;
    c = (c * (n - k)) / (k + 1);
  }
  return sum / 2 ** n;
}

/**
 * Score a leaked sample against a set of candidate keys.
 *
 * The answer is deliberately a number, not a verdict: `expected_false` is how
 * many of the keys you searched would score this well purely by chance. Below
 * 0.01 you can act on it; above 1 you are looking at noise.
 *
 * @param {{sites:Array}} plan
 * @param {string} sample leaked script text — need not parse, or even be whole
 * @param {Array<{id:number|string}>} candidates
 */
function trace(plan, sample, scriptId, candidates, { limit = 10 } = {}) {
  const mark = readMark(plan, sample);
  const n = mark.covered.length;

  const scored = candidates.map((row) => {
    const tag = tagBits(scriptId, row.id);
    let matched = 0;
    for (const p of mark.covered) if (tag[p] === mark.bits[p]) matched++;
    return { row, matched };
  });
  scored.sort((a, b) => b.matched - a.matched);

  const matches = scored.slice(0, limit).map(({ row, matched }) => ({
    ...row,
    matched,
    score: n ? matched / n : 0,
    expected_false: candidates.length * tailProbability(n, matched),
  }));

  const best = matches[0];
  const runnerUp = matches[1];
  return {
    bits_recovered: n,
    bits_possible: TAG_BITS,
    carriers_read: mark.sites,
    carriers_total: plan.sites.length,
    carriers_by_kind: { read: mark.byKind, total: kindTotals(plan) },
    candidates: candidates.length,
    // One key, well clear of the field, that chance does not explain.
    confident: !!(best && best.expected_false < 0.01 && (!runnerUp || runnerUp.matched < best.matched)),
    matches,
  };
}

module.exports = {
  apply,
  planFor,
  trace,
  readMark,
  tagBits,
  TAG_BITS,
  _buildPlan: buildPlan,
  _render: render,
  _planCacheSize: () => planCache.size,
  _resetPlanCache: () => planCache.clear(),
};

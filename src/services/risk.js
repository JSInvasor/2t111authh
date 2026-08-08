'use strict';

// Risk scoring.
//
// Every automatic ban in this system used to be one signal wide: more than N
// HWIDs, ban. More than N IPs, ban. N tamper reports, ban. Each of those fires
// on things real customers do — a phone that changes network, a reinstall, a
// second device the user owns — and a wrongly banned paying customer costs far
// more than a pirate who got one extra session. That asymmetry is what kills
// these products commercially, not the piracy.
//
// So signals accumulate into a score instead of each holding its own trigger.
// One oddity is noise; several at once is a pattern. The score also gives the
// dashboard something to show — "why was this banned" is answerable, and a key
// sitting at 45 can be looked at before it becomes a support ticket.

const db = require('../db');
const config = require('../config');
const lease = require('./lease');
const { netPrefix } = require('../utils/net');

const now = () => Math.floor(Date.now() / 1000);

/** Scale `value` into 0..max, reaching max at `full`. */
function ramp(value, full, max) {
  if (value <= 0 || full <= 0) return 0;
  return Math.min(max, Math.round((value / full) * max));
}

/**
 * Score a key 0..100 from what the log and the live session state say about it.
 *
 * @param {number} keyId
 * @param {{hwid?:string|null, ip?:string|null, env?:string|null}} [candidate]
 *   The request being judged, counted alongside history so a limit is enforced
 *   on the offending request rather than one execution late.
 * @returns {{score:number, factors:Array<{name:string, points:number, detail:string}>}}
 */
function score(keyId, candidate = {}) {
  const since = now() - Math.floor(config.keyShareWindowMs / 1000);
  const rows = db
    .prepare(
      `SELECT hwid, ip, reason, success FROM executions
        WHERE key_id = ? AND created_at >= ?`
    )
    .all(keyId, since);

  const key = db.prepare('SELECT env_fp_changes FROM keys WHERE id = ?').get(keyId);
  const factors = [];
  const add = (name, points, detail) => {
    if (points > 0) factors.push({ name, points, detail });
  };

  // Distinct devices. Two is a person with a laptop and a desktop; ten is a
  // key doing the rounds.
  const hwids = new Set(rows.filter((r) => r.success).map((r) => r.hwid).filter(Boolean));
  if (candidate.hwid) hwids.add(String(candidate.hwid));
  add('devices', ramp(hwids.size - 1, 6, 30), `${hwids.size} distinct HWIDs in the window`);

  // Distinct networks, not addresses — one household or one carrier is one
  // network, so this counts places rather than DHCP leases.
  const nets = new Set(
    rows
      .filter((r) => r.success)
      .map((r) => netPrefix(r.ip))
      .filter(Boolean)
  );
  if (candidate.ip) nets.add(netPrefix(candidate.ip));
  add('networks', ramp(nets.size - 1, 8, 25), `${nets.size} distinct networks in the window`);

  // Sessions evicted because the seat was already taken. This is the sharpest
  // signal available: it means the key was in use somewhere else at that moment,
  // not that it looked odd across a window.
  const concurrent = rows.filter((r) => r.reason === 'concurrent_session').length;
  add('concurrency', ramp(concurrent, 4, 30), `${concurrent} sessions displaced another`);

  // Protocol violations. Weighted harder than anything else per-event, because
  // these are the only signals here the server established itself rather than
  // inferred: a spent or foreign nonce, a proof that does not verify. A stock
  // loader cannot produce one, so unlike the heuristics above there is no
  // legitimate behaviour to mistake for it.
  const violations = rows.filter((r) => r.reason && r.reason.startsWith('protocol:')).length;
  add('protocol', ramp(violations, 2, 25), `${violations} protocol violations`);

  // Client-side integrity reports. Proof of key possession is required to file
  // one, so these are from the holder's own machine.
  const tampers = rows.filter((r) => r.reason && r.reason.startsWith('client_tamper:')).length;
  add('tamper', ramp(tampers, 3, 20), `${tampers} client integrity reports`);

  // The machine stopped looking like the one that first used this key.
  const envChanges = key ? key.env_fp_changes : 0;
  add('environment', ramp(envChanges, 4, 15), `environment changed ${envChanges} times`);

  const total = Math.min(100, factors.reduce((n, f) => n + f.points, 0));
  return { score: total, factors };
}

/**
 * What to do about a key, given its score.
 * @returns {'allow'|'watch'|'ban'}
 */
function verdict(total) {
  if (total >= config.riskBanAt) return 'ban';
  if (total >= config.riskWatchAt) return 'watch';
  return 'allow';
}

/**
 * Score a request and, if it is bad enough, take the key out of service.
 * Returns the assessment either way so the caller can log it.
 */
function assess(keyId, candidate = {}) {
  if (!config.riskScoring) return { score: 0, factors: [], verdict: 'allow' };

  const { score: total, factors } = score(keyId, candidate);
  const call = verdict(total);

  if (call === 'ban') {
    db.prepare("UPDATE keys SET status = 'banned' WHERE id = ?").run(keyId);
    lease.revokeKey(keyId);
  }
  return { score: total, factors, verdict: call };
}

/** One-line explanation for the dashboard and the execution log. */
function explain(assessment) {
  if (!assessment.factors.length) return 'no risk signals';
  return assessment.factors
    .sort((a, b) => b.points - a.points)
    .map((f) => `${f.name} +${f.points} (${f.detail})`)
    .join('; ');
}

module.exports = { score, verdict, assess, explain };

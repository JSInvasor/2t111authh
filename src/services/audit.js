'use strict';

// Audit trail for actions taken by people.
//
// This system delegates real authority: a reseller can ban a key, reset its
// HWID, or delete it outright, and the Discord bot does the same on behalf of
// whoever ran the command. None of it used to leave a trace. That makes the
// disputes that money guarantees — "a reseller banned my key for nothing", "I
// never touched it", "who reset my HWID?" — impossible to settle, and it makes a
// reseller quietly abusing their access impossible to notice.
//
// Recorded in the service layer rather than in the routes on purpose: the
// Discord bot calls these services directly, so the routes are not the choke
// point. Anything that mutates without naming an actor lands as `system`, which
// is itself worth seeing.

const db = require('../db');

const now = () => Math.floor(Date.now() / 1000);

const SYSTEM = { type: 'system', id: null, name: null };

/** Build an actor from an authenticated request (see middleware/auth.js). */
function actorFromRequest(req) {
  if (!req || !req.auth) return SYSTEM;
  return {
    type: req.auth.role === 'reseller' ? 'reseller' : 'admin',
    id: req.auth.resellerId != null ? String(req.auth.resellerId) : null,
    name: req.auth.username || null,
    ip: req.ip || null,
  };
}

/** Build an actor from a Discord interaction. */
function actorFromDiscord(user) {
  if (!user) return { type: 'bot', id: null, name: null };
  return { type: 'bot', id: String(user.id), name: user.tag || user.username || null };
}

const insert = db.prepare(
  `INSERT INTO audit_log (actor_type, actor_id, actor_name, action, target_type, target_id, detail, ip, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

/**
 * Append one entry. Never throws: an audit write failing must not take down the
 * action it is describing, and a lost row is better than a 500 on a ban.
 *
 * @param {{actor?:object, action:string, targetType?:string, targetId?:string|number, detail?:object}} entry
 */
function record({ actor, action, targetType = null, targetId = null, detail = null }) {
  const who = actor || SYSTEM;
  try {
    insert.run(
      String(who.type || 'system'),
      who.id != null ? String(who.id) : null,
      who.name != null ? String(who.name).slice(0, 128) : null,
      String(action).slice(0, 64),
      targetType ? String(targetType) : null,
      targetId != null ? String(targetId) : null,
      detail ? JSON.stringify(detail).slice(0, 2000) : null,
      who.ip ? String(who.ip) : null,
      now()
    );
  } catch (err) {
    console.error('[2t1auth] audit write failed:', err.message);
  }
}

/** Recent entries, newest first. Optionally scoped to one target. */
function list({ targetType = null, targetId = null, limit = 100, offset = 0 } = {}) {
  const n = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
  if (targetType && targetId != null) {
    return db
      .prepare(
        `SELECT * FROM audit_log WHERE target_type = ? AND target_id = ?
          ORDER BY id DESC LIMIT ? OFFSET ?`
      )
      .all(String(targetType), String(targetId), n, offset);
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?').all(n, offset);
}

/** Everything a given actor has done — for spotting a reseller gone bad. */
function byActor(actorType, actorId, { limit = 100 } = {}) {
  const n = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
  return db
    .prepare('SELECT * FROM audit_log WHERE actor_type = ? AND actor_id = ? ORDER BY id DESC LIMIT ?')
    .all(String(actorType), String(actorId), n);
}

module.exports = { record, list, byActor, actorFromRequest, actorFromDiscord, SYSTEM };

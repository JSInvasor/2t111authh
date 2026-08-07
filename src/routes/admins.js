'use strict';

// Admin account management.
//
// Mounted behind requireAdmin; the routes that change anything check ownership
// themselves, because one of them (changing your own password) is deliberately
// open to every admin while the rest are owner-only.

const express = require('express');
const admins = require('../services/admins');
const resellers = require('../services/resellers');
const audit = require('../services/audit');

const router = express.Router();

const MIN_PASSWORD = 8;
// Usernames end up in audit entries and log lines; keep them boring.
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;

/** True when this caller may manage other admins. */
function callerIsOwner(req) {
  return req.auth.viaApiKey || admins.isOwner(req.auth.username);
}

function ownerOnly(req, res) {
  if (callerIsOwner(req)) return true;
  res.status(403).json({ success: false, message: 'Only the owner account can manage admins' });
  return false;
}

/** Every admin can see who else has access — it is not a secret from them. */
router.get('/', (req, res) => {
  res.json({
    success: true,
    admins: admins.list(),
    // Lets the dashboard hide controls the caller cannot use, rather than
    // offering them and answering 403.
    you: { username: req.auth.username, is_owner: callerIsOwner(req) },
  });
});

router.post('/', async (req, res, next) => {
  try {
    if (!ownerOnly(req, res)) return;

    const { username, password } = req.body || {};
    const name = String(username || '');
    const pass = String(password || '');

    if (!USERNAME_RE.test(name)) {
      return res.status(400).json({
        success: false,
        message: 'Username must be 3-32 characters, letters/digits/._- only',
      });
    }
    if (pass.length < MIN_PASSWORD) {
      return res.status(400).json({ success: false, message: `Password must be at least ${MIN_PASSWORD} characters` });
    }
    // Logins check admins first, so a name shared with a reseller would shadow
    // that reseller out of their own account.
    if (admins.getAdmin(name) || resellers.getByUsername(name)) {
      return res.status(409).json({ success: false, message: 'That username is taken' });
    }

    await admins.upsertAdmin(name, pass, { actor: audit.actorFromRequest(req) });
    res.status(201).json({ success: true, admin: admins.getById(admins.getAdmin(name).id) });
  } catch (err) {
    next(err);
  }
});

/**
 * Change a password. The owner may change anyone's; every other admin may change
 * only their own, and must confirm the current one — otherwise a hijacked
 * session could lock the real account holder out of it.
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const target = admins.getById(id);
    if (!target) return res.status(404).json({ success: false, message: 'Not found' });

    const password = String((req.body || {}).password || '');
    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ success: false, message: `Password must be at least ${MIN_PASSWORD} characters` });
    }

    const self = target.username === req.auth.username;
    if (!self && !ownerOnly(req, res)) return;

    if (self && !req.auth.viaApiKey) {
      const current = String((req.body || {}).current_password || '');
      if (!(await admins.checkPassword(id, current))) {
        return res.status(403).json({ success: false, message: 'Current password is incorrect' });
      }
    }

    await admins.setPassword(id, password, { actor: audit.actorFromRequest(req) });
    res.json({ success: true, admin: admins.getById(id) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res) => {
  if (!ownerOnly(req, res)) return;

  const id = parseInt(req.params.id, 10);
  const target = admins.getById(id);
  if (!target) return res.status(404).json({ success: false, message: 'Not found' });
  if (target.username === req.auth.username) {
    return res.status(400).json({ success: false, message: 'You cannot delete the account you are signed in as' });
  }

  const out = admins.remove(id, { actor: audit.actorFromRequest(req) });
  if (!out.ok) {
    const message =
      out.reason === 'owner'
        ? 'The owner account cannot be deleted — transfer ownership first'
        : out.reason === 'last_admin'
          ? 'This is the only admin account left'
          : 'Not found';
    return res.status(out.reason === 'not_found' ? 404 : 409).json({ success: false, message });
  }
  res.json({ success: true });
});

/**
 * Hand ownership to another admin. Exists so an owner leaving is not a dead end
 * — the alternatives are the master API key or editing the database by hand.
 */
router.post('/:id/transfer-ownership', (req, res) => {
  if (!ownerOnly(req, res)) return;

  const id = parseInt(req.params.id, 10);
  const out = admins.transferOwnership(id, { actor: audit.actorFromRequest(req) });
  if (!out.ok) {
    const message = out.reason === 'already_owner' ? 'That account is already the owner' : 'Not found';
    return res.status(out.reason === 'not_found' ? 404 : 409).json({ success: false, message });
  }
  res.json({ success: true, admins: admins.list() });
});

module.exports = router;

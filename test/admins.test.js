'use strict';
// Admin account management over real HTTP.
//
// The interesting cases are not "can the owner create an admin" — they are the
// ones where a wrong answer leaves an install nobody can administer, or lets a
// non-owner quietly mint themselves a way back in.

const path = require('node:path');
const os = require('node:os');
const nodeCrypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef0123';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.BACKUP_INTERVAL_MS = '0';
process.env.DB_PATH = path.join(
  os.tmpdir(),
  `2t1auth-admins-${process.pid}-${nodeCrypto.randomBytes(4).toString('hex')}.db`
);

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');

const admins = require('../src/services/admins');
const audit = require('../src/services/audit');
const { server } = require('../src/index');

const MASTER = process.env.ADMIN_API_KEY;
let base;

test.before(async () => {
  if (!server.listening) await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  await admins.upsertAdmin('owner', 'owner-password-1'); // first ever → owner
  await admins.upsertAdmin('helper', 'helper-password-1');
});
test.after(() => server.close());

async function req(method, pathname, { body, cookie, bearer } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

/** Sign in and return the session cookie. */
async function login(username, password) {
  const res = await fetch(`${base}/dashboard/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.strictEqual(res.status, 200, await res.text());
  return res.headers.getSetCookie().join('; ');
}

const idOf = (username) => admins.getAdmin(username).id;

/* ------------------------------ the basics ------------------------------ */

test('the first admin created owns the install', () => {
  assert.strictEqual(admins.getAdmin('owner').is_owner, 1);
  assert.strictEqual(admins.getAdmin('helper').is_owner, 0);
  assert.strictEqual(admins.owner().username, 'owner');
});

test('the owner can create an admin, who can then sign in', async () => {
  const cookie = await login('owner', 'owner-password-1');
  const made = await req('POST', '/api/v1/admins', {
    cookie,
    body: { username: 'newbie', password: 'newbie-password-1' },
  });
  assert.strictEqual(made.status, 201, made.text);
  assert.strictEqual(made.body.admin.is_owner, 0);

  // …and the new account really works, with full admin reach.
  const theirs = await login('newbie', 'newbie-password-1');
  assert.strictEqual((await req('GET', '/api/v1/overview', { cookie: theirs })).status, 200);
});

test('the list never leaks password hashes', async () => {
  const cookie = await login('owner', 'owner-password-1');
  const res = await req('GET', '/api/v1/admins', { cookie });
  assert.strictEqual(res.status, 200);
  assert.ok(!res.text.includes('scrypt$'), 'a password hash reached the response');
  assert.ok(res.body.admins.every((a) => !('password_hash' in a)));
  assert.deepStrictEqual(res.body.you, { username: 'owner', is_owner: true });
});

/* --------------------------- privilege boundary --------------------------- */

test('a plain admin cannot create, delete, or hand over ownership', async () => {
  const cookie = await login('helper', 'helper-password-1');

  // They can see who has access — that is not a secret from them…
  assert.strictEqual((await req('GET', '/api/v1/admins', { cookie })).status, 200);

  // …but every lever that would let them mint persistence is closed.
  const create = await req('POST', '/api/v1/admins', {
    cookie,
    body: { username: 'backdoor', password: 'backdoor-password' },
  });
  assert.strictEqual(create.status, 403);
  assert.match(create.body.message, /owner/i);
  assert.strictEqual(admins.getAdmin('backdoor'), undefined, 'a non-owner created an admin');

  assert.strictEqual((await req('DELETE', `/api/v1/admins/${idOf('newbie')}`, { cookie })).status, 403);
  assert.strictEqual(
    (await req('POST', `/api/v1/admins/${idOf('helper')}/transfer-ownership`, { cookie })).status,
    403
  );
});

test('a plain admin cannot change someone else\'s password', async () => {
  const cookie = await login('helper', 'helper-password-1');
  const res = await req('PATCH', `/api/v1/admins/${idOf('newbie')}`, {
    cookie,
    body: { password: 'taking-over-1' },
  });
  assert.strictEqual(res.status, 403);
  // The victim's password is untouched.
  assert.ok(await login('newbie', 'newbie-password-1'));
});

test('the master API key counts as the owner, so a lost password is recoverable', async () => {
  const res = await req('POST', '/api/v1/admins', {
    bearer: MASTER,
    body: { username: 'recovered', password: 'recovered-password-1' },
  });
  assert.strictEqual(res.status, 201, res.text);
  assert.ok(await login('recovered', 'recovered-password-1'));
});

/* ------------------------------ own password ------------------------------ */

test('an admin can change their own password, but must prove the current one', async () => {
  const cookie = await login('helper', 'helper-password-1');
  const id = idOf('helper');

  const wrong = await req('PATCH', `/api/v1/admins/${id}`, {
    cookie,
    body: { password: 'helper-password-2', current_password: 'not-it' },
  });
  assert.strictEqual(wrong.status, 403);
  assert.match(wrong.body.message, /current password/i);

  const ok = await req('PATCH', `/api/v1/admins/${id}`, {
    cookie,
    body: { password: 'helper-password-2', current_password: 'helper-password-1' },
  });
  assert.strictEqual(ok.status, 200, ok.text);

  // The old password is dead and the old session with it.
  assert.strictEqual((await req('GET', '/api/v1/overview', { cookie })).status, 401);
  assert.ok(await login('helper', 'helper-password-2'));
});

test('short passwords are refused on both create and change', async () => {
  const cookie = await login('owner', 'owner-password-1');
  const short = await req('POST', '/api/v1/admins', { cookie, body: { username: 'tiny', password: 'abc' } });
  assert.strictEqual(short.status, 400);
  assert.strictEqual(
    (await req('PATCH', `/api/v1/admins/${idOf('newbie')}`, { cookie, body: { password: 'abc' } })).status,
    400
  );
});

test('a username already taken by a reseller is refused', async () => {
  const resellers = require('../src/services/resellers');
  await resellers.create({ username: 'dealer', password: 'dealer-password-1' });
  const cookie = await login('owner', 'owner-password-1');

  // Logins check admins first, so allowing this would shadow the reseller out
  // of their own account.
  const res = await req('POST', '/api/v1/admins', {
    cookie,
    body: { username: 'dealer', password: 'another-password-1' },
  });
  assert.strictEqual(res.status, 409);
});

/* ------------------------------ lockout guards ------------------------------ */

test('the owner cannot be deleted while it holds the role', async () => {
  const cookie = await login('owner', 'owner-password-1');
  // Even the master key, which is otherwise omnipotent here.
  const res = await req('DELETE', `/api/v1/admins/${idOf('owner')}`, { bearer: MASTER });
  assert.strictEqual(res.status, 409);
  assert.match(res.body.message, /transfer ownership/i);
  assert.ok(admins.getAdmin('owner'), 'the owner was deleted');
  assert.ok(cookie);
});

test('you cannot delete the account you are signed in as', async () => {
  const cookie = await login('owner', 'owner-password-1');
  const res = await req('DELETE', `/api/v1/admins/${idOf('owner')}`, { cookie });
  assert.strictEqual(res.status, 400);
});

test('the last remaining admin cannot be deleted', () => {
  // Straight at the service, which is where the invariant has to hold whoever
  // asked — a route check alone would leave the CLI and the bot free to do it.
  const db = require('../src/db');
  const saved = db.prepare('SELECT * FROM admins').all();
  db.prepare('DELETE FROM admins WHERE is_owner = 0').run();
  db.prepare('UPDATE admins SET is_owner = 0').run();
  try {
    const only = db.prepare('SELECT id FROM admins').get();
    assert.strictEqual(admins.remove(only.id).reason, 'last_admin');
    assert.strictEqual(admins.countAdmins(), 1);
  } finally {
    db.prepare('DELETE FROM admins').run();
    const ins = db.prepare(
      'INSERT INTO admins (id, username, password_hash, created_at, token_version, is_owner) VALUES (?,?,?,?,?,?)'
    );
    for (const a of saved) ins.run(a.id, a.username, a.password_hash, a.created_at, a.token_version, a.is_owner);
  }
});

/* ---------------------------- ownership transfer ---------------------------- */

test('ownership moves to exactly one account, and the old owner loses the powers', async () => {
  const cookie = await login('owner', 'owner-password-1');
  const target = idOf('newbie');

  const res = await req('POST', `/api/v1/admins/${target}/transfer-ownership`, { cookie });
  assert.strictEqual(res.status, 200, res.text);

  const owners = admins.list().filter((a) => a.is_owner);
  assert.strictEqual(owners.length, 1, 'there must be exactly one owner');
  assert.strictEqual(owners[0].username, 'newbie');

  // The former owner is now an ordinary admin.
  const after = await req('POST', '/api/v1/admins', {
    cookie,
    body: { username: 'nope', password: 'nope-password-1' },
  });
  assert.strictEqual(after.status, 403);

  // And the new owner can do what the old one could — including deleting them.
  const theirs = await login('newbie', 'newbie-password-1');
  assert.strictEqual((await req('DELETE', `/api/v1/admins/${idOf('recovered')}`, { cookie: theirs })).status, 200);

  await req('POST', `/api/v1/admins/${idOf('owner')}/transfer-ownership`, { cookie: theirs }); // hand it back
});

/* --------------------------------- audit --------------------------------- */

test('every admin change is attributed in the audit log', async () => {
  const cookie = await login('owner', 'owner-password-1');
  await req('POST', '/api/v1/admins', { cookie, body: { username: 'audited', password: 'audited-password-1' } });
  const id = idOf('audited');
  await req('PATCH', `/api/v1/admins/${id}`, { cookie, body: { password: 'audited-password-2' } });
  await req('DELETE', `/api/v1/admins/${id}`, { cookie });

  const trail = audit.list({ targetType: 'admin', targetId: id }).map((e) => e.action);
  assert.deepStrictEqual(trail, ['admin.delete', 'admin.set_password', 'admin.create']);
  assert.ok(audit.list({ targetType: 'admin', targetId: id }).every((e) => e.actor_name === 'owner'));
});

test('a deleted admin is signed out immediately', async () => {
  const cookie = await login('owner', 'owner-password-1');
  await req('POST', '/api/v1/admins', { cookie, body: { username: 'shortlived', password: 'shortlived-pass-1' } });

  const theirs = await login('shortlived', 'shortlived-pass-1');
  assert.strictEqual((await req('GET', '/api/v1/overview', { cookie: theirs })).status, 200);

  await req('DELETE', `/api/v1/admins/${idOf('shortlived')}`, { cookie });
  assert.strictEqual(
    (await req('GET', '/api/v1/overview', { cookie: theirs })).status,
    401,
    "a deleted admin's session kept working"
  );
});

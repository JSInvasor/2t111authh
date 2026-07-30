'use strict';

// Create (or update the password of) a dashboard admin account.
// Usage:  npm run create-admin -- <username> <password>
//    or:  node scripts/create-admin.js <username> <password>

require('../src/db');
const admins = require('../src/services/admins');

const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) {
  console.error('Usage: node scripts/create-admin.js <username> <password>');
  process.exit(1);
}
if (String(password).length < 6) {
  console.error('Password must be at least 6 characters.');
  process.exit(1);
}

admins.upsertAdmin(String(username), String(password));
console.log(`Admin "${username}" created/updated. Log in at /dashboard`);

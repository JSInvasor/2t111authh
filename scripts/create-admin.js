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
// Matches the minimum the dashboard enforces, so the two paths can't disagree
// about what counts as an acceptable password.
if (String(password).length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

admins
  .upsertAdmin(String(username), String(password))
  .then((admin) => {
    console.log(`Admin "${username}" created/updated. Log in at /dashboard`);
    if (admin.is_owner) {
      console.log('This account owns the install — it is the one that can create and remove other admins.');
    }
  })
  .catch((err) => {
    console.error('Failed to create admin:', err.message);
    process.exit(1);
  });

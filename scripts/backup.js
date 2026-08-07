#!/usr/bin/env node
'use strict';

// Take a verified backup, or check one you already have.
//
//   npm run backup                 → back up, verify, prune
//   npm run backup -- --verify     → check the newest backup on disk
//   npm run backup -- --verify FILE→ check a specific file
//
// Exits non-zero on any failure, so cron and monitoring notice. A backup nobody
// would hear about failing is not a backup.

const backup = require('../src/services/backup');
const config = require('../src/config');

const args = process.argv.slice(2);
const verifyAt = args.indexOf('--verify');

async function main() {
  if (verifyAt !== -1) {
    const file = args[verifyAt + 1] || backup.latest();
    if (!file) {
      console.error(`No backups found in ${config.backupDir}`);
      process.exit(1);
    }
    const res = backup.verify(file);
    if (!res.ok) {
      console.error(`✗ ${file}\n  ${res.reason}`);
      process.exit(1);
    }
    console.log(`✓ ${file}`);
    console.log(`  ${Object.entries(res.counts).map(([t, n]) => `${t}: ${n}`).join(', ')}`);
    return;
  }

  const out = await backup.run();
  console.log(`✓ ${out.file} (${(out.bytes / 1024).toFixed(1)} KiB)`);
  console.log(`  ${Object.entries(out.counts).map(([t, n]) => `${t}: ${n}`).join(', ')}`);
  if (out.pruned.length) console.log(`  pruned ${out.pruned.length} old backup(s)`);
}

main().catch((err) => {
  console.error('Backup failed:', err.message);
  process.exit(1);
});

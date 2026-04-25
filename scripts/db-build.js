#!/usr/bin/env node
// CLI for `npm run db:build` — applies any pending migrations.
//
// Usage:
//   node scripts/db-build.js              # apply pending migrations
//   node scripts/db-build.js --status     # show applied + pending, no writes
import 'dotenv/config';
import { runMigrations, migrationStatus } from '../lib/db.js';
import { DB_PATH } from '../lib/config.js';

const arg = process.argv[2];

if (arg === '--status' || arg === 'status') {
  const { applied, pending } = migrationStatus();
  console.log(`db: ${DB_PATH}`);
  console.log(`applied (${applied.length}):`);
  for (const f of applied) console.log(`  ✓ ${f}`);
  console.log(`pending (${pending.length}):`);
  for (const f of pending) console.log(`  · ${f}`);
  process.exit(0);
}

console.log(`db: ${DB_PATH}`);
const { applied, alreadyApplied } = runMigrations({ log: (m) => console.log(m) });
if (!applied.length) {
  console.log(`nothing to do (${alreadyApplied.length} already applied)`);
} else {
  console.log(`applied ${applied.length} migration(s)`);
}

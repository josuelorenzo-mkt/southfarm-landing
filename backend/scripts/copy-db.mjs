#!/usr/bin/env node
// Copy a SQLite DB (with WAL) to a destination using better-sqlite3's online
// backup API — a consistent snapshot even when the source is being written by
// a live server (unlike raw file copy, which can capture torn WAL frames).
// Usage: node scripts/copy-db.mjs <source> <dest>

import Database from 'better-sqlite3';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('usage: copy-db.mjs <source> <dest>');
  process.exit(2);
}
const source = new Database(src, { readonly: true, fileMustExist: true });
try {
  await source.backup(dest);
} finally {
  source.close();
}
console.log(`copied ${src} -> ${dest}`);

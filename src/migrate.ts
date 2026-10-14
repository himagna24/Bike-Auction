import { readFileSync } from 'node:fs';
import { pool } from './db.js';
await pool.query(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
console.log('schema applied');
await pool.end();

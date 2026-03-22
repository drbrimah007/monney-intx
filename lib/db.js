// lib/db.js — Neon PostgreSQL connection
// Neon uses the standard pg protocol but works as a serverless HTTP client,
// so each Vercel function call gets a fast, connection-pool-free query.

const { neon } = require('@neondatabase/serverless');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set. Add it in Vercel → Settings → Environment Variables.');
}

const sql = neon(process.env.DATABASE_URL);

module.exports = { sql };

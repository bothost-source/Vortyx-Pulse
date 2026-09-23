const { Pool } = require('pg');

// Supabase's Postgres requires SSL on every connection, including local
// development — unlike some other hosts that only need it in production.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

module.exports = pool;

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pool = require('./db/pool');

const authRoutes = require('./routes/auth');
const keysRoutes = require('./routes/keys');
const paymentsRoutes = require('./routes/payments');
const adminRoutes = require('./routes/admin');
const usageRoutes = require('./routes/usage');
const reportsRoutes = require('./routes/reports');
const v1Routes = require('./routes/v1');

const app = express();

app.use(cors()); 
app.use(express.json());

app.get('/', (req, res) => res.json({ service: 'vortyx-pulse-backend', status: 'running' }));
app.get('/health', (req, res) => res.json({ ok: true }));


app.use('/api/auth', authRoutes);
app.use('/api/keys', keysRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/reports', reportsRoutes);

app.use('/v1', v1Routes);


async function runMigrations() {
  const schemaPath = path.join(__dirname, 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  console.log('Database schema is up to date.');
}

const PORT = process.env.PORT || 3000;
runMigrations()
  .then(() => {
    app.listen(PORT, () => console.log(`Vortyx Pulse backend running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to run migrations on startup:', err.message);
    // Start the server anyway — /health will still respond, making it easier to diagnose from logs.
    app.listen(PORT, () => console.log(`Vortyx Pulse backend running on port ${PORT} (migrations failed, see above)`));
  });


require('dotenv').config();
const express = require('express');
const cors = require('cors');

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


app.use('/api/auth', authRoutes);
app.use('/api/keys', keysRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/reports', reportsRoutes);


app.use('/v1', v1Routes);

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vortyx Pulse backend running on port ${PORT}`));

const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { WALLETS, isValidTxFormat } = require('../config/wallets');

const router = express.Router();

const PLAN_PRICES = { '3mo': 5, annual: 10, perm: 25 };
const CRYPTO_COINS = Object.keys(WALLETS);

// GET /api/payments/wallets — the addresses users send crypto payment to.
// Fill these in for real in config/wallets.js.
router.get('/wallets', requireAuth, (req, res) => {
  res.json({ wallets: WALLETS });
});

// POST /api/payments/crypto — user declares they've sent a crypto payment.
// txReference is now REQUIRED and format-checked (not a real blockchain
// lookup — see config/wallets.js for why) before it's even recorded, so
// obviously-wrong hashes are rejected immediately rather than sitting in
// the admin queue.
router.post('/crypto', requireAuth, async (req, res) => {
  const { plan, coin, txReference } = req.body;
  if (!PLAN_PRICES[plan]) return res.status(422).json({ error: 'Invalid plan' });
  if (!CRYPTO_COINS.includes(coin)) return res.status(422).json({ error: 'Unsupported coin' });
  if (!txReference || !txReference.trim()) {
    return res.status(422).json({ error: 'Transaction ID is required so we can verify your payment.' });
  }
  if (!isValidTxFormat(coin, txReference)) {
    return res.status(422).json({ error: `That doesn't look like a valid ${coin} transaction ID. Double-check you copied the full hash.` });
  }

  const amount = PLAN_PRICES[plan];
  const { rows } = await pool.query(
    `INSERT INTO payments (user_id, plan, amount_usd, method, status, tx_reference)
     VALUES ($1,$2,$3,$4,'pending',$5) RETURNING id, created_at`,
    [req.user.id, plan, amount, coin, txReference.trim()]
  );

  res.status(201).json({
    payment: rows[0],
    message: 'Payment recorded as pending. Our team verifies crypto payments manually, usually within 12 hours.',
  });
});

// GET /api/payments/mine — the caller's own payment history
router.get('/mine', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, plan, amount_usd, method, status, tx_reference, created_at, confirmed_at
     FROM payments WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ payments: rows });
});

module.exports = router;

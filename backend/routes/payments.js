const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const PLAN_PRICES = { '3mo': 5, annual: 10, perm: 25 };
const CRYPTO_COINS = ['USDT', 'BTC', 'LTC', 'ETH'];

// POST /api/payments/card — create a pending payment + Stripe PaymentIntent
router.post('/card', requireAuth, async (req, res) => {
  const { plan } = req.body;
  if (!PLAN_PRICES[plan]) return res.status(422).json({ error: 'Invalid plan' });
  const amount = PLAN_PRICES[plan];

  // ---------------------------------------------------------------------
  // Wire up real Stripe here. Example (after `npm install stripe`):
  //
  //   const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  //   const intent = await stripe.paymentIntents.create({
  //     amount: amount * 100, currency: 'usd',
  //     metadata: { userId: req.user.id, plan },
  //   });
  //   -> return intent.client_secret to the frontend, confirm on the client,
  //      and use a Stripe webhook to flip payments.status to 'completed'
  //      (see /api/payments/webhook below).
  // ---------------------------------------------------------------------

  const { rows } = await pool.query(
    `INSERT INTO payments (user_id, plan, amount_usd, method, status)
     VALUES ($1,$2,$3,'card','pending') RETURNING id`,
    [req.user.id, plan, amount]
  );

  res.status(201).json({
    paymentId: rows[0].id,
    amount,
    note: 'Stripe not yet connected — see comment in routes/payments.js',
  });
});

// Stripe calls this automatically once a card payment succeeds.
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  // Verify the Stripe signature here in production:
  //   const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  // Then, on 'payment_intent.succeeded':
  //   await pool.query(`UPDATE payments SET status='completed', confirmed_at=now(),
  //     tx_reference=$1 WHERE id=$2`, [intent.id, paymentId]);
  //   -> also update the user's plan + plan_expires_at here.
  res.json({ received: true });
});

// POST /api/payments/crypto — user declares they've sent a crypto payment
router.post('/crypto', requireAuth, async (req, res) => {
  const { plan, coin, txReference } = req.body;
  if (!PLAN_PRICES[plan]) return res.status(422).json({ error: 'Invalid plan' });
  if (!CRYPTO_COINS.includes(coin)) return res.status(422).json({ error: 'Unsupported coin' });

  const amount = PLAN_PRICES[plan];
  const { rows } = await pool.query(
    `INSERT INTO payments (user_id, plan, amount_usd, method, status, tx_reference)
     VALUES ($1,$2,$3,$4,'pending',$5) RETURNING id, created_at`,
    [req.user.id, plan, amount, coin, txReference || null]
  );

  res.status(201).json({
    payment: rows[0],
    message: 'Payment recorded as pending. Our team confirms crypto payments manually, usually within 12 hours.',
  });
});

// GET /api/payments/mine — the caller's own payment history
router.get('/mine', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, plan, amount_usd, method, status, created_at, confirmed_at
     FROM payments WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ payments: rows });
});

module.exports = router;

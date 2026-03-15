require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://ethan3409.github.io/sparkystudy';

// CORS — allow only your frontend
app.use(cors({
  origin: [
    FRONTEND_URL,
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ]
}));

// Raw body for Stripe webhook signature verification (must come before json parser)
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful payment
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('Payment completed for:', session.customer_email, '| session:', session.id);
    // In a real app with a database you'd update the user record here.
    // Since SparkStudy uses localStorage, the success page handles the upgrade.
  }

  // Handle subscription cancelled / payment failed
  if (event.type === 'customer.subscription.deleted') {
    console.log('Subscription cancelled:', event.data.object.id);
  }

  res.json({ received: true });
});

// JSON body parser for all other routes
app.use(express.json());

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── POST /api/create-checkout-session ───────────────────────────────────────
// Creates a Stripe Checkout Session and returns the URL to redirect the user.
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { email, promo } = req.body;

    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1
        }
      ],
      // 7-day free trial
      subscription_data: {
        trial_period_days: 7
      },
      // Pre-fill email if we have it
      customer_email: email || undefined,
      // Success/cancel redirect URLs
      success_url: `${FRONTEND_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/payment.html?cancelled=1`,
      // Pass promo code through metadata
      metadata: {
        promo: promo || ''
      }
    };

    // Allow promo codes to be applied at checkout
    if (promo) {
      sessionParams.allow_promotion_codes = true;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Error creating checkout session:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/verify-session?session_id=xxx ──────────────────────────────────
// Called by payment-success.html to confirm payment status and get plan details.
app.get('/api/verify-session', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription']
    });

    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      // Still in trial — trial counts as active
      const sub = session.subscription;
      if (sub && sub.status === 'trialing') {
        return res.json({
          success: true,
          plan: 'elite',
          email: session.customer_email,
          trial: true,
          trial_start: new Date(sub.trial_start * 1000).toISOString(),
          trial_end: new Date(sub.trial_end * 1000).toISOString(),
          subscription_id: sub.id
        });
      }
      return res.status(402).json({ error: 'Payment not completed', status: session.status });
    }

    const sub = session.subscription;
    const trialEnd = sub && sub.trial_end
      ? new Date(sub.trial_end * 1000).toISOString()
      : null;
    const trialStart = sub && sub.trial_start
      ? new Date(sub.trial_start * 1000).toISOString()
      : null;

    res.json({
      success: true,
      plan: 'elite',
      email: session.customer_email,
      trial: sub ? sub.status === 'trialing' : false,
      trial_start: trialStart,
      trial_end: trialEnd,
      subscription_id: sub ? sub.id : null,
      // expiry = 1 year from now (or end of trial)
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    });
  } catch (err) {
    console.error('Error verifying session:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`SparkStudy backend running on port ${PORT}`);
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');

// Safe Anthropic init
let anthropic = null;
try {
  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  } else {
    console.warn('⚠️  ANTHROPIC_API_KEY not set — AI chat will return 503');
  }
} catch(e) {
  console.error('Anthropic init failed:', e.message);
}

// Safe Stripe init — server still starts even if key is missing
let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  } else {
    console.warn('⚠️  STRIPE_SECRET_KEY not set — Stripe endpoints will return 503');
  }
} catch(e) {
  console.error('Stripe init failed:', e.message);
}

// Simple in-memory rate limit: max 3 support messages per IP per hour
const contactRateLimit = new Map();
function checkContactRate(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour
  const entry = contactRateLimit.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
  if (entry.count >= 3) return false;
  entry.count++;
  contactRateLimit.set(ip, entry);
  return true;
}

const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://ethan3409.github.io/sparkystudy';

// CORS — allow only your frontend
// Browsers send Origin as scheme+host only (no path), so we allow the root domain too
app.use(cors({
  origin: [
    FRONTEND_URL,
    'https://ethan3409.github.io',
    'https://sparkystudy.com',
    'https://www.sparkystudy.com',
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

// JSON body parser for all other routes — increase limit for base64 image uploads
app.use(express.json({ limit: '20mb' }));

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── POST /api/chat ───────────────────────────────────────────────────────────
// AI chat — only answers based on provided module/notes context.
// If no context, tells the user to add module content.
app.post('/api/chat', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'AI not configured. Add ANTHROPIC_API_KEY to Railway Variables.' });
  const { question, history = [], systemContext = '' } = req.body;
  if (!question) return res.status(400).json({ error: 'Missing question' });

  const hasContext = typeof systemContext === 'string' && systemContext.trim().length > 30;
  const systemPrompt = hasContext
    ? `You are SparkStudy AI, a study assistant for Alberta electrical apprentices. Answer questions based ONLY on the module/notes content provided below. Stay focused on that content. If the answer is not clearly in the content, say so and suggest the student add more notes.\n\nModule/Notes Content:\n${systemContext.slice(0, 12000)}`
    : `You are SparkStudy AI, a study assistant for Alberta electrical apprentices. No specific module or notes content has been loaded. Answer as helpfully as you can, but always end your response with this exact line:\n\n⚠️ *I can't be fully certain without your module content. For accurate course-specific answers, upload your notes using the 📎 button.*`;

  const messages = [
    ...(Array.isArray(history) ? history : []).slice(-6).map(h => ({ role: h.role, content: String(h.content) })),
    { role: 'user', content: question }
  ];

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages
    });
    res.json({ answer: response.content[0].text, sources: [] });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/extract-image ──────────────────────────────────────────────────
// Accepts a base64 image and uses Claude Vision to extract text (OCR).
// Used by students uploading photos of textbook pages or handwritten notes.
app.post('/api/extract-image', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'AI not configured.' });
  const { image, mimeType = 'image/jpeg' } = req.body;
  if (!image) return res.status(400).json({ error: 'Missing image data' });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: image }
          },
          {
            type: 'text',
            text: 'Extract ALL text from this image exactly as written. This is a study document or textbook page. Preserve headings, bullet points, formulas, numbered lists, and paragraph structure. If there are diagrams or figures, describe them briefly in brackets like [Figure: description]. Output only the extracted text, nothing else.'
          }
        ]
      }]
    });
    res.json({ text: response.content[0].text });
  } catch (err) {
    console.error('Image extraction error:', err.message);
    res.status(500).json({ error: 'Failed to extract text from image: ' + err.message });
  }
});

// ── POST /api/classify-content ───────────────────────────────────────────────
// Uses AI to determine if uploaded text is copyrighted textbook material (module)
// or student-created notes. Returns { type: 'module' | 'notes', confidence, reason }
app.post('/api/classify-content', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'AI not configured.' });
  const { text } = req.body;
  if (!text || text.length < 30) return res.status(400).json({ error: 'Text too short to classify' });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: `You classify educational text as either a copyrighted TEXTBOOK/MODULE or student-created NOTES.

TEXTBOOK/MODULE indicators: publisher name (ILM, Pearson, McGraw-Hill), edition numbers, ISBN, module codes (e.g. 030201a), formal objective lists, "Rationale" or "Outcome" sections, figure references like "Figure 1 -", page numbers in margins, copyright notices, "Learning Resources for Skilled Trades", professional typesetting language.

STUDENT NOTES indicators: informal language, abbreviations, personal comments ("I think", "remember to", "prof said"), bullet point summaries, handwritten style (short fragments), class dates, highlighting markers, study tips, personal mnemonics, incomplete sentences.

Respond with ONLY valid JSON: {"type":"module" or "notes","confidence":0.0-1.0,"reason":"brief explanation"}`,
      messages: [{ role: 'user', content: text.slice(0, 3000) }]
    });
    const raw = response.content[0].text.trim();
    const json = JSON.parse(raw);
    res.json(json);
  } catch (err) {
    console.error('Classification error:', err.message);
    // Default to safest assumption: treat as module (don't share)
    res.json({ type: 'module', confidence: 0.5, reason: 'Classification failed — defaulting to module for safety' });
  }
});

// ── POST /api/detect-title ───────────────────────────────────────────────────
// Detects the title of a module/textbook from its first page text content.
app.post('/api/detect-title', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'AI not configured.' });
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: 'You detect the title of educational textbooks/modules. The title page typically has a format like: publisher info, then "ELECTRICIAN", then the actual title in large text, then edition info. Return ONLY valid JSON: {"title":"The Detected Title"}. If you cannot detect a title, return {"title":""}.',
      messages: [{ role: 'user', content: text.slice(0, 2000) }]
    });
    const raw = response.content[0].text.trim();
    const json = JSON.parse(raw);
    res.json(json);
  } catch (err) {
    res.json({ title: '' });
  }
});

// ── POST /api/create-checkout-session ───────────────────────────────────────
// Creates a Stripe Checkout Session and returns the URL to redirect the user.
app.post('/api/create-checkout-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payment system not configured yet. Please contact support.' });
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
  if (!stripe) return res.status(503).json({ error: 'Payment system not configured yet.' });
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

// ── POST /api/contact ────────────────────────────────────────────────────────
// Forwards support messages to the owner email. Owner email never sent to client.
app.post('/api/contact', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  if (!checkContactRate(ip)) {
    return res.status(429).json({ error: 'Too many messages. Please wait an hour before sending another.' });
  }

  const { name, email, subject, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'Missing required fields.' });
  if (message.length > 2000) return res.status(400).json({ error: 'Message too long (max 2000 characters).' });

  const ownerEmail = process.env.CONTACT_EMAIL;
  if (!ownerEmail) {
    console.error('CONTACT_EMAIL env var not set');
    return res.status(500).json({ error: 'Support email not configured.' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS   // Gmail App Password (not your real password)
      }
    });

    await transporter.sendMail({
      from: `"SparkStudy Support" <${process.env.SMTP_USER}>`,
      to: ownerEmail,
      replyTo: email,
      subject: `[SparkStudy Support] ${subject || 'General Inquiry'} — from ${name}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;">
          <h2 style="color:#f59e0b;">New Support Message — SparkStudy</h2>
          <table style="border-collapse:collapse;width:100%;margin-bottom:20px;">
            <tr><td style="padding:8px;background:#f3f4f6;font-weight:600;width:100px;">From</td><td style="padding:8px;border:1px solid #e5e7eb;">${name}</td></tr>
            <tr><td style="padding:8px;background:#f3f4f6;font-weight:600;">Email</td><td style="padding:8px;border:1px solid #e5e7eb;">${email}</td></tr>
            <tr><td style="padding:8px;background:#f3f4f6;font-weight:600;">Subject</td><td style="padding:8px;border:1px solid #e5e7eb;">${subject || 'No subject'}</td></tr>
          </table>
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;white-space:pre-wrap;">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
          <p style="color:#9ca3af;font-size:0.85rem;margin-top:16px;">Reply directly to this email to respond to ${name}.</p>
        </div>
      `
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Contact email failed:', err.message);
    res.status(500).json({ error: 'Failed to send message. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`SparkStudy backend running on port ${PORT}`);
});

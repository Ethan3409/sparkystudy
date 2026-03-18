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

// Simple rate limiter for all API endpoints
const apiRateLimit = new Map();
function rateLimit(req, res, maxRequests = 30, windowMs = 60000) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const entry = apiRateLimit.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
  entry.count++;
  apiRateLimit.set(ip, entry);
  if (entry.count > maxRequests) { res.status(429).json({ error: 'Too many requests. Try again later.' }); return false; }
  return true;
}
setInterval(() => { const now = Date.now(); for (const [ip, e] of apiRateLimit) { if (now > e.resetAt + 600000) apiRateLimit.delete(ip); } }, 600000);

// HTML escape helper for email templates
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// CORS — allow only your frontend
app.use(cors({
  origin: [
    FRONTEND_URL,
    'https://ethan3409.github.io',
    'https://sparkystudy.com',
    'https://www.sparkystudy.com',
    ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000', 'http://127.0.0.1:5500'] : [])
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

// ── POST /api/tts ───────────────────────────────────────────────────────────
// Text-to-speech proxy — keeps ElevenLabs API key server-side
app.post('/api/tts', async (req, res) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'TTS not configured.' });
  const { text } = req.body;
  if (!text || typeof text !== 'string' || text.length < 1) return res.status(400).json({ error: 'Text required.' });
  try {
    const voiceId = 'FOSKkhOXCEGmWEXxIIpp';
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.substring(0, 5000), model_id: 'eleven_turbo_v2_5', voice_settings: { stability: 0.55, similarity_boost: 0.80 } })
    });
    if (!response.ok) { const err = await response.json().catch(() => ({})); return res.status(response.status).json({ error: err.detail?.message || 'TTS failed' }); }
    res.set('Content-Type', 'audio/mpeg');
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) { console.error('TTS error:', err.message); res.status(500).json({ error: 'TTS failed' }); }
});

// ── POST /api/chat ───────────────────────────────────────────────────────────
// AI chat — only answers based on provided module/notes context.
// If no context, tells the user to add module content.
app.post('/api/chat', async (req, res) => {
  if (!rateLimit(req, res, 20, 60000)) return;
  if (!anthropic) return res.status(503).json({ error: 'AI not configured. Add ANTHROPIC_API_KEY to Railway Variables.' });
  const { question, history = [], systemContext = '' } = req.body;
  if (!question) return res.status(400).json({ error: 'Missing question' });

  const hasContext = typeof systemContext === 'string' && systemContext.trim().length > 30;

  const CEC_REFERENCE = `
CRITICAL: You are an expert on the Canadian Electrical Code (CEC). NEVER guess a table number — if you are not certain, say "check your code book for the exact table." Here are key CEC tables and sections you MUST know:

CEC TABLE REFERENCE (2024 Edition):
- Table 1: General definitions
- Table 2: Ampacity of copper conductors (based on insulation rating, 30°C ambient)
- Table 3: Ampacity of aluminum conductors
- Table 4: Ampacity of copper conductors in free air
- Table 5A: Conductor properties (resistance, area)
- Table 12: Demand factors for dwelling unit lighting & receptacles
- Table 13: General lighting demand by building type (watts per sq meter)
- Table 14: Demand factors for household electric ranges, ovens, cooktops (NOT Table 62)
- Table 19: Minimum conductor size for services and feeders
- Table 21: Minimum size of grounding conductor
- Table 33: Minimum cover requirements for underground wiring
- Table 36: Conductor fill for conduit and tubing
- Table 39: Support spacing for cables
- Table 41: Box fill calculations
- Table 56: Demand factors for commercial cooking equipment
- Table 57: Demand factors for dryers
- Table 62: Feeder demand factors for ELEVATORS (NOT ranges)
- Table 63: Demand factors for welders
- Table 65: Demand factors for motors
- Table 66: Full-load current for single-phase AC motors
- Table 67: Full-load current for 3-phase AC motors
- Table 68: Locked-rotor current for motors
- Table D3: Voltage drop calculations
- Table D11: Demand load for single dwellings
- Table D16: Ampacity correction for more than 3 conductors

KEY CEC SECTIONS:
- Section 0: Object, Scope, Definitions
- Section 2: General Rules (working space, markings)
- Section 4: Conductors
- Section 6: Services & Service Equipment
- Section 8: Circuit Loading and Demand Factors
- Section 10: Grounding and Bonding
- Section 12: Wiring Methods
- Section 14: Protection and Control
- Section 18: Hazardous Locations
- Section 20: Flammable Liquid/Gas Locations
- Section 22: Location with Combustible Dusts
- Section 24: Patient Care Areas (hospitals, clinics)
- Section 26: Installation of Electrical Equipment
- Section 28: Motors and Generators
- Section 30: Special Installations (data processing, swimming pools)
- Section 32: Fire Alarm Systems
- Section 36: High-Voltage Installations
- Section 46: Emergency Power Supply
- Section 62: Fixed Electric Heating
- Section 64: Renewable Energy Systems
- Section 68: Pools, Tubs, and Spas
- Section 70: Electrical Vehicle Charging
- Section 84: Interconnection of Power Producers
- Section 86: Electric Vehicle Energy Management Systems

RULES:
1. NEVER confuse Table 14 (ranges/cooking) with Table 62 (elevators)
2. If asked about a table you are not 100% certain about, say "I'd recommend checking your code book for the exact reference"
3. Always provide the CEC rule number when you know it
4. For patient care areas (Section 24): basic care = 150V max to ground, critical care = isolated system, intermediate care = 2-wire circuits
5. For grounding: ground rods minimum 3m (Rule 10-700), minimum #6 AWG copper bonding conductor
`;

  const systemPrompt = hasContext
    ? `You are SparkStudy AI, an expert study assistant for Alberta electrical apprentices (ILM curriculum). You are deeply knowledgeable about the Canadian Electrical Code (CEC) and all electrical trade theory.\n\n${CEC_REFERENCE}\n\nThe student's lesson content, notes, and uploaded modules are below. When a topic is covered in the provided content, prioritize that material. For topics NOT in the provided content, use the CEC reference above and your general knowledge. NEVER refuse to answer. NEVER say a topic is "outside your scope." Always do your best to answer accurately.\n\nAvailable Content:\n${systemContext.slice(0, 40000)}`
    : `You are SparkStudy AI, an expert study assistant for Alberta electrical apprentices (ILM curriculum). You are deeply knowledgeable about the Canadian Electrical Code (CEC) and all electrical trade theory.\n\n${CEC_REFERENCE}\n\nNo specific module or notes content has been loaded yet. Answer ALL questions about electrical theory, the CEC, load calculations, wiring methods, and the Alberta apprenticeship curriculum. NEVER refuse to answer. NEVER say a topic is "outside your scope." Always do your best. If you are genuinely uncertain about a specific table number or rule, say so clearly rather than guessing.\n\nEnd every response with:\n⚠️ *For more accurate course-specific answers, upload your notes using the 📎 button.*`;

  const messages = [
    ...(Array.isArray(history) ? history : []).slice(-6).map(h => ({ role: h.role, content: String(h.content) })),
    { role: 'user', content: question }
  ];

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
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
  if (!rateLimit(req, res, 10, 60000)) return;
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
  if (!rateLimit(req, res, 15, 60000)) return;
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
  if (!rateLimit(req, res, 5, 60000)) return;
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

  const { name: rawName, email: rawEmail, subject: rawSubject, message } = req.body;
  if (!rawName || !rawEmail || !message) return res.status(400).json({ error: 'Missing required fields.' });
  if (message.length > 2000) return res.status(400).json({ error: 'Message too long (max 2000 characters).' });
  // Sanitize inputs to prevent email header injection and XSS
  const name = (rawName || '').replace(/[\r\n]/g, '').slice(0, 100);
  const email = (rawEmail || '').replace(/[\r\n]/g, '').slice(0, 100);
  const subject = (rawSubject || '').replace(/[\r\n]/g, '').slice(0, 200);

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
            <tr><td style="padding:8px;background:#f3f4f6;font-weight:600;width:100px;">From</td><td style="padding:8px;border:1px solid #e5e7eb;">${escHtml(name)}</td></tr>
            <tr><td style="padding:8px;background:#f3f4f6;font-weight:600;">Email</td><td style="padding:8px;border:1px solid #e5e7eb;">${escHtml(email)}</td></tr>
            <tr><td style="padding:8px;background:#f3f4f6;font-weight:600;">Subject</td><td style="padding:8px;border:1px solid #e5e7eb;">${escHtml(subject || 'No subject')}</td></tr>
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

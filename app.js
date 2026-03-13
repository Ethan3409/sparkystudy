
// ===== FIREBASE CONFIG =====
// HOW TO SET UP (takes ~5 min):
//   1. Go to https://console.firebase.google.com  and sign in with your Google account
//   2. Click "Add project" → name it "sparkystudy" → disable Google Analytics → Create
//   3. In your project: click the </> (Web) icon → register app as "sparkystudy" → Continue
//   4. Copy the firebaseConfig object values into the fields below
//   5. In left sidebar: Build → Firestore Database → Create database → Start in test mode → Next → Enable
//   6. Save and redeploy. Done — all users will now appear in your admin panel!
const FB_CONFIG = {
  apiKey:            "AIzaSyBAbpgFTA_HcbAWO30fWAQuIr7BhH36Z4Q",
  authDomain:        "sparkystudy-afd09.firebaseapp.com",
  projectId:         "sparkystudy-afd09",
  storageBucket:     "sparkystudy-afd09.firebasestorage.app",
  messagingSenderId: "48279803646",
  appId:             "1:48279803646:web:16dcac58d4a39a1e1537af"
};

// ===== FIREBASE BRIDGE =====
const FireDB = {
  db: null,
  ready: false,

  async init() {
    const configured = FB_CONFIG.apiKey && FB_CONFIG.apiKey.length > 10;
    if (!configured) return false;
    // Wait for Firebase SDK to load (it's deferred)
    let tries = 0;
    while (!window.firebase && tries++ < 20) await new Promise(r => setTimeout(r, 200));
    if (!window.firebase) { console.warn('[sparkystudy] Firebase SDK not loaded'); return false; }
    try {
      if (!firebase.apps.length) firebase.initializeApp(FB_CONFIG);
      this.db = firebase.firestore();
      this.ready = true;
      console.log('[sparkystudy] Firebase connected ✓');
      return true;
    } catch(e) { console.warn('[sparkystudy] Firebase init failed:', e.message); return false; }
  },

  // Save full user state (password is NEVER sent to cloud)
  async saveUser(state) {
    if (!this.ready || !state?.user?.id) return;
    try {
      const { password, ...userSafe } = state.user;
      await this.db.collection('users').doc(state.user.id).set(
        { ...state, user: userSafe, _synced: firebase.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } catch(e) { console.warn('[sparkystudy] saveUser failed:', e.message); }
  },

  // Find a user by email in Firestore (for login + signup duplicate check)
  async findByEmail(email) {
    if (!this.ready) return null;
    try {
      const snap = await this.db.collection('users').where('user.email', '==', email).limit(1).get();
      if (snap.empty) return null;
      const data = snap.docs[0].data();
      // Re-attach the password from localStorage if available (we don't store it in cloud)
      const local = Storage.findByEmailLocal(email);
      return local || { ...data, user: { ...data.user, password: '' } };
    } catch(e) { return null; }
  },

  // Fetch all non-owner users from Firestore (for owner admin panel)
  async getAllUsers() {
    if (!this.ready) return null;
    try {
      const snap = await this.db.collection('users').where('user.isOwner', '==', false).get();
      return snap.docs.map(d => {
        const data = d.data();
        // If user also exists locally (same device), merge in the full local copy which includes password
        const local = Storage.getUserById(data.user.id);
        return local || data;
      });
    } catch(e) { console.warn('[sparkystudy] getAllUsers failed:', e.message); return null; }
  },
  async logVisit(data) {
    if (!this.ready) return;
    try { await this.db.collection('visits').add({ ...data, _ts: firebase.firestore.FieldValue.serverTimestamp() }); }
    catch(e) { /* non-critical, fail silently */ }
  },
  async getVisits(days = 30) {
    if (!this.ready) return null;
    try {
      const cutoff = Date.now() - days * 86400000;
      const snap = await this.db.collection('visits').where('timestamp', '>=', cutoff).orderBy('timestamp', 'desc').limit(5000).get();
      return snap.docs.map(d => d.data());
    } catch(e) { return null; }
  },
  async deleteUser(uid) {
    if (!this.ready) return;
    try { await this.db.collection('users').doc(uid).delete(); } catch(e) { /* fail silently */ }
  },
  async updateUserField(uid, fields) {
    if (!this.ready) return;
    try { await this.db.collection('users').doc(uid).set({ user: fields }, { merge: true }); } catch(e) { /* fail silently */ }
  },
  async clearVisits() {
    if (!this.ready) return 0;
    try {
      const snap = await this.db.collection('visits').limit(500).get();
      if (snap.empty) return 0;
      const batch = this.db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      // If there were 500 (max batch), run again to catch the rest
      if (snap.docs.length === 500) await this.clearVisits();
      return snap.docs.length;
    } catch(e) { console.warn('clearVisits failed', e); return 0; }
  }
};

// Kick off Firebase connection as soon as the page is interactive
document.addEventListener('DOMContentLoaded', () => FireDB.init());

// ===== MULTI-USER STORAGE =====
const STORAGE_KEY = 'sparkstudy_v1';
const USERS_KEY = 'sparkstudy_users';
const ANALYTICS_KEY = 'sparkstudy_analytics';
const ACTIVE_USER_KEY = 'sparkstudy_active';
const PREV_ACCOUNT_KEY = 'sparkstudy_prev_uid';

const Storage = {
  // Active user session
  get() {
    const uid = localStorage.getItem(ACTIVE_USER_KEY);
    if (!uid) return null;
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY + '_' + uid)) || null; } catch(e) { return null; }
  },
  set(state) {
    if (!state || !state.user) return;
    const uid = state.user.id;
    localStorage.setItem(STORAGE_KEY + '_' + uid, JSON.stringify(state));
    localStorage.setItem(ACTIVE_USER_KEY, uid);
    // Update user registry
    UserRegistry.update(state.user);
    // Async cloud sync — non-blocking, never breaks local flow
    FireDB.saveUser(state);
  },
  update(partial) { const s = this.get(); if (!s) return null; Object.assign(s, partial); this.set(s); return s; },
  clear() {
    const uid = localStorage.getItem(ACTIVE_USER_KEY);
    if (uid) localStorage.removeItem(STORAGE_KEY + '_' + uid);
    localStorage.removeItem(ACTIVE_USER_KEY);
  },
  logout() { localStorage.removeItem(ACTIVE_USER_KEY); },
  setActiveUser(uid) { localStorage.setItem(ACTIVE_USER_KEY, uid); },
  getUserById(uid) {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY + '_' + uid)) || null; } catch(e) { return null; }
  },
  getAllUsers() {
    const reg = UserRegistry.getAll();
    return reg.map(u => {
      const state = this.getUserById(u.id);
      return state;
    }).filter(Boolean);
  },
  createDefault(name, email, password, period, isOwner) {
    const uid = crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    const state = {
      user: { id: uid, name, email, password, period, signupDate: Date.now(), lastLogin: Date.now(), isOwner: !!isOwner, subscription: { plan: 'trial', startDate: Date.now(), trialEnd: Date.now() + PRICING.elite.trialDays*86400000, endDate: null, status: 'trial', groupId: null, groupSize: null } },
      diagnostic: { completed: false, responses: [], weakAreas: [], strongAreas: [], score: 0, pct: 0 },
      flashcards: {},
      exams: { attempts: [], bookmarked: [] },
      sessions: { streak: 0, streakStart: null, lastStudy: null, totalTime: 0, daily: {} },
      studyGuide: { lessonProgress: {} },
      studyPlan: { dailyFlashcards: 20, dailyMinutes: 30 },
      preferences: { showHints: true },
      points: { total: 0, weekly: 0, weekStart: Date.now(), history: [] },
      mathSettings: { enabledCategories: null }, // null = all enabled
      mathStats: {}, // per-category: { attempts, correct }
      _v: '1.0'
    };
    FLASHCARD_BANK.filter(fc => {
      const t = TOPICS[fc.topic];
      return t && (t.period === period || t.period <= period);
    }).forEach(fc => {
      state.flashcards[fc.id] = { interval: 0, ease: 2.5, reps: 0, nextReview: 0, lastReview: null, correct: 0, incorrect: 0, quality: null, bookmarked: false };
    });
    localStorage.setItem(STORAGE_KEY + '_' + uid, JSON.stringify(state));
    localStorage.setItem(ACTIVE_USER_KEY, uid);
    UserRegistry.add(state.user);
    SiteAnalytics.track('signup', { userId: uid, email, period });
    // Sync new account to cloud database (non-blocking)
    FireDB.saveUser(state);
    return state;
  },
  // Local-only email lookup (used internally and by FireDB to merge passwords)
  findByEmailLocal(email) {
    const reg = UserRegistry.getAll();
    const u = reg.find(r => r.email === email);
    if (!u) return null;
    return this.getUserById(u.id);
  },
  // Public email lookup — checks local first, then Firestore (async)
  findByEmail(email) {
    return this.findByEmailLocal(email);
  }
};

// ===== USER REGISTRY =====
const UserRegistry = {
  getAll() { try { return JSON.parse(localStorage.getItem(USERS_KEY)) || []; } catch(e) { return []; } },
  add(user) {
    const reg = this.getAll();
    if (!reg.find(u => u.id === user.id)) {
      reg.push({ id: user.id, name: user.name, email: user.email, period: user.period, signupDate: user.signupDate, isOwner: !!user.isOwner });
    }
    localStorage.setItem(USERS_KEY, JSON.stringify(reg));
  },
  update(user) {
    const reg = this.getAll();
    const idx = reg.findIndex(u => u.id === user.id);
    if (idx >= 0) {
      reg[idx] = { ...reg[idx], name: user.name, email: user.email, period: user.period, lastLogin: user.lastLogin };
    } else {
      reg.push({ id: user.id, name: user.name, email: user.email, period: user.period, signupDate: user.signupDate, lastLogin: user.lastLogin, isOwner: !!user.isOwner });
    }
    localStorage.setItem(USERS_KEY, JSON.stringify(reg));
  },
  count() { return this.getAll().filter(u => !u.isOwner).length; }
};

// ===== SITE ANALYTICS ENGINE =====
const SiteAnalytics = {
  _get() { try { return JSON.parse(localStorage.getItem(ANALYTICS_KEY)) || this._default(); } catch(e) { return this._default(); } },
  _save(data) { localStorage.setItem(ANALYTICS_KEY, JSON.stringify(data)); },
  _default() {
    return {
      visits: [],
      events: [],
      pageViews: [],
      dailyVisits: {},
      totalVisits: 0,
      uniqueVisitors: {},
      revenue: { total: 0, transactions: [] },
      funnelData: { landing: 0, signup: 0, diagnostic: 0, dashboard: 0, flashcards: 0, exams: 0 }
    };
  },
  _isOwner() { try { const s = Storage.get(); return !!(s && s.user && s.user.isOwner); } catch(e) { return false; } },
  track(eventName, data = {}) {
    if (this._isOwner()) return; // never track owner activity
    const a = this._get();
    const event = { event: eventName, timestamp: Date.now(), date: new Date().toISOString().slice(0, 10), ...data };
    a.events.push(event);
    if (a.events.length > 5000) a.events = a.events.slice(-5000);
    this._save(a);
  },
  trackVisit(userId) {
    if (this._isOwner()) return; // never count owner visits
    const a = this._get();
    const today = new Date().toISOString().slice(0, 10);
    const hour = new Date().getHours();
    a.totalVisits = (a.totalVisits || 0) + 1;
    a.visits.push({ userId: userId || 'anonymous', timestamp: Date.now(), date: today, hour });
    if (a.visits.length > 10000) a.visits = a.visits.slice(-10000);
    a.dailyVisits[today] = (a.dailyVisits[today] || 0) + 1;
    if (userId) a.uniqueVisitors[userId] = Date.now();
    this._save(a);
    // Log to Firebase for cross-device analytics
    FireDB.logVisit({ userId: userId || 'anonymous', timestamp: Date.now(), date: today, hour });
  },
  trackPageView(page, userId) {
    if (this._isOwner()) return; // never track owner page views
    const a = this._get();
    const today = new Date().toISOString().slice(0, 10);
    const hour = new Date().getHours();
    a.pageViews.push({ page, userId: userId || 'anonymous', timestamp: Date.now(), date: today });
    if (a.pageViews.length > 10000) a.pageViews = a.pageViews.slice(-10000);
    // Funnel tracking
    if (a.funnelData[page] !== undefined) a.funnelData[page]++;
    this._save(a);
    // Log page visits to Firebase too
    FireDB.logVisit({ userId: userId || 'anonymous', timestamp: Date.now(), date: today, hour, page });
  },
  trackSubscription(userId, plan, amount) {
    const a = this._get();
    a.revenue.total += amount;
    a.revenue.transactions.push({ userId, plan, amount, date: new Date().toISOString().slice(0, 10), timestamp: Date.now() });
    this._save(a);
  },
  getData() { return this._get(); },
  getVisitsLast30Days() {
    const a = this._get();
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push({ date: key, label: d.toLocaleDateString('en', { month: 'short', day: 'numeric' }), count: a.dailyVisits[key] || 0 });
    }
    return days;
  },
  getHourlyDistribution() {
    const a = this._get();
    const hours = new Array(24).fill(0);
    const cutoff = Date.now() - 30 * 86400000;
    a.visits.filter(v => v.timestamp > cutoff).forEach(v => { if (v.hour !== undefined) hours[v.hour]++; });
    return hours;
  },
  getTopPages() {
    const a = this._get();
    const counts = {};
    const cutoff = Date.now() - 30 * 86400000;
    a.pageViews.filter(pv => pv.timestamp > cutoff).forEach(pv => { counts[pv.page] = (counts[pv.page] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  },
  getRecentEvents(limit = 50) {
    const a = this._get();
    return a.events.slice(-limit).reverse();
  }
};

// ===== POINTS & GAMIFICATION =====
const RANKS = [
  { min:0,     name:'Apprentice',  badge:'⚡', color:'#6b7280' },
  { min:100,   name:'Journeyman',  badge:'🔧', color:'#3b82f6' },
  { min:500,   name:'Technician',  badge:'🔌', color:'#8b5cf6' },
  { min:1500,  name:'Electrician', badge:'⚡', color:'#f59e0b' },
  { min:4000,  name:'Master',      badge:'🏆', color:'#22c55e' },
  { min:10000, name:'Expert',      badge:'⭐', color:'#ef4444' },
];

const Points = {
  ACTIONS: {
    exam_complete:    { base: 0,   desc: 'Complete an exam'         }, // calculated per score
    exam_perfect:     { base: 50,  desc: 'Perfect exam score'       },
    exam_pass:        { base: 20,  desc: 'Pass an exam (70%+)'      },
    flashcard_correct:{ base: 1,   desc: 'Correct flashcard'        },
    flashcard_streak: { base: 5,   desc: '10-card correct streak'   },
    lesson_complete:  { base: 25,  desc: 'Complete a lesson'        },
    math_correct:     { base: 2,   desc: 'Correct math answer'      },
    diagnostic_done:  { base: 50,  desc: 'Complete diagnostic'      },
    daily_login:      { base: 5,   desc: 'Daily login'              },
    streak_7:         { base: 50,  desc: '7-day streak bonus'       },
    streak_30:        { base: 200, desc: '30-day streak bonus'      },
  },

  getRank(total) {
    let rank = RANKS[0];
    for (const r of RANKS) { if (total >= r.min) rank = r; }
    return rank;
  },

  getNextRank(total) {
    for (const r of RANKS) { if (total < r.min) return r; }
    return null;
  },

  _resetWeeklyIfNeeded(state) {
    if (!state.points) state.points = { total:0, weekly:0, weekStart:Date.now(), history:[] };
    const weekMs = 7 * 86400000;
    if (Date.now() - (state.points.weekStart || 0) > weekMs) {
      state.points.weekly = 0;
      state.points.weekStart = Date.now();
    }
    return state;
  },

  award(reason, amount, silent = false) {
    const state = Storage.get();
    if (!state || state.user.isOwner) return;
    this._resetWeeklyIfNeeded(state);
    const streak = state.sessions.streak || 1;
    const multiplier = streak >= 7 ? 2 : streak >= 3 ? 1.5 : 1;
    const earned = Math.round(amount * multiplier);
    state.points.total = (state.points.total || 0) + earned;
    state.points.weekly = (state.points.weekly || 0) + earned;
    state.points.history = state.points.history || [];
    state.points.history.push({ reason, amount: earned, timestamp: Date.now() });
    if (state.points.history.length > 200) state.points.history = state.points.history.slice(-200);
    Storage.set(state);
    if (!silent) {
      const mult = multiplier > 1 ? ` <span style="color:#f59e0b">${multiplier}x streak!</span>` : '';
      showToast(`+${earned} pts — ${reason}${mult}`, 'success');
    }
    // Sync to Firebase so leaderboard sees it
    FireDB.saveUser(state);
    return earned;
  },

  awardExam(pct) {
    const pts = Math.round(pct * 2); // 0–200 pts based on score
    this.award('Exam completed', pts);
    if (pct === 100) this.award('Perfect score!', Points.ACTIONS.exam_perfect.base, true);
    else if (pct >= 70) this.award('Passing grade', Points.ACTIONS.exam_pass.base, true);
  },
};

// ===== SM-2 ALGORITHM =====
const SM2 = {
  update(cardData, quality) {
    // quality: 0=blackout, 1=wrong, 2=hard, 3=correct-hard, 4=correct, 5=easy
    const now = Date.now();
    if (quality < 3) {
      cardData.reps = 0;
      cardData.interval = 1;
      cardData.incorrect++;
    } else {
      if (cardData.reps === 0) cardData.interval = 1;
      else if (cardData.reps === 1) cardData.interval = 3;
      else cardData.interval = Math.round(cardData.interval * cardData.ease);
      cardData.reps++;
      cardData.correct++;
    }
    cardData.ease = Math.max(1.3, cardData.ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
    cardData.nextReview = now + cardData.interval * 86400000;
    cardData.lastReview = now;
    cardData.quality = quality;
    return cardData;
  },
  getMasteryTier(cardData) {
    if (!cardData.lastReview) return 'new';
    if (cardData.interval >= 60) return 'expert';
    if (cardData.interval >= 21) return 'mastered';
    if (cardData.interval >= 3) return 'review';
    return 'learning';
  },
  getDueCards(state) {
    const now = Date.now();
    return FLASHCARD_BANK.filter(fc => {
      const cd = state.flashcards[fc.id];
      return cd && cd.nextReview <= now;
    });
  }
};

// ===== TOAST NOTIFICATIONS =====
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${type === 'success' ? '&#10003;' : type === 'error' ? '&#10007;' : '&#9432;'}</span> ${msg}`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
}

// ===== UTILITY FUNCTIONS =====
function getToday() { return new Date().toISOString().split('T')[0]; }

function updateStreak(state) {
  const today = getToday();
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  if (state.sessions.lastStudy === today) return state;
  if (state.sessions.lastStudy === yesterday) {
    state.sessions.streak++;
  } else if (state.sessions.lastStudy !== today) {
    state.sessions.streak = 1;
    state.sessions.streakStart = today;
  }
  state.sessions.lastStudy = today;
  return state;
}

function recordStudy(state) {
  const today = getToday();
  const wasNewDay = state.sessions.lastStudy !== today;
  if (!state.sessions.daily[today]) state.sessions.daily[today] = { flashcards: 0, exams: 0, time: 0 };
  state = updateStreak(state);
  Storage.set(state);
  // Award daily login points once per day
  if (wasNewDay && !state.user.isOwner) {
    setTimeout(() => {
      Points.award('Daily login', Points.ACTIONS.daily_login.base, true);
      const streak = state.sessions.streak;
      if (streak === 7)  Points.award('7-day streak! 🔥', Points.ACTIONS.streak_7.base);
      if (streak === 30) Points.award('30-day streak! 💥', Points.ACTIONS.streak_30.base);
    }, 500);
  }
  return state;
}

function getTopicsForPeriod(period) {
  return Object.values(TOPICS).filter(t => t.period <= period).sort((a, b) => a.order - b.order);
}

function getTopicMastery(state, topicId) {
  // --- Flashcard component (SM-2 based) ---
  const cards = FLASHCARD_BANK.filter(fc => fc.topic === topicId);
  let flashScore = 0;
  let hasFlashActivity = false;
  if (cards.length > 0) {
    let total = 0;
    cards.forEach(fc => {
      const cd = state.flashcards[fc.id];
      if (!cd) return;
      hasFlashActivity = true;
      const tier = SM2.getMasteryTier(cd);
      if (tier === 'expert') total += 100;
      else if (tier === 'mastered') total += 80;
      else if (tier === 'review') total += 50;
      else if (tier === 'learning') total += 25;
      else total += 0;
    });
    if (hasFlashActivity) flashScore = total / cards.length;
  }

  // --- Exam component (aggregate across all attempts for this topic) ---
  let examScore = 0;
  let hasExamActivity = false;
  if (state.exams && state.exams.attempts && state.exams.attempts.length > 0) {
    let totalCorrect = 0, totalQuestions = 0;
    state.exams.attempts.forEach(attempt => {
      if (attempt.topicScores && attempt.topicScores[topicId]) {
        totalCorrect += attempt.topicScores[topicId].correct;
        totalQuestions += attempt.topicScores[topicId].total;
      }
    });
    if (totalQuestions > 0) {
      hasExamActivity = true;
      examScore = (totalCorrect / totalQuestions) * 100;
    }
  }

  // --- Blend: if both sources have data, weight 60% flashcard / 40% exam.
  //     If only one source, use it alone. If neither, return 0. ---
  if (hasFlashActivity && hasExamActivity) {
    return Math.round(flashScore * 0.6 + examScore * 0.4);
  } else if (hasFlashActivity) {
    return Math.round(flashScore);
  } else if (hasExamActivity) {
    return Math.round(examScore);
  }
  return 0;
}

function getOverallMastery(state) {
  const topics = getTopicsForPeriod(state.user.period);
  if (topics.length === 0) return 0;
  let sum = 0;
  topics.forEach(t => { sum += getTopicMastery(state, t.id); });
  return Math.round(sum / topics.length);
}

function getMasteryColor(pct) {
  if (pct >= 80) return '#10b981';
  if (pct >= 60) return '#34d399';
  if (pct >= 40) return '#fbbf24';
  if (pct >= 20) return '#f97316';
  return '#ef4444';
}

// ===== AUTH MODULE =====
const Auth = {
  selectedPeriod: null,
  isOwnerAnalytics: false,
  selectPeriod(p) {
    this.selectedPeriod = p;
    document.querySelectorAll('.period-option').forEach(el => {
      el.classList.toggle('selected', parseInt(el.dataset.period) === p);
    });
  },
  appliedPromo: null,
  checkPromo() {
    const code = document.getElementById('signupPromo').value.trim();
    const el = document.getElementById('promoResult');
    if (!code) { el.innerHTML = ''; this.appliedPromo = null; return; }
    const promo = PromoCodes.validate(code);
    if (promo) {
      this.appliedPromo = promo;
      const desc = promo.type === 'percent' ? promo.value + '% off' : promo.type === 'flat' ? '$' + promo.value + ' off' : promo.type === 'trial_extend' ? '+' + promo.value + ' extra trial days' : promo.type === 'free' ? 'Free access!' : promo.value;
      el.innerHTML = '<span style="color:#22c55e;">&#x2705; ' + desc + ' &mdash; Code applied!</span>';
    } else {
      this.appliedPromo = null;
      el.innerHTML = '<span style="color:#ef4444;">&#x274C; Invalid or expired code</span>';
    }
  },
  async signup() {
    const name = document.getElementById('signupName').value.trim();
    const email = document.getElementById('signupEmail').value.trim();
    const pass = document.getElementById('signupPassword').value;
    if (!name || !email || !pass) return showToast('Please fill in all fields', 'error');
    // Check local first (fast), then Firestore (catches accounts from other devices)
    if (Storage.findByEmailLocal(email)) return showToast('An account with this email already exists. Please log in.', 'error');
    if (FireDB.ready) {
      const cloudUser = await FireDB.findByEmail(email);
      if (cloudUser) return showToast('An account with this email already exists. Please log in.', 'error');
    }
    // Default to period 1 — user will pick their year on the plan selection screen after diagnostic
    const state = Storage.createDefault(name, email, pass, this.selectedPeriod || 1);
    SiteAnalytics.track('signup', { email, period: this.selectedPeriod || 1 });
    showToast('Account created! Starting your diagnostic...', 'success');
    App.navigate('diagnostic');
  },
  async login() {
    const email = document.getElementById('loginEmail').value.trim();
    const pass = document.getElementById('loginPassword').value;
    if (!email || !pass) return showToast('Please enter email and password', 'error');

    // Owner ANALYTICS-ONLY login — goes straight to analytics dashboard
    if (email === OWNER_ANALYTICS_LOGIN.email && pass === OWNER_ANALYTICS_LOGIN.password) {
      this.isOwnerAnalytics = true;
      // Load all users from Firebase into admin panel (async)
      if (FireDB.ready) {
        const cloudUsers = await FireDB.getAllUsers();
        if (cloudUsers) OwnerDashboard._cloudUsers = cloudUsers;
      }
      SiteAnalytics.track('owner_analytics_login', {});
      showToast('Owner Analytics Mode — viewing all site data', 'success');
      App.navigate('owner');
      return;
    }

    // Owner STUDENT login — auto-creates account if needed
    if (email === OWNER.email && pass === OWNER.password) {
      let state = Storage.findByEmailLocal(OWNER.email);
      if (!state) {
        Storage.createDefault(OWNER.name, OWNER.email, OWNER.password, 2, true);
        state = Storage.get();
        state.diagnostic.completed = true;
        state.diagnostic.score = 64;
        state.diagnostic.pct = 100;
        Storage.set(state);
      } else {
        Storage.setActiveUser(state.user.id);
      }
      state = Storage.get();
      state.user.lastLogin = Date.now();
      state.user.isOwner = true;
      Storage.set(state);
      SiteAnalytics.track('owner_login', { userId: state.user.id });
      showToast('Welcome back, Boss! Owner mode active.', 'success');
      App.navigate('dashboard');
      return;
    }

    // Regular student login — check local first, then Firestore
    let state = Storage.findByEmailLocal(email);
    if (!state && FireDB.ready) {
      // Student signed up on a different device — pull their account from cloud
      showToast('Looking up your account...', 'info');
      const cloudState = await FireDB.findByEmail(email);
      if (cloudState) {
        // Restore account locally with the provided password
        const stateWithPass = { ...cloudState, user: { ...cloudState.user, password: pass } };
        localStorage.setItem(STORAGE_KEY + '_' + cloudState.user.id, JSON.stringify(stateWithPass));
        UserRegistry.add(cloudState.user);
        state = stateWithPass;
      }
    }
    if (!state) return showToast('No account found. Please sign up first.', 'error');
    if (state.user.password !== pass) return showToast('Invalid credentials', 'error');
    if (state.user.banned) return showToast('This account has been disabled. Please contact support.', 'error');
    Storage.setActiveUser(state.user.id);
    state.user.lastLogin = Date.now();
    Storage.set(state);
    SiteAnalytics.track('login', { userId: state.user.id, email });
    SiteAnalytics.trackVisit(state.user.id);
    showToast('Welcome back, ' + state.user.name + '!', 'success');
    if (!state.diagnostic.completed) App.navigate('diagnostic');
    else App.navigate('dashboard');
  },
  logout() {
    this.isOwnerAnalytics = false;
    Storage.logout();
    App.navigate('landing');
    showToast('Logged out', 'info');
  }
};

// ===== APP / ROUTER =====
const App = {
  currentPage: null,
  navigate(page) {
    const state = Storage.get();
    const publicPages = ['landing', 'signup', 'login'];
    const ownerPages = ['owner'];

    // Owner analytics mode \u2014 only allow owner page + public pages
    if (Auth.isOwnerAnalytics && !ownerPages.includes(page) && !publicPages.includes(page)) { page = 'owner'; }

    // Auth guard
    if (!publicPages.includes(page) && !ownerPages.includes(page) && !Auth.isOwnerAnalytics && !state) { page = 'landing'; }
    // Force diagnostic
    if (state && !state.diagnostic.completed && !publicPages.includes(page) && !ownerPages.includes(page) && page !== 'diagnostic') { page = 'diagnostic'; }

    // Hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const pageEl = document.getElementById('page-' + page);
    if (pageEl) pageEl.classList.add('active');
    this.currentPage = page;

    // Track page view
    const uid = state ? state.user.id : (Auth.isOwnerAnalytics ? 'owner-analytics' : null);
    if (uid && !publicPages.includes(page)) SiteAnalytics.trackPageView(page, uid);

    // Update navbar
    const navRight = document.getElementById('navRight');
    const navLinks = document.getElementById('navLinks');

    if (publicPages.includes(page)) {
      navLinks.classList.add('nav-hidden');
      navLinks.classList.remove('nav-visible');
      navRight.classList.add('nav-hidden');
    } else if (ownerPages.includes(page)) {
      // Owner analytics \u2014 hide normal nav, show minimal
      navLinks.classList.add('nav-hidden');
      navLinks.classList.remove('nav-visible');
      navRight.classList.remove('nav-hidden');
    } else {
      navLinks.classList.remove('nav-hidden');
      navLinks.classList.add('nav-visible');
      navRight.classList.remove('nav-hidden');
    }

    // Active nav link (handles both top-level and dropdown items)
    document.querySelectorAll('.nav-links a, .nav-dropdown-menu a').forEach(a => {
      a.classList.toggle('active', a.dataset.page === page);
    });
    // Highlight dropdown button if active page is inside it
    const studyPages = ['flashcards','exams','lessons','study-guide','review','group'];
    const practicePages = ['tools','math','notes'];
    const studyBtn = document.getElementById('navDropStudy');
    const practiceBtn = document.getElementById('navDropPractice');
    if (studyBtn) studyBtn.classList.toggle('active', studyPages.includes(page));
    if (practiceBtn) practiceBtn.classList.toggle('active', practicePages.includes(page));

    // Update streak display & owner badge
    if (state) {
      document.getElementById('streakCount').textContent = state.sessions.streak || 0;
      document.getElementById('navAvatar').textContent = (state.user.name || '?')[0].toUpperCase();
      const ownerBadge = document.getElementById('ownerBadge');
      if (ownerBadge) ownerBadge.style.display = state.user.isOwner ? 'inline-block' : 'none';
      const groupLink = document.getElementById('navGroupLink');
      if (groupLink) groupLink.style.display = (state.user.subscription && state.user.subscription.groupId) ? '' : 'none';
    } else if (Auth.isOwnerAnalytics) {
      const ownerBadge = document.getElementById('ownerBadge');
      if (ownerBadge) ownerBadge.style.display = 'inline-block';
      document.getElementById('navAvatar').textContent = 'E';
      document.getElementById('navStreak').style.display = 'none';
    }

    // Update mobile drawer & bottom nav
    if (typeof updateMobileDrawer === 'function') updateMobileDrawer(state, page);

    // Render page content
    this.renderPage(page, state);

    // Scroll to top
    window.scrollTo(0, 0);
  },
  renderPage(page, state) {
    switch (page) {
      case 'diagnostic': Diagnostic.render(state); break;
      case 'dashboard': Dashboard.render(state); break;
      case 'flashcards': Flashcards.render(state); break;
      case 'exams': Exams.render(state); break;
      case 'study-guide': StudyGuide.render(state); break;
      case 'tools': Tools.cleanup(); Tools.render(state); break;
      case 'analytics': Analytics.render(state); break;
      case 'review': Review.render(state); break;
      case 'settings': Settings.render(state); break;
      case 'group': GroupProgress.render(state); break;
      case 'owner': OwnerDashboard.render(); break;
      case 'lessons': Lessons.render(state); break;
      case 'notes': Notes.render(state); break;
      case 'wrong-study': WrongAnswerStudy.render(); break;
      case 'math': MathPractice.render(state); break;
      case 'leaderboard': Leaderboard.render(state); break;
    }
  },
  init() {
    // Nav link clicks
    document.querySelectorAll('.nav-links a').forEach(a => {
      a.addEventListener('click', e => { e.preventDefault(); App.navigate(a.dataset.page); });
    });
    // Track anonymous visit
    SiteAnalytics.trackVisit(null);
    SiteAnalytics.trackPageView('landing', null);
    // Check state
    const state = Storage.get();
    if (state) {
      SiteAnalytics.trackVisit(state.user.id);
      if (!state.diagnostic.completed) this.navigate('diagnostic');
      else this.navigate('dashboard');
    } else {
      this.navigate('landing');
    }
  }
};

// ===== DIAGNOSTIC.JS =====
// ===== DIAGNOSTIC MODULE =====
const Diagnostic = {
  questions: [],
  currentIndex: 0,
  answers: [],
  startTime: null,

  render(state) {
    const container = document.getElementById('diagContent');
    if (state && state.diagnostic.completed) {
      App.navigate('dashboard');
      return;
    }
    // Filter questions for the user's period
    this.questions = DIAGNOSTIC_QUESTIONS.filter(dq => {
      const t = TOPICS[dq.topic];
      return t && t.period <= state.user.period;
    });
    // Shuffle
    this.questions = this.questions.sort(() => Math.random() - 0.5);
    this.currentIndex = 0;
    this.answers = new Array(this.questions.length).fill(null);
    this.startTime = Date.now();
    this.renderQuestion(container);
  },

  renderQuestion(container) {
    if (!container) container = document.getElementById('diagContent');
    const q = this.questions[this.currentIndex];
    const topic = TOPICS[q.topic];
    const pct = ((this.currentIndex) / this.questions.length * 100).toFixed(0);

    container.innerHTML = `
      <div class="diag-progress">
        <div class="diag-counter">Question ${this.currentIndex + 1} of ${this.questions.length}</div>
        <div class="progress-bar"><div class="fill" style="width:${pct}%"></div></div>
      </div>
      <div class="diag-topic-badge">${topic.icon} ${topic.name}</div>
      <div class="diag-question">${q.q}</div>
      <div class="diag-options">
        ${q.options.map((opt, i) => `
          <div class="diag-option ${this.answers[this.currentIndex] === i ? 'selected' : ''}" onclick="Diagnostic.selectAnswer(${i})">
            <div class="option-letter">${String.fromCharCode(65 + i)}</div>
            <div>${opt}</div>
          </div>
        `).join('')}
        <div class="diag-option ${this.answers[this.currentIndex] === -1 ? 'selected' : ''}" onclick="Diagnostic.selectAnswer(-1)" style="border-style:dashed;opacity:0.75;">
          <div class="option-letter" style="background:rgba(100,116,139,0.2);color:var(--text-muted);">?</div>
          <div style="color:var(--text-muted);font-style:italic;">Haven't learned this yet</div>
        </div>
      </div>
      <div class="diag-actions">
        <button class="btn btn-secondary" ${this.currentIndex === 0 ? 'disabled' : ''} onclick="Diagnostic.prev()">&#8592; Previous</button>
        ${this.currentIndex < this.questions.length - 1
          ? `<button class="btn btn-primary" ${this.answers[this.currentIndex] === null ? 'disabled' : ''} onclick="Diagnostic.next()">Next &#8594;</button>`
          : `<button class="btn btn-primary" ${this.answers[this.currentIndex] === null ? 'disabled' : ''} onclick="Diagnostic.finish()">Finish Assessment</button>`
        }
      </div>
    `;
  },

  selectAnswer(idx) {
    this.answers[this.currentIndex] = idx;
    this.renderQuestion();
  },

  next() {
    if (this.answers[this.currentIndex] === null) return;
    this.currentIndex++;
    this.renderQuestion();
  },

  prev() {
    if (this.currentIndex > 0) { this.currentIndex--; this.renderQuestion(); }
  },

  finish() {
    if (this.answers[this.currentIndex] === null) return;
    const state = Storage.get();
    const timeSpent = Date.now() - this.startTime;

    // Score by topic
    const topicScores = {};
    const topicCounts = {};
    let totalCorrect = 0;

    const notLearnedTopics = {};
    this.questions.forEach((q, i) => {
      const isNYL = this.answers[i] === -1;
      const correct = !isNYL && this.answers[i] === q.correct;
      if (correct) totalCorrect++;
      if (isNYL) { notLearnedTopics[q.topic] = true; return; }
      if (!topicScores[q.topic]) { topicScores[q.topic] = 0; topicCounts[q.topic] = 0; }
      topicCounts[q.topic]++;
      if (correct) topicScores[q.topic]++;
    });

    // Calculate percentages and find weak/strong
    const topicPcts = {};
    const weak = [];
    const strong = [];
    const notLearned = Object.keys(notLearnedTopics);
    Object.keys(topicScores).forEach(tid => {
      const pct = Math.round((topicScores[tid] / topicCounts[tid]) * 100);
      topicPcts[tid] = pct;
      if (pct < 60) weak.push(tid);
      else if (pct >= 80) strong.push(tid);
    });

    // Sort weak by worst first
    weak.sort((a, b) => topicPcts[a] - topicPcts[b]);

    const pct = Math.round((totalCorrect / this.questions.length) * 100);

    const answeredTotal = this.questions.filter((_,i) => this.answers[i] !== -1).length || 1;
    const answeredPct = Math.round((totalCorrect / answeredTotal) * 100);
    state.diagnostic = {
      completed: true,
      completedDate: Date.now(),
      responses: this.questions.map((q, i) => ({ qId: q.id, selected: this.answers[i], correct: q.correct, topic: q.topic, isCorrect: this.answers[i] === q.correct, isNYL: this.answers[i] === -1 })),
      weakAreas: weak,
      strongAreas: strong,
      notLearnedAreas: notLearned,
      topicPcts,
      score: totalCorrect,
      total: this.questions.length,
      pct: answeredPct,
      timeSpent
    };

    state.sessions.streak = 1;
    state.sessions.streakStart = getToday();
    state.sessions.lastStudy = getToday();
    Storage.set(state);

    SiteAnalytics.track('diagnostic_complete', { userId: state.user.id, score: pct, weakAreas: weak.length, strongAreas: strong.length });

    this.renderResults(state);
  },

  skipDiagnostic() {
    const s = Storage.get();
    if (!s) return;
    s.diagnostic.completed = true;
    s.diagnostic.pct = 0;
    s.diagnostic.weakAreas = [];
    s.diagnostic.notLearnedAreas = Object.keys(TOPICS);
    Storage.set(s);
    // Show the plan selector inline instead of going to dashboard
    const header = document.getElementById('diagHeader');
    const container = document.getElementById('diagContent');
    if (header) header.innerHTML = '<h1>&#x1F389; Almost there!</h1><p style="color:var(--text-secondary);margin-top:8px;">Start your free trial and select your year to unlock everything.</p>';
    if (container) container.innerHTML = `<div class="diag-results slide-up">${Diagnostic._planSelectHTML(s)}</div>`;
  },

  _planSelectHTML(state) {
    const p = state.user.period || 1;
    const price = PRICING.elite.price;
    const trial = PRICING.elite.trialDays;
    return `
    <div style="max-width:480px;margin:0 auto;">

      <!-- Plan card -->
      <div style="background:linear-gradient(135deg,rgba(245,158,11,0.08),rgba(139,92,246,0.06));border:2px solid var(--accent);border-radius:18px;padding:28px;margin-bottom:20px;position:relative;overflow:hidden;">
        <div style="position:absolute;top:14px;right:14px;background:var(--accent);color:#000;font-size:0.7rem;font-weight:800;padding:3px 10px;border-radius:20px;letter-spacing:0.5px;">FREE TRIAL</div>
        <div style="font-size:1.5rem;font-weight:900;margin-bottom:4px;">&#x26A1; SparkyStudy Elite</div>
        <div style="font-size:0.9rem;color:var(--text-secondary);margin-bottom:20px;">Everything you need to pass your apprenticeship exam</div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:20px;">
          ${['All modules & lessons','Unlimited flashcards','Full practice exams','Diagnostic study plan','Smart analytics','Simulator tools'].map(f=>`<div style="font-size:0.82rem;display:flex;align-items:center;gap:6px;"><span style="color:#22c55e;font-size:0.9rem;">&#x2713;</span>${f}</div>`).join('')}
        </div>

        <div style="background:var(--bg-card);border-radius:12px;padding:16px;text-align:center;margin-bottom:4px;">
          <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:4px;">After your ${trial}-day free trial</div>
          <div style="font-size:2.2rem;font-weight:900;color:var(--accent);">$${price}<span style="font-size:1rem;font-weight:500;color:var(--text-secondary);">/year</span></div>
          <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px;">That's just $${(price/12).toFixed(2)}/month &mdash; less than a textbook</div>
        </div>
        <div style="font-size:0.75rem;color:var(--text-muted);text-align:center;margin-top:8px;">&#x26A0;&#xFE0F; You will not be charged today. After ${trial} days, your subscription is $${price}/year. Cancel anytime.</div>
      </div>

      <!-- Year selection -->
      <div style="margin-bottom:18px;">
        <div style="font-size:0.85rem;font-weight:700;margin-bottom:10px;color:var(--text-primary);">&#x1F393; Which year are you studying?</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;" id="planYearGrid">
          <div onclick="Diagnostic._selectYear(1)" id="planY1" style="border:2px solid ${p===1?'var(--accent)':'var(--border)'};border-radius:12px;padding:14px;cursor:pointer;text-align:center;background:${p===1?'rgba(245,158,11,0.08)':'var(--bg-card)'};">
            <div style="font-size:1.4rem;font-weight:900;color:var(--accent);">1st Year</div>
            <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px;">DC theory, wiring, code basics</div>
          </div>
          <div onclick="Diagnostic._selectYear(2)" id="planY2" style="border:2px solid ${p===2?'var(--accent)':'var(--border)'};border-radius:12px;padding:14px;cursor:pointer;text-align:center;background:${p===2?'rgba(245,158,11,0.08)':'var(--bg-card)'};">
            <div style="font-size:1.4rem;font-weight:900;color:var(--accent);">2nd Year</div>
            <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px;">AC theory, motors, controls, code</div>
          </div>
        </div>
      </div>

      <!-- Promo code -->
      <div style="margin-bottom:18px;">
        <label style="font-size:0.8rem;color:var(--text-muted);display:block;margin-bottom:6px;">Have a promo code?</label>
        <div style="display:flex;gap:8px;">
          <input id="planPromoInput" type="text" placeholder="Enter code" style="flex:1;padding:9px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:0.85rem;text-transform:uppercase;">
          <button onclick="Diagnostic._applyPromo()" style="padding:9px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:0.8rem;cursor:pointer;font-weight:600;">Apply</button>
        </div>
        <div id="planPromoMsg" style="font-size:0.78rem;margin-top:5px;min-height:18px;"></div>
      </div>

      <!-- CTA -->
      <button onclick="Diagnostic.confirmPlan()" class="btn btn-primary btn-lg" style="width:100%;font-size:1rem;padding:16px;">Start My ${trial}-Day Free Trial &#8594;</button>
      <p style="font-size:0.72rem;color:var(--text-muted);text-align:center;margin-top:10px;line-height:1.5;">No payment required today. By starting your trial you agree to be billed $${price}/year after ${trial} days unless you cancel. You can cancel at any time from Settings.</p>
    </div>`;
  },

  _selectedYear: null,
  _selectYear(y) {
    this._selectedYear = y;
    const y1 = document.getElementById('planY1');
    const y2 = document.getElementById('planY2');
    if (y1 && y2) {
      y1.style.borderColor = y === 1 ? 'var(--accent)' : 'var(--border)';
      y1.style.background = y === 1 ? 'rgba(245,158,11,0.08)' : 'var(--bg-card)';
      y2.style.borderColor = y === 2 ? 'var(--accent)' : 'var(--border)';
      y2.style.background = y === 2 ? 'rgba(245,158,11,0.08)' : 'var(--bg-card)';
    }
  },

  _applyPromo() {
    const code = (document.getElementById('planPromoInput')?.value || '').trim().toUpperCase();
    const msg = document.getElementById('planPromoMsg');
    if (!code) { if(msg) msg.textContent = ''; return; }
    const result = PromoCodes.apply(code);
    if (msg) { msg.textContent = result.message; msg.style.color = result.success ? 'var(--success)' : 'var(--danger)'; }
  },

  confirmPlan() {
    const state = Storage.get();
    if (!state) return;
    const year = this._selectedYear || state.user.period || 1;
    state.user.period = year;
    Storage.set(state);
    App.navigate('dashboard');
  },

  renderResults(state) {
    const container = document.getElementById('diagContent');
    const d = state.diagnostic;
    const header = document.getElementById('diagHeader');
    header.innerHTML = '<h1>Diagnostic Complete!</h1><p style="color:var(--text-secondary);margin-top:8px;">Here\'s where you stand. Your study plan has been customized based on these results.</p>';

    const topicEntries = Object.entries(d.topicPcts).sort((a, b) => a[1] - b[1]);

    container.innerHTML = `
      <div class="diag-results slide-up">
        <div class="diag-score-circle" style="--score-pct:${d.pct}%">
          <div class="diag-score-inner">
            <div class="score-num">${d.pct}%</div>
            <div class="score-label">${d.score}/${d.total} correct</div>
          </div>
        </div>
        <p style="color:var(--text-secondary);margin-bottom:8px;">Time: ${Math.round(d.timeSpent / 60000)} minutes</p>
        <p style="font-size:1.1rem;font-weight:600;margin-bottom:24px;">
          ${d.pct >= 80 ? 'Great foundation! Let\'s sharpen the edges.' : d.pct >= 60 ? 'Good start! We\'ve identified areas to focus on.' : 'Perfect \u2014 now we know exactly where to focus your study time.'}
        </p>

        ${d.weakAreas.length > 0 ? `
          <div style="margin-bottom:16px;">
            <h3 style="color:var(--danger);margin-bottom:12px;">&#9888; Areas Needing Work</h3>
            <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;">
              ${d.weakAreas.map(tid => `<span class="badge badge-danger">${TOPICS[tid]?.name || tid} \u2014 ${d.topicPcts[tid]}%</span>`).join('')}
            </div>
          </div>
        ` : ''}

        ${(d.notLearnedAreas||[]).length > 0 ? `
          <div style="margin-bottom:16px;">
            <h3 style="color:var(--text-muted);margin-bottom:12px;">&#x1F4DA; Not Covered Yet</h3>
            <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;">
              ${(d.notLearnedAreas||[]).map(tid => `<span class="badge" style="background:rgba(100,116,139,0.15);color:var(--text-muted);border:1px dashed var(--border);">${TOPICS[tid]?.name || tid}</span>`).join('')}
            </div>
            <p style="font-size:0.78rem;color:var(--text-muted);margin-top:8px;">We'll start you here — no pressure.</p>
          </div>
        ` : ''}

        ${d.strongAreas.length > 0 ? `
          <div style="margin-bottom:24px;">
            <h3 style="color:var(--success);margin-bottom:12px;">&#10003; Strong Areas</h3>
            <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;">
              ${d.strongAreas.map(tid => `<span class="badge badge-success">${TOPICS[tid]?.name || tid} \u2014 ${d.topicPcts[tid]}%</span>`).join('')}
            </div>
          </div>
        ` : ''}

        ${topicEntries.length > 0 ? `
        <details style="margin-bottom:24px;text-align:left;">
          <summary style="cursor:pointer;font-size:0.85rem;color:var(--text-muted);padding:8px 0;">&#x25B6; All topic scores</summary>
          <div class="diag-breakdown" style="margin-top:12px;">
            ${topicEntries.map(([tid, pct]) => `
              <div class="diag-topic-result">
                <span class="topic-name">${TOPICS[tid]?.icon || ''} ${TOPICS[tid]?.name || tid}</span>
                <span class="topic-score" style="color:${getMasteryColor(pct)}">${pct}%</span>
              </div>
            `).join('')}
          </div>
        </details>` : ''}

        <div id="diagPlanSelect" style="margin-top:8px;">
          ${Diagnostic._planSelectHTML(state)}
        </div>
      </div>
    `;
  }
};

// ===== DASHBOARD.JS =====
// ===== DASHBOARD MODULE =====
const Dashboard = {
  render(state) {
    if (!state) return;
    const container = document.getElementById('dashContent');
    const topics = getTopicsForPeriod(state.user.period);
    const dueCards = SM2.getDueCards(state);
    const today = getToday();
    const daily = state.sessions.daily[today] || { flashcards: 0, exams: 0, time: 0 };
    const fcGoal = state.studyPlan.dailyFlashcards;
    const overallMastery = getOverallMastery(state);

    // Weak areas from diagnostic or current mastery
    let weakTopics = [];
    if (state.diagnostic.weakAreas && state.diagnostic.weakAreas.length > 0) {
      weakTopics = state.diagnostic.weakAreas.slice(0, 5).map(tid => ({
        id: tid, name: TOPICS[tid]?.name || tid, icon: TOPICS[tid]?.icon || '', mastery: getTopicMastery(state, tid)
      }));
    } else {
      weakTopics = topics.map(t => ({ id: t.id, name: t.name, icon: t.icon, mastery: getTopicMastery(state, t.id) }))
        .sort((a, b) => a.mastery - b.mastery).slice(0, 5);
    }

    // Recent exam
    const lastExam = state.exams.attempts.length > 0 ? state.exams.attempts[state.exams.attempts.length - 1] : null;

    container.innerHTML = `
      <div class="dash-welcome">
        <h1>Welcome back, ${state.user.name.split(' ')[0]}!</h1>
        <p>Period ${state.user.period} Electrical Apprentice &mdash; ${dueCards.length > 0 ? `${dueCards.length} flashcards due today` : 'All caught up on flashcards!'}</p>
      </div>

      ${(() => {
        const pts = (state.points && state.points.total) || 0;
        const wPts = (state.points && state.points.weekly) || 0;
        const rank = Points.getRank(pts);
        const nextRank = Points.getNextRank(pts);
        const pctToNext = nextRank ? Math.min(100, Math.round(((pts - rank.min) / (nextRank.min - rank.min)) * 100)) : 100;
        return `<div style="background:linear-gradient(135deg,rgba(245,158,11,0.08),rgba(139,92,246,0.08));border:1px solid rgba(245,158,11,0.25);border-radius:var(--radius);padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;cursor:pointer;" onclick="App.navigate('leaderboard')">
          <div style="font-size:2rem;">${rank.badge}</div>
          <div style="flex:1;min-width:140px;">
            <div style="font-weight:700;font-size:1rem;color:${rank.color};">${rank.name}</div>
            <div style="font-size:0.78rem;color:var(--text-muted);margin:2px 0 6px;">${pts.toLocaleString()} pts total · ${wPts.toLocaleString()} this week</div>
            <div style="background:var(--bg-secondary);border-radius:4px;height:6px;overflow:hidden;width:100%;max-width:220px;">
              <div style="height:100%;width:${pctToNext}%;background:linear-gradient(90deg,${rank.color},#f59e0b);border-radius:4px;transition:width 0.5s;"></div>
            </div>
            ${nextRank ? `<div style="font-size:0.7rem;color:var(--text-muted);margin-top:3px;">${pctToNext}% to ${nextRank.badge} ${nextRank.name}</div>` : '<div style="font-size:0.7rem;color:#f59e0b;margin-top:3px;">⭐ Max rank achieved!</div>'}
          </div>
          <div style="text-align:right;">
            <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:2px;">View Leaderboard</div>
            <div style="font-size:0.8rem;color:var(--accent);">🏆 →</div>
          </div>
        </div>`;
      })()}

      <div class="stat-grid" style="margin-bottom:24px;">
        <div class="stat-card">
          <div class="stat-value">${state.sessions.streak}</div>
          <div class="stat-label">Day Streak</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${overallMastery}%</div>
          <div class="stat-label">Overall Mastery</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${dueCards.length}</div>
          <div class="stat-label">Cards Due</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${state.exams.attempts.length}</div>
          <div class="stat-label">Exams Taken</div>
        </div>
      </div>

      <div class="dash-grid">
        <!-- Daily Goals -->
        <div class="card">
          <div class="section-title">&#127919; Today's Goals</div>
          <div class="daily-goals">
            ${(() => {
              const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()];
              const sched = state.schedule || {};
              const todayTopicId = sched[dayName];
              const todayTopic = todayTopicId ? TOPICS[todayTopicId] : null;
              if (todayTopic) {
                const topicMastery = getTopicMastery(state, todayTopicId);
                return `<div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:10px;padding:12px 14px;margin-bottom:12px;">
                  <div style="font-size:0.7rem;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">📅 Today — ${dayName}</div>
                  <div style="font-weight:700;font-size:0.95rem;">${todayTopic.icon} ${todayTopic.name}</div>
                  <div style="font-size:0.78rem;color:var(--text-muted);margin:4px 0 8px;">Current mastery: ${topicMastery}%</div>
                  <div style="display:flex;gap:8px;">
                    <button onclick="App.navigate('flashcards')" class="btn btn-primary btn-sm" style="font-size:0.75rem;padding:5px 10px;">Study Cards</button>
                    <button onclick="App.navigate('math')" class="btn btn-secondary btn-sm" style="font-size:0.75rem;padding:5px 10px;">Math Practice</button>
                  </div>
                </div>`;
              }
              return `<div style="font-size:0.8rem;color:var(--text-muted);padding:8px 0 12px;">
                <a href="#" onclick="App.navigate('settings');return false;" style="color:var(--accent);">Set your class schedule</a> to get daily topic suggestions.
              </div>`;
            })()}
            <div class="goal-item">
              <div class="goal-icon">&#128218;</div>
              <div class="goal-info">
                <div class="goal-title">Review Flashcards</div>
                <div class="goal-progress-text">${daily.flashcards} / ${fcGoal} cards</div>
                <div class="progress-bar" style="margin-top:6px;"><div class="fill" style="width:${Math.min(100, (daily.flashcards / fcGoal) * 100)}%"></div></div>
              </div>
              <div class="goal-check">${daily.flashcards >= fcGoal ? '&#10003;' : ''}</div>
            </div>
            <div class="goal-item">
              <div class="goal-icon">&#9200;</div>
              <div class="goal-info">
                <div class="goal-title">Study Time</div>
                <div class="goal-progress-text">${Math.round((daily.time || 0) / 60000)}min / ${state.studyPlan.dailyMinutes}min</div>
                <div class="progress-bar" style="margin-top:6px;"><div class="fill" style="width:${Math.min(100, ((daily.time || 0) / 60000 / state.studyPlan.dailyMinutes) * 100)}%"></div></div>
              </div>
              <div class="goal-check">${(daily.time || 0) / 60000 >= state.studyPlan.dailyMinutes ? '&#10003;' : ''}</div>
            </div>
          </div>
        </div>

        <!-- Weak Areas -->
        <div class="card">
          <div class="section-title">&#9888;&#65039; Focus Areas</div>
          <div class="weak-areas-list">
            ${weakTopics.map(wt => `
              <div class="weak-area-item">
                <div class="wa-info">
                  <div class="wa-name">${wt.icon} ${wt.name}</div>
                  <div class="wa-mastery">${wt.mastery}% mastery</div>
                </div>
                <div class="progress-bar" style="width:80px;"><div class="fill" style="width:${wt.mastery}%;background:${getMasteryColor(wt.mastery)}"></div></div>
                <button class="btn btn-sm btn-primary" onclick="Flashcards.startTopic('${wt.id}')">Study</button>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Exam Score Predictor -->
        ${(() => {
          const pred = getExamPrediction(state);
          const predColor = pred >= 70 ? 'var(--success)' : pred >= 50 ? 'var(--accent)' : 'var(--danger)';
          const predMsg = pred >= 80 ? 'Looking strong! Keep reviewing to lock it in.' : pred >= 70 ? 'You would likely pass. Keep building mastery.' : pred >= 50 ? 'Getting there. Focus on your weak areas below.' : 'Keep studying! Focus on the topics highlighted below.';
          return `
        <div class="card full-width" style="background:linear-gradient(135deg,var(--bg-card),rgba(245,158,11,0.05));border-color:rgba(245,158,11,0.2);">
          <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap;">
            <div>
              <div style="font-size:0.8rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:4px;">Estimated Exam Score</div>
              <div style="font-size:3rem;font-weight:800;color:${predColor}">${pred}%</div>
              <div style="font-size:0.85rem;color:var(--text-secondary);margin-top:2px;">${predMsg}</div>
            </div>
            <div style="margin-left:auto;font-size:0.8rem;color:var(--text-muted);text-align:right;">
              <div>Pass mark: <strong style="color:var(--accent);">70%</strong></div>
              <div>Based on your current topic mastery</div>
            </div>
          </div>
        </div>`;
        })()}

        <!-- Quick Actions -->
        <div class="card full-width">
          <div class="section-title">&#9889; Quick Actions</div>
          <div class="quick-actions" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));">
            <div class="quick-action" onclick="App.navigate('flashcards')">
              <div class="qa-icon">&#128218;</div>
              <div class="qa-title">${dueCards.length > 0 ? `Review ${dueCards.length} Due Cards` : 'Browse Flashcards'}</div>
              <div class="qa-desc">${dueCards.length > 0 ? 'Spaced repetition session' : 'All caught up!'}</div>
            </div>
            <div class="quick-action" onclick="QuickQuiz.start()">
              <div class="qa-icon">&#9889;</div>
              <div class="qa-title">Quick Quiz</div>
              <div class="qa-desc">10 questions, rapid fire</div>
            </div>
            <div class="quick-action" onclick="CramMode.start()">
              <div class="qa-icon">&#128293;</div>
              <div class="qa-title">Cram Mode</div>
              <div class="qa-desc">Drill your weakest topics</div>
            </div>
            <div class="quick-action" onclick="Exams.startNew()">
              <div class="qa-icon">&#128221;</div>
              <div class="qa-title">Full Practice Exam</div>
              <div class="qa-desc">50 questions, 60 minutes</div>
            </div>
            <div class="quick-action" onclick="App.navigate('study-guide')">
              <div class="qa-icon">&#128214;</div>
              <div class="qa-title">Study Guide</div>
              <div class="qa-desc">Concepts & formulas</div>
            </div>
            <div class="quick-action" onclick="App.navigate('analytics')">
              <div class="qa-icon">&#128200;</div>
              <div class="qa-title">Analytics</div>
              <div class="qa-desc">Track progress</div>
            </div>
          </div>
        </div>

        <!-- Mastery Heat Map -->
        <div class="card full-width">
          <div class="section-title">&#128202; Topic Mastery</div>
          <div class="mastery-heatmap">
            ${topics.map(t => {
              const m = getTopicMastery(state, t.id);
              return `
                <div class="heatmap-row">
                  <div class="heatmap-label" title="${t.name}">${t.icon} ${t.name}</div>
                  <div class="heatmap-bar-wrap">
                    <div class="heatmap-bar" style="width:${Math.max(2, m)}%;background:${getMasteryColor(m)}"></div>
                    <div class="heatmap-pct" style="color:${m > 50 ? '#000' : 'var(--text-secondary)'}">${m}%</div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        ${lastExam ? `
        <div class="card full-width">
          <div class="section-title">&#128203; Last Exam Result</div>
          <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
            <div style="font-size:2.5rem;font-weight:800;color:${lastExam.pct >= 70 ? 'var(--success)' : 'var(--danger)'}">${lastExam.pct}%</div>
            <div>
              <div style="font-weight:600;">${lastExam.pct >= 70 ? 'Passed!' : 'Keep practicing'}</div>
              <div style="color:var(--text-muted);font-size:0.85rem;">${lastExam.score}/${lastExam.total} correct &mdash; ${new Date(lastExam.date).toLocaleDateString()}</div>
            </div>
            <button class="btn btn-secondary btn-sm" style="margin-left:auto;" onclick="App.navigate('review')">Review Answers</button>
          </div>
        </div>
        ` : ''}
      </div>
    `;
  }
};

// ===== FLASHCARDS.JS =====
// ===== FLASHCARD MODULE =====
const Flashcards = {
  sessionCards: [],
  currentIndex: 0,
  isFlipped: false,
  sessionStart: null,
  mode: 'menu', // menu, session, complete

  render(state) {
    if (!state) return;
    this.mode = 'menu';
    this.renderMenu(state);
  },

  renderMenu(state) {
    const container = document.getElementById('fcContent');
    const dueCards = SM2.getDueCards(state);
    const topics = getTopicsForPeriod(state.user.period);

    container.innerHTML = `
      <h1 style="margin-bottom:8px;">Flashcards</h1>
      <p style="color:var(--text-secondary);margin-bottom:32px;">Powered by spaced repetition \u2014 cards appear right before you'd forget them.</p>

      ${dueCards.length > 0 ? `
        <div class="card card-glow" style="margin-bottom:32px;text-align:center;padding:32px;cursor:pointer;" onclick="Flashcards.startDue()">
          <div style="font-size:2.5rem;margin-bottom:8px;">&#128293;</div>
          <div style="font-size:1.3rem;font-weight:700;margin-bottom:4px;">Review ${dueCards.length} Due Cards</div>
          <div style="color:var(--text-secondary);font-size:0.9rem;">These cards are due for review based on your learning progress</div>
          <button class="btn btn-primary btn-lg" style="margin-top:16px;">Start Review Session</button>
        </div>
      ` : `
        <div class="card" style="margin-bottom:32px;text-align:center;padding:32px;">
          <div style="font-size:2.5rem;margin-bottom:8px;">&#10003;</div>
          <div style="font-size:1.2rem;font-weight:700;color:var(--success);">All caught up!</div>
          <div style="color:var(--text-secondary);font-size:0.9rem;">No cards due right now. Pick a topic below to study ahead.</div>
        </div>
      `}

      <h2 style="margin-bottom:16px;">Study by Topic</h2>
      <div class="fc-topics-grid">
        ${topics.map(t => {
          const cards = FLASHCARD_BANK.filter(fc => fc.topic === t.id);
          const mastery = getTopicMastery(state, t.id);
          const due = cards.filter(fc => { const cd = state.flashcards[fc.id]; return cd && cd.nextReview <= Date.now(); }).length;
          return `
            <div class="fc-topic-card" onclick="Flashcards.startTopic('${t.id}')">
              <div class="tc-name">${t.icon} ${t.name}</div>
              <div class="tc-stats">${cards.length} cards &middot; ${mastery}% mastery</div>
              ${due > 0 ? `<div class="tc-due">${due} due now</div>` : '<div class="tc-due" style="color:var(--success);">Up to date</div>'}
              <div class="progress-bar" style="margin-top:8px;"><div class="fill" style="width:${mastery}%;background:${getMasteryColor(mastery)}"></div></div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  },

  startDue() {
    const state = Storage.get();
    this.sessionCards = SM2.getDueCards(state).sort(() => Math.random() - 0.5);
    if (this.sessionCards.length === 0) { showToast('No cards due!', 'info'); return; }
    this.currentIndex = 0;
    this.isFlipped = false;
    this.sessionStart = Date.now();
    this.mode = 'session';
    this.renderCard();
  },

  startTopic(topicId) {
    const state = Storage.get();
    // Get all cards for this topic, prioritizing due cards first
    const allCards = FLASHCARD_BANK.filter(fc => fc.topic === topicId);
    const due = allCards.filter(fc => { const cd = state.flashcards[fc.id]; return cd && cd.nextReview <= Date.now(); });
    const notDue = allCards.filter(fc => !due.includes(fc));
    this.sessionCards = [...due.sort(() => Math.random() - 0.5), ...notDue.sort(() => Math.random() - 0.5)];
    if (this.sessionCards.length === 0) { showToast('No cards for this topic', 'info'); return; }
    this.currentIndex = 0;
    this.isFlipped = false;
    this.sessionStart = Date.now();
    this.mode = 'session';
    App.navigate('flashcards');
    this.renderCard();
  },

  renderCard() {
    const container = document.getElementById('fcContent');
    if (this.currentIndex >= this.sessionCards.length) { this.renderComplete(); return; }

    const card = this.sessionCards[this.currentIndex];
    const state = Storage.get();
    const cd = state.flashcards[card.id];
    const tier = cd ? SM2.getMasteryTier(cd) : 'new';
    const topic = TOPICS[card.topic];

    container.innerHTML = `
      <div class="fc-session-header">
        <button class="btn btn-ghost" onclick="Flashcards.endSession()">&#10005; End Session</button>
        <div class="fc-count">Card ${this.currentIndex + 1} of ${this.sessionCards.length}</div>
        <div class="badge badge-${tier === 'new' ? 'danger' : tier === 'learning' ? 'warning' : tier === 'review' ? 'info' : 'success'}">${tier}</div>
      </div>

      <div class="diag-topic-badge">${topic?.icon || ''} ${topic?.name || card.topic}</div>

      <div class="fc-card-wrapper" onclick="Flashcards.flip()">
        <div class="fc-card ${this.isFlipped ? 'flipped' : ''}">
          <div class="fc-card-face">
            <div class="fc-label">Question</div>
            <div class="fc-text">${card.q}</div>
            <div class="fc-hint">Tap to reveal answer</div>
          </div>
          <div class="fc-card-face fc-card-back">
            <div class="fc-label">Answer</div>
            <div class="fc-text">${card.a}</div>
          </div>
        </div>
      </div>

      ${this.isFlipped ? `
        <p style="text-align:center;color:var(--text-secondary);margin-bottom:12px;font-size:0.85rem;">How well did you know this?</p>
        <div class="fc-rating">
          <button class="btn rate-again" onclick="Flashcards.rate(1)">&#10007; Again</button>
          <button class="btn rate-hard" onclick="Flashcards.rate(3)">&#128172; Hard</button>
          <button class="btn rate-good" onclick="Flashcards.rate(4)">&#10003; Good</button>
          <button class="btn rate-easy" onclick="Flashcards.rate(5)">&#128171; Easy</button>
        </div>
      ` : `
        <div class="fc-tap-hint">Tap the card or press Space to flip</div>
      `}

      <div style="display:flex;justify-content:center;gap:8px;margin-top:24px;">
        <button class="btn btn-ghost btn-sm" ${this.currentIndex === 0 ? 'disabled' : ''} onclick="Flashcards.prevCard()">&#8592; Previous</button>
        <button class="btn btn-ghost btn-sm" onclick="Flashcards.skip()">Skip &#8594;</button>
      </div>
    `;
  },

  flip() {
    this.isFlipped = !this.isFlipped;
    this.renderCard();
  },

  rate(quality) {
    const card = this.sessionCards[this.currentIndex];
    const state = Storage.get();
    if (!state.flashcards[card.id]) {
      state.flashcards[card.id] = { interval: 0, ease: 2.5, reps: 0, nextReview: 0, lastReview: null, correct: 0, incorrect: 0, quality: null, bookmarked: false };
    }
    SM2.update(state.flashcards[card.id], quality);

    // Award points for correct answers
    if (quality >= 4) {
      Points.award('Correct flashcard', Points.ACTIONS.flashcard_correct.base, true);
      // Bonus every 10 correct in a row
      this._correctStreak = (this._correctStreak || 0) + 1;
      if (this._correctStreak > 0 && this._correctStreak % 10 === 0) Points.award('10-card streak! 🔥', Points.ACTIONS.flashcard_streak.base);
    } else {
      this._correctStreak = 0;
    }

    // Update daily stats
    const today = getToday();
    if (!state.sessions.daily[today]) state.sessions.daily[today] = { flashcards: 0, exams: 0, time: 0 };
    state.sessions.daily[today].flashcards++;
    recordStudy(state);

    this.currentIndex++;
    this.isFlipped = false;
    this.renderCard();
  },

  skip() {
    this.currentIndex++;
    this.isFlipped = false;
    this.renderCard();
  },

  prevCard() {
    if (this.currentIndex > 0) { this.currentIndex--; this.isFlipped = false; this.renderCard(); }
  },

  endSession() {
    this.mode = 'menu';
    const state = Storage.get();
    // Record time
    if (this.sessionStart) {
      const elapsed = Date.now() - this.sessionStart;
      const today = getToday();
      if (!state.sessions.daily[today]) state.sessions.daily[today] = { flashcards: 0, exams: 0, time: 0 };
      state.sessions.daily[today].time = (state.sessions.daily[today].time || 0) + elapsed;
      state.sessions.totalTime = (state.sessions.totalTime || 0) + elapsed;
      Storage.set(state);
    }
    this.renderMenu(state);
  },

  renderComplete() {
    const container = document.getElementById('fcContent');
    const elapsed = this.sessionStart ? Date.now() - this.sessionStart : 0;
    const state = Storage.get();

    // Record time
    const today = getToday();
    if (!state.sessions.daily[today]) state.sessions.daily[today] = { flashcards: 0, exams: 0, time: 0 };
    state.sessions.daily[today].time = (state.sessions.daily[today].time || 0) + elapsed;
    state.sessions.totalTime = (state.sessions.totalTime || 0) + elapsed;
    Storage.set(state);

    container.innerHTML = `
      <div class="fc-complete slide-up">
        <div class="check-icon">&#127881;</div>
        <h2>Session Complete!</h2>
        <p>You reviewed ${this.sessionCards.length} cards in ${Math.round(elapsed / 60000)} minutes.</p>
        <div class="stat-grid" style="max-width:400px;margin:24px auto;">
          <div class="stat-card">
            <div class="stat-value">${state.sessions.streak}</div>
            <div class="stat-label">Day Streak</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${state.sessions.daily[today]?.flashcards || 0}</div>
            <div class="stat-label">Cards Today</div>
          </div>
        </div>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="Flashcards.startDue()">Review More Due Cards</button>
          <button class="btn btn-secondary" onclick="App.navigate('dashboard')">Back to Dashboard</button>
        </div>
      </div>
    `;
  }
};

// Keyboard shortcut for flashcards
document.addEventListener('keydown', e => {
  if (Flashcards.mode !== 'session') return;
  if (e.code === 'Space' && !Flashcards.isFlipped) { e.preventDefault(); Flashcards.flip(); }
  else if (e.key === '1' && Flashcards.isFlipped) Flashcards.rate(1);
  else if (e.key === '2' && Flashcards.isFlipped) Flashcards.rate(3);
  else if (e.key === '3' && Flashcards.isFlipped) Flashcards.rate(4);
  else if (e.key === '4' && Flashcards.isFlipped) Flashcards.rate(5);
  else if (e.key === 'ArrowRight') Flashcards.skip();
  else if (e.key === 'ArrowLeft') Flashcards.prevCard();
});

// ===== EXAMS.JS =====
// ===== EXAM MODULE =====
const Exams = {
  currentExam: null,
  currentQ: 0,
  answers: [],
  timer: null,
  timeLeft: 0,
  startTime: null,
  mode: 'list', // list, active, results

  render(state) {
    if (!state) return;
    if (this.mode === 'active') { this.renderQuestion(); return; }
    this.mode = 'list';
    this.renderList(state);
  },

  renderList(state) {
    const container = document.getElementById('examContent');
    const attempts = state.exams.attempts;
    const bestScore = attempts.length > 0 ? Math.max(...attempts.map(a => a.pct)) : null;

    container.innerHTML = `
      <h1 style="margin-bottom:8px;">Practice Exams</h1>
      <p style="color:var(--text-secondary);margin-bottom:32px;">Simulate the real Alberta IP exam \u2014 50 questions, 60 minutes, instant results.</p>

      <div class="card card-glow" style="margin-bottom:24px;padding:32px;">
        <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap;">
          <div style="font-size:3rem;">&#128221;</div>
          <div style="flex:1;">
            <h2 style="margin-bottom:4px;">Period ${state.user.period} Practice Exam</h2>
            <p style="color:var(--text-secondary);font-size:0.9rem;">50 multiple-choice questions covering all Period ${state.user.period} topics. 60-minute time limit. 70% to pass.</p>
          </div>
          <button class="btn btn-primary btn-lg" onclick="Exams.startNew()">Start Exam</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:32px;padding:28px;border:1px solid rgba(139,92,246,0.2);background:linear-gradient(135deg,rgba(139,92,246,0.04),rgba(59,130,246,0.04));">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <div style="font-size:1.8rem;">&#x1F3AF;</div>
          <div>
            <h2 style="margin:0;font-size:1.2rem;">Custom Exam Builder</h2>
            <p style="color:var(--text-muted);font-size:0.8rem;margin:2px 0 0;">Pick a module or topic and get every available question for it.</p>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:end;">
          <div>
            <label style="font-size:0.75rem;color:var(--text-muted);display:block;margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Select Module or Topic</label>
            <select id="customExamSelect" style="width:100%;padding:10px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:0.9rem;" onchange="Exams._updateCustomCount()">
              <option value="">-- Choose a module or topic --</option>
              <optgroup label="&#x1F4D6; By Module">
                ${MODULES.filter(m => m.hasContent).map(m => {
                  const topicIds = m.topics;
                  const qCount = EXAM_BANK.filter(eq => topicIds.includes(eq.topic)).length;
                  return '<option value="module:' + m.id + '">' + m.num + '. ' + m.name + ' (' + qCount + ' questions)</option>';
                }).join('')}
              </optgroup>
              <optgroup label="&#x1F4CA; By Topic (All)">
                ${Object.values(TOPICS).filter(t => t.period <= state.user.period).sort((a,b)=>a.order-b.order).map(t => {
                  const qCount = EXAM_BANK.filter(eq => eq.topic === t.id).length;
                  return qCount > 0 ? '<option value="topic:' + t.id + '">' + t.icon + ' ' + t.name + ' (' + qCount + ' questions)</option>' : '';
                }).join('')}
              </optgroup>
            </select>
          </div>
          <button class="btn btn-primary" onclick="Exams.startCustom()" id="customExamBtn" disabled style="white-space:nowrap;padding:10px 24px;">
            Build Exam
          </button>
        </div>
        <div id="customCountRow" style="display:none;margin-top:14px;padding:12px 14px;background:rgba(139,92,246,0.06);border-radius:8px;border:1px solid rgba(139,92,246,0.15);">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <label style="font-size:0.8rem;color:var(--text-secondary);font-weight:600;white-space:nowrap;">Question Count:</label>
            <div style="display:flex;align-items:center;gap:8px;flex:1;">
              <input type="range" id="customCountSlider" min="1" max="10" value="10"
                style="flex:1;accent-color:var(--accent);cursor:pointer;"
                oninput="Exams._syncCountInputs('slider')">
              <input type="number" id="customCountInput" min="1" max="10" value="10"
                style="width:64px;padding:6px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:0.9rem;text-align:center;"
                oninput="Exams._syncCountInputs('number')">
              <button class="btn btn-sm" onclick="Exams._setMaxCount()"
                style="background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:0.8rem;font-weight:600;cursor:pointer;white-space:nowrap;">
                MAX
              </button>
            </div>
          </div>
          <div id="customCountHint" style="margin-top:6px;font-size:0.78rem;color:var(--text-muted);"></div>
        </div>
        <div id="customExamInfo" style="margin-top:10px;font-size:0.8rem;color:var(--text-muted);"></div>
      </div>

      ${attempts.length > 0 ? `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <h2>Past Attempts</h2>
          ${bestScore !== null ? `<div class="badge badge-${bestScore >= 70 ? 'success' : 'warning'}">Best: ${bestScore}%</div>` : ''}
        </div>
        <div class="exam-list">
          ${attempts.slice().reverse().map((a, idx) => `
            <div class="exam-list-item">
              <div class="eli-info">
                <h3>Practice Exam #${attempts.length - idx}</h3>
                <p>${new Date(a.date).toLocaleDateString()} &mdash; ${a.score}/${a.total} correct &mdash; ${Math.round(a.timeSpent / 60000)} min</p>
              </div>
              <div class="eli-meta">
                <div class="best-score" style="color:${a.pct >= 70 ? 'var(--success)' : 'var(--danger)'}">${a.pct}%</div>
                <div style="font-size:0.8rem;color:var(--text-muted)">${a.pct >= 70 ? 'PASS' : 'FAIL'}</div>
              </div>
            </div>
          `).join('')}
        </div>
      ` : `
        <div class="empty-state">
          <h3>No exams taken yet</h3>
          <p style="color:var(--text-muted);">Take your first practice exam to see how you'd do on the real thing.</p>
        </div>
      `}
    `;
  },

  startNew() {
    const state = Storage.get();
    if (!state) return;

    // Build exam: 50 questions from the appropriate period
    const available = EXAM_BANK.filter(eq => {
      const t = TOPICS[eq.topic];
      return t && t.period <= state.user.period;
    });

    // Shuffle and pick 50 (or all if less)
    const shuffled = available.sort(() => Math.random() - 0.5);
    this.currentExam = shuffled.slice(0, Math.min(50, shuffled.length));
    this.answers = new Array(this.currentExam.length).fill(null);
    this.currentQ = 0;
    this.timeLeft = 60 * 60; // 60 minutes in seconds
    this.startTime = Date.now();
    this.mode = 'active';

    // Start timer
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.timeLeft--;
      this.updateTimer();
      if (this.timeLeft <= 0) { clearInterval(this.timer); this.submitExam(); }
    }, 1000);

    App.navigate('exams');
    this.renderQuestion();
  },

  _updateCustomCount() {
    const sel = document.getElementById('customExamSelect');
    const btn = document.getElementById('customExamBtn');
    const info = document.getElementById('customExamInfo');
    const countRow = document.getElementById('customCountRow');
    if (!sel || !btn) return;
    const val = sel.value;
    if (!val) {
      btn.disabled = true;
      info.innerHTML = '';
      if (countRow) countRow.style.display = 'none';
      return;
    }
    const questions = this._getCustomQuestions(val);
    btn.disabled = questions.length === 0;
    if (questions.length > 0) {
      // Show and configure the count controls
      if (countRow) {
        countRow.style.display = 'block';
        const slider = document.getElementById('customCountSlider');
        const numInput = document.getElementById('customCountInput');
        const hint = document.getElementById('customCountHint');
        if (slider) { slider.max = questions.length; slider.value = questions.length; }
        if (numInput) { numInput.max = questions.length; numInput.value = questions.length; }
        if (hint) hint.textContent = questions.length + ' questions available — drag the slider or type a number (1–' + questions.length + ')';
      }
      const topicBreakdown = {};
      questions.forEach(q => { topicBreakdown[q.topic] = (topicBreakdown[q.topic] || 0) + 1; });
      const breakdown = Object.entries(topicBreakdown).map(([tid, count]) => (TOPICS[tid]?.name || tid) + ': ' + count).join(', ');
      info.innerHTML = '<strong style="color:var(--accent);">' + questions.length + ' questions available</strong> &mdash; ' + breakdown;
    } else {
      if (countRow) countRow.style.display = 'none';
      info.innerHTML = '<span style="color:#ef4444;">No questions available for this selection</span>';
    }
  },

  _syncCountInputs(source) {
    const slider = document.getElementById('customCountSlider');
    const numInput = document.getElementById('customCountInput');
    if (!slider || !numInput) return;
    const max = parseInt(slider.max) || 1;
    if (source === 'slider') {
      let v = Math.max(1, Math.min(max, parseInt(slider.value) || 1));
      slider.value = v;
      numInput.value = v;
    } else {
      let v = Math.max(1, Math.min(max, parseInt(numInput.value) || 1));
      numInput.value = v;
      slider.value = v;
    }
  },

  _setMaxCount() {
    const slider = document.getElementById('customCountSlider');
    const numInput = document.getElementById('customCountInput');
    if (!slider || !numInput) return;
    slider.value = slider.max;
    numInput.value = slider.max;
  },

  _getCustomQuestions(val) {
    if (!val) return [];
    const [type, id] = val.split(':');
    if (type === 'module') {
      const mod = MODULES.find(m => m.id === id);
      if (!mod) return [];
      return EXAM_BANK.filter(eq => mod.topics.includes(eq.topic));
    } else if (type === 'topic') {
      return EXAM_BANK.filter(eq => eq.topic === id);
    }
    return [];
  },

  startCustom() {
    const sel = document.getElementById('customExamSelect');
    if (!sel || !sel.value) return;
    const state = Storage.get();
    if (!state) return;
    const questions = this._getCustomQuestions(sel.value);
    if (questions.length === 0) return showToast('No questions available for this selection', 'error');

    // Get the user-chosen count from the slider/input (default to all)
    const numInput = document.getElementById('customCountInput');
    const wantedCount = numInput ? Math.max(1, Math.min(questions.length, parseInt(numInput.value) || questions.length)) : questions.length;

    // Shuffle the questions then slice to requested count
    const shuffled = [...questions].sort(() => Math.random() - 0.5);
    this.currentExam = shuffled.slice(0, wantedCount);
    this.answers = new Array(this.currentExam.length).fill(null);
    this.currentQ = 0;
    // Time: 1.2 minutes per question, minimum 5 minutes
    this.timeLeft = Math.max(300, Math.round(this.currentExam.length * 72));
    this.startTime = Date.now();
    this.mode = 'active';
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.timeLeft--;
      this.updateTimer();
      if (this.timeLeft <= 0) { clearInterval(this.timer); this.submitExam(); }
    }, 1000);
    showToast('Custom exam started: ' + this.currentExam.length + ' questions', 'success');
    App.navigate('exams');
    this.renderQuestion();
  },

  updateTimer() {
    const el = document.getElementById('examTimerDisplay');
    if (!el) return;
    const m = Math.floor(this.timeLeft / 60);
    const s = this.timeLeft % 60;
    el.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    if (this.timeLeft < 300) el.classList.add('warning');
  },

  renderQuestion() {
    const container = document.getElementById('examContent');
    const q = this.currentExam[this.currentQ];
    const topic = TOPICS[q.topic];
    const answered = this.answers.filter(a => a !== null).length;

    container.innerHTML = `
      <div class="exam-header">
        <div style="display:flex;align-items:center;gap:12px;">
          <button class="btn btn-ghost btn-sm" onclick="Exams.confirmEnd()">&#10005; End</button>
          <span style="color:var(--text-muted);font-size:0.85rem;">${answered}/${this.currentExam.length} answered</span>
        </div>
        <div class="exam-timer ${this.timeLeft < 300 ? 'warning' : ''}" id="examTimerDisplay">
          ${Math.floor(this.timeLeft / 60)}:${(this.timeLeft % 60).toString().padStart(2, '0')}
        </div>
        <div class="badge badge-info">${topic?.name || ''}</div>
      </div>

      <div class="exam-question-area">
        <div class="exam-q-num">Question ${this.currentQ + 1} of ${this.currentExam.length}</div>
        <div class="exam-q-text">${q.q}</div>
        <div class="exam-options">
          ${q.opts.map((opt, i) => `
            <div class="exam-option ${this.answers[this.currentQ] === i ? 'selected' : ''}" onclick="Exams.selectAnswer(${i})">
              <div class="opt-letter">${String.fromCharCode(65 + i)}</div>
              <div>${opt}</div>
            </div>
          `).join('')}
        </div>
        <div class="exam-nav">
          <button class="btn btn-secondary" ${this.currentQ === 0 ? 'disabled' : ''} onclick="Exams.prevQ()">&#8592; Previous</button>
          ${this.currentQ < this.currentExam.length - 1
            ? `<button class="btn btn-primary" onclick="Exams.nextQ()">Next &#8594;</button>`
            : `<button class="btn btn-primary" onclick="Exams.confirmSubmit()">Submit Exam</button>`
          }
        </div>

        <div class="exam-dots" style="margin-top:20px;">
          ${this.currentExam.map((_, i) => `
            <div class="exam-dot ${this.answers[i] !== null ? 'answered' : ''} ${i === this.currentQ ? 'current' : ''}"
                 onclick="Exams.goToQ(${i})">${i + 1}</div>
          `).join('')}
        </div>
      </div>
    `;
  },

  selectAnswer(idx) {
    this.answers[this.currentQ] = idx;
    this.renderQuestion();
  },

  nextQ() { if (this.currentQ < this.currentExam.length - 1) { this.currentQ++; this.renderQuestion(); } },
  prevQ() { if (this.currentQ > 0) { this.currentQ--; this.renderQuestion(); } },
  goToQ(i) { this.currentQ = i; this.renderQuestion(); },

  confirmSubmit() {
    const unanswered = this.answers.filter(a => a === null).length;
    if (unanswered > 0) {
      if (!confirm(`You have ${unanswered} unanswered question${unanswered > 1 ? 's' : ''}. Submit anyway?`)) return;
    }
    this.submitExam();
  },

  confirmEnd() {
    if (confirm('Are you sure you want to end this exam? Your progress will be lost.')) {
      clearInterval(this.timer);
      this.mode = 'list';
      const state = Storage.get();
      this.renderList(state);
    }
  },

  submitExam() {
    clearInterval(this.timer);
    const state = Storage.get();
    const timeSpent = Date.now() - this.startTime;

    let score = 0;
    const responses = this.currentExam.map((q, i) => {
      const isCorrect = this.answers[i] === q.correct;
      if (isCorrect) score++;
      return { qId: q.id, topic: q.topic, selected: this.answers[i], correct: q.correct, isCorrect, q: q.q, opts: q.opts, exp: q.exp };
    });

    const pct = Math.round((score / this.currentExam.length) * 100);

    // Topic breakdown
    const topicScores = {};
    responses.forEach(r => {
      if (!topicScores[r.topic]) topicScores[r.topic] = { correct: 0, total: 0 };
      topicScores[r.topic].total++;
      if (r.isCorrect) topicScores[r.topic].correct++;
    });

    const attempt = {
      id: 'exam_' + Date.now(),
      date: Date.now(),
      score, total: this.currentExam.length, pct,
      timeSpent, responses, topicScores
    };

    state.exams.attempts.push(attempt);
    SiteAnalytics.track('exam_complete', { userId: state.user.id, score: pct, correct: score, total: this.currentExam.length });
    Points.awardExam(pct);

    // Update daily stats
    const today = getToday();
    if (!state.sessions.daily[today]) state.sessions.daily[today] = { flashcards: 0, exams: 0, time: 0 };
    state.sessions.daily[today].exams++;
    state.sessions.daily[today].time = (state.sessions.daily[today].time || 0) + timeSpent;
    state.sessions.totalTime = (state.sessions.totalTime || 0) + timeSpent;
    recordStudy(state);

    this.mode = 'results';
    this.renderResults(attempt, state);
  },

  renderResults(attempt, state) {
    const container = document.getElementById('examContent');
    const topicEntries = Object.entries(attempt.topicScores).map(([tid, s]) => ({
      name: TOPICS[tid]?.name || tid, icon: TOPICS[tid]?.icon || '', pct: Math.round((s.correct / s.total) * 100), correct: s.correct, total: s.total
    })).sort((a, b) => a.pct - b.pct);

    container.innerHTML = `
      <div class="exam-results slide-up">
        <div style="margin-bottom:24px;">
          <div class="big-score ${attempt.pct >= 70 ? 'pass' : 'fail'}">${attempt.pct}%</div>
          <div style="font-size:1.3rem;font-weight:600;margin-top:8px;">${attempt.pct >= 70 ? 'You Passed!' : 'Not Yet \u2014 Keep Practicing!'}</div>
          <div style="color:var(--text-secondary);margin-top:4px;">${attempt.score}/${attempt.total} correct &mdash; ${Math.round(attempt.timeSpent / 60000)} minutes</div>
        </div>

        <h3 style="margin-bottom:16px;">Performance by Topic</h3>
        <div class="diag-breakdown" style="margin-bottom:32px;">
          ${topicEntries.map(te => `
            <div class="diag-topic-result">
              <span class="topic-name">${te.icon} ${te.name}</span>
              <span class="topic-score" style="color:${getMasteryColor(te.pct)}">${te.correct}/${te.total} (${te.pct}%)</span>
            </div>
          `).join('')}
        </div>

        <h3 style="margin-bottom:16px;">Question Review</h3>
        <div style="display:flex;flex-direction:column;gap:12px;text-align:left;max-width:800px;margin:0 auto;">
          ${attempt.responses.map((r, i) => `
            <div class="review-question">
              <div class="rq-topic">${TOPICS[r.topic]?.name || r.topic}</div>
              <div class="rq-text">${i + 1}. ${r.q}</div>
              <div class="rq-answer">
                ${r.isCorrect
                  ? `<span class="rq-correct-answer">&#10003; ${r.opts[r.correct]}</span>`
                  : `<span class="rq-your-answer">&#10007; Your answer: ${r.selected !== null ? r.opts[r.selected] : 'Unanswered'}</span><br><span class="rq-correct-answer">&#10003; Correct: ${r.opts[r.correct]}</span>`
                }
              </div>
              ${r.exp ? `<div class="rq-explanation">${r.exp}</div>` : ''}
            </div>
          `).join('')}
        </div>

        <div style="display:flex;gap:12px;justify-content:center;margin-top:32px;flex-wrap:wrap;">
          ${(() => {
            const wrongs = attempt.responses.filter(r=>!r.isCorrect).map(r=>({q:r.q,opts:r.opts,correct:r.correct,selected:r.selected,exp:r.exp||'',topic:r.topic}));
            if (wrongs.length > 0) { WrongAnswerStudy._pending = wrongs; WrongAnswerStudy._pendingLabel = 'Exam'; }
            return wrongs.length > 0 ? `<button class="btn btn-primary" style="background:linear-gradient(135deg,#ef4444,#f59e0b);border:none;order:-1;" onclick="WrongAnswerStudy.launchPending()">📖 Study My ${wrongs.length} Wrong Answer${wrongs.length!==1?'s':''}</button>` : '';
          })()}
          <button class="btn btn-primary" onclick="Exams.startNew()">Take Another Exam</button>
          <button class="btn btn-secondary" onclick="Exams.mode='list';App.navigate('exams')">Back to Exams</button>
          <button class="btn btn-secondary" onclick="App.navigate('dashboard')">Dashboard</button>
        </div>
      </div>
    `;
  }
};

// ===== NOTES MODULE =====
const Notes = {
  currentTopic: 'general',
  mode: 'edit',   // 'edit' | 'quiz' | 'study'
  quizCards: [],
  quizIdx: 0,
  quizAnswers: {},

  // Special characters for electrical trade
  CHARS: [
    { label:'Ω', tip:'Ohm' }, { label:'μ', tip:'Micro' }, { label:'°', tip:'Degree' },
    { label:'∠', tip:'Angle' }, { label:'Δ', tip:'Delta' }, { label:'φ', tip:'Phi (phase)' },
    { label:'π', tip:'Pi' }, { label:'√', tip:'Square root' }, { label:'²', tip:'Squared' },
    { label:'³', tip:'Cubed' }, { label:'±', tip:'Plus/minus' }, { label:'×', tip:'Multiply' },
    { label:'÷', tip:'Divide' }, { label:'≤', tip:'Less/equal' }, { label:'≥', tip:'Greater/equal' },
    { label:'≠', tip:'Not equal' }, { label:'∑', tip:'Sum' }, { label:'∞', tip:'Infinity' },
    { label:'→', tip:'Arrow' }, { label:'↑', tip:'Up' }, { label:'↓', tip:'Down' },
    { label:'✓', tip:'Check' }, { label:'✗', tip:'Cross' }, { label:'⚡', tip:'Lightning' },
    { label:'½', tip:'Half' }, { label:'¼', tip:'Quarter' }, { label:'¾', tip:'3/4' },
  ],

  TOPICS_LIST: [
    { id:'general', name:'📝 General Notes', icon:'📝' },
    { id:'safety', name:'Safety', icon:'🦺' },
    { id:'tools', name:'Tools & Equipment', icon:'🔧' },
    { id:'conductors', name:'Conductors & Cables', icon:'🔌' },
    { id:'wiring-methods', name:'Wiring Methods', icon:'📐' },
    { id:'residential', name:'Residential Wiring', icon:'🏠' },
    { id:'grounding-bonding', name:'Grounding & Bonding', icon:'⏚' },
    { id:'overcurrent', name:'Overcurrent Protection', icon:'⚡' },
    { id:'motors', name:'Motors', icon:'⚙️' },
    { id:'transformers', name:'Transformers', icon:'🔄' },
    { id:'ac-theory', name:'AC Theory', icon:'〰️' },
    { id:'dc-theory', name:'DC Theory', icon:'🔋' },
    { id:'code-cec', name:'CEC Code', icon:'📖' },
    { id:'exam-prep', name:'Exam Prep', icon:'🎯' },
  ],

  _storageKey(userId, topicId) { return `sparky_notes_${userId}_${topicId}`; },

  _load(userId, topicId) {
    return localStorage.getItem(this._storageKey(userId, topicId)) || '';
  },

  _save(userId, topicId, html) {
    localStorage.setItem(this._storageKey(userId, topicId), html);
    // Update last-edited timestamp
    localStorage.setItem(`sparky_notes_ts_${userId}_${topicId}`, Date.now());
  },

  _wordCount(html) {
    const text = html.replace(/<[^>]*>/g,'').trim();
    return text ? text.split(/\s+/).filter(Boolean).length : 0;
  },

  _allNoteIds(userId) {
    return this.TOPICS_LIST.map(t => ({ ...t, has: !!localStorage.getItem(this._storageKey(userId, t.id)) }));
  },

  render(state) {
    const container = document.getElementById('notesContent');
    if (!container || !state) return;
    const userId = state.user.id;
    if (this.mode === 'quiz') { this._renderQuiz(container, userId); return; }
    if (this.mode === 'study') { this._renderStudy(container, userId); return; }
    this._renderEditor(container, state);
  },

  _renderEditor(container, state) {
    const userId = state.user.id;
    const topic = this.TOPICS_LIST.find(t => t.id === this.currentTopic) || this.TOPICS_LIST[0];
    const savedHtml = this._load(userId, this.currentTopic);
    const topics = this._allNoteIds(userId);

    container.innerHTML = `
      <div style="display:grid;grid-template-columns:220px 1fr;gap:20px;min-height:calc(100vh - 120px);">
        <!-- Sidebar -->
        <div class="notes-no-print" style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:14px;height:fit-content;position:sticky;top:80px;">
          <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);font-weight:700;padding:0 4px;margin-bottom:10px;">Topics</div>
          ${topics.map(t => `
            <div class="notes-sidebar-item ${t.id===this.currentTopic?'active':''}" onclick="Notes._switchTopic('${t.id}','${userId}')">
              ${t.icon} ${t.name}
              ${t.has ? '<span style="float:right;font-size:0.65rem;color:var(--accent);">●</span>' : ''}
            </div>
          `).join('')}
        </div>

        <!-- Main editor pane -->
        <div>
          <!-- Header -->
          <div class="notes-no-print" style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px 16px 0 0;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.06);">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:1.4rem;">${topic.icon}</span>
                <div>
                  <div style="font-weight:800;font-size:1rem;">${topic.name}</div>
                  <div style="font-size:0.72rem;color:var(--text-muted);" id="notesStatus">Auto-saved</div>
                </div>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn btn-secondary btn-sm" onclick="Notes._studyMode('${userId}')" title="Highlight key terms and review">📖 Study Mode</button>
                <button class="btn btn-secondary btn-sm" onclick="Notes._generateQuiz('${userId}')" title="Auto-generate quiz from your notes">⚡ Make Quiz</button>
                <button class="btn btn-secondary btn-sm" onclick="Notes._print('${userId}')" title="Print clean notes">🖨️ Print</button>
              </div>
            </div>
            <!-- Formatting toolbar -->
            <div class="notes-toolbar">
              <button class="ntb" onclick="Notes._fmt('bold')" title="Bold"><b>B</b></button>
              <button class="ntb" onclick="Notes._fmt('italic')" title="Italic"><i>I</i></button>
              <button class="ntb" onclick="Notes._fmt('underline')" title="Underline"><u>U</u></button>
              <button class="ntb" onclick="Notes._fmt('strikeThrough')" title="Strikethrough"><s>S</s></button>
              <div class="ntb-sep"></div>
              <button class="ntb" onclick="Notes._fmt('insertUnorderedList')" title="Bullet list">• List</button>
              <button class="ntb" onclick="Notes._fmt('insertOrderedList')" title="Numbered list">1. List</button>
              <div class="ntb-sep"></div>
              <button class="ntb" onclick="Notes._heading(1)" title="Heading 1" style="font-size:0.9rem;font-weight:900;">H1</button>
              <button class="ntb" onclick="Notes._heading(2)" title="Heading 2" style="font-size:0.85rem;font-weight:800;">H2</button>
              <button class="ntb" onclick="Notes._heading(3)" title="Heading 3" style="font-size:0.8rem;font-weight:700;">H3</button>
              <div class="ntb-sep"></div>
              <button class="ntb" onclick="Notes._fmt('removeFormat')" title="Clear formatting">✕ Format</button>
              <button class="ntb" onclick="Notes._highlight()" title="Highlight (marks as quiz term)" style="background:rgba(245,158,11,0.15);color:var(--accent);">★ Key Term</button>
            </div>
          </div>

          <!-- Special character bar -->
          <div class="notes-char-bar notes-no-print">
            <span style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-muted);font-weight:700;align-self:center;white-space:nowrap;margin-right:4px;">Quick Insert:</span>
            ${this.CHARS.map(c => `<button class="char-btn" onclick="Notes._insertChar('${c.label}')" title="${c.tip}">${c.label}</button>`).join('')}
          </div>

          <!-- Editor -->
          <div id="notesEditorWrap" class="notes-print-area" style="background:var(--bg-card);border:1px solid var(--border);border-top:none;border-radius:0 0 16px 16px;">
            <div id="notesEditor" class="notes-editor"
              contenteditable="true"
              spellcheck="true"
              autocorrect="on"
              data-placeholder="Start typing your notes here...&#10;&#10;Tip: Bold important terms with the toolbar — they'll become quiz cards automatically. Use the special character buttons above to insert Ω, μ, °, ∠ and more."
              oninput="Notes._onInput('${userId}')"
            >${savedHtml}</div>
            <!-- Print header (hidden on screen) -->
            <div id="notesPrintHeader" style="display:none;">
              <h2>${topic.name} — sparkystudy Notes</h2>
              <p style="font-size:0.8rem;color:#666;">Student: ${state.user.name} &nbsp;|&nbsp; Date: ${new Date().toLocaleDateString()}</p>
              <hr>
            </div>
          </div>

          <!-- Word count bar -->
          <div class="notes-no-print" id="notesWordBar" style="display:flex;align-items:center;justify-content:space-between;padding:8px 4px;font-size:0.72rem;color:var(--text-muted);">
            <span id="notesWordCount">0 words</span>
            <span>Tip: <strong style="color:var(--accent);">★ Key Term</strong> = auto-quiz card</span>
          </div>
        </div>
      </div>
    `;

    // Init word count
    const editor = document.getElementById('notesEditor');
    if (editor) {
      document.getElementById('notesWordCount').textContent = this._wordCount(editor.innerHTML) + ' words';
    }
  },

  _switchTopic(topicId, userId) {
    // Save current before switching
    const editor = document.getElementById('notesEditor');
    if (editor) this._save(userId, this.currentTopic, editor.innerHTML);
    this.currentTopic = topicId;
    const state = Storage.get();
    this.render(state);
    setTimeout(() => { const ed = document.getElementById('notesEditor'); if (ed) ed.focus(); }, 100);
  },

  _fmt(cmd) {
    document.getElementById('notesEditor')?.focus();
    document.execCommand(cmd, false, null);
  },

  _heading(level) {
    document.getElementById('notesEditor')?.focus();
    document.execCommand('formatBlock', false, 'h' + level);
  },

  _highlight() {
    document.getElementById('notesEditor')?.focus();
    // Wrap selection in a mark span that signals "quiz term"
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      showToast('Select a word or phrase first, then click Key Term', 'info');
      return;
    }
    document.execCommand('hiliteColor', false, 'rgba(245,158,11,0.3)');
    document.execCommand('bold', false, null);
    showToast('Key term marked — it\'ll appear in your auto-quiz!', 'success');
  },

  _insertChar(char) {
    const editor = document.getElementById('notesEditor');
    if (!editor) return;
    editor.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(char));
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      document.execCommand('insertText', false, char);
    }
    // Trigger save
    const userId = Storage.get()?.user?.id;
    if (userId) this._save(userId, this.currentTopic, editor.innerHTML);
  },

  _onInput(userId) {
    const editor = document.getElementById('notesEditor');
    if (!editor) return;
    // Debounced auto-save
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._save(userId, this.currentTopic, editor.innerHTML);
      const status = document.getElementById('notesStatus');
      if (status) { status.textContent = 'Saved ' + new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
    }, 800);
    // Word count
    const wc = document.getElementById('notesWordCount');
    if (wc) wc.textContent = this._wordCount(editor.innerHTML) + ' words';
  },

  _print(userId) {
    const editor = document.getElementById('notesEditor');
    if (!editor) return;
    this._save(userId, this.currentTopic, editor.innerHTML);
    const header = document.getElementById('notesPrintHeader');
    if (header) header.style.display = 'block';
    window.print();
    if (header) header.style.display = 'none';
  },

  // ── Study Mode: render notes with key terms highlighted, show glossary ──
  _studyMode(userId) {
    const editor = document.getElementById('notesEditor');
    if (editor) this._save(userId, this.currentTopic, editor.innerHTML);
    this.mode = 'study';
    const state = Storage.get();
    this.render(state);
  },

  _renderStudy(container, userId) {
    const html = this._load(userId, this.currentTopic);
    const topic = this.TOPICS_LIST.find(t => t.id === this.currentTopic) || this.TOPICS_LIST[0];

    // Extract highlighted/bolded terms for glossary
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    const terms = new Set();
    tempDiv.querySelectorAll('b, strong, mark').forEach(el => {
      const t = el.textContent.trim();
      if (t.length > 1 && t.length < 80) terms.add(t);
    });

    container.innerHTML = `
      <div style="max-width:860px;margin:0 auto;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-size:1.5rem;">${topic.icon}</span>
            <div>
              <h2 style="margin:0;font-size:1.1rem;">Study Mode — ${topic.name}</h2>
              <div style="font-size:0.75rem;color:var(--text-muted);">Key terms highlighted · Read through, then test yourself</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-primary btn-sm" onclick="Notes.mode='quiz';Notes._generateQuiz('${userId}')">⚡ Take Quiz</button>
            <button class="btn btn-secondary btn-sm" onclick="Notes.mode='edit';Notes.render(Storage.get())">← Back to Notes</button>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr ${terms.size>0?'260px':'0'};gap:20px;align-items:start;">
          <!-- Notes content -->
          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:24px;font-size:0.95rem;line-height:1.9;color:var(--text-primary);">
            ${html || '<p style="color:var(--text-muted);">No notes yet for this topic.</p>'}
          </div>

          <!-- Key terms sidebar -->
          ${terms.size > 0 ? `
            <div style="background:linear-gradient(135deg,rgba(245,158,11,0.07),rgba(245,158,11,0.02));border:1px solid rgba(245,158,11,0.2);border-radius:16px;padding:16px;position:sticky;top:80px;">
              <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:var(--accent);font-weight:700;margin-bottom:12px;">⭐ Key Terms (${terms.size})</div>
              ${[...terms].map(t=>`
                <div style="padding:7px 10px;background:rgba(245,158,11,0.08);border-radius:8px;font-size:0.83rem;font-weight:600;color:var(--text-primary);margin-bottom:6px;border-left:3px solid var(--accent);">${t}</div>
              `).join('')}
              <div style="margin-top:14px;font-size:0.72rem;color:var(--text-muted);">These terms will appear in your auto-quiz</div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  },

  // ── Quiz Generation ──
  _generateQuiz(userId) {
    const editor = document.getElementById('notesEditor');
    if (editor) this._save(userId, this.currentTopic, editor.innerHTML);
    const html = this._load(userId, this.currentTopic);
    if (!html.trim()) { showToast('Write some notes first! Bold key terms to get better quiz cards.', 'info'); return; }

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    const cards = [];
    const usedTerms = new Set();

    // Method 1: Sentences containing bolded terms
    tempDiv.querySelectorAll('p, li, div, h1, h2, h3').forEach(el => {
      const bolds = el.querySelectorAll('b, strong');
      bolds.forEach(b => {
        const term = b.textContent.trim();
        if (!term || term.length < 2 || term.length > 60 || usedTerms.has(term.toLowerCase())) return;
        usedTerms.add(term.toLowerCase());
        const sentence = el.textContent.trim();
        if (sentence.length < 10) return;
        // Make fill-in-blank by removing the term
        const blanked = sentence.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'), '________');
        cards.push({ type:'blank', question: blanked, answer: term, hint: sentence });
      });
    });

    // Method 2: Definition patterns "X is Y" / "X = Y" / "X: Y" from text nodes
    const fullText = tempDiv.textContent;
    const defPatterns = [
      /([A-Za-zΩμ°∠Δφ \d]+?)\s*=\s*([^.\n,]{5,60})/g,
      /([A-Z][a-z]+(?:\s[a-z]+)?)\s+(?:is|are|means?)\s+([^.\n]{10,80})/g,
    ];
    defPatterns.forEach(re => {
      let m;
      while ((m = re.exec(fullText)) !== null) {
        const term = m[1].trim(), def = m[2].trim();
        if (!term || !def || usedTerms.has(term.toLowerCase())) continue;
        usedTerms.add(term.toLowerCase());
        cards.push({ type:'def', question: `What is ${term}?`, answer: def, hint: `${term} = ${def}` });
      }
    });

    if (cards.length === 0) {
      showToast('No quiz cards found! Bold important terms or write "X is Y" definitions.', 'info');
      return;
    }

    // Shuffle
    this.quizCards = cards.sort(() => Math.random() - 0.5).slice(0, 20);
    this.quizIdx = 0;
    this.quizAnswers = {};
    this.mode = 'quiz';
    const state = Storage.get();
    this.render(state);
  },

  _renderQuiz(container, userId) {
    const topic = this.TOPICS_LIST.find(t => t.id === this.currentTopic) || this.TOPICS_LIST[0];
    const cards = this.quizCards;
    const done = this.quizIdx >= cards.length;

    if (done) {
      // Results
      let correct = 0;
      cards.forEach((c,i) => {
        const ua = (this.quizAnswers[i]||'').trim().toLowerCase();
        const ans = c.answer.trim().toLowerCase();
        if (ua && (ans.includes(ua) || ua.includes(ans) || ua === ans)) correct++;
      });
      const pct = Math.round(correct/cards.length*100);
      if (pct === 100) launchConfetti();

      container.innerHTML = `
        <div style="max-width:600px;margin:0 auto;text-align:center;padding:48px 20px;">
          <div style="font-size:4rem;font-weight:900;color:${pct>=80?'var(--success)':'var(--danger)'};">${pct}%</div>
          <div style="font-size:1.3rem;font-weight:700;margin:8px 0;">${pct>=90?'You nailed it! 🏆':pct>=70?'Solid work! 🎉':'Keep reviewing! 💪'}</div>
          <div style="color:var(--text-muted);margin-bottom:28px;">${correct}/${cards.length} correct · based on your own notes</div>
          <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="Notes._generateQuiz('${userId}')">🔁 New Quiz</button>
            <button class="btn btn-secondary" onclick="Notes._studyMode('${userId}')">📖 Study Mode</button>
            <button class="btn btn-secondary" onclick="Notes.mode='edit';Notes.render(Storage.get())">← Notes</button>
          </div>
          <div style="margin-top:32px;text-align:left;">
            <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-muted);font-weight:700;margin-bottom:12px;">Answer Review</div>
            ${cards.map((c,i)=>{
              const ua=(this.quizAnswers[i]||'').trim().toLowerCase();
              const ans=c.answer.trim().toLowerCase();
              const ok = ua && (ans.includes(ua)||ua.includes(ans)||ua===ans);
              return `<div style="background:var(--bg-card);border:1px solid ${ok?'rgba(34,197,94,0.3)':'rgba(239,68,68,0.2)'};border-left:3px solid ${ok?'#22c55e':'#ef4444'};border-radius:10px;padding:12px 14px;margin-bottom:8px;">
                <div style="font-size:0.83rem;color:var(--text-primary);margin-bottom:4px;">${c.question}</div>
                <div style="font-size:0.8rem;color:#22c55e;">✓ ${c.answer}</div>
                ${!ok&&this.quizAnswers[i]?`<div style="font-size:0.78rem;color:#ef4444;">You wrote: ${this.quizAnswers[i]}</div>`:''}
              </div>`;
            }).join('')}
          </div>
        </div>`;
      return;
    }

    const card = cards[this.quizIdx];
    const answered = this.quizAnswers[this.quizIdx] !== undefined;

    container.innerHTML = `
      <div style="max-width:640px;margin:0 auto;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px;">
          <div>
            <h2 style="margin:0;font-size:1.05rem;font-weight:800;">📝 Notes Quiz — ${topic.name}</h2>
            <div style="font-size:0.75rem;color:var(--text-muted);">Questions generated from your own notes</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="Notes.mode='edit';Notes.render(Storage.get())">✕ Exit</button>
        </div>

        <!-- Progress -->
        <div style="margin-bottom:20px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:0.8rem;">
            <span style="color:var(--text-muted);">Card ${this.quizIdx+1} of ${cards.length}</span>
            <span style="color:var(--accent);font-weight:700;">${Math.round(this.quizIdx/cards.length*100)}%</span>
          </div>
          <div style="height:6px;background:var(--bg-input);border-radius:3px;overflow:hidden;">
            <div style="height:100%;width:${this.quizIdx/cards.length*100}%;background:var(--accent);border-radius:3px;transition:width 0.4s;"></div>
          </div>
        </div>

        <!-- Card -->
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:28px;margin-bottom:16px;">
          <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.8px;color:var(--accent);font-weight:700;margin-bottom:12px;">
            ${card.type==='blank'?'FILL IN THE BLANK':'DEFINITION'}
          </div>
          <div style="font-size:1.05rem;font-weight:600;line-height:1.7;color:var(--text-primary);">${card.question}</div>
        </div>

        <!-- Answer input -->
        <div style="margin-bottom:16px;">
          <input type="text" id="notesQuizInput" placeholder="Type your answer..."
            style="width:100%;padding:14px 16px;background:var(--bg-card);border:2px solid ${answered?'rgba(34,197,94,0.4)':'var(--border)'};border-radius:12px;color:var(--text-primary);font-size:1rem;outline:none;box-sizing:border-box;"
            value="${this.quizAnswers[this.quizIdx]||''}"
            onkeydown="if(event.key==='Enter'){Notes._submitQuizAnswer('${userId}');}"
            ${answered?'disabled':''}>
        </div>

        ${answered ? `
          <div style="background:rgba(245,158,11,0.07);border:1px solid rgba(245,158,11,0.2);border-radius:12px;padding:14px;margin-bottom:16px;">
            <div style="font-size:0.7rem;text-transform:uppercase;color:var(--accent);font-weight:700;margin-bottom:6px;">✓ From your notes</div>
            <div style="font-size:0.88rem;color:var(--text-primary);">${card.hint}</div>
          </div>
          <button class="btn btn-primary" style="width:100%;" onclick="Notes._nextQuiz('${userId}')">
            ${this.quizIdx+1<cards.length?'Next →':'See Results'}
          </button>
        ` : `
          <button class="btn btn-primary" style="width:100%;opacity:${document.getElementById('notesQuizInput')?.value?'1':'0.5'};" onclick="Notes._submitQuizAnswer('${userId}')">
            Confirm Answer
          </button>
        `}
      </div>
    `;
    // Focus input
    setTimeout(() => document.getElementById('notesQuizInput')?.focus(), 50);
  },

  _submitQuizAnswer(userId) {
    const input = document.getElementById('notesQuizInput');
    if (!input || !input.value.trim()) { showToast('Type an answer first!', 'info'); return; }
    this.quizAnswers[this.quizIdx] = input.value.trim();
    const state = Storage.get();
    this.render(state);
    window.scrollTo(0,0);
  },

  _nextQuiz(userId) {
    this.quizIdx++;
    const state = Storage.get();
    this.render(state);
    window.scrollTo(0,0);
  }
};

// ===== WRONG ANSWER STUDY MODULE =====
const WrongAnswerStudy = {
  questions: [],      // [{q, opts, correct, selected, exp, topic}]
  phase: 'study',     // 'study' | 'quiz'
  quizIdx: 0,
  quizAnswers: [],
  quizSelected: null,
  quizShowFeedback: false,
  sourceLabel: '',

  _pending: null,
  _pendingLabel: '',

  launchPending() {
    if (this._pending && this._pending.length > 0) {
      this.launch(this._pending, this._pendingLabel);
    }
  },

  launch(wrongResponses, sourceLabel) {
    this.questions = wrongResponses;
    this.phase = 'study';
    this.quizIdx = 0;
    this.quizAnswers = [];
    this.quizSelected = null;
    this.quizShowFeedback = false;
    this.sourceLabel = sourceLabel || 'Exam';
    App.navigate('wrong-study');
  },

  render() {
    const container = document.getElementById('wrongStudyContent');
    if (!container) return;
    if (!this.questions || this.questions.length === 0) {
      container.innerHTML = `<div style="text-align:center;padding:60px 20px;">
        <div style="font-size:3rem;margin-bottom:16px;">🎯</div>
        <h2 style="color:var(--accent);">No Wrong Answers!</h2>
        <p style="color:var(--text-secondary);">You got everything right. Nothing to study.</p>
        <button class="btn btn-primary" onclick="App.navigate('exams')" style="margin-top:20px;">Back to Exams</button>
      </div>`;
      return;
    }
    if (this.phase === 'study') this._renderStudy(container);
    else this._renderQuiz(container);
  },

  _renderStudy(container) {
    const q = this.questions;
    const topicGroups = {};
    q.forEach(r => {
      const tn = TOPICS[r.topic]?.name || r.topic;
      if (!topicGroups[tn]) topicGroups[tn] = [];
      topicGroups[tn].push(r);
    });

    container.innerHTML = `
      <div style="max-width:800px;margin:0 auto;">
        <!-- Header -->
        <div style="background:linear-gradient(135deg,rgba(239,68,68,0.1),rgba(245,158,11,0.08));border:1px solid rgba(239,68,68,0.25);border-radius:16px;padding:24px;margin-bottom:28px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
          <div style="font-size:2.5rem;">📖</div>
          <div style="flex:1;min-width:200px;">
            <h2 style="margin:0;font-size:1.3rem;font-weight:800;">Custom Study Guide</h2>
            <div style="color:var(--text-secondary);font-size:0.88rem;margin-top:4px;">Based on ${q.length} wrong answer${q.length!==1?'s':''} from your ${this.sourceLabel}</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <div style="background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);border-radius:10px;padding:8px 16px;text-align:center;">
              <div style="font-size:1.4rem;font-weight:800;color:#ef4444;">${q.length}</div>
              <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">To Review</div>
            </div>
            <div style="background:rgba(139,92,246,0.12);border:1px solid rgba(139,92,246,0.3);border-radius:10px;padding:8px 16px;text-align:center;">
              <div style="font-size:1.4rem;font-weight:800;color:#8b5cf6;">${Object.keys(topicGroups).length}</div>
              <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Topic${Object.keys(topicGroups).length!==1?'s':''}</div>
            </div>
          </div>
        </div>

        <!-- Topic index pills -->
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:28px;">
          ${Object.keys(topicGroups).map((tn,i) => `
            <a href="#topic-${i}" style="padding:6px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:20px;font-size:0.8rem;font-weight:600;color:var(--text-secondary);text-decoration:none;transition:var(--transition);"
              onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
              onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-secondary)'">
              ${TOPICS[Object.keys(TOPICS).find(k=>TOPICS[k].name===tn)]?.icon||'📌'} ${tn} (${topicGroups[tn].length})
            </a>
          `).join('')}
        </div>

        <!-- Questions by topic -->
        ${Object.entries(topicGroups).map(([tn, qs], gi) => `
          <div id="topic-${gi}" style="margin-bottom:32px;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid rgba(245,158,11,0.2);">
              <span style="font-size:1.3rem;">${TOPICS[Object.keys(TOPICS).find(k=>TOPICS[k].name===tn)]?.icon||'📌'}</span>
              <h3 style="margin:0;font-size:1rem;font-weight:700;">${tn}</h3>
              <span style="background:rgba(239,68,68,0.12);color:#ef4444;font-size:0.75rem;font-weight:700;padding:2px 10px;border-radius:10px;">${qs.length} wrong</span>
            </div>
            ${qs.map((r, qi) => `
              <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:14px;border-left:4px solid rgba(239,68,68,0.5);">
                <!-- Question -->
                <div style="font-weight:600;font-size:0.95rem;color:var(--text-primary);margin-bottom:14px;line-height:1.5;">${r.q}</div>

                <!-- All options with color coding -->
                <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">
                  ${r.opts.map((opt, oi) => {
                    const isCorrect = oi === r.correct;
                    const wasSelected = oi === r.selected;
                    let bg = 'var(--bg-input)', border = 'var(--border)', textCol = 'var(--text-secondary)', prefix = '';
                    if (isCorrect) { bg='rgba(34,197,94,0.1)'; border='rgba(34,197,94,0.4)'; textCol='#22c55e'; prefix='✓ '; }
                    else if (wasSelected) { bg='rgba(239,68,68,0.08)'; border='rgba(239,68,68,0.35)'; textCol='#ef4444'; prefix='✗ '; }
                    return `<div style="padding:10px 14px;background:${bg};border:1px solid ${border};border-radius:8px;font-size:0.88rem;color:${textCol};font-weight:${isCorrect?'600':'400'};">
                      ${prefix}${opt}${wasSelected&&!isCorrect?' <span style="font-size:0.75rem;opacity:0.7;">(your answer)</span>':''}
                    </div>`;
                  }).join('')}
                </div>

                <!-- Explanation -->
                ${r.exp ? `
                  <div style="background:linear-gradient(135deg,rgba(245,158,11,0.07),rgba(245,158,11,0.03));border:1px solid rgba(245,158,11,0.2);border-radius:10px;padding:14px;">
                    <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.8px;color:var(--accent);font-weight:700;margin-bottom:6px;">💡 Why this is correct</div>
                    <div style="font-size:0.88rem;color:var(--text-primary);line-height:1.6;">${r.exp}</div>
                  </div>
                ` : ''}
              </div>
            `).join('')}
          </div>
        `).join('')}

        <!-- CTA to Quiz -->
        <div style="background:linear-gradient(135deg,rgba(245,158,11,0.1),rgba(139,92,246,0.08));border:1px solid rgba(245,158,11,0.25);border-radius:16px;padding:28px;text-align:center;margin-top:32px;">
          <div style="font-size:2rem;margin-bottom:10px;">🎯</div>
          <h3 style="margin:0 0 8px;font-size:1.1rem;font-weight:700;">Ready to test yourself?</h3>
          <p style="color:var(--text-secondary);font-size:0.88rem;margin-bottom:20px;">Take a targeted quiz with only these ${q.length} question${q.length!==1?'s':''} — no distractors, just your weak spots.</p>
          <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
            <button class="btn btn-primary" onclick="WrongAnswerStudy._startQuiz()">⚡ Start Re-Quiz (${q.length} Questions)</button>
            <button class="btn btn-secondary" onclick="App.navigate('exams')">Back to Exams</button>
          </div>
        </div>
      </div>
    `;
  },

  _startQuiz() {
    this.phase = 'quiz';
    this.quizIdx = 0;
    this.quizAnswers = new Array(this.questions.length).fill(null);
    this.quizSelected = null;
    this.quizShowFeedback = false;
    // Shuffle questions for variety
    this.questions = [...this.questions].sort(() => Math.random() - 0.5);
    this.render();
    window.scrollTo(0, 0);
  },

  _renderQuiz(container) {
    const q = this.questions;
    const done = this.quizIdx >= q.length;

    if (done) {
      // Results screen
      let correct = 0;
      q.forEach((r, i) => { if (this.quizAnswers[i] === r.correct) correct++; });
      const pct = Math.round(correct / q.length * 100);
      const allCorrect = correct === q.length;
      if (allCorrect) launchConfetti();

      container.innerHTML = `
        <div style="max-width:640px;margin:0 auto;text-align:center;padding:40px 20px;">
          <div style="font-size:4.5rem;font-weight:900;color:${pct>=80?'var(--success)':'var(--danger)'};">${pct}%</div>
          <div style="font-size:1.3rem;font-weight:700;margin:8px 0;">${allCorrect?'Perfect! All Mastered! 🏆':pct>=80?'Great improvement! 🎉':pct>=50?'Getting there! 💪':'Keep grinding! ⚡'}</div>
          <div style="color:var(--text-secondary);margin-bottom:28px;">${correct}/${q.length} correct on your targeted re-quiz</div>

          ${pct < 100 ? `
            <div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:12px;padding:16px;margin-bottom:24px;">
              <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;color:var(--accent);font-weight:700;margin-bottom:10px;">Still needs work (${q.length-correct})</div>
              ${q.filter((r,i)=>this.quizAnswers[i]!==r.correct).map(r=>`
                <div style="text-align:left;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.85rem;">
                  <div style="color:var(--text-primary);font-weight:500;margin-bottom:3px;">${r.q.length>80?r.q.slice(0,80)+'…':r.q}</div>
                  <div style="color:#22c55e;font-size:0.8rem;">✓ ${r.opts[r.correct]}</div>
                </div>
              `).join('')}
            </div>
          ` : `<div style="font-size:1.1rem;color:var(--success);margin-bottom:24px;">You've mastered all of your weak areas! 🌟</div>`}

          <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
            ${pct < 100 ? `<button class="btn btn-primary" onclick="WrongAnswerStudy._startQuiz()">🔁 Retry Missed Questions</button>` : ''}
            <button class="btn btn-secondary" onclick="WrongAnswerStudy.phase='study';WrongAnswerStudy.render()">📖 Review Study Guide</button>
            <button class="btn btn-secondary" onclick="App.navigate('exams')">Back to Exams</button>
          </div>
        </div>
      `;
      return;
    }

    const current = q[this.quizIdx];
    const sel = this.quizSelected;
    const showFb = this.quizShowFeedback;
    const progress = Math.round((this.quizIdx / q.length) * 100);

    container.innerHTML = `
      <div style="max-width:680px;margin:0 auto;">
        <!-- Progress bar -->
        <div style="margin-bottom:20px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <span style="font-size:0.8rem;color:var(--text-muted);font-weight:600;">Re-Quiz: Wrong Answer Drill</span>
            <span style="font-size:0.8rem;font-weight:700;color:var(--accent);">${this.quizIdx+1} / ${q.length}</span>
          </div>
          <div style="height:6px;background:var(--bg-input);border-radius:3px;overflow:hidden;">
            <div style="height:100%;width:${progress}%;background:var(--accent);border-radius:3px;transition:width 0.4s ease;"></div>
          </div>
        </div>

        <!-- Question card -->
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:24px;margin-bottom:16px;">
          <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.8px;color:var(--accent);font-weight:700;margin-bottom:10px;">${TOPICS[current.topic]?.icon||''} ${TOPICS[current.topic]?.name||current.topic}</div>
          <div style="font-size:1rem;font-weight:600;color:var(--text-primary);line-height:1.6;">${current.q}</div>
        </div>

        <!-- Options -->
        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">
          ${current.opts.map((opt, oi) => {
            let bg = 'var(--bg-card)', border = 'var(--border)', textCol = 'var(--text-primary)', cursor = 'pointer', pointerEvents = 'auto';
            if (showFb) {
              pointerEvents = 'none';
              if (oi === current.correct) { bg='rgba(34,197,94,0.12)'; border='rgba(34,197,94,0.5)'; textCol='#22c55e'; }
              else if (oi === sel) { bg='rgba(239,68,68,0.1)'; border='rgba(239,68,68,0.4)'; textCol='#ef4444'; }
              else { bg='var(--bg-input)'; border='var(--border)'; textCol='var(--text-muted)'; }
            } else if (oi === sel) { bg='rgba(245,158,11,0.1)'; border='var(--accent)'; textCol='var(--text-primary)'; }
            return `<button onclick="WrongAnswerStudy._selectAnswer(${oi})"
              style="width:100%;text-align:left;padding:14px 18px;background:${bg};border:2px solid ${border};border-radius:12px;color:${textCol};font-size:0.93rem;font-weight:500;cursor:${cursor};pointer-events:${pointerEvents};transition:border-color 0.15s,background 0.15s;line-height:1.4;">
              <span style="font-weight:700;margin-right:8px;opacity:0.6;">${String.fromCharCode(65+oi)}.</span>${opt}
              ${showFb && oi===current.correct ? ' <span style="float:right;font-size:1rem;">✅</span>' : ''}
              ${showFb && oi===sel && oi!==current.correct ? ' <span style="float:right;font-size:1rem;">❌</span>' : ''}
            </button>`;
          }).join('')}
        </div>

        <!-- Feedback / explanation -->
        ${showFb ? `
          <div style="background:${sel===current.correct?'rgba(34,197,94,0.08)':'rgba(239,68,68,0.06)'};border:1px solid ${sel===current.correct?'rgba(34,197,94,0.25)':'rgba(239,68,68,0.2)'};border-radius:12px;padding:16px;margin-bottom:20px;">
            <div style="font-weight:700;font-size:0.9rem;color:${sel===current.correct?'#22c55e':'#ef4444'};margin-bottom:${current.exp?'8px':'0'};">
              ${sel===current.correct?'✅ Correct!':'❌ Incorrect — the right answer was: '+current.opts[current.correct]}
            </div>
            ${current.exp ? `<div style="font-size:0.87rem;color:var(--text-secondary);line-height:1.6;">${current.exp}</div>` : ''}
          </div>
          <button class="btn btn-primary" style="width:100%;" onclick="WrongAnswerStudy._next()">
            ${this.quizIdx+1 < q.length ? 'Next Question →' : 'See Results'}
          </button>
        ` : `
          <button class="btn btn-primary" style="width:100%;opacity:${sel===null?'0.45':'1'};pointer-events:${sel===null?'none':'auto'};" onclick="WrongAnswerStudy._confirmAnswer()">
            Confirm Answer
          </button>
        `}
      </div>
    `;
  },

  _selectAnswer(idx) {
    if (this.quizShowFeedback) return;
    this.quizSelected = idx;
    this.render();
  },

  _confirmAnswer() {
    if (this.quizSelected === null) return;
    this.quizAnswers[this.quizIdx] = this.quizSelected;
    this.quizShowFeedback = true;
    this.render();
    window.scrollTo(0, 0);
  },

  _next() {
    this.quizIdx++;
    this.quizSelected = null;
    this.quizShowFeedback = false;
    this.render();
    window.scrollTo(0, 0);
  }
};

// ===== PAGES.JS =====
// ===== STUDY GUIDE MODULE =====
const StudyGuide = {
  currentTopic: null,
  currentLesson: 0,
  quizMode: false,
  lessonProgress: {},
  customMode: false,
  customConfig: null,
  _customIdx: 0,
  _customTopicIdx: 0,
  _customAfterQuiz: false,

  render(state) {
    if (!state) return;
    const container = document.getElementById('sgContent');
    if (!container) return;
    // Custom study guide mode
    if (this.customMode && this.customConfig) { this._renderCustomGuide(); return; }
    if (this.customMode && !this.customConfig) { this.showCustomBuilder(); return; }
    try {
    const topics = getTopicsForPeriod(state.user.period);
    if (!this.currentTopic) this.currentTopic = topics[0]?.id || null;

    // Load lesson progress from state
    this.lessonProgress = (state.studyGuide && state.studyGuide.lessonProgress) ? state.studyGuide.lessonProgress : {};

    // Get student's weak areas and mastery per topic
    const topicData = topics.map(t => {
      const fc = Object.entries(state.flashcards || {}).filter(([id]) => {
        const card = FLASHCARD_BANK.find(f => f.id === id);
        return card && card.topic === t.id;
      });
      const total = fc.length;
      const reviewed = fc.filter(([,c]) => c.lastReview).length;
      const correct = fc.reduce((s,[,c]) => s + (c.correct||0), 0);
      const attempts = fc.reduce((s,[,c]) => s + (c.correct||0) + (c.incorrect||0), 0);
      const mastery = attempts > 0 ? Math.round(correct/attempts*100) : 0;
      const isWeak = state.diagnostic.weakAreas?.includes(t.id);
      const lessonsComplete = this.lessonProgress[t.id]?.completed || 0;
      const totalLessons = (STUDY_CONTENT[t.id]?.sections || []).length;
      return { ...t, mastery, reviewed, total, isWeak, lessonsComplete, totalLessons, attempts };
    });

    // Sort: weak areas first, then by lowest mastery
    const sorted = [...topicData].sort((a,b) => {
      if (a.isWeak && !b.isWeak) return -1;
      if (!a.isWeak && b.isWeak) return 1;
      return a.mastery - b.mastery;
    });

    const current = topicData.find(t => t.id === this.currentTopic);
    const content = STUDY_CONTENT[this.currentTopic];

    // Determine recommended next topic
    const recommended = sorted.find(t => t.lessonsComplete < t.totalLessons) || sorted[0];

    // Build module data for sidebar (grouped by section)
    const sectionGroups = getModulesBySection().map(sec => ({
      ...sec,
      modules: sec.modules.map(m => {
        const mTopics = m.topics.map(tid => topicData.find(t => t.id === tid)).filter(Boolean);
        const avgMastery = mTopics.length > 0 ? Math.round(mTopics.reduce((s,t) => s + t.mastery, 0) / mTopics.length) : 0;
        return { ...m, mastery: avgMastery, mTopics };
      })
    }));
    const sgView = this._sidebarView || 'modules';
    const collapsedSections = this._collapsedSections || {};

    container.innerHTML = `
      <div class="sg-layout">
        <div class="sg-sidebar">
          <div style="margin-bottom:16px;padding:12px;background:linear-gradient(135deg,rgba(245,158,11,0.08),rgba(139,92,246,0.08));border-radius:10px;border:1px solid rgba(245,158,11,0.15);">
            <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:6px;">Your Learning Path</div>
            <div style="font-size:0.85rem;color:var(--text-primary);font-weight:600;">
              ${state.diagnostic.weakAreas?.length > 0 ? 'Focus: ' + state.diagnostic.weakAreas.slice(0,2).map(id => TOPICS[id]?.name || id).join(', ') : 'All topics available'}
            </div>
            <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px;">
              ${sorted.filter(t => t.mastery >= 70).length}/${topics.length} topics mastered
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" style="width:100%;margin-bottom:12px;" onclick="StudyGuide.customMode=true;StudyGuide.customConfig=null;StudyGuide.render(Storage.get())">&#x1F4CB; Custom Study Guide</button>
          ${recommended && recommended.id !== this.currentTopic ? `
            <div onclick="StudyGuide.selectTopic('${recommended.id}')" style="cursor:pointer;margin-bottom:12px;padding:10px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:8px;">
              <div style="font-size:0.65rem;text-transform:uppercase;color:#22c55e;font-weight:700;letter-spacing:0.5px;">Recommended Next</div>
              <div style="font-size:0.85rem;font-weight:600;margin-top:2px;">${recommended.icon} ${recommended.name}</div>
              <div style="font-size:0.7rem;color:var(--text-muted);">${recommended.isWeak ? 'Weak area' : 'Low mastery'} &middot; ${recommended.mastery}%</div>
            </div>
          ` : ''}
          <!-- View toggle -->
          <div style="display:flex;gap:2px;margin-bottom:10px;background:var(--bg-input);border-radius:var(--radius-sm);padding:2px;">
            <button onclick="StudyGuide._sidebarView='modules';StudyGuide.render(Storage.get())" style="flex:1;padding:6px 8px;border:none;border-radius:6px;font-size:0.75rem;font-weight:600;cursor:pointer;transition:var(--transition);background:${sgView === 'modules' ? 'var(--accent)' : 'transparent'};color:${sgView === 'modules' ? '#000' : 'var(--text-muted)'};">Modules</button>
            <button onclick="StudyGuide._sidebarView='topics';StudyGuide.render(Storage.get())" style="flex:1;padding:6px 8px;border:none;border-radius:6px;font-size:0.75rem;font-weight:600;cursor:pointer;transition:var(--transition);background:${sgView === 'topics' ? 'var(--accent)' : 'transparent'};color:${sgView === 'topics' ? '#000' : 'var(--text-muted)'};">Topics</button>
          </div>
          ${sgView === 'modules' ? `
            <div class="sg-module-sections">
              ${sectionGroups.map(sec => {
                const isCollapsed = collapsedSections[sec.id];
                const availCount = sec.modules.filter(m => m.hasContent).length;
                return `
                <div style="margin-bottom:8px;">
                  <div onclick="StudyGuide._collapsedSections=StudyGuide._collapsedSections||{};StudyGuide._collapsedSections['${sec.id}']=!StudyGuide._collapsedSections['${sec.id}'];StudyGuide.render(Storage.get())" style="display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;border-radius:6px;background:rgba(${sec.color === '#f59e0b' ? '245,158,11' : sec.color === '#d97706' ? '217,119,6' : sec.color === '#8b5cf6' ? '139,92,246' : sec.color === '#7c3aed' ? '124,58,237' : sec.color === '#3b82f6' ? '59,130,246' : sec.color === '#2563eb' ? '37,99,235' : sec.color === '#ef4444' ? '239,68,68' : '220,38,38'},0.1);border-left:3px solid ${sec.color};">
                    <span style="font-size:0.7rem;transition:transform 0.2s;display:inline-block;transform:rotate(${isCollapsed ? '0' : '90'}deg);">&#x25B6;</span>
                    <span style="font-size:0.72rem;font-weight:700;color:${sec.color};flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${sec.name}</span>
                    <span style="font-size:0.6rem;color:var(--text-muted);background:var(--bg-input);padding:1px 6px;border-radius:10px;">${availCount}/${sec.modules.length}</span>
                  </div>
                  ${!isCollapsed ? `<ul class="sg-nav-list" style="margin:2px 0 0 6px;border-left:1px solid rgba(255,255,255,0.05);padding-left:6px;">
                    ${sec.modules.map(m => {
                      const color = !m.hasContent ? '#ef4444' : m.mastery >= 70 ? '#22c55e' : m.mastery >= 40 ? '#f59e0b' : m.mastery > 0 ? '#ef4444' : 'var(--text-muted)';
                      const isActive = m.topics.includes(this.currentTopic);
                      return `
                        <li class="sg-nav-item ${isActive ? 'active' : ''}" ${m.hasContent ? `onclick="StudyGuide.selectTopic('${m.topics[0]}')"` : ''} style="padding:5px 6px;${!m.hasContent ? 'opacity:0.4;cursor:default;' : ''}">
                          <div style="display:flex;align-items:center;gap:6px;width:100%;">
                            <span style="font-size:0.6rem;font-weight:700;color:var(--text-muted);min-width:18px;">${m.num}</span>
                            <div style="flex:1;min-width:0;">
                              <div style="font-size:0.75rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${m.name}</div>
                              ${m.hasContent ? `<div style="height:2px;background:var(--bg-input);border-radius:1px;margin-top:2px;overflow:hidden;"><div style="height:100%;width:${m.mastery}%;background:${color};border-radius:1px;"></div></div>` : '<span style="font-size:0.55rem;color:#ef4444;font-weight:700;">COMING SOON</span>'}
                            </div>
                            ${m.hasContent ? `<span style="font-size:0.6rem;font-weight:700;color:${color};">${m.mastery}%</span>` : ''}
                          </div>
                        </li>`;
                    }).join('')}
                  </ul>` : ''}
                </div>`;
              }).join('')}
            </div>
          ` : `
            <ul class="sg-nav-list">
              ${topicData.map(t => {
                const pct = t.totalLessons > 0 ? Math.round(t.lessonsComplete / t.totalLessons * 100) : 0;
                const color = t.mastery >= 70 ? '#22c55e' : t.mastery >= 40 ? '#f59e0b' : t.mastery > 0 ? '#ef4444' : 'var(--text-muted)';
                return `
                  <li class="sg-nav-item ${t.id === this.currentTopic ? 'active' : ''}" onclick="StudyGuide.selectTopic('${t.id}')" style="position:relative;">
                    <div style="display:flex;align-items:center;gap:8px;width:100%;">
                      <span>${t.icon}</span>
                      <div style="flex:1;min-width:0;">
                        <div style="font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${t.name}</div>
                        <div style="height:3px;background:var(--bg-input);border-radius:2px;margin-top:3px;overflow:hidden;">
                          <div style="height:100%;width:${pct}%;background:${color};border-radius:2px;transition:width 0.3s;"></div>
                        </div>
                      </div>
                      <span style="font-size:0.7rem;font-weight:700;color:${color};min-width:28px;text-align:right;">${t.mastery}%</span>
                    </div>
                    ${t.isWeak ? '<div style="position:absolute;top:4px;right:4px;width:6px;height:6px;border-radius:50%;background:#ef4444;" title="Weak area"></div>' : ''}
                  </li>`;
              }).join('')}
            </ul>
          `}
        </div>
        <div class="sg-content">
          ${content ? this._renderLesson(content, current, state) : `
            <div class="empty-state">
              <h3>Content Coming Soon</h3>
              <p>Study guide content for this topic is being developed.</p>
            </div>
          `}
        </div>
      </div>
    `;
    } catch(err) {
      console.error('StudyGuide render error:', err);
      container.innerHTML = '<div style="padding:40px;color:#ef4444;"><h3>Study Guide Error</h3><pre style="white-space:pre-wrap;color:#f59e0b;">' + err.message + '\n' + (err.stack || '') + '</pre></div>';
    }
  },

  _renderLesson(content, topicData, state) {
    try {
    const sections = content.sections || [];
    const progress = this.lessonProgress[this.currentTopic] || { completed: 0, quizScores: {} };
    const currentIdx = Math.min(this.currentLesson, sections.length - 1);
    const section = sections[currentIdx];
    const isComplete = currentIdx < progress.completed;
    const totalSections = sections.length;

    // Adaptive messaging based on student performance
    let adaptiveMsg = '';
    if (topicData) {
      if (topicData.isWeak && topicData.mastery < 30) {
        adaptiveMsg = '<div style="padding:12px 16px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px;margin-bottom:20px;font-size:0.85rem;"><strong style="color:#ef4444;">Focus Area</strong> &mdash; Your diagnostic showed this as a weak area. Take your time with each section and use the practice problems to build confidence.</div>';
      } else if (topicData.mastery >= 70) {
        adaptiveMsg = '<div style="padding:12px 16px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:8px;margin-bottom:20px;font-size:0.85rem;"><strong style="color:#22c55e;">Strong Topic</strong> &mdash; You\'re doing great here at ' + topicData.mastery + '% mastery! Review to keep it sharp, or move on to topics that need more work.</div>';
      } else if (topicData.attempts > 20 && topicData.mastery < 50) {
        adaptiveMsg = '<div style="padding:12px 16px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:8px;margin-bottom:20px;font-size:0.85rem;"><strong style="color:#f59e0b;">Keep Pushing</strong> &mdash; You\'ve been studying this topic but it hasn\'t clicked yet. Try reading through the lesson slowly and really focus on the formulas and key points.</div>';
      }
    }

    // Build lesson navigation dots
    const dots = sections.map((s, i) => {
      const done = i < progress.completed;
      const active = i === currentIdx;
      const bg = active ? 'var(--accent)' : done ? '#22c55e' : 'var(--bg-input)';
      const border = active ? '2px solid var(--accent)' : done ? '2px solid #22c55e' : '2px solid var(--border)';
      return `<div onclick="StudyGuide.goToSection(${i})" style="width:${active ? 28 : 12}px;height:12px;border-radius:6px;background:${bg};border:${border};cursor:pointer;transition:all 0.2s;" title="${s.heading}"></div>`;
    }).join('');

    // Build the current section content with rich formatting
    let sectionHTML = '';
    if (section) {
      sectionHTML = `
        <div style="margin-bottom:24px;">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
            <div style="width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,var(--accent),#d97706);display:flex;align-items:center;justify-content:center;color:#000;font-weight:800;font-size:0.9rem;">${currentIdx + 1}</div>
            <div>
              <h3 style="margin:0;font-size:1.15rem;">${section.heading}</h3>
              <div style="font-size:0.75rem;color:var(--text-muted);">Section ${currentIdx + 1} of ${totalSections}${isComplete ? ' &middot; <span style="color:#22c55e;">Completed</span>' : ''}</div>
            </div>
          </div>

          ${section.isFormula ? `
            <div style="background:linear-gradient(135deg,rgba(139,92,246,0.08),rgba(59,130,246,0.08));border:1px solid rgba(139,92,246,0.2);border-radius:12px;padding:20px;margin-bottom:16px;">
              <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:#8b5cf6;margin-bottom:10px;font-weight:700;">Key Formulas</div>
              <pre style="font-family:'Fira Code',monospace;font-size:1rem;line-height:1.8;color:var(--text-primary);margin:0;white-space:pre-wrap;">${section.formula}</pre>
            </div>
          ` : ''}

          ${section.isKeyPoint ? `
            <div style="background:rgba(245,158,11,0.06);border-left:4px solid var(--accent);border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:16px;">
              <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin-bottom:6px;font-weight:700;">Key Point</div>
              <div style="font-size:0.95rem;line-height:1.7;color:var(--text-primary);">${section.content}</div>
            </div>
          ` : ''}

          ${!section.isFormula && !section.isKeyPoint && section.content ? `
            <div style="font-size:0.95rem;line-height:1.8;color:var(--text-secondary);margin-bottom:16px;">${section.content}</div>
          ` : ''}

          ${section.content && section.isFormula ? `
            <div style="font-size:0.95rem;line-height:1.8;color:var(--text-secondary);margin-bottom:16px;">${section.content}</div>
          ` : ''}

          ${this._getInteractiveContent(this.currentTopic, currentIdx)}
        </div>
      `;
    }

    // Quick quiz for this section
    const quizHTML = this._getSectionQuiz(this.currentTopic, currentIdx);

    return `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
        <div>
          <h2 style="margin:0;font-size:1.4rem;">${content.title}</h2>
          <div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px;">
            ${topicData ? `Mastery: <strong style="color:${topicData.mastery >= 70 ? '#22c55e' : topicData.mastery >= 40 ? '#f59e0b' : '#ef4444'};">${topicData.mastery}%</strong> &middot; ` : ''}
            ${progress.completed}/${totalSections} sections complete
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-secondary btn-sm" onclick="StudyGuide.startTopicQuiz('${this.currentTopic}')">&#x1F4DD; Topic Quiz</button>
          <button class="btn btn-primary btn-sm" onclick="Flashcards.startTopic('${this.currentTopic}')">&#x1F4DA; Flashcards</button>
        </div>
      </div>

      ${adaptiveMsg}

      <div style="display:flex;align-items:center;gap:6px;margin-bottom:24px;padding:12px 0;">
        ${dots}
      </div>

      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:20px;">
        ${sectionHTML}
      </div>

      ${quizHTML}

      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:20px;">
        <button class="btn btn-ghost" onclick="StudyGuide.prevSection()" ${currentIdx === 0 ? 'disabled style="opacity:0.3;"' : ''}>
          &#x2190; Previous
        </button>
        <span style="font-size:0.85rem;color:var(--text-muted);">${currentIdx + 1} / ${totalSections}</span>
        ${currentIdx < totalSections - 1 ? `
          <button class="btn btn-primary" onclick="StudyGuide.nextSection()">
            Next Section &#x2192;
          </button>
        ` : `
          <button class="btn btn-primary" onclick="StudyGuide.completeAndNext()">
            &#x2705; Complete Topic
          </button>
        `}
      </div>
    `;
    } catch(err) {
      console.error('StudyGuide _renderLesson error:', err);
      return '<div style="padding:20px;color:#ef4444;"><strong>Lesson Render Error:</strong><pre style="white-space:pre-wrap;color:#f59e0b;">' + err.message + '</pre></div>';
    }
  },

  _getInteractiveContent(topicId, sectionIdx) {
    // Interactive visual aids for specific topics
    const visuals = {
      'ohms-law': {
        0: `<div style="background:var(--bg-input);border-radius:10px;padding:20px;margin-top:16px;">
              <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin-bottom:12px;font-weight:700;">&#x26A1; Interactive: Ohm's Law Calculator</div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
                <div><label style="font-size:0.75rem;color:var(--text-muted);display:block;margin-bottom:4px;">Voltage (V)</label><input type="number" id="ohmV" placeholder="?" style="width:100%;padding:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:1rem;" oninput="StudyGuide.calcOhm()"></div>
                <div><label style="font-size:0.75rem;color:var(--text-muted);display:block;margin-bottom:4px;">Current (A)</label><input type="number" id="ohmI" placeholder="?" style="width:100%;padding:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:1rem;" oninput="StudyGuide.calcOhm()"></div>
                <div><label style="font-size:0.75rem;color:var(--text-muted);display:block;margin-bottom:4px;">Resistance (&#x2126;)</label><input type="number" id="ohmR" placeholder="?" style="width:100%;padding:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:1rem;" oninput="StudyGuide.calcOhm()"></div>
              </div>
              <div id="ohmResult" style="margin-top:12px;padding:12px;background:var(--bg-card);border-radius:6px;font-size:0.9rem;color:var(--text-secondary);text-align:center;">Enter any two values to calculate the third</div>
              <div style="margin-top:8px;text-align:center;"><button class="btn btn-ghost btn-sm" onclick="document.getElementById('ohmV').value='';document.getElementById('ohmI').value='';document.getElementById('ohmR').value='';document.getElementById('ohmResult').innerHTML='Enter any two values to calculate the third';">Clear</button></div>
            </div>`,
        1: `<div style="background:var(--bg-input);border-radius:10px;padding:20px;margin-top:16px;">
              <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin-bottom:12px;font-weight:700;">&#x26A1; Interactive: Power Calculator</div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;">
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">V</label><input type="number" id="pwrV" placeholder="?" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" oninput="StudyGuide.calcPower()"></div>
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">I (A)</label><input type="number" id="pwrI" placeholder="?" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" oninput="StudyGuide.calcPower()"></div>
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">R (&#x2126;)</label><input type="number" id="pwrR" placeholder="?" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" oninput="StudyGuide.calcPower()"></div>
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">P (W)</label><input type="number" id="pwrP" placeholder="?" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" oninput="StudyGuide.calcPower()"></div>
              </div>
              <div id="pwrResult" style="margin-top:10px;padding:10px;background:var(--bg-card);border-radius:6px;font-size:0.85rem;color:var(--text-secondary);text-align:center;">Enter any two values</div>
            </div>`
      },
      'series-circuits': {
        2: `<div style="background:var(--bg-input);border-radius:10px;padding:20px;margin-top:16px;">
              <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin-bottom:12px;font-weight:700;">&#x26A1; Interactive: Series Circuit Calculator</div>
              <div style="margin-bottom:12px;"><label style="font-size:0.75rem;color:var(--text-muted);">Source Voltage (V):</label><input type="number" id="seriesV" value="120" style="width:80px;padding:6px;margin-left:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);"></div>
              <div style="margin-bottom:8px;"><label style="font-size:0.75rem;color:var(--text-muted);">Resistances (comma-separated &#x2126;):</label><input type="text" id="seriesR" value="100,200,300" style="width:200px;padding:6px;margin-left:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);"></div>
              <button class="btn btn-secondary btn-sm" onclick="StudyGuide.calcSeries()">Calculate</button>
              <div id="seriesResult" style="margin-top:12px;padding:12px;background:var(--bg-card);border-radius:6px;font-size:0.85rem;"></div>
            </div>`
      },
      'parallel-circuits': {
        2: `<div style="background:var(--bg-input);border-radius:10px;padding:20px;margin-top:16px;">
              <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin-bottom:12px;font-weight:700;">&#x26A1; Interactive: Parallel Circuit Calculator</div>
              <div style="margin-bottom:12px;"><label style="font-size:0.75rem;color:var(--text-muted);">Source Voltage (V):</label><input type="number" id="parallelV" value="120" style="width:80px;padding:6px;margin-left:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);"></div>
              <div style="margin-bottom:8px;"><label style="font-size:0.75rem;color:var(--text-muted);">Resistances (comma-separated &#x2126;):</label><input type="text" id="parallelR" value="100,200,300" style="width:200px;padding:6px;margin-left:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);"></div>
              <button class="btn btn-secondary btn-sm" onclick="StudyGuide.calcParallel()">Calculate</button>
              <div id="parallelResult" style="margin-top:12px;padding:12px;background:var(--bg-card);border-radius:6px;font-size:0.85rem;"></div>
            </div>`
      },
      'ac-theory': {
        1: `<div style="background:var(--bg-input);border-radius:10px;padding:20px;margin-top:16px;">
              <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin-bottom:12px;font-weight:700;">&#x26A1; Interactive: AC Value Converter</div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Vpeak</label><input type="number" id="acPeak" placeholder="?" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" oninput="StudyGuide.calcAC('peak')"></div>
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Vrms</label><input type="number" id="acRms" placeholder="?" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" oninput="StudyGuide.calcAC('rms')"></div>
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Vavg</label><input type="number" id="acAvg" placeholder="?" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" oninput="StudyGuide.calcAC('avg')"></div>
              </div>
              <div style="margin-top:8px;font-size:0.8rem;color:var(--text-muted);text-align:center;">Enter any value to see all conversions</div>
            </div>`
      },
      'transformers': {
        1: `<div style="background:var(--bg-input);border-radius:10px;padding:20px;margin-top:16px;">
              <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin-bottom:12px;font-weight:700;">&#x26A1; Interactive: Transformer Calculator</div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;">
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Vp</label><input type="number" id="txVp" value="480" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" oninput="StudyGuide.calcTransformer()"></div>
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Vs</label><input type="number" id="txVs" value="120" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" oninput="StudyGuide.calcTransformer()"></div>
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Np</label><input type="number" id="txNp" placeholder="?" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);"></div>
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Ns</label><input type="number" id="txNs" placeholder="?" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);"></div>
              </div>
              <div id="txResult" style="margin-top:10px;padding:10px;background:var(--bg-card);border-radius:6px;font-size:0.85rem;color:var(--text-secondary);text-align:center;">Turns ratio: 4:1 (Step-down)</div>
            </div>`
      },
      'motors': {
        1: `<div style="background:var(--bg-input);border-radius:10px;padding:20px;margin-top:16px;">
              <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin-bottom:12px;font-weight:700;">&#x26A1; Interactive: Motor Speed Calculator</div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Frequency (Hz)</label><input type="number" id="motorF" value="60" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" oninput="StudyGuide.calcMotor()"></div>
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Poles</label><input type="number" id="motorP" value="4" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" oninput="StudyGuide.calcMotor()"></div>
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Actual RPM</label><input type="number" id="motorRPM" value="1750" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" oninput="StudyGuide.calcMotor()"></div>
              </div>
              <div id="motorResult" style="margin-top:10px;padding:10px;background:var(--bg-card);border-radius:6px;font-size:0.85rem;color:var(--text-secondary);text-align:center;"></div>
            </div>`
      },
      'power-factor': {
        1: `<div style="background:var(--bg-input);border-radius:10px;padding:20px;margin-top:16px;">
              <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin-bottom:12px;font-weight:700;">&#x26A1; Interactive: Power Triangle Calculator</div>
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;">
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">True (W)</label><input type="number" id="pfW" value="8000" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" oninput="StudyGuide.calcPF()"></div>
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Reactive (VAR)</label><input type="number" id="pfVAR" value="6000" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" oninput="StudyGuide.calcPF()"></div>
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Apparent (VA)</label><input type="number" id="pfVA" placeholder="?" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" disabled></div>
                <div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">PF</label><input type="text" id="pfPF" placeholder="?" style="width:100%;padding:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);" disabled></div>
              </div>
              <div id="pfResult" style="margin-top:10px;padding:10px;background:var(--bg-card);border-radius:6px;font-size:0.85rem;color:var(--text-secondary);text-align:center;"></div>
            </div>`
      }
    };
    return visuals[topicId]?.[sectionIdx] || '';
  },

  _getSectionQuiz(topicId, sectionIdx) {
    // Find exam questions related to this topic for inline quizzes
    const topicExams = EXAM_BANK.filter(q => q.topic === topicId);
    if (topicExams.length === 0) return '';
    const shuffled = [...topicExams].sort(() => Math.random() - 0.5);
    const q = shuffled[0];
    if (!q) return '';
    return `
      <div style="background:rgba(59,130,246,0.05);border:1px solid rgba(59,130,246,0.15);border-radius:12px;padding:20px;margin-top:20px;">
        <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:#3b82f6;font-weight:700;margin-bottom:10px;">&#x1F4A1; Quick Check</div>
        <div style="font-size:0.95rem;margin-bottom:14px;line-height:1.6;" id="sgQuizQ">${q.q}</div>
        <div id="sgQuizOptions">
          ${q.opts.map((opt, i) => `
            <div onclick="StudyGuide.answerQuiz('${q.id}',${i},${q.correct})" style="padding:10px 14px;margin-bottom:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:0.9rem;transition:all 0.2s;" onmouseover="this.style.borderColor='#3b82f6'" onmouseout="this.style.borderColor='var(--border)'">${opt}</div>
          `).join('')}
        </div>
        <div id="sgQuizFeedback" style="display:none;margin-top:10px;padding:12px;border-radius:8px;font-size:0.9rem;"></div>
      </div>
    `;
  },

  // Calculator functions
  calcOhm() {
    const v = parseFloat(document.getElementById('ohmV').value);
    const i = parseFloat(document.getElementById('ohmI').value);
    const r = parseFloat(document.getElementById('ohmR').value);
    const el = document.getElementById('ohmResult');
    let results = [];
    if (!isNaN(v) && !isNaN(i) && isNaN(r)) results.push('R = ' + (v/i).toFixed(2) + ' &#x2126;');
    if (!isNaN(v) && isNaN(i) && !isNaN(r)) results.push('I = ' + (v/r).toFixed(4) + ' A (' + (v/r*1000).toFixed(1) + ' mA)');
    if (isNaN(v) && !isNaN(i) && !isNaN(r)) results.push('V = ' + (i*r).toFixed(2) + ' V');
    if (!isNaN(v) && !isNaN(i)) results.push('P = ' + (v*i).toFixed(2) + ' W');
    if (!isNaN(v) && !isNaN(r)) results.push('P = ' + (v*v/r).toFixed(2) + ' W');
    if (!isNaN(i) && !isNaN(r)) results.push('P = ' + (i*i*r).toFixed(2) + ' W');
    el.innerHTML = results.length > 0 ? '<strong style="color:var(--accent);">' + results.join(' &nbsp;|&nbsp; ') + '</strong>' : 'Enter any two values to calculate the third';
  },

  calcPower() {
    const v = parseFloat(document.getElementById('pwrV').value);
    const i = parseFloat(document.getElementById('pwrI').value);
    const r = parseFloat(document.getElementById('pwrR').value);
    const p = parseFloat(document.getElementById('pwrP').value);
    const el = document.getElementById('pwrResult');
    let results = [];
    if (!isNaN(v) && !isNaN(i)) results.push('P = ' + (v*i).toFixed(2) + ' W');
    if (!isNaN(i) && !isNaN(r)) results.push('P = I&#xB2;R = ' + (i*i*r).toFixed(2) + ' W');
    if (!isNaN(v) && !isNaN(r)) results.push('P = V&#xB2;/R = ' + (v*v/r).toFixed(2) + ' W');
    if (!isNaN(p) && !isNaN(v)) results.push('I = ' + (p/v).toFixed(4) + ' A');
    if (!isNaN(p) && !isNaN(i)) results.push('V = ' + (p/i).toFixed(2) + ' V');
    el.innerHTML = results.length > 0 ? '<strong style="color:var(--accent);">' + results.join(' &nbsp;|&nbsp; ') + '</strong>' : 'Enter any two values';
  },

  calcSeries() {
    const v = parseFloat(document.getElementById('seriesV').value);
    const rs = document.getElementById('seriesR').value.split(',').map(x => parseFloat(x.trim())).filter(x => !isNaN(x));
    if (!v || rs.length === 0) return;
    const rt = rs.reduce((s,r) => s+r, 0);
    const it = v / rt;
    const drops = rs.map(r => (it * r).toFixed(2));
    document.getElementById('seriesResult').innerHTML = '<strong style="color:var(--accent);">Rt = ' + rt.toFixed(1) + ' &#x2126; &nbsp;|&nbsp; It = ' + (it*1000).toFixed(1) + ' mA</strong><br>' +
      rs.map((r,i) => '<span style="color:var(--text-secondary);">R' + (i+1) + ' = ' + r + '&#x2126; &#x2192; V' + (i+1) + ' = ' + drops[i] + 'V</span>').join('<br>') +
      '<br><span style="color:var(--text-muted);font-size:0.8rem;">Sum of drops: ' + drops.reduce((s,d) => s+parseFloat(d), 0).toFixed(2) + 'V = Source ' + v + 'V &#x2705;</span>';
  },

  calcParallel() {
    const v = parseFloat(document.getElementById('parallelV').value);
    const rs = document.getElementById('parallelR').value.split(',').map(x => parseFloat(x.trim())).filter(x => !isNaN(x));
    if (!v || rs.length === 0) return;
    const rt = 1 / rs.reduce((s,r) => s + 1/r, 0);
    const it = v / rt;
    const branches = rs.map(r => (v / r));
    document.getElementById('parallelResult').innerHTML = '<strong style="color:var(--accent);">Rt = ' + rt.toFixed(2) + ' &#x2126; &nbsp;|&nbsp; It = ' + it.toFixed(3) + ' A</strong><br>' +
      rs.map((r,i) => '<span style="color:var(--text-secondary);">R' + (i+1) + ' = ' + r + '&#x2126; &#x2192; I' + (i+1) + ' = ' + branches[i].toFixed(3) + 'A</span>').join('<br>') +
      '<br><span style="color:var(--text-muted);font-size:0.8rem;">Sum of currents: ' + branches.reduce((s,b) => s+b, 0).toFixed(3) + 'A = It &#x2705;</span>';
  },

  calcAC(from) {
    let peak, rms, avg;
    if (from === 'peak') {
      peak = parseFloat(document.getElementById('acPeak').value);
      if (isNaN(peak)) return;
      rms = peak * 0.707; avg = peak * 0.637;
      document.getElementById('acRms').value = rms.toFixed(1);
      document.getElementById('acAvg').value = avg.toFixed(1);
    } else if (from === 'rms') {
      rms = parseFloat(document.getElementById('acRms').value);
      if (isNaN(rms)) return;
      peak = rms * 1.414; avg = peak * 0.637;
      document.getElementById('acPeak').value = peak.toFixed(1);
      document.getElementById('acAvg').value = avg.toFixed(1);
    } else {
      avg = parseFloat(document.getElementById('acAvg').value);
      if (isNaN(avg)) return;
      peak = avg / 0.637; rms = peak * 0.707;
      document.getElementById('acPeak').value = peak.toFixed(1);
      document.getElementById('acRms').value = rms.toFixed(1);
    }
  },

  calcTransformer() {
    const vp = parseFloat(document.getElementById('txVp').value);
    const vs = parseFloat(document.getElementById('txVs').value);
    if (isNaN(vp) || isNaN(vs) || vs === 0) return;
    const ratio = vp / vs;
    const type = ratio > 1 ? 'Step-down' : ratio < 1 ? 'Step-up' : 'Isolation';
    document.getElementById('txResult').innerHTML = '<strong style="color:var(--accent);">Turns ratio: ' + ratio.toFixed(2) + ':1 (' + type + ')</strong><br><span style="color:var(--text-muted);font-size:0.8rem;">If Ip = 10A, then Is = ' + (10 * ratio).toFixed(1) + 'A</span>';
  },

  calcMotor() {
    const f = parseFloat(document.getElementById('motorF').value);
    const p = parseFloat(document.getElementById('motorP').value);
    const rpm = parseFloat(document.getElementById('motorRPM').value);
    if (isNaN(f) || isNaN(p) || p === 0) return;
    const ns = 120 * f / p;
    const slip = !isNaN(rpm) ? ((ns - rpm) / ns * 100) : 0;
    document.getElementById('motorResult').innerHTML = '<strong style="color:var(--accent);">Sync Speed: ' + ns + ' RPM</strong>' +
      (!isNaN(rpm) ? ' &nbsp;|&nbsp; <strong>Slip: ' + slip.toFixed(1) + '%</strong>' : '') +
      '<br><span style="color:var(--text-muted);font-size:0.8rem;">Common: 2-pole=' + (120*f/2) + ', 4-pole=' + (120*f/4) + ', 6-pole=' + (120*f/6) + ', 8-pole=' + (120*f/8) + ' RPM</span>';
  },

  calcPF() {
    const w = parseFloat(document.getElementById('pfW').value);
    const var_ = parseFloat(document.getElementById('pfVAR').value);
    if (isNaN(w) || isNaN(var_)) return;
    const va = Math.sqrt(w*w + var_*var_);
    const pf = w / va;
    const angle = Math.acos(pf) * 180 / Math.PI;
    document.getElementById('pfVA').value = va.toFixed(0);
    document.getElementById('pfPF').value = pf.toFixed(3);
    document.getElementById('pfResult').innerHTML = '<strong style="color:var(--accent);">VA = ' + va.toFixed(0) + ' &nbsp;|&nbsp; PF = ' + pf.toFixed(3) + ' (' + (pf*100).toFixed(1) + '%) &nbsp;|&nbsp; Angle = ' + angle.toFixed(1) + '&#xB0;</strong>';
  },

  // Navigation & progress
  goToSection(idx) {
    this.currentLesson = idx;
    const state = Storage.get();
    this.render(state);
  },

  nextSection() {
    this.markSectionComplete();
    this.currentLesson++;
    const state = Storage.get();
    this.render(state);
  },

  prevSection() {
    if (this.currentLesson > 0) {
      this.currentLesson--;
      const state = Storage.get();
      this.render(state);
    }
  },

  markSectionComplete() {
    const state = Storage.get();
    if (!state) return;
    if (!state.studyGuide) state.studyGuide = { lessonProgress: {} };
    if (!state.studyGuide.lessonProgress) state.studyGuide.lessonProgress = {};
    if (!state.studyGuide.lessonProgress[this.currentTopic]) {
      state.studyGuide.lessonProgress[this.currentTopic] = { completed: 0, quizScores: {} };
    }
    const prog = state.studyGuide.lessonProgress[this.currentTopic];
    if (this.currentLesson >= prog.completed) {
      prog.completed = this.currentLesson + 1;
    }
    Storage.set(state);
    this.lessonProgress = state.studyGuide.lessonProgress;
    // Track
    SiteAnalytics.track('lesson_complete', { topic: this.currentTopic, section: this.currentLesson });
  },

  completeAndNext() {
    this.markSectionComplete();
    const state = Storage.get();
    const topics = getTopicsForPeriod(state.user.period);
    // Find next incomplete topic
    const currentIdx = topics.findIndex(t => t.id === this.currentTopic);
    for (let i = 1; i <= topics.length; i++) {
      const next = topics[(currentIdx + i) % topics.length];
      const prog = this.lessonProgress[next.id];
      const total = (STUDY_CONTENT[next.id]?.sections || []).length;
      if (!prog || prog.completed < total) {
        this.currentTopic = next.id;
        this.currentLesson = 0;
        break;
      }
    }
    showToast('Topic complete! Moving to next.', 'success');
    this.render(state);
  },

  answerQuiz(qId, selected, correct) {
    const opts = document.getElementById('sgQuizOptions');
    const fb = document.getElementById('sgQuizFeedback');
    const isCorrect = selected === correct;
    const children = opts.children;
    for (let i = 0; i < children.length; i++) {
      children[i].style.pointerEvents = 'none';
      if (i === correct) {
        children[i].style.background = 'rgba(34,197,94,0.15)';
        children[i].style.borderColor = '#22c55e';
        children[i].style.color = '#22c55e';
      } else if (i === selected && !isCorrect) {
        children[i].style.background = 'rgba(239,68,68,0.15)';
        children[i].style.borderColor = '#ef4444';
        children[i].style.color = '#ef4444';
      }
    }
    fb.style.display = 'block';
    fb.style.background = isCorrect ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)';
    fb.style.border = isCorrect ? '1px solid rgba(34,197,94,0.3)' : '1px solid rgba(239,68,68,0.3)';
    fb.innerHTML = isCorrect ? '<strong style="color:#22c55e;">&#x2705; Correct!</strong> Great work.' : '<strong style="color:#ef4444;">&#x274C; Not quite.</strong> Review the section above and try to understand why option ' + (correct+1) + ' is correct.';
    // Save to state for Review tracking
    const state = Storage.get();
    if (state) {
      const examQ = EXAM_BANK.find(e => e.id === qId);
      if (examQ) {
        // Save as a mini-attempt so Review can find missed questions
        if (!state.exams.attempts) state.exams.attempts = [];
        const existing = state.exams.attempts.find(a => a.id === 'sg_quick_checks');
        if (existing) {
          // Remove old response for same question if exists, add new
          existing.responses = existing.responses.filter(r => r.qId !== qId);
          existing.responses.push({ qId, topic: examQ.topic, selected, correct: examQ.correct, isCorrect, q: examQ.q, opts: examQ.opts, exp: examQ.exp });
          existing.date = Date.now();
        } else {
          state.exams.attempts.push({
            id: 'sg_quick_checks', date: Date.now(), score: 0, total: 0, pct: 0, timeSpent: 0,
            responses: [{ qId, topic: examQ.topic, selected, correct: examQ.correct, isCorrect, q: examQ.q, opts: examQ.opts, exp: examQ.exp }]
          });
        }
        // Update daily stats
        const today = new Date().toISOString().split('T')[0];
        if (!state.sessions.daily[today]) state.sessions.daily[today] = { flashcards: 0, exams: 0, time: 0 };
        Storage.set(state);
      }
    }
    // Track in analytics
    SiteAnalytics.track('quiz_answer', { topic: this.currentTopic, correct: isCorrect });
  },

  startTopicQuiz(topicId) {
    const questions = EXAM_BANK.filter(q => q.topic === topicId).sort(() => Math.random() - 0.5).slice(0, 10);
    if (questions.length === 0) return showToast('No quiz questions for this topic yet', 'info');
    this._topicQuizQuestions = questions;
    this._topicQuizIdx = 0;
    this._topicQuizCorrect = 0;
    this._topicQuizAnswers = [];
    this._renderTopicQuiz();
  },

  _renderTopicQuiz() {
    const container = document.getElementById('sgContent');
    const qs = this._topicQuizQuestions;
    const idx = this._topicQuizIdx;
    if (idx >= qs.length) {
      const pct = Math.round(this._topicQuizCorrect / qs.length * 100);
      const color = pct >= 70 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444';
      // Save full attempt to state for Review & Analytics
      const state = Storage.get();
      if (state) {
        const responses = this._topicQuizAnswers.map(a => ({
          qId: a.qId, topic: a.topic, selected: a.selected, correct: a.correctIdx, isCorrect: a.correct, q: a.q, opts: a.opts, exp: a.exp
        }));
        const topicScores = {};
        responses.forEach(r => {
          if (!topicScores[r.topic]) topicScores[r.topic] = { correct: 0, total: 0 };
          topicScores[r.topic].total++;
          if (r.isCorrect) topicScores[r.topic].correct++;
        });
        if (!state.exams.attempts) state.exams.attempts = [];
        state.exams.attempts.push({
          id: 'sg_topic_quiz_' + Date.now(), date: Date.now(),
          score: this._topicQuizCorrect, total: qs.length, pct,
          timeSpent: 0, responses, topicScores,
          source: 'study_guide_topic_quiz', topicId: this.currentTopic
        });
        // Update daily stats
        const today = new Date().toISOString().split('T')[0];
        if (!state.sessions.daily[today]) state.sessions.daily[today] = { flashcards: 0, exams: 0, time: 0 };
        state.sessions.daily[today].exams++;
        Storage.set(state);
        SiteAnalytics.track('topic_quiz_complete', { topic: this.currentTopic, score: pct, correct: this._topicQuizCorrect, total: qs.length });
      }
      container.innerHTML = `
        <div style="max-width:600px;margin:40px auto;text-align:center;">
          <div style="font-size:3rem;font-weight:900;color:${color};">${pct}%</div>
          <h2 style="margin:8px 0;">Topic Quiz Complete</h2>
          <p style="color:var(--text-secondary);">${this._topicQuizCorrect}/${qs.length} correct</p>
          <div style="margin-top:24px;">
            ${this._topicQuizAnswers.map((a,i) => `
              <div style="display:flex;align-items:center;gap:8px;padding:8px;margin-bottom:4px;background:var(--bg-card);border-radius:6px;text-align:left;">
                <span style="font-size:1.1rem;">${a.correct ? '&#x2705;' : '&#x274C;'}</span>
                <span style="font-size:0.85rem;flex:1;">${qs[i].q.substring(0,80)}...</span>
              </div>
            `).join('')}
          </div>
          <div style="margin-top:24px;display:flex;gap:12px;justify-content:center;">
            ${this._customAfterQuiz ?
              `<button class="btn btn-primary" onclick="StudyGuide._customAfterQuiz=false;StudyGuide._advanceCustomTopic()">Next Topic</button>
               <button class="btn btn-secondary" onclick="StudyGuide.startTopicQuiz('${this.currentTopic}')">Retry Quiz</button>` :
              `<button class="btn btn-primary" onclick="StudyGuide.render(Storage.get())">Back to Lesson</button>
               <button class="btn btn-secondary" onclick="StudyGuide.startTopicQuiz('${this.currentTopic}')">Retry Quiz</button>`}
          </div>
        </div>
      `;
      return;
    }
    const q = qs[idx];
    container.innerHTML = `
      <div style="max-width:700px;margin:20px auto;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
          <h3 style="margin:0;">Topic Quiz</h3>
          <span style="font-size:0.85rem;color:var(--text-muted);">Question ${idx+1} of ${qs.length}</span>
        </div>
        <div style="height:4px;background:var(--bg-input);border-radius:2px;margin-bottom:24px;overflow:hidden;">
          <div style="height:100%;width:${(idx/qs.length)*100}%;background:var(--accent);border-radius:2px;transition:width 0.3s;"></div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;">
          <div style="font-size:1rem;line-height:1.6;margin-bottom:20px;">${q.q}</div>
          ${q.opts.map((opt, i) => `
            <div onclick="StudyGuide._answerTopicQuiz(${i},${q.correct})" style="padding:12px 16px;margin-bottom:8px;background:var(--bg-input);border:2px solid var(--border);border-radius:8px;cursor:pointer;font-size:0.95rem;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">${opt}</div>
          `).join('')}
        </div>
      </div>
    `;
  },

  _answerTopicQuiz(selected, correct) {
    const isCorrect = selected === correct;
    const q = this._topicQuizQuestions[this._topicQuizIdx];
    this._topicQuizAnswers.push({ selected, correct: isCorrect, qId: q.id, topic: q.topic, q: q.q, opts: q.opts, exp: q.exp, correctIdx: q.correct });
    if (isCorrect) this._topicQuizCorrect++;
    this._topicQuizIdx++;
    SiteAnalytics.track('quiz_answer', { topic: this.currentTopic, correct: isCorrect, source: 'topic_quiz' });
    setTimeout(() => this._renderTopicQuiz(), 300);
  },

  selectTopic(topicId) {
    this.currentTopic = topicId;
    this.currentLesson = 0;
    const state = Storage.get();
    this.render(state);
  },

  // ===== CUSTOM STUDY GUIDE METHODS =====
  showCustomBuilder() {
    this.customMode = true;
    const state = Storage.get();
    const container = document.getElementById('sgContent');
    const topics = getTopicsForPeriod(state.user.period);
    const csgSections = getModulesBySection();
    const csgSelectView = this._csgSelectView || 'modules';
    container.innerHTML = `
      <div style="max-width:700px;margin:0 auto;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;">
          <button class="btn btn-ghost btn-sm" onclick="StudyGuide.customMode=false;StudyGuide.render(Storage.get())">&#x2190; Back</button>
          <div>
            <h2 style="margin:0;font-size:1.4rem;">&#x1F4CB; Custom Study Guide</h2>
            <p style="font-size:0.8rem;color:var(--text-muted);margin:4px 0 0;">Build a focused study plan for your upcoming exam</p>
          </div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:20px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
            <h3 style="margin:0;font-size:1rem;">1. Select What to Study</h3>
            <div style="display:flex;gap:2px;background:var(--bg-input);border-radius:var(--radius-sm);padding:2px;">
              <button onclick="StudyGuide._csgSelectView='modules';StudyGuide.showCustomBuilder()" style="padding:5px 12px;border:none;border-radius:6px;font-size:0.75rem;font-weight:600;cursor:pointer;background:${csgSelectView === 'modules' ? 'var(--accent)' : 'transparent'};color:${csgSelectView === 'modules' ? '#000' : 'var(--text-muted)'};">Modules</button>
              <button onclick="StudyGuide._csgSelectView='topics';StudyGuide.showCustomBuilder()" style="padding:5px 12px;border:none;border-radius:6px;font-size:0.75rem;font-weight:600;cursor:pointer;background:${csgSelectView === 'topics' ? 'var(--accent)' : 'transparent'};color:${csgSelectView === 'topics' ? '#000' : 'var(--text-muted)'};">Topics</button>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
            <button class="btn btn-ghost btn-sm" onclick="document.querySelectorAll('.csg-topic-check').forEach(c=>{if(!c.disabled)c.checked=true})">Select All Available</button>
            <button class="btn btn-ghost btn-sm" onclick="document.querySelectorAll('.csg-topic-check').forEach(c=>c.checked=false)">Clear All</button>
            <button class="btn btn-ghost btn-sm" onclick="StudyGuide._selectWeakTopics()">&#x1F534; Weak Areas Only</button>
          </div>
          ${csgSelectView === 'modules' ? `
            <div style="display:flex;flex-direction:column;gap:10px;">
              ${csgSections.map(sec => {
                const availCount = sec.modules.filter(m => m.hasContent).length;
                return `
                <div>
                  <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;border-left:3px solid ${sec.color};background:rgba(255,255,255,0.02);border-radius:0 6px 6px 0;margin-bottom:4px;">
                    <span style="font-size:0.72rem;font-weight:700;color:${sec.color};flex:1;">${sec.name}</span>
                    <span style="font-size:0.6rem;color:var(--text-muted);">${availCount} available</span>
                  </div>
                  <div style="display:flex;flex-direction:column;gap:3px;padding-left:8px;">
                    ${sec.modules.map(m => `
                      <label style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg-input);border-radius:6px;${m.hasContent ? 'cursor:pointer;' : 'opacity:0.35;cursor:not-allowed;'}font-size:0.82rem;">
                        <input type="checkbox" class="csg-topic-check" value="${m.topics.join(',')}" ${m.hasContent ? 'checked' : 'disabled'} style="width:16px;height:16px;">
                        <span style="font-size:0.6rem;font-weight:700;color:var(--text-muted);min-width:18px;">${m.num}</span>
                        <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${m.name}</span>
                        ${!m.hasContent ? '<span style="font-size:0.55rem;background:rgba(239,68,68,0.15);color:#ef4444;padding:1px 6px;border-radius:4px;font-weight:700;flex-shrink:0;">COMING SOON</span>' : ''}
                      </label>
                    `).join('')}
                  </div>
                </div>`;
              }).join('')}
            </div>
          ` : `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              ${topics.map(t => {
                const isWeak = state.diagnostic.weakAreas?.includes(t.id);
                return `<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-input);border-radius:8px;cursor:pointer;font-size:0.85rem;">
                  <input type="checkbox" class="csg-topic-check" value="${t.id}" checked style="width:18px;height:18px;">
                  <span>${t.icon} ${t.name}</span>
                  ${isWeak ? '<span style="font-size:0.6rem;background:rgba(239,68,68,0.15);color:#ef4444;padding:1px 6px;border-radius:4px;margin-left:auto;">weak</span>' : ''}
                </label>`;
              }).join('')}
            </div>
          `}
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:20px;">
          <h3 style="margin:0 0 16px;font-size:1rem;">2. Study Mode</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <label style="display:flex;align-items:flex-start;gap:10px;padding:16px;background:var(--bg-input);border:2px solid var(--accent);border-radius:10px;cursor:pointer;" onclick="this.querySelector('input').checked=true;document.querySelectorAll('.csg-mode-radio').forEach(r=>{r.closest('label').style.borderColor=r.checked?'var(--accent)':'var(--border)'})">
              <input type="radio" name="csgMode" value="deep" class="csg-mode-radio" checked style="margin-top:2px;">
              <div><div style="font-weight:600;font-size:0.9rem;">&#x1F4DA; Deep Dive</div><div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px;">Full lessons with explanations, formulas, and key points. Best for learning new material.</div></div>
            </label>
            <label style="display:flex;align-items:flex-start;gap:10px;padding:16px;background:var(--bg-input);border:2px solid var(--border);border-radius:10px;cursor:pointer;" onclick="this.querySelector('input').checked=true;document.querySelectorAll('.csg-mode-radio').forEach(r=>{r.closest('label').style.borderColor=r.checked?'var(--accent)':'var(--border)'})">
              <input type="radio" name="csgMode" value="refresh" class="csg-mode-radio" style="margin-top:2px;">
              <div><div style="font-weight:600;font-size:0.9rem;">&#x26A1; Quick Refresh</div><div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px;">Key points and formulas only. Best for reviewing before an exam.</div></div>
            </label>
          </div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:20px;">
          <h3 style="margin:0 0 16px;font-size:1rem;">3. Include Quizzes?</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
            <label style="display:flex;align-items:flex-start;gap:10px;padding:14px;background:var(--bg-input);border:2px solid var(--accent);border-radius:10px;cursor:pointer;" onclick="this.querySelector('input').checked=true;document.querySelectorAll('.csg-quiz-radio').forEach(r=>{r.closest('label').style.borderColor=r.checked?'var(--accent)':'var(--border)'})">
              <input type="radio" name="csgQuiz" value="after_each" class="csg-quiz-radio" checked style="margin-top:2px;">
              <div><div style="font-weight:600;font-size:0.85rem;">After Each Topic</div><div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">Quiz at the end of each topic</div></div>
            </label>
            <label style="display:flex;align-items:flex-start;gap:10px;padding:14px;background:var(--bg-input);border:2px solid var(--border);border-radius:10px;cursor:pointer;" onclick="this.querySelector('input').checked=true;document.querySelectorAll('.csg-quiz-radio').forEach(r=>{r.closest('label').style.borderColor=r.checked?'var(--accent)':'var(--border)'})">
              <input type="radio" name="csgQuiz" value="final_only" class="csg-quiz-radio" style="margin-top:2px;">
              <div><div style="font-weight:600;font-size:0.85rem;">Final Quiz Only</div><div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">One big quiz at the end</div></div>
            </label>
            <label style="display:flex;align-items:flex-start;gap:10px;padding:14px;background:var(--bg-input);border:2px solid var(--border);border-radius:10px;cursor:pointer;" onclick="this.querySelector('input').checked=true;document.querySelectorAll('.csg-quiz-radio').forEach(r=>{r.closest('label').style.borderColor=r.checked?'var(--accent)':'var(--border)'})">
              <input type="radio" name="csgQuiz" value="none" class="csg-quiz-radio" style="margin-top:2px;">
              <div><div style="font-weight:600;font-size:0.85rem;">No Quizzes</div><div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">Just the study material</div></div>
            </label>
          </div>
        </div>
        <button class="btn btn-primary" style="width:100%;padding:14px;font-size:1rem;" onclick="StudyGuide.generateCustomGuide()">&#x1F680; Generate My Study Guide</button>
      </div>
    `;
  },

  _selectWeakTopics() {
    const state = Storage.get();
    const weakAreas = state.diagnostic.weakAreas || [];
    document.querySelectorAll('.csg-topic-check').forEach(c => { c.checked = weakAreas.includes(c.value); });
  },

  generateCustomGuide() {
    const rawValues = Array.from(document.querySelectorAll('.csg-topic-check:checked')).map(c => c.value);
    // Flatten: module checkboxes have comma-separated topic IDs
    const selectedTopics = [...new Set(rawValues.flatMap(v => v.split(',')))];
    if (selectedTopics.length === 0) return showToast('Select at least one topic or module', 'error');
    const mode = document.querySelector('input[name="csgMode"]:checked')?.value || 'deep';
    const quizMode = document.querySelector('input[name="csgQuiz"]:checked')?.value || 'after_each';
    this.customConfig = { topics: selectedTopics, mode, quizMode };
    this.customMode = true;
    this._customIdx = 0;
    this._customTopicIdx = 0;
    this._renderCustomGuide();
  },

  _renderCustomGuide() {
    const container = document.getElementById('sgContent');
    const state = Storage.get();
    const cfg = this.customConfig;
    if (!cfg) return;
    const topicId = cfg.topics[this._customTopicIdx];
    const topic = TOPICS[topicId];
    const content = STUDY_CONTENT[topicId];
    if (!topic || !content) {
      if (this._customTopicIdx < cfg.topics.length - 1) { this._customTopicIdx++; this._customIdx = 0; this._renderCustomGuide(); }
      else { this._renderCustomComplete(); }
      return;
    }
    const sections = content.sections || [];
    const isRefresh = cfg.mode === 'refresh';
    const displaySections = isRefresh ? sections.filter(s => s.isFormula || s.isKeyPoint) : sections;
    if (displaySections.length === 0) {
      container.innerHTML = this._customHeader(cfg) + `
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:20px;">
          <h3>${topic.icon} ${topic.name}</h3>
          <p style="color:var(--text-muted);">No key formulas or key points for this topic in refresh mode.</p>
          ${sections.length > 0 ? '<p style="font-size:0.85rem;color:var(--text-secondary);">' + sections[0].content + '</p>' : ''}
        </div>
        <div style="text-align:right;"><button class="btn btn-primary" onclick="StudyGuide._customNext()">Next Topic &#x2192;</button></div>`;
      return;
    }
    const currentSection = displaySections[Math.min(this._customIdx, displaySections.length - 1)];
    container.innerHTML = this._customHeader(cfg) + `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:20px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
          <span style="font-size:1.4rem;">${topic.icon}</span>
          <div><h3 style="margin:0;font-size:1.1rem;">${topic.name}</h3><div style="font-size:0.75rem;color:var(--text-muted);">${isRefresh ? 'Quick Refresh' : 'Deep Dive'} &middot; Section ${this._customIdx + 1}/${displaySections.length}</div></div>
        </div>
        ${currentSection ? `
          <h4 style="color:var(--accent);margin:0 0 12px;">${currentSection.heading}</h4>
          ${currentSection.isFormula ? '<div style="background:linear-gradient(135deg,rgba(139,92,246,0.08),rgba(59,130,246,0.08));border:1px solid rgba(139,92,246,0.2);border-radius:10px;padding:16px;margin-bottom:12px;"><div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:#8b5cf6;margin-bottom:8px;font-weight:700;">Key Formulas</div><pre style="font-family:monospace;font-size:0.95rem;line-height:1.8;margin:0;white-space:pre-wrap;">' + currentSection.formula + '</pre></div>' : ''}
          ${currentSection.isKeyPoint ? '<div style="background:rgba(245,158,11,0.06);border-left:4px solid var(--accent);padding:14px 18px;border-radius:0 8px 8px 0;margin-bottom:12px;"><div style="font-size:0.65rem;text-transform:uppercase;color:var(--accent);margin-bottom:4px;font-weight:700;">Key Point</div><div style="font-size:0.9rem;line-height:1.7;">' + currentSection.content + '</div></div>' : ''}
          ${!currentSection.isFormula && !currentSection.isKeyPoint && currentSection.content ? '<div style="font-size:0.9rem;line-height:1.8;color:var(--text-secondary);">' + currentSection.content + '</div>' : ''}
          ${currentSection.content && currentSection.isFormula ? '<div style="font-size:0.9rem;line-height:1.8;color:var(--text-secondary);margin-top:8px;">' + currentSection.content + '</div>' : ''}
        ` : ''}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <button class="btn btn-ghost" onclick="StudyGuide._customPrev()" ${this._customIdx === 0 && this._customTopicIdx === 0 ? 'disabled style="opacity:0.3;"' : ''}>&#x2190; Previous</button>
        <span style="font-size:0.8rem;color:var(--text-muted);">Topic ${this._customTopicIdx + 1}/${cfg.topics.length}</span>
        ${this._customIdx < displaySections.length - 1 ? `
          <button class="btn btn-primary" onclick="StudyGuide._customIdx++;StudyGuide._renderCustomGuide()">Next &#x2192;</button>
        ` : `
          <button class="btn btn-primary" onclick="StudyGuide._customNext()">${cfg.quizMode === 'after_each' ? '&#x1F4DD; Topic Quiz' : 'Next Topic &#x2192;'}</button>
        `}
      </div>`;
  },

  _customHeader(cfg) {
    const progress = ((this._customTopicIdx + this._customIdx * 0.1) / cfg.topics.length) * 100;
    return '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;"><button class="btn btn-ghost btn-sm" onclick="if(confirm(\'Exit custom study guide?\')){StudyGuide.customMode=false;StudyGuide.customConfig=null;StudyGuide.render(Storage.get());}">&#x2190; Exit</button><div style="flex:1;"><div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:4px;">Custom Study Guide &middot; ' + (cfg.mode === 'deep' ? 'Deep Dive' : 'Quick Refresh') + ' &middot; ' + cfg.topics.length + ' topics</div><div style="height:4px;background:var(--bg-input);border-radius:2px;overflow:hidden;"><div style="height:100%;width:' + Math.min(progress, 100) + '%;background:var(--accent);border-radius:2px;transition:width 0.3s;"></div></div></div></div>';
  },

  _customPrev() {
    if (this._customIdx > 0) { this._customIdx--; }
    else if (this._customTopicIdx > 0) {
      this._customTopicIdx--;
      const topicId = this.customConfig.topics[this._customTopicIdx];
      const content = STUDY_CONTENT[topicId];
      const sections = content?.sections || [];
      const ds = this.customConfig.mode === 'refresh' ? sections.filter(s => s.isFormula || s.isKeyPoint) : sections;
      this._customIdx = Math.max(0, ds.length - 1);
    }
    this._renderCustomGuide();
  },

  _customNext() {
    const cfg = this.customConfig;
    if (cfg.quizMode === 'after_each') {
      const topicId = cfg.topics[this._customTopicIdx];
      const questions = EXAM_BANK.filter(q => q.topic === topicId).sort(() => Math.random() - 0.5).slice(0, 5);
      if (questions.length > 0) {
        this._topicQuizQuestions = questions;
        this._topicQuizIdx = 0;
        this._topicQuizCorrect = 0;
        this._topicQuizAnswers = [];
        this._customAfterQuiz = true;
        this._renderTopicQuiz();
        return;
      }
    }
    this._advanceCustomTopic();
  },

  _advanceCustomTopic() {
    if (this._customTopicIdx < this.customConfig.topics.length - 1) {
      this._customTopicIdx++;
      this._customIdx = 0;
      this._renderCustomGuide();
    } else if (this.customConfig.quizMode === 'final_only') {
      const allQs = [];
      this.customConfig.topics.forEach(tid => { allQs.push(...EXAM_BANK.filter(q => q.topic === tid).sort(() => Math.random() - 0.5).slice(0, 3)); });
      if (allQs.length > 0) {
        this._topicQuizQuestions = allQs.sort(() => Math.random() - 0.5).slice(0, 20);
        this._topicQuizIdx = 0;
        this._topicQuizCorrect = 0;
        this._topicQuizAnswers = [];
        this._customAfterQuiz = true;
        this._renderTopicQuiz();
      } else { this._renderCustomComplete(); }
    } else { this._renderCustomComplete(); }
  },

  _renderCustomComplete() {
    const container = document.getElementById('sgContent');
    const cfg = this.customConfig;
    container.innerHTML = '<div style="max-width:500px;margin:60px auto;text-align:center;"><div style="font-size:3rem;margin-bottom:16px;">&#x1F389;</div><h2 style="margin:0 0 8px;">Custom Study Guide Complete!</h2><p style="color:var(--text-secondary);margin-bottom:24px;">You covered ' + cfg.topics.length + ' topic' + (cfg.topics.length > 1 ? 's' : '') + ' in ' + (cfg.mode === 'deep' ? 'deep dive' : 'quick refresh') + ' mode.</p><div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;"><button class="btn btn-primary" onclick="StudyGuide.customMode=false;StudyGuide.customConfig=null;StudyGuide.render(Storage.get())">Back to Study Guide</button><button class="btn btn-secondary" onclick="StudyGuide.showCustomBuilder()">Build Another</button><button class="btn btn-secondary" onclick="App.navigate(\'flashcards\')">Practice Flashcards</button></div></div>';
    this.customMode = false;
    this.customConfig = null;
  }
};

// ===== TOOLS / SIMULATORS PAGE =====
const Tools = {
  activeSim: null,

  sims: [
    { id: 'ohm-sim', name: "Ohm's Law Simulator", icon: '&#x26A1;', desc: 'Visualize voltage, current, and resistance relationships with animated electron flow', period: 1 },
    { id: 'series-sim', name: 'Series Circuit Builder', icon: '&#x1F50C;', desc: 'Build series circuits with up to 5 resistors and see voltage drops, current flow, and power', period: 1 },
    { id: 'parallel-sim', name: 'Parallel Circuit Builder', icon: '&#x1F504;', desc: 'Build parallel circuits and watch branch currents split in real time', period: 1 },
    { id: 'wire-sizer', name: 'CEC Wire Sizer', icon: '&#x1F4D5;', desc: 'Look up CEC Table 2 wire ampacity, voltage drop, and conduit fill', period: 1 },
    { id: 'ac-wave', name: 'AC Waveform Viewer', icon: '&#x1F4C8;', desc: 'Animated sine wave showing peak, RMS, average, and frequency relationships', period: 2 },
    { id: 'transformer-sim', name: 'Transformer Simulator', icon: '&#x1F504;', desc: 'Adjust turns ratio and load — see voltage, current, and power on both sides', period: 2 },
    { id: 'motor-sim', name: 'Motor Speed & Torque', icon: '&#x2699;', desc: 'Change frequency, poles, and load to see sync speed, slip, and torque', period: 2 },
    { id: 'pf-triangle', name: 'Power Triangle', icon: '&#x1F4CA;', desc: 'Interactive power triangle — drag to adjust true, reactive, and apparent power', period: 2 },
    { id: 'vd-calc', name: 'Voltage Drop Calculator', icon: '&#x1F9EE;', desc: 'Calculate voltage drop for copper and aluminum conductors per CEC standards', period: 1 },
    { id: 'demand-factor', name: 'Demand Factor Practice', icon: '&#x1F3E0;', desc: 'Scenario-based CEC 8-200 practice tool — read a home description and calculate the service size', period: 1 },
    { id: 'demand-factor-calc', name: 'Demand Factor Calculator', icon: '&#x1F9EE;', desc: 'CEC Rule 8-200 residential demand load calculator — enter your own loads and see the math', period: 1 },
    { id: 'conduit-fill', name: 'Conduit Fill Calculator', icon: '&#x1F4D0;', desc: 'Calculate conduit fill percentage per CEC Table 8 for common raceway types', period: 1 },
    { id: 'rlc-impedance', name: 'RLC Impedance Calculator', icon: '&#x1F300;', desc: 'Calculate impedance, phase angle, and resonance in series/parallel RLC circuits', period: 2 },
    { id: 'diagram-sim', name: 'Drawing & Diagram Conversion', icon: '&#x1F4CB;', desc: 'Learn to read block diagrams, wiring diagrams, and schematics — and count conductors for any circuit', period: 1 },
  ],

  render(state) {
    if (!state) return;
    const container = document.getElementById('toolsContent');
    if (!container) return;
    const period = state.user.period;

    if (this.activeSim) {
      container.innerHTML = this._renderSim(this.activeSim, state);
      setTimeout(() => this._initSim(this.activeSim), 50);
      return;
    }

    const available = this.sims.filter(s => s.period <= period);
    const locked = this.sims.filter(s => s.period > period);
    const catColors = { 'DC Fundamentals': '#f59e0b', 'Code & Sizing': '#3b82f6', 'AC & Power': '#8b5cf6', 'Equipment': '#22c55e', 'Diagrams & Drawings': '#ec4899' };
    const catIcons = { 'DC Fundamentals': '&#x26A1;', 'Code & Sizing': '&#x1F4D5;', 'AC & Power': '&#x1F4C8;', 'Equipment': '&#x2699;', 'Diagrams & Drawings': '&#x1F4CB;' };
    const cats = [
      { label: 'DC Fundamentals', ids: ['ohm-sim', 'series-sim', 'parallel-sim'] },
      { label: 'Code & Sizing', ids: ['wire-sizer', 'vd-calc', 'demand-factor-calc', 'demand-factor', 'conduit-fill'] },
      { label: 'AC & Power', ids: ['ac-wave', 'pf-triangle', 'rlc-impedance'] },
      { label: 'Equipment', ids: ['transformer-sim', 'motor-sim'] },
      { label: 'Diagrams & Drawings', ids: ['diagram-sim'] },
    ];
    container.innerHTML = `
      <div style="margin-bottom:32px;padding:28px 24px;background:linear-gradient(135deg,rgba(245,158,11,0.06),rgba(139,92,246,0.06));border:1px solid rgba(245,158,11,0.12);border-radius:16px;position:relative;overflow:hidden;">
        <div style="position:absolute;top:-30px;right:-30px;width:120px;height:120px;background:radial-gradient(circle,rgba(245,158,11,0.08),transparent 70%);border-radius:50%;"></div>
        <h1 style="margin:0 0 6px;font-size:1.6rem;">&#x1F9EA; Tools & Simulators</h1>
        <p style="color:var(--text-secondary);margin:0;font-size:0.9rem;">${available.length} interactive tools available &middot; Period ${period}</p>
      </div>
      ${cats.map(cat => {
        const catSims = cat.ids.map(id => this.sims.find(s => s.id === id)).filter(Boolean);
        const avail = catSims.filter(s => s.period <= period);
        const lock = catSims.filter(s => s.period > period);
        if (avail.length === 0 && lock.length === 0) return '';
        const cc = catColors[cat.label] || '#f59e0b';
        return `
          <div style="margin-bottom:32px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
              <span style="font-size:1rem;">${catIcons[cat.label] || ''}</span>
              <h3 style="font-size:0.8rem;text-transform:uppercase;letter-spacing:1.5px;color:${cc};margin:0;">${cat.label}</h3>
              <div style="flex:1;height:1px;background:linear-gradient(90deg,${cc}33,transparent);"></div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;" class="tools-grid">
              ${avail.map(s => `
                <div onclick="Tools.open('${s.id}')" style="background:linear-gradient(145deg,var(--bg-card),rgba(${cc === '#f59e0b' ? '245,158,11' : cc === '#3b82f6' ? '59,130,246' : cc === '#8b5cf6' ? '139,92,246' : '34,197,94'},0.03));border:1px solid var(--border);border-radius:14px;padding:22px;cursor:pointer;transition:all 0.25s ease;position:relative;overflow:hidden;" onmouseover="this.style.borderColor='${cc}';this.style.boxShadow='0 4px 24px ${cc}22';this.style.transform='translateY(-3px)'" onmouseout="this.style.borderColor='var(--border)';this.style.boxShadow='none';this.style.transform='none'">
                  <div style="display:flex;align-items:flex-start;gap:14px;">
                    <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,${cc}18,${cc}08);border:1px solid ${cc}22;display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;">${s.icon}</div>
                    <div style="flex:1;min-width:0;">
                      <h3 style="font-size:0.95rem;margin:0 0 5px;color:var(--text-primary);font-weight:700;">${s.name}</h3>
                      <p style="font-size:0.76rem;color:var(--text-muted);margin:0;line-height:1.45;">${s.desc}</p>
                    </div>
                  </div>
                  <div style="position:absolute;bottom:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,${cc}33,transparent);"></div>
                </div>
              `).join('')}
              ${lock.map(s => `
                <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:22px;opacity:0.35;position:relative;overflow:hidden;">
                  <div style="display:flex;align-items:flex-start;gap:14px;">
                    <div style="width:48px;height:48px;border-radius:12px;background:var(--bg-input);display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;">${s.icon}</div>
                    <div style="flex:1;min-width:0;">
                      <h3 style="font-size:0.95rem;margin:0 0 5px;font-weight:700;">${s.name}</h3>
                      <p style="font-size:0.76rem;color:var(--text-muted);margin:0;line-height:1.45;">${s.desc}</p>
                    </div>
                  </div>
                  <div style="position:absolute;top:10px;right:10px;font-size:0.6rem;background:rgba(239,68,68,0.1);color:#ef4444;padding:2px 8px;border-radius:10px;font-weight:600;">&#x1F512; Period ${s.period}</div>
                </div>
              `).join('')}
            </div>
          </div>`;
      }).join('')}
    `;
  },

  open(simId) {
    this.activeSim = simId;
    const state = Storage.get();
    this.render(state);
  },

  back() {
    this.cleanup();
    const state = Storage.get();
    this.render(state);
  },

  _initSim(simId) {
    switch (simId) {
      case 'ohm-sim': this._updateOhmSim(); break;
      case 'series-sim': this._updateSeriesSim(); break;
      case 'parallel-sim': this._updateParallelSim(); break;
      case 'wire-sizer': this._updateWireSizer(); break;
      case 'ac-wave': this._updateACSim(); break;
      case 'transformer-sim': this._updateTxSim(); break;
      case 'motor-sim': this._updateMotorSim(); break;
      case 'pf-triangle': this._updatePFSim(); break;
      case 'vd-calc': this._updateVDCalc(); break;
      case 'demand-factor': this._updateDemandFactor(); break;
      case 'demand-factor-calc': this._updateDemandCalc(); break;
      case 'conduit-fill': this._updateConduitFill(); break;
      case 'rlc-impedance': this._updateRLC(); break;
      case 'diagram-sim': this._initDiagramSim(); break;
    }
  },

  _renderSim(simId, state) {
    const sim = this.sims.find(s => s.id === simId);
    const header = `
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:28px;padding:18px 20px;background:linear-gradient(135deg,rgba(245,158,11,0.05),rgba(139,92,246,0.05));border:1px solid rgba(245,158,11,0.1);border-radius:14px;position:relative;overflow:hidden;">
        <button class="btn btn-ghost btn-sm" onclick="Tools.back()" style="padding:8px 14px;border-radius:8px;">&#x2190; Back</button>
        <div style="width:46px;height:46px;border-radius:12px;background:linear-gradient(135deg,var(--accent-soft),rgba(139,92,246,0.1));border:1px solid rgba(245,158,11,0.15);display:flex;align-items:center;justify-content:center;font-size:1.4rem;flex-shrink:0;">${sim.icon}</div>
        <div style="flex:1;">
          <h2 style="margin:0;font-size:1.25rem;font-weight:800;">${sim.name}</h2>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-top:3px;">${sim.desc}</div>
        </div>
        <div style="position:absolute;top:-20px;right:-20px;width:80px;height:80px;background:radial-gradient(circle,rgba(245,158,11,0.06),transparent);border-radius:50%;"></div>
      </div>
    `;

    switch (simId) {
      case 'ohm-sim': return header + this._simOhm();
      case 'series-sim': return header + this._simSeries();
      case 'parallel-sim': return header + this._simParallel();
      case 'wire-sizer': return header + this._simWireSizer();
      case 'ac-wave': return header + this._simACWave();
      case 'transformer-sim': return header + this._simTransformer();
      case 'motor-sim': return header + this._simMotor();
      case 'pf-triangle': return header + this._simPFTriangle();
      case 'vd-calc': return header + this._simVDCalc();
      case 'demand-factor': return header + this._simDemandFactor();
      case 'demand-factor-calc': return header + this._simDemandCalc();
      case 'conduit-fill': return header + this._simConduitFill();
      case 'rlc-impedance': return header + this._simRLC();
      case 'diagram-sim': return header + this._simDiagramConversion();
      default: return header + '<p>Simulator not found.</p>';
    }
  },

  // ===== OHM'S LAW SIMULATOR (INSTRUMENT DESIGN) =====
  _simOhm() {
    if (this._ohmResRAF)       { cancelAnimationFrame(this._ohmResRAF); this._ohmResRAF = null; }
    if (this._ohmWireIntervals){ this._ohmWireIntervals.forEach(clearInterval); this._ohmWireIntervals = []; }
    if (!this._ohmV) { this._ohmV = 4.5; this._ohmR = 500; }
    return `
<style>
@keyframes eflow{from{stroke-dashoffset:50}to{stroke-dashoffset:0}}
.ohm-inst{
  --oi-bg:#070b14;--oi-panel:#0b1220;--oi-panel2:#0f1a2e;
  --oi-border:rgba(56,120,200,0.28);--oi-border2:rgba(56,120,200,0.5);
  --oi-sky:#4da6ff;--oi-sky2:#1e6fbf;
  --oi-V:#ffd166;--oi-I:#06d6a0;--oi-R:#ef476f;--oi-P:#a8dadc;
  --oi-muted:#7a9cc4;--oi-text:#e8f2ff;
  color:var(--oi-text);font-family:'Rajdhani',sans-serif;
  display:flex;flex-direction:column;gap:14px;
}
.ohm-inst .presets{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.ohm-inst .plbl{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--oi-muted)}
.ohm-inst .chip{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:1px;padding:4px 11px;border-radius:3px;border:1px solid var(--oi-border);background:var(--oi-panel);color:var(--oi-muted);cursor:pointer;transition:all .12s}
.ohm-inst .chip:hover{border-color:var(--oi-sky);color:var(--oi-sky)}
.ohm-inst .chip.on{border-color:var(--oi-sky);color:var(--oi-sky);background:rgba(77,166,255,0.08);box-shadow:0 0 10px rgba(77,166,255,0.15)}
.ohm-inst .main{display:grid;grid-template-columns:1fr 300px;gap:14px;align-items:start}
.ohm-inst .left{display:flex;flex-direction:column;gap:14px}
.ohm-inst .pnl{background:var(--oi-panel);border:1px solid var(--oi-border);border-radius:8px;position:relative;overflow:hidden}
.ohm-inst .pnl::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent 5%,var(--oi-sky2) 30%,var(--oi-sky) 50%,var(--oi-sky2) 70%,transparent 95%);opacity:0.6}
.ohm-inst .pnl-hdr{padding:10px 18px;border-bottom:1px solid var(--oi-border);display:flex;align-items:center;justify-content:space-between}
.ohm-inst .pnl-title{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:2.5px;text-transform:uppercase;color:#9ab8d8}
.ohm-inst .pnl-body{padding:18px}
.ohm-inst .formula{display:flex;align-items:baseline;justify-content:center;gap:6px;padding:12px 20px 16px}
.ohm-inst .fl{font-family:'Rajdhani',sans-serif;font-weight:700;line-height:1;transition:font-size .38s cubic-bezier(.34,1.56,.64,1),text-shadow .3s}
.ohm-inst .fl-V{color:var(--oi-V);font-size:116px;text-shadow:0 0 40px rgba(255,209,102,.35)}
.ohm-inst .fl-eq{color:#5a7fa8;font-size:70px;font-weight:400;margin:0 8px}
.ohm-inst .fl-I{color:var(--oi-I);font-size:70px;text-shadow:0 0 30px rgba(6,214,160,.3)}
.ohm-inst .fl-dot{color:#5a7fa8;font-size:70px;font-weight:400;margin:0 4px}
.ohm-inst .fl-R{color:var(--oi-R);font-size:70px;text-shadow:0 0 30px rgba(239,71,111,.3)}
.ohm-inst .fl-legend{display:flex;justify-content:center;gap:24px;border-top:1px solid var(--oi-border);padding:10px 0}
.ohm-inst .fll{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:1.5px;color:var(--oi-muted);display:flex;align-items:center;gap:7px}
.ohm-inst .fll-dot{width:6px;height:6px;border-radius:50%}
.ohm-inst .sl-group{margin-bottom:20px}.ohm-inst .sl-group:last-child{margin-bottom:0}
.ohm-inst .sl-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.ohm-inst .sl-name{font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#9ab8d8}
.ohm-inst .sl-val{font-family:'Share Tech Mono',monospace;font-size:15px;font-weight:500}
.ohm-inst .sv-V{color:var(--oi-V)}.ohm-inst .sv-R{color:var(--oi-R)}
.ohm-inst .sl-row{display:flex;align-items:center;gap:8px}
.ohm-inst .sl-b{font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--oi-muted);width:22px;text-align:center;flex-shrink:0}
.ohm-inst input[type=range]{-webkit-appearance:none;appearance:none;flex:1;height:3px;border-radius:2px;outline:none;cursor:pointer}
.ohm-inst input[type=range].trV{background:linear-gradient(to right,var(--oi-V) var(--p,0%),#0f1a2e var(--p,0%))}
.ohm-inst input[type=range].trR{background:linear-gradient(to right,var(--oi-R) var(--p,50%),#0f1a2e var(--p,50%))}
.ohm-inst input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--oi-text);border:2px solid #070b14;box-shadow:0 0 8px rgba(77,166,255,.4);transition:transform .1s}
.ohm-inst input[type=range]:active::-webkit-slider-thumb{transform:scale(1.25)}
.ohm-inst .cur-meter{padding:16px 18px 14px;border-bottom:1px solid var(--oi-border)}
.ohm-inst .cur-row{display:flex;align-items:flex-end;justify-content:space-between;gap:12px}
.ohm-inst .cur-lbl-col .c-lbl{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#9ab8d8;margin-bottom:6px}
.ohm-inst .cur-val{font-family:'Share Tech Mono',monospace;font-size:36px;font-weight:400;color:var(--oi-I);text-shadow:0 0 24px rgba(6,214,160,.45);transition:all .2s;letter-spacing:-1px}
.ohm-inst .bar-bg{height:4px;background:#0f1a2e;border-radius:2px;overflow:hidden;margin-bottom:4px}
.ohm-inst .bar-fill{height:100%;border-radius:2px;background:linear-gradient(90deg,var(--oi-I),var(--oi-sky));box-shadow:0 0 8px rgba(6,214,160,.4);transition:width .35s cubic-bezier(.34,1.56,.64,1)}
.ohm-inst .bar-lbs{display:flex;justify-content:space-between}
.ohm-inst .bar-lbs span{font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--oi-muted)}
.ohm-inst .rg{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:14px 18px}
.ohm-inst .rc{border:1px solid var(--oi-border);border-radius:6px;padding:12px;background:var(--oi-panel2);position:relative;overflow:hidden}
.ohm-inst .rc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%}
.ohm-inst .rc.cV::before{background:var(--oi-V)}.ohm-inst .rc.cI::before{background:var(--oi-I)}
.ohm-inst .rc.cR::before{background:var(--oi-R)}.ohm-inst .rc.cP::before{background:var(--oi-P)}
.ohm-inst .rc-l{font-family:'Share Tech Mono',monospace;font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:#9ab8d8;margin-bottom:5px}
.ohm-inst .rc-v{font-family:'Share Tech Mono',monospace;font-size:17px;transition:color .2s}
.ohm-inst .rc.cV .rc-v{color:var(--oi-V)}.ohm-inst .rc.cI .rc-v{color:var(--oi-I)}
.ohm-inst .rc.cR .rc-v{color:var(--oi-R)}.ohm-inst .rc.cP .rc-v{color:var(--oi-P)}
</style>
<div class="ohm-inst">

  <div class="presets">
    <span class="plbl">Presets \u2192</span>
    <button class="chip on"  onclick="Tools._ohmInstrPreset(4.5,500,this)">PhET Default</button>
    <button class="chip"     onclick="Tools._ohmInstrPreset(1.5,100,this)">1\u00d7 AA</button>
    <button class="chip"     onclick="Tools._ohmInstrPreset(9,47,this)">9V Dev Kit</button>
    <button class="chip"     onclick="Tools._ohmInstrPreset(12,10,this)">12V / 10\u03a9</button>
    <button class="chip"     onclick="Tools._ohmInstrPreset(5,220,this)">USB 5V</button>
  </div>

  <div class="main">
    <div class="left">

      <div class="pnl">
        <div class="pnl-hdr">
          <span class="pnl-title">Ohm's Law Formula</span>
          <span style="font-family:'Share Tech Mono',monospace;font-size:9px;color:#7a9cc4">V = I \u00b7 R</span>
        </div>
        <div class="formula">
          <span class="fl fl-V" id="fl-V">V</span>
          <span class="fl fl-eq">=</span>
          <span class="fl fl-I" id="fl-I">I</span>
          <span class="fl fl-dot">\u00b7</span>
          <span class="fl fl-R" id="fl-R">R</span>
        </div>
        <div class="fl-legend">
          <span class="fll"><span class="fll-dot" style="background:#ffd166"></span>Voltage \u2014 V</span>
          <span class="fll"><span class="fll-dot" style="background:#06d6a0"></span>Current \u2014 I</span>
          <span class="fll"><span class="fll-dot" style="background:#ef476f"></span>Resistance \u2014 R</span>
        </div>
      </div>

      <div class="pnl">
        <div class="pnl-hdr"><span class="pnl-title">Circuit Diagram</span></div>
        <div style="padding:16px 20px 18px">
          <svg id="cct-svg" viewBox="60 0 520 230" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;overflow:visible">
            <defs>
              <filter id="ge"><feGaussianBlur stdDeviation="3"/></filter>
              <filter id="ge-soft"><feGaussianBlur stdDeviation="1.5"/></filter>
              <filter id="gr"><feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
              <clipPath id="res-clip"><rect x="211" y="168" width="178" height="34" rx="5"/></clipPath>
            </defs>
            <rect x="100" y="35" width="400" height="155" fill="none" stroke="#0d1f35" stroke-width="10" stroke-linejoin="round"/>
            <rect x="100" y="35" width="400" height="155" fill="none" stroke="#2a5f96" stroke-width="3" stroke-linejoin="round"/>
            <rect x="100" y="35" width="400" height="155" fill="none" stroke="#4da6ff" stroke-width="1.2" stroke-linejoin="round" opacity=".6"/>
            <rect id="cur-wire" x="100" y="35" width="400" height="155"
              fill="none" stroke="#06d6a0" stroke-width="1.8" stroke-linejoin="round"
              stroke-dasharray="7 15" opacity=".75"
              style="animation:eflow 1s linear infinite"/>
            <circle cx="100" cy="35"  r="5" fill="#4da6ff" opacity=".55"/>
            <circle cx="500" cy="35"  r="5" fill="#4da6ff" opacity=".55"/>
            <circle cx="500" cy="190" r="5" fill="#4da6ff" opacity=".55"/>
            <circle cx="100" cy="190" r="5" fill="#4da6ff" opacity=".55"/>
            <circle cx="100" cy="35"  r="11" fill="#4da6ff" opacity=".07" filter="url(#ge)"/>
            <circle cx="500" cy="35"  r="11" fill="#4da6ff" opacity=".07" filter="url(#ge)"/>
            <circle cx="500" cy="190" r="11" fill="#4da6ff" opacity=".07" filter="url(#ge)"/>
            <circle cx="100" cy="190" r="11" fill="#4da6ff" opacity=".07" filter="url(#ge)"/>
            <rect x="76" y="72" width="48" height="76" rx="7" fill="#0b1220" stroke="#3a6fa8" stroke-width="1.5"/>
            <line x1="88" y1="92"  x2="112" y2="92"  stroke="#4a7fba" stroke-width="2"/>
            <line x1="88" y1="101" x2="112" y2="101" stroke="#4a7fba" stroke-width="2"/>
            <line x1="88" y1="117" x2="112" y2="117" stroke="#4a7fba" stroke-width="2"/>
            <line x1="88" y1="126" x2="112" y2="126" stroke="#4a7fba" stroke-width="2"/>
            <text x="100" y="90"  fill="#ffd166" font-family="'Rajdhani',sans-serif" font-size="13" text-anchor="middle" font-weight="700">+</text>
            <text x="100" y="144" fill="#9ab8d8" font-family="'Share Tech Mono',monospace" font-size="15" text-anchor="middle">\u2212</text>
            <polygon points="93,54 100,46 107,54" fill="#06d6a0" opacity=".85"/>
            <polygon points="93,175 100,183 107,175" fill="#06d6a0" opacity=".85"/>
            <text id="bat-v" x="70" y="110" fill="#ffd166"
              font-family="'Share Tech Mono',monospace"
              font-size="11" font-weight="400" text-anchor="middle"
              transform="rotate(-90,70,110)">4.5V</text>
            <rect x="210" y="168" width="180" height="44" rx="6"
              fill="#0b1220" stroke="#ef476f" stroke-width="1.5" filter="url(#gr)"/>
            <g id="rdots" clip-path="url(#res-clip)"></g>
            <g id="eg-res" clip-path="url(#res-clip)"></g>
            <text id="res-lbl" x="300" y="224"
              fill="#ef476f" font-family="'Share Tech Mono',monospace"
              font-size="11" text-anchor="middle">500 \u03a9</text>
            <rect x="212" y="14" width="176" height="38" rx="5"
              fill="#0b1220" stroke="#06d6a0" stroke-width="1.2"/>
            <text x="300" y="28" fill="#7a9cc4" font-family="'Share Tech Mono',monospace"
              font-size="8" text-anchor="middle" letter-spacing="2">CURRENT</text>
            <text id="cur-svg" x="300" y="46" fill="#06d6a0"
              font-family="'Share Tech Mono',monospace" font-size="14" font-weight="400"
              text-anchor="middle">9.00 mA</text>
            <g id="eg-top"></g>
            <g id="eg-right"></g>
            <g id="eg-bottom-L"></g>
            <g id="eg-bottom-R"></g>
            <g id="eg-left"></g>
          </svg>
        </div>
      </div>

    </div>

    <div style="display:flex;flex-direction:column;gap:14px">

      <div class="pnl">
        <div class="pnl-hdr"><span class="pnl-title">Input Values</span></div>
        <div class="pnl-body">
          <div class="sl-group">
            <div class="sl-top">
              <span class="sl-name">Voltage</span>
              <span class="sl-val sv-V" id="sv-V">4.5 V</span>
            </div>
            <div class="sl-row">
              <span class="sl-b">0.1</span>
              <input type="range" class="trV" id="sl-V" min="0.1" max="12" step="0.1" value="4.5" oninput="Tools._ohmSlide('V',this.value)">
              <span class="sl-b">12</span>
            </div>
          </div>
          <div class="sl-group">
            <div class="sl-top">
              <span class="sl-name">Resistance</span>
              <span class="sl-val sv-R" id="sv-R">500 \u03a9</span>
            </div>
            <div class="sl-row">
              <span class="sl-b">10</span>
              <input type="range" class="trR" id="sl-R" min="10" max="1000" step="10" value="500" oninput="Tools._ohmSlide('R',this.value)">
              <span class="sl-b">1k</span>
            </div>
          </div>
        </div>
      </div>

      <div class="pnl">
        <div class="cur-meter">
          <div class="cur-row">
            <div class="cur-lbl-col">
              <div class="c-lbl">Current Output</div>
              <div class="cur-val" id="cv-big">9.00 mA</div>
            </div>
          </div>
        </div>
        <div style="padding:12px 18px 14px">
          <div class="bar-bg"><div class="bar-fill" id="cur-bar" style="width:0.75%"></div></div>
          <div class="bar-lbs"><span>0 A</span><span>1.2 A max</span></div>
        </div>
      </div>

      <div class="pnl">
        <div class="pnl-hdr"><span class="pnl-title">All Readings</span></div>
        <div class="rg">
          <div class="rc cV"><div class="rc-l">Voltage</div><div class="rc-v" id="rd-V">4.5 V</div></div>
          <div class="rc cI"><div class="rc-l">Current</div><div class="rc-v" id="rd-I">9.00 mA</div></div>
          <div class="rc cR"><div class="rc-l">Resistance</div><div class="rc-v" id="rd-R">500 \u03a9</div></div>
          <div class="rc cP"><div class="rc-l">Power</div><div class="rc-v" id="rd-P">40.5 \u03bcW</div></div>
        </div>
      </div>

    </div>
  </div>
</div>`;
  },

  _ohmV: 4.5,
  _ohmR: 500,
  _ohmResRAF: null,
  _ohmWireIntervals: [],
  _ohmResParticles: [],
  _ohmResNodes: [],
  _ohmSt: null,
  _ohmAnimFrame: null,

  _ohmFmtI(i){ if(i>=1) return i.toFixed(3)+' A'; if(i>=0.001) return (i*1000).toFixed(2)+' mA'; return (i*1e6).toFixed(1)+' \u03bcA'; },
  _ohmFmtV(v){ return v.toFixed(1)+' V'; },
  _ohmFmtR(r){ return r>=1000 ? (r/1000).toFixed(2)+'k\u03a9' : r.toFixed(0)+' \u03a9'; },
  _ohmFmtP(p){ if(p>=1) return p.toFixed(3)+' W'; if(p>=0.001) return (p*1000).toFixed(2)+' mW'; return (p*1e6).toFixed(1)+' \u03bcW'; },

  _ohmFp(id, mn, mx, v){
    const el = document.getElementById(id);
    if (el) el.style.setProperty('--p', ((v-mn)/(mx-mn)*100)+'%');
  },

  _ohmUpdateFormula(I){
    const V = this._ohmV, R = this._ohmR;
    const Vs = 0.6 + 0.7*(V/12);
    const Is = 0.55 + 0.7*(I/1.2);
    const Rs = 0.55 + 0.7*(R/1000);
    const fV = document.getElementById('fl-V');
    const fI = document.getElementById('fl-I');
    const fR = document.getElementById('fl-R');
    if (fV) { fV.style.fontSize = Math.round(118*Vs)+'px'; fV.style.textShadow = `0 0 ${Math.round(20+50*Vs)}px rgba(255,209,102,${(0.2+0.6*Vs).toFixed(2)})`; }
    if (fI) { fI.style.fontSize = Math.round(74*Is)+'px';  fI.style.textShadow = `0 0 ${Math.round(15+40*Is)}px rgba(6,214,160,${(0.15+0.55*Is).toFixed(2)})`; }
    if (fR) { fR.style.fontSize = Math.round(74*Rs)+'px';  fR.style.textShadow = `0 0 ${Math.round(15+40*Rs)}px rgba(239,71,111,${(0.15+0.55*Rs).toFixed(2)})`; }
  },

  _ohmUpdateDots(){
    const g = document.getElementById('rdots'); if (!g) return;
    g.innerHTML = '';
    const n = Math.round(12 + (this._ohmR/1000)*55);
    for (let i=0; i<n; i++){
      const x = 215 + Math.random()*170;
      const y = 171 + Math.random()*38;
      const c = document.createElementNS('http://www.w3.org/2000/svg','circle');
      c.setAttribute('cx', x); c.setAttribute('cy', y);
      c.setAttribute('r', 1.1 + Math.random()*1.6);
      c.setAttribute('fill','#ef476f');
      c.setAttribute('opacity', 0.18 + Math.random()*0.38);
      g.appendChild(c);
    }
  },

  _ohmUpdateWireSpeed(I){
    const el = document.getElementById('cur-wire'); if (!el) return;
    const dur = Math.max(0.05, 1.0 / Math.max(0.005, I * 28));
    el.style.animationDuration = dur + 's';
  },

  _ohmSvgCircle(fill, r, glowFill, glowR){
    const ns = 'http://www.w3.org/2000/svg';
    const g  = document.createElementNS(ns,'g');
    const b  = document.createElementNS(ns,'circle');
    b.setAttribute('r', glowR||6); b.setAttribute('fill', glowFill||fill);
    b.setAttribute('opacity','0.18'); b.setAttribute('filter','url(#ge-soft)');
    const c  = document.createElementNS(ns,'circle');
    c.setAttribute('r', r||2.8); c.setAttribute('fill', fill); c.setAttribute('opacity','0.92');
    g.appendChild(b); g.appendChild(c);
    return { g, c, b };
  },

  _ohmClearWireElectrons(){
    if (this._ohmWireIntervals) { this._ohmWireIntervals.forEach(clearInterval); }
    this._ohmWireIntervals = [];
    ['eg-top','eg-right','eg-bottom-L','eg-bottom-R','eg-left'].forEach(id => {
      const el = document.getElementById(id); if (el) el.innerHTML = '';
    });
  },

  _ohmMakeWireElectron(groupId, axis, fixedCoord, rangeMin, rangeMax, dir, speed){
    const g = document.getElementById(groupId); if (!g) return;
    const {g:node, c, b} = this._ohmSvgCircle('#06d6a0', 2.8, '#06d6a0', 5);
    g.appendChild(node);
    let pos = rangeMin + Math.random()*(rangeMax - rangeMin);
    const id = setInterval(()=>{
      pos += dir * speed;
      if (pos > rangeMax) pos = rangeMin;
      if (pos < rangeMin) pos = rangeMax;
      if (axis==='x'){ c.setAttribute('cx',pos); c.setAttribute('cy',fixedCoord); b.setAttribute('cx',pos); b.setAttribute('cy',fixedCoord); }
      else            { c.setAttribute('cy',pos); c.setAttribute('cx',fixedCoord); b.setAttribute('cy',pos); b.setAttribute('cx',fixedCoord); }
    }, 16);
    this._ohmWireIntervals.push(id);
  },

  _ohmSpawnWireElectrons(I){
    this._ohmClearWireElectrons();
    const spd = Math.max(0.5, Math.min(28, I * 32));
    const cnt = Math.max(1, Math.min(8, Math.round(1 + I * 7)));
    for (let i=0; i<cnt; i++){
      this._ohmMakeWireElectron('eg-top',      'x', 35,  100, 500,  1, spd);
      this._ohmMakeWireElectron('eg-right',    'y', 500,  35, 190,  1, spd);
      this._ohmMakeWireElectron('eg-bottom-L', 'x', 190, 100, 210, -1, spd);
      this._ohmMakeWireElectron('eg-bottom-R', 'x', 190, 390, 500, -1, spd);
      this._ohmMakeWireElectron('eg-left',     'y', 100,  35, 190, -1, spd);
    }
  },

  _ohmClearResElectrons(){
    if (this._ohmResRAF) { cancelAnimationFrame(this._ohmResRAF); this._ohmResRAF = null; }
    this._ohmResParticles = []; this._ohmResNodes = [];
    const g = document.getElementById('eg-res'); if (g) g.innerHTML = '';
  },

  _ohmSpawnResElectrons(I){
    this._ohmClearResElectrons();
    const R = this._ohmR;
    const RX1=212, RX2=388, RY1=170, RY2=210;
    const cnt = Math.max(2, Math.min(14, Math.round(2 + I * 12)));
    const driftSpeed  = Math.max(0.5, Math.min(14, I * 18));
    const bounceAmp   = Math.max(0.5, Math.min(3.5, (R/1000)*3.0 + 0.4));
    const bounceSpeed = driftSpeed * bounceAmp;
    const ns = 'http://www.w3.org/2000/svg';
    const g  = document.getElementById('eg-res'); if (!g) return;
    for (let i=0; i<cnt; i++){
      const x  = RX1 + Math.random()*(RX2-RX1);
      const y  = RY1 + 4 + Math.random()*(RY2-RY1-8);
      const vx = driftSpeed * (0.6 + Math.random()*0.8);
      const vy = bounceSpeed * (Math.random()<0.5?1:-1) * (0.5+Math.random());
      this._ohmResParticles.push({x, y, vx, vy});
      const {g:node, c, b} = this._ohmSvgCircle('#06d6a0', 2.4, '#06d6a0', 5);
      g.appendChild(node);
      this._ohmResNodes.push({c, b});
    }
    const tick = () => {
      for (let i=0; i<this._ohmResParticles.length; i++){
        const p = this._ohmResParticles[i];
        p.x += p.vx; p.y += p.vy;
        if (p.y <= RY1+2){ p.y=RY1+2; p.vy=Math.abs(p.vy); }
        if (p.y >= RY2-2){ p.y=RY2-2; p.vy=-Math.abs(p.vy); }
        if (p.x > RX2+4) p.x = RX1-4;
        if (p.x < RX1-4) p.x = RX2+4;
        const collisionChance = 0.01 + (R/1000)*0.04;
        if (Math.random() < collisionChance){
          p.vy = bounceSpeed * (Math.random()<0.5?1:-1) * (0.5+Math.random());
          p.vx = driftSpeed * (0.4 + Math.random()*0.8);
        }
        const n = this._ohmResNodes[i];
        if (n){ n.c.setAttribute('cx',p.x); n.c.setAttribute('cy',p.y); n.b.setAttribute('cx',p.x); n.b.setAttribute('cy',p.y); }
      }
      this._ohmResRAF = requestAnimationFrame(tick);
    };
    this._ohmResRAF = requestAnimationFrame(tick);
  },

  _ohmRecalc(){
    const V = this._ohmV, R = this._ohmR;
    const I = V / R, P = V * I;
    this._ohmFp('sl-V', 0.1, 12, V);
    this._ohmFp('sl-R', 10, 1000, R);
    const se = (id,t) => { const e=document.getElementById(id); if(e) e.textContent=t; };
    se('sv-V', this._ohmFmtV(V));
    se('sv-R', this._ohmFmtR(R));
    const cs = this._ohmFmtI(I);
    se('cv-big', cs); se('cur-svg', cs);
    const bar = document.getElementById('cur-bar');
    if (bar) bar.style.width = Math.min(100,(I/1.2)*100)+'%';
    se('rd-V', this._ohmFmtV(V));
    se('rd-I', cs);
    se('rd-R', this._ohmFmtR(R));
    se('rd-P', this._ohmFmtP(P));
    se('bat-v', this._ohmFmtV(V).replace(' ',''));
    se('res-lbl', this._ohmFmtR(R));
    this._ohmUpdateFormula(I);
    this._ohmUpdateDots();
    this._ohmUpdateWireSpeed(I);
    this._ohmSpawnWireElectrons(I);
    this._ohmSpawnResElectrons(I);
  },

  _ohmSlide(w, v){
    if (w==='V') this._ohmV = parseFloat(v);
    else         this._ohmR = parseFloat(v);
    this._ohmRecalc();
  },

  _ohmInstrPreset(v, r, btn){
    this._ohmV = v; this._ohmR = r;
    const slV = document.getElementById('sl-V'); if (slV) slV.value = v;
    const slR = document.getElementById('sl-R'); if (slR) slR.value = r;
    document.querySelectorAll('.ohm-inst .chip').forEach(c => c.classList.remove('on'));
    if (btn) btn.classList.add('on');
    this._ohmRecalc();
  },

  _updateOhmSim(){
    Tools._ohmRecalc();
  },


    // ===== SERIES CIRCUIT BUILDER =====
  _simSeries() {
    return `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:0;overflow:hidden;">
        <div style="padding:20px 24px 16px;border-bottom:1px solid rgba(255,255,255,0.06);background:linear-gradient(135deg,rgba(245,158,11,0.06),transparent);">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
            <div style="font-size:1.5rem;">⚡</div>
            <div>
              <div style="font-weight:700;font-size:1rem;">Series Circuit Builder</div>
              <div style="font-size:0.75rem;color:var(--text-muted);">Current is the same everywhere — voltage divides across resistors</div>
            </div>
          </div>
          <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
            <div>
              <label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px;">Source Voltage</label>
              <div style="display:flex;align-items:center;gap:6px;background:var(--bg-input);border:1px solid var(--border);border-radius:10px;padding:4px 10px 4px 4px;">
                <input type="number" id="serSimV" value="120" min="1" max="600" style="width:70px;padding:6px 8px;background:transparent;border:none;outline:none;color:var(--text-primary);font-size:1.1rem;font-weight:700;" oninput="Tools._updateSeriesSim()">
                <span style="font-size:0.85rem;color:var(--accent);font-weight:700;">V</span>
              </div>
            </div>
            <div>
              <label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px;">Resistors</label>
              <select id="serSimN" style="padding:8px 14px;background:var(--bg-input);border:1px solid var(--border);border-radius:10px;color:var(--text-primary);font-weight:600;font-size:0.9rem;" onchange="Tools._updateSeriesSim()">
                <option value="2">2</option><option value="3" selected>3</option><option value="4">4</option><option value="5">5</option>
              </select>
            </div>
            <div id="serSimInputs" style="display:flex;gap:8px;flex-wrap:wrap;flex:1;"></div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1.1fr 0.9fr;gap:0;">
          <div style="padding:20px;border-right:1px solid rgba(255,255,255,0.06);">
            <canvas id="serSimCanvas" width="460" height="320" style="width:100%;border-radius:10px;background:rgba(0,0,0,0.15);"></canvas>
            <div id="serSimCurrentBar" style="margin-top:10px;"></div>
          </div>
          <div id="serSimResults" style="font-size:0.85rem;padding:20px;"></div>
        </div>
      </div>
    `;
  },

  _updateSeriesSim() {
    const v = parseFloat(document.getElementById('serSimV').value) || 120;
    const n = parseInt(document.getElementById('serSimN').value) || 3;
    const inputDiv = document.getElementById('serSimInputs');
    const colors = ['#f59e0b', '#8b5cf6', '#3b82f6', '#22c55e', '#ef4444'];

    // Build resistor inputs if count changed
    const existing = inputDiv.querySelectorAll('input').length;
    if (existing !== n) {
      inputDiv.innerHTML = Array.from({length: n}, (_, i) => `
        <div>
          <label style="font-size:0.65rem;color:${colors[i % colors.length]};display:block;margin-bottom:4px;font-weight:700;">R${i+1} (Ω)</label>
          <input type="number" id="serSimR${i}" value="${[100,200,300,150,250][i] || 100}" min="1" max="100000" style="width:76px;padding:7px 8px;background:var(--bg-input);border:2px solid ${colors[i % colors.length]}33;border-radius:8px;color:var(--text-primary);font-weight:600;font-size:0.9rem;" oninput="Tools._updateSeriesSim()">
        </div>
      `).join('');
    }

    const rs = Array.from({length: n}, (_, i) => parseFloat(document.getElementById('serSimR' + i)?.value) || 100);
    const rt = rs.reduce((s, r) => s + r, 0);
    const it = v / rt;
    const drops = rs.map(r => it * r);
    const powers = rs.map(r => it * it * r);

    // === Premium Canvas Drawing ===
    const canvas = document.getElementById('serSimCanvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      // Background gradient
      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, 'rgba(245,158,11,0.03)'); bg.addColorStop(1, 'rgba(59,130,246,0.03)');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

      const mx = 50, my = 50, mw = W - 100, mh = H - 100;
      const wireY = my + 30;
      const retY = my + mh - 20;

      // Draw wire glow
      ctx.shadowColor = 'rgba(245,158,11,0.15)'; ctx.shadowBlur = 10;
      ctx.strokeStyle = '#374151'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(mx, wireY); ctx.lineTo(mx + mw, wireY); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mx, retY); ctx.lineTo(mx + mw, retY); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mx, wireY); ctx.lineTo(mx, retY); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mx + mw, wireY); ctx.lineTo(mx + mw, retY); ctx.stroke();
      ctx.shadowBlur = 0;

      // Battery on left
      const batX = mx, batMid = (wireY + retY) / 2;
      ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(batX, wireY); ctx.lineTo(batX, batMid - 20); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(batX, retY); ctx.lineTo(batX, batMid + 20); ctx.stroke();
      // Battery plates
      ctx.lineWidth = 5; ctx.strokeStyle = '#f59e0b';
      ctx.beginPath(); ctx.moveTo(batX - 14, batMid - 20); ctx.lineTo(batX + 14, batMid - 20); ctx.stroke();
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(batX - 9, batMid - 8); ctx.lineTo(batX + 9, batMid - 8); ctx.stroke();
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(batX - 14, batMid + 8); ctx.lineTo(batX + 14, batMid + 8); ctx.stroke();
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(batX - 9, batMid + 20); ctx.lineTo(batX + 9, batMid + 20); ctx.stroke();
      // Battery voltage label
      ctx.fillStyle = '#f59e0b'; ctx.font = 'bold 13px Inter,sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(v + 'V', batX, batMid + 38);
      ctx.font = '10px Inter,sans-serif'; ctx.fillStyle = 'rgba(245,158,11,0.6)';
      ctx.fillText('AC', batX, batMid + 50);

      // Resistors along top wire, evenly spaced
      const resistorW = 36, resistorH = 22;
      const rSpacing = (mw - mx - 20) / n;
      rs.forEach((r, i) => {
        const rx = mx + 60 + i * rSpacing + rSpacing * 0.1;
        const ry = wireY - resistorH / 2;
        const color = colors[i % colors.length];

        // Wire connections to resistor
        ctx.strokeStyle = '#4b5563'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(i === 0 ? mx + 5 : rx - 5, wireY); ctx.lineTo(rx, wireY); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(rx + resistorW, wireY); ctx.lineTo(i === n-1 ? mx + mw - 5 : rx + resistorW + 5, wireY); ctx.stroke();

        // Resistor body with glow
        ctx.shadowColor = color + '44'; ctx.shadowBlur = 12;
        const grad = ctx.createLinearGradient(rx, ry, rx + resistorW, ry + resistorH);
        grad.addColorStop(0, color + '33'); grad.addColorStop(0.5, color + '55'); grad.addColorStop(1, color + '33');
        ctx.fillStyle = grad;
        ctx.strokeStyle = color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.roundRect(rx, ry, resistorW, resistorH, 5); ctx.fill(); ctx.stroke();
        ctx.shadowBlur = 0;

        // Resistor value inside
        ctx.fillStyle = color; ctx.font = 'bold 10px Inter,sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(r + 'Ω', rx + resistorW / 2, wireY + 5);

        // Voltage drop above (with arrow)
        ctx.fillStyle = color; ctx.font = 'bold 11px Inter,sans-serif';
        ctx.fillText(drops[i].toFixed(1) + 'V', rx + resistorW / 2, wireY - 18);
        // Small bracket
        ctx.strokeStyle = color + '88'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(rx + 2, wireY - 14); ctx.lineTo(rx + 2, wireY - 4); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(rx + resistorW - 2, wireY - 14); ctx.lineTo(rx + resistorW - 2, wireY - 4); ctx.stroke();

        // R label below
        ctx.fillStyle = 'rgba(156,163,175,0.8)'; ctx.font = '9px Inter,sans-serif';
        ctx.fillText('R' + (i+1), rx + resistorW / 2, wireY + 18);
      });

      // Current flow arrows on return wire
      ctx.fillStyle = '#22c55e'; ctx.font = 'bold 12px Inter,sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('I = ' + (it >= 1 ? it.toFixed(3) + 'A' : (it * 1000).toFixed(2) + 'mA') + '   →', mx + mw / 2, retY + 16);

      // Animated electrons on the wire
      if (!this._serAnimFrame) {
        this._serPhase = 0;
        const animate = () => {
          this._serAnimFrame = requestAnimationFrame(animate);
          const c = document.getElementById('serSimCanvas');
          if (!c) { cancelAnimationFrame(this._serAnimFrame); this._serAnimFrame = null; return; }
          const vv = parseFloat(document.getElementById('serSimV')?.value || 120);
          const nn = parseInt(document.getElementById('serSimN')?.value || 3);
          const rrs = Array.from({length: nn}, (_,ii) => parseFloat(document.getElementById('serSimR'+ii)?.value) || 100);
          const rrt = rrs.reduce((s,r) => s+r, 0);
          const iit = vv / rrt;
          const spd = Math.max(0.3, Math.min(iit * 1.5, 4));
          Tools._serPhase = (Tools._serPhase + spd) % 160;
          Tools._drawSerElectrons(c, Tools._serPhase, iit, nn);
        };
        animate();
      }
    }

    // === Results Panel ===
    const resultsDiv = document.getElementById('serSimResults');
    if (resultsDiv) {
      const totalP = powers.reduce((s,p) => s+p, 0);
      const itStr = it >= 1 ? it.toFixed(4) + 'A' : (it * 1000).toFixed(2) + 'mA';
      resultsDiv.innerHTML = `
        <div style="margin-bottom:16px;">
          <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:10px;">Circuit Summary</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
            <div style="background:linear-gradient(135deg,rgba(245,158,11,0.1),rgba(245,158,11,0.02));border:1px solid rgba(245,158,11,0.2);border-radius:10px;padding:12px;text-align:center;">
              <div style="font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Total R</div>
              <div style="font-size:1.1rem;font-weight:800;color:#f59e0b;">${rt.toFixed(1)}Ω</div>
            </div>
            <div style="background:linear-gradient(135deg,rgba(34,197,94,0.1),rgba(34,197,94,0.02));border:1px solid rgba(34,197,94,0.2);border-radius:10px;padding:12px;text-align:center;">
              <div style="font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Current</div>
              <div style="font-size:1.1rem;font-weight:800;color:#22c55e;">${itStr}</div>
            </div>
          </div>
          <div style="background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.12);border-radius:8px;padding:8px 12px;font-size:0.75rem;color:#22c55e;font-weight:600;margin-bottom:12px;">
            ✓ Current is THE SAME through every component
          </div>
        </div>
        <div style="margin-bottom:14px;">
          <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:8px;">Voltage Drops</div>
          ${rs.map((r, i) => `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <div style="width:10px;height:10px;border-radius:50%;background:${colors[i % colors.length]};flex-shrink:0;"></div>
              <div style="flex:1;font-size:0.8rem;color:var(--text-secondary);">V<sub>${i+1}</sub> = ${it.toFixed(4)} × ${r}Ω</div>
              <div style="font-weight:700;color:${colors[i % colors.length]};font-size:0.85rem;">${drops[i].toFixed(2)}V</div>
            </div>
            <div style="height:4px;background:var(--bg-input);border-radius:2px;margin-bottom:8px;margin-left:18px;">
              <div style="height:100%;width:${(drops[i]/v*100).toFixed(1)}%;background:${colors[i % colors.length]};border-radius:2px;"></div>
            </div>
          `).join('')}
          <div style="font-size:0.72rem;color:var(--text-muted);margin-left:18px;">Sum: ${drops.reduce((s,d)=>s+d,0).toFixed(2)}V = ${v}V ✓</div>
        </div>
        <div>
          <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:8px;">Power Dissipation</div>
          ${rs.map((r, i) => `<div style="display:flex;justify-content:space-between;font-size:0.8rem;padding:3px 0;"><span style="color:${colors[i % colors.length]};">P<sub>${i+1}</sub> (R${i+1})</span><span style="font-weight:600;">${powers[i] >= 1 ? powers[i].toFixed(2)+'W' : (powers[i]*1000).toFixed(1)+'mW'}</span></div>`).join('')}
          <div style="display:flex;justify-content:space-between;font-size:0.85rem;padding:6px 0;border-top:1px solid rgba(255,255,255,0.08);margin-top:4px;"><span style="font-weight:700;color:var(--text-primary);">P Total</span><span style="font-weight:800;color:var(--accent);">${totalP >= 1 ? totalP.toFixed(2)+'W' : (totalP*1000).toFixed(1)+'mW'}</span></div>
        </div>
      `;
    }
  },

  _drawSerElectrons(canvas, phase, current, n) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const numDots = Math.max(3, Math.min(Math.round(Math.abs(current) * 5), 12));
    const wireY = 80, retY = W * 0.55, lx = 50, rx = W - 50;
    // Clockwise path: top-right, down-right, bottom-left, up-left
    const path = [
      ...Array.from({length:20}, (_,j) => ({x: lx + (rx-lx)*j/20, y: wireY})),
      ...Array.from({length:10}, (_,j) => ({x: rx, y: wireY + (retY-wireY)*j/10})),
      ...Array.from({length:20}, (_,j) => ({x: rx - (rx-lx)*j/20, y: retY})),
      ...Array.from({length:10}, (_,j) => ({x: lx, y: retY - (retY-wireY)*j/10})),
    ];
    const totalPts = path.length;
    for (let d = 0; d < numDots; d++) {
      const idx = Math.floor((phase + d * totalPts / numDots)) % totalPts;
      const pt = path[idx];
      if (!pt) continue;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
      const grd = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, 3.5);
      grd.addColorStop(0, '#93c5fd'); grd.addColorStop(1, '#3b82f6');
      ctx.fillStyle = grd; ctx.fill();
      ctx.shadowColor = '#3b82f6'; ctx.shadowBlur = 6;
      ctx.fill(); ctx.shadowBlur = 0;
    }
  },

  // ===== PARALLEL CIRCUIT BUILDER =====
  _simParallel() {
    return `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:20px;overflow:hidden;">
        <!-- Header -->
        <div style="padding:20px 24px 18px;border-bottom:1px solid rgba(255,255,255,0.06);background:linear-gradient(135deg,rgba(139,92,246,0.08),rgba(59,130,246,0.04),transparent);">
          <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;">
            <div style="width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,rgba(139,92,246,0.2),rgba(59,130,246,0.1));border:1px solid rgba(139,92,246,0.3);display:flex;align-items:center;justify-content:center;font-size:1.3rem;">⚡</div>
            <div>
              <div style="font-weight:800;font-size:1.05rem;color:var(--text-primary);">Parallel Circuit Simulator</div>
              <div style="font-size:0.78rem;color:var(--text-muted);margin-top:2px;">Same voltage across every branch — current divides proportionally</div>
            </div>
          </div>
          <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
            <div>
              <label style="font-size:0.68rem;color:var(--text-muted);display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.8px;font-weight:700;">Source Voltage</label>
              <div style="display:flex;align-items:center;gap:0;background:rgba(139,92,246,0.07);border:1.5px solid rgba(139,92,246,0.3);border-radius:10px;overflow:hidden;">
                <input type="number" id="parSimV" value="120" min="1" max="600" style="width:75px;padding:9px 10px;background:transparent;border:none;outline:none;color:#c4b5fd;font-size:1.15rem;font-weight:800;" oninput="Tools._updateParallelSim()">
                <span style="padding:0 12px;font-size:0.9rem;color:#8b5cf6;font-weight:800;border-left:1px solid rgba(139,92,246,0.2);">V</span>
              </div>
            </div>
            <div>
              <label style="font-size:0.68rem;color:var(--text-muted);display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.8px;font-weight:700;">Branches</label>
              <select id="parSimN" style="padding:9px 14px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:10px;color:var(--text-primary);font-weight:700;font-size:0.95rem;" onchange="Tools._updateParallelSim()">
                <option value="2">2</option><option value="3" selected>3</option><option value="4">4</option><option value="5">5</option>
              </select>
            </div>
            <div id="parSimInputs" style="display:flex;gap:10px;flex-wrap:wrap;flex:1;"></div>
          </div>
        </div>
        <!-- Canvas + Results two-col -->
        <div style="display:grid;grid-template-columns:1.15fr 0.85fr;gap:0;">
          <div style="padding:20px;border-right:1px solid rgba(255,255,255,0.05);">
            <canvas id="parSimCanvas" width="480" height="380" style="width:100%;border-radius:14px;background:#0a0a12;display:block;"></canvas>
          </div>
          <div id="parSimResults" style="padding:20px;overflow-y:auto;"></div>
        </div>
      </div>
    `;
  },

  _updateParallelSim() {
    const v = parseFloat(document.getElementById('parSimV')?.value) || 120;
    const n = parseInt(document.getElementById('parSimN')?.value) || 3;
    const inputDiv = document.getElementById('parSimInputs');
    if (!inputDiv) return;
    const colors = ['#f59e0b','#8b5cf6','#3b82f6','#22c55e','#ef4444'];

    // Rebuild resistor inputs only if count changed
    const existing = inputDiv.querySelectorAll('input').length;
    if (existing !== n) {
      inputDiv.innerHTML = Array.from({length:n},(_,i)=>`
        <div>
          <label style="font-size:0.68rem;color:${colors[i%colors.length]};display:block;margin-bottom:5px;font-weight:800;letter-spacing:0.3px;">R${i+1} (Ω)</label>
          <input type="number" id="parSimR${i}" value="${[100,200,300,150,250][i]||100}" min="1" max="100000"
            style="width:80px;padding:8px 10px;background:${colors[i%colors.length]}14;border:2px solid ${colors[i%colors.length]}44;border-radius:9px;color:var(--text-primary);font-weight:700;font-size:0.95rem;outline:none;"
            oninput="Tools._updateParallelSim()">
        </div>`).join('');
    }

    const rs = Array.from({length:n},(_,i)=>parseFloat(document.getElementById('parSimR'+i)?.value)||100);
    const rt = 1/rs.reduce((s,r)=>s+1/r,0);
    const it = v/rt;
    const branches = rs.map(r=>v/r);
    const powers = rs.map(r=>v*v/r);
    const maxI = Math.max(...branches);

    // ── Start / restart animation ──
    if (this._parAnimFrame) { cancelAnimationFrame(this._parAnimFrame); this._parAnimFrame = null; }
    this._parPhase = 0;
    this._parV = v; this._parN = n; this._parRs = rs;
    this._parBranches = branches; this._parIt = it;

    const animate = () => {
      this._parAnimFrame = requestAnimationFrame(animate);
      const canvas = document.getElementById('parSimCanvas');
      if (!canvas) { cancelAnimationFrame(this._parAnimFrame); this._parAnimFrame = null; return; }
      this._parPhase = (this._parPhase||0) + 0.8;
      Tools._drawParallelCanvas(canvas, this._parV, this._parN, this._parRs, this._parBranches, this._parIt, this._parPhase);
    };
    animate();

    // ── Results panel ──
    const resultsDiv = document.getElementById('parSimResults');
    if (!resultsDiv) return;
    const totalP = powers.reduce((s,p)=>s+p,0);
    const fmtI = i => i>=1 ? i.toFixed(3)+'A' : (i*1000).toFixed(1)+'mA';

    resultsDiv.innerHTML = `
      <!-- Stat row -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
        <div style="background:linear-gradient(135deg,rgba(139,92,246,0.12),rgba(139,92,246,0.03));border:1px solid rgba(139,92,246,0.25);border-radius:12px;padding:14px;text-align:center;">
          <div style="font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px;">Total R</div>
          <div style="font-size:1.25rem;font-weight:900;color:#a78bfa;">${rt.toFixed(2)}Ω</div>
          <div style="font-size:0.65rem;color:var(--text-muted);margin-top:3px;">&lt; ${Math.min(...rs)}Ω smallest</div>
        </div>
        <div style="background:linear-gradient(135deg,rgba(34,197,94,0.12),rgba(34,197,94,0.03));border:1px solid rgba(34,197,94,0.25);border-radius:12px;padding:14px;text-align:center;">
          <div style="font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px;">Total I</div>
          <div style="font-size:1.25rem;font-weight:900;color:#4ade80;">${fmtI(it)}</div>
          <div style="font-size:0.65rem;color:var(--text-muted);margin-top:3px;">sum of all branches</div>
        </div>
      </div>
      <!-- Voltage rule -->
      <div style="background:rgba(139,92,246,0.07);border:1px solid rgba(139,92,246,0.18);border-radius:10px;padding:10px 13px;font-size:0.78rem;color:#a78bfa;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px;">
        <span style="font-size:1rem;">🔁</span> Every branch sees exactly <strong>${v}V</strong>
      </div>
      <!-- Branch currents -->
      <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);font-weight:700;margin-bottom:10px;">Branch Currents</div>
      ${rs.map((r,i)=>{
        const iStr=fmtI(branches[i]);
        const pct=(branches[i]/it*100).toFixed(0);
        return `
        <div style="margin-bottom:12px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <div style="width:11px;height:11px;border-radius:50%;background:${colors[i%colors.length]};box-shadow:0 0 6px ${colors[i%colors.length]}88;flex-shrink:0;"></div>
              <span style="font-size:0.82rem;color:var(--text-secondary);">I<sub>${i+1}</sub> = ${v}V ÷ ${r}Ω</span>
            </div>
            <span style="font-weight:800;color:${colors[i%colors.length]};font-size:0.88rem;">${iStr}</span>
          </div>
          <div style="height:7px;background:rgba(255,255,255,0.05);border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,${colors[i%colors.length]}cc,${colors[i%colors.length]});border-radius:4px;transition:width 0.4s ease;box-shadow:0 0 8px ${colors[i%colors.length]}55;"></div>
          </div>
          <div style="font-size:0.68rem;color:var(--text-muted);margin-top:3px;text-align:right;">${pct}% of total</div>
        </div>`;
      }).join('')}
      <div style="font-size:0.72rem;color:var(--text-muted);padding:8px 0;border-top:1px solid rgba(255,255,255,0.06);margin-top:2px;">
        Sum: ${fmtI(branches.reduce((s,b)=>s+b,0))} = ${fmtI(it)} ✓
      </div>
      <!-- Power -->
      <div style="margin-top:14px;">
        <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);font-weight:700;margin-bottom:8px;">Power Dissipation</div>
        ${rs.map((r,i)=>`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <span style="font-size:0.82rem;color:${colors[i%colors.length]};font-weight:600;">P<sub>${i+1}</sub></span>
            <span style="font-size:0.82rem;font-weight:700;color:var(--text-primary);">${powers[i]>=1?powers[i].toFixed(1)+'W':(powers[i]*1000).toFixed(1)+'mW'}</span>
          </div>`).join('')}
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;margin-top:2px;">
          <span style="font-size:0.9rem;font-weight:800;color:var(--text-primary);">P Total</span>
          <span style="font-size:1rem;font-weight:900;color:#a78bfa;">${totalP>=1?totalP.toFixed(1)+'W':(totalP*1000).toFixed(1)+'mW'}</span>
        </div>
      </div>
    `;
  },

  _drawParallelCanvas(canvas, v, n, rs, branches, it, phase) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const colors = ['#f59e0b','#8b5cf6','#3b82f6','#22c55e','#ef4444'];
    const maxI = Math.max(...branches);

    ctx.clearRect(0,0,W,H);

    // Dark background with subtle vignette
    const bgGrad = ctx.createRadialGradient(W/2,H/2,0,W/2,H/2,W*0.7);
    bgGrad.addColorStop(0,'#0f0f1c'); bgGrad.addColorStop(1,'#070710');
    ctx.fillStyle = bgGrad; ctx.fillRect(0,0,W,H);

    // Grid dots
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    for(let gx=20;gx<W;gx+=24) for(let gy=20;gy<H;gy+=24) { ctx.beginPath(); ctx.arc(gx,gy,1,0,Math.PI*2); ctx.fill(); }

    const busLX = 110, busRX = W - 50;
    const topY = 38, botY = H - 38;
    const usableH = botY - topY;
    const branchSpacing = usableH / n;

    // ── Draw branches first (behind bus bars) ──
    rs.forEach((r,i) => {
      const branchY = topY + i * branchSpacing + branchSpacing / 2;
      const color = colors[i % colors.length];
      const branchFraction = branches[i] / it;
      // Wire thickness proportional to current (2-7px)
      const wireW = 2 + branchFraction * 5;

      const resW = 68, resH = 28;
      const resCX = (busLX + busRX) / 2;
      const resX = resCX - resW/2, resY = branchY - resH/2;

      // Left wire: busL → resistor
      ctx.strokeStyle = color + 'aa'; ctx.lineWidth = wireW;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(busLX, branchY); ctx.lineTo(resX, branchY); ctx.stroke();
      // Right wire: resistor → busR
      ctx.beginPath(); ctx.moveTo(resX+resW, branchY); ctx.lineTo(busRX, branchY); ctx.stroke();

      // Wire glow
      ctx.shadowColor = color; ctx.shadowBlur = 8;
      ctx.strokeStyle = color + '44'; ctx.lineWidth = wireW + 4;
      ctx.beginPath(); ctx.moveTo(busLX, branchY); ctx.lineTo(resX, branchY); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(resX+resW, branchY); ctx.lineTo(busRX, branchY); ctx.stroke();
      ctx.shadowBlur = 0;

      // ── Resistor body ──
      // Outer glow rect
      ctx.shadowColor = color; ctx.shadowBlur = 18;
      const resGrad = ctx.createLinearGradient(resX, resY, resX+resW, resY+resH);
      resGrad.addColorStop(0, color+'33'); resGrad.addColorStop(0.5, color+'55'); resGrad.addColorStop(1, color+'33');
      ctx.fillStyle = resGrad;
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(resX, resY, resW, resH, 7); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0;

      // Zig-zag inside the resistor box
      const zigX1 = resX+6, zigX2 = resX+resW-6, zigY = branchY;
      const zigW = zigX2-zigX1, zigCount = 5, zigH = 6;
      const zigStep = zigW / (zigCount*2);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(zigX1, zigY);
      for(let z=0;z<zigCount;z++){
        ctx.lineTo(zigX1+(z*2+1)*zigStep, zigY-zigH);
        ctx.lineTo(zigX1+(z*2+2)*zigStep, zigY+zigH);
      }
      ctx.stroke();

      // Resistor value label above the box
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px Inter,sans-serif'; ctx.textAlign = 'center';
      ctx.shadowColor = color; ctx.shadowBlur = 6;
      ctx.fillText(r>=1000?(r/1000).toFixed(1)+'kΩ':r+'Ω', resCX, resY-6);
      ctx.shadowBlur = 0;

      // R label below
      ctx.fillStyle = color+'aa'; ctx.font = '600 9px Inter,sans-serif';
      ctx.fillText('R'+(i+1), resCX, resY+resH+11);

      // Current label on left wire
      const iStr = branches[i]>=1 ? branches[i].toFixed(3)+'A' : (branches[i]*1000).toFixed(1)+'mA';
      ctx.fillStyle = color; ctx.font = 'bold 11px Inter,sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('I'+(i+1)+' = '+iStr, busLX+10, branchY-10);

      // ── Animated current particles ──
      const numParticles = Math.max(2, Math.round(branchFraction * 8));
      const totalLen = (resX - busLX) + resW + (busRX - (resX+resW));
      for(let p=0;p<numParticles;p++){
        const offset = (phase * (1 + branchFraction * 0.5) + p * (100/numParticles)) % 100;
        const dist = (offset/100) * totalLen;
        let px, py = branchY;
        if(dist < resX - busLX) { px = busLX + dist; }
        else if(dist < resX - busLX + resW) { px = resX + (dist - (resX-busLX)); }
        else { px = resX + resW + (dist - (resX-busLX+resW)); }

        // Particle
        const pGrad = ctx.createRadialGradient(px,py,0,px,py,4);
        pGrad.addColorStop(0,'#fff'); pGrad.addColorStop(0.4,color); pGrad.addColorStop(1,'transparent');
        ctx.fillStyle = pGrad;
        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI*2); ctx.fill();
        // Tail
        ctx.strokeStyle = color+'55'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        const tailLen = 8 + branchFraction * 6;
        const tailDist = Math.max(0, dist - tailLen);
        let tx, ty = py;
        if(tailDist < resX-busLX) tx = busLX+tailDist;
        else if(tailDist < resX-busLX+resW) tx = resX+(tailDist-(resX-busLX));
        else tx = resX+resW+(tailDist-(resX-busLX+resW));
        ctx.moveTo(tx, ty); ctx.lineTo(px, py); ctx.stroke();
      }
    });

    // ── Left bus bar (hot) ──
    const busGradL = ctx.createLinearGradient(0,topY,0,botY);
    busGradL.addColorStop(0,'#a78bfa'); busGradL.addColorStop(1,'#7c3aed');
    ctx.shadowColor = '#8b5cf6'; ctx.shadowBlur = 20;
    ctx.strokeStyle = busGradL; ctx.lineWidth = 7; ctx.lineCap = 'square';
    ctx.beginPath(); ctx.moveTo(busLX,topY); ctx.lineTo(busLX,botY); ctx.stroke();
    ctx.shadowBlur = 0;
    // "+" label
    ctx.fillStyle = '#a78bfa'; ctx.font = 'bold 14px Inter,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('+', busLX, topY-14);

    // ── Right bus bar (return) ──
    ctx.shadowColor = '#475569'; ctx.shadowBlur = 8;
    ctx.strokeStyle = '#475569'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(busRX,topY); ctx.lineTo(busRX,botY); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#64748b'; ctx.font = 'bold 14px Inter,sans-serif';
    ctx.fillText('−', busRX, topY-14);

    // ── Battery (below left bus) ──
    const batX = 52, batTopY = topY + 10, batBotY = botY - 10, batMid = (batTopY+batBotY)/2;
    // wire from bus top to battery top
    ctx.strokeStyle = '#475569'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(busLX,topY); ctx.lineTo(busLX,topY); ctx.stroke();
    // vertical wires
    ctx.beginPath(); ctx.moveTo(batX,batTopY); ctx.lineTo(batX,batMid-22); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(batX,batBotY); ctx.lineTo(batX,batMid+22); ctx.stroke();
    // horizontal connectors to bus
    ctx.beginPath(); ctx.moveTo(batX,batTopY); ctx.lineTo(busLX,topY+6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(batX,batBotY); ctx.lineTo(busLX,botY-6); ctx.stroke();
    // Battery plates (5 pairs)
    const plateSep = 8;
    for(let pi=0;pi<4;pi++){
      const py2 = batMid - 14 + pi*plateSep;
      const thick = pi%2===0;
      ctx.strokeStyle = thick?'#a78bfa':'#64748b';
      ctx.lineWidth = thick?4:2;
      const hw = thick?13:9;
      ctx.beginPath(); ctx.moveTo(batX-hw,py2); ctx.lineTo(batX+hw,py2); ctx.stroke();
    }
    // Voltage label
    ctx.fillStyle = '#a78bfa'; ctx.font = 'bold 13px Inter,sans-serif'; ctx.textAlign = 'center';
    ctx.shadowColor='#8b5cf6'; ctx.shadowBlur=8;
    ctx.fillText(v+'V', batX, batMid+34);
    ctx.shadowBlur=0;

    // ── Total current label at top ──
    const itStr = it>=1 ? it.toFixed(3)+'A' : (it*1000).toFixed(1)+'mA';
    ctx.fillStyle='#4ade80'; ctx.font='bold 13px Inter,sans-serif'; ctx.textAlign='left';
    ctx.shadowColor='#22c55e'; ctx.shadowBlur=8;
    ctx.fillText('IT = '+itStr, busLX+12, topY-14);
    ctx.shadowBlur=0;

    // ── V label at bottom ──
    ctx.fillStyle='rgba(167,139,250,0.6)'; ctx.font='600 10px Inter,sans-serif'; ctx.textAlign='center';
    ctx.fillText('V = '+v+'V across all branches', (busLX+busRX)/2, botY+20);
  },

  // ===== CEC WIRE SIZER =====
  _simWireSizer() {
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
          <div style="padding:18px 20px;background:linear-gradient(135deg,rgba(34,197,94,0.06),transparent);border-bottom:1px solid rgba(255,255,255,0.05);">
            <div style="font-weight:700;font-size:0.95rem;margin-bottom:14px;">⚡ Load Parameters</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
              <div>
                <label style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:5px;">Load Current</label>
                <div style="display:flex;align-items:center;gap:4px;">
                  <input type="number" id="wireCurrent" value="40" min="1" max="400" style="flex:1;padding:9px 12px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:8px;color:var(--text-primary);font-weight:700;font-size:1rem;" oninput="Tools._updateWireSizer()">
                  <span style="font-size:0.8rem;color:#22c55e;font-weight:600;">A</span>
                </div>
              </div>
              <div>
                <label style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:5px;">Insulation</label>
                <select id="wireTemp" style="width:100%;padding:9px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-weight:600;" onchange="Tools._updateWireSizer()">
                  <option value="60">60°C (TW)</option><option value="75" selected>75°C (T90)</option><option value="90">90°C (FT4)</option>
                </select>
              </div>
            </div>
          </div>
          <div id="wireSizerResult" style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.05);"></div>
          <div style="padding:0 20px 20px;">
            <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin:14px 0 8px;">CEC Table 2 — Copper Conductors</div>
            <div style="overflow-x:auto;max-height:340px;overflow-y:auto;">
              <table style="width:100%;border-collapse:collapse;font-size:0.78rem;">
                <thead style="position:sticky;top:0;z-index:1;">
                  <tr style="background:#1a1a2e;">
                    <th style="padding:7px 8px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.1);color:var(--text-muted);font-size:0.65rem;text-transform:uppercase;">AWG</th>
                    <th style="padding:7px 8px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.1);color:var(--text-muted);font-size:0.65rem;text-transform:uppercase;">mm²</th>
                    <th style="padding:7px 8px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.1);color:var(--text-muted);font-size:0.65rem;text-transform:uppercase;">60°C</th>
                    <th style="padding:7px 8px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.1);color:var(--text-muted);font-size:0.65rem;text-transform:uppercase;">75°C</th>
                    <th style="padding:7px 8px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.1);color:var(--text-muted);font-size:0.65rem;text-transform:uppercase;">90°C</th>
                  </tr>
                </thead>
                <tbody>
                  ${this._wireSizerData.map(w => `
                    <tr id="wireRow_${w.awg.replace('/','_')}" style="border-bottom:1px solid rgba(255,255,255,0.04);transition:background 0.2s;">
                      <td style="padding:6px 8px;font-weight:700;">${w.awg}</td>
                      <td style="padding:6px 8px;text-align:center;color:var(--text-muted);">${w.area}</td>
                      <td style="padding:6px 8px;text-align:center;">${w.amp60}A</td>
                      <td style="padding:6px 8px;text-align:center;">${w.amp75}A</td>
                      <td style="padding:6px 8px;text-align:center;">${w.amp90}A</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:16px;">
          <div style="font-weight:700;font-size:0.95rem;">📊 Conductor Size Comparison</div>
          <canvas id="wireSizerCanvas" width="420" height="360" style="border-radius:10px;width:100%;"></canvas>
          <div style="padding:12px;background:rgba(34,197,94,0.04);border:1px solid rgba(34,197,94,0.1);border-radius:10px;font-size:0.75rem;color:var(--text-secondary);line-height:1.8;">
            <strong style="color:#22c55e;">Tip:</strong> Canadian code (CEC Rule 4-004) requires conductors rated at 125% for continuous loads. Always check applicable derating factors for ambient temperature and conduit fill.
          </div>
        </div>
      </div>
    `;
  },

  _wireSizerData: [
    { awg: '14', area: 2.08, amp60: 15, amp75: 15, amp90: 15 },
    { awg: '12', area: 3.31, amp60: 20, amp75: 20, amp90: 20 },
    { awg: '10', area: 5.26, amp60: 30, amp75: 30, amp90: 30 },
    { awg: '8', area: 8.37, amp60: 40, amp75: 45, amp90: 50 },
    { awg: '6', area: 13.3, amp60: 55, amp75: 65, amp90: 70 },
    { awg: '4', area: 21.2, amp60: 70, amp75: 85, amp90: 95 },
    { awg: '3', area: 26.7, amp60: 85, amp75: 100, amp90: 110 },
    { awg: '2', area: 33.6, amp60: 95, amp75: 115, amp90: 130 },
    { awg: '1', area: 42.4, amp60: 110, amp75: 130, amp90: 145 },
    { awg: '1/0', area: 53.5, amp60: 125, amp75: 150, amp90: 170 },
    { awg: '2/0', area: 67.4, amp60: 145, amp75: 175, amp90: 195 },
    { awg: '3/0', area: 85.0, amp60: 165, amp75: 200, amp90: 225 },
    { awg: '4/0', area: 107, amp60: 195, amp75: 230, amp90: 260 },
    { awg: '250', area: 127, amp60: 215, amp75: 255, amp90: 290 },
    { awg: '300', area: 152, amp60: 240, amp75: 285, amp90: 320 },
  ],

  _updateWireSizer() {
    const current = parseFloat(document.getElementById('wireCurrent').value) || 0;
    const temp = document.getElementById('wireTemp').value;
    const key = 'amp' + temp;
    const data = this._wireSizerData;
    const match = data.find(w => w[key] >= current);
    const resultDiv = document.getElementById('wireSizerResult');
    if (resultDiv) {
      if (match) {
        const utilPct = Math.round((current / match[key]) * 100);
        const utilColor = utilPct > 90 ? '#ef4444' : utilPct > 75 ? '#f59e0b' : '#22c55e';
        resultDiv.innerHTML = `
          <div style="background:rgba(34,197,94,0.07);border:1px solid rgba(34,197,94,0.2);border-radius:12px;padding:14px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <div><div style="font-size:0.65rem;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.5px;">Minimum Size</div>
              <div style="font-size:1.5rem;font-weight:900;color:#22c55e;">AWG ${match.awg}</div></div>
              <div style="text-align:right;"><div style="font-size:0.65rem;text-transform:uppercase;color:var(--text-muted);">Utilization</div>
              <div style="font-size:1.5rem;font-weight:900;color:${utilColor};">${utilPct}%</div></div>
            </div>
            <div style="height:6px;background:rgba(255,255,255,0.07);border-radius:3px;overflow:hidden;margin-bottom:6px;">
              <div style="height:100%;width:${utilPct}%;background:${utilColor};border-radius:3px;transition:width 0.3s;"></div>
            </div>
            <div style="font-size:0.75rem;color:var(--text-secondary);">${match.area} mm² · rated ${match[key]}A · ${temp}°C insulation</div>
          </div>`;
      } else {
        resultDiv.innerHTML = '<div style="padding:14px;background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.2);border-radius:12px;"><strong style="color:#ef4444;">⚠ Exceeds table range</strong><div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px;">Consult CEC Table 2 for conductors larger than 300 kcmil.</div></div>';
      }
    }
    // Highlight matching row
    data.forEach(w => {
      const row = document.getElementById('wireRow_' + w.awg.replace('/', '_'));
      if (row) {
        if (match && w.awg === match.awg) {
          row.style.background = 'rgba(34,197,94,0.15)';
          row.style.boxShadow = 'inset 3px 0 0 #22c55e';
        } else {
          row.style.background = 'transparent';
          row.style.boxShadow = 'none';
        }
      }
    });
    // Draw canvas bar chart
    const c = document.getElementById('wireSizerCanvas');
    if (!c) return;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    // Dark background
    ctx.fillStyle = '#0d0d1a';
    ctx.beginPath(); ctx.roundRect(0, 0, W, H, 10); ctx.fill();

    const maxAmp = 320;
    const barW = Math.floor((W - 40) / data.length) - 3;
    const chartH = H - 70;
    const startX = 20;

    data.forEach((w, i) => {
      const amp = w[key];
      const barH = (amp / maxAmp) * chartH;
      const x = startX + i * (barW + 3);
      const y = H - 40 - barH;
      const isMatch = match && w.awg === match.awg;
      const isTooSmall = amp < current;

      // Bar color
      let barColor = isTooSmall ? 'rgba(239,68,68,0.35)' : isMatch ? '#22c55e' : 'rgba(34,197,94,0.2)';
      if (isMatch) {
        ctx.shadowColor = '#22c55e';
        ctx.shadowBlur = 12;
      } else {
        ctx.shadowBlur = 0;
      }

      const grad = ctx.createLinearGradient(0, y, 0, y + barH);
      if (isMatch) {
        grad.addColorStop(0, '#22c55e');
        grad.addColorStop(1, 'rgba(34,197,94,0.4)');
      } else if (isTooSmall) {
        grad.addColorStop(0, 'rgba(239,68,68,0.6)');
        grad.addColorStop(1, 'rgba(239,68,68,0.2)');
      } else {
        grad.addColorStop(0, 'rgba(34,197,94,0.5)');
        grad.addColorStop(1, 'rgba(34,197,94,0.1)');
      }
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.roundRect(x, y, barW, barH, [4, 4, 0, 0]); ctx.fill();
      ctx.shadowBlur = 0;

      // Amp label on top of bar
      ctx.fillStyle = isMatch ? '#22c55e' : 'rgba(255,255,255,0.4)';
      ctx.font = isMatch ? 'bold 9px Inter' : '8px Inter';
      ctx.textAlign = 'center';
      if (barH > 16) ctx.fillText(amp + 'A', x + barW / 2, y - 3);

      // AWG label at bottom
      ctx.fillStyle = isMatch ? '#22c55e' : 'rgba(255,255,255,0.45)';
      ctx.font = isMatch ? 'bold 8px Inter' : '7.5px Inter';
      ctx.fillText(w.awg, x + barW / 2, H - 25);
    });

    // Load line
    const loadY = H - 40 - (current / maxAmp) * chartH;
    if (current > 0 && current <= maxAmp) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath(); ctx.moveTo(startX, loadY); ctx.lineTo(W - 10, loadY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f59e0b';
      ctx.font = 'bold 9px Inter';
      ctx.textAlign = 'left';
      ctx.fillText('Load: ' + current + 'A', startX + 4, loadY - 4);
    }

    // X-axis line
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(startX, H - 40); ctx.lineTo(W - 10, H - 40); ctx.stroke();

    // Legend
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '8.5px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('AWG / kcmil — CEC Table 2 Ampacity', W / 2, H - 6);
  },

  // ===== AC WAVEFORM VIEWER =====
  _simACWave() {
    const waveType = this._acWaveType || 'sine';
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:24px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
            <h3 style="margin:0;font-size:1rem;">Waveform Controls</h3>
            <div style="display:flex;gap:2px;background:var(--bg-input);border-radius:8px;padding:2px;">
              <button onclick="Tools._acWaveType='sine';Tools._updateACSim()" style="padding:3px 8px;border:none;border-radius:5px;font-size:0.65rem;font-weight:700;cursor:pointer;background:${waveType==='sine'?'var(--accent)':'transparent'};color:${waveType==='sine'?'#000':'var(--text-muted)'};">Sine</button>
              <button onclick="Tools._acWaveType='square';Tools._updateACSim()" style="padding:3px 8px;border:none;border-radius:5px;font-size:0.65rem;font-weight:700;cursor:pointer;background:${waveType==='square'?'var(--accent)':'transparent'};color:${waveType==='square'?'#000':'var(--text-muted)'};">Square</button>
              <button onclick="Tools._acWaveType='triangle';Tools._updateACSim()" style="padding:3px 8px;border:none;border-radius:5px;font-size:0.65rem;font-weight:700;cursor:pointer;background:${waveType==='triangle'?'var(--accent)':'transparent'};color:${waveType==='triangle'?'#000':'var(--text-muted)'};">Triangle</button>
            </div>
          </div>
          <div style="margin-bottom:14px;">
            <label style="font-size:0.8rem;color:var(--text-muted);display:flex;justify-content:space-between;"><span>Peak Voltage (Vpk)</span><strong id="acSimVpk_val" style="color:var(--accent);">170 V</strong></label>
            <input type="range" id="acSimVpk" min="10" max="680" value="170" style="width:100%;" oninput="Tools._updateACSim()">
          </div>
          <div style="margin-bottom:14px;">
            <label style="font-size:0.8rem;color:var(--text-muted);display:flex;justify-content:space-between;"><span>Frequency (Hz)</span><strong id="acSimF_val" style="color:#8b5cf6;">60 Hz</strong></label>
            <input type="range" id="acSimF" min="10" max="400" value="60" class="range-purple" style="width:100%;" oninput="Tools._updateACSim()">
          </div>
          <div style="margin-bottom:14px;">
            <label style="font-size:0.8rem;color:var(--text-muted);display:flex;justify-content:space-between;"><span>Phase Shift</span><strong id="acSimPhi_val" style="color:#22c55e;">0&deg;</strong></label>
            <input type="range" id="acSimPhi" min="0" max="360" value="0" class="range-green" style="width:100%;" oninput="Tools._updateACSim()">
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
            <div style="background:linear-gradient(135deg,rgba(239,68,68,0.08),transparent);border:1px solid rgba(239,68,68,0.12);border-radius:8px;padding:10px;text-align:center;">
              <div style="font-size:0.55rem;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.5px;">Vpeak</div>
              <div id="acSimPeak" style="font-size:1rem;font-weight:800;color:#ef4444;">170.0 V</div>
            </div>
            <div style="background:linear-gradient(135deg,rgba(34,197,94,0.08),transparent);border:1px solid rgba(34,197,94,0.12);border-radius:8px;padding:10px;text-align:center;">
              <div style="font-size:0.55rem;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.5px;">Vrms</div>
              <div id="acSimRms" style="font-size:1rem;font-weight:800;color:#22c55e;">120.2 V</div>
            </div>
            <div style="background:linear-gradient(135deg,rgba(59,130,246,0.08),transparent);border:1px solid rgba(59,130,246,0.12);border-radius:8px;padding:10px;text-align:center;">
              <div style="font-size:0.55rem;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.5px;">Vavg</div>
              <div id="acSimAvg" style="font-size:1rem;font-weight:800;color:#3b82f6;">108.3 V</div>
            </div>
            <div style="background:linear-gradient(135deg,rgba(245,158,11,0.08),transparent);border:1px solid rgba(245,158,11,0.12);border-radius:8px;padding:10px;text-align:center;">
              <div style="font-size:0.55rem;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.5px;">Vpp</div>
              <div id="acSimPP" style="font-size:1rem;font-weight:800;color:#f59e0b;">340.0 V</div>
            </div>
            <div style="background:var(--bg-input);border-radius:8px;padding:10px;text-align:center;">
              <div style="font-size:0.55rem;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.5px;">Period</div>
              <div id="acSimPeriod" style="font-size:1rem;font-weight:800;">16.67 ms</div>
            </div>
            <div style="background:var(--bg-input);border-radius:8px;padding:10px;text-align:center;">
              <div style="font-size:0.55rem;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.5px;">Phase</div>
              <div id="acSimWL" style="font-size:1rem;font-weight:800;">0&deg;</div>
            </div>
          </div>
          <div style="margin-top:12px;padding:10px;background:rgba(139,92,246,0.04);border:1px solid rgba(139,92,246,0.08);border-radius:8px;font-size:0.75rem;color:var(--text-secondary);line-height:1.8;font-family:'Fira Code',monospace;">
            Vrms = Vpk &times; 0.707<br>Vavg = Vpk &times; 0.637<br>Vpp = Vpk &times; 2<br>T = 1/f
          </div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:24px;display:flex;flex-direction:column;align-items:center;">
          <canvas id="acSimCanvas" width="380" height="300" style="border-radius:10px;"></canvas>
          <div style="display:flex;gap:16px;margin-top:12px;font-size:0.7rem;">
            <span style="color:#f59e0b;">&#x25CF; Waveform</span>
            <span style="color:#ef4444;">- - Peak</span>
            <span style="color:#22c55e;">- - RMS</span>
            <span style="color:#3b82f6;">- - Average</span>
          </div>
        </div>
      </div>
    `;
  },

  _acWaveType: 'sine',
  _updateACSim() {
    const vpk = parseFloat(document.getElementById('acSimVpk')?.value || 170);
    const f = parseFloat(document.getElementById('acSimF')?.value || 60);
    const phi = parseFloat(document.getElementById('acSimPhi')?.value || 0);
    const rms = vpk * 0.707;
    const avg = vpk * 0.637;
    if (document.getElementById('acSimVpk_val')) document.getElementById('acSimVpk_val').textContent = vpk + ' V';
    if (document.getElementById('acSimF_val')) document.getElementById('acSimF_val').textContent = f + ' Hz';
    if (document.getElementById('acSimPhi_val')) document.getElementById('acSimPhi_val').innerHTML = phi + '&deg;';
    if (document.getElementById('acSimPeak')) document.getElementById('acSimPeak').textContent = vpk.toFixed(1) + ' V';
    if (document.getElementById('acSimRms')) document.getElementById('acSimRms').textContent = rms.toFixed(1) + ' V';
    if (document.getElementById('acSimAvg')) document.getElementById('acSimAvg').textContent = avg.toFixed(1) + ' V';
    if (document.getElementById('acSimPP')) document.getElementById('acSimPP').textContent = (vpk * 2).toFixed(1) + ' V';
    if (document.getElementById('acSimPeriod')) document.getElementById('acSimPeriod').textContent = (1000 / f).toFixed(2) + ' ms';
    if (document.getElementById('acSimWL')) document.getElementById('acSimWL').innerHTML = phi + '&deg;';
    Tools._drawACWave(vpk, f);
  },

  _acAnimPhase: 0,

  _drawACWave(vpk, f) {
    const c = document.getElementById('acSimCanvas');
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    const mid = h / 2;
    const rms = vpk * 0.707;
    const avg = vpk * 0.637;
    const amp = (h - 40) / 2;
    const scale = amp / vpk;

    // Animate
    if (!this._acAnimId) {
      const animate = () => {
        this._acAnimId = requestAnimationFrame(animate);
        const canvas = document.getElementById('acSimCanvas');
        if (!canvas) { cancelAnimationFrame(this._acAnimId); this._acAnimId = null; return; }
        const vp = parseFloat(document.getElementById('acSimVpk')?.value || 170);
        const fr = parseFloat(document.getElementById('acSimF')?.value || 60);
        Tools._acAnimPhase += fr / 600;
        Tools._renderACFrame(canvas, vp, fr, Tools._acAnimPhase);
      };
      animate();
    }
  },

  _renderACFrame(canvas, vpk, f, phase) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const mid = h / 2;
    const amp = (h - 40) / 2;
    const rms = vpk * 0.707;
    const avg = vpk * 0.637;
    const waveType = Tools._acWaveType || 'sine';
    const phi = parseFloat(document.getElementById('acSimPhi')?.value || 0) * Math.PI / 180;

    ctx.clearRect(0, 0, w, h);

    // Background gradient
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, 'rgba(245,158,11,0.02)'); bg.addColorStop(0.5, 'transparent'); bg.addColorStop(1, 'rgba(139,92,246,0.02)');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
    for (let y = 20; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }

    // Zero line
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

    // RMS lines
    ctx.strokeStyle = 'rgba(34,197,94,0.25)'; ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(0, mid - rms / vpk * amp); ctx.lineTo(w, mid - rms / vpk * amp); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, mid + rms / vpk * amp); ctx.lineTo(w, mid + rms / vpk * amp); ctx.stroke();

    // Avg lines
    ctx.strokeStyle = 'rgba(59,130,246,0.25)';
    ctx.beginPath(); ctx.moveTo(0, mid - avg / vpk * amp); ctx.lineTo(w, mid - avg / vpk * amp); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, mid + avg / vpk * amp); ctx.lineTo(w, mid + avg / vpk * amp); ctx.stroke();
    ctx.setLineDash([]);

    // Waveform function
    const waveVal = (angle) => {
      if (waveType === 'square') return Math.sin(angle) >= 0 ? 1 : -1;
      if (waveType === 'triangle') { const t = ((angle / Math.PI) % 2 + 2) % 2; return t < 1 ? 2 * t - 1 : 3 - 2 * t; }
      return Math.sin(angle);
    };

    // Wave glow
    ctx.shadowColor = 'rgba(245,158,11,0.3)'; ctx.shadowBlur = 10;
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const angle = (x / w) * Math.PI * 4 + phase + phi;
      const y = mid - waveVal(angle) * amp;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Peak markers
    ctx.fillStyle = '#ef4444'; ctx.font = 'bold 10px Inter'; ctx.textAlign = 'right';
    ctx.fillText('+Vpk', w - 5, mid - amp + 12);
    ctx.fillText('-Vpk', w - 5, mid + amp - 4);
    ctx.fillStyle = '#22c55e';
    ctx.fillText('RMS', w - 5, mid - rms / vpk * amp + 12);
    ctx.fillStyle = '#3b82f6';
    ctx.fillText('AVG', w - 5, mid - avg / vpk * amp - 4);
  },

  // ===== TRANSFORMER SIMULATOR =====
  _simTransformer() {
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
          <div style="padding:18px 20px;background:linear-gradient(135deg,rgba(139,92,246,0.06),transparent);border-bottom:1px solid rgba(255,255,255,0.05);">
            <div style="font-weight:700;font-size:0.95rem;margin-bottom:14px;">🔄 Transformer Parameters</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div>
                <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Primary Voltage</label>
                <div style="display:flex;align-items:center;gap:4px;">
                  <input type="number" id="txSimVp" value="480" style="flex:1;padding:8px 10px;background:rgba(245,158,11,0.07);border:1px solid rgba(245,158,11,0.2);border-radius:8px;color:#f59e0b;font-weight:700;" oninput="Tools._updateTxSim()">
                  <span style="font-size:0.75rem;color:#f59e0b;">V</span>
                </div>
              </div>
              <div>
                <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Load Resistance</label>
                <div style="display:flex;align-items:center;gap:4px;">
                  <input type="number" id="txSimLoad" value="10" min="0.1" style="flex:1;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-weight:700;" oninput="Tools._updateTxSim()">
                  <span style="font-size:0.75rem;color:var(--text-muted);">Ω</span>
                </div>
              </div>
              <div>
                <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Primary Turns (Np)</label>
                <input type="number" id="txSimNp" value="200" style="width:100%;padding:8px 10px;background:rgba(245,158,11,0.07);border:1px solid rgba(245,158,11,0.2);border-radius:8px;color:#f59e0b;font-weight:700;box-sizing:border-box;" oninput="Tools._updateTxSim()">
              </div>
              <div>
                <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Secondary Turns (Ns)</label>
                <input type="number" id="txSimNs" value="50" style="width:100%;padding:8px 10px;background:rgba(34,197,94,0.07);border:1px solid rgba(34,197,94,0.2);border-radius:8px;color:#22c55e;font-weight:700;box-sizing:border-box;" oninput="Tools._updateTxSim()">
              </div>
              <div style="grid-column:1/-1;">
                <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Efficiency</label>
                <select id="txSimEff" style="width:100%;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-weight:600;" onchange="Tools._updateTxSim()">
                  <option value="100" selected>Ideal (100%)</option><option value="98">98% (very efficient)</option><option value="95">95% (typical)</option><option value="90">90% (older unit)</option>
                </select>
              </div>
            </div>
          </div>
          <div id="txSimResults" style="padding:16px 20px;font-size:0.85rem;"></div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:12px;">
          <div style="font-weight:700;font-size:0.95rem;">🔁 Transformer Diagram</div>
          <canvas id="txSimCanvas" width="420" height="340" style="border-radius:10px;width:100%;"></canvas>
          <div style="display:flex;gap:12px;font-size:0.72rem;flex-wrap:wrap;">
            <span style="color:#f59e0b;">■ Primary (amber)</span>
            <span style="color:#22c55e;">■ Secondary (green)</span>
            <span style="color:#8b5cf6;">■ Iron Core</span>
          </div>
        </div>
      </div>
    `;
  },

  _updateTxSim() {
    const vp = parseFloat(document.getElementById('txSimVp').value) || 480;
    const np = parseFloat(document.getElementById('txSimNp').value) || 200;
    const ns = parseFloat(document.getElementById('txSimNs').value) || 50;
    const load = parseFloat(document.getElementById('txSimLoad').value) || 10;
    const eff = parseFloat(document.getElementById('txSimEff')?.value || 100) / 100;
    const ratio = np / ns;
    const vs = vp / ratio;
    const is = vs / load;
    const ip = (is / ratio) / eff;
    const pLoad = vs * is;
    const pInput = pLoad / eff;
    const pLoss = pInput - pLoad;
    const type = ratio > 1 ? 'Step-Down' : ratio < 1 ? 'Step-Up' : 'Isolation';

    // Draw transformer — premium version
    const c = document.getElementById('txSimCanvas');
    if (c) {
      const ctx = c.getContext('2d');
      const TW = c.width, TH = c.height;
      ctx.clearRect(0, 0, TW, TH);
      // Dark background
      ctx.fillStyle = '#0d0d1a';
      ctx.beginPath(); ctx.roundRect(0, 0, TW, TH, 8); ctx.fill();

      const coreX = TW/2 - 30, coreW = 60, coreY = 25, coreH = TH - 50;
      // Core glow
      ctx.shadowColor = '#8b5cf6'; ctx.shadowBlur = 16;
      const coreGrad = ctx.createLinearGradient(coreX, 0, coreX + coreW, 0);
      coreGrad.addColorStop(0, 'rgba(139,92,246,0.3)');
      coreGrad.addColorStop(0.5, 'rgba(139,92,246,0.5)');
      coreGrad.addColorStop(1, 'rgba(139,92,246,0.3)');
      ctx.fillStyle = coreGrad;
      ctx.beginPath(); ctx.roundRect(coreX, coreY, coreW, coreH, 6); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(139,92,246,0.8)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(coreX, coreY, coreW, coreH, 6); ctx.stroke();

      // Core lamination lines
      ctx.strokeStyle = 'rgba(139,92,246,0.25)'; ctx.lineWidth = 1;
      for (let y = coreY + 10; y < coreY + coreH - 5; y += 8) {
        ctx.beginPath(); ctx.moveTo(coreX + 4, y); ctx.lineTo(coreX + coreW - 4, y); ctx.stroke();
      }

      // Flux lines inside core (animated via phase)
      const fluxPhase = (Date.now() / 400) % (2 * Math.PI);
      for (let k = 0; k < 4; k++) {
        const fy = coreY + coreH * (k + 1) / 5;
        const amp2 = 8 * Math.sin(fluxPhase + k);
        ctx.strokeStyle = `rgba(139,92,246,${0.2 + 0.15 * Math.abs(Math.sin(fluxPhase + k))})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(coreX + 5, fy);
        ctx.bezierCurveTo(coreX + 20, fy + amp2, coreX + 40, fy - amp2, coreX + coreW - 5, fy);
        ctx.stroke();
      }

      // Primary coils (left)
      const coilCount = Math.min(Math.round(np / 20), 10);
      const coilSpacing = (coreH - 20) / Math.max(coilCount, 1);
      ctx.shadowColor = '#f59e0b'; ctx.shadowBlur = 6;
      ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 3;
      for (let i = 0; i < coilCount; i++) {
        ctx.beginPath();
        ctx.arc(coreX - 14, coreY + 15 + i * coilSpacing, 14, -Math.PI * 0.7, Math.PI * 0.7, true);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      // Primary wire leads
      ctx.strokeStyle = 'rgba(245,158,11,0.6)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(coreX - 28, coreY + 10); ctx.lineTo(40, coreY + 10); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(coreX - 28, coreY + coreH - 10); ctx.lineTo(40, coreY + coreH - 10); ctx.stroke();

      // Secondary coils (right)
      const coilCountS = Math.min(Math.round(ns / 20), 10);
      const coilSpacingS = (coreH - 20) / Math.max(coilCountS, 1);
      ctx.shadowColor = '#22c55e'; ctx.shadowBlur = 6;
      ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 3;
      for (let i = 0; i < coilCountS; i++) {
        ctx.beginPath();
        ctx.arc(coreX + coreW + 14, coreY + 15 + i * coilSpacingS, 14, Math.PI * 0.3, Math.PI * 1.7);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      // Secondary wire leads
      ctx.strokeStyle = 'rgba(34,197,94,0.6)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(coreX + coreW + 28, coreY + 10); ctx.lineTo(TW - 30, coreY + 10); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(coreX + coreW + 28, coreY + coreH - 10); ctx.lineTo(TW - 30, coreY + coreH - 10); ctx.stroke();

      // Labels — Primary
      ctx.font = 'bold 11px Inter'; ctx.textAlign = 'center';
      ctx.fillStyle = '#f59e0b'; ctx.shadowColor = '#f59e0b'; ctx.shadowBlur = 4;
      ctx.fillText('PRIMARY', 30, coreY - 8);
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(245,158,11,0.85)'; ctx.font = 'bold 13px Inter';
      ctx.fillText(vp.toFixed(0) + 'V', 30, TH / 2 - 6);
      ctx.font = '10px Inter'; ctx.fillStyle = 'rgba(245,158,11,0.6)';
      ctx.fillText(ip.toFixed(2) + 'A', 30, TH / 2 + 10);
      ctx.fillText(np + ' turns', 30, TH / 2 + 24);

      // Labels — Secondary
      ctx.font = 'bold 11px Inter'; ctx.fillStyle = '#22c55e';
      ctx.shadowColor = '#22c55e'; ctx.shadowBlur = 4;
      ctx.fillText('SECONDARY', TW - 35, coreY - 8);
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(34,197,94,0.85)'; ctx.font = 'bold 13px Inter';
      ctx.fillText(vs.toFixed(1) + 'V', TW - 35, TH / 2 - 6);
      ctx.font = '10px Inter'; ctx.fillStyle = 'rgba(34,197,94,0.6)';
      ctx.fillText(is.toFixed(2) + 'A', TW - 35, TH / 2 + 10);
      ctx.fillText(ns + ' turns', TW - 35, TH / 2 + 24);

      // Type badge at bottom
      const typeColor = ratio > 1 ? '#3b82f6' : ratio < 1 ? '#f59e0b' : '#22c55e';
      ctx.fillStyle = typeColor; ctx.font = 'bold 12px Inter';
      ctx.shadowColor = typeColor; ctx.shadowBlur = 6;
      ctx.fillText(type + '  ' + ratio.toFixed(2) + ':1', TW / 2, TH - 8);
      ctx.shadowBlur = 0;
    }

    const r = document.getElementById('txSimResults');
    if (r) {
      r.innerHTML = `
        <div style="background:var(--bg-input);border-radius:10px;padding:16px;margin-bottom:12px;">
          <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:8px;">Transformer Relationships</div>
          <div style="font-size:0.8rem;line-height:2;color:var(--text-secondary);">
            <strong>Turns Ratio: ${ratio.toFixed(2)}:1 (${type})</strong><br>
            Vp/Vs = Np/Ns &rarr; ${vp}/${vs.toFixed(1)} = ${np}/${ns}<br>
            ${eff < 1 ? 'Efficiency: ' + (eff*100).toFixed(0) + '% &middot; Losses: ' + pLoss.toFixed(1) + 'W' : 'Ideal transformer (no losses)'}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.85rem;margin-bottom:10px;">
          <div style="background:linear-gradient(135deg,rgba(245,158,11,0.1),rgba(245,158,11,0.02));border:1px solid rgba(245,158,11,0.15);padding:14px;border-radius:10px;text-align:center;">
            <div style="font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Primary</div>
            <div style="color:#f59e0b;font-weight:800;font-size:1.1rem;">${vp}V</div>
            <div style="font-size:0.8rem;color:var(--text-secondary);">${ip.toFixed(3)}A &middot; ${pInput.toFixed(1)}W</div>
          </div>
          <div style="background:linear-gradient(135deg,rgba(34,197,94,0.1),rgba(34,197,94,0.02));border:1px solid rgba(34,197,94,0.15);padding:14px;border-radius:10px;text-align:center;">
            <div style="font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Secondary</div>
            <div style="color:#22c55e;font-weight:800;font-size:1.1rem;">${vs.toFixed(1)}V</div>
            <div style="font-size:0.8rem;color:var(--text-secondary);">${is.toFixed(3)}A &middot; ${pLoad.toFixed(1)}W</div>
          </div>
        </div>
        ${eff < 1 ? '<div style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.12);border-radius:8px;padding:10px;text-align:center;font-size:0.8rem;"><span style="color:#ef4444;font-weight:700;">Losses: ' + pLoss.toFixed(1) + 'W</span> <span style="color:var(--text-muted);">(' + (pLoss/pInput*100).toFixed(1) + '% of input)</span></div>' : ''}
      `;
    }
  },

  // ===== MOTOR SPEED & TORQUE =====
  _simMotor() {
    return `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:24px;">
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid rgba(255,255,255,0.04);">
          <div>
            <label style="font-size:0.72rem;color:var(--text-muted);display:block;margin-bottom:4px;">Frequency</label>
            <div style="display:flex;align-items:center;gap:3px;">
              <input type="number" id="motorSimF" value="60" style="width:70px;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-weight:600;" oninput="Tools._updateMotorSim()">
              <span style="font-size:0.75rem;color:var(--text-muted);">Hz</span>
            </div>
          </div>
          <div>
            <label style="font-size:0.72rem;color:var(--text-muted);display:block;margin-bottom:4px;">Poles</label>
            <select id="motorSimP" style="padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-weight:600;" onchange="Tools._updateMotorSim()">
              <option value="2">2</option><option value="4" selected>4</option><option value="6">6</option><option value="8">8</option><option value="12">12</option>
            </select>
          </div>
          <div>
            <label style="font-size:0.72rem;color:var(--text-muted);display:block;margin-bottom:4px;">HP Rating</label>
            <div style="display:flex;align-items:center;gap:3px;">
              <input type="number" id="motorSimHP" value="5" min="0.5" max="500" step="0.5" style="width:70px;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-weight:600;" oninput="Tools._updateMotorSim()">
              <span style="font-size:0.75rem;color:var(--text-muted);">HP</span>
            </div>
          </div>
          <div>
            <label style="font-size:0.72rem;color:var(--text-muted);display:block;margin-bottom:4px;">Voltage</label>
            <select id="motorSimVolt" style="padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-weight:600;" onchange="Tools._updateMotorSim()">
              <option value="208">208V</option><option value="240">240V</option><option value="480" selected>480V</option><option value="600">600V</option>
            </select>
          </div>
          <div style="flex:1;min-width:140px;">
            <label style="font-size:0.72rem;color:var(--text-muted);display:flex;justify-content:space-between;margin-bottom:4px;"><span>Slip</span><strong id="motorSimSlip_val" style="color:var(--accent);">3%</strong></label>
            <input type="range" id="motorSimSlip" min="0" max="20" value="3" style="width:100%;" oninput="Tools._updateMotorSim()">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
          <div style="display:flex;flex-direction:column;align-items:center;">
            <canvas id="motorSimCanvas" width="280" height="280" style="border-radius:12px;"></canvas>
            <div style="font-size:0.7rem;color:var(--text-muted);margin-top:6px;">&#x2699; Live rotor animation</div>
          </div>
          <div id="motorSimResults" style="font-size:0.85rem;"></div>
        </div>
      </div>
    `;
  },

  _motorAnimAngle: 0,

  _updateMotorSim() {
    const f = parseFloat(document.getElementById('motorSimF').value) || 60;
    const p = parseInt(document.getElementById('motorSimP').value) || 4;
    const slip = parseFloat(document.getElementById('motorSimSlip').value) || 3;
    const hp = parseFloat(document.getElementById('motorSimHP').value) || 5;
    document.getElementById('motorSimSlip_val').textContent = slip + '%';
    const ns = 120 * f / p;
    const nr = ns * (1 - slip / 100);
    const watts = hp * 746;
    const torque = (watts * 60) / (2 * Math.PI * nr);

    // Animate rotor
    if (!this._motorAnimId) {
      const animate = () => {
        this._motorAnimId = requestAnimationFrame(animate);
        const canvas = document.getElementById('motorSimCanvas');
        if (!canvas) { cancelAnimationFrame(this._motorAnimId); this._motorAnimId = null; return; }
        const freq = parseFloat(document.getElementById('motorSimF')?.value || 60);
        const poles = parseInt(document.getElementById('motorSimP')?.value || 4);
        const sl = parseFloat(document.getElementById('motorSimSlip')?.value || 3);
        const syncSpeed = 120 * freq / poles;
        const rotorSpeed = syncSpeed * (1 - sl / 100);
        Tools._motorAnimAngle += rotorSpeed / 3000;
        Tools._drawMotorRotor(canvas, poles, Tools._motorAnimAngle);
      };
      animate();
    }

    const r = document.getElementById('motorSimResults');
    if (r) {
      r.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
          <div style="background:var(--bg-input);border-radius:10px;padding:14px;text-align:center;">
            <div style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;">Sync Speed</div>
            <div style="font-size:1.3rem;font-weight:800;color:var(--accent);">${ns} RPM</div>
            <div style="font-size:0.7rem;color:var(--text-muted);">Ns = 120f/P</div>
          </div>
          <div style="background:var(--bg-input);border-radius:10px;padding:14px;text-align:center;">
            <div style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;">Rotor Speed</div>
            <div style="font-size:1.3rem;font-weight:800;color:#22c55e;">${nr.toFixed(0)} RPM</div>
            <div style="font-size:0.7rem;color:var(--text-muted);">Nr = Ns(1-s)</div>
          </div>
          <div style="background:var(--bg-input);border-radius:10px;padding:14px;text-align:center;">
            <div style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;">Torque</div>
            <div style="font-size:1.3rem;font-weight:800;color:#8b5cf6;">${torque.toFixed(1)} Nm</div>
            <div style="font-size:0.7rem;color:var(--text-muted);">T = P&times;60/(2&pi;Nr)</div>
          </div>
          <div style="background:var(--bg-input);border-radius:10px;padding:14px;text-align:center;">
            <div style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;">Power</div>
            <div style="font-size:1.3rem;font-weight:800;color:#ef4444;">${watts}W</div>
            <div style="font-size:0.7rem;color:var(--text-muted);">${hp} HP &times; 746</div>
          </div>
        </div>
        <div style="background:rgba(139,92,246,0.06);border-radius:8px;padding:12px;font-size:0.78rem;line-height:1.8;color:var(--text-secondary);font-family:'Fira Code',monospace;">
          Ns = 120 &times; ${f} / ${p} = <strong>${ns} RPM</strong><br>
          Slip = ${slip}% &rarr; Nr = ${ns} &times; ${(1-slip/100).toFixed(3)} = <strong>${nr.toFixed(0)} RPM</strong><br>
          T = (${watts} &times; 60) / (2&pi; &times; ${nr.toFixed(0)}) = <strong>${torque.toFixed(1)} Nm</strong>
        </div>
        <div style="margin-top:12px;font-size:0.75rem;color:var(--text-muted);">
          Common nameplate speeds: 2P=3600, 4P=1800, 6P=1200, 8P=900
        </div>
      `;
    }
  },

  _drawMotorRotor(canvas, poles, angle) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const cx = w/2, cy = h/2, r = 100;
    ctx.clearRect(0, 0, w, h);

    // Stator
    ctx.strokeStyle = '#555'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(cx, cy, r + 20, 0, Math.PI * 2); ctx.stroke();

    // Stator slots
    for (let i = 0; i < poles * 3; i++) {
      const a = (i / (poles * 3)) * Math.PI * 2;
      ctx.strokeStyle = 'rgba(139,92,246,0.3)'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r + 10), cy + Math.sin(a) * (r + 10));
      ctx.lineTo(cx + Math.cos(a) * (r + 20), cy + Math.sin(a) * (r + 20));
      ctx.stroke();
    }

    // Rotor
    ctx.fillStyle = 'rgba(245,158,11,0.1)';
    ctx.beginPath(); ctx.arc(cx, cy, r - 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r - 5, 0, Math.PI * 2); ctx.stroke();

    // Rotor bars (animated)
    const colors = ['#f59e0b', '#22c55e', '#3b82f6', '#ef4444', '#8b5cf6', '#ec4899'];
    for (let i = 0; i < poles; i++) {
      const a = angle + (i / poles) * Math.PI * 2;
      ctx.strokeStyle = colors[i % colors.length]; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * (r - 10), cy + Math.sin(a) * (r - 10));
      ctx.stroke();
      // Pole marker
      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * (r - 15), cy + Math.sin(a) * (r - 15), 6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Center shaft
    ctx.fillStyle = '#777';
    ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fill();
  },

  // ===== POWER FACTOR TRIANGLE =====
  _simPFTriangle() {
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
          <div style="padding:18px 20px;background:linear-gradient(135deg,rgba(139,92,246,0.06),transparent);border-bottom:1px solid rgba(255,255,255,0.05);">
            <div style="font-weight:700;font-size:0.95rem;margin-bottom:14px;">📐 Power Triangle Controls</div>
            <div style="margin-bottom:14px;">
              <label style="font-size:0.75rem;color:var(--text-muted);display:flex;justify-content:space-between;margin-bottom:5px;"><span>True Power P (W)</span><strong id="pfSimW_val" style="color:#22c55e;">8000 W</strong></label>
              <input type="range" id="pfSimW" min="100" max="50000" value="8000" class="range-green" style="width:100%;" oninput="Tools._updatePFSim()">
            </div>
            <div style="margin-bottom:14px;">
              <label style="font-size:0.75rem;color:var(--text-muted);display:flex;justify-content:space-between;margin-bottom:5px;"><span>Reactive Power Q (VAR)</span><strong id="pfSimVAR_val" style="color:#ef4444;">6000 VAR</strong></label>
              <input type="range" id="pfSimVAR" min="0" max="50000" value="6000" class="range-red" style="width:100%;" oninput="Tools._updatePFSim()">
            </div>
            <div style="margin-bottom:14px;">
              <label style="font-size:0.75rem;color:var(--text-muted);display:flex;justify-content:space-between;margin-bottom:5px;"><span>System Voltage (V)</span><strong id="pfSimVolt_val" style="color:#3b82f6;">480 V</strong></label>
              <input type="range" id="pfSimVolt" min="120" max="600" value="480" step="1" class="range-blue" style="width:100%;" oninput="Tools._updatePFSim()">
            </div>
          </div>
          <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.05);">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              ${[
                {id:'pfSimVA', label:'Apparent S', color:'#f59e0b', val:'10000 VA'},
                {id:'pfSimPF', label:'Power Factor', color:'#8b5cf6', val:'0.800'},
                {id:'pfSimAngle', label:'Phase Angle', color:'#3b82f6', val:'36.9°'},
                {id:'pfSimRating', label:'PF Rating', color:'#f59e0b', val:'Fair'},
              ].map(s => `<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:10px;text-align:center;">
                <div style="font-size:0.62rem;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.5px;">${s.label}</div>
                <div id="${s.id}" style="font-weight:800;color:${s.color};font-size:1rem;">${s.val}</div>
              </div>`).join('')}
            </div>
          </div>
          <div style="padding:14px 20px;">
            <div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">⚡ PF Correction Capacitor</div>
            <div id="pfCorrectionResult" style="font-size:0.82rem;color:var(--text-secondary);"></div>
          </div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:12px;">
          <div style="font-weight:700;font-size:0.95rem;">📊 Power Triangle Visualization</div>
          <canvas id="pfSimCanvas" width="420" height="340" style="border-radius:10px;width:100%;"></canvas>
          <div style="display:flex;gap:12px;font-size:0.72rem;flex-wrap:wrap;">
            <span style="color:#22c55e;">■ P — True Power (W)</span>
            <span style="color:#ef4444;">■ Q — Reactive (VAR)</span>
            <span style="color:#f59e0b;">■ S — Apparent (VA)</span>
          </div>
        </div>
      </div>
    `;
  },

  _updatePFSim() {
    const w = parseFloat(document.getElementById('pfSimW').value);
    const var_ = parseFloat(document.getElementById('pfSimVAR').value);
    const volt = parseFloat(document.getElementById('pfSimVolt')?.value || 480);
    const va = Math.sqrt(w * w + var_ * var_);
    const pf = w / va;
    const angle = Math.acos(pf) * 180 / Math.PI;
    let rating = 'Excellent'; let rColor = '#22c55e';
    if (pf < 0.99) { rating = 'Excellent'; rColor = '#22c55e'; }
    if (pf < 0.95) { rating = 'Good'; rColor = '#22c55e'; }
    if (pf < 0.85) { rating = 'Fair'; rColor = '#f59e0b'; }
    if (pf < 0.70) { rating = 'Poor'; rColor = '#ef4444'; }

    const pfSimW_val = document.getElementById('pfSimW_val');
    const pfSimVAR_val = document.getElementById('pfSimVAR_val');
    const pfSimVolt_val = document.getElementById('pfSimVolt_val');
    if (pfSimW_val) pfSimW_val.textContent = (w/1000).toFixed(1) + ' kW';
    if (pfSimVAR_val) pfSimVAR_val.textContent = (var_/1000).toFixed(1) + ' kVAR';
    if (pfSimVolt_val) pfSimVolt_val.textContent = volt + ' V';
    const pfSimVA = document.getElementById('pfSimVA'); if (pfSimVA) pfSimVA.textContent = (va/1000).toFixed(2) + ' kVA';
    const pfSimPF = document.getElementById('pfSimPF'); if (pfSimPF) { pfSimPF.textContent = pf.toFixed(3); pfSimPF.style.color = rColor; }
    const pfSimAngle = document.getElementById('pfSimAngle'); if (pfSimAngle) pfSimAngle.innerHTML = angle.toFixed(1) + '&deg;';
    const pfSimRating = document.getElementById('pfSimRating'); if (pfSimRating) { pfSimRating.textContent = rating; pfSimRating.style.color = rColor; }

    // PF correction
    const pfTarget = 0.95;
    const pfCor = document.getElementById('pfCorrectionResult');
    if (pfCor) {
      if (pf >= 0.95) {
        pfCor.innerHTML = '<span style="color:#22c55e;">✓ PF is already at or above 0.95 — no correction needed.</span>';
      } else {
        const qTarget = w * Math.tan(Math.acos(pfTarget));
        const qCorrect = var_ - qTarget;
        const capKvar = qCorrect / 1000;
        const freq = 60;
        const capUF = (qCorrect / (2 * Math.PI * freq * volt * volt)) * 1e9;
        pfCor.innerHTML = `
          <div style="background:rgba(139,92,246,0.06);border:1px solid rgba(139,92,246,0.15);border-radius:8px;padding:10px;">
            <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:6px;">To correct to PF = 0.95:</div>
            <div style="display:flex;justify-content:space-between;font-size:0.82rem;margin-bottom:3px;">
              <span style="color:var(--text-muted);">Required kVAR</span>
              <strong style="color:#8b5cf6;">${capKvar.toFixed(2)} kVAR</strong>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:0.82rem;">
              <span style="color:var(--text-muted);">Cap. at ${volt}V / 60Hz</span>
              <strong style="color:#3b82f6;">${capUF.toFixed(1)} μF</strong>
            </div>
          </div>`;
      }
    }

    // Draw triangle — premium version
    const c = document.getElementById('pfSimCanvas');
    if (!c) return;
    const ctx = c.getContext('2d');
    const cw = c.width, ch = c.height;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#0d0d1a';
    ctx.beginPath(); ctx.roundRect(0, 0, cw, ch, 10); ctx.fill();

    const ox = 55, oy = 55;
    const maxDim = Math.max(w, var_, va, 100);
    const scale = Math.min(250 / maxDim, 0.005);
    const wPx = Math.max(w * scale, 10);
    const varPx = var_ > 0 ? Math.max(var_ * scale, 4) : 0;
    const vaPx = Math.max(va * scale, 10);

    // Triangle fill
    if (varPx > 0) {
      ctx.fillStyle = 'rgba(245,158,11,0.04)';
      ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + wPx, oy); ctx.lineTo(ox + wPx, oy + varPx); ctx.closePath(); ctx.fill();
    }

    const drawVec = (x1, y1, x2, y2, color, lw, label, labelOff) => {
      ctx.strokeStyle = color; ctx.lineWidth = lw;
      ctx.shadowColor = color; ctx.shadowBlur = lw > 2 ? 8 : 4;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.shadowBlur = 0;
      const ang = Math.atan2(y2 - y1, x2 - x1);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - 8*Math.cos(ang-0.35), y2 - 8*Math.sin(ang-0.35));
      ctx.lineTo(x2 - 8*Math.cos(ang+0.35), y2 - 8*Math.sin(ang+0.35));
      ctx.closePath(); ctx.fill();
      if (label) {
        ctx.font = 'bold 11px Inter'; ctx.textAlign = 'center';
        ctx.fillText(label, (x1+x2)/2 + (labelOff||[0])[0], (y1+y2)/2 + (labelOff||[0,12])[1]);
      }
    };

    // P — true power (horizontal)
    drawVec(ox, oy, ox + wPx, oy, '#22c55e', 3, 'P = ' + (w/1000).toFixed(1) + ' kW', [0, -14]);
    // Q — reactive (vertical)
    if (varPx > 0) drawVec(ox + wPx, oy, ox + wPx, oy + varPx, '#ef4444', 3, 'Q = ' + (var_/1000).toFixed(1) + ' kVAR', [40, 0]);
    // S — apparent (hyp)
    drawVec(ox, oy, ox + wPx, oy + varPx, '#f59e0b', 3.5, 'S = ' + (va/1000).toFixed(2) + ' kVA', [-30, 16]);

    // Right angle box
    if (varPx > 0) {
      const bs = 10;
      ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ox + wPx - bs, oy); ctx.lineTo(ox + wPx - bs, oy + bs); ctx.lineTo(ox + wPx, oy + bs); ctx.stroke();
    }

    // Angle arc
    ctx.strokeStyle = '#8b5cf6'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ox, oy, 38, 0, angle * Math.PI / 180); ctx.stroke();
    ctx.fillStyle = '#8b5cf6'; ctx.font = 'bold 11px Inter'; ctx.textAlign = 'left';
    ctx.fillText('θ=' + angle.toFixed(1) + '°', ox + 42, oy + 18);

    // PF meter bar at bottom
    const barY = ch - 40, barX = 30, barW = cw - 60, barH = 14;
    ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 6); ctx.fill();
    const pfFill = pf * barW;
    const pfGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    pfGrad.addColorStop(0, '#ef4444'); pfGrad.addColorStop(0.7, '#f59e0b'); pfGrad.addColorStop(0.95, '#22c55e'); pfGrad.addColorStop(1, '#22c55e');
    ctx.fillStyle = pfGrad; ctx.shadowColor = rColor; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.roundRect(barX, barY, pfFill, barH, 6); ctx.fill(); ctx.shadowBlur = 0;

    // PF label
    ctx.fillStyle = rColor; ctx.font = 'bold 12px Inter'; ctx.textAlign = 'center';
    ctx.fillText('PF = ' + pf.toFixed(3) + '  (' + rating + ')', cw/2, barY + barH + 16);
  },

  // ===== VOLTAGE DROP CALCULATOR =====
  _simVDCalc() {
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
          <div style="padding:18px 20px;background:linear-gradient(135deg,rgba(59,130,246,0.06),transparent);border-bottom:1px solid rgba(255,255,255,0.05);">
            <div style="font-weight:700;font-size:0.95rem;margin-bottom:14px;">🔌 Circuit Parameters</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div>
                <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">System Voltage</label>
                <select id="vdVoltage" style="width:100%;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-weight:600;font-size:0.85rem;" onchange="Tools._updateVDCalc()">
                  <option value="120">120V (1Φ)</option><option value="208">208V (3Φ)</option><option value="240" selected>240V (1Φ)</option><option value="347">347V (3Φ)</option><option value="480">480V (3Φ)</option><option value="600">600V (3Φ)</option>
                </select>
              </div>
              <div>
                <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Phase</label>
                <select id="vdPhase" style="width:100%;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-weight:600;font-size:0.85rem;" onchange="Tools._updateVDCalc()">
                  <option value="1" selected>Single Phase</option><option value="3">Three Phase</option>
                </select>
              </div>
              <div>
                <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Current (A)</label>
                <input type="number" id="vdCurrent" value="40" style="width:100%;padding:8px 10px;background:rgba(59,130,246,0.07);border:1px solid rgba(59,130,246,0.2);border-radius:8px;color:var(--text-primary);font-weight:700;font-size:0.95rem;box-sizing:border-box;" oninput="Tools._updateVDCalc()">
              </div>
              <div>
                <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Distance (m)</label>
                <input type="number" id="vdDist" value="30" style="width:100%;padding:8px 10px;background:rgba(59,130,246,0.07);border:1px solid rgba(59,130,246,0.2);border-radius:8px;color:var(--text-primary);font-weight:700;font-size:0.95rem;box-sizing:border-box;" oninput="Tools._updateVDCalc()">
              </div>
              <div>
                <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Wire Size (AWG)</label>
                <select id="vdWire" style="width:100%;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-weight:600;font-size:0.85rem;" onchange="Tools._updateVDCalc()">
                  <option value="14">14</option><option value="12">12</option><option value="10">10</option><option value="8" selected>8</option><option value="6">6</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option><option value="1/0">1/0</option><option value="2/0">2/0</option><option value="3/0">3/0</option><option value="4/0">4/0</option>
                </select>
              </div>
              <div>
                <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Material</label>
                <select id="vdMat" style="width:100%;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-weight:600;font-size:0.85rem;" onchange="Tools._updateVDCalc()">
                  <option value="cu" selected>Copper</option><option value="al">Aluminum</option>
                </select>
              </div>
            </div>
          </div>
          <div id="vdResult" style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.05);"></div>
          <div style="padding:14px 20px;background:rgba(59,130,246,0.03);">
            <div style="font-size:0.7rem;color:var(--text-muted);font-family:'Fira Code',monospace;line-height:2;">
              Vd = (2 × ρ × L × I) / A &nbsp;(1Φ)<br>
              Vd = (√3 × ρ × L × I) / A &nbsp;(3Φ)<br>
              <span style="color:#3b82f6;">CEC 8-102: ≤3% feeders · ≤5% total</span>
            </div>
          </div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:12px;">
          <div style="font-weight:700;font-size:0.95rem;">⚡ Voltage Distribution Visual</div>
          <canvas id="vdCanvas" width="420" height="300" style="border-radius:10px;width:100%;"></canvas>
          <div id="vdWireInfo" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;"></div>
        </div>
      </div>
    `;
  },

  _vdWireAreas: { '14': 2.08, '12': 3.31, '10': 5.26, '8': 8.37, '6': 13.3, '4': 21.2, '3': 26.7, '2': 33.6, '1': 42.4, '1/0': 53.5, '2/0': 67.4, '3/0': 85.0, '4/0': 107 },

  _updateVDCalc() {
    const voltage = parseFloat(document.getElementById('vdVoltage').value);
    const current = parseFloat(document.getElementById('vdCurrent').value) || 0;
    const dist = parseFloat(document.getElementById('vdDist').value) || 0;
    const wire = document.getElementById('vdWire').value;
    const mat = document.getElementById('vdMat').value;
    const phase = parseInt(document.getElementById('vdPhase').value);

    const area = this._vdWireAreas[wire] || 8.37;
    const rho = mat === 'cu' ? 17.2 : 28.3;
    const multiplier = phase === 1 ? 2 : 1.732;
    const vd = (multiplier * rho * dist * current) / (area * 1000);
    const pct = (vd / voltage) * 100;
    const vLoad = voltage - vd;

    const color = pct <= 3 ? '#22c55e' : pct <= 5 ? '#f59e0b' : '#ef4444';
    const status = pct <= 3 ? '✓ Within 3% feeder limit' : pct <= 5 ? '⚠ Exceeds 3% feeder — check 5% total' : '✗ Exceeds 5% total — upsize conductor';

    const r = document.getElementById('vdResult');
    if (r) {
      const rgb = color === '#22c55e' ? '34,197,94' : color === '#f59e0b' ? '245,158,11' : '239,68,68';
      r.innerHTML = `
        <div style="background:rgba(${rgb},0.07);border:1px solid rgba(${rgb},0.2);border-radius:12px;padding:14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <div><div style="font-size:0.62rem;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.5px;">Voltage Drop</div>
            <div style="font-size:1.6rem;font-weight:900;color:${color};">${vd.toFixed(2)}V <span style="font-size:0.9rem;">(${pct.toFixed(2)}%)</span></div></div>
            <div style="text-align:right;"><div style="font-size:0.62rem;text-transform:uppercase;color:var(--text-muted);">At Load</div>
            <div style="font-size:1.3rem;font-weight:800;color:var(--text-primary);">${vLoad.toFixed(1)}V</div></div>
          </div>
          <div style="height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;position:relative;margin-bottom:5px;">
            <div style="position:absolute;left:0;top:0;bottom:0;width:${Math.min(pct / 5 * 100, 100)}%;background:${color};border-radius:3px;transition:width 0.3s;"></div>
            <div style="position:absolute;left:60%;top:-2px;bottom:-2px;width:1px;background:#f59e0b;opacity:0.6;"></div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.62rem;color:var(--text-muted);margin-bottom:6px;"><span>0%</span><span>3%</span><span>5%</span></div>
          <div style="font-size:0.8rem;font-weight:600;color:${color};">${status}</div>
        </div>`;
    }

    // Update wire info cards
    const wi = document.getElementById('vdWireInfo');
    if (wi) {
      const R_total = (multiplier * rho * dist) / (area * 1000);
      wi.innerHTML = [
        { label: 'Resistance', val: R_total.toFixed(4) + ' Ω', c: '#8b5cf6' },
        { label: 'Wire Area', val: area + ' mm²', c: '#3b82f6' },
        { label: mat === 'cu' ? 'Copper ρ' : 'Alum. ρ', val: rho + ' nΩ·m', c: '#f59e0b' },
      ].map(d => `<div style="background:var(--bg-input);border-radius:8px;padding:10px;text-align:center;">
        <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;">${d.label}</div>
        <div style="font-weight:700;color:${d.c};font-size:0.9rem;">${d.val}</div>
      </div>`).join('');
    }

    // Draw canvas visual
    const c = document.getElementById('vdCanvas');
    if (!c) return;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d0d1a';
    ctx.beginPath(); ctx.roundRect(0, 0, W, H, 10); ctx.fill();

    const wireH = 28, wireY = H / 2 - wireH / 2;
    const panelX = 30, loadX = W - 60;
    const wireLen = loadX - panelX - 60;

    // Gradient wire showing voltage drop
    const grad = ctx.createLinearGradient(panelX + 40, 0, loadX, 0);
    grad.addColorStop(0, '#22c55e');
    grad.addColorStop(Math.min(pct / 10, 0.95), color);
    grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.roundRect(panelX + 40, wireY, wireLen, wireH, 4);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Source panel (left box)
    ctx.fillStyle = 'rgba(34,197,94,0.15)';
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(panelX, wireY - 30, 38, wireH + 60, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#22c55e';
    ctx.font = 'bold 11px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('⚡', panelX + 19, wireY + wireH / 2 - 5);
    ctx.font = 'bold 10px Inter';
    ctx.fillText(voltage + 'V', panelX + 19, wireY + wireH / 2 + 10);

    // Load box (right)
    const lRgb = color === '#22c55e' ? '34,197,94' : color === '#f59e0b' ? '245,158,11' : '239,68,68';
    ctx.fillStyle = `rgba(${lRgb},0.15)`;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(loadX, wireY - 30, 40, wireH + 60, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = 'bold 10px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('LOAD', loadX + 20, wireY + wireH / 2 - 5);
    ctx.fillText(vLoad.toFixed(1) + 'V', loadX + 20, wireY + wireH / 2 + 10);

    // Distance label on wire
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '9px Inter';
    ctx.textAlign = 'center';
    const midWireX = panelX + 40 + wireLen / 2;
    ctx.fillText(dist + 'm · AWG ' + wire + ' · ' + (mat === 'cu' ? 'Cu' : 'Al'), midWireX, wireY - 8);

    // Drop label on wire
    ctx.fillStyle = color;
    ctx.font = 'bold 11px Inter';
    ctx.fillText('▼ ' + vd.toFixed(2) + 'V drop (' + pct.toFixed(2) + '%)', midWireX, wireY + wireH + 20);

    // 3% and 5% reference lines (vertical tick marks below)
    const limY = H - 25;
    const barX = panelX + 40;
    const barW = wireLen;
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(barX, limY - 8); ctx.lineTo(barX + barW, limY - 8); ctx.stroke();

    // Fill bar showing pct vs limits
    const fillW = Math.min(pct / 5 * barW, barW);
    const fGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    fGrad.addColorStop(0, '#22c55e');
    fGrad.addColorStop(0.6, '#f59e0b');
    fGrad.addColorStop(1, '#ef4444');
    ctx.fillStyle = fGrad;
    ctx.beginPath(); ctx.roundRect(barX, limY - 8, fillW, 8, 4); ctx.fill();

    // Limit markers
    ctx.strokeStyle = 'rgba(245,158,11,0.6)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    const t3x = barX + barW * 0.6;
    ctx.beginPath(); ctx.moveTo(t3x, limY - 18); ctx.lineTo(t3x, limY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(245,158,11,0.7)';
    ctx.font = '8px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('3%', t3x, limY + 10);
    ctx.fillStyle = 'rgba(239,68,68,0.7)';
    ctx.fillText('5%', barX + barW, limY + 10);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText('0%', barX, limY + 10);
  },

  // ===== DEMAND FACTOR SCENARIO SIMULATOR =====
  _dfScenarios: [
    { desc: 'A 1,200 sq ft Calgary bungalow (slab-on-grade). No A/C. Electric heat: 8,000W. Electric range: 10,500W. Electric dryer: 5,000W. Hot water tank: 3,500W.', area: 1200, range: 10500, dryer: 5000, ac: 0, heat: 8000, hw: 3500, other: 0 },
    { desc: 'A 2,400 sq ft Edmonton two-storey. Central A/C: 6,000W. Electric heat: 12,000W. Electric range: 12,000W. Electric dryer: 5,500W. Hot water tank: 4,000W. Jacuzzi tub: 1,500W.', area: 2400, range: 12000, dryer: 5500, ac: 6000, heat: 12000, hw: 4000, other: 1500 },
    { desc: 'A 900 sq ft condo. No separate dryer (in-suite washer-dryer combo: 2,200W). No electric heat (gas furnace). Electric range: 7,500W. Hot water tank: 3,000W. A/C unit: 2,000W.', area: 900, range: 7500, dryer: 2200, ac: 2000, heat: 0, hw: 3000, other: 0 },
    { desc: 'A 3,200 sq ft new construction home. Geothermal heat pump: 14,000W (counts as both heat and A/C). Electric range: 13,500W (over 12kW). Two electric dryers (garages): count first at 5,000W, second at 2,500W. Two hot water tanks: 4,500W each. EV charger: 7,200W other fixed load.', area: 3200, range: 13500, dryer: 5000, ac: 14000, heat: 14000, hw: 4500, other: 7200 },
    { desc: 'A 1,650 sq ft townhouse. No electric heat (natural gas). No A/C. Electric range: 9,000W. Electric dryer: 4,800W. Hot water tank: 3,000W. Electric floor heating (bathroom only): 800W.', area: 1650, range: 9000, dryer: 4800, ac: 0, heat: 0, hw: 3000, other: 800 },
    { desc: 'A 1,850 sq ft basement suite conversion. Electric baseboard heat: 7,500W. No A/C. No electric range (gas). Electric dryer: 5,000W. Hot water tank: 3,500W.', area: 1850, range: 0, dryer: 5000, ac: 0, heat: 7500, hw: 3500, other: 0 },
    { desc: 'A 2,100 sq ft house with split systems. Air source heat pump: 10,000W (use as both A/C and heat — take the larger). Backup electric heat strips: 6,000W. Electric range: 11,000W. Dryer: 5,200W. Hot water tank: 4,000W.', area: 2100, range: 11000, dryer: 5200, ac: 10000, heat: 10000, hw: 4000, other: 0 },
    { desc: 'A newly built 1,400 sq ft infill home. Mini-split heat pump: 5,000W (A/C function) and 5,000W (heating function — same unit). Electric range: 10,000W. Dryer: 4,500W. Tankless electric HWT: 15,000W (count as fixed load "other"). No separate baseboard heat.', area: 1400, range: 10000, dryer: 4500, ac: 5000, heat: 5000, hw: 0, other: 15000 },
  ],
  _dfScenarioIdx: 0,
  _dfAnswerShown: false,

  // ===== DEMAND FACTOR CALCULATOR (plain) =====
  _simDemandCalc() {
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
          <div style="padding:18px 20px;background:linear-gradient(135deg,rgba(59,130,246,0.06),transparent);border-bottom:1px solid rgba(255,255,255,0.05);">
            <div style="font-weight:700;font-size:0.95rem;margin-bottom:4px;">🏠 CEC Rule 8-200 Demand Factor Calculator</div>
            <div style="font-size:0.75rem;color:var(--text-muted);">Enter residential loads to calculate service size demand</div>
          </div>
          <div style="padding:18px 20px;">
            <div style="display:flex;flex-direction:column;gap:10px;">
              ${[
                { id:'dcArea', label:'Floor Area', unit:'sq ft', hint:'3 VA/sq ft (basic load)', col:'#3b82f6' },
                { id:'dcRange', label:'Electric Range', unit:'W', hint:'≤12000W = 6000W demand; >12kW = 6kW + 40% over 12kW', col:'#f59e0b' },
                { id:'dcDryer', label:'Electric Dryer', unit:'W', hint:'First dryer at 25% of nameplate', col:'#8b5cf6' },
                { id:'dcAC', label:'A/C (or Heat Pump)', unit:'W', hint:'Use larger of A/C or heat (not both)', col:'#22c55e' },
                { id:'dcHeat', label:'Electric Heat', unit:'W', hint:'Use larger of A/C or heat (not both)', col:'#ef4444' },
                { id:'dcHW', label:'Hot Water Tank', unit:'W', hint:'100% of nameplate', col:'#f59e0b' },
                { id:'dcOther', label:'Other Fixed Loads', unit:'W', hint:'EV charger, hot tub, etc. at 100%', col:'#ec4899' },
              ].map(f => `
                <div style="display:flex;align-items:center;gap:10px;">
                  <label style="font-size:0.72rem;color:var(--text-muted);width:130px;flex-shrink:0;">${f.label}</label>
                  <input type="number" id="${f.id}" value="0" min="0"
                    style="flex:1;padding:7px 10px;background:rgba(${f.col==='#3b82f6'?'59,130,246':f.col==='#f59e0b'?'245,158,11':f.col==='#8b5cf6'?'139,92,246':f.col==='#22c55e'?'34,197,94':f.col==='#ef4444'?'239,68,68':f.col==='#ec4899'?'236,72,153':'245,158,11'},0.08);border:1px solid rgba(${f.col==='#3b82f6'?'59,130,246':f.col==='#f59e0b'?'245,158,11':f.col==='#8b5cf6'?'139,92,246':f.col==='#22c55e'?'34,197,94':f.col==='#ef4444'?'239,68,68':f.col==='#ec4899'?'236,72,153':'245,158,11'},0.25);border-radius:8px;color:${f.col};font-weight:700;"
                    oninput="Tools._updateDemandCalc()">
                  <span style="font-size:0.72rem;color:var(--text-muted);width:28px;">${f.unit}</span>
                </div>
                <div style="font-size:0.67rem;color:var(--text-muted);margin-top:-6px;padding-left:140px;">${f.hint}</div>
              `).join('')}
              <div style="margin-top:6px;display:flex;align-items:center;gap:10px;">
                <label style="font-size:0.72rem;color:var(--text-muted);width:130px;flex-shrink:0;">Service Voltage</label>
                <select id="dcVoltage" style="flex:1;padding:7px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-weight:600;" onchange="Tools._updateDemandCalc()">
                  <option value="240" selected>240V (single-phase)</option>
                  <option value="208">208V (3-phase)</option>
                </select>
              </div>
            </div>
            <button onclick="Tools._resetDemandCalc()" style="margin-top:16px;padding:8px 18px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:8px;color:#ef4444;font-weight:600;font-size:0.8rem;cursor:pointer;">🗑 Clear All</button>
          </div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
          <div style="padding:18px 20px;background:linear-gradient(135deg,rgba(34,197,94,0.05),transparent);border-bottom:1px solid rgba(255,255,255,0.05);">
            <div style="font-weight:700;font-size:0.95rem;">📋 CEC 8-200 Step-by-Step Calculation</div>
          </div>
          <div id="dcResult" style="padding:16px 20px;">
            <div style="color:var(--text-muted);font-size:0.85rem;padding:20px;text-align:center;">Enter values to see the demand calculation</div>
          </div>
        </div>
      </div>
    `;
  },

  _resetDemandCalc() {
    ['dcArea','dcRange','dcDryer','dcAC','dcHeat','dcHW','dcOther'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '0';
    });
    this._updateDemandCalc();
  },

  _updateDemandCalc() {
    const area = parseFloat(document.getElementById('dcArea')?.value || 0);
    const range = parseFloat(document.getElementById('dcRange')?.value || 0);
    const dryer = parseFloat(document.getElementById('dcDryer')?.value || 0);
    const ac = parseFloat(document.getElementById('dcAC')?.value || 0);
    const heat = parseFloat(document.getElementById('dcHeat')?.value || 0);
    const hw = parseFloat(document.getElementById('dcHW')?.value || 0);
    const other = parseFloat(document.getElementById('dcOther')?.value || 0);
    const voltage = parseFloat(document.getElementById('dcVoltage')?.value || 240);

    // CEC Rule 8-200 Calculations
    const basicLoad = area * 3;
    const first5000 = Math.min(basicLoad, 5000);
    const remainder = Math.max(basicLoad - 5000, 0) * 0.40;
    const basicDemand = first5000 + remainder;

    const rangeDemand = range > 0 ? (range <= 12000 ? 6000 : 6000 + (range - 12000) * 0.40) : 0;
    const dryerDemand = dryer > 0 ? dryer * 0.25 : 0;
    const hwDemand = hw;
    const acHeatDemand = Math.max(ac, heat);
    const otherDemand = other;

    const totalDemand = basicDemand + rangeDemand + dryerDemand + hwDemand + acHeatDemand + otherDemand;
    const serviceAmps = totalDemand / voltage;
    const recommended = serviceAmps <= 100 ? 100 : serviceAmps <= 125 ? 125 : serviceAmps <= 150 ? 150 : serviceAmps <= 200 ? 200 : 400;

    const r = document.getElementById('dcResult');
    if (!r) return;

    if (area === 0 && range === 0 && dryer === 0 && ac === 0 && heat === 0 && hw === 0 && other === 0) {
      r.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:20px;text-align:center;">Enter values to see the demand calculation</div>';
      return;
    }

    const row = (label, value, color, note) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 12px;border-radius:8px;background:rgba(${color==='#22c55e'?'34,197,94':color==='#f59e0b'?'245,158,11':color==='#3b82f6'?'59,130,246':color==='#8b5cf6'?'139,92,246':color==='#ef4444'?'239,68,68':color==='#ec4899'?'236,72,153':'255,255,255'},0.06);">
        <div><div style="font-size:0.75rem;font-weight:600;color:${color};">${label}</div>${note ? '<div style="font-size:0.65rem;color:var(--text-muted);">' + note + '</div>' : ''}</div>
        <div style="font-weight:800;color:${color};font-size:0.9rem;">${value}</div>
      </div>`;

    r.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${row('Basic Load (3 VA/sq ft)', basicLoad.toFixed(0) + ' VA', '#3b82f6', area > 0 ? area + ' sq ft × 3 VA = ' + basicLoad.toFixed(0) + ' VA' : 'Enter floor area')}
        ${row('Basic Load Demand', basicDemand.toFixed(0) + ' VA', '#3b82f6', basicLoad <= 5000 ? 'First 5000 VA at 100%' : 'First 5000 @ 100% + ' + (basicLoad-5000).toFixed(0) + ' VA @ 40%')}
        ${range > 0 ? row('Range Demand', rangeDemand.toFixed(0) + ' VA', '#f59e0b', range <= 12000 ? range/1000 + ' kW range → flat 6000 VA' : range/1000 + ' kW range → 6000 + 40% over 12kW') : ''}
        ${dryer > 0 ? row('Dryer Demand (25%)', dryerDemand.toFixed(0) + ' VA', '#8b5cf6', dryer.toFixed(0) + ' W × 25% = ' + dryerDemand.toFixed(0) + ' VA') : ''}
        ${hw > 0 ? row('Hot Water Tank (100%)', hwDemand.toFixed(0) + ' VA', '#f59e0b', hw.toFixed(0) + ' W at 100%') : ''}
        ${(ac > 0 || heat > 0) ? row('A/C or Heat (larger)', acHeatDemand.toFixed(0) + ' VA', '#22c55e', 'A/C: ' + ac.toFixed(0) + ' W vs Heat: ' + heat.toFixed(0) + ' W → use ' + Math.max(ac,heat).toFixed(0) + ' W') : ''}
        ${other > 0 ? row('Other Fixed Loads', otherDemand.toFixed(0) + ' VA', '#ec4899', other.toFixed(0) + ' W at 100%') : ''}
        <div style="height:1px;background:rgba(255,255,255,0.08);margin:6px 0;"></div>
        ${row('Total Demand', (totalDemand/1000).toFixed(2) + ' kVA', '#f59e0b', 'Sum of all demand values')}
        ${row('Service Amps @ ' + voltage + 'V', serviceAmps.toFixed(1) + ' A', '#f59e0b', totalDemand.toFixed(0) + ' VA ÷ ' + voltage + 'V')}
        <div style="margin-top:8px;padding:14px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:10px;text-align:center;">
          <div style="font-size:0.65rem;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.5px;">Recommended Service Size</div>
          <div style="font-size:2rem;font-weight:900;color:#22c55e;">${recommended}A</div>
          <div style="font-size:0.75rem;color:rgba(34,197,94,0.7);">Next standard size above ${serviceAmps.toFixed(1)}A</div>
        </div>
      </div>
    `;
  },

  // ===== DEMAND FACTOR PRACTICE (scenario) =====
  _simDemandFactor() {
    return `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
        <div style="padding:20px 24px;background:linear-gradient(135deg,rgba(245,158,11,0.08),transparent);border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
            <div style="display:flex;align-items:center;gap:12px;">
              <div style="font-size:1.6rem;">🏠</div>
              <div>
                <div style="font-weight:700;font-size:1rem;">CEC Rule 8-200 Demand Factor Simulator</div>
                <div style="font-size:0.75rem;color:var(--text-muted);">Practice residential service sizing with real scenarios</div>
              </div>
            </div>
            <div style="display:flex;gap:8px;">
              <button onclick="Tools._dfNewScenario()" style="padding:8px 16px;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);border-radius:8px;color:#f59e0b;font-weight:600;font-size:0.8rem;cursor:pointer;">🔄 New Scenario</button>
              <button onclick="Tools._dfShowAnswer()" style="padding:8px 16px;background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.3);border-radius:8px;color:#22c55e;font-weight:600;font-size:0.8rem;cursor:pointer;">✓ Show Answer</button>
            </div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;">
          <div style="padding:20px;border-right:1px solid rgba(255,255,255,0.06);">
            <div id="dfScenarioCard" style="background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);border-radius:12px;padding:16px;margin-bottom:20px;">
              <div id="dfScenarioNum" style="font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:#f59e0b;margin-bottom:8px;font-weight:700;">📋 Scenario ${(this._dfScenarioIdx||0)+1} of ${this._dfScenarios.length}</div>
              <div id="dfScenarioText" style="font-size:0.88rem;color:var(--text-primary);line-height:1.6;">${this._dfScenarios[this._dfScenarioIdx||0].desc}</div>
            </div>
            <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:12px;">Your Calculation Inputs (CEC Rule 8-200)</div>
            <div style="display:flex;flex-direction:column;gap:10px;">
              ${[
                {id:'dfArea', label:'Floor Area', unit:'sq ft', hint:'Basic load = 3 VA/sq ft'},
                {id:'dfRange', label:'Electric Range', unit:'W', hint:'≤12kW = 6000W demand; >12kW add 40% of excess'},
                {id:'dfDryer', label:'Electric Dryer', unit:'W', hint:'First dryer @ 25% of rating'},
                {id:'dfAC', label:'A/C or Heat Pump', unit:'W', hint:'Take larger of A/C or heat'},
                {id:'dfHeat', label:'Electric Heat', unit:'W', hint:'Take larger of A/C or heat'},
                {id:'dfHW', label:'Hot Water Tank', unit:'W', hint:'100% of rating'},
                {id:'dfOther', label:'Other Fixed Loads', unit:'W', hint:'Add at 25%'},
              ].map(f => `
                <div style="display:flex;align-items:center;gap:8px;">
                  <label style="font-size:0.78rem;color:var(--text-secondary);width:130px;flex-shrink:0;">${f.label}</label>
                  <input type="number" id="${f.id}" value="0" min="0" style="width:90px;padding:6px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:7px;color:var(--text-primary);font-weight:600;font-size:0.9rem;" oninput="Tools._updateDemandFactor()">
                  <span style="font-size:0.72rem;color:var(--text-muted);">${f.unit}</span>
                  <span style="font-size:0.68rem;color:rgba(245,158,11,0.7);font-style:italic;display:none;" class="df-hint">${f.hint}</span>
                </div>
              `).join('')}
              <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
                <label style="font-size:0.78rem;color:var(--text-secondary);width:130px;">Service Voltage</label>
                <select id="dfVoltage" style="padding:6px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:7px;color:var(--text-primary);font-weight:600;" onchange="Tools._updateDemandFactor()">
                  <option value="240" selected>240V (Single Phase)</option><option value="120">120V</option>
                </select>
              </div>
            </div>
          </div>

          <div style="padding:20px;">
            <div id="dfResult" style="margin-bottom:16px;">
              <div style="color:var(--text-muted);font-size:0.85rem;padding:20px;text-align:center;background:var(--bg-input);border-radius:10px;">Enter your values to see the running calculation</div>
            </div>
            <div style="background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.15);border-radius:10px;padding:14px;">
              <div style="font-size:0.7rem;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">📖 CEC Rule 8-200 Quick Reference</div>
              <div style="font-size:0.75rem;color:var(--text-secondary);line-height:1.8;">
                <div><strong style="color:var(--text-primary);">Step 1 — Basic Load:</strong> Area × 3 VA/sq ft</div>
                <div style="padding-left:12px;color:var(--text-muted);">• First 5,000 VA @ 100%</div>
                <div style="padding-left:12px;color:var(--text-muted);">• Remainder @ 40%</div>
                <div><strong style="color:var(--text-primary);">Step 2 — Range:</strong> ≤12kW → 6,000W; >12kW → 6,000 + 40% of excess</div>
                <div><strong style="color:var(--text-primary);">Step 3 — Dryer:</strong> First dryer @ 25% of rated watts</div>
                <div><strong style="color:var(--text-primary);">Step 4 — A/C or Heat:</strong> Take only the LARGER of the two @ 100%</div>
                <div><strong style="color:var(--text-primary);">Step 5 — Hot Water:</strong> 100% of rated watts</div>
                <div><strong style="color:var(--text-primary);">Step 6 — Other Fixed:</strong> Add 25% of each fixed load</div>
                <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);"><strong style="color:#3b82f6;">Service A = Total Demand (VA) ÷ Voltage</strong></div>
              </div>
            </div>
            <div id="dfAnswerPanel" style="display:none;margin-top:16px;"></div>
          </div>
        </div>
      </div>
    `;
  },

  _dfNewScenario() {
    // Advance to next unused scenario (avoid repeat until all shown)
    if (!this._dfUsed) this._dfUsed = new Set();
    this._dfUsed.add(this._dfScenarioIdx);
    if (this._dfUsed.size >= this._dfScenarios.length) this._dfUsed.clear();
    let next;
    do { next = Math.floor(Math.random() * this._dfScenarios.length); } while (this._dfUsed.has(next));
    this._dfScenarioIdx = next;
    this._dfAnswerShown = false;
    // Update scenario text and number directly in the DOM
    const scText = document.getElementById('dfScenarioText');
    if (scText) scText.textContent = this._dfScenarios[next].desc;
    const numEl = document.getElementById('dfScenarioNum');
    if (numEl) numEl.textContent = '📋 Scenario ' + (next + 1) + ' of ' + this._dfScenarios.length;
    // Reset all input fields to 0
    ['dfArea','dfRange','dfDryer','dfAC','dfHeat','dfHW','dfOther'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '0';
    });
    // Reset running calculation panel
    const dfResult = document.getElementById('dfResult');
    if (dfResult) dfResult.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:20px;text-align:center;background:var(--bg-input);border-radius:10px;">Enter your values to see the running calculation</div>';
    // Hide answer panel
    const ansPanel = document.getElementById('dfAnswerPanel');
    if (ansPanel) { ansPanel.style.display = 'none'; ansPanel.innerHTML = ''; }
  },

  _dfShowAnswer() {
    const sc = this._dfScenarios[this._dfScenarioIdx || 0];
    const area = sc.area, range = sc.range, dryer = sc.dryer, ac = sc.ac, heat = sc.heat, hw = sc.hw, other = sc.other;
    const voltage = parseFloat(document.getElementById('dfVoltage')?.value || 240);
    const basicLoad = area * 3;
    const first5000 = Math.min(basicLoad, 5000);
    const remainder = Math.max(basicLoad - 5000, 0) * 0.40;
    const basicDemand = first5000 + remainder;
    const rangeDemand = range > 0 ? (range <= 12000 ? 6000 : 6000 + (range - 12000) * 0.40) : 0;
    const dryerCalc = dryer > 0 ? dryer * 0.25 : 0;
    const hwDemand = hw;
    const acHeatDemand = Math.max(ac, heat);
    const otherDemand = other * 0.25;
    const totalDemand = basicDemand + rangeDemand + dryerCalc + hwDemand + acHeatDemand + otherDemand;
    const current = totalDemand / voltage;
    let serviceSize = '60A';
    if (current > 160) serviceSize = '200A';
    else if (current > 80) serviceSize = '100A';
    else if (current > 48) serviceSize = '60A';
    const panel = document.getElementById('dfAnswerPanel');
    if (!panel) return;
    panel.style.display = 'block';
    panel.innerHTML = `
      <div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:12px;padding:16px;">
        <div style="font-size:0.7rem;font-weight:700;color:#22c55e;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">✅ Correct Answer — CEC 8-200 Calculation</div>
        <div style="display:flex;flex-direction:column;gap:5px;font-size:0.8rem;margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
            <span style="color:var(--text-secondary);">Basic Load (${area} × 3)</span><span style="font-weight:600;">${basicLoad.toFixed(0)} VA</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
            <span style="color:var(--text-muted);padding-left:12px;">First 5000 VA @ 100%</span><span>${first5000.toFixed(0)} VA</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
            <span style="color:var(--text-muted);padding-left:12px;">Remainder @ 40%</span><span>${remainder.toFixed(0)} VA</span>
          </div>
          ${rangeDemand > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);"><span style="color:var(--text-secondary);">Range (${range}W → ${range<=12000?'6000W':'6000+'+((range-12000)*0.4).toFixed(0)+'W'})</span><span style="font-weight:600;">${rangeDemand.toFixed(0)} VA</span></div>` : ''}
          ${dryerCalc > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);"><span style="color:var(--text-secondary);">Dryer (${dryer}W × 25%)</span><span style="font-weight:600;">${dryerCalc.toFixed(0)} VA</span></div>` : ''}
          ${acHeatDemand > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);"><span style="color:var(--text-secondary);">A/C or Heat (larger of ${ac}W vs ${heat}W)</span><span style="font-weight:600;">${acHeatDemand.toFixed(0)} VA</span></div>` : ''}
          ${hwDemand > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);"><span style="color:var(--text-secondary);">Hot Water (${hw}W @ 100%)</span><span style="font-weight:600;">${hwDemand.toFixed(0)} VA</span></div>` : ''}
          ${otherDemand > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);"><span style="color:var(--text-secondary);">Other Fixed (${other}W × 25%)</span><span style="font-weight:600;">${otherDemand.toFixed(0)} VA</span></div>` : ''}
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-top:2px solid rgba(34,197,94,0.3);margin-top:4px;">
            <span style="font-weight:700;color:#22c55e;font-size:0.9rem;">Total Demand</span>
            <span style="font-weight:800;color:#22c55e;font-size:0.9rem;">${totalDemand.toFixed(0)} VA</span>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div style="background:rgba(34,197,94,0.08);border-radius:8px;padding:12px;text-align:center;">
            <div style="font-size:1.3rem;font-weight:800;color:#22c55e;">${current.toFixed(1)}A</div>
            <div style="font-size:0.68rem;color:var(--text-muted);">Service Current @ ${voltage}V</div>
          </div>
          <div style="background:rgba(245,158,11,0.08);border-radius:8px;padding:12px;text-align:center;">
            <div style="font-size:1.3rem;font-weight:800;color:#f59e0b;">${serviceSize}</div>
            <div style="font-size:0.68rem;color:var(--text-muted);">Min. Service Size</div>
          </div>
        </div>
      </div>
    `;
  },

  _updateDemandFactor() {
    const area = parseFloat(document.getElementById('dfArea')?.value) || 0;
    const range = parseFloat(document.getElementById('dfRange')?.value) || 0;
    const dryer = parseFloat(document.getElementById('dfDryer')?.value) || 0;
    const ac = parseFloat(document.getElementById('dfAC')?.value) || 0;
    const heat = parseFloat(document.getElementById('dfHeat')?.value) || 0;
    const hw = parseFloat(document.getElementById('dfHW')?.value) || 0;
    const other = parseFloat(document.getElementById('dfOther')?.value) || 0;
    const voltage = parseFloat(document.getElementById('dfVoltage')?.value) || 240;

    const basicLoad = area * 3;
    const first5000 = Math.min(basicLoad, 5000);
    const remainder = Math.max(basicLoad - 5000, 0) * 0.40;
    const basicDemand = first5000 + remainder;
    const rangeDemand = range > 0 ? (range <= 12000 ? 6000 : 6000 + (range - 12000) * 0.40) : 0;
    const dryerCalc = dryer > 0 ? dryer * 0.25 : 0;
    const hwDemand = hw;
    const acHeatDemand = Math.max(ac, heat);
    const otherDemand = other * 0.25;
    const totalDemand = basicDemand + rangeDemand + dryerCalc + hwDemand + acHeatDemand + otherDemand;
    const current = totalDemand / voltage;
    let serviceSize = '60A';
    if (current > 160) serviceSize = '200A';
    else if (current > 80) serviceSize = '100A';
    else if (current > 48) serviceSize = '60A';

    const r = document.getElementById('dfResult');
    if (r) {
      r.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:5px;font-size:0.82rem;background:var(--bg-input);border-radius:10px;padding:14px;">
          <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:6px;">Running Calculation</div>
          ${basicDemand > 0 ? `<div style="display:flex;justify-content:space-between;padding:3px 0;"><span style="color:var(--text-secondary);">Basic Load demand</span><span style="font-weight:600;">${basicDemand.toFixed(0)} VA</span></div>` : ''}
          ${rangeDemand > 0 ? `<div style="display:flex;justify-content:space-between;padding:3px 0;"><span style="color:var(--text-secondary);">Range demand</span><span style="font-weight:600;">${rangeDemand.toFixed(0)} VA</span></div>` : ''}
          ${dryerCalc > 0 ? `<div style="display:flex;justify-content:space-between;padding:3px 0;"><span style="color:var(--text-secondary);">Dryer demand</span><span style="font-weight:600;">${dryerCalc.toFixed(0)} VA</span></div>` : ''}
          ${acHeatDemand > 0 ? `<div style="display:flex;justify-content:space-between;padding:3px 0;"><span style="color:var(--text-secondary);">A/C or Heat demand</span><span style="font-weight:600;">${acHeatDemand.toFixed(0)} VA</span></div>` : ''}
          ${hwDemand > 0 ? `<div style="display:flex;justify-content:space-between;padding:3px 0;"><span style="color:var(--text-secondary);">Hot Water demand</span><span style="font-weight:600;">${hwDemand.toFixed(0)} VA</span></div>` : ''}
          ${otherDemand > 0 ? `<div style="display:flex;justify-content:space-between;padding:3px 0;"><span style="color:var(--text-secondary);">Other @ 25%</span><span style="font-weight:600;">${otherDemand.toFixed(0)} VA</span></div>` : ''}
          ${totalDemand > 0 ? `
          <div style="display:flex;justify-content:space-between;padding:7px 0;border-top:2px solid var(--accent);margin-top:4px;">
            <span style="font-weight:700;color:var(--accent);">Total</span><span style="font-weight:800;color:var(--accent);">${totalDemand.toFixed(0)} VA</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px;">
            <div style="background:rgba(245,158,11,0.08);border-radius:7px;padding:10px;text-align:center;">
              <div style="font-size:1.1rem;font-weight:800;color:var(--accent);">${current.toFixed(1)}A</div>
              <div style="font-size:0.65rem;color:var(--text-muted);">@ ${voltage}V</div>
            </div>
            <div style="background:rgba(34,197,94,0.08);border-radius:7px;padding:10px;text-align:center;">
              <div style="font-size:1.1rem;font-weight:800;color:#22c55e;">${serviceSize}</div>
              <div style="font-size:0.65rem;color:var(--text-muted);">Min Service</div>
            </div>
          </div>` : ''}
        </div>
      `;
    }
  },

  // ===== CONDUIT FILL CALCULATOR =====
  _simConduitFill() {
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
          <div style="padding:18px 20px;background:linear-gradient(135deg,rgba(245,158,11,0.06),transparent);border-bottom:1px solid rgba(255,255,255,0.05);">
            <div style="font-weight:700;font-size:0.95rem;margin-bottom:14px;">🔧 Conduit Configuration</div>
            <div style="display:flex;flex-direction:column;gap:10px;">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div>
                  <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Conduit Type</label>
                  <select id="cfType" style="width:100%;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:0.85rem;" onchange="Tools._updateConduitFill()">
                    <option value="emt">EMT</option>
                    <option value="rigid">Rigid (IMC/GRC)</option>
                    <option value="pvc40">PVC Schedule 40</option>
                    <option value="pvc80">PVC Schedule 80</option>
                    <option value="flex">Flexible Metal</option>
                  </select>
                </div>
                <div>
                  <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Trade Size</label>
                  <select id="cfSize" style="width:100%;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:0.85rem;" onchange="Tools._updateConduitFill()">
                    <option value="0.5">1/2"</option><option value="0.75">3/4"</option><option value="1" selected>1"</option>
                    <option value="1.25">1-1/4"</option><option value="1.5">1-1/2"</option><option value="2">2"</option>
                    <option value="2.5">2-1/2"</option><option value="3">3"</option><option value="4">4"</option>
                  </select>
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div>
                  <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Wire Type</label>
                  <select id="cfWireType" style="width:100%;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:0.85rem;" onchange="Tools._updateConduitFill()">
                    <option value="thhn">THHN/THWN</option><option value="tw">TW</option><option value="rwu">RWU 90</option>
                  </select>
                </div>
                <div>
                  <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Wire Size</label>
                  <select id="cfWireSize" style="width:100%;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:0.85rem;" onchange="Tools._updateConduitFill()">
                    <option value="14">#14</option><option value="12" selected>#12</option><option value="10">#10</option>
                    <option value="8">#8</option><option value="6">#6</option><option value="4">#4</option>
                    <option value="3">#3</option><option value="2">#2</option><option value="1">#1</option>
                    <option value="1/0">1/0</option><option value="2/0">2/0</option><option value="3/0">3/0</option>
                    <option value="4/0">4/0</option><option value="250">250 kcmil</option>
                    <option value="350">350 kcmil</option><option value="500">500 kcmil</option>
                  </select>
                </div>
              </div>
              <div>
                <label style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Number of Conductors</label>
                <input type="number" id="cfCount" value="3" min="1" max="50" style="width:100%;padding:8px 10px;background:rgba(245,158,11,0.07);border:1px solid rgba(245,158,11,0.2);border-radius:8px;color:#f59e0b;font-weight:700;font-size:1rem;" oninput="Tools._updateConduitFill()">
              </div>
            </div>
          </div>
          <div id="cfResult" style="padding:16px 20px;">
            <p style="color:var(--text-muted);font-size:0.85rem;margin:0;">Configure conduit to see fill percentage.</p>
          </div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:12px;">
          <div style="font-weight:700;font-size:0.95rem;">🔵 Cross-Section Visualization</div>
          <canvas id="cfCanvas" width="420" height="360" style="border-radius:10px;width:100%;"></canvas>
          <div style="padding:10px 14px;background:rgba(245,158,11,0.04);border:1px solid rgba(245,158,11,0.1);border-radius:8px;font-size:0.73rem;color:var(--text-secondary);line-height:1.7;">
            CEC fill limits: 1 conductor = 53% · 2 conductors = 31% · 3+ conductors = 40%
          </div>
        </div>
      </div>
    `;
  },

  // Wire cross-section areas in mm² (approximate for THHN)
  _wireAreas: { '14': 8.97, '12': 11.68, '10': 16.77, '8': 30.19, '6': 40.54, '4': 56.06, '3': 65.61, '2': 77.26, '1': 101.3, '1/0': 126.7, '2/0': 152.0, '3/0': 177.3, '4/0': 227.0, '250': 289.0, '350': 390.0, '500': 542.0 },
  // Conduit internal area in mm² (CEC Table 8 simplified)
  _conduitAreas: {
    emt:   { '0.5': 163, '0.75': 290, '1': 490, '1.25': 808, '1.5': 1065, '2': 1778, '2.5': 2892, '3': 4536, '4': 7854 },
    rigid: { '0.5': 176, '0.75': 305, '1': 508, '1.25': 843, '1.5': 1117, '2': 1855, '2.5': 3019, '3': 4717, '4': 8107 },
    pvc40: { '0.5': 168, '0.75': 298, '1': 500, '1.25': 827, '1.5': 1090, '2': 1820, '2.5': 2960, '3': 4640, '4': 8000 },
    pvc80: { '0.5': 137, '0.75': 250, '1': 424, '1.25': 710, '1.5': 947, '2': 1590, '2.5': 2600, '3': 4080, '4': 7050 },
    flex:  { '0.5': 152, '0.75': 276, '1': 470, '1.25': 785, '1.5': 1040, '2': 1740, '2.5': 2830, '3': 4430, '4': 7670 },
  },

  _updateConduitFill() {
    const type = document.getElementById('cfType').value;
    const size = document.getElementById('cfSize').value;
    const wireSize = document.getElementById('cfWireSize').value;
    const count = parseInt(document.getElementById('cfCount').value) || 1;

    const wireArea = this._wireAreas[wireSize] || 11.68;
    const conduitArea = (this._conduitAreas[type] || this._conduitAreas.emt)[size] || 490;

    const totalWireArea = wireArea * count;
    // CEC fill limits: 1 wire=53%, 2 wires=31%, 3+ wires=40%
    const maxPct = count === 1 ? 53 : count === 2 ? 31 : 40;
    const allowedArea = conduitArea * (maxPct / 100);
    const fillPct = (totalWireArea / conduitArea) * 100;
    const passes = fillPct <= maxPct;
    const maxWires = Math.floor(allowedArea / wireArea);

    const color = passes ? '#22c55e' : '#ef4444';
    const r = document.getElementById('cfResult');
    if (r) {
      r.innerHTML = `
        <h3 style="margin:0 0 16px;font-size:1rem;">Fill Results</h3>
        <div style="text-align:center;margin-bottom:20px;">
          <div style="font-size:2.5rem;font-weight:900;color:${color};">${fillPct.toFixed(1)}%</div>
          <div style="font-size:0.85rem;color:${color};font-weight:600;">${passes ? 'PASSES' : 'EXCEEDS LIMIT'} (max ${maxPct}%)</div>
        </div>
        <div style="height:12px;background:var(--bg-input);border-radius:6px;overflow:hidden;margin-bottom:16px;position:relative;">
          <div style="height:100%;width:${Math.min(fillPct, 100)}%;background:${color};border-radius:6px;transition:width 0.3s;"></div>
          <div style="position:absolute;left:${maxPct}%;top:0;bottom:0;width:2px;background:var(--text-muted);"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:0.85rem;">
          <div style="background:var(--bg-input);padding:12px;border-radius:var(--radius-sm);">
            <div style="color:var(--text-muted);font-size:0.7rem;">Conduit Area</div>
            <div style="font-weight:700;">${conduitArea} mm&sup2;</div>
          </div>
          <div style="background:var(--bg-input);padding:12px;border-radius:var(--radius-sm);">
            <div style="color:var(--text-muted);font-size:0.7rem;">Wire Area (each)</div>
            <div style="font-weight:700;">${wireArea} mm&sup2;</div>
          </div>
          <div style="background:var(--bg-input);padding:12px;border-radius:var(--radius-sm);">
            <div style="color:var(--text-muted);font-size:0.7rem;">Total Wire Area</div>
            <div style="font-weight:700;">${totalWireArea.toFixed(1)} mm&sup2;</div>
          </div>
          <div style="background:var(--bg-input);padding:12px;border-radius:var(--radius-sm);">
            <div style="color:var(--text-muted);font-size:0.7rem;">Max Conductors</div>
            <div style="font-weight:700;color:var(--accent);">${maxWires}</div>
          </div>
        </div>
        <div style="margin-top:14px;font-size:0.75rem;color:var(--text-muted);">
          CEC fill limits: 1 conductor = 53%, 2 conductors = 31%, 3+ conductors = 40%
        </div>
      `;
    }

    // Draw conduit cross-section canvas
    const c = document.getElementById('cfCanvas');
    if (!c) return;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d0d1a';
    ctx.beginPath(); ctx.roundRect(0, 0, W, H, 10); ctx.fill();

    // Conduit circle
    const cx = W / 2, cy = H / 2 - 10;
    const conduitR = Math.min(130, Math.max(40, Math.sqrt(conduitArea / Math.PI) * 1.8));

    // Outer conduit ring
    ctx.strokeStyle = passes ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)';
    ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(cx, cy, conduitR, 0, Math.PI * 2); ctx.stroke();

    // Conduit interior
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.beginPath(); ctx.arc(cx, cy, conduitR - 4, 0, Math.PI * 2); ctx.fill();

    // Fill indicator arc
    const fillAngle = (fillPct / 100) * Math.PI * 2;
    const fillGrad = ctx.createConicGradient(-Math.PI / 2, cx, cy);
    fillGrad.addColorStop(0, passes ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.5)');
    fillGrad.addColorStop(Math.min(fillPct / 100, 1), passes ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)');
    fillGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = fillGrad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, conduitR - 4, -Math.PI / 2, -Math.PI / 2 + fillAngle);
    ctx.closePath();
    ctx.fill();

    // Draw conductor circles (pack them in)
    const wireR = Math.sqrt(wireArea / Math.PI);
    const wireRpx = wireR * (conduitR / Math.sqrt(conduitArea / Math.PI)) * 0.9;
    const cols = [
      ['#3b82f6', '#60a5fa'], ['#8b5cf6', '#a78bfa'], ['#22c55e', '#4ade80'],
      ['#f59e0b', '#fcd34d'], ['#ef4444', '#f87171'], ['#ec4899', '#f472b6'],
    ];
    // Simple grid packing for up to 20 visible wires
    const visibleWires = Math.min(count, 25);
    for (let i = 0; i < visibleWires; i++) {
      // Sunflower spiral packing
      const angle2 = i * 2.399;
      const r2 = wireRpx * 1.05 * Math.sqrt(i + 0.5) * (conduitR / (wireRpx * Math.sqrt(visibleWires + 1)));
      const wx = cx + r2 * Math.cos(angle2);
      const wy = cy + r2 * Math.sin(angle2);
      const col = cols[i % cols.length];
      const wGrad = ctx.createRadialGradient(wx - wireRpx * 0.3, wy - wireRpx * 0.3, wireRpx * 0.1, wx, wy, wireRpx);
      wGrad.addColorStop(0, col[1]);
      wGrad.addColorStop(1, col[0]);
      ctx.fillStyle = wGrad;
      ctx.beginPath(); ctx.arc(wx, wy, Math.max(wireRpx - 1, 2), 0, Math.PI * 2); ctx.fill();
    }
    if (count > 25) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = 'bold 11px Inter'; ctx.textAlign = 'center';
      ctx.fillText('+' + (count - 25) + ' more', cx, cy + conduitR + 16);
    }

    // Fill % in center
    ctx.fillStyle = passes ? '#22c55e' : '#ef4444';
    ctx.font = 'bold 22px Inter'; ctx.textAlign = 'center';
    ctx.shadowColor = passes ? '#22c55e' : '#ef4444'; ctx.shadowBlur = 8;
    ctx.fillText(fillPct.toFixed(1) + '%', cx, cy + 8);
    ctx.shadowBlur = 0;
    ctx.fillStyle = passes ? 'rgba(34,197,94,0.6)' : 'rgba(239,68,68,0.6)';
    ctx.font = '10px Inter';
    ctx.fillText(passes ? 'PASS' : 'FAIL', cx, cy + 22);

    // Max wire limit badge
    ctx.fillStyle = 'rgba(245,158,11,0.8)'; ctx.font = '9.5px Inter'; ctx.textAlign = 'center';
    ctx.fillText('Max ' + maxWires + ' · ' + type.toUpperCase() + ' ' + size + '"', cx, H - 10);
  },

  // ===== RLC IMPEDANCE CALCULATOR =====
  _simRLC() {
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
          <div style="padding:18px 20px;background:linear-gradient(135deg,rgba(139,92,246,0.07),transparent);border-bottom:1px solid rgba(255,255,255,0.05);">
            <div style="font-weight:700;font-size:0.95rem;margin-bottom:12px;">🌀 RLC Circuit Parameters</div>
            <div style="display:flex;gap:4px;margin-bottom:14px;background:var(--bg-input);border-radius:8px;padding:3px;">
              <button id="rlcSerBtn" onclick="Tools._rlcMode='series';document.getElementById('rlcSerBtn').style.cssText='flex:1;padding:7px;border:none;border-radius:6px;font-size:0.8rem;font-weight:700;cursor:pointer;background:var(--accent);color:#000;';document.getElementById('rlcParBtn').style.cssText='flex:1;padding:7px;border:none;border-radius:6px;font-size:0.8rem;font-weight:600;cursor:pointer;background:transparent;color:var(--text-muted);';Tools._updateRLC()" style="flex:1;padding:7px;border:none;border-radius:6px;font-size:0.8rem;font-weight:700;cursor:pointer;background:var(--accent);color:#000;">Series</button>
              <button id="rlcParBtn" onclick="Tools._rlcMode='parallel';document.getElementById('rlcParBtn').style.cssText='flex:1;padding:7px;border:none;border-radius:6px;font-size:0.8rem;font-weight:700;cursor:pointer;background:var(--accent);color:#000;';document.getElementById('rlcSerBtn').style.cssText='flex:1;padding:7px;border:none;border-radius:6px;font-size:0.8rem;font-weight:600;cursor:pointer;background:transparent;color:var(--text-muted);';Tools._updateRLC()" style="flex:1;padding:7px;border:none;border-radius:6px;font-size:0.8rem;font-weight:600;cursor:pointer;background:transparent;color:var(--text-muted);">Parallel</button>
            </div>
            <div style="display:flex;flex-direction:column;gap:10px;">
              ${[
                {id:'rlcR', label:'Resistance R', unit:'Ω', val:'100', col:'#22c55e'},
                {id:'rlcL', label:'Inductance L', unit:'mH', val:'50', col:'#8b5cf6'},
                {id:'rlcC', label:'Capacitance C', unit:'μF', val:'10', col:'#3b82f6'},
                {id:'rlcF', label:'Frequency', unit:'Hz', val:'60', col:'#f59e0b'},
                {id:'rlcV', label:'Source Voltage', unit:'V', val:'120', col:'#ef4444'},
              ].map(p => `<div style="display:flex;align-items:center;gap:8px;">
                <label style="font-size:0.72rem;color:var(--text-muted);width:110px;flex-shrink:0;">${p.label}</label>
                <input type="number" id="${p.id}" value="${p.val}" min="0" style="flex:1;padding:7px 10px;background:rgba(${p.col==='#22c55e'?'34,197,94':p.col==='#8b5cf6'?'139,92,246':p.col==='#3b82f6'?'59,130,246':p.col==='#f59e0b'?'245,158,11':'239,68,68'},0.07);border:1px solid rgba(${p.col==='#22c55e'?'34,197,94':p.col==='#8b5cf6'?'139,92,246':p.col==='#3b82f6'?'59,130,246':p.col==='#f59e0b'?'245,158,11':'239,68,68'},0.25);border-radius:8px;color:${p.col};font-weight:700;" oninput="Tools._updateRLC()">
                <span style="font-size:0.75rem;color:${p.col};font-weight:600;width:28px;">${p.unit}</span>
              </div>`).join('')}
            </div>
          </div>
          <div id="rlcResult" style="padding:16px 20px;">
            <p style="color:var(--text-muted);font-size:0.85rem;margin:0;">Adjust values above to see impedance results.</p>
          </div>
        </div>
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:12px;">
          <div style="font-weight:700;font-size:0.95rem;">📐 Phasor Diagram</div>
          <canvas id="rlcCanvas" width="420" height="360" style="border-radius:10px;width:100%;"></canvas>
          <div style="display:flex;gap:12px;font-size:0.72rem;flex-wrap:wrap;">
            <span style="color:#22c55e;">■ R (Resistance)</span>
            <span style="color:#8b5cf6;">■ X<sub>L</sub> (Inductive)</span>
            <span style="color:#3b82f6;">■ X<sub>C</sub> (Capacitive)</span>
            <span style="color:#f59e0b;">■ Z (Impedance)</span>
          </div>
        </div>
      </div>
    `;
  },

  _rlcMode: 'series',

  _updateRLC() {
    const R = parseFloat(document.getElementById('rlcR').value) || 0;
    const L = (parseFloat(document.getElementById('rlcL').value) || 0) / 1000; // mH to H
    const C = (parseFloat(document.getElementById('rlcC').value) || 0.001) / 1000000; // µF to F
    const f = parseFloat(document.getElementById('rlcF').value) || 60;
    const V = parseFloat(document.getElementById('rlcV').value) || 120;

    const XL = 2 * Math.PI * f * L;
    const XC = C > 0 ? 1 / (2 * Math.PI * f * C) : 0;
    const fRes = (L > 0 && C > 0) ? 1 / (2 * Math.PI * Math.sqrt(L * C)) : 0;

    let Z, angle, I, nature;
    if (this._rlcMode === 'series') {
      const X = XL - XC;
      Z = Math.sqrt(R * R + X * X);
      angle = Math.atan2(X, R) * 180 / Math.PI;
      I = Z > 0 ? V / Z : 0;
      nature = X > 0.1 ? 'Inductive' : X < -0.1 ? 'Capacitive' : 'Resistive (resonance)';
    } else {
      // Parallel: 1/Z = 1/R + j(1/XC - 1/XL)
      const gR = R > 0 ? 1 / R : 0;
      const bL = XL > 0 ? -1 / XL : 0;
      const bC = XC > 0 ? 1 / XC : 0;
      const bTotal = bL + bC;
      Z = 1 / Math.sqrt(gR * gR + bTotal * bTotal);
      angle = -Math.atan2(bTotal, gR) * 180 / Math.PI;
      I = Z > 0 ? V / Z : 0;
      nature = bTotal < -0.001 ? 'Inductive' : bTotal > 0.001 ? 'Capacitive' : 'Resistive (resonance)';
    }

    const PF = Z > 0 ? Math.cos(angle * Math.PI / 180) : 1;
    const P = V * I * PF;
    const Q = V * I * Math.sin(angle * Math.PI / 180);
    const S = V * I;
    const natureColor = nature.includes('Inductive') ? '#8b5cf6' : nature.includes('Capacitive') ? '#3b82f6' : '#22c55e';

    const r = document.getElementById('rlcResult');
    if (r) {
      r.innerHTML = `
        <h3 style="margin:0 0 16px;font-size:1rem;">Impedance Results — ${this._rlcMode === 'series' ? 'Series' : 'Parallel'}</h3>
        <div style="text-align:center;margin-bottom:20px;">
          <div style="font-size:2.2rem;font-weight:900;color:var(--accent);">${Z.toFixed(2)} &Omega;</div>
          <div style="font-size:0.85rem;color:${natureColor};font-weight:600;">${nature} &middot; &theta; = ${angle.toFixed(1)}&deg;</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
          <div style="background:var(--bg-input);padding:12px;border-radius:var(--radius-sm);text-align:center;">
            <div style="font-size:1.2rem;font-weight:800;color:var(--accent);">${I.toFixed(3)}A</div>
            <div style="font-size:0.7rem;color:var(--text-muted);">Current</div>
          </div>
          <div style="background:var(--bg-input);padding:12px;border-radius:var(--radius-sm);text-align:center;">
            <div style="font-size:1.2rem;font-weight:800;color:#22c55e;">${(PF * 100).toFixed(1)}%</div>
            <div style="font-size:0.7rem;color:var(--text-muted);">Power Factor</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;font-size:0.85rem;">
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
            <span style="color:#8b5cf6;">X<sub>L</sub> (Inductive)</span><span style="font-weight:600;">${XL.toFixed(2)} &Omega;</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
            <span style="color:#3b82f6;">X<sub>C</sub> (Capacitive)</span><span style="font-weight:600;">${XC.toFixed(2)} &Omega;</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
            <span style="color:#22c55e;">P (True Power)</span><span style="font-weight:600;">${P.toFixed(1)} W</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
            <span style="color:#ef4444;">Q (Reactive)</span><span style="font-weight:600;">${Math.abs(Q).toFixed(1)} VAR</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
            <span style="color:var(--accent);">S (Apparent)</span><span style="font-weight:600;">${S.toFixed(1)} VA</span>
          </div>
          ${fRes > 0 ? `<div style="display:flex;justify-content:space-between;padding:8px 0;margin-top:4px;border-top:2px solid rgba(34,197,94,0.3);">
            <span style="color:#22c55e;font-weight:600;">Resonant Frequency</span><span style="font-weight:800;color:#22c55e;">${fRes.toFixed(2)} Hz</span>
          </div>` : ''}
        </div>
      `;
    }

    // Draw phasor diagram
    const c = document.getElementById('rlcCanvas');
    if (!c) return;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d0d1a';
    ctx.beginPath(); ctx.roundRect(0, 0, W, H, 10); ctx.fill();

    const ox = 70, oy = H / 2;
    const pXL = 2 * Math.PI * (parseFloat(document.getElementById('rlcF')?.value||60)) * ((parseFloat(document.getElementById('rlcL')?.value||50))/1000);
    const pXC = (() => { const cF = (parseFloat(document.getElementById('rlcC')?.value||10))/1000000; const f2 = parseFloat(document.getElementById('rlcF')?.value||60); return cF > 0 ? 1/(2*Math.PI*f2*cF) : 0; })();
    const pR = parseFloat(document.getElementById('rlcR')?.value||100);
    const maxVal = Math.max(pR, pXL, pXC, Z, 1);
    const scale = Math.min(160 / maxVal, 2);

    const drawArrow = (fromX, fromY, toX, toY, color, label, glow) => {
      const dx = toX - fromX, dy = toY - fromY;
      const len = Math.sqrt(dx*dx + dy*dy);
      if (len < 2) return;
      if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 10; }
      ctx.strokeStyle = color; ctx.lineWidth = glow ? 3 : 2;
      ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.lineTo(toX, toY); ctx.stroke();
      // Arrowhead
      const ang = Math.atan2(dy, dx);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(toX, toY);
      ctx.lineTo(toX - 8*Math.cos(ang-0.4), toY - 8*Math.sin(ang-0.4));
      ctx.lineTo(toX - 8*Math.cos(ang+0.4), toY - 8*Math.sin(ang+0.4));
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      if (label) {
        ctx.fillStyle = color; ctx.font = 'bold 10px Inter'; ctx.textAlign = 'center';
        ctx.fillText(label, toX + 14*Math.cos(ang) + (dy > 0 ? -8 : 8), toY + 14*Math.sin(ang));
      }
    };

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      const r = i * 40;
      ctx.beginPath(); ctx.arc(ox, oy, r, 0, Math.PI*2); ctx.stroke();
    }
    // Axes
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ox - 180, oy); ctx.lineTo(W - 10, oy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ox, 10); ctx.lineTo(ox, H - 10); ctx.stroke();

    // Axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.font = '9px Inter'; ctx.textAlign = 'left';
    ctx.fillText('Re (R)', W - 45, oy - 6);
    ctx.textAlign = 'center';
    ctx.fillText('Im (+jX)', ox, 16);
    ctx.fillText('-jX', ox, H - 6);

    // R vector (horizontal, green)
    const rPx = pR * scale;
    drawArrow(ox, oy, ox + rPx, oy, '#22c55e', 'R=' + pR.toFixed(0) + 'Ω', false);

    // XL vector (vertical up, purple)
    const xlPx = pXL * scale;
    drawArrow(ox + rPx, oy, ox + rPx, oy - xlPx, '#8b5cf6', 'XL=' + pXL.toFixed(1) + 'Ω', false);

    // XC vector (vertical down, blue)
    const xcPx = pXC * scale;
    drawArrow(ox + rPx, oy, ox + rPx, oy + xcPx, '#3b82f6', 'XC=' + pXC.toFixed(1) + 'Ω', false);

    // Net X vector
    const netX = pXL - pXC;
    const xnetPx = netX * scale;
    if (Math.abs(netX) > 0.5) {
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.moveTo(ox + rPx, oy - xnetPx); ctx.lineTo(ox, oy); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Z vector (hypotenuse, amber glow)
    const zPx = Z * scale;
    const angleRad = angle * Math.PI / 180;
    drawArrow(ox, oy, ox + rPx, oy - xnetPx, '#f59e0b', 'Z=' + Z.toFixed(1) + 'Ω', true);

    // Angle arc
    ctx.strokeStyle = 'rgba(245,158,11,0.5)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(ox, oy, 28, -angleRad, 0); ctx.stroke();
    ctx.fillStyle = 'rgba(245,158,11,0.8)'; ctx.font = '9px Inter'; ctx.textAlign = 'center';
    ctx.fillText('θ=' + angle.toFixed(0) + '°', ox + 38, oy + (angle >= 0 ? -8 : 10));

    // Nature label
    ctx.fillStyle = natureColor; ctx.font = 'bold 11px Inter'; ctx.textAlign = 'center';
    ctx.fillText(nature + ' · PF = ' + (Math.abs(PF)*100).toFixed(1) + '%', W/2, H - 8);
  },

  // ===== DRAWING & DIAGRAM CONVERSION SIMULATOR =====
  _diagScenario: 0,
  _diagView: 'block',
  _diagTab: 'learn',
  _diagQuizIdx: 0,
  _diagQuizAnswered: false,
  _diagQuizScore: 0,
  _diagQuizTotal: 0,

  _initDiagramSim() {
    this._diagScenario = this._diagScenario || 0;
    this._diagView = this._diagView || 'block';
    this._diagTab = this._diagTab || 'learn';
    this._renderDiagramContent();
  },

  _renderDiagramContent() {
    const el = document.getElementById('diag-content');
    if (!el) return;
    el.innerHTML = this._diagTab === 'quiz' ? this._diagQuizHTML() : this._diagLearnHTML();
  },

  _diagScenarios: [
    { name: 'Basic Switch & Light', icon: '&#x1F4A1;', color: '#f59e0b' },
    { name: '3-Way Switch Circuit', icon: '&#x1F4A1;', color: '#22c55e' },
    { name: 'Relay Control Circuit', icon: '&#x26A1;', color: '#3b82f6' },
    { name: 'Motor Starter (3-Wire)', icon: '&#x2699;', color: '#8b5cf6' },
  ],

  _simDiagramConversion() {
    this._diagScenario = this._diagScenario || 0;
    this._diagView = this._diagView || 'block';
    this._diagTab = this._diagTab || 'learn';
    const sc = this._diagScenarios;
    const active = this._diagScenario;
    return `
    <div style="max-width:900px;margin:0 auto;">
      <!-- Tab bar -->
      <div style="display:flex;gap:8px;margin-bottom:20px;">
        <button onclick="Tools._diagTab='learn';Tools._renderDiagramContent()" style="padding:9px 22px;border-radius:10px;border:none;cursor:pointer;font-weight:700;font-size:0.85rem;background:${this._diagTab==='learn'?'var(--accent)':'var(--bg-card)'};color:${this._diagTab==='learn'?'#000':'var(--text-secondary)'};border:1px solid ${this._diagTab==='learn'?'transparent':'var(--border)'};">&#x1F4DA; Learn</button>
        <button onclick="Tools._diagTab='quiz';Tools._diagQuizIdx=0;Tools._diagQuizAnswered=false;Tools._diagQuizScore=0;Tools._diagQuizTotal=0;Tools._renderDiagramContent()" style="padding:9px 22px;border-radius:10px;border:none;cursor:pointer;font-weight:700;font-size:0.85rem;background:${this._diagTab==='quiz'?'var(--accent)':'var(--bg-card)'};color:${this._diagTab==='quiz'?'#000':'var(--text-secondary)'};border:1px solid ${this._diagTab==='quiz'?'transparent':'var(--border)'};">&#x1F9E0; Quiz</button>
      </div>
      <!-- Scenario tabs -->
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px;">
        ${sc.map((s,i) => `<button onclick="Tools._diagScenario=${i};Tools._diagView='block';Tools._renderDiagramContent()" style="padding:7px 14px;border-radius:10px;border:none;cursor:pointer;font-size:0.8rem;font-weight:700;background:${i===active?s.color:'var(--bg-card)'};color:${i===active?'#000':'var(--text-secondary)'};border:1px solid ${i===active?'transparent':'var(--border)'};">${s.icon} ${s.name}</button>`).join('')}
      </div>
      <!-- Dynamic content -->
      <div id="diag-content">${this._diagTab === 'quiz' ? this._diagQuizHTML() : this._diagLearnHTML()}</div>
    </div>`;
  },

  _diagLearnHTML() {
    const s = this._diagScenario;
    const v = this._diagView;
    const sc = this._diagScenarios[s];
    const views = ['block','wiring','schematic'];
    const vLabels = { block:'Block Diagram', wiring:'Wiring Diagram', schematic:'Schematic (Ladder)' };
    const vIcons = { block:'&#x1F4E6;', wiring:'&#x1F9F5;', schematic:'&#x1F4C4;' };
    const svgFn = [this._diagSVGBlock.bind(this), this._diagSVGWiring.bind(this), this._diagSVGSchematic.bind(this)];
    const svgHTML = v === 'block' ? this._diagSVGBlock(s) : v === 'wiring' ? this._diagSVGWiring(s) : this._diagSVGSchematic(s);
    const wireInfo = this._diagWireInfo(s, v);
    const explainText = this._diagExplain(s, v);
    return `
    <!-- View toggle -->
    <div style="display:flex;gap:6px;margin-bottom:18px;background:var(--bg-input);padding:4px;border-radius:12px;width:fit-content;">
      ${views.map(vv => `<button onclick="Tools._diagView='${vv}';Tools._renderDiagramContent()" style="padding:8px 18px;border-radius:9px;border:none;cursor:pointer;font-size:0.8rem;font-weight:700;background:${vv===v?sc.color:'transparent'};color:${vv===v?'#000':'var(--text-muted)'};">${vIcons[vv]} ${vLabels[vv]}</button>`).join('')}
    </div>
    <!-- What am I looking at -->
    <div style="margin-bottom:14px;padding:12px 16px;background:rgba(${s===0?'245,158,11':s===1?'34,197,94':s===2?'59,130,246':'139,92,246'},0.07);border:1px solid rgba(${s===0?'245,158,11':s===1?'34,197,94':s===2?'59,130,246':'139,92,246'},0.2);border-radius:10px;font-size:0.82rem;color:var(--text-secondary);line-height:1.6;">
      <strong style="color:${sc.color};">${vLabels[v]} — what you're looking at:</strong><br>${explainText}
    </div>
    <!-- SVG diagram -->
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:18px;overflow:auto;">
      ${svgHTML}
    </div>
    <!-- Wire count breakdown -->
    ${wireInfo}`;
  },

  _diagExplain(s, v) {
    const texts = {
      0: {
        block: 'A block diagram shows the <strong>function</strong> of each part using labeled boxes and arrows. No wire colours, no box internals — just the logical flow of power from source to load.',
        wiring: 'A wiring diagram shows <strong>actual physical connections</strong>: which wire goes where, the real colours used, and how conductors are connected inside each box. This is what an electrician uses on the job.',
        schematic: 'A schematic (ladder diagram) uses <strong>standard symbols</strong> on two rails (L1 and N). It shows the circuit logic clearly — easy to read fault conditions. Each rung is a complete series path from L1 to N.'
      },
      1: {
        block: 'The 3-way switch circuit uses <strong>two 3-way switches</strong> to control one light from two locations. The block diagram shows the order of components without wire details.',
        wiring: 'Three cable runs are used. Source→SW1 is 14/2, SW1→SW2 is <strong>14/3</strong> (adds a red traveler wire), SW2→Light is 14/2. The two conductors between switches are called <strong>travelers</strong>.',
        schematic: 'The schematic shows both switches sharing two traveler conductors. Only one traveler is in the circuit at a time — flipping either switch changes which traveler is active, toggling the light.'
      },
      2: {
        block: 'A relay control circuit has two parts: the <strong>control circuit</strong> (low energy, switches the coil) and the <strong>power circuit</strong> (full voltage, switches the load via contacts). The block diagram separates these.',
        wiring: 'The control circuit runs 120V through a pushbutton to energize the relay coil. When the coil pulls in, the <strong>NO contact closes</strong>, completing the power circuit to the load. Two separate circuits share the same enclosure.',
        schematic: 'The top rung is the control circuit (pushbutton → coil). The bottom rung is the power circuit (contact → load). This is standard ladder diagram format used in industry.'
      },
      3: {
        block: 'Three-wire control uses a <strong>seal-in contact</strong> (M) in parallel with the Start button so the motor runs after you release Start. Stop breaks the entire circuit. OL contacts protect against overload.',
        wiring: 'The push button station connects back to the starter. Stop (NC) is in series; Start (NO) is in parallel with the M contact. Wire count depends on whether neutral runs to the button station.',
        schematic: 'Classic 3-wire ladder: Stop NC → Start NO parallel with M → M Coil. Main contacts feed three-phase power through OL heaters to the motor. OL NC contacts are in the control rung.'
      }
    };
    return texts[s][v];
  },

  _diagWireInfo(s, v) {
    const info = {
      0: {
        block: [
          { label: 'Panel → Switch Box', count: 2, wires: ['Black (hot)','White (neutral)'], note: 'Standard 14/2 NMD90' },
          { label: 'Switch Box → Light Box', count: 2, wires: ['Black (switched hot)','White (neutral)'], note: 'White must be re-identified at switch box' },
        ],
        wiring: [
          { label: 'Panel → Switch Box', count: 2, wires: ['Black (hot → switch)','White (neutral → pigtail)'], note: '14/2 NMD90 · 2 current-carrying conductors' },
          { label: 'Switch Box → Light Box', count: 2, wires: ['Black (switched hot)','White (neutral)'], note: 'Re-identify white with black tape at switch' },
        ],
        schematic: [
          { label: 'Control path', count: 2, wires: ['L1 through switch contact','Return on Neutral'], note: 'Switch interrupts the ungrounded (hot) conductor only' },
        ]
      },
      1: {
        block: [
          { label: 'Panel → 3-Way SW1', count: 2, wires: ['Black (hot)','White (neutral)'], note: '14/2 NMD90' },
          { label: 'SW1 → 3-Way SW2', count: 3, wires: ['Black (traveler)','Red (traveler)','White (common)'], note: '14/3 NMD90 — the extra wire is key!' },
          { label: 'SW2 → Light', count: 2, wires: ['Black (switched hot)','White (neutral)'], note: '14/2 NMD90' },
        ],
        wiring: [
          { label: 'Panel → SW1', count: 2, wires: ['Black','White'], note: '14/2 · Hot goes to SW1 common terminal' },
          { label: 'SW1 → SW2 (travelers)', count: 3, wires: ['Black traveler','Red traveler','White (neutral)'], note: '14/3 · Black & Red connect traveler terminals; White passes neutral through' },
          { label: 'SW2 → Light', count: 2, wires: ['Black (switched hot from SW2 common)','White (neutral)'], note: '14/2 · White re-identified if used as hot' },
        ],
        schematic: [
          { label: 'Traveler conductors', count: 2, wires: ['Traveler A','Traveler B'], note: 'Only one active path at a time' },
          { label: 'Common conductors', count: 2, wires: ['Hot into SW1','Switched hot to lamp'], note: 'Commons connect to the "pivot" of each switch' },
        ]
      },
      2: {
        block: [
          { label: 'Control circuit', count: 2, wires: ['Hot (L1)','Neutral'], note: '120V control, low amperage' },
          { label: 'Power circuit', count: 2, wires: ['Line hot','Load neutral'], note: '120/240V to load — switched by relay contacts' },
        ],
        wiring: [
          { label: 'Pushbutton → Relay', count: 2, wires: ['Control hot','Control return'], note: 'Small gauge acceptable — coil is low current' },
          { label: 'Relay contact → Load', count: 2, wires: ['Line hot (through contact)','Neutral to load'], note: 'Must be rated for full load current' },
        ],
        schematic: [
          { label: 'Control rung', count: 2, wires: ['L1 rail','N rail'], note: 'Pushbutton → coil completes control rung' },
          { label: 'Power rung', count: 2, wires: ['L1 rail','N rail'], note: 'NO contact → load completes power rung' },
        ]
      },
      3: {
        block: [
          { label: 'Push button station', count: 3, wires: ['L1 control','Common (between Stop & Start)','Return to starter'], note: '3 wires to button station — gives 3-wire control name' },
          { label: 'Starter → Motor', count: 3, wires: ['T1','T2','T3'], note: '3-phase · runs through OL heaters' },
        ],
        wiring: [
          { label: 'Control source → Stop PB', count: 2, wires: ['Control hot','Neutral'], note: 'Stop NC in series with everything' },
          { label: 'Stop → Start PB', count: 1, wires: ['Series conductor'], note: 'One wire between Stop and Start' },
          { label: 'Start PB → M Coil', count: 1, wires: ['Coil hot'], note: 'Parallel path: Start NO or M NO seal-in' },
          { label: 'Starter → Motor', count: 3, wires: ['T1 (L1 through M contact)','T2 (L2 through M contact)','T3 (L3 through M contact)'], note: 'All three phases interrupted by main contacts' },
        ],
        schematic: [
          { label: 'Control rung wires', count: 3, wires: ['L1 control rail','Junction at Start/M contact','N rail (coil return)'], note: '3-wire control — Stop, Start, M coil' },
          { label: 'Power circuit', count: 6, wires: ['L1/L2/L3 line side','T1/T2/T3 load side'], note: '3 lines in, 3 lines out through main contacts and OL heaters' },
        ]
      }
    };
    const rows = info[s][v];
    const colors = ['#f59e0b','#22c55e','#3b82f6','#8b5cf6','#ec4899','#ef4444'];
    return `
    <div style="margin-top:4px;">
      <h4 style="font-size:0.78rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin:0 0 10px;">&#x1F9F5; Conductor Count Breakdown</h4>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;">
        ${rows.map((r,i) => `
        <div style="background:var(--bg-card);border:1px solid rgba(${colors[i%colors.length]==='#f59e0b'?'245,158,11':colors[i%colors.length]==='#22c55e'?'34,197,94':colors[i%colors.length]==='#3b82f6'?'59,130,246':colors[i%colors.length]==='#8b5cf6'?'139,92,246':colors[i%colors.length]==='#ec4899'?'236,72,153':'239,68,68'},0.3);border-radius:12px;padding:14px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <div style="width:28px;height:28px;border-radius:8px;background:${colors[i%colors.length]};display:flex;align-items:center;justify-content:center;font-size:0.85rem;font-weight:900;color:#000;">${r.count}</div>
            <div style="font-size:0.82rem;font-weight:700;color:var(--text-primary);">${r.label}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:3px;margin-bottom:6px;">
            ${r.wires.map(w => `<div style="font-size:0.75rem;color:var(--text-secondary);padding-left:4px;">• ${w}</div>`).join('')}
          </div>
          <div style="font-size:0.72rem;color:var(--text-muted);background:var(--bg-input);padding:4px 8px;border-radius:6px;">${r.note}</div>
        </div>`).join('')}
      </div>
    </div>`;
  },

  // === BLOCK DIAGRAM SVGs ===
  _diagSVGBlock(s) {
    if (s === 0) return `
    <svg viewBox="0 0 720 180" style="width:100%;max-width:720px;display:block;margin:0 auto;" font-family="Inter,sans-serif">
      <defs><marker id="arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#94a3b8"/></marker></defs>
      <!-- Panel -->
      <rect x="20" y="60" width="120" height="60" rx="8" fill="rgba(245,158,11,0.1)" stroke="#f59e0b" stroke-width="2"/>
      <text x="80" y="88" text-anchor="middle" fill="#f59e0b" font-size="12" font-weight="700">PANEL</text>
      <text x="80" y="104" text-anchor="middle" fill="#94a3b8" font-size="10">120V Source</text>
      <!-- Arrow 1 -->
      <line x1="140" y1="90" x2="270" y2="90" stroke="#94a3b8" stroke-width="2" marker-end="url(#arr)"/>
      <text x="205" y="82" text-anchor="middle" fill="#94a3b8" font-size="10">14/2 NMD90</text>
      <text x="205" y="110" text-anchor="middle" fill="#64748b" font-size="9">2 conductors</text>
      <!-- Switch -->
      <rect x="270" y="60" width="120" height="60" rx="8" fill="rgba(59,130,246,0.1)" stroke="#3b82f6" stroke-width="2"/>
      <text x="330" y="88" text-anchor="middle" fill="#3b82f6" font-size="12" font-weight="700">SWITCH BOX</text>
      <text x="330" y="104" text-anchor="middle" fill="#94a3b8" font-size="10">Single-pole SW</text>
      <!-- Arrow 2 -->
      <line x1="390" y1="90" x2="520" y2="90" stroke="#94a3b8" stroke-width="2" marker-end="url(#arr)"/>
      <text x="455" y="82" text-anchor="middle" fill="#94a3b8" font-size="10">14/2 NMD90</text>
      <text x="455" y="110" text-anchor="middle" fill="#64748b" font-size="9">2 conductors</text>
      <!-- Light -->
      <rect x="520" y="60" width="120" height="60" rx="8" fill="rgba(34,197,94,0.1)" stroke="#22c55e" stroke-width="2"/>
      <text x="580" y="88" text-anchor="middle" fill="#22c55e" font-size="12" font-weight="700">LIGHT BOX</text>
      <text x="580" y="104" text-anchor="middle" fill="#94a3b8" font-size="10">120V Lamp</text>
      <!-- Labels -->
      <text x="360" y="165" text-anchor="middle" fill="#64748b" font-size="10">Power flows left → right when switch is closed</text>
    </svg>`;

    if (s === 1) return `
    <svg viewBox="0 0 820 200" style="width:100%;max-width:820px;display:block;margin:0 auto;" font-family="Inter,sans-serif">
      <defs><marker id="arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#94a3b8"/></marker></defs>
      <rect x="10" y="65" width="110" height="60" rx="8" fill="rgba(245,158,11,0.1)" stroke="#f59e0b" stroke-width="2"/>
      <text x="65" y="93" text-anchor="middle" fill="#f59e0b" font-size="11" font-weight="700">PANEL</text>
      <text x="65" y="108" text-anchor="middle" fill="#94a3b8" font-size="9">120V Source</text>
      <line x1="120" y1="95" x2="200" y2="95" stroke="#94a3b8" stroke-width="2" marker-end="url(#arr)"/>
      <text x="160" y="87" text-anchor="middle" fill="#94a3b8" font-size="9">14/2</text>
      <text x="160" y="113" text-anchor="middle" fill="#64748b" font-size="8">2 cond.</text>
      <rect x="200" y="65" width="130" height="60" rx="8" fill="rgba(34,197,94,0.1)" stroke="#22c55e" stroke-width="2"/>
      <text x="265" y="89" text-anchor="middle" fill="#22c55e" font-size="11" font-weight="700">3-WAY SW 1</text>
      <text x="265" y="104" text-anchor="middle" fill="#94a3b8" font-size="9">Location 1</text>
      <line x1="330" y1="95" x2="440" y2="95" stroke="#94a3b8" stroke-width="2" marker-end="url(#arr)"/>
      <text x="385" y="87" text-anchor="middle" fill="#ec4899" font-size="9" font-weight="700">14/3 !</text>
      <text x="385" y="113" text-anchor="middle" fill="#64748b" font-size="8">3 cond.</text>
      <rect x="440" y="65" width="130" height="60" rx="8" fill="rgba(34,197,94,0.1)" stroke="#22c55e" stroke-width="2"/>
      <text x="505" y="89" text-anchor="middle" fill="#22c55e" font-size="11" font-weight="700">3-WAY SW 2</text>
      <text x="505" y="104" text-anchor="middle" fill="#94a3b8" font-size="9">Location 2</text>
      <line x1="570" y1="95" x2="650" y2="95" stroke="#94a3b8" stroke-width="2" marker-end="url(#arr)"/>
      <text x="610" y="87" text-anchor="middle" fill="#94a3b8" font-size="9">14/2</text>
      <text x="610" y="113" text-anchor="middle" fill="#64748b" font-size="8">2 cond.</text>
      <rect x="650" y="65" width="110" height="60" rx="8" fill="rgba(245,158,11,0.1)" stroke="#f59e0b" stroke-width="2"/>
      <text x="705" y="93" text-anchor="middle" fill="#f59e0b" font-size="11" font-weight="700">LIGHT</text>
      <text x="705" y="108" text-anchor="middle" fill="#94a3b8" font-size="9">120V Lamp</text>
      <rect x="355" y="150" width="60" height="22" rx="6" fill="rgba(236,72,153,0.15)" stroke="#ec4899" stroke-width="1.5"/>
      <text x="385" y="164" text-anchor="middle" fill="#ec4899" font-size="9" font-weight="700">14/3 KEY</text>
      <text x="410" y="182" text-anchor="middle" fill="#64748b" font-size="9">3-wire cable carries both traveler wires between switches</text>
    </svg>`;

    if (s === 2) return `
    <svg viewBox="0 0 820 220" style="width:100%;max-width:820px;display:block;margin:0 auto;" font-family="Inter,sans-serif">
      <defs><marker id="arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#94a3b8"/></marker></defs>
      <!-- Control circuit row -->
      <text x="10" y="30" fill="#3b82f6" font-size="10" font-weight="700">CONTROL CIRCUIT (120V)</text>
      <rect x="10" y="40" width="90" height="50" rx="7" fill="rgba(59,130,246,0.08)" stroke="#3b82f6" stroke-width="1.5"/>
      <text x="55" y="63" text-anchor="middle" fill="#3b82f6" font-size="9" font-weight="700">CONTROL</text>
      <text x="55" y="76" text-anchor="middle" fill="#94a3b8" font-size="8">SOURCE</text>
      <line x1="100" y1="65" x2="160" y2="65" stroke="#3b82f6" stroke-width="1.5" marker-end="url(#arr)"/>
      <rect x="160" y="40" width="90" height="50" rx="7" fill="rgba(59,130,246,0.08)" stroke="#3b82f6" stroke-width="1.5"/>
      <text x="205" y="63" text-anchor="middle" fill="#3b82f6" font-size="9" font-weight="700">PUSH</text>
      <text x="205" y="76" text-anchor="middle" fill="#94a3b8" font-size="8">BUTTON</text>
      <line x1="250" y1="65" x2="310" y2="65" stroke="#3b82f6" stroke-width="1.5" marker-end="url(#arr)"/>
      <rect x="310" y="40" width="90" height="50" rx="7" fill="rgba(59,130,246,0.08)" stroke="#3b82f6" stroke-width="1.5"/>
      <text x="355" y="63" text-anchor="middle" fill="#3b82f6" font-size="9" font-weight="700">RELAY</text>
      <text x="355" y="76" text-anchor="middle" fill="#94a3b8" font-size="8">COIL (M)</text>
      <!-- Dotted line down to contact -->
      <line x1="355" y1="90" x2="355" y2="130" stroke="#3b82f6" stroke-width="1.5" stroke-dasharray="4,3"/>
      <text x="365" y="115" fill="#64748b" font-size="8">actuates</text>
      <!-- Power circuit row -->
      <text x="10" y="148" fill="#22c55e" font-size="10" font-weight="700">POWER CIRCUIT (Full voltage)</text>
      <rect x="160" y="158" width="90" height="50" rx="7" fill="rgba(34,197,94,0.08)" stroke="#22c55e" stroke-width="1.5"/>
      <text x="205" y="181" text-anchor="middle" fill="#22c55e" font-size="9" font-weight="700">M CONTACT</text>
      <text x="205" y="194" text-anchor="middle" fill="#94a3b8" font-size="8">(NO → Closes)</text>
      <line x1="250" y1="183" x2="310" y2="183" stroke="#22c55e" stroke-width="1.5" marker-end="url(#arr)"/>
      <rect x="310" y="158" width="90" height="50" rx="7" fill="rgba(34,197,94,0.08)" stroke="#22c55e" stroke-width="1.5"/>
      <text x="355" y="181" text-anchor="middle" fill="#22c55e" font-size="9" font-weight="700">LOAD</text>
      <text x="355" y="194" text-anchor="middle" fill="#94a3b8" font-size="8">Motor/Light</text>
      <line x1="100" y1="183" x2="160" y2="183" stroke="#22c55e" stroke-width="1.5" marker-end="url(#arr)"/>
      <rect x="10" y="158" width="90" height="50" rx="7" fill="rgba(34,197,94,0.08)" stroke="#22c55e" stroke-width="1.5"/>
      <text x="55" y="181" text-anchor="middle" fill="#22c55e" font-size="9" font-weight="700">LINE</text>
      <text x="55" y="194" text-anchor="middle" fill="#94a3b8" font-size="8">SOURCE</text>
    </svg>`;

    // s === 3, Motor Starter
    return `
    <svg viewBox="0 0 820 230" style="width:100%;max-width:820px;display:block;margin:0 auto;" font-family="Inter,sans-serif">
      <defs><marker id="arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#94a3b8"/></marker></defs>
      <text x="10" y="25" fill="#8b5cf6" font-size="10" font-weight="700">CONTROL CIRCUIT</text>
      <rect x="10" y="35" width="80" height="48" rx="7" fill="rgba(139,92,246,0.08)" stroke="#8b5cf6" stroke-width="1.5"/>
      <text x="50" y="56" text-anchor="middle" fill="#8b5cf6" font-size="8" font-weight="700">CONTROL</text>
      <text x="50" y="68" text-anchor="middle" fill="#94a3b8" font-size="7">L1/L2 120V</text>
      <line x1="90" y1="59" x2="140" y2="59" stroke="#8b5cf6" stroke-width="1.5" marker-end="url(#arr)"/>
      <rect x="140" y="35" width="80" height="48" rx="7" fill="rgba(139,92,246,0.08)" stroke="#8b5cf6" stroke-width="1.5"/>
      <text x="180" y="56" text-anchor="middle" fill="#8b5cf6" font-size="8" font-weight="700">STOP PB</text>
      <text x="180" y="68" text-anchor="middle" fill="#94a3b8" font-size="7">NC Contact</text>
      <line x1="220" y1="59" x2="270" y2="59" stroke="#8b5cf6" stroke-width="1.5" marker-end="url(#arr)"/>
      <rect x="270" y="35" width="100" height="48" rx="7" fill="rgba(139,92,246,0.08)" stroke="#8b5cf6" stroke-width="1.5"/>
      <text x="320" y="53" text-anchor="middle" fill="#8b5cf6" font-size="8" font-weight="700">START PB (NO)</text>
      <text x="320" y="64" text-anchor="middle" fill="#94a3b8" font-size="7">|| M Contact (NO)</text>
      <text x="320" y="75" text-anchor="middle" fill="#22c55e" font-size="7">Seal-in</text>
      <line x1="370" y1="59" x2="420" y2="59" stroke="#8b5cf6" stroke-width="1.5" marker-end="url(#arr)"/>
      <rect x="420" y="35" width="80" height="48" rx="7" fill="rgba(139,92,246,0.08)" stroke="#8b5cf6" stroke-width="1.5"/>
      <text x="460" y="53" text-anchor="middle" fill="#8b5cf6" font-size="8" font-weight="700">OL (NC)</text>
      <text x="460" y="64" text-anchor="middle" fill="#94a3b8" font-size="7">Overload</text>
      <text x="460" y="75" text-anchor="middle" fill="#94a3b8" font-size="7">Contact</text>
      <line x1="500" y1="59" x2="550" y2="59" stroke="#8b5cf6" stroke-width="1.5" marker-end="url(#arr)"/>
      <rect x="550" y="35" width="80" height="48" rx="7" fill="rgba(139,92,246,0.08)" stroke="#8b5cf6" stroke-width="1.5"/>
      <text x="590" y="56" text-anchor="middle" fill="#8b5cf6" font-size="8" font-weight="700">M COIL</text>
      <text x="590" y="68" text-anchor="middle" fill="#94a3b8" font-size="7">Contactor</text>
      <line x1="590" y1="83" x2="590" y2="120" stroke="#8b5cf6" stroke-width="1.5" stroke-dasharray="4,3"/>
      <text x="10" y="140" fill="#22c55e" font-size="10" font-weight="700">POWER CIRCUIT (3-Phase)</text>
      <rect x="10" y="148" width="100" height="50" rx="7" fill="rgba(34,197,94,0.08)" stroke="#22c55e" stroke-width="1.5"/>
      <text x="60" y="170" text-anchor="middle" fill="#22c55e" font-size="8" font-weight="700">L1/L2/L3</text>
      <text x="60" y="182" text-anchor="middle" fill="#94a3b8" font-size="7">3-Phase Supply</text>
      <line x1="110" y1="173" x2="180" y2="173" stroke="#22c55e" stroke-width="1.5" marker-end="url(#arr)"/>
      <rect x="180" y="148" width="120" height="50" rx="7" fill="rgba(34,197,94,0.08)" stroke="#22c55e" stroke-width="1.5"/>
      <text x="240" y="170" text-anchor="middle" fill="#22c55e" font-size="8" font-weight="700">M MAIN CONTACTS</text>
      <text x="240" y="182" text-anchor="middle" fill="#94a3b8" font-size="7">3 contacts (T1/T2/T3)</text>
      <line x1="300" y1="173" x2="370" y2="173" stroke="#22c55e" stroke-width="1.5" marker-end="url(#arr)"/>
      <rect x="370" y="148" width="100" height="50" rx="7" fill="rgba(34,197,94,0.08)" stroke="#22c55e" stroke-width="1.5"/>
      <text x="420" y="170" text-anchor="middle" fill="#22c55e" font-size="8" font-weight="700">OL HEATERS</text>
      <text x="420" y="182" text-anchor="middle" fill="#94a3b8" font-size="7">3 elements</text>
      <line x1="470" y1="173" x2="540" y2="173" stroke="#22c55e" stroke-width="1.5" marker-end="url(#arr)"/>
      <rect x="540" y="148" width="80" height="50" rx="7" fill="rgba(34,197,94,0.08)" stroke="#22c55e" stroke-width="1.5"/>
      <text x="580" y="170" text-anchor="middle" fill="#22c55e" font-size="8" font-weight="700">MOTOR</text>
      <text x="580" y="182" text-anchor="middle" fill="#94a3b8" font-size="7">3-Phase</text>
    </svg>`;
  },

  // === WIRING DIAGRAM SVGs ===
  _diagSVGWiring(s) {
    if (s === 0) return `
    <svg viewBox="0 0 720 260" style="width:100%;max-width:720px;display:block;margin:0 auto;" font-family="Inter,sans-serif">
      <!-- Panel box -->
      <rect x="20" y="90" width="90" height="80" rx="8" fill="#1e293b" stroke="#475569" stroke-width="2"/>
      <text x="65" y="126" text-anchor="middle" fill="#94a3b8" font-size="11" font-weight="700">PANEL</text>
      <text x="65" y="143" text-anchor="middle" fill="#64748b" font-size="9">15A Breaker</text>
      <!-- Cables panel→switch: black (hot) and white (neutral) -->
      <line x1="110" y1="115" x2="290" y2="115" stroke="#1f2937" stroke-width="5"/>
      <line x1="110" y1="115" x2="290" y2="115" stroke="#111827" stroke-width="3"/>
      <line x1="110" y1="125" x2="290" y2="125" stroke="#e5e7eb" stroke-width="3"/>
      <text x="200" y="108" text-anchor="middle" fill="#64748b" font-size="9">14/2 NMD90</text>
      <text x="148" y="141" fill="#64748b" font-size="8">⚫ Black (hot)</text>
      <text x="148" y="152" fill="#9ca3af" font-size="8">⚪ White (neutral)</text>
      <!-- Switch box -->
      <rect x="290" y="80" width="100" height="100" rx="8" fill="#1e293b" stroke="#475569" stroke-width="2"/>
      <text x="340" y="108" text-anchor="middle" fill="#94a3b8" font-size="10" font-weight="700">SWITCH</text>
      <text x="340" y="122" text-anchor="middle" fill="#94a3b8" font-size="10" font-weight="700">BOX</text>
      <!-- switch symbol inside box -->
      <circle cx="318" cy="148" r="5" fill="none" stroke="#3b82f6" stroke-width="1.5"/>
      <line x1="323" y1="145" x2="340" y2="138" stroke="#3b82f6" stroke-width="1.5"/>
      <circle cx="345" cy="138" r="4" fill="none" stroke="#3b82f6" stroke-width="1.5"/>
      <!-- Wire nut for neutral -->
      <circle cx="360" cy="156" r="7" fill="#f59e0b" stroke="#d97706" stroke-width="1"/>
      <text x="360" y="159" text-anchor="middle" fill="#000" font-size="7" font-weight="900">WN</text>
      <!-- Re-identification note -->
      <rect x="280" y="190" width="130" height="24" rx="4" fill="rgba(239,68,68,0.1)" stroke="#ef4444" stroke-width="1"/>
      <text x="345" y="204" text-anchor="middle" fill="#ef4444" font-size="8">White → re-ID black tape</text>
      <!-- Cables switch→light: black switched and white -->
      <line x1="390" y1="115" x2="560" y2="115" stroke="#1f2937" stroke-width="5"/>
      <line x1="390" y1="115" x2="560" y2="115" stroke="#111827" stroke-width="3"/>
      <line x1="390" y1="125" x2="560" y2="125" stroke="#e5e7eb" stroke-width="3"/>
      <text x="475" y="108" text-anchor="middle" fill="#64748b" font-size="9">14/2 NMD90</text>
      <!-- Light box -->
      <rect x="560" y="80" width="100" height="100" rx="8" fill="#1e293b" stroke="#475569" stroke-width="2"/>
      <text x="610" y="117" text-anchor="middle" fill="#94a3b8" font-size="10" font-weight="700">LIGHT</text>
      <text x="610" y="131" text-anchor="middle" fill="#94a3b8" font-size="10" font-weight="700">FIXTURE</text>
      <!-- Lamp symbol -->
      <circle cx="610" cy="155" r="11" fill="none" stroke="#f59e0b" stroke-width="1.5"/>
      <line x1="603" y1="148" x2="617" y2="162" stroke="#f59e0b" stroke-width="1.5"/>
      <line x1="617" y1="148" x2="603" y2="162" stroke="#f59e0b" stroke-width="1.5"/>
      <!-- Legend -->
      <text x="20" y="245" fill="#94a3b8" font-size="9" font-weight="700">LEGEND:</text>
      <line x1="80" y1="243" x2="110" y2="243" stroke="#111827" stroke-width="3"/>
      <text x="115" y="246" fill="#64748b" font-size="9">Black = Hot (ungrounded)</text>
      <line x1="290" y1="243" x2="320" y2="243" stroke="#e5e7eb" stroke-width="3"/>
      <text x="325" y="246" fill="#64748b" font-size="9">White = Neutral</text>
      <line x1="460" y1="243" x2="490" y2="243" stroke="#22c55e" stroke-width="3"/>
      <text x="495" y="246" fill="#64748b" font-size="9">Green = EGC</text>
    </svg>`;

    if (s === 1) return `
    <svg viewBox="0 0 820 280" style="width:100%;max-width:820px;display:block;margin:0 auto;" font-family="Inter,sans-serif">
      <!-- Panel -->
      <rect x="10" y="90" width="80" height="80" rx="8" fill="#1e293b" stroke="#475569" stroke-width="2"/>
      <text x="50" y="128" text-anchor="middle" fill="#94a3b8" font-size="10" font-weight="700">PANEL</text>
      <!-- 14/2 to SW1 -->
      <line x1="90" y1="118" x2="180" y2="118" stroke="#111827" stroke-width="4"/>
      <line x1="90" y1="126" x2="180" y2="126" stroke="#e5e7eb" stroke-width="3"/>
      <text x="135" y="112" text-anchor="middle" fill="#64748b" font-size="8">14/2</text>
      <!-- SW1 box -->
      <rect x="180" y="80" width="110" height="100" rx="8" fill="#1e293b" stroke="#22c55e" stroke-width="2"/>
      <text x="235" y="108" text-anchor="middle" fill="#22c55e" font-size="10" font-weight="700">3-WAY SW1</text>
      <!-- 3-way switch symbol -->
      <circle cx="210" cy="148" r="5" fill="none" stroke="#22c55e" stroke-width="1.5"/>
      <line x1="215" y1="146" x2="240" y2="140" stroke="#22c55e" stroke-width="1.5"/>
      <line x1="215" y1="150" x2="240" y2="156" stroke="#22c55e" stroke-width="1.5"/>
      <circle cx="244" cy="140" r="4" fill="none" stroke="#22c55e" stroke-width="1.5"/>
      <circle cx="244" cy="156" r="4" fill="none" stroke="#22c55e" stroke-width="1.5"/>
      <!-- 14/3 cable SW1→SW2 — 3 conductors -->
      <text x="360" y="100" text-anchor="middle" fill="#ec4899" font-size="9" font-weight="700">14/3 NMD90 (3 conductors!)</text>
      <line x1="290" y1="112" x2="450" y2="112" stroke="#111827" stroke-width="4"/>
      <line x1="290" y1="120" x2="450" y2="120" stroke="#dc2626" stroke-width="3"/>
      <line x1="290" y1="128" x2="450" y2="128" stroke="#e5e7eb" stroke-width="3"/>
      <text x="360" y="145" text-anchor="middle" fill="#64748b" font-size="8">⚫ Black = traveler A</text>
      <text x="360" y="156" text-anchor="middle" fill="#64748b" font-size="8">🔴 Red = traveler B</text>
      <text x="360" y="167" text-anchor="middle" fill="#94a3b8" font-size="8">⚪ White = neutral</text>
      <!-- SW2 box -->
      <rect x="450" y="80" width="110" height="100" rx="8" fill="#1e293b" stroke="#22c55e" stroke-width="2"/>
      <text x="505" y="108" text-anchor="middle" fill="#22c55e" font-size="10" font-weight="700">3-WAY SW2</text>
      <circle cx="480" cy="148" r="5" fill="none" stroke="#22c55e" stroke-width="1.5"/>
      <line x1="485" y1="146" x2="510" y2="140" stroke="#22c55e" stroke-width="1.5"/>
      <line x1="485" y1="150" x2="510" y2="156" stroke="#22c55e" stroke-width="1.5"/>
      <circle cx="514" cy="140" r="4" fill="none" stroke="#22c55e" stroke-width="1.5"/>
      <circle cx="514" cy="156" r="4" fill="none" stroke="#22c55e" stroke-width="1.5"/>
      <!-- 14/2 SW2→Light -->
      <line x1="560" y1="118" x2="650" y2="118" stroke="#111827" stroke-width="4"/>
      <line x1="560" y1="126" x2="650" y2="126" stroke="#e5e7eb" stroke-width="3"/>
      <text x="605" y="112" text-anchor="middle" fill="#64748b" font-size="8">14/2</text>
      <!-- Light -->
      <rect x="650" y="90" width="90" height="80" rx="8" fill="#1e293b" stroke="#f59e0b" stroke-width="2"/>
      <text x="695" y="118" text-anchor="middle" fill="#f59e0b" font-size="10" font-weight="700">LIGHT</text>
      <circle cx="695" cy="148" r="12" fill="none" stroke="#f59e0b" stroke-width="2"/>
      <line x1="688" y1="141" x2="702" y2="155" stroke="#f59e0b" stroke-width="1.5"/>
      <line x1="702" y1="141" x2="688" y2="155" stroke="#f59e0b" stroke-width="1.5"/>
      <!-- Callout -->
      <rect x="10" y="220" width="800" height="40" rx="6" fill="rgba(236,72,153,0.08)" stroke="#ec4899" stroke-width="1"/>
      <text x="410" y="237" text-anchor="middle" fill="#ec4899" font-size="9" font-weight="700">KEY POINT: The 14/3 cable between switches carries 3 conductors. Count slashes on a blueprint: /// = 3 conductors = 14/3 cable needed here.</text>
      <text x="410" y="252" text-anchor="middle" fill="#64748b" font-size="9">Black &amp; Red are travelers (connect same-coloured terminals). White passes neutral through. Total cable runs: 14/2 + 14/3 + 14/2</text>
    </svg>`;

    if (s === 2) return `
    <svg viewBox="0 0 820 280" style="width:100%;max-width:820px;display:block;margin:0 auto;" font-family="Inter,sans-serif">
      <!-- Control source -->
      <rect x="10" y="40" width="80" height="50" rx="8" fill="#1e293b" stroke="#3b82f6" stroke-width="1.5"/>
      <text x="50" y="63" text-anchor="middle" fill="#3b82f6" font-size="9" font-weight="700">CONTROL</text>
      <text x="50" y="76" text-anchor="middle" fill="#64748b" font-size="8">120V</text>
      <!-- control hot wire -->
      <line x1="90" y1="55" x2="170" y2="55" stroke="#111827" stroke-width="3"/>
      <!-- PB -->
      <rect x="170" y="30" width="90" height="70" rx="8" fill="#1e293b" stroke="#3b82f6" stroke-width="1.5"/>
      <text x="215" y="53" text-anchor="middle" fill="#3b82f6" font-size="9" font-weight="700">PUSH</text>
      <text x="215" y="66" text-anchor="middle" fill="#3b82f6" font-size="9" font-weight="700">BUTTON</text>
      <!-- NO symbol -->
      <line x1="195" y1="80" x2="205" y2="80" stroke="#3b82f6" stroke-width="1.5"/>
      <line x1="225" y1="80" x2="235" y2="80" stroke="#3b82f6" stroke-width="1.5"/>
      <line x1="205" y1="76" x2="225" y2="76" stroke="#3b82f6" stroke-width="1.5"/>
      <!-- wire to relay -->
      <line x1="260" y1="55" x2="340" y2="55" stroke="#111827" stroke-width="3"/>
      <!-- Relay enclosure -->
      <rect x="340" y="20" width="120" height="130" rx="8" fill="#0f172a" stroke="#3b82f6" stroke-width="2"/>
      <text x="400" y="45" text-anchor="middle" fill="#3b82f6" font-size="9" font-weight="700">RELAY</text>
      <!-- Coil symbol -->
      <rect x="365" y="50" width="70" height="30" rx="4" fill="rgba(59,130,246,0.1)" stroke="#3b82f6" stroke-width="1.5"/>
      <text x="400" y="68" text-anchor="middle" fill="#3b82f6" font-size="9">COIL (M)</text>
      <!-- NO contact symbol -->
      <line x1="365" y1="110" x2="380" y2="110" stroke="#22c55e" stroke-width="2"/>
      <line x1="420" y1="110" x2="435" y2="110" stroke="#22c55e" stroke-width="2"/>
      <line x1="380" y1="104" x2="420" y2="104" stroke="#22c55e" stroke-width="2"/>
      <text x="400" y="135" text-anchor="middle" fill="#22c55e" font-size="8">M Contact (NO)</text>
      <!-- Dotted actuator line coil→contact -->
      <line x1="400" y1="80" x2="400" y2="100" stroke="#64748b" stroke-width="1" stroke-dasharray="3,2"/>
      <!-- wire from contact to load -->
      <line x1="460" y1="110" x2="560" y2="110" stroke="#111827" stroke-width="3"/>
      <!-- control return from coil -->
      <line x1="400" y1="80" x2="400" y2="170" stroke="#e5e7eb" stroke-width="2"/>
      <line x1="400" y1="170" x2="50" y2="170" stroke="#e5e7eb" stroke-width="2"/>
      <line x1="50" y1="170" x2="50" y2="90" stroke="#e5e7eb" stroke-width="2"/>
      <!-- Load -->
      <rect x="560" y="80" width="90" height="60" rx="8" fill="#1e293b" stroke="#22c55e" stroke-width="1.5"/>
      <text x="605" y="107" text-anchor="middle" fill="#22c55e" font-size="10" font-weight="700">LOAD</text>
      <text x="605" y="120" text-anchor="middle" fill="#64748b" font-size="8">Motor/Light</text>
      <!-- Line source -->
      <line x1="560" y1="110" x2="560" y2="40"/>
      <rect x="500" y="20" width="60" height="36" rx="6" fill="#1e293b" stroke="#22c55e" stroke-width="1.5"/>
      <text x="530" y="35" text-anchor="middle" fill="#22c55e" font-size="8" font-weight="700">LINE</text>
      <text x="530" y="48" text-anchor="middle" fill="#64748b" font-size="7">Source</text>
      <line x1="560" y1="56" x2="560" y2="80" stroke="#111827" stroke-width="3"/>
      <!-- Note -->
      <rect x="10" y="220" width="800" height="40" rx="6" fill="rgba(59,130,246,0.08)" stroke="#3b82f6" stroke-width="1"/>
      <text x="410" y="237" text-anchor="middle" fill="#3b82f6" font-size="9" font-weight="700">TWO SEPARATE CIRCUITS share one enclosure. Control circuit (low energy) energizes the coil — coil actuates contact — contact carries full load current.</text>
      <text x="410" y="252" text-anchor="middle" fill="#64748b" font-size="9">This separation is why relay control is safe: you push a 120V button to switch 600V equipment without exposing the operator to high voltage.</text>
    </svg>`;

    // s === 3
    return `
    <svg viewBox="0 0 820 290" style="width:100%;max-width:820px;display:block;margin:0 auto;" font-family="Inter,sans-serif">
      <!-- Push button station -->
      <rect x="10" y="60" width="130" height="130" rx="8" fill="#0f172a" stroke="#8b5cf6" stroke-width="2"/>
      <text x="75" y="83" text-anchor="middle" fill="#8b5cf6" font-size="9" font-weight="700">PUSH BUTTON</text>
      <text x="75" y="96" text-anchor="middle" fill="#8b5cf6" font-size="9" font-weight="700">STATION</text>
      <!-- Stop PB symbol (NC = bar with button) -->
      <line x1="35" y1="118" x2="50" y2="118" stroke="#ef4444" stroke-width="2"/>
      <line x1="50" y1="112" x2="70" y2="112" stroke="#ef4444" stroke-width="2"/>
      <line x1="70" y1="118" x2="85" y2="118" stroke="#ef4444" stroke-width="2"/>
      <line x1="60" y1="108" x2="60" y2="112" stroke="#ef4444" stroke-width="1.5"/>
      <text x="60" y="133" text-anchor="middle" fill="#ef4444" font-size="8">STOP (NC)</text>
      <!-- Start PB symbol (NO) -->
      <line x1="85" y1="165" x2="95" y2="165" stroke="#22c55e" stroke-width="2"/>
      <line x1="115" y1="165" x2="125" y2="165" stroke="#22c55e" stroke-width="2"/>
      <line x1="95" y1="159" x2="115" y2="159" stroke="#22c55e" stroke-width="2"/>
      <text x="105" y="178" text-anchor="middle" fill="#22c55e" font-size="8">START (NO)</text>
      <!-- 3 wires to starter: wire labels -->
      <text x="170" y="90" fill="#64748b" font-size="8">3 control wires</text>
      <line x1="140" y1="100" x2="300" y2="100" stroke="#111827" stroke-width="3"/>
      <line x1="140" y1="120" x2="300" y2="120" stroke="#111827" stroke-width="2" stroke-dasharray="4,2" opacity="0.5"/>
      <line x1="140" y1="140" x2="300" y2="140" stroke="#e5e7eb" stroke-width="2"/>
      <!-- Starter enclosure -->
      <rect x="300" y="50" width="200" height="200" rx="8" fill="#0f172a" stroke="#8b5cf6" stroke-width="2"/>
      <text x="400" y="75" text-anchor="middle" fill="#8b5cf6" font-size="10" font-weight="700">MOTOR STARTER</text>
      <!-- M coil -->
      <rect x="330" y="85" width="80" height="28" rx="4" fill="rgba(139,92,246,0.1)" stroke="#8b5cf6" stroke-width="1.5"/>
      <text x="370" y="103" text-anchor="middle" fill="#8b5cf6" font-size="8">M COIL</text>
      <!-- OL heaters -->
      <rect x="430" y="85" width="55" height="28" rx="4" fill="rgba(239,68,68,0.1)" stroke="#ef4444" stroke-width="1.5"/>
      <text x="457" y="103" text-anchor="middle" fill="#ef4444" font-size="7" font-weight="700">OL (3×)</text>
      <!-- M auxiliary contact -->
      <line x1="330" y1="140" x2="345" y2="140" stroke="#22c55e" stroke-width="2"/>
      <line x1="345" y1="134" x2="375" y2="134" stroke="#22c55e" stroke-width="2"/>
      <line x1="375" y1="140" x2="390" y2="140" stroke="#22c55e" stroke-width="2"/>
      <text x="360" y="152" text-anchor="middle" fill="#22c55e" font-size="7">M aux (seal-in)</text>
      <!-- M main contacts 3-phase -->
      <text x="380" y="180" text-anchor="middle" fill="#94a3b8" font-size="8">Main Contacts</text>
      <text x="380" y="194" text-anchor="middle" fill="#94a3b8" font-size="7">T1 / T2 / T3</text>
      <line x1="340" y1="200" x2="340" y2="220" stroke="#f59e0b" stroke-width="2"/>
      <line x1="370" y1="200" x2="370" y2="220" stroke="#dc2626" stroke-width="2"/>
      <line x1="400" y1="200" x2="400" y2="220" stroke="#1d4ed8" stroke-width="2"/>
      <!-- Motor -->
      <rect x="540" y="140" width="100" height="80" rx="8" fill="#1e293b" stroke="#22c55e" stroke-width="2"/>
      <text x="590" y="175" text-anchor="middle" fill="#22c55e" font-size="10" font-weight="700">MOTOR</text>
      <text x="590" y="192" text-anchor="middle" fill="#64748b" font-size="8">3-Phase</text>
      <!-- 3-phase lines to motor -->
      <line x1="500" y1="170" x2="540" y2="170" stroke="#f59e0b" stroke-width="2"/>
      <line x1="500" y1="180" x2="540" y2="180" stroke="#dc2626" stroke-width="2"/>
      <line x1="500" y1="190" x2="540" y2="190" stroke="#1d4ed8" stroke-width="2"/>
      <!-- L1/L2/L3 lines from top -->
      <rect x="640" y="40" width="80" height="50" rx="6" fill="#1e293b" stroke="#22c55e" stroke-width="1.5"/>
      <text x="680" y="63" text-anchor="middle" fill="#22c55e" font-size="9" font-weight="700">L1/L2/L3</text>
      <text x="680" y="78" text-anchor="middle" fill="#64748b" font-size="8">Supply</text>
      <line x1="660" y1="90" x2="480" y2="90" stroke="#f59e0b" stroke-width="2"/>
      <line x1="670" y1="90" x2="490" y2="90" stroke="#dc2626" stroke-width="2"/>
      <line x1="680" y1="90" x2="500" y2="90" stroke="#1d4ed8" stroke-width="2"/>
      <!-- Note -->
      <rect x="10" y="245" width="800" height="35" rx="6" fill="rgba(139,92,246,0.08)" stroke="#8b5cf6" stroke-width="1"/>
      <text x="410" y="261" text-anchor="middle" fill="#8b5cf6" font-size="9" font-weight="700">Why "3-wire" control? Three wires run to the push button station: L1 control hot, junction between Stop &amp; Start, and coil return. This allows the seal-in contact to hold the circuit without extra wiring.</text>
      <text x="410" y="274" text-anchor="middle" fill="#64748b" font-size="9">Power circuit: 3 lines in → 3 main contacts → 3 OL heaters → 3 motor terminals (T1/T2/T3)</text>
    </svg>`;
  },

  // === SCHEMATIC (LADDER) SVGs ===
  _diagSVGSchematic(s) {
    if (s === 0) return `
    <svg viewBox="0 0 600 180" style="width:100%;max-width:600px;display:block;margin:0 auto;" font-family="Inter,sans-serif">
      <!-- Rails -->
      <line x1="60" y1="30" x2="60" y2="160" stroke="#ef4444" stroke-width="3"/>
      <text x="60" y="20" text-anchor="middle" fill="#ef4444" font-size="11" font-weight="700">L1</text>
      <text x="60" y="172" text-anchor="middle" fill="#ef4444" font-size="9">(Hot)</text>
      <line x1="530" y1="30" x2="530" y2="160" stroke="#e5e7eb" stroke-width="3"/>
      <text x="530" y="20" text-anchor="middle" fill="#94a3b8" font-size="11" font-weight="700">N</text>
      <text x="530" y="172" text-anchor="middle" fill="#94a3b8" font-size="9">(Neutral)</text>
      <!-- Rung 1 -->
      <line x1="60" y1="90" x2="170" y2="90" stroke="#94a3b8" stroke-width="2"/>
      <!-- Switch contact symbol (NO) -->
      <line x1="170" y1="90" x2="190" y2="90" stroke="#3b82f6" stroke-width="2"/>
      <line x1="190" y1="82" x2="240" y2="82" stroke="#3b82f6" stroke-width="2.5"/>
      <line x1="240" y1="90" x2="260" y2="90" stroke="#3b82f6" stroke-width="2"/>
      <text x="215" y="108" text-anchor="middle" fill="#3b82f6" font-size="10" font-weight="700">SW1</text>
      <text x="215" y="120" text-anchor="middle" fill="#64748b" font-size="8">Single-pole switch</text>
      <!-- Wire after switch -->
      <line x1="260" y1="90" x2="370" y2="90" stroke="#94a3b8" stroke-width="2"/>
      <!-- Lamp symbol -->
      <circle cx="400" cy="90" r="22" fill="none" stroke="#f59e0b" stroke-width="2.5"/>
      <line x1="385" y1="75" x2="415" y2="105" stroke="#f59e0b" stroke-width="2"/>
      <line x1="415" y1="75" x2="385" y2="105" stroke="#f59e0b" stroke-width="2"/>
      <text x="400" y="128" text-anchor="middle" fill="#f59e0b" font-size="10" font-weight="700">LAMP</text>
      <!-- Wire to neutral -->
      <line x1="422" y1="90" x2="530" y2="90" stroke="#94a3b8" stroke-width="2"/>
      <!-- Annotation -->
      <text x="300" y="160" text-anchor="middle" fill="#64748b" font-size="9">Switch interrupts the HOT (L1) conductor only — Neutral is continuous</text>
    </svg>`;

    if (s === 1) return `
    <svg viewBox="0 0 680 200" style="width:100%;max-width:680px;display:block;margin:0 auto;" font-family="Inter,sans-serif">
      <!-- Rails -->
      <line x1="50" y1="20" x2="50" y2="190" stroke="#ef4444" stroke-width="3"/>
      <text x="50" y="14" text-anchor="middle" fill="#ef4444" font-size="11" font-weight="700">L1</text>
      <line x1="620" y1="20" x2="620" y2="190" stroke="#e5e7eb" stroke-width="3"/>
      <text x="620" y="14" text-anchor="middle" fill="#94a3b8" font-size="11" font-weight="700">N</text>
      <!-- SW1 common -->
      <line x1="50" y1="80" x2="120" y2="80" stroke="#94a3b8" stroke-width="2"/>
      <!-- SW1 symbol — pivot point -->
      <circle cx="120" cy="80" r="4" fill="#22c55e"/>
      <text x="120" y="68" text-anchor="middle" fill="#22c55e" font-size="8" font-weight="700">SW1 common</text>
      <!-- Traveler A (top path) -->
      <line x1="120" y1="80" x2="140" y2="55" stroke="#22c55e" stroke-width="1.5" stroke-dasharray="5,3"/>
      <line x1="140" y1="55" x2="430" y2="55" stroke="#111827" stroke-width="2.5"/>
      <text x="285" y="46" text-anchor="middle" fill="#64748b" font-size="9">Traveler A (Black)</text>
      <line x1="430" y1="55" x2="450" y2="80" stroke="#22c55e" stroke-width="1.5" stroke-dasharray="5,3"/>
      <!-- Traveler B (bottom path) -->
      <line x1="120" y1="80" x2="140" y2="108" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3" opacity="0.5"/>
      <line x1="140" y1="108" x2="430" y2="108" stroke="#dc2626" stroke-width="2.5"/>
      <text x="285" y="122" text-anchor="middle" fill="#64748b" font-size="9">Traveler B (Red)</text>
      <line x1="430" y1="108" x2="450" y2="80" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3" opacity="0.5"/>
      <!-- SW2 common -->
      <circle cx="450" cy="80" r="4" fill="#22c55e"/>
      <text x="450" y="68" text-anchor="middle" fill="#22c55e" font-size="8" font-weight="700">SW2 common</text>
      <!-- Wire to lamp -->
      <line x1="450" y1="80" x2="530" y2="80" stroke="#94a3b8" stroke-width="2"/>
      <!-- Lamp -->
      <circle cx="560" cy="80" r="20" fill="none" stroke="#f59e0b" stroke-width="2.5"/>
      <line x1="546" y1="66" x2="574" y2="94" stroke="#f59e0b" stroke-width="2"/>
      <line x1="574" y1="66" x2="546" y2="94" stroke="#f59e0b" stroke-width="2"/>
      <line x1="580" y1="80" x2="620" y2="80" stroke="#94a3b8" stroke-width="2"/>
      <text x="560" y="115" text-anchor="middle" fill="#f59e0b" font-size="9" font-weight="700">LAMP</text>
      <!-- Key -->
      <rect x="50" y="155" width="570" height="30" rx="6" fill="rgba(34,197,94,0.08)" stroke="#22c55e" stroke-width="1"/>
      <text x="335" y="170" text-anchor="middle" fill="#22c55e" font-size="8" font-weight="700">Solid line = active traveler path (SW1 up = Traveler A active). Flip SW2 = same traveler, different direction = OPEN circuit.</text>
      <text x="335" y="182" text-anchor="middle" fill="#64748b" font-size="8">Flip either switch = change active traveler = toggle light state.</text>
    </svg>`;

    if (s === 2) return `
    <svg viewBox="0 0 680 220" style="width:100%;max-width:680px;display:block;margin:0 auto;" font-family="Inter,sans-serif">
      <!-- Rails -->
      <line x1="50" y1="20" x2="50" y2="210" stroke="#ef4444" stroke-width="3"/>
      <text x="50" y="14" text-anchor="middle" fill="#ef4444" font-size="11" font-weight="700">L1</text>
      <line x1="600" y1="20" x2="600" y2="210" stroke="#e5e7eb" stroke-width="3"/>
      <text x="600" y="14" text-anchor="middle" fill="#94a3b8" font-size="11" font-weight="700">N</text>
      <!-- CONTROL RUNG (top) -->
      <text x="50" y="55" fill="#64748b" font-size="8">Rung 1 — Control</text>
      <line x1="50" y1="70" x2="140" y2="70" stroke="#94a3b8" stroke-width="2"/>
      <!-- PB NO contact -->
      <line x1="140" y1="70" x2="155" y2="70" stroke="#3b82f6" stroke-width="2"/>
      <line x1="155" y1="62" x2="200" y2="62" stroke="#3b82f6" stroke-width="2.5"/>
      <line x1="200" y1="70" x2="215" y2="70" stroke="#3b82f6" stroke-width="2"/>
      <text x="177" y="84" text-anchor="middle" fill="#3b82f6" font-size="9" font-weight="700">START</text>
      <text x="177" y="95" text-anchor="middle" fill="#64748b" font-size="8">(NO)</text>
      <!-- M coil -->
      <line x1="215" y1="70" x2="480" y2="70" stroke="#94a3b8" stroke-width="2"/>
      <rect x="480" y="55" width="60" height="30" rx="6" fill="rgba(139,92,246,0.12)" stroke="#8b5cf6" stroke-width="2"/>
      <text x="510" y="73" text-anchor="middle" fill="#8b5cf6" font-size="10" font-weight="700">M</text>
      <line x1="540" y1="70" x2="600" y2="70" stroke="#94a3b8" stroke-width="2"/>
      <!-- POWER RUNG (bottom) -->
      <text x="50" y="135" fill="#64748b" font-size="8">Rung 2 — Power circuit</text>
      <line x1="50" y1="148" x2="160" y2="148" stroke="#94a3b8" stroke-width="2"/>
      <!-- M NO contact in power rung -->
      <line x1="160" y1="148" x2="175" y2="148" stroke="#22c55e" stroke-width="2"/>
      <line x1="175" y1="140" x2="220" y2="140" stroke="#22c55e" stroke-width="2.5"/>
      <line x1="220" y1="148" x2="235" y2="148" stroke="#22c55e" stroke-width="2"/>
      <text x="197" y="162" text-anchor="middle" fill="#22c55e" font-size="9" font-weight="700">M</text>
      <text x="197" y="173" text-anchor="middle" fill="#64748b" font-size="8">(NO)</text>
      <!-- Load -->
      <line x1="235" y1="148" x2="420" y2="148" stroke="#94a3b8" stroke-width="2"/>
      <circle cx="455" cy="148" r="22" fill="none" stroke="#f59e0b" stroke-width="2.5"/>
      <line x1="440" y1="133" x2="470" y2="163" stroke="#f59e0b" stroke-width="2"/>
      <line x1="470" y1="133" x2="440" y2="163" stroke="#f59e0b" stroke-width="2"/>
      <text x="455" y="186" text-anchor="middle" fill="#f59e0b" font-size="9" font-weight="700">LOAD</text>
      <line x1="477" y1="148" x2="600" y2="148" stroke="#94a3b8" stroke-width="2"/>
      <!-- Actuator arrow from coil to contact -->
      <line x1="510" y1="85" x2="510" y2="120" stroke="#8b5cf6" stroke-width="1.5" stroke-dasharray="4,2"/>
      <line x1="510" y1="120" x2="197" y2="120" stroke="#8b5cf6" stroke-width="1.5" stroke-dasharray="4,2"/>
      <line x1="197" y1="120" x2="197" y2="130" stroke="#8b5cf6" stroke-width="1.5" stroke-dasharray="4,2"/>
      <text x="360" y="116" text-anchor="middle" fill="#8b5cf6" font-size="8">coil energized → closes M contact</text>
    </svg>`;

    // s === 3 Motor Starter
    return `
    <svg viewBox="0 0 720 280" style="width:100%;max-width:720px;display:block;margin:0 auto;" font-family="Inter,sans-serif">
      <!-- Rails -->
      <line x1="40" y1="15" x2="40" y2="270" stroke="#ef4444" stroke-width="3"/>
      <text x="40" y="10" text-anchor="middle" fill="#ef4444" font-size="10" font-weight="700">L1</text>
      <line x1="660" y1="15" x2="660" y2="200" stroke="#e5e7eb" stroke-width="3"/>
      <text x="660" y="10" text-anchor="middle" fill="#94a3b8" font-size="10" font-weight="700">N/L2</text>
      <!-- CONTROL RUNG -->
      <text x="45" y="40" fill="#64748b" font-size="8">Control Rung</text>
      <!-- OL NC contact -->
      <line x1="40" y1="55" x2="90" y2="55" stroke="#94a3b8" stroke-width="2"/>
      <line x1="90" y1="55" x2="103" y2="55" stroke="#ef4444" stroke-width="2"/>
      <line x1="103" y1="49" x2="133" y2="49" stroke="#ef4444" stroke-width="2.5"/>
      <line x1="103" y1="55" x2="116" y2="55" stroke="#ef4444" stroke-width="2"/>
      <line x1="110" y1="43" x2="110" y2="49" stroke="#ef4444" stroke-width="1.5"/>
      <text x="112" y="70" text-anchor="middle" fill="#ef4444" font-size="8" font-weight="700">OL</text>
      <text x="112" y="80" text-anchor="middle" fill="#64748b" font-size="7">(NC)</text>
      <!-- Stop NC contact -->
      <line x1="133" y1="55" x2="175" y2="55" stroke="#94a3b8" stroke-width="2"/>
      <line x1="175" y1="55" x2="188" y2="55" stroke="#ef4444" stroke-width="2"/>
      <line x1="188" y1="49" x2="218" y2="49" stroke="#ef4444" stroke-width="2.5"/>
      <line x1="218" y1="55" x2="231" y2="55" stroke="#ef4444" stroke-width="2"/>
      <line x1="203" y1="43" x2="203" y2="49" stroke="#ef4444" stroke-width="1.5"/>
      <text x="203" y="70" text-anchor="middle" fill="#ef4444" font-size="8" font-weight="700">STOP</text>
      <text x="203" y="80" text-anchor="middle" fill="#64748b" font-size="7">(NC)</text>
      <!-- Junction point after Stop -->
      <circle cx="231" cy="55" r="4" fill="#94a3b8"/>
      <!-- Start NO contact (top path) -->
      <line x1="231" y1="55" x2="250" y2="55" stroke="#94a3b8" stroke-width="2"/>
      <line x1="250" y1="55" x2="263" y2="55" stroke="#22c55e" stroke-width="2"/>
      <line x1="263" y1="47" x2="313" y2="47" stroke="#22c55e" stroke-width="2.5"/>
      <line x1="313" y1="55" x2="326" y2="55" stroke="#22c55e" stroke-width="2"/>
      <text x="290" y="38" text-anchor="middle" fill="#22c55e" font-size="8" font-weight="700">START</text>
      <!-- M seal-in NO contact (bottom path, parallel) -->
      <line x1="231" y1="55" x2="231" y2="85" stroke="#94a3b8" stroke-width="1.5"/>
      <line x1="231" y1="85" x2="250" y2="85" stroke="#94a3b8" stroke-width="1.5"/>
      <line x1="250" y1="85" x2="263" y2="85" stroke="#8b5cf6" stroke-width="2"/>
      <line x1="263" y1="79" x2="313" y2="79" stroke="#8b5cf6" stroke-width="2.5"/>
      <line x1="313" y1="85" x2="326" y2="85" stroke="#8b5cf6" stroke-width="2"/>
      <text x="290" y="100" text-anchor="middle" fill="#8b5cf6" font-size="8" font-weight="700">M (seal-in)</text>
      <line x1="326" y1="85" x2="326" y2="55" stroke="#94a3b8" stroke-width="1.5"/>
      <!-- Junction after parallel -->
      <circle cx="326" cy="55" r="4" fill="#94a3b8"/>
      <!-- M coil -->
      <line x1="326" y1="55" x2="550" y2="55" stroke="#94a3b8" stroke-width="2"/>
      <rect x="550" y="42" width="60" height="26" rx="6" fill="rgba(139,92,246,0.12)" stroke="#8b5cf6" stroke-width="2"/>
      <text x="580" y="59" text-anchor="middle" fill="#8b5cf6" font-size="10" font-weight="700">M</text>
      <line x1="610" y1="55" x2="660" y2="55" stroke="#94a3b8" stroke-width="2"/>
      <!-- POWER CIRCUIT label -->
      <text x="45" y="140" fill="#64748b" font-size="8">Power Circuit (3-Phase)</text>
      <!-- 3-phase power rungs -->
      <!-- L1 -->
      <line x1="40" y1="155" x2="200" y2="155" stroke="#f59e0b" stroke-width="2.5"/>
      <text x="120" y="148" text-anchor="middle" fill="#f59e0b" font-size="8">L1</text>
      <!-- L1 M contact -->
      <line x1="200" y1="155" x2="215" y2="155" stroke="#f59e0b" stroke-width="2.5"/>
      <line x1="215" y1="149" x2="250" y2="149" stroke="#f59e0b" stroke-width="2.5"/>
      <line x1="250" y1="155" x2="265" y2="155" stroke="#f59e0b" stroke-width="2.5"/>
      <!-- OL heater -->
      <rect x="265" y="148" width="30" height="14" rx="3" fill="rgba(239,68,68,0.1)" stroke="#ef4444" stroke-width="1.5"/>
      <text x="280" y="158" text-anchor="middle" fill="#ef4444" font-size="6">OL1</text>
      <line x1="295" y1="155" x2="400" y2="155" stroke="#f59e0b" stroke-width="2.5"/>
      <text x="350" y="148" text-anchor="middle" fill="#f59e0b" font-size="7">T1</text>
      <!-- L2 -->
      <line x1="40" y1="180" x2="200" y2="180" stroke="#dc2626" stroke-width="2.5"/>
      <text x="120" y="173" text-anchor="middle" fill="#dc2626" font-size="8">L2</text>
      <line x1="200" y1="180" x2="215" y2="180" stroke="#dc2626" stroke-width="2.5"/>
      <line x1="215" y1="174" x2="250" y2="174" stroke="#dc2626" stroke-width="2.5"/>
      <line x1="250" y1="180" x2="265" y2="180" stroke="#dc2626" stroke-width="2.5"/>
      <rect x="265" y="173" width="30" height="14" rx="3" fill="rgba(239,68,68,0.1)" stroke="#ef4444" stroke-width="1.5"/>
      <text x="280" y="183" text-anchor="middle" fill="#ef4444" font-size="6">OL2</text>
      <line x1="295" y1="180" x2="400" y2="180" stroke="#dc2626" stroke-width="2.5"/>
      <text x="350" y="173" text-anchor="middle" fill="#dc2626" font-size="7">T2</text>
      <!-- L3 -->
      <line x1="40" y1="205" x2="200" y2="205" stroke="#1d4ed8" stroke-width="2.5"/>
      <text x="120" y="198" text-anchor="middle" fill="#1d4ed8" font-size="8">L3</text>
      <line x1="200" y1="205" x2="215" y2="205" stroke="#1d4ed8" stroke-width="2.5"/>
      <line x1="215" y1="199" x2="250" y2="199" stroke="#1d4ed8" stroke-width="2.5"/>
      <line x1="250" y1="205" x2="265" y2="205" stroke="#1d4ed8" stroke-width="2.5"/>
      <rect x="265" y="198" width="30" height="14" rx="3" fill="rgba(239,68,68,0.1)" stroke="#ef4444" stroke-width="1.5"/>
      <text x="280" y="208" text-anchor="middle" fill="#ef4444" font-size="6">OL3</text>
      <line x1="295" y1="205" x2="400" y2="205" stroke="#1d4ed8" stroke-width="2.5"/>
      <text x="350" y="198" text-anchor="middle" fill="#1d4ed8" font-size="7">T3</text>
      <!-- Motor symbol -->
      <circle cx="440" cy="180" r="32" fill="rgba(34,197,94,0.06)" stroke="#22c55e" stroke-width="2.5"/>
      <text x="440" y="176" text-anchor="middle" fill="#22c55e" font-size="10" font-weight="900">M</text>
      <text x="440" y="190" text-anchor="middle" fill="#64748b" font-size="8">3Ø</text>
      <line x1="400" y1="155" x2="408" y2="155" stroke="#f59e0b" stroke-width="2.5"/>
      <line x1="400" y1="180" x2="408" y2="180" stroke="#dc2626" stroke-width="2.5"/>
      <line x1="400" y1="205" x2="408" y2="205" stroke="#1d4ed8" stroke-width="2.5"/>
      <!-- Actuator dashes from M coil to main contacts -->
      <line x1="580" y1="68" x2="580" y2="130" stroke="#8b5cf6" stroke-width="1.5" stroke-dasharray="4,2"/>
      <line x1="580" y1="130" x2="220" y2="130" stroke="#8b5cf6" stroke-width="1.5" stroke-dasharray="4,2"/>
      <line x1="220" y1="130" x2="220" y2="143" stroke="#8b5cf6" stroke-width="1.5" stroke-dasharray="4,2"/>
      <text x="400" y="127" text-anchor="middle" fill="#8b5cf6" font-size="7">M energized → main contacts close → motor runs</text>
    </svg>`;
  },

  // === QUIZ ===
  _diagQuizQuestions: [
    { q: 'A single-pole switch controls a light. Looking at the wiring diagram, how many conductors run from the switch box to the light?', opts: ['1','2','3','4'], correct: 1, exp: 'A switch-light circuit needs 2 conductors: switched hot (black) + neutral (white). Both must be present to complete the circuit.' },
    { q: 'On a blueprint, a cable run between two 3-way switches has 3 slash marks (///). What cable type is required?', opts: ['14/1','14/2','14/3','14/4'], correct: 2, exp: 'Each slash mark = one conductor. Three slashes = 3 conductors = 14/3 NMD90. The extra conductor (red) carries the second traveler wire.' },
    { q: 'In a ladder diagram (schematic), why does the switch contact appear on the LEFT side of the rung?', opts: ['It\'s a drawing convention only','Contacts are inputs/conditions — they control whether current can reach the output (coil/load) on the right','Contacts are always drawn first alphabetically','The neutral rail is on the left'], correct: 1, exp: 'In a ladder diagram: left rail = L1 (hot), right rail = N/L2. Contacts (inputs) are placed left, coils/loads (outputs) are placed right. Current flows left-to-right through closed contacts to energize the load.' },
    { q: 'A relay control circuit has two separate rungs. What does the TOP rung contain?', opts: ['The motor winding','The main contacts and OL heaters','The control circuit: pushbutton and relay coil','The grounding conductor'], correct: 2, exp: 'In relay/starter ladder diagrams: top rung = CONTROL circuit (pushbutton, auxiliary contacts, coil). Bottom rung = POWER circuit (main contacts, OL heaters, load/motor). Control uses low energy; power carries full load current.' },
    { q: 'In a 3-wire motor control circuit, why is a SEAL-IN (M) contact wired in parallel with the Start pushbutton?', opts: ['To increase motor speed','To provide a second start button','To hold the circuit energized after you release the Start button','To reduce voltage to the coil'], correct: 2, exp: 'When you press Start, current flows through the Start NO contact and energizes M coil. M coil closes the M auxiliary (seal-in) contact, which creates a parallel path. When you release Start, the seal-in contact keeps the circuit alive. Pressing Stop breaks this path.' },
    { q: 'On a wiring diagram, what is the purpose of the wire nut (WN) shown in the switch box for a basic switch-light circuit?', opts: ['It switches the circuit','It joins the neutral conductor — neutral passes through the box without interruption','It connects to ground only','It terminates the hot wire'], correct: 1, exp: 'The neutral (white) runs continuously from panel to light. It does NOT pass through the switch. At the switch box, the neutral is wire-nutted (spliced) to pass through — the switch only interrupts the hot (black) conductor.' },
    { q: 'A block diagram shows: [Panel] → [Switch] → [Light]. Converting this to a wiring diagram, what additional information is now visible?', opts: ['Only the panel amperage','The actual wire colours, the cable type, how wires connect inside each box, and where wire nuts are located','Only the light wattage','Only the circuit number'], correct: 1, exp: 'A block diagram shows WHAT components exist and their ORDER. A wiring diagram adds HOW they connect: wire colours (black/white/green), cable type (14/2 NMD90), splice locations (wire nuts), box entry points, and which terminal each wire attaches to.' },
    { q: 'In a 3-way switch schematic, how many conductors are drawn between the two switch symbols on the schematic?', opts: ['1','2','3','4'], correct: 1, exp: 'Two traveler conductors run between 3-way switches. The schematic shows both: Traveler A and Traveler B. Only one is active at a time depending on both switch positions. The common conductors (hot in and switched hot out) connect to the rails.' },
  ],

  _diagQuizHTML() {
    const qs = this._diagQuizQuestions;
    const idx = this._diagQuizIdx || 0;
    if (idx >= qs.length) {
      const score = this._diagQuizScore || 0;
      const pct = Math.round((score / qs.length) * 100);
      const color = pct >= 80 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444';
      return `
      <div style="text-align:center;padding:40px 20px;">
        <div style="font-size:3rem;margin-bottom:12px;">${pct >= 80 ? '🏆' : pct >= 60 ? '💪' : '📚'}</div>
        <h2 style="font-size:1.5rem;margin:0 0 8px;color:${color};">Quiz Complete! ${score}/${qs.length} correct (${pct}%)</h2>
        <p style="color:var(--text-secondary);margin:0 0 24px;">${pct >= 80 ? 'Excellent! You understand diagram conversion well.' : pct >= 60 ? 'Good work — review the wiring and schematic views to reinforce the concepts.' : 'Keep practicing! Use the Learn tab to study each view carefully, then try again.'}</p>
        <button onclick="Tools._diagTab='learn';Tools._renderDiagramContent()" style="padding:10px 24px;background:var(--accent);color:#000;border:none;border-radius:10px;font-weight:700;cursor:pointer;margin-right:10px;">&#x1F4DA; Back to Learn</button>
        <button onclick="Tools._diagQuizIdx=0;Tools._diagQuizAnswered=false;Tools._diagQuizScore=0;Tools._diagQuizTotal=0;Tools._renderDiagramContent()" style="padding:10px 24px;background:var(--bg-card);color:var(--text-primary);border:1px solid var(--border);border-radius:10px;font-weight:700;cursor:pointer;">&#x1F504; Try Again</button>
      </div>`;
    }
    const q = qs[idx];
    const answered = this._diagQuizAnswered;
    return `
    <div style="max-width:640px;margin:0 auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <span style="font-size:0.8rem;color:var(--text-muted);">Question ${idx+1} of ${qs.length}</span>
        <span style="font-size:0.8rem;color:var(--text-muted);">Score: ${this._diagQuizScore || 0}/${idx}</span>
      </div>
      <div style="height:4px;background:var(--bg-input);border-radius:4px;margin-bottom:20px;overflow:hidden;">
        <div style="height:100%;width:${((idx)/qs.length)*100}%;background:var(--accent);border-radius:4px;transition:width 0.4s;"></div>
      </div>
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:24px;margin-bottom:16px;">
        <p style="font-size:1rem;font-weight:600;line-height:1.6;margin:0 0 20px;">${q.q}</p>
        <div style="display:flex;flex-direction:column;gap:10px;">
          ${q.opts.map((o,i) => {
            let style = 'padding:12px 16px;border-radius:10px;border:1px solid var(--border);cursor:pointer;font-size:0.88rem;text-align:left;width:100%;background:var(--bg-input);color:var(--text-primary);font-weight:500;';
            if (answered) {
              if (i === q.correct) style = 'padding:12px 16px;border-radius:10px;border:2px solid #22c55e;cursor:default;font-size:0.88rem;text-align:left;width:100%;background:rgba(34,197,94,0.1);color:#22c55e;font-weight:700;';
              else style = 'padding:12px 16px;border-radius:10px;border:1px solid rgba(239,68,68,0.3);cursor:default;font-size:0.88rem;text-align:left;width:100%;background:rgba(239,68,68,0.05);color:var(--text-muted);';
            }
            const check = answered && i === q.correct ? ' ✓' : '';
            return `<button onclick="${answered ? '' : `Tools._diagQuizAnswered=true;if(${i}===${q.correct})Tools._diagQuizScore=(Tools._diagQuizScore||0)+1;Tools._renderDiagramContent()`}" style="${style}">${o}${check}</button>`;
          }).join('')}
        </div>
        ${answered ? `
        <div style="margin-top:16px;padding:12px 14px;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.2);border-radius:10px;font-size:0.82rem;color:var(--text-secondary);line-height:1.6;">
          <strong style="color:#3b82f6;">Explanation:</strong> ${q.exp}
        </div>
        <button onclick="Tools._diagQuizIdx=(Tools._diagQuizIdx||0)+1;Tools._diagQuizAnswered=false;Tools._renderDiagramContent()" style="margin-top:14px;padding:10px 24px;background:var(--accent);color:#000;border:none;border-radius:10px;font-weight:700;cursor:pointer;width:100%;">Next →</button>` : ''}
      </div>
    </div>`;
  },

  // Stop all animations when leaving page
  cleanup() {
    if (this._ohmAnimFrame)    { cancelAnimationFrame(this._ohmAnimFrame); this._ohmAnimFrame = null; }
    if (this._ohmResRAF)       { cancelAnimationFrame(this._ohmResRAF); this._ohmResRAF = null; }
    if (this._ohmWireIntervals){ this._ohmWireIntervals.forEach(clearInterval); this._ohmWireIntervals = []; }
    if (this._acAnimId)        { cancelAnimationFrame(this._acAnimId); this._acAnimId = null; }
    if (this._motorAnimId)     { cancelAnimationFrame(this._motorAnimId); this._motorAnimId = null; }
    if (this._serAnimFrame)    { cancelAnimationFrame(this._serAnimFrame); this._serAnimFrame = null; }
    if (this._parAnimFrame)    { cancelAnimationFrame(this._parAnimFrame); this._parAnimFrame = null; }
    this.activeSim = null;
  }
};
// ===== ANALYTICS MODULE =====
const Analytics = {
  render(state) {
    if (!state) return;
    const container = document.getElementById('analyticsContent');
    const topics = getTopicsForPeriod(state.user.period);
    const overallMastery = getOverallMastery(state);

    // Study days for streak calendar (last 28 days)
    const days = [];
    for (let i = 27; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().split('T')[0];
      const dayData = state.sessions.daily[key];
      days.push({ date: key, day: d.getDay(), label: d.getDate(), studied: !!dayData, heavy: dayData && (dayData.flashcards > 10 || dayData.exams > 0) });
    }

    // Exam trend
    const examAttempts = state.exams.attempts.slice(-10);

    // Total cards reviewed
    let totalCards = 0;
    Object.values(state.sessions.daily).forEach(d => { totalCards += (d.flashcards || 0); });

    // Cards by mastery tier
    const tiers = { new: 0, learning: 0, review: 0, mastered: 0, expert: 0 };
    Object.entries(state.flashcards).forEach(([id, cd]) => {
      const tier = SM2.getMasteryTier(cd);
      tiers[tier]++;
    });
    const totalFlashcards = Object.keys(state.flashcards).length;

    container.innerHTML = `
      <h1 style="margin-bottom:8px;">Analytics</h1>
      <p style="color:var(--text-secondary);margin-bottom:32px;">Track your learning progress over time.</p>

      <div class="stat-grid" style="margin-bottom:24px;">
        <div class="stat-card">
          <div class="stat-value">${overallMastery}%</div>
          <div class="stat-label">Overall Mastery</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${state.sessions.streak}</div>
          <div class="stat-label">Day Streak</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${totalCards}</div>
          <div class="stat-label">Cards Reviewed</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${Math.round((state.sessions.totalTime || 0) / 3600000 * 10) / 10}h</div>
          <div class="stat-label">Total Study Time</div>
        </div>
      </div>

      <div class="analytics-grid">
        <!-- Streak Calendar -->
        <div class="card">
          <div class="section-title">&#128293; Study Streak Calendar</div>
          <div class="streak-day-labels">
            <span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span>
          </div>
          <div class="streak-calendar">
            ${days.map(d => `
              <div class="streak-day ${d.heavy ? 'studied-heavy' : d.studied ? 'studied' : ''}"
                   title="${d.date}${d.studied ? ' \u2014 studied' : ''}"
                   style="display:flex;align-items:center;justify-content:center;font-size:0.65rem;color:${d.studied ? '#000' : 'var(--text-muted)'};">
                ${d.label}
              </div>
            `).join('')}
          </div>
          <div style="display:flex;gap:12px;margin-top:12px;font-size:0.75rem;color:var(--text-muted);">
            <span><span style="display:inline-block;width:12px;height:12px;background:var(--bg-input);border-radius:2px;vertical-align:middle;"></span> No study</span>
            <span><span style="display:inline-block;width:12px;height:12px;background:var(--accent-soft);border-radius:2px;vertical-align:middle;"></span> Studied</span>
            <span><span style="display:inline-block;width:12px;height:12px;background:var(--accent);border-radius:2px;vertical-align:middle;"></span> Heavy study</span>
          </div>
        </div>

        <!-- Card Mastery Distribution -->
        <div class="card">
          <div class="section-title">&#128218; Flashcard Mastery</div>
          <div style="display:flex;flex-direction:column;gap:10px;">
            ${[
              { label: 'Expert (60+ days)', count: tiers.expert, color: '#10b981' },
              { label: 'Mastered (21+ days)', count: tiers.mastered, color: '#34d399' },
              { label: 'Review (3-20 days)', count: tiers.review, color: '#fbbf24' },
              { label: 'Learning (< 3 days)', count: tiers.learning, color: '#f97316' },
              { label: 'New (unseen)', count: tiers.new, color: '#ef4444' },
            ].map(t => `
              <div style="display:flex;align-items:center;gap:10px;">
                <div style="width:100px;font-size:0.8rem;color:var(--text-secondary);text-align:right;">${t.label}</div>
                <div style="flex:1;height:20px;background:var(--bg-input);border-radius:4px;overflow:hidden;position:relative;">
                  <div style="height:100%;width:${totalFlashcards > 0 ? (t.count / totalFlashcards * 100) : 0}%;background:${t.color};border-radius:4px;"></div>
                </div>
                <div style="width:40px;font-size:0.85rem;font-weight:600;">${t.count}</div>
              </div>
            `).join('')}
          </div>
          <div style="text-align:center;margin-top:12px;font-size:0.85rem;color:var(--text-muted);">${totalFlashcards} total cards</div>
        </div>

        <!-- Exam Score Trend -->
        <div class="card full-width">
          <div class="section-title">&#128200; Exam Score Trend</div>
          ${examAttempts.length > 0 ? `
            <div style="display:flex;align-items:flex-end;gap:8px;height:200px;padding-top:20px;">
              ${examAttempts.map((a, i) => `
                <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;">
                  <div style="font-size:0.7rem;font-weight:700;color:${a.pct >= 70 ? 'var(--success)' : 'var(--danger)'}">${a.pct}%</div>
                  <div style="width:100%;height:${a.pct * 1.5}px;background:${a.pct >= 70 ? 'var(--success)' : 'var(--danger)'};border-radius:4px 4px 0 0;min-height:4px;"></div>
                  <div style="font-size:0.65rem;color:var(--text-muted);">#${i + 1}</div>
                </div>
              `).join('')}
            </div>
            <div style="border-top:2px dashed rgba(245,158,11,0.3);margin-top:-${70 * 1.5}px;position:relative;">
              <span style="position:absolute;right:0;top:-16px;font-size:0.7rem;color:var(--accent);">70% pass</span>
            </div>
            <div style="height:${70 * 1.5}px;"></div>
          ` : `
            <div class="empty-state" style="padding:40px;">
              <h3>No exam data yet</h3>
              <p style="color:var(--text-muted);">Take a practice exam to see your score trend.</p>
            </div>
          `}
        </div>

        <!-- Topic Mastery -->
        <div class="card full-width">
          <div class="section-title">&#127919; Topic Mastery Breakdown</div>
          <div class="mastery-heatmap">
            ${topics.map(t => {
              const m = getTopicMastery(state, t.id);
              return `
                <div class="heatmap-row">
                  <div class="heatmap-label">${t.icon} ${t.name}</div>
                  <div class="heatmap-bar-wrap">
                    <div class="heatmap-bar" style="width:${Math.max(2, m)}%;background:${getMasteryColor(m)}"></div>
                    <div class="heatmap-pct" style="color:${m > 50 ? '#000' : 'var(--text-secondary)'}">${m}%</div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        ${state.diagnostic.completed ? `
        <div class="card full-width">
          <div class="section-title">&#129504; Diagnostic vs Current</div>
          <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.9rem;">How you've improved since your initial diagnostic assessment.</p>
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${Object.entries(state.diagnostic.topicPcts || {}).map(([tid, diagPct]) => {
              const currentPct = getTopicMastery(state, tid);
              const diff = currentPct - diagPct;
              return `
                <div style="display:flex;align-items:center;gap:12px;">
                  <div style="width:140px;font-size:0.8rem;color:var(--text-secondary);text-align:right;">${TOPICS[tid]?.name || tid}</div>
                  <div style="width:50px;font-size:0.8rem;color:var(--text-muted);text-align:right;">${diagPct}%</div>
                  <div style="font-size:0.8rem;">&#8594;</div>
                  <div style="width:50px;font-size:0.8rem;font-weight:600;color:${getMasteryColor(currentPct)}">${currentPct}%</div>
                  <div style="font-size:0.8rem;font-weight:600;color:${diff > 0 ? 'var(--success)' : diff < 0 ? 'var(--danger)' : 'var(--text-muted)'};">
                    ${diff > 0 ? '+' : ''}${diff}%
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
        ` : ''}
      </div>
    `;
  }
};

// ===== REVIEW MODULE =====
const Review = {
  tab: 'missed', // missed, bookmarked, weak

  render(state) {
    if (!state) return;
    const container = document.getElementById('reviewContent');

    // Get missed questions from exams
    const missed = [];
    state.exams.attempts.forEach(a => {
      a.responses.filter(r => !r.isCorrect).forEach(r => {
        if (!missed.find(m => m.qId === r.qId)) missed.push(r);
      });
    });

    // Get bookmarked
    const bookmarked = state.exams.bookmarked || [];

    // Get weak topic cards
    const weakCards = [];
    if (state.diagnostic.weakAreas) {
      state.diagnostic.weakAreas.forEach(tid => {
        FLASHCARD_BANK.filter(fc => fc.topic === tid).forEach(fc => {
          const cd = state.flashcards[fc.id];
          if (cd && SM2.getMasteryTier(cd) !== 'mastered' && SM2.getMasteryTier(cd) !== 'expert') {
            weakCards.push({ ...fc, tier: SM2.getMasteryTier(cd) });
          }
        });
      });
    }

    container.innerHTML = `
      <h1 style="margin-bottom:8px;">Review</h1>
      <p style="color:var(--text-secondary);margin-bottom:24px;">Focus on questions and topics that need more work.</p>

      <div class="review-tabs">
        <button class="review-tab ${this.tab === 'missed' ? 'active' : ''}" onclick="Review.switchTab('missed')">
          Missed Questions (${missed.length})
        </button>
        <button class="review-tab ${this.tab === 'weak' ? 'active' : ''}" onclick="Review.switchTab('weak')">
          Weak Area Cards (${weakCards.length})
        </button>
      </div>

      <div id="reviewTabContent">
        ${this.tab === 'missed' ? this.renderMissed(missed) : this.renderWeak(weakCards)}
      </div>
    `;
  },

  switchTab(tab) {
    this.tab = tab;
    const state = Storage.get();
    this.render(state);
  },

  renderMissed(missed) {
    if (missed.length === 0) return '<div class="empty-state"><h3>No missed questions</h3><p style="color:var(--text-muted);">Take a practice exam to see missed questions here.</p></div>';
    return missed.map(r => `
      <div class="review-question">
        <div class="rq-topic">${TOPICS[r.topic]?.icon || ''} ${TOPICS[r.topic]?.name || r.topic}</div>
        <div class="rq-text">${r.q}</div>
        <div class="rq-answer">
          <span class="rq-your-answer">&#10007; Your answer: ${r.selected !== null ? r.opts[r.selected] : 'Unanswered'}</span><br>
          <span class="rq-correct-answer">&#10003; Correct: ${r.opts[r.correct]}</span>
        </div>
        ${r.exp ? `<div class="rq-explanation">${r.exp}</div>` : ''}
      </div>
    `).join('');
  },

  renderWeak(weakCards) {
    if (weakCards.length === 0) return '<div class="empty-state"><h3>No weak area cards</h3><p style="color:var(--text-muted);">Complete the diagnostic to identify weak areas.</p></div>';
    return weakCards.map(fc => `
      <div class="review-question">
        <div class="rq-topic">${TOPICS[fc.topic]?.icon || ''} ${TOPICS[fc.topic]?.name || fc.topic} &mdash; <span class="badge badge-${fc.tier === 'new' ? 'danger' : 'warning'}">${fc.tier}</span></div>
        <div class="rq-text">${fc.q}</div>
        <div class="rq-answer"><span class="rq-correct-answer">${fc.a}</span></div>
      </div>
    `).join('');
  }
};

// ===== LESSONS MODULE =====

const LESSONS_CONTENT = [
  {
    id: 'm1',
    title: 'AC Fundamentals',
    icon: '〜',
    subtitle: 'The Invisible River That Powers Everything',
    color: '#f59e0b',
    gradient: 'linear-gradient(135deg,rgba(245,158,11,0.12),rgba(234,88,12,0.06))',
    border: 'rgba(245,158,11,0.3)',
    readTime: '12 min read',
    sections: [
      {
        type: 'hook',
        title: '⚡ Picture This',
        body: `Right now, the electrons in your outlet aren't traveling from the power plant to your house — they're just jiggling back and forth, 60 times per second, barely moving anywhere at all.\n\nAnd yet your lights are on. Your phone is charging. Your coffee maker just finished its cycle.\n\nHow? Welcome to AC power — arguably the greatest electrical engineering trick ever pulled off.`
      },
      {
        type: 'story',
        title: '🏆 The War of Currents',
        body: `In the late 1880s, Thomas Edison and Nikola Tesla were locked in a bitter fight over which electrical system would power the world.\n\nEdison backed DC (direct current) — electrons flowing one direction, like water through a pipe. Safe, predictable. But DC couldn't be stepped up to high voltage efficiently, which meant it lost half its energy as heat over long distances. Edison's system needed a power station every mile or two.\n\nTesla backed AC (alternating current) — electrons oscillating back and forth. Edison called it dangerous and even publicly electrocuted animals to prove his point (truly a PR disaster). But AC had one killer advantage: it could be transformed.\n\nUsing a transformer, AC voltage could be stepped up to 100,000V to travel hundreds of kilometers with minimal loss, then stepped back down to a safe level at your house. Tesla and Westinghouse won. The world runs on AC to this day.`
      },
      {
        type: 'concept',
        title: '📐 The Sine Wave: Nature\'s Favorite Shape',
        body: `AC voltage follows a sine wave — the same mathematical curve you see in ocean waves, sound waves, and light waves. It's not a coincidence: it's what you get when something rotates.\n\nA generator is literally just a coil of wire spinning in a magnetic field. As the coil rotates, the voltage it produces traces a perfect sine wave:\n• Starting at 0 when the coil is parallel to the magnetic field\n• Rising to a positive peak when the coil is at 90°\n• Back to 0 at 180°\n• Dropping to a negative peak at 270°\n• Back to 0 at 360° (one full rotation)\n\nIn North America, the generator completes 60 of these rotations every second — that's 60 Hz (hertz). Europe uses 50 Hz. Your equipment is designed specifically for the frequency it was built for.`,
        formula: 'v(t) = Vpeak × sin(2πft)\nWhere: f = 60 Hz, t = time in seconds'
      },
      {
        type: 'keypoint',
        title: '⚡ Peak vs. RMS: The Number That Actually Matters',
        body: `Here's where people get confused. When we say a standard outlet is "120V," that's NOT the peak voltage. The actual peak is about 170V.\n\nSo why do we say 120V? Because of RMS — Root Mean Square — a mathematical average that represents the equivalent DC heating effect.\n\nA 120V RMS AC supply does the same work as a 120V DC supply on a resistive load. It's the practical, useful number. The peak voltage is 1.414 times the RMS value (that factor is √2).\n\nThis matters enormously for equipment ratings, insulation ratings, and any calculations involving power.`,
        formula: 'VRMS = Vpeak ÷ √2 = Vpeak × 0.707\nVpeak = VRMS × √2 = VRMS × 1.414\nExample: 120V RMS → Peak = 120 × 1.414 = 169.7V'
      },
      {
        type: 'analogy',
        title: '🌊 Frequency & Period: Thinking in Time',
        body: `Think of frequency like the tempo of a song. 60 Hz means the wave completes 60 full cycles per second — it's a very fast tempo. The period is the time for one complete cycle: 1/60 = 0.0167 seconds (about 16.7 milliseconds).\n\nWhy does this matter on the job? Because:\n• Fluorescent lights flicker at 120 Hz (twice per cycle) — if you ever see a strobe effect on rotating equipment, that's why\n• Induction motor speeds are directly tied to frequency: a 2-pole motor at 60 Hz runs at 3600 RPM (synchronous speed)\n• Harmonic frequencies (120 Hz, 180 Hz, 240 Hz...) are multiples of the fundamental and can cause heating in transformers and neutral conductors`,
        formula: 'f = 1/T   T = 1/f\nAt 60 Hz: T = 1/60 = 16.7 ms\nMotor sync speed = (120 × f) ÷ number of poles'
      },
      {
        type: 'concept',
        title: '🔄 Phase: Where Are You in the Cycle?',
        body: `Phase describes the timing relationship between two sine waves. If two waves start at exactly the same time, they're "in phase" — they work together perfectly.\n\nIf one wave is shifted in time relative to another, there's a phase difference, measured in degrees (since one full cycle = 360°).\n\nThis becomes critical in three-phase power, where three sine waves are deliberately spaced 120° apart. Those three phases allow generators to produce constant power (not pulsing like single-phase), allow smaller conductors for the same power, and enable self-starting motors.\n\nOn the job: when connecting three-phase motors, phase rotation order (A-B-C vs A-C-B) determines which direction the motor spins. Get it wrong and the motor runs backwards.`
      },
      {
        type: 'real-world',
        title: '🔧 Real World: Why Your Outlets Are 120V and 240V',
        body: `Canadian residential service comes into your panel as 240V single-phase (two hot legs, each 120V to neutral, 240V between them). This clever setup means:\n\n• Normal outlets (120V): use one hot leg + neutral\n• High-power appliances (240V): use both hot legs\n\nThe two hot legs are 180° out of phase with each other — when one is at +170V peak, the other is at -170V peak. The difference between them is always 240V.\n\nThis is why a 240V circuit doesn't need a neutral for heating loads — it's just phase-to-phase. But 240V circuits with control electronics (like ovens with displays) DO use neutral for the low-voltage control circuits.`
      },
      {
        type: 'quiz',
        title: '🧠 Quick Check',
        questions: [
          { q: 'A 240V RMS supply has a peak voltage of approximately:', a: '340V (240 × 1.414 = 339.4V)' },
          { q: 'At 60 Hz, how long does one complete AC cycle take?', a: '16.7 milliseconds (1/60 second)' },
          { q: 'Why does AC power win over DC for long-distance transmission?', a: 'AC voltage can be transformed (stepped up/down). High voltage = low current = low I²R losses over long distances.' }
        ]
      },
      {
        type: 'protip',
        title: '🛠 Pro Tips',
        tips: [
          'When measuring AC with a multimeter, you\'re always reading RMS unless the meter specifies otherwise.',
          'Three-phase panels label phases as A, B, C (or L1, L2, L3). The voltage between any two phases is always 1.732 × the phase-to-neutral voltage. At 120V/208V service: 120 × √3 = 207.8V ≈ 208V.',
          'Harmonics are a real problem in modern buildings loaded with computers and variable frequency drives. They cause neutral conductors to overheat even when balanced — always check neutral sizing in these environments.'
        ]
      },
      {
        type: 'objectives',
        title: 'Module 1 Objectives',
        objectives: [
          'Describe the difference between alternating current (AC) and direct current (DC), and explain why AC is used for electrical power distribution.',
          'Describe how a generator produces a sine wave through the rotation of a conductor in a magnetic field.',
          'Identify the components of a sine wave: amplitude, peak value, peak-to-peak value, period, frequency, and phase angle.',
          'Calculate peak voltage from RMS voltage using Vpk = VRMS × √2, and calculate RMS voltage from peak voltage using VRMS = Vpk × 0.707.',
          'Calculate peak-to-peak voltage (Vpp = 2 × Vpk) and average voltage (Vavg = Vpk × 0.637) for a sine wave.',
          'Define frequency (Hz) as the number of complete cycles per second, and period (T) as the time for one complete cycle.',
          'Apply the reciprocal relationship between frequency and period: f = 1/T and T = 1/f.',
          'Explain why North American power systems operate at 60 Hz and describe the consequences of using 60 Hz equipment on a 50 Hz system.',
          'Define phase angle and explain what it means for two waveforms to be in phase or out of phase with each other.',
          'Describe how three-phase power is generated, identifying the 120° phase separation between the three waveforms.',
          'Identify the advantages of three-phase power over single-phase power: constant power delivery, smaller conductors for the same power, and self-starting induction motors.',
          'Apply the relationship between line voltage and phase voltage in a three-phase wye-connected system: VL = VΦ × √3.',
          'Describe the construction of Canadian residential single-phase 120/240V service, identifying the two hot legs, neutral, and their voltage relationships.',
          'Apply Ohm\'s Law calculations to AC resistive circuits using RMS values for voltage and current.'
        ],
        questions: [
          { q: 'A 347V RMS AC supply has a peak voltage of approximately:', a: '347 × 1.414 = 490.7V peak. (VRMS × √2 = Vpeak)' },
          { q: 'In a 120/240V residential service, what is the voltage between the two hot legs?', a: '240V. The two hot legs are 180° out of phase — each is 120V to neutral, but measured between them the difference is always 240V.' },
          { q: 'At 60 Hz, the period of one complete AC cycle is:', a: 'T = 1/f = 1/60 = 0.0167 seconds (16.7 milliseconds).' },
          { q: 'Why is the RMS value of an AC voltage more useful than the peak voltage for most calculations?', a: 'RMS represents the equivalent DC heating effect — a 120V RMS AC supply does the same work on a resistive load as 120V DC. It\'s the practical measure for power, heat, and load calculations.' },
          { q: 'A three-phase 208V system has a phase-to-neutral voltage of:', a: '208 ÷ √3 = 120V per phase. Line voltage = phase voltage × √3, so phase voltage = line voltage ÷ √3.' }
        ]
      },
      {
        type: 'outcome',
        title: 'Module Desired Outcome',
        outcome: 'The student will describe the characteristics and measurements of alternating current (AC) waveforms and apply these to basic AC calculations.',
        questions: [
          { q: 'An electrician measures 169.7V peak on a circuit. What is the RMS voltage, and is this circuit suitable for 120V-rated equipment?', a: 'VRMS = 169.7 × 0.707 = 120V. Yes — this is a standard 120V RMS circuit. The peak of 169.7V ≈ 170V is normal for 120V RMS AC.' },
          { q: 'A 600V/208V transformer secondary produces 208V line-to-line. What is the voltage from one phase to neutral? What is the peak voltage of the line-to-line waveform?', a: 'Phase-to-neutral: 208 ÷ √3 = 120V. Peak of line-to-line: 208 × √2 = 294.2V peak. The insulation of conductors must be rated for at least the peak voltage.' },
          { q: 'A motor rated for 60 Hz is connected to a 50 Hz supply at the same voltage. Describe what happens and why.', a: 'The motor runs at 50/60 = 83.3% of its rated speed (synchronous speed = 120f/poles). It also draws more current because the lower frequency means higher inductive reactance… wait, lower XL = lower impedance = more current. The motor will overheat. Additionally, fans and pumps driving it may lose required performance. Equipment must be matched to the supply frequency.' }
        ]
      }
    ]
  },
  {
    id: 'm2',
    title: 'Properties of Inductors & Capacitors',
    icon: '🔄',
    subtitle: 'The Components That Make AC Interesting',
    color: '#8b5cf6',
    gradient: 'linear-gradient(135deg,rgba(139,92,246,0.12),rgba(59,130,246,0.06))',
    border: 'rgba(139,92,246,0.3)',
    readTime: '14 min read',
    sections: [
      {
        type: 'hook',
        title: '⚡ The Components That Fight Back',
        body: `Resistors are boring. Feed them voltage, they resist, they heat up. Simple.\n\nBut inductors and capacitors? These components have attitude. They store energy. They fight changes in the circuit. They shift the phase of current. And together, they make possible everything from radio tuners to motor starters to power factor correction systems that utilities charge you thousands of dollars for.\n\nUnderstanding L and C is what separates an apprentice who can run wire from a journeyman who understands why the system works.`
      },
      {
        type: 'story',
        title: '🌀 The Inductor: Magnetism Fights Back',
        body: `An inductor is just a coil of wire — but wrapping wire into a coil creates a magnetic field when current flows through it. And here's the key insight: magnetic fields store energy.\n\nWhen you try to increase current through an inductor, the growing magnetic field induces a voltage that opposes the increase (Lenz's Law). When you try to decrease current, the collapsing field tries to maintain the current.\n\nIn other words: an inductor resists changes in current. It's electrical inertia.\n\nThe unit is the henry (H), named after Joseph Henry who discovered electromagnetic induction (yes, Faraday gets more credit, but Henry actually discovered it first — he just published later).\n\nReal-world inductors include motor windings, transformer primary coils, fluorescent lamp ballasts, and relay coils. Basically anything that uses a magnetic field to do work is an inductor.`
      },
      {
        type: 'concept',
        title: '📊 Inductive Reactance: Resistance That Cares About Frequency',
        body: `Inductors don't have resistance in the traditional sense — they have reactance. And unlike resistance (which is fixed), inductive reactance changes with frequency.\n\nHigher frequency → inductor changes current faster → it fights back harder → more reactance.\n\nLower frequency (or DC) → slower change → inductor barely resists → nearly zero reactance at DC.\n\nThis is why inductors are used as "chokes" to block high-frequency signals while passing DC — perfect for power supply filters in electronics.`,
        formula: 'XL = 2πfL\nWhere: XL = inductive reactance (Ω), f = frequency (Hz), L = inductance (H)\n\nExample: L = 100mH at 60 Hz\nXL = 2π × 60 × 0.1 = 37.7 Ω'
      },
      {
        type: 'keypoint',
        title: '⏰ Inductive Phase Shift: Current Lags',
        body: `Here's the most important characteristic for your exam: in a purely inductive circuit, current LAGS voltage by 90°.\n\nMnemonic: ELI the ICE man\n• ELI: in an inductive (L) circuit, voltage (E) leads current (I)\n• ICE: in a capacitive (C) circuit, current (I) leads voltage (E)\n\nPhysically, this makes sense: voltage is applied first, but the inductor's opposition means current builds up slowly afterward. The voltage is always "ahead" of the current by a quarter-cycle (90°).\n\nThis phase shift is the root cause of poor power factor in industrial facilities. Inductive motors, transformers, and ballasts all cause lagging current, and utilities charge extra for it.`,
        formula: 'In a pure inductor: θ = 90° (current lags voltage)'
      },
      {
        type: 'story',
        title: '⚡ The Capacitor: Electric Fields Fight Back',
        body: `A capacitor stores energy in an electric field rather than a magnetic field. The basic structure is two conductive plates separated by an insulator (the dielectric). Push charge onto the plates, an electric field builds up between them — and energy is stored.\n\nCapacitors resist changes in voltage. Try to change the voltage across a capacitor quickly, and the capacitor absorbs or releases charge to fight you.\n\nWhen you disconnect a capacitor from a circuit, it holds its charge — sometimes for a very long time. This is why capacitors in equipment like large drives and power supplies can be lethally dangerous even hours after power is removed. Always verify capacitors are discharged with a properly rated discharge resistor before working inside high-voltage equipment.\n\nThe unit is the farad (F), but practical capacitors are usually in microfarads (μF) or nanofarads (nF) — a full farad is enormous.`
      },
      {
        type: 'concept',
        title: '📊 Capacitive Reactance: The Opposite of Inductive',
        body: `Capacitive reactance is the opposite of inductive reactance in almost every way:\n\n• Higher frequency → capacitor charges/discharges faster → less time to fight → LESS reactance\n• Lower frequency (or DC) → very slow charging → capacitor barely lets anything through → infinite reactance at DC\n\nThis is why capacitors block DC but pass AC — essential in virtually every electronic circuit for signal coupling and filtering.`,
        formula: 'XC = 1 / (2πfC)\nWhere: XC = capacitive reactance (Ω), f = frequency (Hz), C = capacitance (F)\n\nExample: C = 100μF at 60 Hz\nXC = 1 / (2π × 60 × 0.0001) = 26.5 Ω\n\nNote: XC decreases as frequency increases (opposite of XL)'
      },
      {
        type: 'keypoint',
        title: '⏰ Capacitive Phase Shift: Current Leads',
        body: `In a purely capacitive circuit, current LEADS voltage by 90°.\n\nPhysical intuition: when you first connect voltage to a capacitor, current rushes in immediately to charge the plates — before the voltage has had time to build up. Current is "eager," getting there before voltage.\n\nThis leading current is the exact opposite of inductive lagging current, which is why capacitors are used to correct power factor: they cancel out the lagging effect of inductive loads.\n\nPower factor correction capacitor banks are installed at industrial facilities, transformer substations, and motor control panels. They reduce the reactive current the utility has to supply, reducing losses and avoiding demand charges.`,
        formula: 'In a pure capacitor: θ = -90° (current leads voltage)'
      },
      {
        type: 'real-world',
        title: '🔧 Real World: The Motor Start Capacitor',
        body: `Single-phase induction motors can't self-start without help — the single-phase supply creates a pulsating (not rotating) magnetic field. A start capacitor solves this by creating a second, phase-shifted current in a separate start winding.\n\nThe capacitor shifts the current in the start winding by about 90°, creating a phase difference between the run and start windings. The two magnetic fields, 90° apart in time and space, create a rotating field that kicks the motor off.\n\nOnce up to speed, a centrifugal switch disconnects the start capacitor (which is only rated for intermittent duty). Run capacitors (smaller, continuous duty rated) stay in circuit to improve power factor and efficiency.\n\nIf a single-phase motor hums but won't start, or starts only when you give it a spin by hand — the start capacitor is bad. Test it with a capacitance meter.`
      },
      {
        type: 'quiz',
        title: '🧠 Quick Check',
        questions: [
          { q: 'A 50 mH inductor at 60 Hz has a reactance of:', a: 'XL = 2π × 60 × 0.05 = 18.85 Ω' },
          { q: 'In a purely inductive circuit, current _____ voltage by 90°.', a: 'LAGS (use ELI: voltage E leads current I in inductor L)' },
          { q: 'A 47 μF capacitor at 60 Hz has a reactance of:', a: 'XC = 1/(2π × 60 × 0.000047) = 56.4 Ω' },
          { q: 'Why is capacitive reactance high at DC (0 Hz)?', a: 'XC = 1/(2πfC) — dividing by frequency approaching zero gives infinity. DC cannot charge/discharge a capacitor continuously, so it blocks DC.' }
        ]
      },
      {
        type: 'protip',
        title: '🛠 Pro Tips',
        tips: [
          'Remember ELI the ICE man — it\'s the most exam-tested concept related to L and C. ELI = E leads I in Inductor. ICE = I leads E in Capacitor.',
          'Capacitors store dangerous charge. On anything with a large capacitor bank (drives, UPS systems, motor start panels), verify voltage with your meter before touching. Some will hold a lethal charge for many minutes.',
          'Inductive reactance and capacitive reactance cancel each other out at resonance (when XL = XC). Resonance is exploited in radio tuning circuits and power factor correction, but can also cause dangerous overvoltages in unintended resonant conditions.'
        ]
      },
      {
        type: 'objectives',
        title: 'Module 2 Objectives',
        objectives: [
          'Define inductance (L) and explain the principle of self-induction using Faraday\'s and Lenz\'s Laws.',
          'Describe how a magnetic field stores energy in an inductor and explain why an inductor opposes changes in current.',
          'Identify the factors that determine the inductance of a coil: number of turns, core permeability, cross-sectional area, and coil length.',
          'Calculate inductive reactance using XL = 2πfL and explain how XL changes with frequency and inductance.',
          'Describe the phase relationship between voltage and current in a purely inductive circuit (current lags voltage by 90°).',
          'Apply the ELI mnemonic (E leads I in L) to remember inductor phase relationships.',
          'Define capacitance (C) and describe how an electric field stores energy between the plates of a capacitor.',
          'Identify the factors that determine capacitance: plate area, plate separation, and dielectric material.',
          'Calculate capacitive reactance using XC = 1/(2πfC) and explain how XC changes with frequency and capacitance.',
          'Describe the phase relationship between voltage and current in a purely capacitive circuit (current leads voltage by 90°).',
          'Apply the ICE mnemonic (I leads E in C) to remember capacitor phase relationships.',
          'Explain why inductors pass DC but block high-frequency AC signals, and why capacitors block DC but pass AC.',
          'Identify common applications of inductors in electrical systems: motor windings, transformer coils, fluorescent ballasts, reactor coils, and relay coils.',
          'Identify common applications of capacitors: power factor correction, motor starting, filter circuits, and energy storage.',
          'Describe the safety hazard of stored charge in large capacitors and explain the proper procedure for discharging capacitors before working on equipment.'
        ],
        questions: [
          { q: 'A 200mH inductor is connected to a 60 Hz supply. What is its inductive reactance?', a: 'XL = 2πfL = 2π × 60 × 0.2 = 75.4 Ω' },
          { q: 'A 100μF capacitor is connected to a 60 Hz supply. What is its capacitive reactance?', a: 'XC = 1/(2πfC) = 1/(2π × 60 × 0.0001) = 26.5 Ω' },
          { q: 'In a purely inductive circuit, current lags voltage by how many degrees? Apply ELI to confirm.', a: '90°. ELI: in an inductor (L), voltage (E) leads current (I) — meaning current lags voltage by 90°.' },
          { q: 'Why must large capacitors in industrial equipment be discharged before working on them?', a: 'Capacitors store charge and hold it even after power is removed. Large capacitors in drives, UPS systems, and power supplies can retain lethal voltage for many minutes or hours. They must be discharged through a rated resistor and verified with a voltmeter before touching.' },
          { q: 'What happens to inductive reactance if the frequency doubles? What happens to capacitive reactance if the frequency doubles?', a: 'XL doubles (XL = 2πfL — directly proportional to f). XC halves (XC = 1/(2πfC) — inversely proportional to f). This is why inductors increasingly block higher frequencies and capacitors increasingly pass them.' }
        ]
      },
      {
        type: 'outcome',
        title: 'Module Desired Outcome',
        outcome: 'The student will describe the properties of inductors and capacitors and explain their effects on current and voltage in AC circuits.',
        questions: [
          { q: 'A technician connects a 50mH coil directly across a 120V, 60Hz supply. Calculate the inductive reactance and the current that will flow. Is this a safe thing to do without knowing the coil\'s resistance?', a: 'XL = 2π × 60 × 0.05 = 18.85 Ω. Assuming ideal inductor: I = V/XL = 120/18.85 = 6.37A. In practice, a real coil has DC resistance too — total current depends on Z = √(R² + XL²). Without knowing resistance, you could draw much more current than the coil is rated for. Always check the coil\'s rated current before connecting.' },
          { q: 'Explain why a large variable frequency drive should have its capacitor bank discharged before a technician works inside, even 30 minutes after power is removed. How would you verify it is safe?', a: 'Large DC bus capacitors in drives can hold hundreds of volts for extended periods after power off — the bus voltage decays slowly through high-resistance discharge resistors. To verify: wait the manufacturer\'s specified discharge time (typically 5-15 min), then measure DC bus voltage with a properly rated meter between the DC+ and DC- terminals. Voltage must be below 50V (or per the drive\'s safety threshold) before proceeding.' }
        ]
      }
    ]
  },
  {
    id: 'm3',
    title: 'Inductors & Capacitors in Circuits',
    icon: '⚡',
    subtitle: 'Reactance, Impedance, and the Power Triangle',
    color: '#06b6d4',
    gradient: 'linear-gradient(135deg,rgba(6,182,212,0.12),rgba(59,130,246,0.06))',
    border: 'rgba(6,182,212,0.3)',
    readTime: '15 min read',
    sections: [
      {
        type: 'hook',
        title: '⚡ Resistance Isn\'t Everything',
        body: `In a DC circuit, life is simple: Ohm's Law, resistance, done. But in an AC circuit with inductors and capacitors, resistance is just one piece of the puzzle.\n\nWhen you combine resistance (R) with reactance (XL or XC), you get impedance (Z) — the total opposition to current flow in an AC circuit. And impedance doesn't just determine how much current flows — it determines when it flows.\n\nMaster impedance and you understand why motors draw reactive current, why long fluorescent ballast circuits need power factor capacitors, and why neutral conductors in some commercial buildings carry more current than the phase conductors.`
      },
      {
        type: 'concept',
        title: '📐 Impedance: The Full Picture',
        body: `You cannot simply add resistance and reactance together — they're at different angles. R is always at 0° (in phase with voltage), while XL is at +90° and XC is at -90°.\n\nTo combine them, use the Pythagorean theorem on the impedance triangle:\n• Z = √(R² + (XL - XC)²)\n\nWhen XL > XC: net reactance is inductive, current lags voltage\nWhen XC > XL: net reactance is capacitive, current leads voltage\nWhen XL = XC: resonance — Z = R only, current is in phase with voltage\n\nThe phase angle θ tells you how far current is shifted from voltage:\nθ = arctan((XL - XC) / R)`,
        formula: 'Z = √(R² + X²)\nwhere X = XL - XC (net reactance)\n\nFor an RL circuit: Z = √(R² + XL²)\nFor an RC circuit: Z = √(R² + XC²)\nFor an RLC circuit: Z = √(R² + (XL - XC)²)'
      },
      {
        type: 'concept',
        title: '⚡ Series RL Circuit: Motors and Ballasts',
        body: `Almost every inductive load you'll work with is a series RL circuit: resistance from the copper windings plus inductance from the coil. Motors, transformers, relay coils, and fluorescent ballasts are all RL loads.\n\nIn a series RL circuit:\n• Voltage across R is in phase with current\n• Voltage across L leads current by 90°\n• Total supply voltage is the phasor sum: VS = √(VR² + VL²)\n• Current lags supply voltage by angle θ = arctan(XL/R)\n\nExample: A motor coil has R = 8Ω and XL = 6Ω at 60 Hz.\nZ = √(8² + 6²) = √(64 + 36) = √100 = 10 Ω\nCurrent lags voltage by θ = arctan(6/8) = 36.87°`,
        formula: 'Series RL:\nZ = √(R² + XL²)\nVR = I × R\nVL = I × XL\nVS = √(VR² + VL²)\nθ = arctan(XL / R)   [current lags]'
      },
      {
        type: 'concept',
        title: '🔋 Series RC Circuit: Timers and Filters',
        body: `Series RC circuits appear in motor start circuits, timing circuits, and filter networks. Current leads voltage in a capacitive circuit, which is the exact opposite of an RL load.\n\nExample: A circuit has R = 30Ω and C = 100μF at 60 Hz.\nXC = 1/(2π × 60 × 0.0001) = 26.5 Ω\nZ = √(30² + 26.5²) = √(900 + 702) = √1602 = 40.0 Ω\nθ = arctan(26.5/30) = 41.4° (current leads voltage)`,
        formula: 'Series RC:\nZ = √(R² + XC²)\nVR = I × R\nVC = I × XC\nVS = √(VR² + VC²)\nθ = arctan(XC / R)   [current leads]'
      },
      {
        type: 'keypoint',
        title: '🔺 The Power Triangle: Real, Reactive, Apparent',
        body: `Power in AC circuits comes in three flavors:\n\n• True Power (P) — measured in Watts (W). This is REAL power that does actual work: heats elements, spins motors, powers computers. Calculated from I²R (the resistive component only).\n\n• Reactive Power (Q) — measured in VAR (Volt-Amps Reactive). This power is NOT consumed — it just sloshes back and forth between the source and the inductor/capacitor. It does no useful work, but it occupies conductor and transformer capacity.\n\n• Apparent Power (S) — measured in VA (Volt-Amps). This is what the utility actually has to supply: it's the total current times the total voltage, regardless of phase angle. S = V × I.\n\nThese three form a right triangle (just like the impedance triangle):\n S = √(P² + Q²)\n\nPower factor = P / S = cos(θ)`,
        formula: 'P = I² × R = S × cos(θ)     [Watts — does work]\nQ = I² × X = S × sin(θ)     [VAR — does no work]\nS = V × I = √(P² + Q²)      [VA — what the utility supplies]\n\nPF = P/S = cos(θ)\nPF = 1.0 = perfect (resistive only)\nPF = 0.8 = typical induction motor (lagging)'
      },
      {
        type: 'real-world',
        title: '🏭 Real World: Power Factor Correction',
        body: `A large factory runs 200A of current on a 600V system. Power factor is 0.72 lagging (very common with lots of induction motors).\n\nApparent power: S = 600 × 200 = 120 kVA\nTrue power: P = 120 × 0.72 = 86.4 kW\n\nThe utility charges based on the 120 kVA demand (they have to supply that much current), but only 86.4 kW of useful work is being done. The remaining 33.6 kVAR is reactive power wasting conductor capacity.\n\nSolution: install capacitor banks sized to cancel the inductive reactive power (Q). This brings PF closer to 1.0, reducing the apparent current the utility must supply — which reduces your demand charges and line losses.\n\nAs an electrician, you'll install and maintain these power factor correction banks. The capacitors are usually switched in and out automatically based on load.`
      },
      {
        type: 'concept',
        title: '🎯 Resonance: When XL = XC',
        body: `Resonance occurs when inductive and capacitive reactances are equal and opposite — they cancel each other out, leaving only resistance. The results are dramatic:\n\n• Series resonance: impedance drops to minimum (Z = R only), current reaches maximum\n• Parallel resonance: impedance rises to maximum, current from source is minimum\n\nResonant frequency: fr = 1 / (2π√(LC))\n\nThis principle is used intentionally in radio tuners (adjusting C to resonate at a specific station's frequency) and power factor correction banks. Unintentionally, harmonics from VFDs can excite resonance in power factor correction capacitors, causing damaging overvoltages and capacitor failures.`,
        formula: 'Resonant frequency:\nfr = 1 / (2π × √(L × C))\n\nAt resonance: XL = XC, Z = R, PF = 1.0\nSeries resonance: maximum current\nParallel resonance: minimum current from source'
      },
      {
        type: 'quiz',
        title: '🧠 Quick Check',
        questions: [
          { q: 'A series RL circuit has R = 6Ω and XL = 8Ω. What is the impedance?', a: 'Z = √(6² + 8²) = √(36 + 64) = √100 = 10 Ω' },
          { q: 'A motor draws 20A at 240V with a power factor of 0.85. What is the true power?', a: 'S = 240 × 20 = 4800 VA; P = 4800 × 0.85 = 4080 W' },
          { q: 'Why does reactive power (VAR) not appear on your electricity bill?', a: 'Reactive power does no useful work — it just oscillates between source and load. But utilities often charge for high reactive demand because it increases their current supply requirements.' }
        ]
      },
      {
        type: 'protip',
        title: '🛠 Pro Tips',
        tips: [
          'The impedance triangle and power triangle are the SAME shape at the SAME angle. If you know Z, R, and X for the circuit, you know the ratio of P, S, and Q too.',
          'Power factor of 0.8 lagging is the absolute minimum for most industrial facilities before the utility starts charging demand penalties. If you see power factor capacitors in a commercial or industrial panel, their job is to bring PF back above 0.9 or 0.95.',
          'On exam questions involving power: always identify whether the given voltage/current is per-phase or line-to-line in a three-phase system. Three-phase power = 3 × Vphase × Iphase × PF, or equivalently √3 × Vline × Iline × PF.'
        ]
      },
      {
        type: 'objectives',
        title: 'Module 3 Objectives',
        objectives: [
          'Define impedance (Z) as the total opposition to AC current flow, combining resistance and reactance.',
          'Calculate series circuit impedance using the impedance formula: Z = √(R² + X²) where X = XL − XC.',
          'Analyze a series RLC circuit to calculate total impedance, circuit current, and individual component voltage drops.',
          'Calculate parallel circuit impedance using branch currents (IR, IL, IC) and total current IT = √(IR² + (IL − IC)²).',
          'Construct and interpret the impedance triangle, identifying the relationships between R, X, Z, and phase angle θ.',
          'Define true power (P) in watts as the power consumed by resistance and producing real work: P = I²R = V²/R.',
          'Define reactive power (Q) in volt-amperes reactive (VAR) as the power oscillating between source and reactive components: Q = I²X.',
          'Define apparent power (S) in volt-amperes (VA) as the total power supplied by the source: S = V × I.',
          'Construct and interpret the power triangle, applying the Pythagorean relationship: S² = P² + Q².',
          'Define power factor (PF) as the ratio of true power to apparent power: PF = P/S = cos θ.',
          'Classify power factor as leading (capacitive load) or lagging (inductive load) and explain its significance.',
          'Identify the causes of poor power factor in industrial electrical systems (inductive loads: motors, transformers, ballasts).',
          'Describe how power factor correction capacitors improve power factor and reduce reactive current demand.',
          'Calculate the capacitance required for power factor correction given initial and target power factors.',
          'Solve AC circuit problems involving series and parallel combinations of R, L, and C components.'
        ],
        questions: [
          { q: 'A series RLC circuit has R = 30Ω, XL = 60Ω, XC = 20Ω. What is the total impedance?', a: 'X = XL − XC = 60 − 20 = 40Ω. Z = √(R² + X²) = √(30² + 40²) = √(900 + 1600) = √2500 = 50Ω.' },
          { q: 'A circuit draws 10A at 120V with a power factor of 0.8 lagging. Calculate P, Q, and S.', a: 'S = V × I = 120 × 10 = 1200 VA. P = S × PF = 1200 × 0.8 = 960W. Q = √(S² − P²) = √(1200² − 960²) = 720 VAR.' },
          { q: 'What does a lagging power factor mean in terms of current and voltage phase relationship?', a: 'Lagging PF means current lags behind voltage — the load is inductive. The current waveform peaks after the voltage waveform. This increases reactive current and causes the utility to supply more apparent power than the real power consumed.' },
          { q: 'Why do utilities charge industrial customers for poor power factor?', a: 'Poor power factor means the utility must supply more current (more apparent power) to deliver the same real power. More current means larger conductors, more transformer capacity, and more I²R losses in the distribution system — all of which cost money. Industrial customers with PF below 0.85-0.90 typically face demand surcharges.' },
          { q: 'At resonance in a series RLC circuit, what happens to impedance and why?', a: 'At resonance, XL = XC, so they cancel: X = XL − XC = 0. Total impedance Z = √(R² + 0²) = R — the circuit is purely resistive with minimum impedance. Current is at maximum. This is why resonance circuits are used as tuned filters.' }
        ]
      },
      {
        type: 'outcome',
        title: 'Module Desired Outcome',
        outcome: 'The student will analyze AC circuits containing resistors, inductors, and capacitors, and calculate impedance, current, voltage, and power relationships.',
        questions: [
          { q: 'A 120V, 60Hz circuit contains a 40Ω resistor in series with a 0.1H inductor and a 100μF capacitor. Calculate XL, XC, Z, and the current. Is the circuit inductive or capacitive?', a: 'XL = 2π × 60 × 0.1 = 37.7Ω. XC = 1/(2π × 60 × 0.0001) = 26.5Ω. X = XL − XC = 37.7 − 26.5 = 11.2Ω (net inductive). Z = √(40² + 11.2²) = √(1600 + 125.4) = √1725.4 = 41.5Ω. I = V/Z = 120/41.5 = 2.89A. The circuit is inductive (XL > XC).' },
          { q: 'An industrial facility has a total load of 500kW at 0.70 power factor lagging. Calculate the apparent power, reactive power, and the reactive current. Why is this a problem for the utility?', a: 'S = P/PF = 500,000/0.70 = 714.3 kVA. Q = √(S² − P²) = √(714.3² − 500²) = 510.2 kVAR. At 480V 3-phase: IL = S/(√3 × VL) = 714,300/(1.732 × 480) = 859A. Only 500,000/(1.732 × 480) = 601A of that does real work. The utility must size its equipment for 859A, not 601A — the extra 258A is purely reactive current producing no useful work, creating extra losses and requiring larger equipment.' }
        ]
      }
    ]
  },
  {
    id: 'm21',
    title: 'Relays & Contactors',
    icon: '🔌',
    subtitle: 'The Brain and Muscle of Industrial Control',
    color: '#10b981',
    gradient: 'linear-gradient(135deg,rgba(16,185,129,0.12),rgba(5,150,105,0.06))',
    border: 'rgba(16,185,129,0.3)',
    readTime: '13 min read',
    sections: [
      {
        type: 'hook',
        title: '⚡ Small Signal, Big Power',
        body: `Imagine you want to turn on a 100-horsepower motor from across a factory floor. You can't run a wire carrying 150 amps to a little pushbutton at a control station — that would melt the wiring and probably kill the operator.\n\nSo instead, you run a low-voltage, low-current control circuit to a relay or contactor. A tiny 24V signal energizes a coil, which creates a magnetic field, which pulls in a set of contacts, which closes a circuit carrying the full motor current.\n\nThis is the fundamental concept behind all industrial motor control: separate the control circuit from the power circuit. And relays and contactors are what make it possible.`
      },
      {
        type: 'concept',
        title: '🔌 Relay vs. Contactor: Same Idea, Different Scale',
        body: `A relay and a contactor work on exactly the same principle — an electromagnetic coil pulls in an armature to open or close contacts. The difference is scale and purpose:\n\n• Relays: designed for control circuits. Low current (typically < 10A), multiple sets of contacts, used to route signals and interlock circuits. Think of a relay as the logic device.\n\n• Contactors: designed for power circuits. High current (10A to thousands of amps), fewer contact sets (usually 3 main power contacts + a few auxiliary), built for starting and stopping motors and loads. Think of a contactor as the muscle.\n\nContactors have arc suppression features that relays don't — when you interrupt 150A at 600V, there's a tremendous arc. Special materials, magnet blow-out coils, and arc chutes deal with this energy. A relay's contacts would weld together.`
      },
      {
        type: 'concept',
        title: '📐 Contact Types: NO, NC, and Why It Matters',
        body: `Every relay and contactor has contacts in one of two resting states:\n\n• Normally Open (NO): contacts are open when the coil is de-energized. When the coil energizes, they close. This is the most common type for motor starters — you want the motor off by default.\n\n• Normally Closed (NC): contacts are closed when the coil is de-energized. When the coil energizes, they open. Used for safety circuits: if power fails, the NC contact stays closed (safe state) or opens to de-energize a dangerous load.\n\nCritical: "normally" refers to the state with NO power applied. A pushbutton, relay contact, or limit switch is described by its state at rest. This seems obvious but trips up electricians constantly during troubleshooting — a closed NC contact means the coil is NOT energized.`
      },
      {
        type: 'keypoint',
        title: '🔒 Seal-In Contacts: The Self-Latching Trick',
        body: `Here's one of the most important circuits you'll build: the motor starter with seal-in contacts.\n\nProblem: you use a momentary pushbutton (springs back when released) to start a motor. But once you release the button, the control circuit opens and the motor stops. How do you keep the motor running?\n\nSolution: add an auxiliary NO contact from the contactor, wired in parallel with the start button. When you press Start, the contactor energizes. The auxiliary contact (now closed, since the coil is energized) bridges across the start button — creating an alternate current path that holds the coil energized even after you release Start.\n\nPress Stop (an NC pushbutton in series) and the circuit opens — contactor drops out, motor stops, and the now-open auxiliary contact removes the seal-in. Circuit is back to its normal, off state.\n\nThis is called a three-wire control circuit. It's also inherently safe: if power fails, the contactor drops out and won't restart automatically when power returns (unlike a two-wire circuit).`
      },
      {
        type: 'real-world',
        title: '🔀 Interlock Circuits: Preventing Disasters',
        body: `Interlocking is the technique of using contacts to prevent dangerous simultaneous operations. The classic example is a reversing motor starter:\n\nA forward contactor (F) and reverse contactor (R) cannot EVER be energized at the same time — doing so would connect two phases together and short the power supply. So you wire it so each contactor's NC auxiliary contact is in series with the coil of the other.\n\nThis means: if F is energized (its NC contact is now open), the circuit path to R's coil is broken — you physically cannot energize R while F is on. This is electrical interlock.\n\nFor extra safety, add mechanical interlock — a physical lever that prevents both contactors from pulling in simultaneously. Belt-and-suspenders approach.\n\nAs an apprentice, you'll be asked to wire these interlocks. Get them wrong and you risk a phase-to-phase fault, a very unpleasant explosion, and a failed inspection.`
      },
      {
        type: 'concept',
        title: '🌡️ Overload Relays: Protecting the Motor',
        body: `Every motor starter includes an overload relay (OL relay) to protect the motor from overheating. The overload relay monitors current and trips if the current exceeds a threshold for a sustained period.\n\nTwo main types:\n\n• Thermal overload: a bimetallic strip or eutectic alloy that deforms as it heats up (proportional to I² × t). Heats up like the motor does. Trips after a time delay proportional to the overcurrent — brief spikes don't trip it, but sustained overloads do.\n\n• Electronic overload: measures actual current through the motor, calculates thermal model mathematically, trips more accurately and consistently than thermal types. Can also provide phase loss protection and trip history.\n\nThe OL relay's contacts are wired in series with the contactor coil circuit. When the OL trips, it opens its NC contact, which de-energizes the contactor coil, which opens the power contacts, which stops the motor. The motor cannot restart until the OL is manually reset.`,
        formula: 'Overload relay setting range: typically 0.8 × to 1.25 × motor FLA\nCEC requires OL protection for motors: set at no more than 125% of FLA for motors with SF ≥ 1.15 and temperature rise ≤ 40°C'
      },
      {
        type: 'quiz',
        title: '🧠 Quick Check',
        questions: [
          { q: 'What is the purpose of seal-in (holding) contacts in a motor starter?', a: 'To maintain the contactor coil circuit energized after the momentary start pushbutton is released. The NC auxiliary contact wired in parallel with the start button holds the circuit.' },
          { q: 'What happens to an NC contact when its coil is energized?', a: 'It opens. NC = Normally Closed = closed when de-energized. Energizing the coil causes the armature to pull in, opening the NC contact.' },
          { q: 'Why is a reversing starter interlocked?', a: 'To prevent both forward and reverse contactors from energizing simultaneously, which would cause a phase-to-phase short circuit.' }
        ]
      },
      {
        type: 'protip',
        title: '🛠 Pro Tips',
        tips: [
          'When troubleshooting a contactor that chatters or "machine-guns" — check coil voltage first. Low voltage (below ~85% of rated) means the coil can\'t fully pull in the armature. The armature drops out, coil voltage rises, pulls back in, repeat. Also check for a shorted shading ring (in AC contactors).',
          'Always check the "normal" state of contacts before a job: an NC contact with the system off should have continuity. If it doesn\'t, the coil is either still energized, or the contact is damaged.',
          'Three-wire vs. two-wire control: three-wire (momentary pushbutton with seal-in) is safety preferred — loss of power means motor won\'t auto-restart. Two-wire (maintained contact) will restart automatically when power returns. Use two-wire only where that\'s the intended behavior and is safe.'
        ]
      },
      {
        type: 'objectives',
        title: 'Module 21 Objectives',
        objectives: [
          'Describe the operating principle of an electromagnetic relay, identifying the coil, armature, and contact assembly.',
          'Distinguish between a relay and a contactor based on current ratings, contact types, and intended applications.',
          'Define Normally Open (NO) and Normally Closed (NC) contacts and identify their state when the coil is de-energized ("normal" condition).',
          'Identify the standard contact configurations: Form A (NO only), Form B (NC only), and Form C (changeover: NO + NC).',
          'Describe the purpose of seal-in (holding) contacts and draw a three-wire control circuit using seal-in contacts for a motor starter.',
          'Explain the safety advantage of three-wire control (momentary pushbutton with seal-in) versus two-wire control (maintained contact) for motor circuits.',
          'Describe the purpose of electrical interlock circuits and explain how NC auxiliary contacts are used to prevent simultaneous energization of forward and reverse contactors.',
          'Describe the purpose of mechanical interlocks and explain why both electrical and mechanical interlocks are used together.',
          'Draw and explain the operation of a reversing motor starter control circuit including both start/stop control and proper interlock.',
          'Describe the construction and operation of a thermal overload relay, identifying the bimetallic element and its response to sustained overcurrent.',
          'Describe the construction and operation of an electronic overload relay and explain its advantages over the thermal type.',
          'Explain how to set an overload relay based on motor full-load amperes (FLA) and identify the consequences of setting it too high or too low.',
          'Describe the role of auxiliary contacts in relaying status information, interlocking, and control circuit functions.',
          'Identify the key nameplate specifications of a contactor: coil voltage, contact ampere rating (AC3 or AC4 duty), and auxiliary contact count.',
          'Troubleshoot a basic motor control circuit using knowledge of normal contact states, coil energization, and seal-in operation.'
        ],
        questions: [
          { q: 'A relay has 4 contacts: 2 NO and 2 NC. When the coil is energized, what is the state of each contact?', a: 'When the coil energizes: the 2 NO contacts CLOSE, and the 2 NC contacts OPEN. "Normal" refers to the state with no coil power applied.' },
          { q: 'Why does a reversing motor starter require interlocking between the forward and reverse contactors?', a: 'If both F and R contactors energized simultaneously, they would connect two AC phases together, creating a phase-to-phase short circuit — an extremely high fault current that would destroy the contactors and pose a severe safety hazard. Interlocks (electrical and mechanical) prevent this.' },
          { q: 'A motor\'s FLA is 15A. The overload relay has an adjustment range of 10-18A. Where should it be set?', a: 'Per CEC, OL relays are typically set at 100-125% of FLA for standard motors. For 15A FLA, set to 15-18.75A — so the upper end of the range (18A) if the motor has a 1.15 service factor, or closer to 15A for a standard motor. Must not exceed 125% of FLA for motors with 40°C rise and SF ≥ 1.15.' },
          { q: 'What is the difference between three-wire and two-wire motor control, and which is preferred for personnel safety?', a: 'Three-wire: uses momentary pushbuttons with seal-in contact — motor stops if power is lost and must be manually restarted. Two-wire: uses a maintained contact — motor restarts automatically when power returns. Three-wire is preferred for safety: automatic restart after an unexpected power loss can injure personnel near equipment.' },
          { q: 'A contactor chatters repeatedly (buzzing sound while operating). List two possible causes.', a: '1) Coil voltage too low (below ~85% rated) — the magnetic field is too weak to fully seat the armature, so it drops in and out at twice the line frequency. 2) Broken or missing shading ring — the shading ring maintains flux during AC zero-crossings; without it, the armature releases 120 times per second.' }
        ]
      },
      {
        type: 'outcome',
        title: 'Module Desired Outcome',
        outcome: 'The student will describe the function of relays and contactors and demonstrate understanding of their application in industrial motor control circuits.',
        questions: [
          { q: 'You are asked to wire a motor starter with two start/stop stations (one local, one remote), interlocked against a second motor so only one can run at a time. Describe the wiring approach for the interlocks and the multiple stations.', a: 'Multiple stops: wire both STOP buttons (NC) in series with each other and in the coil circuit — any one can shut down the motor. Multiple starts: wire both START buttons (NO) in parallel — any one can start the motor. Seal-in: wire an auxiliary NO contact from this contactor in parallel with the START buttons. Interlock with second motor: wire an NC auxiliary contact from the second motor\'s contactor in series with this motor\'s coil circuit — if the second motor runs, its NC contact opens and prevents this motor from starting.' },
          { q: 'A technician replaces a thermal overload relay\'s heaters with the next larger size because the relay was nuisance-tripping. Explain what is wrong with this approach and what the correct solution is.', a: 'Installing larger heaters raises the overload trip threshold above the motor\'s actual thermal limit. The motor can now draw sustained overcurrent without the OL tripping — it will overheat, degrade insulation, and eventually fail. The correct approach is to measure the actual current and compare to FLA: if the motor is drawing normal current and the OL trips, the heaters are incorrect (too small) for the motor. Replace with heaters matched to the motor\'s FLA. If the motor is drawing high current, find the cause — mechanical overload, low voltage, phase loss, or a failing motor.' }
        ]
      }
    ]
  },
  {
    id: 'm22',
    title: 'Timers & Smart Relays',
    icon: '⏱',
    subtitle: 'Time-Based Control and Programmable Logic',
    color: '#f97316',
    gradient: 'linear-gradient(135deg,rgba(249,115,22,0.12),rgba(245,158,11,0.06))',
    border: 'rgba(249,115,22,0.3)',
    readTime: '12 min read',
    sections: [
      {
        type: 'hook',
        title: '⏰ When "Now" Isn\'t Good Enough',
        body: `Not everything in a control system should happen instantaneously. A conveyor needs to run for 5 seconds before a downstream process starts. A blower should keep running for 2 minutes after an oven shuts off to prevent heat damage. A pump needs a rest period between starts to avoid overheating.\n\nTimers solve all of these problems. They add the dimension of time to control logic, turning simple on/off decisions into time-sequenced operations. And smart relays take this further — they're essentially tiny programmable computers that can replace dozens of timers, counters, and relays with a single compact device.`
      },
      {
        type: 'concept',
        title: '📊 ON-Delay Timer (TON): Wait, Then Act',
        body: `The most common timer type. An ON-delay timer waits a preset time after receiving an input signal before energizing its output.\n\nSequence:\n1. Input signal arrives (coil energizes)\n2. Timing begins\n3. After preset time, output contact closes (timed contact)\n4. If input is removed before timing completes, timer resets — nothing happens\n5. When input is removed after timing, output immediately opens\n\nReal world uses: motor startup delay (allow pressures/temperatures to stabilize before starting), conveyor sequencing (upstream conveyor starts, downstream conveyor delays 3 seconds), HVAC damper control (open damper before starting fan).\n\nInstantaneous contacts: some timers also have an "instantaneous" contact that closes the moment the coil energizes (before timing starts) — useful for starting a different operation while timing proceeds.`,
        formula: 'ON-delay: Input ON → timer counts → output ON after preset time\nInput OFF (anytime) → timer resets → output OFF immediately'
      },
      {
        type: 'concept',
        title: '⏲ OFF-Delay Timer (TOF): Keeps Running After Stop',
        body: `An OFF-delay timer does the opposite: it keeps its output energized for a preset time after the input signal is REMOVED.\n\nSequence:\n1. Input signal arrives → output immediately energizes\n2. Input signal removed → timing begins\n3. After preset time, output de-energizes\n\nReal world uses: cooling fan delay (keep fan running after motor stops to remove heat), exhaust hood (keep running after cooking stops), parking garage lighting (lights stay on for 5 minutes after you leave the area), anti-short-cycle protection on compressors.`,
        formula: 'OFF-delay: Input ON → output immediately ON\nInput OFF → timer counts → output OFF after preset time'
      },
      {
        type: 'concept',
        title: '🔁 Recycling (Repeat Cycle) Timers: Pulse Generators',
        body: `A recycling timer automatically and repeatedly cycles its output on and off at adjustable intervals. Think of it as a built-in pulse generator.\n\nTwo adjustable settings:\n• ON time: how long output stays energized\n• OFF time: how long output stays de-energized\n\nReal world uses: intermittent windshield wiper control, irrigation systems (water for 2 min, pause 30 min), alarm horns (beep-pause-beep), automatic lubrication systems (pump for 10 seconds every 15 minutes).`
      },
      {
        type: 'keypoint',
        title: '💻 Smart Relays: Tiny PLCs',
        body: `A smart relay (also called a programmable logic relay or PLR) is a compact, inexpensive device that combines inputs, outputs, and programmable logic in one unit. Common brands: Siemens LOGO!, Schneider Electric Zelio, Allen-Bradley Pico.\n\nCapabilities in a package the size of a large relay:\n• 8-24 digital inputs\n• 4-16 digital outputs\n• Analog inputs (some models)\n• Built-in clock/calendar\n• Multiple timer functions (ON, OFF, repeat cycle, single-shot)\n• Counter functions\n• Logic gates (AND, OR, NOT, XOR)\n• Simple arithmetic\n• Communication (some models)\n\nA single smart relay can replace a panel stuffed with 10-15 individual relays, timers, and counters — at a fraction of the cost and panel space. They're programmed either through a front panel display or via laptop with free software.`
      },
      {
        type: 'real-world',
        title: '🏭 Ladder Logic: The Language of Control',
        body: `Industrial control programs are written in ladder logic — a visual programming language that looks like a schematic of relay contacts and coils laid out in rungs, like a ladder.\n\nEach rung is a logical statement:\n• Contacts on the left side = conditions (inputs)\n• Coils on the right side = outputs\n• Current "flows" left to right if all contacts are satisfied\n\nA normally open contact in ladder logic = an input that must be TRUE to pass logic.\nA normally closed contact = an input that must be FALSE to pass logic.\n\nLadder logic translates directly from hardwired relay logic — if you understand relay control circuits, you already understand the fundamentals of ladder logic programming. This is why learning relay control is so valuable for the modern electrician: PLCs and smart relays have taken over, but they still speak the language of relays.`
      },
      {
        type: 'quiz',
        title: '🧠 Quick Check',
        questions: [
          { q: 'An ON-delay timer starts timing when the input turns ON. True or False: if the input turns off before timing completes, the output will energize for the remaining delay time.', a: 'FALSE. If the input is removed before the preset time expires, the timer resets and the output never energizes.' },
          { q: 'A blower motor needs to keep running for 3 minutes after an oven shuts off. Which timer type is used?', a: 'OFF-delay timer (TOF). The blower energizes immediately when the oven runs, then stays on for 3 minutes after the oven shuts off.' },
          { q: 'What is the key advantage of a smart relay (PLR) over hardwired relay logic?', a: 'Flexibility and space savings. A single smart relay replaces many individual relays, timers, and counters. The logic is software-defined and can be reprogrammed without rewiring.' }
        ]
      },
      {
        type: 'protip',
        title: '🛠 Pro Tips',
        tips: [
          'When troubleshooting timer circuits, separate the timing function from the contact function. First verify the coil is energizing (voltage across coil terminals). Then verify the timer is actually timing (LED or display indicator). Then check the output contacts.',
          'ON-delay or OFF-delay? Ask yourself: "does the output come ON after a delay, or does it go OFF after a delay?" That question answers it every time.',
          'Smart relays use the IEC61131-3 standard for ladder logic — the same standard as full PLCs. Time you spend learning Siemens LOGO! or Zelio programming translates directly into understanding Allen-Bradley, Siemens S7, and other industrial PLC platforms.'
        ]
      },
      {
        type: 'objectives',
        title: 'Module 22 Objectives',
        objectives: [
          'Define ON-delay (TDOE – Time Delay On Energization) timer operation, describing contact behavior during timing and after the time period elapses.',
          'Define OFF-delay (TDOD – Time Delay On De-energization) timer operation, describing contact behavior and when the timing period begins.',
          'Identify typical industrial applications for ON-delay timers: star-delta motor starting, conveyor sequencing, process heating warm-up, and alarm time delays.',
          'Identify typical industrial applications for OFF-delay timers: motor cooling fan run-on, conveyor coast-down, oil pressure pre-lube, and alarm/fault clearance delays.',
          'Describe the operating principle of pneumatic (dashpot) timers, identifying the bellows, needle valve, and how they produce the timing delay.',
          'Describe the operating principle of electronic timers, explaining how RC circuits or digital clocks generate timing delays.',
          'Identify the advantages of electronic and programmable timers over pneumatic types: greater accuracy, wider range, digital display, and easier adjustment.',
          'Define a smart relay (programmable relay or micro-PLC) and describe its physical structure: inputs, outputs, power supply, and program memory.',
          'Describe the basic structure of ladder logic programming, identifying rungs, contacts (NO and NC), coils, and the left and right power rails.',
          'Explain the correspondence between hardwired relay control circuits and ladder logic diagrams.',
          'Read basic ladder logic diagrams and predict the output state for a given set of input conditions.',
          'Identify timer function blocks in ladder logic: TON (on-delay) and TOF (off-delay), and describe their preset time (PT) and elapsed time (ET) parameters.',
          'Identify counter function blocks in ladder logic: CTU (count-up) and CTD (count-down), and describe their preset value (PV) and current value (CV) parameters.',
          'Describe the IEC 61131-3 standard and identify the five programming languages it defines: LD (ladder), FBD (function block diagram), SFC, ST, and IL.'
        ],
        questions: [
          { q: 'A TON (on-delay) timer is energized. Describe what happens to its output contacts immediately and after the set time.', a: 'When the TON input energizes, NO contacts remain OPEN and NC contacts remain CLOSED — output doesn\'t change yet. After the preset time elapses, the NO contacts CLOSE and NC contacts OPEN. When the input de-energizes, all contacts return to normal state immediately (no delay off).' },
          { q: 'A TOF (off-delay) timer is de-energized. Describe what happens to its output contacts immediately and after the set time.', a: 'When the TOF input de-energizes, the output contacts DO NOT return to normal immediately — timing begins. After the preset time elapses, the NO contacts OPEN and NC contacts CLOSE (returning to normal state).' },
          { q: 'In a star-delta motor starting circuit, what does the timer control?', a: 'The timer controls the transition from star (wye) connection to delta connection. The motor starts in star (reduced voltage), and after the preset time (typically 5-15 seconds, when the motor has accelerated to near full speed), the timer transfers to delta (full voltage). Switching too early causes high inrush; switching too late provides no benefit.' },
          { q: 'In a ladder logic rung, two NO contacts are drawn in series before a coil. What logic does this represent?', a: 'AND logic — BOTH contacts must be closed (TRUE) for the coil to energize. In relay control terms, this means both switches must be ON simultaneously.' },
          { q: 'What is the key advantage of using a smart relay instead of discrete relays and timers for a multi-step sequential process?', a: 'Smart relays can be reprogrammed without rewiring — logic changes are made in software. Discrete relay panels require physical rewiring, addition of new relays, and re-tracing logic every time the process changes. Smart relays also take less panel space, are more reliable (no contact wear for logic functions), and provide built-in timers, counters, and displays.' }
        ]
      },
      {
        type: 'outcome',
        title: 'Module Desired Outcome',
        outcome: 'The student will describe timer types and their application in industrial control, and demonstrate basic understanding of smart relay and programmable logic control.',
        questions: [
          { q: 'A conveyor system requires that: 1) a warning horn sounds for 5 seconds before the conveyor starts, 2) the conveyor runs for its cycle, and 3) after the stop button is pressed, the cooling fan runs for an additional 60 seconds. Describe which timer types you would use for each function.', a: 'Function 1 (pre-start warning): ON-delay timer — when start is pressed, the horn output energizes immediately (NO contact closes), and after 5 seconds the timer\'s timed contact energizes the conveyor. Function 3 (fan run-on): OFF-delay timer — the fan output is energized while the conveyor runs, and when the stop button is pressed, the OFF-delay timer continues powering the fan for 60 seconds before returning to off state.' },
          { q: 'Draw a ladder logic rung (describe it in words) that energizes a pump (Output Y1) when: float switch (Input X1) is activated AND pressure switch (Input X2) is NOT activated, and a stop button (Input X3) has not been pressed (NC contact in circuit).', a: 'Rung: [X1 NO]—[X2 NC]—[X3 NC]—(Y1). Reading left to right: X1 must be CLOSED (float switch activated), X2 must be OPEN/deactivated (NC contact: the pressure switch NC contact must still be passing — meaning high pressure NOT present), X3 must be CLOSED (stop button NC contact: not pressed). All three in series before the Y1 coil. When all three conditions are met, the pump output Y1 energizes.' }
        ]
      }
    ]
  },
  {
    id: 'm23',
    title: 'Pilot & Overcurrent Devices',
    icon: '🛡',
    subtitle: 'The Guardians of Every Circuit',
    color: '#ef4444',
    gradient: 'linear-gradient(135deg,rgba(239,68,68,0.12),rgba(220,38,38,0.06))',
    border: 'rgba(239,68,68,0.3)',
    readTime: '14 min read',
    sections: [
      {
        type: 'hook',
        title: '⚡ Every Circuit Needs Protection',
        body: `Every electrical circuit has a potential failure mode: too much current. Overcurrent destroys insulation, melts conductors, starts fires, and kills people.\n\nThe overcurrent protection device (OCPD) — whether a fuse or circuit breaker — is the last line of defense. It monitors current, and when current exceeds its rating for a sufficient time, it interrupts the circuit.\n\nBut protection isn't the only job in a control system. Someone also has to initiate, stop, and direct the flow of current to the loads. That's the job of pilot devices — the pushbuttons, switches, and sensors that give humans and machines control over electrical systems.`
      },
      {
        type: 'concept',
        title: '🔘 Pilot Devices: Control Without Power',
        body: `A pilot device is a control component that controls a circuit but doesn't carry the main load current. The name comes from "pilot," meaning guide or direct.\n\nKey pilot devices you'll work with:\n\n• Pushbuttons: momentary (springs back) or maintained (stays in place). NO types start things; NC types stop things. Color code: green/black = start, red = stop.\n\n• Selector switches: 2 or 3 position, maintained. For mode selection (Hand/Off/Auto, Local/Remote).\n\n• Limit switches: mechanically actuated by equipment position. Used to detect "door open," "conveyor at end of travel," "cylinder fully extended." Can be NO or NC, maintained or momentary.\n\n• Float switches: actuated by liquid level. Used to control pumps and sump systems.\n\n• Pressure switches: actuated by fluid or air pressure. Compressor control, hydraulic systems.\n\n• Pilot lights: indicate status (motor running, fault condition, power present). Wired in parallel with the load they're indicating.`
      },
      {
        type: 'keypoint',
        title: '🟢 Color Codes and Standards',
        body: `Pilot device colors are standardized by NEMA ICS and the CEC:\n\n• Red: Stop, emergency stop, power off. NC pushbutton.\n• Green or Black: Start, run, power on. NO pushbutton.\n• Yellow: Caution, abnormal condition.\n• Blue: Mandatory action (lockout).\n• White/Grey: no specific function.\n\nPilot lights follow similar conventions:\n• Red = machine running or dangerous condition present\n• Green = safe condition, machine stopped, power available\n• Amber = abnormal condition, attention needed\n\nKnowing color codes lets you read an unfamiliar control panel quickly. A green lit light with a red lit light simultaneously? Something's wrong — those shouldn't both be on if they represent opposite states.`
      },
      {
        type: 'concept',
        title: '⚡ Fuses: Simple, Fast, Sacrificial',
        body: `A fuse is the simplest overcurrent protection device: a piece of calibrated metal that melts at a specific current, breaking the circuit. One-shot device — once blown, it must be replaced.\n\nFuse characteristics that matter:\n\n• Current rating: the continuous current the fuse handles without opening. Size to 100-125% of load.\n\n• Voltage rating: maximum voltage the fuse can safely interrupt. A 250V fuse on a 600V circuit is dangerous — the arc won't extinguish.\n\n• Interrupting rating: the maximum fault current the fuse can safely clear. A fuse rated 10 kAIC on a bus capable of 50 kA fault current WILL explode violently.\n\n• Current-limiting: fast-acting fuses (Class CC, J, RK1, RK5, L) limit the peak let-through current by clearing in less than a half-cycle. This protects equipment from the destructive energy of high fault currents.\n\n• Time-delay (dual-element): have a thermal delay element that ignores brief motor inrush (5-7× FLA) while still protecting against sustained overloads. Essential for motor circuits.`,
        formula: 'Motor circuit fuse sizing (CEC Rule 28-200):\nTime-delay fuses: up to 175% of motor FLA\nNon-time-delay: up to 300% of motor FLA (but must not exceed 600% for short-circuit protection)'
      },
      {
        type: 'concept',
        title: '🔌 Circuit Breakers: Resettable Protection',
        body: `A circuit breaker performs the same overcurrent protection function as a fuse, but mechanically trips rather than melting — it can be reset after a fault is cleared.\n\nThermal-magnetic circuit breaker (most common):\n• Bimetallic strip: provides time-delay overload protection. As overcurrent heats the strip, it bends and trips the mechanism. Simulates thermal damage to the protected conductor.\n• Magnetic (electromagnetic) trip: a solenoid that trips the breaker almost instantaneously on very high fault currents. Protects against short circuits.\n\nElectronic trip breakers (LSIG):\n• Long-time (L): overload protection with inverse time-current curve\n• Short-time (S): short-time delay for selective coordination\n• Instantaneous (I): immediate trip for high-level faults\n• Ground fault (G): ground fault protection at adjustable threshold\n\nGFCI (Ground Fault Circuit Interrupter): detects as little as 5mA of ground fault current and trips in <1/40 second. Protects people from electrocution on 15/20A branch circuits. Required by CEC near water.\n\nGFP (Ground Fault Protection of Equipment): detects ground faults typically in the 150mA-1200mA range. Protects equipment from arcing ground faults on large systems. Required on 1000A+ services per CEC.`
      },
      {
        type: 'real-world',
        title: '🔗 Selective Coordination: The Art of Only Tripping What Needs to Trip',
        body: `In a properly coordinated system, a fault on a branch circuit should trip only the branch circuit breaker — not the feeder breaker, not the main breaker. Otherwise a small fault in one room takes down the whole building.\n\nAchieving coordination means sizing and selecting breakers so each upstream device has a significantly slower (or higher threshold) trip characteristic than the downstream device. Engineers use time-current curves to verify coordination.\n\nFor electricians: never "upsize" a breaker to stop nuisance tripping. If a 20A breaker keeps tripping, the LOAD is drawing more than 20A — fix the load, or investigate the fault. Upsizing the breaker destroys the protection the system was designed to provide.`
      },
      {
        type: 'quiz',
        title: '🧠 Quick Check',
        questions: [
          { q: 'A fuse is rated 600V, 30A, with an interrupting rating of 10 kAIC. The available fault current is 15 kA. Can this fuse be used?', a: 'NO. The interrupting rating (10 kAIC) is less than the available fault current (15 kA). The fuse would explode violently and fail to safely clear the fault.' },
          { q: 'What is the difference between GFCI and GFP?', a: 'GFCI detects very small ground faults (5mA) to protect people. GFP detects larger ground faults (150mA+) to protect equipment from arcing damage. Both interrupt the circuit, but they serve different purposes at different current thresholds.' },
          { q: 'A time-delay fuse for a motor is used instead of a fast-acting fuse. Why?', a: 'Motors draw 5-7× their full-load current during starting. A fast-acting fuse would blow on every motor start. A time-delay fuse rides through brief inrush current while still protecting against sustained overloads and short circuits.' }
        ]
      },
      {
        type: 'protip',
        title: '🛠 Pro Tips',
        tips: [
          'The CEC requires overcurrent protection to be sized based on the conductor ampacity, not the load. If you have a 12 AWG conductor (rated 20A in NMD90), you cannot install a 30A breaker even if the load only draws 15A. The breaker protects the wire, not the load.',
          'Fuse classes use size rejection features to prevent installing the wrong fuse. A Class J fuse physically cannot fit in a Class H fuseholder. Never force a fuse into a holder it wasn\'t designed for, and never bridge a fuse with wire.',
          'When a fuse blows, the fuse is doing its job. Find and fix the fault before replacing the fuse. Putting in a new fuse without clearing the fault means the new fuse will blow too — or worse, if you installed a higher-rated fuse to "fix" the problem, now the conductor is unprotected and it may be the wire that fails next time.'
        ]
      },
      {
        type: 'objectives',
        title: 'Module Objectives',
        objectives: [
          'Define "pilot device" and explain its role in separating the control circuit from the power circuit.',
          'Identify the types of pilot devices: pushbuttons, selector switches, limit switches, float switches, pressure switches, flow switches, proximity switches, and pilot lights.',
          'Describe the difference between normally open (NO) and normally closed (NC) pilot device contacts and their normal state.',
          'Identify NEMA/IEC color coding standards for pushbuttons and pilot lights.',
          'Describe the difference between momentary-contact and maintained-contact pushbuttons and give an application for each.',
          'Identify the electrical and mechanical requirements for emergency stop (E-stop) devices.',
          'Explain why multiple STOP pushbuttons are wired in series and multiple START pushbuttons are wired in parallel.',
          'Identify the sensing principles of automatic pilot devices: limit switches (mechanical), float switches (level), pressure switches (pressure), flow switches (fluid flow), inductive proximity (metallic targets), capacitive proximity (any material), and photoelectric (light beam).',
          'Describe the purpose of pilot lights and identify standard color codes for pilot light indication.',
          'Define overcurrent and identify the two main categories: overload and short circuit.',
          'Describe the construction and operating principle of a fuse and explain what causes it to open.',
          'Identify the difference between non-time-delay and time-delay (dual-element) fuses.',
          'Describe the purpose of the thermal element and the fast-acting element in a dual-element fuse.',
          'Define "current-limiting fuse" and describe how it reduces I²t energy let-through during a fault.',
          'Identify the common fuse classes (H, CC, J, RK1, RK5, T, L) and explain the purpose of physical rejection features.',
          'Explain why a fuse must be rated at or above the circuit voltage and describe the consequence of installing an under-rated fuse.',
          'Define interrupting rating (AIC) and explain why it must exceed the available fault current at the installation point.',
          'Describe the construction and operation of a thermal-magnetic circuit breaker, identifying the role of both the thermal and magnetic trip elements.',
          'Explain the inverse-time trip characteristic and describe why it is suitable for protecting conductors.',
          'Define the instantaneous trip function and identify the fault conditions that activate it.',
          'Define "trip-free" design and explain why it is an important safety feature.',
          'Define GFCI, state the trip current threshold (5mA), and identify locations where the CEC requires GFCI protection.',
          'Define GFP (Ground Fault Protection of Equipment), state its typical trip range, and explain how it differs from GFCI in purpose and threshold.',
          'State the CEC requirements for sizing motor branch circuit overcurrent protection and motor overload protection.',
          'Define selective coordination and explain its importance in minimizing system disruption during a fault.',
          'Explain why upsizing an overcurrent device to prevent nuisance tripping is dangerous and what the correct approach is.',
          'Identify the CEC requirement for a motor disconnect and describe its location and function.'
        ],
        questions: [
          { q: 'What is the key function of a pilot device in a motor control circuit?', a: 'A pilot device controls the operation of a power circuit without carrying the full load current — it operates in the lower-voltage control circuit and signals contactors or starters to energize or de-energize the motor.' },
          { q: 'Stop buttons are wired in series and start buttons in parallel. Why?', a: 'Series stops: any one station can break the circuit and stop the motor (fail-safe). Parallel starts: any one station can energize the coil to start the motor (convenience). This arrangement is universal in motor control.' },
          { q: 'What is the difference between a Class J and a Class H fuse?', a: 'Class J is current-limiting (clears in <½ cycle), rated 200,000A AIC, with rejection features. Class H (glass tube) is NOT current-limiting, typically rated only 10,000A AIC, and can be replaced with any cylindrical fuse. Class J provides vastly superior fault protection.' },
          { q: 'Why must a fuse\'s voltage rating meet or exceed the circuit voltage?', a: 'After the fuse element melts, an arc forms across the gap. The fuse must be able to extinguish this arc. A fuse rated below circuit voltage cannot reliably extinguish the arc — the housing may rupture and the fault current continues to flow.' },
          { q: 'A GFP device trips at 300mA. A GFCI trips at 5mA. Why are both used instead of just GFCI everywhere?', a: 'GFCI at 5mA would nuisance-trip on the normal leakage currents of large commercial/industrial systems. GFP at 150mA–1200mA detects only genuine arcing ground faults on large conductors without nuisance tripping, while GFCI is used on branch circuits for personnel protection.' }
        ]
      },
      {
        type: 'outcome',
        title: 'Module Desired Outcome',
        outcome: 'The student will identify pilot devices and overcurrent protection devices used in industrial motor control circuits, and correctly size overcurrent protection for conductors and motors.',
        questions: [
          { q: 'A motor control panel has a red mushroom-head button, a green momentary button, an amber selector switch, and a green pilot light. Identify each device\'s likely function.', a: 'Red mushroom-head = Emergency Stop (maintained, hardwired). Green momentary = Start pushbutton (NO, momentary). Amber selector = Mode/caution function (e.g., Hand-Off-Auto or speed select). Green pilot light = Motor running or power available indicator.' },
          { q: 'A 30A, 600V, Class H fuse is installed in a panel where the available fault current is 25,000A. The fuse is rated 10,000A interrupting capacity. Describe the risk and the correct solution.', a: 'The fuse\'s interrupting rating (10 kAIC) is far below the available fault current (25 kA). Under a short circuit, the fuse will rupture violently and fail to clear the fault. The correct solution is to replace it with a fuse rated for at least 25 kAIC — such as Class J (200 kAIC) or Class RK1 (200 kAIC).' },
          { q: 'Describe a scenario where a time-delay fuse is required instead of a non-time-delay fuse, and explain the consequence of using the wrong type.', a: 'A motor circuit drawing 20A FLA with 5-7× starting inrush (100-140A for ~3 seconds). A non-time-delay fuse sized for 20A continuous current would blow on every start due to the inrush. It must be oversized to ~300% (60A), which severely reduces short-circuit protection. A time-delay fuse sized at 125-175% of FLA (25-35A) rides through the inrush while providing superior fault protection.' },
          { q: 'A 20A circuit breaker trips repeatedly on a circuit feeding an electric heater. The electrician replaces it with a 30A breaker to "fix" the problem. Explain what is wrong with this and what the correct approach should be.', a: 'Wrong approach: the 12 AWG wiring on a typical 20A circuit is only rated for 20A. A 30A breaker will allow 30A to flow through conductors rated for 20A, causing overheating, insulation breakdown, and potentially a fire. Correct approach: measure the actual current draw of the heater. If it exceeds 20A, the heater is oversized for the circuit — either replace the heater or upgrade the circuit (wiring and breaker together) to the appropriate ampacity.' }
        ]
      }
    ]
  }
  ,{
    id: 'm24',
    title: 'Drawing & Diagram Conversion',
    icon: '📋',
    subtitle: 'Reading the Language Every Electrician Must Speak',
    color: '#ec4899',
    gradient: 'linear-gradient(135deg,rgba(236,72,153,0.12),rgba(139,92,246,0.06))',
    border: 'rgba(236,72,153,0.3)',
    readTime: '13 min read',
    sections: [
      {
        type: 'hook',
        title: '⚡ The Drawing Is the Circuit',
        body: `Before a single wire is pulled, before a single conduit is bent, the electrician reads the drawing.\n\nThe drawing tells you what to build. And every drawing speaks a specific language — a language of symbols, conventions, and diagram types that took over a century to standardize across the entire electrical industry.\n\nMiss one wire on the wiring diagram? The light doesn't work. Misread a contact symbol on the schematic? The motor won't start — or worse, won't stop. Mistake a 14/2 cable run for a 14/3 on a blueprint? You'll be back in the wall.\n\nThis module is about reading that language fluently.`
      },
      {
        type: 'story',
        title: '🏗 Three Ways to Describe the Same Circuit',
        body: `Imagine you need to explain a simple switch-light circuit to three different people.\n\nTo a project manager, you draw boxes: [Panel] → [Switch] → [Light]. Simple. Clean. Shows the logic without any messy details.\n\nTo the apprentice who's pulling wire, you draw a wiring diagram: which wire goes to which terminal, what colour is which, where the wire nut is, and which cable carries how many conductors.\n\nTo the troubleshooter who shows up at 2 AM when the light doesn't work, you hand them a schematic: L1 on the left rail, N on the right, SW1 contact in the rung, lamp symbol at the end. They trace continuity from left to right in 10 seconds and find the problem.\n\nSame circuit. Three completely different drawings. Each one is exactly right for its purpose — and you need to be able to work with all three.`
      },
      {
        type: 'concept',
        title: '📦 Block Diagrams: The Big Picture',
        body: `A block diagram is the simplest of the three. It uses labeled rectangles (blocks) connected by arrows to show the functional flow of a circuit.\n\nEach block represents one function:\n• [Power Source] → [Switch] → [Load]\n• [Control Source] → [Pushbutton] → [Relay Coil]\n• [L1/L2/L3] → [Main Contacts] → [OL Heaters] → [Motor]\n\nBlock diagrams tell you:\n✓ What components are in the circuit\n✓ What order they appear in\n✓ Which is the control path and which is the power path\n\nBlock diagrams do NOT tell you:\n✗ Wire colours\n✗ Cable types or sizes\n✗ Physical routing\n✗ Terminal connections\n✗ Whether contacts are NO or NC\n\nUse block diagrams for planning, documentation, and quick communication. They are often the first step in circuit design.`
      },
      {
        type: 'keypoint',
        title: '🧵 Wiring Diagrams: What the Apprentice Uses',
        body: `A wiring diagram shows how the circuit is actually built — wire by wire, terminal by terminal.\n\nEvery conductor is shown with its correct colour. Every splice shows a wire nut. Every device shows all its terminals and what connects where. The physical layout of boxes often approximates the actual installation.\n\nCanadian conductor colour code:\n• Black = hot (ungrounded) conductor\n• White = neutral (grounded) conductor\n• Red = second hot in a multi-wire circuit (14/3 or 12/3 cable)\n• Green or bare = equipment grounding conductor (EGC)\n\nSwitch loops (switch legs): In older wiring, the cable from a light box to a switch box carries the hot in the black wire and returns the switched hot in the white wire. The white wire must be re-identified with black tape or paint at both ends — it is acting as a hot conductor, not a neutral.\n\nCounting conductors: each wire in a cable counts. 14/2 has 2 insulated conductors (black + white) plus a bare EGC. 14/3 has 3 insulated conductors (black + red + white) plus a bare EGC. The number after the slash tells you how many insulated conductors.`
      },
      {
        type: 'concept',
        title: '🪜 Schematic (Ladder) Diagrams: The Troubleshooter\'s Map',
        body: `The schematic diagram is drawn in ladder format and is the universal language of motor control troubleshooting.\n\nStructure:\n• Two vertical rails: L1 (hot, left) and N/L2 (neutral or second hot, right)\n• Horizontal rungs connect the two rails\n• Each rung is a complete circuit path from L1 through contacts to a load at N/L2\n\nContact symbols:\n• NO contact: two short vertical lines (open gap) — must close for current to flow\n• NC contact: two short vertical lines with a diagonal slash — must NOT open for current to flow\n\nOutput symbols:\n• Coil: letter in parentheses or a circle — (M), (CR), (T)\n• Lamp: circle with X inside\n• Motor: circle with M\n\nReading rule: trace from L1, through each contact in series, to the output at N/L2. If ALL series contacts are closed, the output energizes. Contacts in parallel = OR logic (either one provides a path).\n\nThe most important convention: CONTACTS are on the LEFT side of the rung. OUTPUTS (coils, loads) are on the RIGHT side. Always.`,
        formula: 'Series contacts: ALL must be closed (AND logic)\nParallel contacts: ANY ONE can close (OR logic)\nA coil energizes when current reaches it from L1 to N/L2'
      },
      {
        type: 'keypoint',
        title: '🔢 Counting Wires — The Core Skill',
        body: `When you look at a block diagram and need to know what cable to buy, you count the conductors required between each pair of locations.\n\nBasic switch-light:\n• Panel → Switch box: 2 conductors (hot + neutral) → 14/2\n• Switch box → Light box: 2 conductors (switched hot + neutral) → 14/2\n\n3-way switch circuit:\n• Panel → SW1 box: 2 conductors → 14/2\n• SW1 box → SW2 box: 3 conductors (traveler A + traveler B + neutral) → 14/3\n• SW2 box → Light box: 2 conductors → 14/2\n\n3-wire motor control push button station:\n• 3 conductors to the button station (control hot, junction point, neutral return)\n\nMotor power circuit:\n• 3 conductors from starter to motor (T1, T2, T3)\n\nOn blueprints, slash marks on a circuit line tell you the same thing:\n// = 2 conductors (14/2)\n/// = 3 conductors (14/3)\n//// = 4 conductors\n\nA home run arrow on a floor plan shows which panel the circuit returns to.`
      },
      {
        type: 'concept',
        title: '🔄 Converting Between Diagram Types',
        body: `Block → Wiring Diagram:\n1. Identify each block and select the physical device (single-pole switch, relay, motor)\n2. Draw each device's enclosure with all terminals\n3. Connect terminals with conductors using correct colour codes\n4. Show all wire nuts for splices\n5. Label cable types (14/2 NMD90, etc.)\n\nWiring → Schematic:\n1. Identify all loads (coils, motors, lamps) — these become your output symbols on the right rail\n2. Identify all contacts and switches — these become contact symbols on the left side of rungs\n3. Trace current paths in the wiring diagram → replicate as rungs\n4. Series connections in wiring become contacts in series in the rung\n5. Parallel connections become contacts in parallel\n6. Draw dashed lines connecting a coil symbol to all contacts operated by that coil\n\nSchematic → Wiring:\n1. Identify each rung and trace what it energizes\n2. For each component, draw its physical enclosure\n3. Connect terminals per the schematic, adding correct wire colours\n4. Combine circuits sharing the same box into one drawing\n\nThis back-and-forth conversion is what happens every time an electrician plans and then builds a control circuit.`
      },
      {
        type: 'real-world',
        title: '🛠 The 3-Wire Control Circuit — Reading the Ladder',
        body: `The 3-wire motor starter is the most common control circuit in industrial electrical work, and you need to read it cold.\n\nControl rung (trace from left to right):\nL1 → [OL NC contact] → [Stop NC] → junction point → [Start NO] → [M coil] → N/L2\n                                              ↕ (parallel)\n                                         [M aux NO seal-in]\n\nHow to read it:\n• OL NC: if the overload trips, this contact opens, killing the coil — motor stops\n• Stop NC: pressing Stop opens this contact — motor stops\n• Junction: current can reach the coil through either the Start NO or the M seal-in\n• Start NO: momentarily closes when Start is pressed — energizes M coil\n• M seal-in: closes when M energizes — holds the circuit after Start is released\n• M coil: energizes to close all M contacts\n\nPower rungs (3-phase):\nL1 → [M contact] → [OL heater 1] → T1 → Motor\nL2 → [M contact] → [OL heater 2] → T2 → Motor\nL3 → [M contact] → [OL heater 3] → T3 → Motor\n\nThe dashed line from the M coil to all M contacts shows: when M coil energizes, ALL M contacts change state simultaneously.`
      },
      {
        type: 'quiz',
        title: '🧠 Quick Check',
        questions: [
          { q: 'A block diagram shows 3 slash marks on the cable run between two switch boxes. What cable type is needed?', a: '14/3 NMD90 — 3 slash marks = 3 conductors. The circuit is a 3-way switch and the two traveler wires plus neutral must run in the same cable between the two switch locations.' },
          { q: 'In a ladder diagram, where are contacts placed relative to the coil?', a: 'Contacts (inputs/conditions) are always on the LEFT side of the rung. Coils and loads (outputs) are always on the RIGHT side, closest to the neutral rail. Current flows left to right through closed contacts to energize the output.' },
          { q: 'What does a diagonal line through a contact symbol on a schematic mean?', a: 'It is a Normally Closed (NC) contact — the contacts are CLOSED when no power is applied to the coil. They OPEN when the coil is energized. NC contacts are used for stop buttons and overload contacts.' }
        ]
      },
      {
        type: 'protip',
        title: '🛠 Pro Tips',
        tips: [
          'When counting conductors on a block diagram, draw a line between each pair of adjacent boxes and ask: "How many electrical connections must cross this line?" That number is your conductor count. Each connection needs its own conductor.',
          'The white wire in a switch loop MUST be re-identified as a hot conductor — typically with a wrap of black electrical tape at both ends. If you see a white wire at a single-pole switch terminal (not at a wire nut), it is a switch leg return and it should be marked. Leaving it white is a code violation and creates a hazard for the next person who works there.',
          'When troubleshooting from a ladder diagram: cover the right side with your finger, look at only the contacts in the rung, and ask "Can current get through here right now?" If yes, the coil should be energized. If the coil is NOT energized, you found the rung. Now test each contact in that rung until you find the one that won\'t close.'
        ]
      },
      {
        type: 'objectives',
        title: 'Module Objectives',
        objectives: [
          'Define the three types of electrical diagrams: block diagram, wiring diagram, and schematic (ladder) diagram.',
          'State the purpose of each diagram type and identify which is used for planning, which for wiring, and which for troubleshooting.',
          'Read a block diagram and identify the logical sequence of components in a circuit.',
          'Determine the number of conductors required in each cable run by analyzing a block diagram.',
          'Identify the Canadian conductor colour code: black (hot), white (neutral), red (second hot), green/bare (EGC).',
          'Explain the purpose of re-identifying a white conductor in a switch loop and describe how it is done.',
          'Describe the difference between 14/2 and 14/3 NMD90 cable and explain when each is required.',
          'Identify the structural elements of a ladder (schematic) diagram: L1 rail, N/L2 rail, rungs, contacts, and coils.',
          'Distinguish between NO (normally open) and NC (normally closed) contact symbols on a schematic.',
          'State the rule for placing contacts and loads on a ladder rung: contacts on the left, outputs on the right.',
          'Trace a circuit path through a ladder rung and determine whether an output is energized given a set of contact states.',
          'Identify the purpose of each element in a 3-wire motor control schematic: Stop NC, Start NO, M seal-in, M coil, OL NC contacts.',
          'Explain how the seal-in (M auxiliary) contact allows the motor to run after the Start button is released.',
          'Explain how the Stop NC contact and OL NC contact each stop the motor.',
          'Convert a simple block diagram to a wiring diagram by adding conductor colours, cable types, and terminal connections.',
          'Convert a wiring diagram to a schematic by extracting control rungs and power rungs in ladder format.',
          'Read slash marks on a blueprint floor plan circuit line and determine the corresponding cable type.',
          'Identify the schematic symbols for: NO contact, NC contact, relay/contactor coil, lamp, motor, fuse, push button NO/NC.'
        ],
        questions: [
          { q: 'Why does a 3-way switch circuit require 14/3 cable between the two switches, while 14/2 is used for the rest of the circuit?', a: 'Between the two 3-way switches, three conductors are required: traveler A (black), traveler B (red), and neutral (white). 14/3 cable carries these three conductors plus the bare EGC. The source-to-SW1 and SW2-to-light runs only need 2 conductors each (hot + neutral or switched hot + neutral), so 14/2 is sufficient.' },
          { q: 'In a 3-wire motor control circuit, what would happen if the M seal-in contact failed to close after the Start button was pressed?', a: 'The motor would run only while the Start button is held down. The instant the Start button is released, the control circuit would open (since the seal-in path was never established) and the coil would de-energize, stopping the motor. The seal-in contact is what provides "memory" to keep the motor running after momentary Start is released.' },
          { q: 'On a schematic, you see a contact symbol with a diagonal slash near the Stop pushbutton. Is this contact normally open or normally closed? What does pressing Stop do to it?', a: 'The diagonal slash indicates an NC (normally closed) contact. In its normal state (with no one pressing Stop), this contact is CLOSED, allowing current to flow through the control rung to the coil. Pressing Stop opens this NC contact, breaking the control circuit, de-energizing the coil, and stopping the motor.' }
        ]
      },
      {
        type: 'outcome',
        title: 'Module Desired Outcome',
        outcome: 'The student will read, interpret, and convert between block diagrams, wiring diagrams, and schematic (ladder) diagrams for residential and motor control circuits, and will correctly count conductors from diagram information.',
        questions: [
          { q: 'You are given a block diagram: [Panel] → [3-Way SW1] → [3-Way SW2] → [Light Fixture]. List the three cable runs required, the cable type for each, and the conductor count for each run.', a: 'Run 1: Panel to SW1 box — 14/2 NMD90 — 2 conductors (black hot, white neutral). Run 2: SW1 box to SW2 box — 14/3 NMD90 — 3 conductors (black traveler, red traveler, white neutral). Run 3: SW2 box to Light box — 14/2 NMD90 — 2 conductors (black switched hot, white neutral). Total: 3 cable runs, 7 conductors (plus EGCs in each cable).' },
          { q: 'Convert the following description to a ladder schematic rung: "A relay coil (CR1) is controlled by a normally open pushbutton (PB1). A normally closed limit switch (LS1) is in series before the pushbutton. A CR1 auxiliary contact is in parallel with PB1."', a: 'L1 rail → [LS1 NC contact] → junction → [PB1 NO contact] → [CR1 coil] → N rail. In parallel with PB1: [CR1 NO auxiliary contact] connected between the junction and the point after PB1. The NC slash on LS1 and NO gap on PB1 and CR1 aux must be correctly drawn.' },
          { q: 'On a wiring diagram you see a white wire connected to a single-pole switch terminal. Is this correct? What must be done?', a: 'This is a switch loop — the white conductor is returning the switched hot from the switch back to the light box. It is being used as an ungrounded (hot) conductor, not a neutral. The CEC requires the white wire to be re-identified at both ends (at the switch terminal and at the splice in the light box) with black electrical tape or black paint to indicate it is being used as a hot conductor. Leaving it white is a violation and creates a hazard.' }
        ]
      }
    ]
  }
];

const Lessons = {
  activeLesson: null,

  render(state) {
    if (!state) return;
    const container = document.getElementById('lessonsContent');
    if (!container) return;

    if (this.activeLesson) {
      this._renderLesson(this.activeLesson, container);
    } else {
      this._renderIndex(container, state);
    }
  },

  _renderIndex(container, state) {
    container.innerHTML = `
      <div style="padding:24px 0 8px;">
        <h1 style="font-size:2rem;margin-bottom:6px;">&#x1F4DA; Lessons</h1>
        <p style="color:var(--text-secondary);font-size:1rem;max-width:600px;">Deep-dive lessons for every available module — real explanations, real-world examples, and the kind of context that makes everything click.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px;margin-top:24px;">
        ${LESSONS_CONTENT.map(lesson => `
          <div onclick="Lessons._open('${lesson.id}')" style="cursor:pointer;background:${lesson.gradient};border:1px solid ${lesson.border};border-radius:16px;padding:24px;transition:transform 0.15s,box-shadow 0.15s;position:relative;overflow:hidden;"
            onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 32px rgba(0,0,0,0.3)'"
            onmouseout="this.style.transform='';this.style.boxShadow=''">
            <div style="font-size:2.5rem;margin-bottom:10px;">${lesson.icon}</div>
            <h2 style="font-size:1.15rem;margin:0 0 4px;color:${lesson.color};">${lesson.title}</h2>
            <p style="color:var(--text-secondary);font-size:0.85rem;margin:0 0 16px;line-height:1.4;">${lesson.subtitle}</p>
            <div style="display:flex;align-items:center;justify-content:space-between;">
              <span style="font-size:0.78rem;color:var(--text-muted);">&#x1F4D6; ${lesson.sections.length} sections &nbsp;&bull;&nbsp; ${lesson.readTime}</span>
              <span style="font-size:0.8rem;font-weight:600;color:${lesson.color};">Start &#x2192;</span>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  },

  _open(lessonId) {
    this.activeLesson = lessonId;
    const container = document.getElementById('lessonsContent');
    if (container) this._renderLesson(lessonId, container);
    window.scrollTo(0, 0);
  },

  _back() {
    this.activeLesson = null;
    const container = document.getElementById('lessonsContent');
    const state = Storage.get();
    if (container && state) this._renderIndex(container, state);
    window.scrollTo(0, 0);
  },

  _renderLesson(lessonId, container) {
    const lesson = LESSONS_CONTENT.find(l => l.id === lessonId);
    if (!lesson) { this.activeLesson = null; return; }

    const sectionHtml = lesson.sections.map(s => this._renderSection(s, lesson.color)).join('');

    container.innerHTML = `
      <div style="padding:16px 0;">
        <button onclick="Lessons._back()" style="background:none;border:1px solid var(--border);color:var(--text-secondary);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:0.85rem;margin-bottom:20px;display:flex;align-items:center;gap:6px;">
          &#8592; All Lessons
        </button>
        <div style="background:${lesson.gradient};border:1px solid ${lesson.border};border-radius:16px;padding:32px;margin-bottom:28px;">
          <div style="font-size:3rem;margin-bottom:12px;">${lesson.icon}</div>
          <h1 style="font-size:1.9rem;margin:0 0 6px;color:${lesson.color};">${lesson.title}</h1>
          <p style="color:var(--text-secondary);font-size:1rem;margin:0;font-style:italic;">${lesson.subtitle}</p>
          <div style="margin-top:14px;font-size:0.82rem;color:var(--text-muted);">&#x1F4D6; ${lesson.sections.length} sections &nbsp;&bull;&nbsp; ${lesson.readTime}</div>
        </div>
        ${sectionHtml}
        <div style="text-align:center;padding:32px 0 16px;">
          <button onclick="Lessons._back()" style="background:${lesson.color};color:#000;font-weight:700;border:none;padding:14px 32px;border-radius:10px;cursor:pointer;font-size:1rem;">
            &#x2190; Back to Lessons
          </button>
        </div>
      </div>
    `;
  },

  _renderSection(s, accentColor) {
    // Special full-width renderers for objectives and outcome
    if (s.type === 'objectives') {
      const objList = s.objectives.map((o, i) =>
        `<div style="display:flex;gap:10px;padding:10px 12px;background:rgba(255,255,255,0.03);border-radius:6px;margin-bottom:6px;align-items:flex-start;">
          <span style="flex-shrink:0;background:${accentColor};color:#000;font-weight:700;font-size:0.72rem;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;">${i+1}</span>
          <span style="font-size:0.88rem;line-height:1.55;color:var(--text-secondary);">${o}</span>
        </div>`
      ).join('');
      const qHtml = s.questions ? '<div style="margin-top:20px;border-top:1px solid var(--border);padding-top:16px;"><div style="font-size:0.8rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">Objective-Based Questions</div>' +
        s.questions.map((qobj, i) => `
          <div style="background:rgba(0,0,0,0.15);border-radius:10px;padding:14px;margin-bottom:10px;">
            <div style="font-weight:600;margin-bottom:6px;font-size:0.9rem;">Q${i+1}: ${qobj.q}</div>
            <details style="cursor:pointer;">
              <summary style="font-size:0.82rem;color:${accentColor};font-weight:600;">Reveal Answer</summary>
              <div style="margin-top:8px;padding:10px;background:rgba(16,185,129,0.1);border-radius:6px;font-size:0.85rem;line-height:1.5;color:#a7f3d0;">${qobj.a}</div>
            </details>
          </div>`).join('') + '</div>' : '';
      return `
        <div style="background:rgba(255,255,255,0.02);border:2px solid ${accentColor}33;border-radius:14px;padding:24px;margin-bottom:18px;">
          <h3 style="font-size:1.1rem;margin:0 0 4px;display:flex;align-items:center;gap:8px;color:${accentColor};">&#x1F4CB; ${s.title}</h3>
          <p style="font-size:0.78rem;color:var(--text-muted);margin:0 0 16px;font-style:italic;">Knowledge objectives only — hands-on demonstration objectives are excluded.</p>
          ${objList}${qHtml}
        </div>`;
    }

    if (s.type === 'outcome') {
      const qHtml = s.questions ? s.questions.map((qobj, i) => `
        <div style="background:rgba(0,0,0,0.2);border-radius:10px;padding:14px;margin-bottom:10px;">
          <div style="font-weight:600;margin-bottom:6px;font-size:0.9rem;">Scenario ${i+1}: ${qobj.q}</div>
          <details style="cursor:pointer;">
            <summary style="font-size:0.82rem;color:${accentColor};font-weight:600;">Reveal Answer</summary>
            <div style="margin-top:8px;padding:10px;background:rgba(16,185,129,0.1);border-radius:6px;font-size:0.85rem;line-height:1.5;color:#a7f3d0;">${qobj.a}</div>
          </details>
        </div>`).join('') : '';
      return `
        <div style="background:linear-gradient(135deg,${accentColor}15,${accentColor}05);border:2px solid ${accentColor};border-radius:14px;padding:28px;margin-bottom:18px;">
          <h3 style="font-size:1.15rem;margin:0 0 12px;display:flex;align-items:center;gap:8px;color:${accentColor};">&#x1F3AF; ${s.title}</h3>
          <div style="background:rgba(0,0,0,0.25);border-radius:10px;padding:16px;margin-bottom:20px;">
            <p style="font-size:0.95rem;font-style:italic;color:var(--text-primary);margin:0;line-height:1.65;">"${s.outcome}"</p>
          </div>
          <div style="font-size:0.8rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">Outcome Assessment Scenarios</div>
          ${qHtml}
        </div>`;
    }

    const typeStyles = {
      hook:       { bg: 'rgba(245,158,11,0.07)', border: 'rgba(245,158,11,0.25)', icon: '' },
      story:      { bg: 'rgba(99,102,241,0.06)', border: 'rgba(99,102,241,0.2)', icon: '' },
      concept:    { bg: 'var(--bg-card)',          border: 'var(--border)',           icon: '' },
      keypoint:   { bg: 'rgba(16,185,129,0.07)',  border: 'rgba(16,185,129,0.25)',   icon: '' },
      analogy:    { bg: 'rgba(6,182,212,0.06)',   border: 'rgba(6,182,212,0.2)',     icon: '' },
      real_world: { bg: 'rgba(249,115,22,0.06)',  border: 'rgba(249,115,22,0.2)',    icon: '' },
      'real-world': { bg: 'rgba(249,115,22,0.06)', border: 'rgba(249,115,22,0.2)',   icon: '' },
      quiz:       { bg: 'rgba(139,92,246,0.06)',  border: 'rgba(139,92,246,0.25)',   icon: '' },
      protip:     { bg: 'rgba(34,197,94,0.06)',   border: 'rgba(34,197,94,0.25)',    icon: '' },
    };
    const style = typeStyles[s.type] || typeStyles.concept;

    let inner = '';

    if (s.body) {
      const paragraphs = s.body.split('\n\n').map(p => {
        const lines = p.split('\n');
        if (lines.length > 1 && lines.some(l => l.startsWith('•'))) {
          const listItems = lines.filter(l => l.startsWith('•')).map(l => '<li style="margin-bottom:5px;">' + l.slice(1).trim() + '</li>').join('');
          const pre = lines.filter(l => !l.startsWith('•')).join(' ').trim();
          return (pre ? '<p style="margin:0 0 8px;">' + pre + '</p>' : '') + '<ul style="margin:0 0 12px;padding-left:20px;">' + listItems + '</ul>';
        }
        return '<p style="margin:0 0 12px;line-height:1.7;color:var(--text-primary);">' + p.replace(/\n/g, '<br>') + '</p>';
      }).join('');
      inner += paragraphs;
    }

    if (s.formula) {
      inner += `<pre style="background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:14px 16px;font-family:monospace;font-size:0.85rem;color:#e2e8f0;white-space:pre-wrap;margin:12px 0 0;">${s.formula}</pre>`;
    }

    if (s.questions) {
      inner += '<div style="display:flex;flex-direction:column;gap:12px;margin-top:8px;">';
      s.questions.forEach((qobj, i) => {
        inner += `
          <div style="background:rgba(0,0,0,0.15);border-radius:10px;padding:14px;">
            <div style="font-weight:600;margin-bottom:6px;font-size:0.9rem;">Q${i+1}: ${qobj.q}</div>
            <details style="cursor:pointer;">
              <summary style="font-size:0.82rem;color:${accentColor};font-weight:600;">Reveal Answer</summary>
              <div style="margin-top:8px;padding:10px;background:rgba(16,185,129,0.1);border-radius:6px;font-size:0.85rem;line-height:1.5;color:#a7f3d0;">${qobj.a}</div>
            </details>
          </div>`;
      });
      inner += '</div>';
    }

    if (s.tips) {
      inner += '<div style="display:flex;flex-direction:column;gap:10px;margin-top:8px;">';
      s.tips.forEach(tip => {
        inner += `<div style="display:flex;gap:10px;align-items:flex-start;"><span style="font-size:1.1rem;flex-shrink:0;">&#x2705;</span><span style="font-size:0.88rem;line-height:1.6;color:var(--text-secondary);">${tip}</span></div>`;
      });
      inner += '</div>';
    }

    return `
      <div style="background:${style.bg};border:1px solid ${style.border};border-radius:14px;padding:24px;margin-bottom:18px;">
        <h3 style="font-size:1.05rem;margin:0 0 14px;display:flex;align-items:center;gap:8px;">${s.title}</h3>
        ${inner}
      </div>`;
  }
};

// ===== SETTINGS MODULE =====
const Settings = {
  render(state) {
    if (!state) return;
    const container = document.getElementById('settingsContent');
    const initials = (state.user.name || '?').split(' ').map(w => w[0]).join('').toUpperCase().substring(0,2);
    const memberDays = Math.floor((Date.now() - state.user.signupDate) / 86400000);
    const fcReviewed = Object.values(state.flashcards || {}).reduce((s,c) => s + (c.correct||0) + (c.incorrect||0), 0);
    const examsTaken = (state.exams.attempts || []).length;
    const sub = state.user.subscription || {};
    const planName = sub.plan === 'elite_group' ? 'Elite Group' : sub.plan === 'elite' ? 'Elite' : sub.plan === 'pro' ? 'Pro' : 'Free';

    container.innerHTML = `
      <div style="max-width:680px;margin:0 auto;">
        <!-- Profile Header -->
        <div style="display:flex;align-items:center;gap:20px;margin-bottom:32px;padding:28px;background:linear-gradient(135deg,var(--bg-card),rgba(245,158,11,0.06));border:1px solid var(--border);border-radius:var(--radius-lg);">
          <div style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,var(--accent),#d97706);display:flex;align-items:center;justify-content:center;font-size:1.5rem;font-weight:800;color:#000;flex-shrink:0;">${initials}</div>
          <div style="flex:1;min-width:0;">
            <h2 style="margin:0 0 4px;font-size:1.4rem;">${state.user.name}</h2>
            <div style="color:var(--text-secondary);font-size:0.85rem;">${state.user.email}</div>
            <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
              <span class="badge" style="background:var(--accent-soft);color:var(--accent);">Period ${state.user.period}</span>
              <span class="badge" style="background:var(--info-bg);color:var(--info);">${planName}</span>
              <span class="badge" style="background:var(--success-bg);color:var(--success);">${memberDays} days</span>
            </div>
          </div>
        </div>

        <!-- Quick Stats -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:28px;">
          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;text-align:center;">
            <div style="font-size:1.5rem;font-weight:800;color:var(--accent);">${state.sessions.streak || 0}</div>
            <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">Day Streak</div>
          </div>
          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;text-align:center;">
            <div style="font-size:1.5rem;font-weight:800;color:var(--success);">${fcReviewed}</div>
            <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">Cards Reviewed</div>
          </div>
          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;text-align:center;">
            <div style="font-size:1.5rem;font-weight:800;color:var(--info);">${examsTaken}</div>
            <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">Exams Taken</div>
          </div>
        </div>

        ${state.user.isOwner ? `
        <!-- Owner Quick Access -->
        <div style="background:linear-gradient(135deg,rgba(245,158,11,0.08),rgba(245,158,11,0.02));border:2px solid var(--accent);border-radius:var(--radius);padding:20px;margin-bottom:28px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
            <span style="font-size:1.2rem;">&#x1F451;</span>
            <h3 style="margin:0;color:var(--accent);">Owner Dashboard</h3>
          </div>
          <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;font-size:0.85rem;">
            <div style="color:var(--text-secondary);">Diagnostic Questions: <strong style="color:var(--text-primary);">${DIAGNOSTIC_QUESTIONS.length}</strong></div>
            <div style="color:var(--text-secondary);">Exam Questions: <strong style="color:var(--text-primary);">${EXAM_BANK.length}</strong></div>
            <div style="color:var(--text-secondary);">Flashcards: <strong style="color:var(--text-primary);">${FLASHCARD_BANK.length}</strong></div>
            <div style="color:var(--text-secondary);">Topics: <strong style="color:var(--text-primary);">${Object.keys(TOPICS).length}</strong></div>
          </div>
          <div style="margin-top:12px;font-size:0.8rem;color:var(--success);display:flex;align-items:center;gap:6px;">
            <span style="width:8px;height:8px;border-radius:50%;background:var(--success);display:inline-block;"></span> All systems active
          </div>
        </div>
        ` : ''}

        <!-- Study Goals -->
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:16px;">
          <h3 style="margin:0 0 16px;font-size:1.05rem;display:flex;align-items:center;gap:8px;">&#x1F3AF; Daily Goals</h3>
          <div style="display:flex;flex-direction:column;gap:14px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
              <div><div style="font-weight:600;font-size:0.9rem;">Flashcard Target</div><div style="font-size:0.8rem;color:var(--text-muted);">Cards per day</div></div>
              <select style="padding:10px 14px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);min-width:120px;" onchange="Settings.updateGoal('dailyFlashcards', parseInt(this.value))">
                ${[10, 15, 20, 30, 50].map(n => `<option value="${n}" ${state.studyPlan.dailyFlashcards === n ? 'selected' : ''}>${n} cards</option>`).join('')}
              </select>
            </div>
            <div style="height:1px;background:var(--border);"></div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
              <div><div style="font-weight:600;font-size:0.9rem;">Study Time Target</div><div style="font-size:0.8rem;color:var(--text-muted);">Minutes per day</div></div>
              <select style="padding:10px 14px;background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);min-width:120px;" onchange="Settings.updateGoal('dailyMinutes', parseInt(this.value))">
                ${[15, 30, 45, 60, 90, 120].map(n => `<option value="${n}" ${state.studyPlan.dailyMinutes === n ? 'selected' : ''}>${n} min</option>`).join('')}
              </select>
            </div>
          </div>
        </div>

        <!-- Data & Account -->
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:16px;">
          <h3 style="margin:0 0 16px;font-size:1.05rem;display:flex;align-items:center;gap:8px;">&#x1F4BE; Data &amp; Account</h3>
          <div style="display:flex;flex-direction:column;gap:12px;">
            <button class="btn btn-secondary" onclick="Settings.exportData()" style="justify-content:flex-start;gap:10px;">
              <span style="font-size:1.1rem;">&#x1F4E5;</span> Export Progress Data
            </button>
            <button class="btn btn-secondary" onclick="Settings.retakeDiagnostic()" style="justify-content:flex-start;gap:10px;">
              <span style="font-size:1.1rem;">&#x1F504;</span> Retake Diagnostic Assessment
            </button>
          </div>
        </div>

        <!-- Danger Zone -->
        <div style="background:var(--bg-card);border:1px solid rgba(239,68,68,0.3);border-radius:var(--radius);padding:24px;margin-bottom:24px;">
          <h3 style="margin:0 0 16px;font-size:1.05rem;color:var(--danger);display:flex;align-items:center;gap:8px;">&#x26A0; Danger Zone</h3>
          <button class="btn btn-danger" onclick="Settings.resetAll()" style="width:100%;">Reset All Data</button>
          <div style="font-size:0.75rem;color:var(--text-muted);margin-top:8px;text-align:center;">This will permanently delete all your progress.</div>
        </div>

        <!-- Schedule Upload -->
        ${Settings._scheduleHTML(state)}

        <!-- Account Switcher -->
        ${Settings._accountSwitcherHTML(state)}

        <!-- Log Out -->
        <button class="btn btn-ghost" onclick="Auth.logout()" style="width:100%;margin-bottom:40px;">&#8592; Log Out</button>
      </div>
    `;
  },

  _scheduleHTML(state) {
    const sched = state.schedule || {};
    const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const topics = Object.values(TOPICS).filter(t => t.period === (state.user.period||1)).sort((a,b)=>a.order-b.order);
    const hasSchedule = Object.keys(sched).some(k => days.includes(k) && sched[k]);
    return `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:16px;">
      <h3 style="margin:0 0 6px;font-size:1.05rem;display:flex;align-items:center;gap:8px;">&#x1F4C5; My Class Schedule</h3>
      <p style="color:var(--text-secondary);font-size:0.85rem;margin:0 0 18px;">Set your schedule so the dashboard can suggest what to study each day based on your classes and weak spots.</p>

      <!-- Image upload -->
      <div style="margin-bottom:18px;">
        <label style="font-size:0.8rem;color:var(--text-muted);display:block;margin-bottom:8px;">Upload a photo of your timetable (optional — for reference)</label>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <label style="padding:8px 16px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:0.85rem;">
            📎 Choose Image
            <input type="file" accept="image/*,application/pdf" style="display:none;" onchange="Settings.uploadScheduleImage(event)">
          </label>
          ${sched.imageData ? `<span style="font-size:0.8rem;color:#22c55e;">✓ Schedule image saved</span>
            <button onclick="Settings.clearScheduleImage()" style="font-size:0.75rem;color:#ef4444;background:none;border:none;cursor:pointer;">Remove</button>` : '<span style="font-size:0.8rem;color:var(--text-muted);">No image uploaded</span>'}
        </div>
        ${sched.imageData ? `<img src="${sched.imageData}" style="max-width:100%;border-radius:8px;margin-top:10px;border:1px solid var(--border);">` : ''}
      </div>

      <!-- Weekly grid -->
      <div style="font-size:0.85rem;font-weight:700;margin-bottom:10px;">What topic do you study each day?</div>
      <div style="display:grid;gap:8px;">
        ${days.map(day => `
          <div style="display:flex;align-items:center;gap:12px;">
            <div style="min-width:90px;font-size:0.85rem;font-weight:600;color:var(--text-secondary);">${day}</div>
            <select id="sched_${day}" onchange="Settings.saveScheduleDay('${day}',this.value)"
              style="flex:1;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:0.82rem;">
              <option value="">— No class —</option>
              ${topics.map(t=>`<option value="${t.id}" ${sched[day]===t.id?'selected':''}>${t.name}</option>`).join('')}
            </select>
          </div>`).join('')}
      </div>
      ${hasSchedule ? `<div style="margin-top:12px;padding:10px 14px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.3);border-radius:8px;font-size:0.82rem;color:#22c55e;">✅ Schedule saved — your dashboard will show daily study suggestions based on today's topic.</div>` : ''}
    </div>`;
  },

  uploadScheduleImage(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) return showToast('Image too large (max 3MB)', 'error');
    const reader = new FileReader();
    reader.onload = e => {
      const s = Storage.get();
      if (!s.schedule) s.schedule = {};
      s.schedule.imageData = e.target.result;
      Storage.set(s);
      showToast('Schedule image saved!', 'success');
      Settings.render(s);
    };
    reader.readAsDataURL(file);
  },

  clearScheduleImage() {
    const s = Storage.get();
    if (s.schedule) { delete s.schedule.imageData; Storage.set(s); }
    showToast('Image removed', 'info');
    Settings.render(s);
  },

  saveScheduleDay(day, topicId) {
    const s = Storage.get();
    if (!s.schedule) s.schedule = {};
    s.schedule[day] = topicId || null;
    Storage.set(s);
  },

  _accountSwitcherHTML(state) {
    // Collect all locally stored accounts
    const reg = UserRegistry.getAll();
    const currentUid = state.user.id;
    const others = reg.filter(u => u.id !== currentUid);
    if (others.length === 0) return '';
    return `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:16px;">
      <h3 style="margin:0 0 16px;font-size:1.05rem;display:flex;align-items:center;gap:8px;">&#x1F500; Switch Account</h3>
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${others.map(u => {
          const initials = (u.name || '?').split(' ').map(w => w[0]).join('').toUpperCase().substring(0,2);
          const isOwner = u.isOwner;
          return `
          <button onclick="Settings.switchToAccount('${u.id}')" style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg-input);border:1px solid var(--border);border-radius:10px;cursor:pointer;text-align:left;width:100%;transition:border-color 0.2s;" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
            <div style="width:36px;height:36px;border-radius:50%;background:${isOwner ? 'linear-gradient(135deg,#f59e0b,#d97706)' : 'linear-gradient(135deg,#3b82f6,#1d4ed8)'};display:flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:800;color:#000;flex-shrink:0;">${initials}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:700;font-size:0.88rem;color:var(--text-primary);">${u.name}</div>
              <div style="font-size:0.75rem;color:var(--text-muted);">${u.email}${isOwner ? ' &nbsp;&#x1F451; Owner' : ''}</div>
            </div>
            <div style="font-size:0.75rem;color:var(--text-muted);">Switch &#8594;</div>
          </button>`;
        }).join('')}
      </div>
    </div>`;
  },

  switchToAccount(uid) {
    const targetState = Storage.getUserById(uid);
    if (!targetState) return showToast('Account not found on this device', 'error');
    // Remember who we're switching away from
    const currentState = Storage.get();
    if (currentState) localStorage.setItem(PREV_ACCOUNT_KEY, currentState.user.id);
    // Switch active user
    localStorage.setItem(ACTIVE_USER_KEY, uid);
    showToast('Switched to ' + targetState.user.name, 'success');
    // Re-navigate to dashboard or owner panel
    if (targetState.user.isOwner) {
      OwnerDashboard._cloudUsers = null;
      App.navigate('owner');
    } else {
      App.navigate('dashboard');
    }
  },

  updateGoal(key, value) {
    const state = Storage.get();
    state.studyPlan[key] = value;
    Storage.set(state);
    showToast('Goal updated!', 'success');
  },

  exportData() {
    const state = Storage.get();
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sparkystudy-backup-${getToday()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Data exported!', 'success');
  },

  retakeDiagnostic() {
    if (!confirm('This will reset your diagnostic results and generate a new study plan. Continue?')) return;
    const state = Storage.get();
    state.diagnostic = { completed: false, responses: [], weakAreas: [], strongAreas: [], score: 0, pct: 0 };
    Storage.set(state);
    App.navigate('diagnostic');
  },

  resetAll() {
    if (!confirm('This will delete ALL your progress, flashcard data, and exam history. This cannot be undone. Are you sure?')) return;
    Storage.clear();
    showToast('All data reset', 'info');
    App.navigate('landing');
  }
};




// ===== GROUP PROGRESS =====
const GroupProgress = {
  render(state) {
    const container = document.getElementById('groupContent');
    const sub = state.user.subscription || {};
    const gid = sub.groupId;
    if (!gid) {
      container.innerHTML = '<div style="text-align:center;padding:60px 20px;"><h2>&#x1F465; Group Progress</h2><p style="color:var(--text-secondary);margin-top:12px;">You are not part of a group plan. Group progress is available for Elite Group members.</p><button class="btn btn-primary" onclick="App.navigate(\'dashboard\')">Back to Dashboard</button></div>';
      return;
    }
    const allUsers = Storage.getAllUsers().filter(s => s && s.user.subscription && s.user.subscription.groupId === gid && !s.user.isOwner);
    const myId = state.user.id;
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px;"><div><h2 style="margin:0;">&#x1F465; Group Progress</h2><p style="color:var(--text-secondary);margin-top:4px;">'+allUsers.length+' members in your group</p></div><button class="btn btn-secondary btn-sm" onclick="GroupProgress.render(Storage.get())">&#x21BB; Refresh</button></div>' +
      '<div class="oa-grid" style="grid-template-columns:repeat(4,1fr);">' +
      this._statCard(allUsers.length, 'Members', '') + this._statCard(this._groupAvgMastery(allUsers) + '%', 'Avg Mastery', '') + this._statCard(this._groupAvgExam(allUsers) + '%', 'Avg Exam Score', '') + this._statCard(Math.round(allUsers.reduce((s,u) => s + (u.sessions.streak||0), 0) / Math.max(allUsers.length,1)), 'Avg Streak', 'd') +
      '</div><div style="margin-top:24px;"><h3 style="margin-bottom:16px;">&#x1F3C6; Leaderboard</h3>' + this._renderLeaderboard(allUsers, myId) + '</div>' +
      '<div style="margin-top:24px;"><h3 style="margin-bottom:16px;">&#x1F4CB; Member Details</h3>' + this._renderMembers(allUsers, myId) + '</div>';
  },
  _statCard(val, label, suffix) { return '<div class="oa-stat"><div class="oa-stat-value">' + val + suffix + '</div><div class="oa-stat-label">' + label + '</div></div>'; },
  _getMastery(st) { const cs = Object.values(st.flashcards || {}).filter(c => c.lastReview); if (!cs.length) return 0; return Math.round(cs.reduce((s,c) => s + c.correct / Math.max(c.correct + c.incorrect, 1), 0) / cs.length * 100); },
  _getAvgExam(st) { const att = st.exams.attempts || []; if (!att.length) return 0; return Math.round(att.reduce((s,e) => s + (e.pct||0), 0) / att.length); },
  _groupAvgMastery(users) { if (!users.length) return 0; return Math.round(users.reduce((s,u) => s + this._getMastery(u), 0) / users.length); },
  _groupAvgExam(users) { const w = users.filter(u => (u.exams.attempts||[]).length > 0); if (!w.length) return 0; return Math.round(w.reduce((s,u) => s + this._getAvgExam(u), 0) / w.length); },
  _renderLeaderboard(users, myId) {
    const ranked = users.map(u => ({ name: u.user.name, id: u.user.id, mastery: this._getMastery(u), exams: (u.exams.attempts||[]).length, avgExam: this._getAvgExam(u), streak: u.sessions.streak || 0, fcReviews: Object.values(u.flashcards||{}).reduce((s,c) => s + (c.correct||0) + (c.incorrect||0), 0) })).sort((a,b) => b.mastery - a.mastery);
    const medals = ['&#x1F947;', '&#x1F948;', '&#x1F949;'];
    return '<table class="oa-table"><thead><tr><th>#</th><th>Student</th><th>Mastery</th><th>Avg Exam</th><th>Exams</th><th>FC Reviews</th><th>Streak</th></tr></thead><tbody>' + ranked.map((r,i) => { const isMe = r.id === myId; return '<tr style="' + (isMe ? 'background:rgba(245,158,11,0.08);' : '') + '"><td>' + (medals[i] || (i+1)) + '</td><td><strong>' + r.name + '</strong>' + (isMe ? ' <span style="font-size:0.7rem;color:var(--accent);">(You)</span>' : '') + '</td><td><strong style="color:' + (r.mastery >= 70 ? '#22c55e' : r.mastery >= 40 ? '#f59e0b' : '#ef4444') + ';">' + r.mastery + '%</strong></td><td>' + r.avgExam + '%</td><td>' + r.exams + '</td><td>' + r.fcReviews + '</td><td>' + r.streak + 'd</td></tr>'; }).join('') + '</tbody></table>';
  },
  _renderMembers(users, myId) {
    return users.map(st => {
      const u = st.user, isMe = u.id === myId, mastery = this._getMastery(st);
      const topicMastery = Object.keys(TOPICS).map(tid => { const cds = Object.entries(st.flashcards||{}).filter(([id]) => { const fc = FLASHCARD_BANK.find(f => f.id === id); return fc && fc.topic === tid; }); if (!cds.length) return null; return { name: TOPICS[tid]?.name || tid, m: Math.round(cds.reduce((s,[,c]) => s + c.correct / Math.max(c.correct + c.incorrect, 1), 0) / cds.length * 100) }; }).filter(Boolean).sort((a,b) => b.m - a.m);
      const lastExam = (st.exams.attempts||[]).slice(-1)[0];
      const border = isMe ? 'border:2px solid var(--accent);' : 'border:1px solid var(--border);';
      return '<div style="background:var(--bg-card);' + border + 'border-radius:var(--radius);padding:20px;margin-bottom:12px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><div><strong style="font-size:1.1rem;">' + u.name + '</strong>' + (isMe ? ' <span style="background:var(--accent);color:#000;padding:2px 8px;border-radius:10px;font-size:0.7rem;font-weight:700;">YOU</span>' : '') + '<div style="font-size:0.8rem;color:var(--text-muted);margin-top:2px;">Period ' + u.period + ' &middot; Streak: ' + (st.sessions.streak||0) + 'd</div></div><div style="text-align:right;"><div style="font-size:1.5rem;font-weight:800;color:' + (mastery >= 70 ? '#22c55e' : mastery >= 40 ? '#f59e0b' : '#ef4444') + ';">' + mastery + '%</div><div style="font-size:0.7rem;color:var(--text-muted);">Mastery</div></div></div>' +
        (topicMastery.length > 0 ? '<div style="margin-top:8px;">' + topicMastery.slice(0,6).map(t => '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;"><span style="font-size:0.8rem;width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + t.name + '</span><div style="flex:1;height:6px;background:var(--bg-input);border-radius:3px;overflow:hidden;"><div style="height:100%;width:' + t.m + '%;background:' + (t.m >= 70 ? '#22c55e' : t.m >= 40 ? '#f59e0b' : '#ef4444') + ';border-radius:3px;"></div></div><span style="font-size:0.75rem;font-weight:600;width:32px;text-align:right;">' + t.m + '%</span></div>').join('') + '</div>' : '') + '</div>';
    }).join('');
  }
};

// ===== PRICING CONFIG =====
const PRICING_KEY = 'sparkstudy_pricing';
const PROMO_KEY = 'sparkstudy_promos';
const PRICING = {
  elite: { name: 'Elite', price: 99, period: 'year', trialDays: 7 },
  group: {
    name: 'Elite Group',
    maxStudents: 15,
    minPrice: 42,
    getPrice(students) {
      const max = PRICING.group.maxStudents;
      const minP = PRICING.group.minPrice;
      const n = Math.max(2, Math.min(students, max));
      const startPrice = PRICING.elite.price - 10;
      const step = (startPrice - minP) / Math.max(max - 2, 1);
      const perStudent = Math.round(startPrice - (n - 2) * step);
      return Math.max(minP, Math.min(startPrice, perStudent));
    }
  },
  load() {
    try {
      const saved = JSON.parse(localStorage.getItem(PRICING_KEY));
      if (saved) {
        if (saved.elitePrice) PRICING.elite.price = saved.elitePrice;
        if (saved.trialDays !== undefined) PRICING.elite.trialDays = saved.trialDays;
        if (saved.groupMax) PRICING.group.maxStudents = saved.groupMax;
        if (saved.groupMin) PRICING.group.minPrice = saved.groupMin;
      }
    } catch(e) {}
  },
  save() {
    localStorage.setItem(PRICING_KEY, JSON.stringify({
      elitePrice: PRICING.elite.price,
      trialDays: PRICING.elite.trialDays,
      groupMax: PRICING.group.maxStudents,
      groupMin: PRICING.group.minPrice
    }));
  }
};
PRICING.load();

// ===== PROMO CODES =====
const PromoCodes = {
  getAll() { try { return JSON.parse(localStorage.getItem(PROMO_KEY)) || []; } catch(e) { return []; } },
  save(codes) { localStorage.setItem(PROMO_KEY, JSON.stringify(codes)); },
  add(code, type, value, maxUses, expiry) {
    const all = this.getAll();
    if (all.find(c => c.code.toUpperCase() === code.toUpperCase())) return false;
    all.push({ code: code.toUpperCase(), type, value, maxUses: maxUses || null, uses: 0, expiry: expiry || null, active: true, created: Date.now() });
    this.save(all);
    return true;
  },
  remove(code) {
    const all = this.getAll().filter(c => c.code !== code);
    this.save(all);
  },
  toggle(code) {
    const all = this.getAll();
    const c = all.find(p => p.code === code);
    if (c) c.active = !c.active;
    this.save(all);
  },
  validate(code) {
    if (!code) return null;
    const all = this.getAll();
    const promo = all.find(c => c.code === code.toUpperCase() && c.active);
    if (!promo) return null;
    if (promo.maxUses && promo.uses >= promo.maxUses) return null;
    if (promo.expiry && Date.now() > promo.expiry) return null;
    return promo;
  },
  redeem(code) {
    const all = this.getAll();
    const promo = all.find(c => c.code === code.toUpperCase());
    if (promo) { promo.uses++; this.save(all); }
  }
};

// ===== OWNER ANALYTICS DASHBOARD =====
const OwnerDashboard = {
  currentTab: 'overview',
  groupSliderVal: 5,
  _cloudUsers: null,  // populated from Firestore
  _cloudVisits: null, // real visit data from Firestore (excludes owner)

  _gatherData() {
    const a = SiteAnalytics.getData();
    // Use Firestore users if available (shows ALL students), otherwise fall back to local
    const allFetched = this._cloudUsers || Storage.getAllUsers();
    const users = allFetched.filter(s => s && !s.user.isOwner);
    const registry = this._cloudUsers
      ? this._cloudUsers.filter(s => s && !s.user.isOwner).map(s => s.user)
      : UserRegistry.getAll().filter(u => !u.isOwner);
    const now = Date.now(), today = new Date().toISOString().slice(0,10);
    const last7 = now-7*86400000, last30 = now-30*86400000;
    const totalUsers = registry.length;
    const activeWeek = users.filter(s=>s.user.lastLogin>last7).length;
    const activeMonth = users.filter(s=>s.user.lastLogin>last30).length;
    const avgTime = users.length>0?Math.round(users.reduce((s,u)=>s+(u.sessions.totalTime||0),0)/Math.max(users.length,1)/60000):0;
    const totalExams = users.reduce((s,u)=>s+(u.exams.attempts?.length||0),0);
    const totalFc = users.reduce((s,u)=>s+Object.values(u.flashcards||{}).reduce((c,fc)=>c+(fc.correct||0)+(fc.incorrect||0),0),0);
    const diagDone = users.filter(s=>s.diagnostic.completed).length;
    const eliteUsers = users.filter(s=>s.user.subscription?.status==='paid').length;
    const trialUsers = users.filter(s=>s.user.subscription?.status==='trial').length;
    const expiredTrials = users.filter(s=>s.user.subscription?.status==='trial'&&s.user.subscription.trialEnd&&s.user.subscription.trialEnd<now).length;
    const groupUsers = users.filter(s=>s.user.subscription?.groupId).length;
    const revenue = a.revenue?.total||0;
    const signupsWeek = registry.filter(u=>u.signupDate>last7).length;
    const signupsMonth = registry.filter(u=>u.signupDate>last30).length;
    const p1 = users.filter(s=>s.user.period===1).length, p2 = users.filter(s=>s.user.period===2).length;
    let allScores=[]; users.forEach(s=>{(s.exams.attempts||[]).forEach(ex=>{if(ex.pct!==undefined)allScores.push(ex.pct);});});
    const avgExam = allScores.length>0?Math.round(allScores.reduce((a,b)=>a+b,0)/allScores.length):0;
    const diagScores = users.filter(s=>s.diagnostic.completed).map(s=>s.diagnostic.pct||0);
    const avgDiag = diagScores.length>0?Math.round(diagScores.reduce((a,b)=>a+b,0)/diagScores.length):0;
    const recentEvents = SiteAnalytics.getRecentEvents(50);

    // Traffic stats — use Firebase cloud data if available (real cross-device, owner-excluded)
    let totalVisits, todayVisits, visitDays, hourly, topPages;
    if (this._cloudVisits) {
      const cv = this._cloudVisits;
      totalVisits = cv.length;
      todayVisits = cv.filter(v => v.date === today).length;
      // Build 30-day chart
      const dayMap = {};
      for (let i = 29; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        dayMap[d.toISOString().slice(0,10)] = 0;
      }
      cv.forEach(v => { if (dayMap[v.date] !== undefined) dayMap[v.date]++; });
      visitDays = Object.entries(dayMap).map(([date, count]) => {
        const d = new Date(date + 'T12:00:00');
        return { date, label: d.toLocaleDateString('en', { month: 'short', day: 'numeric' }), count };
      });
      // Hourly distribution
      const hrs = new Array(24).fill(0);
      cv.forEach(v => { if (v.hour !== undefined) hrs[v.hour]++; });
      hourly = hrs;
      // Top pages
      const pageCounts = {};
      cv.forEach(v => { if (v.page) pageCounts[v.page] = (pageCounts[v.page]||0) + 1; });
      topPages = Object.entries(pageCounts).sort((a,b) => b[1]-a[1]);
    } else {
      totalVisits = a.totalVisits||0;
      todayVisits = a.dailyVisits[today]||0;
      visitDays = SiteAnalytics.getVisitsLast30Days();
      hourly = SiteAnalytics.getHourlyDistribution();
      topPages = SiteAnalytics.getTopPages();
    }

    return {a,users,registry,now,today,last7,last30,totalUsers,activeWeek,activeMonth,totalVisits,todayVisits,avgTime,totalExams,totalFc,diagDone,eliteUsers,trialUsers,expiredTrials,groupUsers,revenue,signupsWeek,signupsMonth,visitDays,hourly,topPages,recentEvents,p1,p2,avgExam,avgDiag};
  },

  async render() {
    const container = document.getElementById('ownerContent');
    // Pull both users and visits from Firebase in parallel
    if (FireDB.ready) {
      const [cloudUsers, cloudVisits] = await Promise.all([
        FireDB.getAllUsers(),
        FireDB.getVisits(30)
      ]);
      if (cloudUsers && cloudUsers.length >= 0) this._cloudUsers = cloudUsers;
      if (cloudVisits) this._cloudVisits = cloudVisits;
    }
    const D = this._gatherData();
    const cloudBadge = FireDB.ready
      ? '<span style="font-size:0.7rem;background:#22c55e22;color:#22c55e;border:1px solid #22c55e44;border-radius:6px;padding:2px 8px;margin-left:8px;">&#x2601;&#xFE0F; Cloud</span>'
      : '<span style="font-size:0.7rem;background:#f59e0b22;color:#f59e0b;border:1px solid #f59e0b44;border-radius:6px;padding:2px 8px;margin-left:8px;">&#x1F4BB; Local only</span>';
    const tabs = [
      {id:'overview',label:'Overview',icon:'&#x1F4CA;'},{id:'users',label:'Users',icon:'&#x1F465;'},
      {id:'diagnostics',label:'Diagnostics',icon:'&#x1F3AF;'},{id:'exams',label:'Exams',icon:'&#x1F4DD;'},
      {id:'flashcards',label:'Flashcards',icon:'&#x1F4DA;'},{id:'traffic',label:'Traffic',icon:'&#x1F6A6;'},
      {id:'engagement',label:'Engagement',icon:'&#x1F525;'},{id:'revenue',label:'Revenue',icon:'&#x1F4B0;'},
      {id:'plans',label:'Plans & Pricing',icon:'&#x1F4B3;'},{id:'events',label:'Event Log',icon:'&#x1F4DC;'},
      {id:'export',label:'Export',icon:'&#x1F4E5;'}
    ];
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px;"><div><h1 style="margin:0;">&#x1F451; Owner Analytics</h1><p style="color:var(--text-secondary);margin-top:4px;">Real-time insights &mdash; '+D.totalUsers+' users, '+D.totalVisits+' visits'+cloudBadge+'</p></div><div style="display:flex;align-items:center;gap:12px;"><span class="oa-live-dot"></span><span style="font-size:0.85rem;color:#22c55e;">Live</span><span style="font-size:0.75rem;color:var(--text-muted);">'+new Date().toLocaleTimeString()+'</span><button class="btn btn-ghost btn-sm" onclick="App.navigate(\'dashboard\')" style="border:1px solid var(--border);">&#x1F519; My Dashboard</button><button class="btn btn-secondary btn-sm" onclick="OwnerDashboard.render()">&#x21BB; Refresh</button><button class="btn btn-ghost btn-sm" onclick="Auth.logout()">Logout</button></div></div><div class="oa-tabs" style="flex-wrap:wrap;">'+tabs.map(t=>'<div class="oa-tab '+(this.currentTab===t.id?'active':'')+'" onclick="OwnerDashboard.switchTab(\''+t.id+'\')">'+t.icon+' '+t.label+'</div>').join('')+'</div><div id="oaTabContent"></div>';
    const tc = document.getElementById('oaTabContent');
    const fn = '_tab_'+this.currentTab;
    if(this[fn]) tc.innerHTML = this[fn](D);
  },

  switchTab(t) { this.currentTab=t; this.render(); },

  _tab_overview(D) {
    const maxV=Math.max(...D.visitDays.map(d=>d.count),1), maxH=Math.max(...D.hourly,1);
    return '<div class="oa-grid"><div class="oa-stat"><div class="oa-stat-value">'+D.totalUsers+'</div><div class="oa-stat-label">Total Users</div><div class="oa-stat-sub">+'+D.signupsWeek+' this week</div></div><div class="oa-stat"><div class="oa-stat-value">'+D.activeWeek+'</div><div class="oa-stat-label">Active (7d)</div><div class="oa-stat-sub">'+D.activeMonth+' (30d)</div></div><div class="oa-stat"><div class="oa-stat-value">'+D.totalVisits+'</div><div class="oa-stat-label">Total Visits</div><div class="oa-stat-sub">'+D.todayVisits+' today</div></div><div class="oa-stat"><div class="oa-stat-value" style="color:#22c55e;">$'+D.revenue.toFixed(2)+'</div><div class="oa-stat-label">Revenue</div><div class="oa-stat-sub">'+D.eliteUsers+' elite / '+D.trialUsers+' trial</div></div></div>'+
      '<div class="oa-grid" style="grid-template-columns:repeat(4,1fr);"><div class="oa-stat"><div class="oa-stat-value">'+D.totalExams+'</div><div class="oa-stat-label">Exams Taken</div><div class="oa-stat-sub">Avg: '+D.avgExam+'%</div></div><div class="oa-stat"><div class="oa-stat-value">'+D.totalFc+'</div><div class="oa-stat-label">FC Reviews</div></div><div class="oa-stat"><div class="oa-stat-value">'+D.diagDone+'</div><div class="oa-stat-label">Diagnostics</div><div class="oa-stat-sub">Avg: '+D.avgDiag+'%</div></div><div class="oa-stat"><div class="oa-stat-value">'+D.avgTime+'m</div><div class="oa-stat-label">Avg Session</div></div></div>'+
      '<div class="oa-section"><h3>&#x1F4C8; Visits (30d)</h3><div class="oa-bar-chart">'+D.visitDays.map(d=>'<div class="oa-bar" style="height:'+Math.max(d.count/maxV*100,2)+'%;"><div class="oa-bar-value">'+(d.count||'')+'</div><div class="oa-bar-label">'+d.label.split(' ')[1]+'</div></div>').join('')+'</div></div>'+
      '<div class="oa-two-col"><div class="oa-section"><h3>&#x1F3AF; Funnel</h3>'+this._renderFunnel([{label:'Visits',value:D.a.funnelData?.landing||0,color:'#3b82f6'},{label:'Signups',value:D.totalUsers,color:'#8b5cf6'},{label:'Diagnostic',value:D.diagDone,color:'#f59e0b'},{label:'Active (7d)',value:D.activeWeek,color:'#22c55e'}])+'</div><div class="oa-section"><h3>&#x1F4CA; Distribution</h3><div class="oa-donut-wrap">'+this._renderDonut([{label:'Period 1',value:D.p1,color:'#3b82f6'},{label:'Period 2',value:D.p2,color:'#f59e0b'},{label:'Elite',value:D.eliteUsers,color:'#22c55e'},{label:'Trial',value:D.trialUsers,color:'#8b5cf6'}])+'</div></div></div>'+
      '<div class="oa-section"><h3>&#x23F0; Peak Hours</h3><div class="oa-bar-chart" style="height:120px;">'+D.hourly.map((v,i)=>'<div class="oa-bar" style="height:'+Math.max(v/maxH*100,2)+'%;background:'+(i>=8&&i<=22?'linear-gradient(to top,var(--accent),#fbbf24)':'linear-gradient(to top,#4b5563,#6b7280)')+';"><div class="oa-bar-value">'+(v||'')+'</div><div class="oa-bar-label">'+(i%3===0?i+':00':'')+'</div></div>').join('')+'</div></div>'+
      '<div class="oa-section" style="border:1px dashed rgba(245,158,11,0.3);background:rgba(245,158,11,0.03);"><h3>&#x1F9EA; Test Data</h3><p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:12px;">Generate sample students and activity to preview your dashboard.</p><button class="btn btn-secondary btn-sm" onclick="OwnerDashboard.generateTestData()">&#x2795; Generate 5 Test Students</button> <button class="btn btn-ghost btn-sm" onclick="if(confirm(\'Remove all test data?\')){OwnerDashboard.clearTestData()}" style="color:#ef4444;margin-left:8px;">Clear Test Data</button></div>';
  },

  _tab_users(D) {
    // Get all groups
    const groups={};D.users.forEach(s=>{const gid=s.user.subscription?.groupId;if(gid){if(!groups[gid])groups[gid]=[];groups[gid].push(s.user.name);}});
    const groupCount=Object.keys(groups).length;
    const groupedCount=D.users.filter(s=>s.user.subscription?.groupId).length;
    const rows = D.registry.map(reg=>{const st=Storage.getUserById(reg.id);if(!st||st.user.isOwner)return '';const u=st.user,sub=u.subscription||{};const isActive=u.lastLogin>D.last7;const isBanned=!!u.banned;const isTrial=sub.status==='trial';const trialLeft=isTrial&&sub.trialEnd?Math.max(0,Math.ceil((sub.trialEnd-D.now)/86400000)):0;const subLabel=sub.status==='paid'?'Elite':(isTrial?'Trial ('+trialLeft+'d)':'Trial');const subBadge=sub.status==='paid'?'oa-badge-paid':(isTrial&&trialLeft>0?'oa-badge-trial':'oa-badge-inactive');const gid=sub.groupId;const rowStyle=isBanned?'opacity:0.5;background:rgba(239,68,68,0.05);':'';return '<tr style="'+rowStyle+'"><td><strong>'+u.name+'</strong>'+(isBanned?' <span style="font-size:0.65rem;background:#ef444422;color:#ef4444;border-radius:4px;padding:1px 5px;font-weight:700;">BLOCKED</span>':'')+'<br><span style="font-size:0.7rem;color:var(--text-muted);">'+u.email+'</span></td><td>P'+u.period+'</td><td><span class="oa-badge '+(isActive&&!isBanned?'oa-badge-active':'oa-badge-inactive')+'">'+(isBanned?'Blocked':isActive?'Active':'Inactive')+'</span></td><td>'+this._timeAgo(u.lastLogin)+'</td><td>'+(st.diagnostic.completed?st.diagnostic.pct+'%':'--')+'</td><td>'+this._getUserMastery(st)+'%</td><td>'+(st.exams.attempts?.length||0)+'</td><td>'+(st.sessions.streak||0)+'d</td><td><span class="oa-badge '+subBadge+'">'+subLabel+'</span></td><td style="font-size:0.8rem;">'+(gid?'<span style="color:#8b5cf6;">'+gid+'</span>':'--')+'</td><td style="font-size:0.7rem;">'+new Date(u.signupDate).toLocaleDateString()+'</td><td style="white-space:nowrap;"><button onclick="OwnerDashboard.blockUser(\''+u.id+'\')" style="font-size:0.7rem;padding:3px 8px;border-radius:5px;border:1px solid '+(isBanned?'#22c55e':'#f59e0b')+';background:transparent;color:'+(isBanned?'#22c55e':'#f59e0b')+';cursor:pointer;margin-right:4px;">'+(isBanned?'Unblock':'Block')+'</button><button onclick="OwnerDashboard.removeUser(\''+u.id+'\')" style="font-size:0.7rem;padding:3px 8px;border-radius:5px;border:1px solid #ef4444;background:transparent;color:#ef4444;cursor:pointer;">Remove</button></td></tr>';}).join('');
    return '<div class="oa-grid"><div class="oa-stat"><div class="oa-stat-value">'+D.totalUsers+'</div><div class="oa-stat-label">Students</div></div><div class="oa-stat"><div class="oa-stat-value">'+D.activeWeek+'</div><div class="oa-stat-label">Active (7d)</div></div><div class="oa-stat"><div class="oa-stat-value">'+groupCount+'</div><div class="oa-stat-label">Groups</div></div><div class="oa-stat"><div class="oa-stat-value">'+groupedCount+'</div><div class="oa-stat-label">In Groups</div></div></div>'+
      // Group management section
      '<div class="oa-section"><h3>&#x1F465; Group Management</h3><p style="color:var(--text-secondary);margin-bottom:12px;">Assign students to groups so they can see each other\'s progress.</p>'+
      '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin-bottom:16px;">'+
      '<div><label style="font-size:0.75rem;color:var(--text-muted);display:block;margin-bottom:4px;">Group Name</label><input type="text" id="assignGroupId" placeholder="e.g. Class-A" value="'+(Object.keys(groups)[0]||'')+'" style="padding:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);width:150px;"></div>'+
      '<div style="flex:1;min-width:200px;"><label style="font-size:0.75rem;color:var(--text-muted);display:block;margin-bottom:4px;">Select Students (comma-separated emails)</label><input type="text" id="assignEmails" placeholder="student1@email.com, student2@email.com" style="padding:8px;width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);"></div>'+
      '<button class="btn btn-primary btn-sm" onclick="OwnerDashboard.assignGroup()" style="height:38px;">Assign to Group</button>'+
      '<button class="btn btn-secondary btn-sm" onclick="OwnerDashboard.removeFromGroups()" style="height:38px;">Remove from Groups</button>'+
      '</div>'+
      (groupCount>0?'<div style="margin-bottom:16px;">'+Object.entries(groups).map(([gid,members])=>'<div style="background:var(--bg-input);border:1px solid rgba(139,92,246,0.3);border-radius:var(--radius);padding:12px;margin-bottom:8px;display:flex;align-items:center;gap:12px;"><span style="color:#8b5cf6;font-weight:700;">'+gid+'</span><span style="font-size:0.85rem;color:var(--text-secondary);">'+members.length+' members: '+members.join(', ')+'</span></div>').join('')+'</div>':'')+
      '</div>'+
      '<div class="oa-section"><h3>&#x1F4CB; All Students</h3><div style="overflow-x:auto;"><table class="oa-table"><thead><tr><th>User</th><th>Period</th><th>Status</th><th>Last Active</th><th>Diagnostic</th><th>Mastery</th><th>Exams</th><th>Streak</th><th>Plan</th><th>Group</th><th>Joined</th><th>Actions</th></tr></thead><tbody>'+(rows||'<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:40px;">No students yet.</td></tr>')+'</tbody></table></div></div>'+D.users.filter(s=>!s.user.isOwner).map(s=>this._renderUserDetail(s)).join('');
  },

  _renderUserDetail(st) {
    const u=st.user;const tm=Object.keys(TOPICS).map(tid=>{const cds=Object.entries(st.flashcards||{}).filter(([id])=>{const fc=FLASHCARD_BANK.find(f=>f.id===id);return fc&&fc.topic===tid;});if(!cds.length)return{name:TOPICS[tid]?.name||tid,m:0};return{name:TOPICS[tid]?.name||tid,m:Math.round(cds.reduce((s,[,c])=>s+c.correct/Math.max(c.correct+c.incorrect,1),0)/cds.length*100)};}).filter(t=>t.m>0).sort((a,b)=>a.m-b.m);
    const weak=tm.slice(0,3),strong=tm.slice(-3).reverse();
    return '<div class="oa-section" style="margin-top:8px;"><h3>&#x1F464; '+u.name+' <span style="font-size:0.8rem;color:var(--text-muted);font-weight:400;">&mdash; '+u.email+'</span></h3><div class="oa-grid" style="grid-template-columns:repeat(3,1fr);"><div style="padding:8px;"><span style="font-size:0.7rem;color:var(--text-muted);">Weakest</span>'+weak.map(t=>'<div style="font-size:0.85rem;">'+t.name+': <strong>'+t.m+'%</strong></div>').join('')+'</div><div style="padding:8px;"><span style="font-size:0.7rem;color:var(--text-muted);">Strongest</span>'+strong.map(t=>'<div style="font-size:0.85rem;">'+t.name+': <strong style="color:#22c55e;">'+t.m+'%</strong></div>').join('')+'</div><div style="padding:8px;"><span style="font-size:0.7rem;color:var(--text-muted);">Exams</span>'+(st.exams.attempts||[]).slice(-3).reverse().map(ex=>'<div style="font-size:0.85rem;">'+new Date(ex.date).toLocaleDateString()+': <strong>'+ex.pct+'%</strong></div>').join('')+'</div></div></div>';
  },

  _tab_diagnostics(D) {
    const done=D.users.filter(s=>s.diagnostic.completed),scores=done.map(s=>s.diagnostic.pct||0);
    const avg=scores.length?Math.round(scores.reduce((a,b)=>a+b,0)/scores.length):0,hi=scores.length?Math.max(...scores):0,lo=scores.length?Math.min(...scores):0;
    const bk=[0,0,0,0,0];scores.forEach(s=>{bk[Math.min(4,Math.floor(s/20.01))]++;});const maxB=Math.max(...bk,1);const bkL=['0-20%','21-40%','41-60%','61-80%','81-100%'];
    const twc={};done.forEach(s=>{(s.diagnostic.weakAreas||[]).forEach(t=>{twc[t]=(twc[t]||0)+1;});});const wt=Object.entries(twc).sort((a,b)=>b[1]-a[1]).slice(0,10);const mxW=wt.length?wt[0][1]:1;
    const times=done.map(s=>s.diagnostic.timeSpent||0).filter(t=>t>0);const avgT=times.length?Math.round(times.reduce((a,b)=>a+b,0)/times.length/60000):0;
    return '<div class="oa-grid"><div class="oa-stat"><div class="oa-stat-value">'+done.length+'/'+D.totalUsers+'</div><div class="oa-stat-label">Completed</div></div><div class="oa-stat"><div class="oa-stat-value">'+avg+'%</div><div class="oa-stat-label">Average</div></div><div class="oa-stat"><div class="oa-stat-value" style="color:#22c55e;">'+hi+'%</div><div class="oa-stat-label">Highest</div></div><div class="oa-stat"><div class="oa-stat-value" style="color:#ef4444;">'+lo+'%</div><div class="oa-stat-label">Lowest</div></div></div><div class="oa-two-col"><div class="oa-section"><h3>&#x1F4CA; Score Distribution</h3><div class="oa-bar-chart" style="height:160px;">'+bk.map((v,i)=>'<div class="oa-bar" style="height:'+Math.max(v/maxB*100,3)+'%;"><div class="oa-bar-value">'+v+'</div><div class="oa-bar-label">'+bkL[i]+'</div></div>').join('')+'</div></div><div class="oa-section"><h3>&#x1F534; Common Weak Areas</h3>'+wt.map(([tid,cnt])=>'<div class="oa-metric-row"><span>'+(TOPICS[tid]?.name||tid)+'</span><div style="display:flex;align-items:center;gap:8px;"><div style="width:80px;height:6px;background:var(--bg-input);border-radius:3px;overflow:hidden;"><div style="height:100%;width:'+Math.round(cnt/mxW*100)+'%;background:#ef4444;border-radius:3px;"></div></div><span style="font-size:0.85rem;font-weight:600;">'+cnt+'</span></div></div>').join('')+'</div></div><div class="oa-section"><h3>&#x1F4CB; Individual Scores</h3><div style="overflow-x:auto;"><table class="oa-table"><thead><tr><th>Student</th><th>Score</th><th>Weak Areas</th><th>Time</th><th>Date</th></tr></thead><tbody>'+done.map(s=>'<tr><td>'+s.user.name+'</td><td><strong>'+s.diagnostic.pct+'%</strong></td><td style="font-size:0.8rem;">'+(s.diagnostic.weakAreas||[]).map(t=>TOPICS[t]?.name||t).join(', ')+'</td><td>'+Math.round((s.diagnostic.timeSpent||0)/60000)+'m</td><td style="font-size:0.8rem;">'+(s.diagnostic.completedDate?new Date(s.diagnostic.completedDate).toLocaleDateString():'--')+'</td></tr>').join('')+'</tbody></table></div></div>';
  },

  _tab_exams(D) {
    let all=[];D.users.forEach(s=>{(s.exams.attempts||[]).forEach(ex=>{all.push({...ex,userName:s.user.name});});});all.sort((a,b)=>(b.date||0)-(a.date||0));
    const scores=all.map(a=>a.pct||0),avg=scores.length?Math.round(scores.reduce((a,b)=>a+b,0)/scores.length):0,passing=scores.filter(s=>s>=70).length;
    return '<div class="oa-grid"><div class="oa-stat"><div class="oa-stat-value">'+all.length+'</div><div class="oa-stat-label">Total Attempts</div></div><div class="oa-stat"><div class="oa-stat-value">'+avg+'%</div><div class="oa-stat-label">Average</div></div><div class="oa-stat"><div class="oa-stat-value" style="color:#22c55e;">'+passing+'</div><div class="oa-stat-label">Passing (70%+)</div></div><div class="oa-stat"><div class="oa-stat-value" style="color:#ef4444;">'+(all.length-passing)+'</div><div class="oa-stat-label">Below 70%</div></div></div><div class="oa-section"><h3>&#x1F4CB; Recent Exams</h3><div style="overflow-x:auto;max-height:400px;"><table class="oa-table"><thead><tr><th>Student</th><th>Score</th><th>Correct</th><th>Time</th><th>Date</th></tr></thead><tbody>'+all.slice(0,30).map(ex=>'<tr><td>'+ex.userName+'</td><td><strong style="color:'+(ex.pct>=70?'#22c55e':'#ef4444')+';">'+ex.pct+'%</strong></td><td>'+ex.correct+'/'+ex.total+'</td><td>'+Math.round((ex.timeSpent||0)/60000)+'m</td><td style="font-size:0.8rem;">'+new Date(ex.date).toLocaleDateString()+'</td></tr>').join('')+'</tbody></table></div></div><div class="oa-section"><h3>Bank Stats</h3><div class="oa-grid" style="grid-template-columns:repeat(3,1fr);"><div class="oa-stat"><div class="oa-stat-value">'+EXAM_BANK.length+'</div><div class="oa-stat-label">Questions</div></div><div class="oa-stat"><div class="oa-stat-value">'+Object.keys(TOPICS).length+'</div><div class="oa-stat-label">Topics</div></div><div class="oa-stat"><div class="oa-stat-value">50</div><div class="oa-stat-label">Per Exam</div></div></div></div>';
  },

  _tab_flashcards(D) {
    const tiers={new:0,learning:0,review:0,mastered:0,expert:0};let totalR=0;
    D.users.forEach(s=>{Object.values(s.flashcards||{}).forEach(c=>{tiers[SM2.getMasteryTier(c)]++;totalR+=(c.correct||0)+(c.incorrect||0);});});
    const acc=D.users.reduce((s,u)=>{const cs=Object.values(u.flashcards||{});return{c:s.c+cs.reduce((a,c)=>a+(c.correct||0),0),t:s.t+cs.reduce((a,c)=>a+(c.correct||0)+(c.incorrect||0),0)};},{c:0,t:0});
    const accPct=acc.t>0?Math.round(acc.c/acc.t*100):0;
    return '<div class="oa-grid"><div class="oa-stat"><div class="oa-stat-value">'+FLASHCARD_BANK.length+'</div><div class="oa-stat-label">Cards in Bank</div></div><div class="oa-stat"><div class="oa-stat-value">'+totalR+'</div><div class="oa-stat-label">Total Reviews</div></div><div class="oa-stat"><div class="oa-stat-value">'+accPct+'%</div><div class="oa-stat-label">Accuracy</div></div><div class="oa-stat"><div class="oa-stat-value">'+(tiers.mastered+tiers.expert)+'</div><div class="oa-stat-label">Mastered</div></div></div><div class="oa-section"><h3>&#x1F4CA; Mastery Distribution</h3><div class="oa-donut-wrap">'+this._renderDonut([{label:'New',value:tiers.new,color:'#6b7280'},{label:'Learning',value:tiers.learning,color:'#3b82f6'},{label:'Review',value:tiers.review,color:'#f59e0b'},{label:'Mastered',value:tiers.mastered,color:'#22c55e'},{label:'Expert',value:tiers.expert,color:'#8b5cf6'}])+'</div></div>';
  },

  _tab_traffic(D) {
    const maxV=Math.max(...D.visitDays.map(d=>d.count),1),maxH=Math.max(...D.hourly,1);
    const dayN=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],byDay=[0,0,0,0,0,0,0];
    D.a.visits.forEach(v=>{byDay[new Date(v.timestamp).getDay()]++;});const maxD=Math.max(...byDay,1);
    const totalUnique=Object.keys(D.a.uniqueVisitors||{}).length;
    return '<div class="oa-grid"><div class="oa-stat"><div class="oa-stat-value">'+D.totalVisits+'</div><div class="oa-stat-label">Total Visits</div></div><div class="oa-stat"><div class="oa-stat-value">'+D.todayVisits+'</div><div class="oa-stat-label">Today</div></div><div class="oa-stat"><div class="oa-stat-value">'+totalUnique+'</div><div class="oa-stat-label">Unique Visitors</div></div><div class="oa-stat"><div class="oa-stat-value">'+D.signupsMonth+'</div><div class="oa-stat-label">Signups (30d)</div></div></div><div class="oa-section"><h3>&#x1F4C8; Daily Traffic</h3><div class="oa-bar-chart">'+D.visitDays.map(d=>'<div class="oa-bar" style="height:'+Math.max(d.count/maxV*100,2)+'%;"><div class="oa-bar-value">'+(d.count||'')+'</div><div class="oa-bar-label">'+d.label.split(' ')[1]+'</div></div>').join('')+'</div></div><div class="oa-two-col"><div class="oa-section"><h3>&#x23F0; Hourly</h3><div class="oa-bar-chart" style="height:120px;">'+D.hourly.map((v,i)=>'<div class="oa-bar" style="height:'+Math.max(v/maxH*100,2)+'%;"><div class="oa-bar-value">'+(v||'')+'</div><div class="oa-bar-label">'+(i%4===0?i+':00':'')+'</div></div>').join('')+'</div></div><div class="oa-section"><h3>&#x1F4C5; By Day</h3><div class="oa-bar-chart" style="height:120px;">'+byDay.map((v,i)=>'<div class="oa-bar" style="height:'+Math.max(v/maxD*100,3)+'%;"><div class="oa-bar-value">'+v+'</div><div class="oa-bar-label">'+dayN[i]+'</div></div>').join('')+'</div></div></div><div class="oa-section"><h3>&#x1F4C4; Top Pages</h3>'+(D.topPages.length>0?D.topPages.slice(0,10).map(([p,c],i)=>'<div class="oa-metric-row"><span>#'+(i+1)+' '+p+'</span><span style="font-weight:600;">'+c+'</span></div>').join(''):'<p style="color:var(--text-muted);">No data</p>')+'</div>';
  },

  _tab_engagement(D) {
    const heat=[];for(let i=83;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);heat.push({date:d.toISOString().slice(0,10),count:D.a.dailyVisits[d.toISOString().slice(0,10)]||0});}
    const mxH=Math.max(...heat.map(d=>d.count),1);
    const retained=D.users.filter(s=>s.user.lastLogin>s.user.signupDate+7*86400000).length;
    const retRate=D.totalUsers>0?Math.round(retained/D.totalUsers*100):0;
    const avgStr=D.users.length>0?Math.round(D.users.reduce((s,u)=>s+(u.sessions.streak||0),0)/D.users.length):0;
    const maxStr=D.users.length>0?Math.max(...D.users.map(u=>u.sessions.streak||0)):0;
    return '<div class="oa-grid"><div class="oa-stat"><div class="oa-stat-value">'+retRate+'%</div><div class="oa-stat-label">7-Day Retention</div></div><div class="oa-stat"><div class="oa-stat-value">'+avgStr+'d</div><div class="oa-stat-label">Avg Streak</div></div><div class="oa-stat"><div class="oa-stat-value">'+maxStr+'d</div><div class="oa-stat-label">Best Streak</div></div><div class="oa-stat"><div class="oa-stat-value">'+D.avgTime+'m</div><div class="oa-stat-label">Avg Session</div></div></div><div class="oa-section"><h3>&#x1F525; Heatmap (12wk)</h3><div style="display:flex;gap:2px;flex-wrap:wrap;">'+heat.map(d=>{const int=d.count/mxH;const bg=d.count===0?'rgba(255,255,255,0.05)':'rgba(245,158,11,'+(0.2+int*0.8).toFixed(2)+')';return '<div style="width:14px;height:14px;border-radius:3px;background:'+bg+';" title="'+d.date+': '+d.count+'"></div>';}).join('')+'</div></div><div class="oa-section"><h3>Feature Usage</h3><div class="oa-grid" style="grid-template-columns:repeat(3,1fr);"><div class="oa-stat"><div class="oa-stat-value">'+D.diagDone+'</div><div class="oa-stat-label">Diagnostics</div></div><div class="oa-stat"><div class="oa-stat-value">'+D.totalExams+'</div><div class="oa-stat-label">Exams</div></div><div class="oa-stat"><div class="oa-stat-value">'+D.totalFc+'</div><div class="oa-stat-label">FC Reviews</div></div></div></div>';
  },

  _tab_revenue(D) {
    const tx=D.a.revenue?.transactions||[];const mrr=Math.round(D.eliteUsers*99/12);
    return '<div class="oa-grid"><div class="oa-stat"><div class="oa-stat-value" style="color:#22c55e;">$'+D.revenue.toFixed(2)+'</div><div class="oa-stat-label">Revenue</div></div><div class="oa-stat"><div class="oa-stat-value">$'+mrr+'</div><div class="oa-stat-label">Est. MRR</div></div><div class="oa-stat"><div class="oa-stat-value">'+D.eliteUsers+'</div><div class="oa-stat-label">Elite</div></div><div class="oa-stat"><div class="oa-stat-value">'+D.groupUsers+'</div><div class="oa-stat-label">Group</div></div></div><div class="oa-two-col"><div class="oa-section"><h3>&#x1F4B3; Breakdown</h3><div class="oa-donut-wrap">'+this._renderDonut([{label:'Elite',value:D.eliteUsers,color:'#f59e0b'},{label:'Trial',value:D.trialUsers,color:'#3b82f6'},{label:'Expired',value:D.expiredTrials,color:'#ef4444'}])+'</div></div><div class="oa-section"><h3>&#x1F4B0; Potential</h3><div class="oa-metric-row"><span>All trials convert</span><span style="color:#22c55e;font-weight:700;">+$'+D.trialUsers*99+'</span></div><div class="oa-metric-row"><span>Max annual</span><span style="color:#22c55e;font-weight:700;">$'+D.totalUsers*99+'</span></div></div></div><div class="oa-section"><h3>Transactions</h3>'+(tx.length>0?'<table class="oa-table"><thead><tr><th>Date</th><th>User</th><th>Plan</th><th>Amount</th></tr></thead><tbody>'+tx.slice(-20).reverse().map(t=>{const u=UserRegistry.getAll().find(r=>r.id===t.userId);return '<tr><td>'+t.date+'</td><td>'+(u?.name||'Unknown')+'</td><td>'+t.plan+'</td><td style="color:#22c55e;font-weight:600;">$'+t.amount.toFixed(2)+'</td></tr>';}).join('')+'</tbody></table>':'<p style="color:var(--text-muted);text-align:center;padding:30px;">No transactions yet.</p>')+'</div>';
  },

  _tab_plans(D) {
    const gs=this.groupSliderVal,ep=PRICING.elite.price,td=PRICING.elite.trialDays,gm=PRICING.group.maxStudents,gmin=PRICING.group.minPrice;
    const pp=PRICING.group.getPrice(gs),tt=pp*gs,sv=ep*gs-tt,svp=gs>0?Math.round(sv/(ep*gs)*100):0;
    const maxSv=Math.round((ep-gmin)/ep*100);
    const promos=PromoCodes.getAll();
    // Build pricing table rows
    const tableNums=[];for(let i=2;i<=gm;i++){if(i<=10||i%5===0||i===gm)tableNums.push(i);}
    return '<div style="background:linear-gradient(135deg,rgba(245,158,11,0.06),rgba(139,92,246,0.06));border:1px solid rgba(245,158,11,0.15);border-radius:16px;padding:28px;margin-bottom:28px;">'+
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;"><div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,var(--accent),#d97706);display:flex;align-items:center;justify-content:center;font-size:1.2rem;">&#x2699;</div><div><h3 style="margin:0;font-size:1.15rem;">Pricing Controls</h3><p style="margin:0;font-size:0.8rem;color:var(--text-muted);">Adjust your plan pricing. Changes save instantly and reflect site-wide.</p></div></div>'+
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">'+
      '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:20px;">'+
      '<div style="font-weight:700;font-size:0.9rem;color:var(--accent);margin-bottom:16px;display:flex;align-items:center;gap:6px;">&#x2B50; Elite Plan</div>'+
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'+
      '<div><label style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);display:block;margin-bottom:6px;">Annual Price</label><div style="position:relative;"><span style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-muted);font-weight:600;">$</span><input type="number" id="editElitePrice" value="'+ep+'" min="1" max="999" style="width:100%;padding:10px 10px 10px 28px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:1.2rem;font-weight:800;transition:border-color 0.2s;" onfocus="this.style.borderColor=\'var(--accent)\'" onblur="this.style.borderColor=\'var(--border)\';OwnerDashboard.savePricing()"></div><div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">= $'+(ep/12).toFixed(2)+'/month</div></div>'+
      '<div><label style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);display:block;margin-bottom:6px;">Free Trial</label><div style="display:flex;align-items:center;gap:8px;"><input type="number" id="editTrialDays" value="'+td+'" min="0" max="90" style="width:70px;padding:10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:1.2rem;font-weight:800;text-align:center;transition:border-color 0.2s;" onfocus="this.style.borderColor=\'var(--accent)\'" onblur="this.style.borderColor=\'var(--border)\';OwnerDashboard.savePricing()"><span style="font-size:0.85rem;color:var(--text-secondary);">days</span></div></div>'+
      '</div></div>'+
      '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:20px;">'+
      '<div style="font-weight:700;font-size:0.9rem;color:#8b5cf6;margin-bottom:16px;display:flex;align-items:center;gap:6px;">&#x1F465; Group Plan</div>'+
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'+
      '<div><label style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);display:block;margin-bottom:6px;">Max Students</label><div style="display:flex;align-items:center;gap:8px;"><input type="number" id="editGroupMax" value="'+gm+'" min="2" max="100" style="width:70px;padding:10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:1.2rem;font-weight:800;text-align:center;transition:border-color 0.2s;" onfocus="this.style.borderColor=\'#8b5cf6\'" onblur="this.style.borderColor=\'var(--border)\';OwnerDashboard.savePricing()"><span style="font-size:0.85rem;color:var(--text-secondary);">per group</span></div></div>'+
      '<div><label style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);display:block;margin-bottom:6px;">Floor Price</label><div style="position:relative;"><span style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-muted);font-weight:600;">$</span><input type="number" id="editGroupMin" value="'+gmin+'" min="1" max="'+ep+'" style="width:100%;padding:10px 10px 10px 28px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);font-size:1.2rem;font-weight:800;transition:border-color 0.2s;" onfocus="this.style.borderColor=\'#8b5cf6\'" onblur="this.style.borderColor=\'var(--border)\';OwnerDashboard.savePricing()"></div><div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">min per student/yr</div></div>'+
      '</div></div>'+
      '</div></div>'+
      '<div class="oa-section"><h3>&#x26A1; Plan Preview</h3><div class="oa-grid" style="grid-template-columns:1fr 1fr;gap:24px;">'+
      '<div style="background:var(--bg-input);border:2px solid var(--accent);border-radius:var(--radius);padding:32px;text-align:center;position:relative;"><div style="position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:var(--accent);color:#000;padding:4px 16px;border-radius:20px;font-size:0.75rem;font-weight:700;">MOST POPULAR</div><div style="font-weight:800;font-size:1.3rem;color:var(--accent);">Elite</div><div style="font-size:2.5rem;font-weight:900;margin:12px 0;">$'+ep+'<span style="font-size:0.9rem;font-weight:400;color:var(--text-secondary);">/year</span></div><div style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:16px;">$'+(ep/12).toFixed(2)+'/month &middot; '+td+'-day free trial</div><div style="text-align:left;font-size:0.85rem;color:var(--text-secondary);line-height:2;">&#x2705; '+td+'-day free trial<br>&#x2705; Unlimited flashcards (SM-2)<br>&#x2705; Unlimited practice exams<br>&#x2705; Full diagnostic assessment<br>&#x2705; Personalized study plan<br>&#x2705; Cram mode &amp; quick quizzes<br>&#x2705; Detailed analytics<br>&#x2705; Formula quick reference<br>&#x2705; Exam score predictor</div></div>'+
      '<div style="background:var(--bg-input);border:2px solid #8b5cf6;border-radius:var(--radius);padding:32px;text-align:center;position:relative;"><div style="position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:#8b5cf6;color:#fff;padding:4px 16px;border-radius:20px;font-size:0.75rem;font-weight:700;">BEST VALUE</div><div style="font-weight:800;font-size:1.3rem;color:#8b5cf6;">Elite Group</div><div style="font-size:2.5rem;font-weight:900;margin:12px 0;">$<span id="groupPerStudent">'+pp+'</span><span style="font-size:0.9rem;font-weight:400;color:var(--text-secondary);">/student/yr</span></div><div style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:8px;" id="groupTotalDisplay">'+gs+' students &middot; $'+tt+' total &middot; Save '+svp+'%</div>'+
      '<div style="margin:20px 0;padding:16px;background:rgba(139,92,246,0.1);border-radius:var(--radius);border:1px solid rgba(139,92,246,0.2);"><div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:8px;">Number of students:</div><div style="display:flex;align-items:center;gap:12px;"><span style="font-size:0.85rem;color:var(--text-muted);">2</span><input type="range" id="groupSlider" min="2" max="'+gm+'" value="'+gs+'" oninput="OwnerDashboard.updateGroupSlider(this.value)" class="range-purple" style="flex:1;"><span style="font-size:0.85rem;color:var(--text-muted);">'+gm+'</span></div><div style="display:flex;justify-content:center;margin-top:8px;"><span style="font-size:1.8rem;font-weight:900;color:#8b5cf6;" id="groupSliderCount">'+gs+'</span><span style="font-size:0.85rem;color:var(--text-secondary);margin-left:6px;margin-top:12px;">students</span></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;"><div style="background:rgba(139,92,246,0.15);padding:12px;border-radius:var(--radius-sm);text-align:center;"><div style="font-size:1.5rem;font-weight:800;color:#8b5cf6;" id="groupPerStudentLarge">$'+pp+'</div><div style="font-size:0.7rem;color:var(--text-muted);">per student / year</div></div><div style="background:rgba(34,197,94,0.15);padding:12px;border-radius:var(--radius-sm);text-align:center;"><div style="font-size:1.5rem;font-weight:800;color:#22c55e;" id="groupTotalLarge">$'+tt+'</div><div style="font-size:0.7rem;color:var(--text-muted);">total / year</div></div></div><div style="margin-top:8px;font-size:0.8rem;color:#22c55e;text-align:center;" id="groupSavingsDisplay">Save $'+sv+' ('+svp+'%) vs individual</div></div>'+
      '<div style="text-align:left;font-size:0.85rem;color:var(--text-secondary);line-height:2;">&#x2705; Everything in Elite<br>&#x2705; Bundle discount (up to '+maxSv+'% off)<br>&#x2705; One invoice for all students<br>&#x2705; Group progress dashboard<br>&#x2705; Priority support</div></div></div></div>'+
      '<div class="oa-section"><h3>&#x1F4CA; Group Pricing Table</h3><div style="overflow-x:auto;"><table class="oa-table"><thead><tr><th>Students</th><th>Per Student</th><th>Total/Year</th><th>vs Individual</th><th>Savings</th></tr></thead><tbody>'+tableNums.map(n=>{const p=PRICING.group.getPrice(n),t=p*n,s=ep*n-t;return '<tr><td><strong>'+n+'</strong></td><td>$'+p+'</td><td style="font-weight:600;">$'+t+'</td><td style="color:var(--text-muted);">$'+ep*n+'</td><td style="color:#22c55e;font-weight:600;">-$'+s+' ('+Math.round(s/(ep*n)*100)+'%)</td></tr>';}).join('')+'</tbody></table></div></div>'+
      // PROMO CODES SECTION
      '<div class="oa-section"><h3>&#x1F3AB; Promo Codes</h3><p style="color:var(--text-secondary);margin-bottom:16px;">Create and manage promotional codes for students.</p>'+
      '<div style="background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:20px;">'+
      '<div style="font-weight:700;margin-bottom:12px;">&#x2795; Add New Code</div>'+
      '<div class="oa-grid" style="grid-template-columns:1fr 1fr 1fr 1fr auto;gap:10px;align-items:end;">'+
      '<div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Code</label><input type="text" id="newPromoCode" placeholder="e.g. SPARK20" style="width:100%;padding:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);text-transform:uppercase;"></div>'+
      '<div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Type</label><select id="newPromoType" style="width:100%;padding:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);"><option value="percent">% Off</option><option value="flat">$ Off</option><option value="trial_extend">Extra Trial Days</option><option value="free">Free Access (1yr)</option></select></div>'+
      '<div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Value</label><input type="number" id="newPromoValue" placeholder="20" min="0" style="width:100%;padding:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);"></div>'+
      '<div><label style="font-size:0.7rem;color:var(--text-muted);display:block;margin-bottom:4px;">Max Uses (0=unlimited)</label><input type="number" id="newPromoMax" placeholder="0" min="0" style="width:100%;padding:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);"></div>'+
      '<button class="btn btn-primary btn-sm" onclick="OwnerDashboard.addPromo()" style="height:38px;">Add</button>'+
      '</div></div>'+
      (promos.length>0?'<table class="oa-table"><thead><tr><th>Code</th><th>Type</th><th>Value</th><th>Uses</th><th>Max</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>'+promos.map(p=>{
        const typeLabel=p.type==='percent'?'% Off':p.type==='flat'?'$ Off':p.type==='trial_extend'?'Trial +Days':p.type==='free'?'Free Access':p.type;
        const valLabel=p.type==='percent'?p.value+'%':p.type==='flat'?'$'+p.value:p.type==='trial_extend'?'+'+p.value+'d':p.type==='free'?'1 Year':'--';
        const statusBadge=p.active?'<span class="oa-badge oa-badge-active">Active</span>':'<span class="oa-badge oa-badge-inactive">Disabled</span>';
        return '<tr><td><strong style="font-family:monospace;letter-spacing:1px;">'+p.code+'</strong></td><td>'+typeLabel+'</td><td>'+valLabel+'</td><td>'+p.uses+'</td><td>'+(p.maxUses||'&infin;')+'</td><td>'+statusBadge+'</td><td style="font-size:0.8rem;">'+new Date(p.created).toLocaleDateString()+'</td><td style="white-space:nowrap;"><button class="btn btn-ghost btn-sm" onclick="OwnerDashboard.togglePromo(\''+p.code+'\')">'+(p.active?'Disable':'Enable')+'</button> <button class="btn btn-ghost btn-sm" style="color:#ef4444;" onclick="OwnerDashboard.deletePromo(\''+p.code+'\')">Delete</button></td></tr>';}).join('')+'</tbody></table>':'<p style="color:var(--text-muted);text-align:center;padding:30px;">No promo codes yet. Add one above.</p>')+'</div>';
  },

  savePricing() {
    PRICING.elite.price = parseInt(document.getElementById('editElitePrice').value) || 99;
    PRICING.elite.trialDays = parseInt(document.getElementById('editTrialDays').value) || 7;
    PRICING.group.maxStudents = parseInt(document.getElementById('editGroupMax').value) || 15;
    PRICING.group.minPrice = parseInt(document.getElementById('editGroupMin').value) || 42;
    PRICING.save();
    showToast('Pricing updated!', 'success');
  },

  addPromo() {
    const code = document.getElementById('newPromoCode').value.trim();
    const type = document.getElementById('newPromoType').value;
    const value = parseFloat(document.getElementById('newPromoValue').value) || 0;
    const maxUses = parseInt(document.getElementById('newPromoMax').value) || 0;
    if (!code) return showToast('Enter a promo code', 'error');
    if (type !== 'free' && value <= 0) return showToast('Enter a value', 'error');
    if (PromoCodes.add(code, type, value, maxUses)) {
      showToast('Promo code "' + code.toUpperCase() + '" created!', 'success');
      SiteAnalytics.track('promo_created', { code: code.toUpperCase(), type, value });
      this.render();
    } else {
      showToast('Code already exists', 'error');
    }
  },
  togglePromo(code) { PromoCodes.toggle(code); this.render(); },
  deletePromo(code) { PromoCodes.remove(code); showToast('Deleted', 'info'); this.render(); },

  assignGroup() {
    const gid = document.getElementById('assignGroupId').value.trim();
    const emailsRaw = document.getElementById('assignEmails').value.trim();
    if (!gid) return showToast('Enter a group name', 'error');
    if (!emailsRaw) return showToast('Enter student emails', 'error');
    const emails = emailsRaw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    let assigned = 0;
    emails.forEach(email => {
      const st = Storage.findByEmail(email);
      if (st) {
        if (!st.user.subscription) st.user.subscription = {};
        st.user.subscription.groupId = gid;
        st.user.subscription.groupSize = emails.length;
        st.user.subscription.plan = 'paid';
        st.user.subscription.status = 'paid';
        Storage.set(st);
        assigned++;
      }
    });
    if (assigned > 0) {
      showToast(assigned + ' student(s) assigned to group "' + gid + '"', 'success');
      SiteAnalytics.track('group_assigned', { groupId: gid, count: assigned });
      this.render();
    } else {
      showToast('No matching students found. Make sure emails are correct.', 'error');
    }
  },
  removeFromGroups() {
    const emailsRaw = document.getElementById('assignEmails').value.trim();
    if (!emailsRaw) return showToast('Enter student emails to remove from groups', 'error');
    const emails = emailsRaw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    let removed = 0;
    emails.forEach(email => {
      const st = Storage.findByEmail(email);
      if (st && st.user.subscription && st.user.subscription.groupId) {
        st.user.subscription.groupId = null;
        st.user.subscription.groupSize = null;
        Storage.set(st);
        removed++;
      }
    });
    showToast(removed + ' student(s) removed from groups', 'info');
    this.render();
  },

  updateGroupSlider(val) {
    val=parseInt(val);this.groupSliderVal=val;
    const ep=PRICING.elite.price,pp=PRICING.group.getPrice(val),tt=pp*val,sv=ep*val-tt,svp=Math.round(sv/(ep*val)*100);
    document.getElementById('groupPerStudent').textContent=pp;
    document.getElementById('groupSliderCount').textContent=val;
    document.getElementById('groupPerStudentLarge').textContent='$'+pp;
    document.getElementById('groupTotalLarge').textContent='$'+tt;
    document.getElementById('groupTotalDisplay').textContent=val+' students \u00B7 $'+tt+' total \u00B7 Save '+svp+'%';
    document.getElementById('groupSavingsDisplay').textContent='Save $'+sv+' ('+svp+'%) vs individual';
  },

  _tab_events(D) {
    const ic={signup:'&#x1F4DD;',login:'&#x1F511;',owner_login:'&#x1F451;',owner_analytics_login:'&#x1F4CA;',exam_complete:'&#x1F4DD;',diagnostic_complete:'&#x1F3AF;'};
    return '<div class="oa-section"><h3>&#x1F4DC; Events ('+D.recentEvents.length+')</h3>'+(D.recentEvents.length>0?'<div style="max-height:500px;overflow-y:auto;"><table class="oa-table"><thead><tr><th>Time</th><th>Event</th><th>Details</th></tr></thead><tbody>'+D.recentEvents.map(ev=>{const time=new Date(ev.timestamp).toLocaleString();const dets=Object.entries(ev).filter(([k])=>!['event','timestamp','date'].includes(k)).map(([k,v])=>k+': '+v).join(', ');return '<tr><td style="white-space:nowrap;font-size:0.8rem;">'+time+'</td><td>'+(ic[ev.event]||'&#x26A1;')+' '+ev.event+'</td><td style="font-size:0.8rem;color:var(--text-secondary);">'+dets+'</td></tr>';}).join('')+'</tbody></table></div>':'<p style="color:var(--text-muted);text-align:center;padding:40px;">No events yet.</p>')+'</div>';
  },

  _tab_export(D) {
    return '<div class="oa-section"><h3>&#x1F4E5; Export</h3><div class="oa-grid" style="grid-template-columns:repeat(3,1fr);">'+
      '<div style="background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);padding:24px;text-align:center;"><div style="font-size:2rem;">&#x1F4CA;</div><div style="font-weight:700;">Analytics</div><div style="font-size:0.8rem;color:var(--text-muted);margin:8px 0;">Visits, events, revenue</div><button class="btn btn-primary btn-sm" onclick="OwnerDashboard.exportAll()">Download</button></div>'+
      '<div style="background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);padding:24px;text-align:center;"><div style="font-size:2rem;">&#x1F465;</div><div style="font-weight:700;">Users</div><div style="font-size:0.8rem;color:var(--text-muted);margin:8px 0;">Students, progress, scores</div><button class="btn btn-primary btn-sm" onclick="OwnerDashboard.exportUsers()">Download</button></div>'+
      '<div style="background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius);padding:24px;text-align:center;"><div style="font-size:2rem;">&#x1F4BE;</div><div style="font-weight:700;">Full Backup</div><div style="font-size:0.8rem;color:var(--text-muted);margin:8px 0;">Everything combined</div><button class="btn btn-primary btn-sm" onclick="OwnerDashboard.exportFull()">Download</button></div></div></div>';
  },

  _renderDonut(items) {
    const total=items.reduce((s,i)=>s+i.value,0);if(total===0)return '<p style="color:var(--text-muted);">No data</p>';
    let cum=0;const r=60,cx=70,cy=70;
    const sl=items.filter(i=>i.value>0).map(item=>{const pct=item.value/total;const sa=cum*2*Math.PI-Math.PI/2;cum+=pct;const ea=cum*2*Math.PI-Math.PI/2;if(pct>=0.999)return '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="'+item.color+'" stroke-width="24"/>';return '<path d="M'+(cx+r*Math.cos(sa))+' '+(cy+r*Math.sin(sa))+' A'+r+' '+r+' 0 '+(pct>0.5?1:0)+' 1 '+(cx+r*Math.cos(ea))+' '+(cy+r*Math.sin(ea))+'" fill="none" stroke="'+item.color+'" stroke-width="24"/>';});
    return '<svg width="140" height="140" viewBox="0 0 140 140">'+sl.join('')+'<text x="'+cx+'" y="'+cy+'" text-anchor="middle" dy="5" fill="var(--text-primary)" font-size="20" font-weight="800">'+total+'</text></svg><div class="oa-legend">'+items.map(i=>'<div class="oa-legend-item"><div class="oa-legend-dot" style="background:'+i.color+';"></div> '+i.label+': <strong>'+i.value+'</strong> ('+Math.round(i.value/total*100)+'%)</div>').join('')+'</div>';
  },

  _renderFunnel(steps) {
    const max=Math.max(...steps.map(s=>s.value),1);
    return '<div style="display:flex;flex-direction:column;gap:8px;">'+steps.map((s,i)=>{const w=Math.max(s.value/max*100,15);const cr=i>0&&steps[i-1].value>0?Math.round(s.value/steps[i-1].value*100):100;return '<div style="display:flex;align-items:center;gap:12px;"><div style="width:90px;font-size:0.8rem;text-align:right;color:var(--text-secondary);">'+s.label+'</div><div style="flex:1;height:32px;background:var(--bg-input);border-radius:4px;overflow:hidden;"><div style="height:100%;width:'+w+'%;background:'+s.color+';border-radius:4px;display:flex;align-items:center;padding-left:8px;"><span style="font-size:0.8rem;font-weight:700;color:#fff;">'+s.value+'</span></div></div>'+(i>0?'<span style="font-size:0.75rem;color:var(--text-muted);width:36px;">'+cr+'%</span>':'<span style="width:36px;"></span>')+'</div>';}).join('')+'</div>';
  },

  _getUserMastery(st) {const cs=Object.values(st.flashcards||{}).filter(c=>c.lastReview);if(!cs.length)return 0;return Math.round(cs.reduce((s,c)=>s+c.correct/Math.max(c.correct+c.incorrect,1),0)/cs.length*100);},
  _timeAgo(ts) {const d=Date.now()-ts;if(d<60000)return 'Just now';if(d<3600000)return Math.floor(d/60000)+'m ago';if(d<86400000)return Math.floor(d/3600000)+'h ago';if(d<604800000)return Math.floor(d/86400000)+'d ago';return new Date(ts).toLocaleDateString();},

  async removeUser(uid) {
    const st = Storage.getUserById(uid);
    if (!st) return showToast('User not found', 'error');
    if (!confirm('Permanently remove ' + st.user.name + ' (' + st.user.email + ')?\n\nThis cannot be undone.')) return;
    // Remove from localStorage
    localStorage.removeItem('sparkstudy_v1_' + uid);
    // Remove from UserRegistry
    const reg = UserRegistry.getAll().filter(u => u.id !== uid);
    localStorage.setItem('sparkstudy_users', JSON.stringify(reg));
    // Remove from Firebase
    await FireDB.deleteUser(uid);
    showToast(st.user.name + ' has been removed.', 'success');
    this.render();
  },

  async blockUser(uid) {
    const st = Storage.getUserById(uid);
    if (!st) return showToast('User not found', 'error');
    const isBanned = !!st.user.banned;
    const action = isBanned ? 'unblock' : 'block';
    if (!confirm((isBanned ? 'Unblock' : 'Block') + ' ' + st.user.name + '?\n\n' + (isBanned ? 'They will be able to log in again.' : 'They will be locked out immediately.'))) return;
    st.user.banned = !isBanned;
    localStorage.setItem('sparkstudy_v1_' + uid, JSON.stringify(st));
    // Update Firebase too
    await FireDB.updateUserField(uid, { banned: st.user.banned });
    showToast(st.user.name + ' has been ' + action + 'ed.', 'success');
    this.render();
  },

  async clearAllTrafficData() {
    if (!confirm('Clear ALL traffic data?\n\nThis will permanently delete all visit logs from localStorage and Firebase. This cannot be undone.')) return;
    // Clear localStorage analytics
    const blank = SiteAnalytics._default ? SiteAnalytics._default() : { visits:[], pageViews:[], dailyVisits:{}, totalVisits:0, uniqueVisitors:{}, events:[], revenue:{total:0,transactions:[]}, funnelData:{landing:0,signup:0,diagnostic:0,dashboard:0,flashcards:0,exams:0} };
    localStorage.setItem(ANALYTICS_KEY, JSON.stringify(blank));
    // Clear Firebase visits collection
    showToast('Clearing Firebase visit data...', 'info');
    await FireDB.clearVisits();
    this._cloudVisits = [];
    showToast('All traffic data cleared.', 'success');
    this.render();
  },

  exportAll() {const d={analytics:SiteAnalytics.getData(),users:UserRegistry.getAll(),date:new Date().toISOString()};const b=new Blob([JSON.stringify(d,null,2)],{type:'application/json'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download='sparkystudy-analytics-'+new Date().toISOString().slice(0,10)+'.json';a.click();URL.revokeObjectURL(u);showToast('Exported!','success');},
  exportUsers() {const d=Storage.getAllUsers().map(s=>({...s,user:{...s.user,password:'[REDACTED]'}}));const b=new Blob([JSON.stringify(d,null,2)],{type:'application/json'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download='sparkystudy-users-'+new Date().toISOString().slice(0,10)+'.json';a.click();URL.revokeObjectURL(u);showToast('Exported!','success');},
  exportFull() {const d={analytics:SiteAnalytics.getData(),registry:UserRegistry.getAll(),users:Storage.getAllUsers().map(s=>({...s,user:{...s.user,password:'[REDACTED]'}})),date:new Date().toISOString()};const b=new Blob([JSON.stringify(d,null,2)],{type:'application/json'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download='sparkystudy-backup-'+new Date().toISOString().slice(0,10)+'.json';a.click();URL.revokeObjectURL(u);showToast('Exported!','success');},

  generateTestData() {
    const names = ['Alex Johnson','Sarah Miller','Jake Thompson','Emma Davis','Ryan Wilson','Olivia Brown','Liam Garcia','Mia Anderson','Noah Martinez','Ava Taylor'];
    const topicIds = Object.keys(TOPICS);
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const name = names[i];
      const email = name.toLowerCase().replace(' ','.') + '@test.com';
      if (Storage.findByEmail(email)) continue;
      const period = Math.random() > 0.5 ? 1 : 2;
      const state = Storage.createDefault(name, email, 'test123', period);
      // Simulate completed diagnostic
      const diagPct = Math.floor(Math.random() * 60) + 30;
      state.diagnostic.completed = true;
      state.diagnostic.pct = diagPct;
      state.diagnostic.completedDate = now - Math.floor(Math.random() * 14) * 86400000;
      state.diagnostic.weakAreas = topicIds.slice(0, Math.floor(Math.random() * 5) + 2);
      // Simulate some flashcard progress
      const fcIds = Object.keys(state.flashcards);
      const reviewCount = Math.floor(Math.random() * 40) + 10;
      for (let j = 0; j < Math.min(reviewCount, fcIds.length); j++) {
        const fc = state.flashcards[fcIds[j]];
        fc.correct = Math.floor(Math.random() * 8);
        fc.incorrect = Math.floor(Math.random() * 4);
        fc.lastReview = now - Math.floor(Math.random() * 7) * 86400000;
        fc.reps = fc.correct + fc.incorrect;
        fc.ease = 2.0 + Math.random() * 1.5;
      }
      // Simulate exam attempts
      const examCount = Math.floor(Math.random() * 4) + 1;
      for (let j = 0; j < examCount; j++) {
        const pct = Math.floor(Math.random() * 50) + 40;
        const total = 50;
        state.exams.attempts.push({ date: now - Math.floor(Math.random() * 10) * 86400000, pct, correct: Math.round(pct/100*total), total, timeSpent: (Math.random()*30+10)*60000 });
      }
      // Simulate session data
      state.sessions.streak = Math.floor(Math.random() * 12);
      state.sessions.totalTime = Math.floor(Math.random() * 300) * 60000;
      state.user.lastLogin = now - Math.floor(Math.random() * 5) * 86400000;
      state.user.signupDate = now - Math.floor(Math.random() * 21 + 3) * 86400000;
      state.user.subscription.status = Math.random() > 0.7 ? 'paid' : 'trial';
      if (state.user.subscription.status === 'paid') state.user.subscription.plan = 'paid';
      Storage.set(state);
      // Simulate visits
      for (let v = 0; v < Math.floor(Math.random() * 8) + 2; v++) {
        SiteAnalytics.trackVisit(state.user.id);
        SiteAnalytics.trackPageView(['dashboard','flashcards','exams','analytics'][Math.floor(Math.random()*4)], state.user.id);
      }
    }
    showToast('5 test students generated!', 'success');
    this.render();
  },
  clearTestData() {
    const testEmails = ['alex.johnson@test.com','sarah.miller@test.com','jake.thompson@test.com','emma.davis@test.com','ryan.wilson@test.com'];
    testEmails.forEach(email => {
      const st = Storage.findByEmail(email);
      if (st) {
        localStorage.removeItem(STORAGE_KEY + '_' + st.user.id);
        const reg = UserRegistry.getAll().filter(u => u.email !== email);
        localStorage.setItem(USERS_KEY, JSON.stringify(reg));
      }
    });
    showToast('Test data cleared', 'info');
    this.render();
  }
};

// ===== MOBILE NAV TOGGLE (burger → open drawer) =====
function toggleMobileNav() { openMobileDrawer(); }

function openMobileDrawer() {
  document.getElementById('mobileDrawer').classList.add('open');
  document.getElementById('drawerOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeMobileDrawer() {
  document.getElementById('mobileDrawer').classList.remove('open');
  document.getElementById('drawerOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

// Populate the drawer nav based on login state
function updateMobileDrawer(state, activePage) {
  const drawerUser = document.getElementById('drawerUser');
  const drawerAvatar = document.getElementById('drawerAvatar');
  const drawerName = document.getElementById('drawerName');
  const drawerStreak = document.getElementById('drawerStreak');
  const drawerNav = document.getElementById('drawerNav');
  const bottomNav = document.getElementById('bottomNav');

  const publicPages = ['landing','login','signup','diagnostic'];
  const isMobile = window.innerWidth <= 768;

  if (!state) {
    // Not logged in — hide drawer user, hide bottom nav
    if (drawerUser) drawerUser.style.display = 'none';
    if (bottomNav) bottomNav.classList.remove('bn-visible');
    if (drawerNav) drawerNav.innerHTML = `
      <div class="mobile-drawer-section-label">Account</div>
      <button class="mobile-drawer-item" onclick="App.navigate('login');closeMobileDrawer();">
        <span class="mdi">🔑</span> Log In
      </button>
      <button class="mobile-drawer-item" onclick="App.navigate('signup');closeMobileDrawer();">
        <span class="mdi">✨</span> Sign Up
      </button>`;
    return;
  }

  // Logged in — show user info
  if (drawerUser) drawerUser.style.display = 'flex';
  if (drawerAvatar) drawerAvatar.textContent = (state.user.name || '?')[0].toUpperCase();
  if (drawerName) drawerName.textContent = state.user.name || 'Student';
  if (drawerStreak) drawerStreak.textContent = state.sessions.streak || 0;

  // Show bottom nav on mobile
  if (bottomNav && isMobile) bottomNav.classList.add('bn-visible');

  // Update bottom nav active states
  const bnPages = ['dashboard','flashcards','exams','lessons'];
  bnPages.forEach(p => {
    const el = document.getElementById('bn-' + p);
    if (el) el.classList.toggle('active', activePage === p);
  });
  const moreBn = document.getElementById('bn-more');
  if (moreBn) moreBn.classList.toggle('active', !bnPages.includes(activePage));

  // Build drawer nav items
  const navItems = [
    { section: 'Study' },
    { page: 'dashboard', icon: '🏠', label: 'Dashboard' },
    { page: 'flashcards', icon: '🃏', label: 'Flashcards' },
    { page: 'exams', icon: '📝', label: 'Exams' },
    { page: 'lessons', icon: '📚', label: 'Lessons' },
    { page: 'study-guide', icon: '📖', label: 'Study Guide' },
    { page: 'notes', icon: '📝', label: 'My Notes' },
    { section: 'Tools & Insights' },
    { page: 'tools', icon: '🔧', label: 'Simulators' },
    { page: 'math', icon: '🧮', label: 'Math Practice' },
    { page: 'leaderboard', icon: '🏆', label: 'Leaderboard' },
    { page: 'analytics', icon: '📊', label: 'Analytics' },
    { page: 'review', icon: '⭐', label: 'Review Wrong' },
    { section: 'Account' },
    { page: 'settings', icon: '⚙️', label: 'Settings' },
  ];
  if (state.user.isOwner) {
    navItems.splice(navItems.findIndex(i => i.section === 'Account'), 0,
      { page: 'owner', icon: '👑', label: 'Owner Analytics' });
  }
  if (state.user.subscription && state.user.subscription.groupId) {
    navItems.splice(navItems.findIndex(i => i.page === 'settings'), 0,
      { page: 'group', icon: '👥', label: 'Group' });
  }

  drawerNav.innerHTML = navItems.map(item => {
    if (item.section) return `<div class="mobile-drawer-section-label">${item.section}</div>`;
    const active = activePage === item.page ? ' active' : '';
    return `<button class="mobile-drawer-item${active}" onclick="App.navigate('${item.page}');closeMobileDrawer();">
      <span class="mdi">${item.icon}</span> ${item.label}
    </button>`;
  }).join('');
}

// Expose so App.navigate can call it
window._updateMobileDrawer = updateMobileDrawer;

// ===== EXAM SCORE PREDICTOR =====
function getExamPrediction(state) {
  const topics = getTopicsForPeriod(state.user.period);
  if (topics.length === 0) return null;
  let totalWeight = 0, weightedScore = 0;
  topics.forEach(t => {
    const cards = FLASHCARD_BANK.filter(fc => fc.topic === t.id).length;
    const mastery = getTopicMastery(state, t.id);
    // Weight by number of exam questions for that topic
    const examQs = EXAM_BANK.filter(eq => eq.topic === t.id).length;
    const weight = Math.max(1, examQs);
    totalWeight += weight;
    // Mastery maps to estimated exam performance (with some noise floor)
    const estimated = Math.min(100, mastery * 0.85 + 10); // 10% base + 85% of mastery
    weightedScore += estimated * weight;
  });
  return totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 0;
}

// ===== MATH PRACTICE =====
const MathPractice = {
  currentCategory: 'ohms-law',
  currentProblem: null,
  score: 0,
  attempts: 0,
  showingSolution: false,
  showingConfig: false,

  categories: [
    { id:'ohms-law',       name:"Ohm's Law",          icon:'⚡', period:1, formula:'V = IR' },
    { id:'power',          name:'Power',               icon:'💡', period:1, formula:'P = VI = I²R = V²/R' },
    { id:'series',         name:'Series Circuits',     icon:'➡️', period:1, formula:'Rt = R1+R2+... Vt = V1+V2+...' },
    { id:'parallel',       name:'Parallel Circuits',   icon:'⑂',  period:1, formula:'1/Rt = 1/R1+1/R2+...' },
    { id:'series-parallel',name:'Series-Parallel',     icon:'🔧', period:1, formula:'Combined Rt, V drops, I' },
    { id:'ac-basics',      name:'AC Basics',           icon:'📈', period:2, formula:'Vrms = Vp×0.707, f = 1/T' },
    { id:'reactance',      name:'Reactance (XL & XC)', icon:'🌊', period:2, formula:'XL=2πfL, XC=1/(2πfC)' },
    { id:'impedance',      name:'Impedance',           icon:'📐', period:2, formula:'Z = √(R²+X²)' },
    { id:'power-factor',   name:'Power Factor',        icon:'📊', period:2, formula:'PF=cosθ, P=S×PF, S=VI' },
    { id:'transformers',   name:'Transformers',        icon:'🔁', period:2, formula:'V1/V2 = N1/N2 = I2/I1' },
    { id:'motors',         name:'Motor Speed & Slip',  icon:'⚙️', period:2, formula:'Ns=120f/P, slip=(Ns-Nr)/Ns' },
    { id:'three-phase',    name:'Three-Phase',         icon:'🔺', period:2, formula:'VL=√3×Vp (wye), IL=√3×Ip (delta)' },
  ],

  // Maps each math category to its actual lesson/study content.
  // type:'lessons' → opens a specific lesson module by module ID (m1, m2, etc.)
  // type:'study-guide' → opens the Study Guide for that topic (period 1 content or modules without a written lesson yet)
  _studyTopicMap: {
    // Period 1 — Study Guide only (no MODULES exist for period 1)
    'ohms-law':       { type:'study-guide', id:'ohms-law',          label:"Ohm's Law & Basic Theory" },
    'power':          { type:'study-guide', id:'ohms-law',          label:"Ohm's Law & Basic Theory" },
    'series':         { type:'study-guide', id:'series-circuits',   label:'Series Circuits' },
    'parallel':       { type:'study-guide', id:'parallel-circuits', label:'Parallel Circuits' },
    'series-parallel':{ type:'study-guide', id:'series-circuits',   label:'Series Circuits' },
    // Period 2 — real curriculum modules (hasContent:true)
    'ac-basics':      { type:'lessons', id:'m1',  label:'Fundamentals of Alternating Current' },
    'reactance':      { type:'lessons', id:'m2',  label:'Properties of Inductors and Capacitors' },
    'impedance':      { type:'lessons', id:'m3',  label:'Inductors and Capacitors in Circuits' },
    'three-phase':    { type:'lessons', id:'m4',  label:'Principles of AC Circuits' },
    // Period 2 — Study Guide fallback (no written lesson module yet)
    'power-factor':   { type:'study-guide', id:'power-factor', label:'Power Factor' },
    'transformers':   { type:'study-guide', id:'transformers', label:'Transformers' },
    'motors':         { type:'study-guide', id:'motors',       label:'Motors & Generators' },
  },

  openLesson(catId) {
    const mapping = this._studyTopicMap[catId];
    if (!mapping) { App.navigate('study-guide'); return; }
    if (mapping.type === 'lessons') {
      Lessons.activeLesson = mapping.id;
      App.navigate('lessons');
    } else {
      StudyGuide.currentTopic = mapping.id;
      StudyGuide.currentLesson = 0;
      App.navigate('study-guide');
    }
    window.scrollTo(0, 0);
  },

  _lessonLabel(catId) {
    const m = this._studyTopicMap[catId];
    return m ? m.label : 'Study Guide';
  },

  _r(min, max, step=1) { return Math.round((Math.random()*(max-min)+min)/step)*step; },
  _round(v, dp=2) { return Math.round(v*Math.pow(10,dp))/Math.pow(10,dp); },

  _getEnabledCategories(state) {
    const enabled = state && state.mathSettings && state.mathSettings.enabledCategories;
    if (!enabled) return this.categories; // all enabled
    return this.categories.filter(c => enabled.includes(c.id));
  },

  generateProblem(randomFromEnabled = false) {
    const state = Storage.get();
    if (randomFromEnabled) {
      const enabled = this._getEnabledCategories(state);
      if (enabled.length > 0) {
        this.currentCategory = enabled[Math.floor(Math.random() * enabled.length)].id;
      }
    }
    const gen = this['_gen_' + this.currentCategory.replace(/-/g,'_')];
    if (gen) this.currentProblem = gen.call(this);
    this.showingSolution = false;
    this.render(state);
  },

  toggleConfig() {
    this.showingConfig = !this.showingConfig;
    this.render(Storage.get());
  },

  toggleCategory(id) {
    const state = Storage.get();
    if (!state) return;
    if (!state.mathSettings) state.mathSettings = { enabledCategories: null };
    let enabled = state.mathSettings.enabledCategories;
    // null means all enabled — materialise the full list first
    if (!enabled) enabled = this.categories.map(c => c.id);
    if (enabled.includes(id)) {
      enabled = enabled.filter(e => e !== id);
      if (enabled.length === 0) enabled = this.categories.map(c => c.id); // never empty
    } else {
      enabled.push(id);
    }
    state.mathSettings.enabledCategories = enabled;
    Storage.set(state);
    this.render(state);
    FireDB.saveUser(state);
  },

  _setAll(enable) {
    const state = Storage.get();
    if (!state) return;
    if (!state.mathSettings) state.mathSettings = {};
    state.mathSettings.enabledCategories = enable ? null : [this.categories[0].id]; // null = all; keep at least one
    Storage.set(state);
    this.render(state);
    FireDB.saveUser(state);
  },

  _gen_ohms_law() {
    const type = this._r(0,2);
    if (type===0) { const V=this._r(12,480,12),R=this._r(1,200,5); return {q:`A circuit has a voltage of <strong>${V}V</strong> and a resistance of <strong>${R}Ω</strong>. What is the current?`,a:this._round(V/R),unit:'A',hint:'I = V ÷ R',formula:'I = V / R'}; }
    if (type===1) { const I=this._r(1,30),R=this._r(5,200,5); return {q:`A current of <strong>${I}A</strong> flows through a <strong>${R}Ω</strong> resistor. What is the voltage across it?`,a:this._round(I*R),unit:'V',hint:'V = I × R',formula:'V = I × R'}; }
    const V=this._r(12,480,12),I=this._r(1,20); return {q:`A <strong>${V}V</strong> source pushes <strong>${I}A</strong> through a resistor. What is the resistance?`,a:this._round(V/I),unit:'Ω',hint:'R = V ÷ I',formula:'R = V / I'};
  },

  _gen_power() {
    const type = this._r(0,3);
    if (type===0) { const V=this._r(12,240,12),I=this._r(1,20); return {q:`A load draws <strong>${I}A</strong> at <strong>${V}V</strong>. What is the power?`,a:this._round(V*I),unit:'W',hint:'P = V × I',formula:'P = V × I'}; }
    if (type===1) { const I=this._r(1,20),R=this._r(5,100,5); return {q:`A current of <strong>${I}A</strong> flows through a <strong>${R}Ω</strong> resistor. What power is dissipated?`,a:this._round(I*I*R),unit:'W',hint:'P = I² × R',formula:'P = I² × R'}; }
    if (type===2) { const V=this._r(12,240,12),R=this._r(5,100,5); return {q:`<strong>${V}V</strong> is applied across a <strong>${R}Ω</strong> resistor. What is the power?`,a:this._round(V*V/R),unit:'W',hint:'P = V² ÷ R',formula:'P = V² / R'}; }
    const P=this._r(100,2400,100),V=this._r(120,240,120); return {q:`A <strong>${P}W</strong> heater operates at <strong>${V}V</strong>. What current does it draw?`,a:this._round(P/V),unit:'A',hint:'I = P ÷ V',formula:'I = P / V'};
  },

  _gen_series() {
    const type = this._r(0,2);
    if (type===0) { const R1=this._r(5,100,5),R2=this._r(5,100,5),R3=this._r(5,100,5); return {q:`Three resistors <strong>R1=${R1}Ω, R2=${R2}Ω, R3=${R3}Ω</strong> are connected in series. What is the total resistance?`,a:R1+R2+R3,unit:'Ω',hint:'Add all resistors: Rt = R1+R2+R3',formula:'Rt = R1 + R2 + R3'}; }
    if (type===1) { const V=this._r(12,120,12),R1=this._r(10,50,10),R2=this._r(10,50,10); const I=this._round(V/(R1+R2)); return {q:`<strong>${V}V</strong> is applied across a series circuit with <strong>R1=${R1}Ω</strong> and <strong>R2=${R2}Ω</strong>. What is the current?`,a:I,unit:'A',hint:'Find Rt first, then I = V ÷ Rt',formula:'I = V / (R1+R2)'}; }
    const V=this._r(24,120,12),R1=this._r(10,40,10),R2=this._r(10,40,10); const I=V/(R1+R2); return {q:`In a series circuit with <strong>${V}V</strong>, <strong>R1=${R1}Ω</strong>, and <strong>R2=${R2}Ω</strong>, what is the voltage drop across R1?`,a:this._round(I*R1),unit:'V',hint:'Find I first (I=V/Rt), then V1 = I × R1',formula:'V1 = I × R1'};
  },

  _gen_parallel() {
    const type = this._r(0,2);
    if (type===0) { const R1=this._r(10,100,10),R2=this._r(10,100,10); const Rt=this._round((R1*R2)/(R1+R2)); return {q:`Two resistors <strong>R1=${R1}Ω</strong> and <strong>R2=${R2}Ω</strong> are in parallel. What is the total resistance?`,a:Rt,unit:'Ω',hint:'Use the product-over-sum formula: Rt = (R1×R2)/(R1+R2)',formula:'Rt = (R1×R2) / (R1+R2)'}; }
    if (type===1) { const V=this._r(12,120,12),R1=this._r(10,60,10),R2=this._r(10,60,10); const I1=this._round(V/R1),I2=this._round(V/R2); return {q:`<strong>${V}V</strong> is applied to a parallel circuit with <strong>R1=${R1}Ω</strong> and <strong>R2=${R2}Ω</strong>. What is the total current?`,a:this._round(I1+I2),unit:'A',hint:'Each branch: I=V/R. Total: It=I1+I2',formula:'It = V/R1 + V/R2'}; }
    const V=this._r(24,120,12),R1=this._r(10,60,10),R2=this._r(10,60,10); return {q:`A parallel circuit has <strong>${V}V</strong> across branches <strong>R1=${R1}Ω</strong> and <strong>R2=${R2}Ω</strong>. What current flows through R2?`,a:this._round(V/R2),unit:'A',hint:'In parallel, same voltage across all branches. I2 = V / R2',formula:'I2 = V / R2'};
  },

  _gen_series_parallel() {
    const R1=this._r(10,50,10),R2=this._r(10,50,10),R3=this._r(10,50,10),V=this._r(24,120,12);
    const Rp=this._round((R2*R3)/(R2+R3)); const Rt=this._round(R1+Rp); const I=this._round(V/Rt);
    const type=this._r(0,1);
    if(type===0) return {q:`R1=${R1}Ω is in series with parallel combination of R2=${R2}Ω and R3=${R3}Ω. Source is <strong>${V}V</strong>. What is the total current?`,a:I,unit:'A',hint:'Find Rparallel=(R2×R3)/(R2+R3), then Rt=R1+Rp, then I=V/Rt',formula:'Rp=(R2×R3)/(R2+R3), Rt=R1+Rp, I=V/Rt'};
    return {q:`R1=${R1}Ω is in series with parallel combination of R2=${R2}Ω and R3=${R3}Ω. Source is <strong>${V}V</strong>. What is the total resistance?`,a:Rt,unit:'Ω',hint:'Rp=(R2×R3)/(R2+R3), then Rt=R1+Rp',formula:'Rt = R1 + (R2×R3)/(R2+R3)'};
  },

  _gen_ac_basics() {
    const type=this._r(0,3);
    if(type===0){ const Vp=this._r(100,400,10); return {q:`A sine wave has a peak voltage of <strong>${Vp}V</strong>. What is the RMS voltage?`,a:this._round(Vp*0.7071),unit:'V',hint:'Vrms = Vpeak × 0.7071',formula:'Vrms = Vpeak × 0.7071'}; }
    if(type===1){ const Vr=this._r(100,250,10); return {q:`The RMS voltage of a circuit is <strong>${Vr}V</strong>. What is the peak voltage?`,a:this._round(Vr*1.4142),unit:'V',hint:'Vpeak = Vrms × 1.414',formula:'Vpeak = Vrms × 1.414'}; }
    if(type===2){ const T=this._r(10,100,5); return {q:`A sine wave has a period of <strong>${T}ms</strong>. What is its frequency?`,a:this._round(1000/T,1),unit:'Hz',hint:'f = 1 / T (convert ms to seconds first)',formula:'f = 1/T'}; }
    const f=this._r(10,120,10); return {q:`A signal has a frequency of <strong>${f}Hz</strong>. What is its period?`,a:this._round(1000/f,2),unit:'ms',hint:'T = 1/f (then convert to ms)',formula:'T = 1/f × 1000ms'};
  },

  _gen_reactance() {
    const type=this._r(0,1);
    if(type===0){ const f=this._r(30,120,10),L=this._r(10,500,10); return {q:`An inductor of <strong>${L}mH</strong> is connected to a <strong>${f}Hz</strong> supply. What is its inductive reactance?`,a:this._round(2*Math.PI*f*(L/1000)),unit:'Ω',hint:'XL = 2π × f × L (convert mH to H)',formula:'XL = 2πfL'}; }
    const f=this._r(30,120,10),C=this._r(10,500,10); return {q:`A capacitor of <strong>${C}μF</strong> is connected to a <strong>${f}Hz</strong> supply. What is its capacitive reactance?`,a:this._round(1/(2*Math.PI*f*(C/1000000))),unit:'Ω',hint:'XC = 1 ÷ (2π × f × C) (convert μF to F)',formula:'XC = 1/(2πfC)'};
  },

  _gen_impedance() {
    const type=this._r(0,1);
    const R=this._r(10,100,10);
    if(type===0){ const XL=this._r(10,150,10); return {q:`A series RL circuit has R=<strong>${R}Ω</strong> and XL=<strong>${XL}Ω</strong>. What is the impedance?`,a:this._round(Math.sqrt(R*R+XL*XL)),unit:'Ω',hint:'Z = √(R² + XL²)',formula:'Z = √(R² + X²)'}; }
    const XC=this._r(10,150,10); return {q:`A series RC circuit has R=<strong>${R}Ω</strong> and XC=<strong>${XC}Ω</strong>. What is the impedance?`,a:this._round(Math.sqrt(R*R+XC*XC)),unit:'Ω',hint:'Z = √(R² + XC²)',formula:'Z = √(R² + X²)'};
  },

  _gen_power_factor() {
    const type=this._r(0,2);
    if(type===0){ const pf=this._round(this._r(70,99)/100,2),S=this._r(1000,10000,500); return {q:`A load has an apparent power of <strong>${S}VA</strong> and a power factor of <strong>${pf}</strong>. What is the true power?`,a:this._round(S*pf),unit:'W',hint:'P = S × PF',formula:'P = S × PF'}; }
    if(type===1){ const R=this._r(10,80,10),X=this._r(10,80,10); const Z=Math.sqrt(R*R+X*X); return {q:`A circuit has R=<strong>${R}Ω</strong> and X=<strong>${X}Ω</strong>. What is the power factor?`,a:this._round(R/Z,3),unit:'(decimal)',hint:'PF = R / Z (where Z = √(R²+X²))',formula:'PF = cos θ = R/Z'}; }
    const V=this._r(120,600,120),I=this._r(5,40,5); return {q:`A circuit has <strong>${V}V</strong> and <strong>${I}A</strong>. What is the apparent power?`,a:this._round(V*I),unit:'VA',hint:'S = V × I',formula:'S = V × I'};
  },

  _gen_transformers() {
    const type=this._r(0,2);
    const N1=this._r(100,2000,100),N2=this._r(50,500,50);
    if(type===0){ const V1=this._r(120,4800,120); return {q:`A transformer has <strong>${N1} primary turns</strong> and <strong>${N2} secondary turns</strong>. Primary voltage is <strong>${V1}V</strong>. What is the secondary voltage?`,a:this._round(V1*N2/N1),unit:'V',hint:'V2 = V1 × (N2/N1)',formula:'V1/V2 = N1/N2'}; }
    if(type===1){ const V1=this._r(240,4800,240),V2=this._r(12,240,12); const ratio=this._round(V1/V2,1); return {q:`A transformer steps down from <strong>${V1}V</strong> to <strong>${V2}V</strong>. What is the turns ratio (N1:N2)?`,a:ratio,unit:':1',hint:'Turns ratio = V1 / V2',formula:'N1/N2 = V1/V2'}; }
    const V1=this._r(240,4800,240),N1b=this._r(200,2000,200),N2b=this._r(50,500,50),I2=this._r(5,50,5);
    return {q:`A transformer has turns ratio ${N1b}:${N2b}. If secondary current is <strong>${I2}A</strong>, what is the primary current?`,a:this._round(I2*N2b/N1b),unit:'A',hint:'I1 = I2 × (N2/N1) — primary current is inversely proportional to turns',formula:'I1/I2 = N2/N1'};
  },

  _gen_motors() {
    const type=this._r(0,1);
    if(type===0){ const f=60,P=this._r(2,8,2)*2; return {q:`A <strong>${P}-pole</strong> induction motor operates on <strong>60Hz</strong>. What is its synchronous speed?`,a:this._round(120*f/P),unit:'RPM',hint:'Ns = 120 × f / P',formula:'Ns = 120f / P'}; }
    const Ns=this._r(600,3600,300),slip=this._r(2,8);
    const Nr=Math.round(Ns*(1-slip/100));
    return {q:`A motor has synchronous speed <strong>${Ns}RPM</strong> and runs at <strong>${Nr}RPM</strong>. What is the slip percentage?`,a:slip,unit:'%',hint:'Slip = (Ns - Nr) / Ns × 100',formula:'Slip% = (Ns−Nr)/Ns × 100'};
  },

  _gen_three_phase() {
    const type=this._r(0,1);
    if(type===0){ const Vp=this._r(120,277,1); return {q:`In a <strong>wye (Y)</strong> connected system, the phase voltage is <strong>${Vp}V</strong>. What is the line voltage?`,a:this._round(Vp*Math.sqrt(3)),unit:'V',hint:'VL = Vp × √3 (√3 ≈ 1.732)',formula:'VL = Vp × √3'}; }
    const VL=this._r(208,600,100); return {q:`In a <strong>wye (Y)</strong> system, the line voltage is <strong>${VL}V</strong>. What is the phase voltage?`,a:this._round(VL/Math.sqrt(3)),unit:'V',hint:'Vp = VL ÷ √3 (√3 ≈ 1.732)',formula:'Vp = VL / √3'};
  },

  checkAnswer() {
    const input = document.getElementById('mathAnswer');
    if (!input || !this.currentProblem) return;
    const userVal = parseFloat(input.value.replace(/[^0-9.\-]/g,''));
    if (isNaN(userVal)) { showToast('Enter a number first', 'error'); return; }
    const correct = this.currentProblem.a;
    const tolerance = Math.abs(correct) * 0.02 + 0.01; // 2% tolerance
    const isCorrect = Math.abs(userVal - correct) <= tolerance;
    this.attempts++;
    // Track per-category stats
    const state = Storage.get();
    if (state) {
      if (!state.mathStats) state.mathStats = {};
      const catId = this.currentCategory;
      if (!state.mathStats[catId]) state.mathStats[catId] = { attempts: 0, correct: 0 };
      state.mathStats[catId].attempts++;
      if (isCorrect) state.mathStats[catId].correct++;
      Storage.set(state);
      FireDB.saveUser(state);
    }
    if (isCorrect) {
      this.score++;
      Points.award('Math problem solved', Points.ACTIONS.math_correct.base, true);
      showToast('✅ Correct! +2 pts', 'success');
    } else { showToast(`❌ Not quite. Answer: ${correct} ${this.currentProblem.unit}`, 'error'); }
    const pct = this.attempts > 0 ? Math.round(this.score/this.attempts*100) : 0;
    const scoreEl = document.getElementById('mathScore');
    if (scoreEl) scoreEl.textContent = `${this.score}/${this.attempts} (${pct}%)`;
    this.showingSolution = !isCorrect;
    const solEl = document.getElementById('mathSolution');
    if (solEl) solEl.style.display = this.showingSolution ? 'block' : 'none';
    if (isCorrect) setTimeout(() => this.generateProblem(), 1200);
  },

  render(state) {
    const container = document.getElementById('mathContent');
    if (!container) return;
    const cat = this.categories.find(c => c.id === this.currentCategory) || this.categories[0];
    const enabledCats = state && state.mathSettings && state.mathSettings.enabledCategories;
    const mathStats = (state && state.mathStats) || {};
    const enabledCount = enabledCats ? enabledCats.length : this.categories.length;
    const formulaLines = this._formulaRef(this.currentCategory);

    container.innerHTML = `
      <!-- Header -->
      <div style="margin-bottom:18px;">
        <h1 style="font-size:1.6rem;font-weight:900;margin-bottom:2px;">🧮 Math Practice</h1>
        <p style="color:var(--text-secondary);font-size:0.85rem;">Formulas are always shown. Pick only the modules you need.</p>
      </div>

      <!-- Module selector — always visible, chip-style toggles -->
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
          <span style="font-size:0.8rem;font-weight:700;color:var(--text-secondary);">
            MODULES — <span style="color:var(--accent);">${enabledCount} active</span>
          </span>
          <div style="display:flex;gap:6px;">
            <button onclick="MathPractice._setAll(true)" class="btn btn-ghost btn-sm" style="font-size:0.75rem;padding:4px 10px;">All on</button>
            <button onclick="MathPractice._setAll(false)" class="btn btn-ghost btn-sm" style="font-size:0.75rem;padding:4px 10px;">All off</button>
            <button onclick="MathPractice.generateProblem(true)" class="btn btn-primary btn-sm" style="font-size:0.75rem;padding:4px 12px;">🎲 Random</button>
          </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
          ${this.categories.map(c => {
            const isEnabled = !enabledCats || enabledCats.includes(c.id);
            const isActive = c.id === this.currentCategory;
            const s = mathStats[c.id] || { attempts:0, correct:0 };
            const acc = s.attempts > 0 ? Math.round(s.correct/s.attempts*100) : null;
            const accDot = acc === null ? '' : acc >= 80 ? ' 🟢' : acc >= 50 ? ' 🟡' : ' 🔴';
            return `<button onclick="MathPractice._chipClick('${c.id}', event)"
              data-chipid="${c.id}"
              title="${isEnabled ? 'Click to practice · Right-click to toggle on/off' : 'Disabled — click to enable & practice'}"
              style="padding:6px 12px;border-radius:20px;font-size:0.8rem;font-weight:${isActive?'700':'500'};
                border:2px solid ${isActive ? 'var(--accent)' : isEnabled ? 'var(--border)' : 'transparent'};
                background:${isActive ? 'var(--accent-soft)' : isEnabled ? 'var(--bg-secondary)' : 'rgba(0,0,0,0.3)'};
                color:${isActive ? 'var(--accent)' : isEnabled ? 'var(--text-primary)' : 'var(--text-muted)'};
                opacity:${isEnabled?'1':'0.5'};cursor:pointer;transition:var(--transition);white-space:nowrap;">
              ${c.icon} ${c.name}${accDot}
            </button>`;
          }).join('')}
        </div>
        <p style="font-size:0.72rem;color:var(--text-muted);margin-top:10px;">
          Tap a module to practice it. <strong>Long-press</strong> or <strong>right-click</strong> a chip to enable/disable it from the random rotation.
        </p>
      </div>

      <!-- Practice layout -->
      <div style="display:grid;grid-template-columns:1fr 300px;gap:20px;align-items:start;" class="math-layout">

        <!-- Main practice card -->
        <div>
          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:14px;">

            <!-- Active module label + score -->
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:1.3rem;">${cat.icon}</span>
                <div>
                  <div style="font-weight:700;font-size:1rem;">${cat.name}</div>
                  <div style="font-size:0.72rem;color:var(--text-muted);font-family:monospace;">${cat.formula}</div>
                </div>
              </div>
              <div style="font-size:0.85rem;color:var(--text-muted);">Score: <strong id="mathScore" style="color:var(--accent);">${this.score}/${this.attempts} (${this.attempts>0?Math.round(this.score/this.attempts*100):0}%)</strong></div>
            </div>

            ${this.currentProblem ? `
              <!-- Problem -->
              <div style="background:var(--bg-input);border-radius:10px;padding:18px;margin-bottom:16px;font-size:1.05rem;line-height:1.7;">
                ${this.currentProblem.q}
              </div>

              <!-- Answer row -->
              <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px;">
                <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:180px;">
                  <input id="mathAnswer" type="number" step="any" placeholder="Your answer…"
                    style="flex:1;padding:12px 14px;font-size:1.1rem;background:var(--bg-input);border:2px solid var(--accent);border-radius:10px;color:var(--text-primary);outline:none;"
                    onkeydown="if(event.key==='Enter')MathPractice.checkAnswer()">
                  <span style="font-weight:600;color:var(--text-secondary);">${this.currentProblem.unit}</span>
                </div>
                <button onclick="MathPractice.checkAnswer()" class="btn btn-primary" style="padding:12px 24px;font-size:1rem;">Check ✓</button>
                <button onclick="MathPractice.generateProblem()" class="btn btn-ghost btn-sm">Skip →</button>
              </div>

              <!-- Wrong answer feedback / hint -->
              <div id="mathSolution" style="display:${this.showingSolution?'block':'none'};background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:10px;padding:14px;font-size:0.88rem;">
                <strong>💡 Hint:</strong> ${this.currentProblem.hint}<br>
                <strong>Formula used:</strong> <code style="background:var(--bg-input);padding:2px 6px;border-radius:4px;">${this.currentProblem.formula}</code><br>
                <strong>Answer:</strong> <span style="color:var(--accent);font-weight:700;">${this.currentProblem.a} ${this.currentProblem.unit}</span>
              </div>
              <div style="display:flex;align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap;">
                ${!this.showingSolution ? `<button onclick="document.getElementById('mathSolution').style.display='block';this.style.display='none';" style="font-size:0.78rem;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:0;">💡 Show hint</button>` : ''}
                <button onclick="MathPractice.openLesson('${this.currentCategory}')" style="font-size:0.78rem;color:#818cf8;background:none;border:none;cursor:pointer;padding:0;display:flex;align-items:center;gap:4px;">
                  📖 ${this._lessonLabel(this.currentCategory)} →
                </button>
              </div>

            ` : `
              <div style="text-align:center;padding:32px 20px 24px;color:var(--text-muted);">
                <div style="font-size:3rem;margin-bottom:10px;">${cat.icon}</div>
                <p style="font-size:0.95rem;color:var(--text-primary);font-weight:600;">Ready to practice ${cat.name}</p>
                <p style="font-size:0.82rem;margin:4px 0 20px;">Formulas are on the right — hit Start when you're ready.</p>
                <button onclick="MathPractice.openLesson('${this.currentCategory}')"
                  style="display:inline-flex;align-items:center;gap:8px;padding:10px 18px;background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.35);border-radius:8px;cursor:pointer;font-size:0.85rem;color:#818cf8;font-weight:600;"
                  onmouseover="this.style.background='rgba(99,102,241,0.22)'" onmouseout="this.style.background='rgba(99,102,241,0.12)'">
                  📖 Not sure? Read: ${this._lessonLabel(this.currentCategory)}
                </button>
              </div>
            `}
          </div>

          <button onclick="MathPractice.generateProblem()" class="btn btn-primary" style="width:100%;font-size:1rem;padding:14px;">
            ${this.currentProblem ? '➡️ Next Problem' : '▶️ Start Practicing'}
          </button>
        </div>

        <!-- Formula sheet — always visible, right column -->
        <div style="position:sticky;top:74px;">
          <div style="background:var(--bg-card);border:2px solid var(--accent);border-radius:var(--radius);padding:18px;">
            <div style="font-size:0.72rem;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">📋 Formula Sheet — ${cat.name}</div>
            <div style="font-size:0.88rem;color:var(--text-primary);line-height:2;font-family:'Courier New',monospace;font-weight:500;">
              ${formulaLines}
            </div>
          </div>

          <!-- Link to the lesson page for this topic -->
          <button onclick="MathPractice.openLesson('${this.currentCategory}')"
            style="width:100%;margin-top:10px;padding:12px;background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.35);border-radius:var(--radius);cursor:pointer;text-align:left;transition:var(--transition);"
            onmouseover="this.style.background='rgba(99,102,241,0.22)'" onmouseout="this.style.background='rgba(99,102,241,0.12)'">
            <div style="font-size:0.8rem;font-weight:700;color:#818cf8;margin-bottom:2px;">📖 ${this._lessonLabel(this.currentCategory)}</div>
            <div style="font-size:0.73rem;color:var(--text-muted);line-height:1.4;">Read the lesson, see worked examples, and take a mini-quiz on this topic.</div>
          </button>

          <div style="margin-top:10px;">
            <button onclick="MathPractice.exportPDF()" class="btn btn-secondary btn-sm" style="width:100%;">🖨️ Print Worksheet</button>
          </div>
        </div>

      </div>

      <style>
        @media(max-width:768px){.math-layout{grid-template-columns:1fr!important;}}
        @media(max-width:768px){.math-layout > div:last-child{order:-1;position:static!important;}}
      </style>
    `;
    if (this.currentProblem) {
      const inp = document.getElementById('mathAnswer');
      if (inp) setTimeout(() => inp.focus(), 50);
    }
    // Attach long-press handlers to chips for toggle on/off
    container.querySelectorAll('[data-chipid]').forEach(btn => {
      let t;
      btn.addEventListener('pointerdown', () => { t = setTimeout(() => MathPractice.toggleCategory(btn.dataset.chipid), 600); });
      btn.addEventListener('pointerup', () => clearTimeout(t));
      btn.addEventListener('contextmenu', e => { e.preventDefault(); MathPractice.toggleCategory(btn.dataset.chipid); });
    });
  },

  _chipClick(id, event) {
    // Left-click → select this module and generate a problem.
    // If the module was disabled, re-enable it so it joins the random rotation too.
    const state = Storage.get();
    if (state && state.mathSettings && state.mathSettings.enabledCategories && !state.mathSettings.enabledCategories.includes(id)) {
      state.mathSettings.enabledCategories.push(id);
      Storage.set(state);
      FireDB.saveUser(state);
    }
    this.selectCategory(id);
    this.generateProblem();
  },

  selectCategory(id) {
    this.currentCategory = id;
    this.currentProblem = null;
    this.showingSolution = false;
    this.render(Storage.get());
  },

  _formulaRef(id) {
    const refs = {
      'ohms-law': 'V = I × R<br>I = V / R<br>R = V / I',
      'power': 'P = V × I<br>P = I² × R<br>P = V² / R<br>I = P / V<br>V = P / I',
      'series': 'Rt = R1 + R2 + R3...<br>It = I1 = I2 = I3 (same)<br>Vt = V1 + V2 + V3<br>Vn = It × Rn',
      'parallel': 'Vt = V1 = V2 = V3 (same)<br>It = I1 + I2 + I3<br>Rt = (R1×R2)/(R1+R2)  [2 resistors]<br>1/Rt = 1/R1 + 1/R2 + 1/R3',
      'series-parallel': 'Solve parallel groups first → get Rp<br>Add Rp to series resistors → get Rt<br>I = V / Rt<br>Vdrop = I × R (series parts)',
      'ac-basics': 'Vrms = Vpeak × 0.7071<br>Vpeak = Vrms × 1.4142<br>f = 1 / T<br>T = 1 / f<br>60 Hz → T = 16.67ms',
      'reactance': 'XL = 2π × f × L<br>XC = 1 / (2π × f × C)<br>XL in Ω, f in Hz, L in H<br>XC in Ω, f in Hz, C in F',
      'impedance': 'Z = √(R² + X²)<br>θ = arctan(X / R)<br>X = XL − XC (net reactance)',
      'power-factor': 'PF = cos θ = R / Z<br>P = S × PF  (true power, W)<br>Q = S × sin θ  (reactive, VAR)<br>S = V × I  (apparent, VA)<br>S² = P² + Q²',
      'transformers': 'V1/V2 = N1/N2<br>I1/I2 = N2/N1<br>V2 = V1 × (N2/N1)<br>I1 = I2 × (N2/N1)<br>Efficiency = Pout / Pin × 100%',
      'motors': 'Ns = 120 × f / P<br>Slip = (Ns − Nr) / Ns × 100%<br>Nr = Ns × (1 − slip)<br>(Ns=sync RPM, Nr=rotor RPM, P=poles)',
      'three-phase': 'Wye: VL = Vp × √3,  IL = Ip<br>Delta: VL = Vp,  IL = Ip × √3<br>√3 = 1.732<br>3φ Power = √3 × VL × IL × PF',
    };
    return refs[id] || '';
  },

  exportPDF() {
    const cat = this.categories.find(c => c.id === this.currentCategory);
    // Generate 10 problems for printing
    const problems = [];
    for (let i = 0; i < 10; i++) {
      const gen = this['_gen_' + this.currentCategory.replace(/-/g,'_')];
      if (gen) problems.push(gen.call(this));
    }
    // Build printable HTML
    const html = `<!DOCTYPE html><html><head><title>${cat.name} Worksheet</title>
    <style>
      body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;color:#000;}
      h1{font-size:1.4rem;border-bottom:2px solid #000;padding-bottom:8px;}
      .problem{margin:20px 0;padding:14px;border:1px solid #ccc;border-radius:6px;}
      .num{font-weight:700;color:#555;}
      .q{font-size:1rem;margin:4px 0 12px;}
      .answer{border-bottom:1px solid #000;min-width:150px;display:inline-block;height:20px;margin-left:8px;}
      .formula{font-size:0.8rem;color:#888;font-style:italic;margin-top:8px;}
      .footer{margin-top:40px;font-size:0.75rem;color:#888;text-align:center;}
      @media print{button{display:none;}}
    </style></head><body>
    <h1>🧮 ${cat.name} Worksheet</h1>
    <p style="font-size:0.85rem;color:#555;">Formula: ${cat.formula}</p>
    <p style="font-size:0.85rem;color:#555;">Name: ___________________ &nbsp;&nbsp;&nbsp; Date: ___________________</p>
    ${problems.map((p,i)=>`<div class="problem"><div class="num">Problem ${i+1}</div>
    <div class="q">${p.q.replace(/<strong>/g,'').replace(/<\/strong>/g,'')}</div>
    <div>Answer: <span class="answer"></span> ${p.unit}</div>
    <div class="formula">Hint: ${p.hint}</div></div>`).join('')}
    <div class="footer">SparkyStudy — ${cat.name} Worksheet — sparkystudy.com</div>
    <br><button onclick="window.print()">🖨️ Print</button>
    </body></html>`;
    const win = window.open('','_blank');
    win.document.write(html);
    win.document.close();
  },
};

// ===== CRAM MODE =====
const CramMode = {
  start() {
    const state = Storage.get();
    if (!state) return;
    // Get weakest topics
    const topics = getTopicsForPeriod(state.user.period);
    const ranked = topics.map(t => ({ id: t.id, mastery: getTopicMastery(state, t.id) })).sort((a, b) => a.mastery - b.mastery);
    // Take bottom 20% of topics (min 3)
    const weakCount = Math.max(3, Math.ceil(topics.length * 0.2));
    const weakTopicIds = ranked.slice(0, weakCount).map(t => t.id);
    // Get all flashcards for those topics, prioritizing unmastered
    const cards = FLASHCARD_BANK.filter(fc => weakTopicIds.includes(fc.topic)).filter(fc => {
      const cd = state.flashcards[fc.id];
      return !cd || SM2.getMasteryTier(cd) !== 'expert';
    }).sort(() => Math.random() - 0.5);

    if (cards.length === 0) { showToast('All topics mastered! Nothing to cram.', 'success'); return; }
    Flashcards.sessionCards = cards.slice(0, 30); // Cap at 30 for a cram session
    Flashcards.currentIndex = 0;
    Flashcards.isFlipped = false;
    Flashcards.sessionStart = Date.now();
    Flashcards.mode = 'session';
    App.navigate('flashcards');
    Flashcards.renderCard();
    showToast(`Cram Mode: ${Flashcards.sessionCards.length} cards from your weakest topics`, 'info');
  }
};

// ===== QUICK QUIZ (10-question rapid fire) =====
const QuickQuiz = {
  questions: [],
  current: 0,
  answers: [],
  startTime: null,

  start() {
    const state = Storage.get();
    if (!state) return;
    const available = EXAM_BANK.filter(eq => {
      const t = TOPICS[eq.topic];
      return t && t.period <= state.user.period;
    }).sort(() => Math.random() - 0.5);
    this.questions = available.slice(0, 10);
    this.answers = new Array(10).fill(null);
    this.current = 0;
    this.startTime = Date.now();
    App.navigate('exams');
    this.render();
  },

  render() {
    const container = document.getElementById('examContent');
    if (this.current >= this.questions.length) { this.showResults(); return; }
    const q = this.questions[this.current];
    const topic = TOPICS[q.topic];
    container.innerHTML = `
      <div style="max-width:700px;margin:0 auto;padding:32px 24px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
          <h2 style="font-size:1.2rem;">&#9889; Quick Quiz</h2>
          <span style="color:var(--text-muted);font-size:0.9rem;">${this.current + 1}/10</span>
        </div>
        <div class="progress-bar" style="margin-bottom:24px;"><div class="fill" style="width:${this.current * 10}%"></div></div>
        <div class="diag-topic-badge">${topic?.icon || ''} ${topic?.name || ''}</div>
        <div class="diag-question" style="margin-top:12px;">${q.q}</div>
        <div class="diag-options">
          ${q.opts.map((opt, i) => `
            <div class="diag-option" onclick="QuickQuiz.answer(${i})">
              <div class="option-letter">${String.fromCharCode(65 + i)}</div>
              <div>${opt}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  },

  answer(idx) {
    this.answers[this.current] = idx;
    this.current++;
    this.render();
  },

  showResults() {
    const container = document.getElementById('examContent');
    const state = Storage.get();
    const elapsed = Date.now() - this.startTime;
    let score = 0;
    this.questions.forEach((q, i) => { if (this.answers[i] === q.correct) score++; });
    const pct = score * 10;

    // Record study
    const today = getToday();
    if (!state.sessions.daily[today]) state.sessions.daily[today] = { flashcards: 0, exams: 0, time: 0 };
    state.sessions.daily[today].time = (state.sessions.daily[today].time || 0) + elapsed;
    recordStudy(state);
    if (pct === 100) launchConfetti();

    container.innerHTML = `
      <div class="exam-results slide-up" style="max-width:700px;margin:0 auto;">
        <div class="big-score ${pct >= 70 ? 'pass' : 'fail'}">${pct}%</div>
        <div style="font-size:1.2rem;font-weight:600;margin:8px 0;">${pct >= 90 ? 'Excellent!' : pct >= 70 ? 'Nice work!' : 'Keep at it!'}</div>
        <div style="color:var(--text-secondary);margin-bottom:24px;">${score}/10 correct in ${Math.round(elapsed / 1000)}s</div>
        ${this.questions.map((q, i) => `
          <div class="review-question" style="text-align:left;">
            <div class="rq-topic">${TOPICS[q.topic]?.name || q.topic}</div>
            <div class="rq-text">${i + 1}. ${q.q}</div>
            <div class="rq-answer">
              ${this.answers[i] === q.correct
                ? `<span class="rq-correct-answer">&#10003; ${q.opts[q.correct]}</span>`
                : `<span class="rq-your-answer">&#10007; ${q.opts[this.answers[i]] || 'Skipped'}</span><br><span class="rq-correct-answer">&#10003; ${q.opts[q.correct]}</span>`
              }
            </div>
            ${q.exp ? `<div class="rq-explanation">${q.exp}</div>` : ''}
          </div>
        `).join('')}
        <div style="display:flex;gap:12px;justify-content:center;margin-top:24px;flex-wrap:wrap;">
          ${(() => {
            const wrongs = this.questions.map((q,i)=>this.answers[i]!==q.correct?{q:q.q,opts:q.opts,correct:q.correct,selected:this.answers[i],exp:q.exp||'',topic:q.topic}:null).filter(Boolean);
            if (wrongs.length > 0) { WrongAnswerStudy._pending = wrongs; WrongAnswerStudy._pendingLabel = 'Quick Quiz'; }
            return wrongs.length > 0 ? `<button class="btn btn-primary" style="background:linear-gradient(135deg,#ef4444,#f59e0b);border:none;order:-1;" onclick="WrongAnswerStudy.launchPending()">📖 Study ${wrongs.length} Wrong Answer${wrongs.length!==1?'s':''}</button>` : '';
          })()}
          <button class="btn btn-primary" onclick="QuickQuiz.start()">Another Quick Quiz</button>
          <button class="btn btn-secondary" onclick="App.navigate('dashboard')">Dashboard</button>
        </div>
      </div>
    `;
  }
};

// ===== FORMULA SHEET (Floating) =====
const FormulaSheet = {
  visible: false,
  toggle() {
    this.visible = !this.visible;
    let el = document.getElementById('formulaSheet');
    if (!el) {
      el = document.createElement('div');
      el.id = 'formulaSheet';
      el.style.cssText = 'position:fixed;top:64px;right:0;width:340px;max-width:90vw;height:calc(100vh - 64px);background:var(--bg-secondary);border-left:1px solid var(--border);z-index:900;overflow-y:auto;padding:24px;transform:translateX(100%);transition:transform 0.3s ease;box-shadow:-4px 0 30px rgba(0,0,0,0.3);';
      el.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
          <h3 style="font-size:1rem;font-weight:700;">&#128211; Formula Quick Reference</h3>
          <button class="btn btn-ghost btn-sm" onclick="FormulaSheet.toggle()">&#10005;</button>
        </div>
        <div style="font-family:'Courier New',monospace;font-size:0.8rem;color:var(--text-secondary);display:flex;flex-direction:column;gap:16px;">
          <div class="formula-box"><strong style="color:var(--accent);">Ohm's Law</strong><br>V = I × R<br>I = V / R<br>R = V / I</div>
          <div class="formula-box"><strong style="color:var(--accent);">Power</strong><br>P = V × I<br>P = I² × R<br>P = V² / R</div>
          <div class="formula-box"><strong style="color:var(--accent);">Series Circuits</strong><br>Rt = R1 + R2 + R3<br>It = I1 = I2 = I3<br>Vt = V1 + V2 + V3</div>
          <div class="formula-box"><strong style="color:var(--accent);">Parallel Circuits</strong><br>1/Rt = 1/R1 + 1/R2<br>Rt = (R1×R2)/(R1+R2)<br>Vt = V1 = V2 = V3<br>It = I1 + I2 + I3</div>
          <div class="formula-box"><strong style="color:var(--accent);">AC Values</strong><br>Vrms = Vpeak × 0.707<br>Vpeak = Vrms × 1.414<br>f = 1 / T</div>
          <div class="formula-box"><strong style="color:var(--accent);">Impedance</strong><br>Z = √(R² + X²)<br>XL = 2πfL<br>XC = 1/(2πfC)</div>
          <div class="formula-box"><strong style="color:var(--accent);">Transformers</strong><br>Vp/Vs = Np/Ns<br>Vp×Ip = Vs×Is</div>
          <div class="formula-box"><strong style="color:var(--accent);">Motor Speed</strong><br>Ns = 120f / P<br>Slip% = (Ns-Nr)/Ns × 100</div>
          <div class="formula-box"><strong style="color:var(--accent);">Power Factor</strong><br>PF = W / VA = cos θ<br>VA² = W² + VAR²</div>
          <div class="formula-box"><strong style="color:var(--accent);">Voltage Drop</strong><br>Vd = 2 × I × R × L<br>Max 3% branch, 5% total</div>
          <div class="formula-box"><strong style="color:var(--accent);">Wire Ampacity</strong><br>14 AWG = 15A<br>12 AWG = 20A<br>10 AWG = 30A<br>8 AWG = 40A<br>6 AWG = 55A</div>
        </div>
      `;
      document.body.appendChild(el);
      // Small delay to trigger transition
      requestAnimationFrame(() => { el.style.transform = 'translateX(0)'; });
    } else {
      el.style.transform = this.visible ? 'translateX(0)' : 'translateX(100%)';
    }
  }
};

// ===== POMODORO TIMER =====
const Pomodoro = {
  active: false,
  timeLeft: 25 * 60,
  isBreak: false,
  interval: null,
  el: null,

  toggle() {
    if (!this.el) this.createUI();
    this.el.style.display = this.el.style.display === 'none' ? 'flex' : 'none';
  },

  createUI() {
    this.el = document.createElement('div');
    this.el.id = 'pomodoroTimer';
    this.el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;z-index:800;display:none;flex-direction:column;align-items:center;gap:12px;min-width:200px;box-shadow:var(--shadow-lg);';
    this.updateUI();
    document.body.appendChild(this.el);
  },

  updateUI() {
    if (!this.el) return;
    const m = Math.floor(this.timeLeft / 60);
    const s = this.timeLeft % 60;
    this.el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
        <span style="font-size:0.8rem;font-weight:600;color:${this.isBreak ? 'var(--success)' : 'var(--accent)'};">${this.isBreak ? '&#9749; Break' : '&#128293; Focus'}</span>
        <button class="btn btn-ghost btn-sm" onclick="Pomodoro.toggle()" style="padding:2px 6px;">&#10005;</button>
      </div>
      <div style="font-size:2.5rem;font-weight:800;font-variant-numeric:tabular-nums;color:${this.isBreak ? 'var(--success)' : 'var(--accent)'};">
        ${m}:${s.toString().padStart(2, '0')}
      </div>
      <div style="display:flex;gap:8px;">
        ${this.active
          ? `<button class="btn btn-secondary btn-sm" onclick="Pomodoro.pause()">Pause</button>`
          : `<button class="btn btn-primary btn-sm" onclick="Pomodoro.start()">Start</button>`
        }
        <button class="btn btn-ghost btn-sm" onclick="Pomodoro.reset()">Reset</button>
      </div>
    `;
  },

  start() {
    this.active = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => {
      this.timeLeft--;
      if (this.timeLeft <= 0) {
        clearInterval(this.interval);
        this.active = false;
        if (!this.isBreak) {
          showToast('Focus session complete! Take a 5-minute break.', 'success');
          this.isBreak = true;
          this.timeLeft = 5 * 60;
        } else {
          showToast('Break over! Ready for another focus session?', 'info');
          this.isBreak = false;
          this.timeLeft = 25 * 60;
        }
      }
      this.updateUI();
    }, 1000);
    this.updateUI();
  },

  pause() {
    this.active = false;
    clearInterval(this.interval);
    this.updateUI();
  },

  reset() {
    this.active = false;
    clearInterval(this.interval);
    this.isBreak = false;
    this.timeLeft = 25 * 60;
    this.updateUI();
  }
};

// ===== CONFETTI =====
function launchConfetti() {
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden;';
  document.body.appendChild(container);
  const colors = ['#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#fbbf24'];
  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    const color = colors[Math.floor(Math.random() * colors.length)];
    const left = Math.random() * 100;
    const delay = Math.random() * 0.5;
    const size = 6 + Math.random() * 8;
    const rotation = Math.random() * 360;
    piece.style.cssText = `position:absolute;top:-20px;left:${left}%;width:${size}px;height:${size * 0.6}px;background:${color};border-radius:2px;animation:confettiFall ${1.5 + Math.random()}s ease-out ${delay}s forwards;transform:rotate(${rotation}deg);`;
    container.appendChild(piece);
  }
  setTimeout(() => container.remove(), 3000);
}

// Add confetti animation CSS
const confettiStyle = document.createElement('style');
confettiStyle.textContent = '@keyframes confettiFall { 0% { top: -20px; opacity: 1; } 100% { top: 110vh; opacity: 0; transform: rotate(720deg) translateX(100px); } }';
document.head.appendChild(confettiStyle);

// ===== FLOATING ACTION BUTTONS (Formula + Timer) =====
function createFAB() {
  const fab = document.createElement('div');
  fab.id = 'fabContainer';
  fab.style.cssText = 'position:fixed;bottom:24px;left:24px;display:flex;flex-direction:column;gap:8px;z-index:800;';
  fab.innerHTML = `
    <button onclick="FormulaSheet.toggle()" title="Formula Sheet" style="width:48px;height:48px;border-radius:50%;background:var(--bg-card);border:1px solid var(--border);color:var(--accent);font-size:1.2rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:var(--transition);box-shadow:var(--shadow);" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">&#128211;</button>
    <button onclick="Pomodoro.toggle()" title="Pomodoro Timer" style="width:48px;height:48px;border-radius:50%;background:var(--bg-card);border:1px solid var(--border);color:var(--accent);font-size:1.2rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:var(--transition);box-shadow:var(--shadow);" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">&#9200;</button>
  `;
  document.body.appendChild(fab);
}

// Migrate old single-user storage to multi-user
(function migrateStorage() {
  const oldData = localStorage.getItem('sparkstudy_v1');
  if (oldData && !localStorage.getItem('sparkstudy_users')) {
    try {
      const state = JSON.parse(oldData);
      if (state && state.user && state.user.id) {
        localStorage.setItem('sparkstudy_v1_' + state.user.id, oldData);
        localStorage.setItem('sparkstudy_active', state.user.id);
        const reg = [{ id: state.user.id, name: state.user.name, email: state.user.email, period: state.user.period, signupDate: state.user.signupDate, isOwner: !!state.user.isOwner }];
        localStorage.setItem('sparkstudy_users', JSON.stringify(reg));
        localStorage.removeItem('sparkstudy_v1');
      }
    } catch(e) {}
  }
})();

// ===== PWA INSTALL =====
const PWA = {
  deferredPrompt: null,
  init() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      // Show the install banner on the landing page
      const banner = document.getElementById('landingInstallBanner');
      if (banner) banner.style.display = '';
    });
    window.addEventListener('appinstalled', () => {
      this.deferredPrompt = null;
      // Hide the banner once installed
      const banner = document.getElementById('landingInstallBanner');
      if (banner) banner.style.display = 'none';
      showToast('sparkystudy installed! Tap the icon on your home screen to launch it.', 'success');
    });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  },
  promptInstall() {
    if (this.deferredPrompt) {
      this.deferredPrompt.prompt();
      this.deferredPrompt.userChoice.then(result => {
        this.deferredPrompt = null;
        if (result.outcome === 'accepted') {
          const banner = document.getElementById('landingInstallBanner');
          if (banner) banner.style.display = 'none';
        }
      });
    } else {
      showToast('Open this page in Chrome or Safari, then use "Add to Home Screen" to install sparkystudy.', 'info');
    }
  }
};

// ===== LEADERBOARD =====
const Leaderboard = {
  _tab: 'weekly', // 'weekly' | 'alltime'
  _users: [],

  async render(state) {
    const el = document.getElementById('leaderboardContent');
    if (!el) return;
    el.innerHTML = `<div style="text-align:center;padding:60px 0;color:var(--text-muted);">Loading leaderboard…</div>`;

    // Fetch all users from Firebase
    let users = [];
    try {
      const cloudUsers = await FireDB.getAllUsers();
      if (cloudUsers && cloudUsers.length > 0) {
        users = cloudUsers.map(u => ({
          id: u.id,
          name: (u.user && u.user.name) ? u.user.name : 'Anonymous',
          avatar: (u.user && u.user.name) ? u.user.name.charAt(0).toUpperCase() : '?',
          totalPts: (u.user && u.user.points && u.user.points.total) ? u.user.points.total : 0,
          weeklyPts: (u.user && u.user.points && u.user.points.weekly) ? u.user.points.weekly : 0,
          streak: (u.user && u.user.sessions && u.user.sessions.streak) ? u.user.sessions.streak : 0,
          isOwner: (u.user && u.user.isOwner) ? true : false,
        })).filter(u => !u.isOwner);
      }
    } catch(e) {}

    // Also include current local user if not in list
    if (state && !state.user.isOwner) {
      const existing = users.find(u => u.id === state.user.id);
      if (!existing) {
        users.push({
          id: state.user.id,
          name: state.user.name || 'You',
          avatar: state.user.name ? state.user.name.charAt(0).toUpperCase() : '?',
          totalPts: (state.points && state.points.total) || 0,
          weeklyPts: (state.points && state.points.weekly) || 0,
          streak: state.sessions.streak || 0,
          isOwner: false,
        });
      }
    }

    this._users = users;
    this._renderBoard(state);
  },

  _renderBoard(state) {
    const el = document.getElementById('leaderboardContent');
    if (!el) return;
    const myId = state ? state.user.id : null;
    const sorted = [...this._users].sort((a,b) =>
      this._tab === 'weekly' ? b.weeklyPts - a.weeklyPts : b.totalPts - a.totalPts
    );
    const myPos = sorted.findIndex(u => u.id === myId);
    const myRank = myPos >= 0 ? Points.getRank(sorted[myPos].totalPts) : null;
    const myPts = myPos >= 0 ? (this._tab === 'weekly' ? sorted[myPos].weeklyPts : sorted[myPos].totalPts) : 0;

    el.innerHTML = `
      <div style="max-width:700px;margin:0 auto;padding:24px 16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px;">
          <div>
            <h1 style="font-size:1.8rem;font-weight:900;margin-bottom:4px;">🏆 Leaderboard</h1>
            <p style="color:var(--text-secondary);font-size:0.9rem;">Compete with other students. Study more, earn more points.</p>
          </div>
          <div style="display:flex;gap:8px;">
            <button onclick="Leaderboard._switchTab('weekly')" class="btn btn-sm ${this._tab==='weekly'?'btn-primary':'btn-secondary'}">This Week</button>
            <button onclick="Leaderboard._switchTab('alltime')" class="btn btn-sm ${this._tab==='alltime'?'btn-primary':'btn-secondary'}">All-Time</button>
          </div>
        </div>

        ${myPos >= 0 ? `
        <div style="background:var(--accent-soft);border:2px solid var(--accent);border-radius:var(--radius);padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
          <div style="font-size:1.4rem;font-weight:900;color:var(--accent);min-width:40px;text-align:center;">#${myPos+1}</div>
          <div style="width:38px;height:38px;border-radius:50%;background:var(--accent);color:#000;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1rem;">${sorted[myPos].avatar}</div>
          <div style="flex:1;">
            <div style="font-weight:700;">You — ${sorted[myPos].name}</div>
            <div style="font-size:0.8rem;color:var(--text-muted);">${myRank ? `${myRank.badge} ${myRank.name}` : ''} · ${sorted[myPos].streak}🔥 streak</div>
          </div>
          <div style="font-size:1.3rem;font-weight:900;color:var(--accent);">${myPts.toLocaleString()} pts</div>
        </div>` : ''}

        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;">
          ${sorted.length === 0 ? `<div style="padding:48px;text-align:center;color:var(--text-muted);">No users yet. Be the first to earn points!</div>` :
            sorted.slice(0, 50).map((u, i) => {
              const rank = Points.getRank(u.totalPts);
              const pts = this._tab === 'weekly' ? u.weeklyPts : u.totalPts;
              const isMe = u.id === myId;
              const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `<span style="color:var(--text-muted);font-size:0.85rem;">#${i+1}</span>`;
              return `<div style="display:flex;align-items:center;gap:14px;padding:13px 18px;border-bottom:1px solid var(--border);background:${isMe ? 'rgba(245,158,11,0.06)' : 'transparent'};transition:background 0.2s;" onmouseenter="this.style.background='var(--bg-hover)'" onmouseleave="this.style.background='${isMe ? 'rgba(245,158,11,0.06)' : 'transparent'}'">
                <div style="width:32px;text-align:center;font-size:${i<3?'1.2rem':'0.9rem'};">${medal}</div>
                <div style="width:36px;height:36px;border-radius:50%;background:${isMe ? 'var(--accent)' : 'var(--bg-secondary)'};color:${isMe ? '#000' : 'var(--text-secondary)'};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.9rem;flex-shrink:0;">${u.avatar}</div>
                <div style="flex:1;min-width:0;">
                  <div style="font-weight:${isMe ? '700' : '500'};font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${u.name}${isMe ? ' (you)' : ''}</div>
                  <div style="font-size:0.72rem;color:${rank.color};">${rank.badge} ${rank.name}${u.streak > 0 ? ` · ${u.streak}🔥` : ''}</div>
                </div>
                <div style="font-weight:700;font-size:0.95rem;color:${i===0?'#f59e0b':i===1?'#9ca3af':i===2?'#cd7c2f':'var(--text-primary)'};">${pts.toLocaleString()}<span style="font-size:0.72rem;font-weight:400;color:var(--text-muted);margin-left:3px;">pts</span></div>
              </div>`;
            }).join('')
          }
        </div>

        <div style="margin-top:20px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;">
          <div style="font-weight:700;margin-bottom:12px;font-size:0.85rem;">How to earn points</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;">
            ${Object.entries(Points.ACTIONS).filter(([,v])=>v.base>0).map(([,v]) =>
              `<div style="font-size:0.8rem;color:var(--text-secondary);display:flex;justify-content:space-between;padding:6px 8px;background:var(--bg-secondary);border-radius:6px;">
                <span>${v.desc}</span><strong style="color:var(--accent);margin-left:8px;">+${v.base}</strong>
              </div>`
            ).join('')}
          </div>
          <p style="font-size:0.75rem;color:var(--text-muted);margin-top:10px;">🔥 Streak bonuses: 3-day streak = 1.5× points · 7-day streak = 2× points</p>
        </div>
      </div>
    `;
  },

  _switchTab(tab) {
    this._tab = tab;
    const state = Storage.get();
    this._renderBoard(state);
  }
};

// One-time analytics wipe — clears all pre-launch test traffic (was 100% owner)
(function purgeTestTraffic() {
  const FLAG = 'sparkstudy_traffic_purged_v1';
  if (localStorage.getItem(FLAG)) return; // already ran, never run again
  const blank = { visits:[], pageViews:[], dailyVisits:{}, totalVisits:0, uniqueVisitors:{}, events:[], revenue:{total:0,transactions:[]}, funnelData:{landing:0,signup:0,diagnostic:0,dashboard:0,flashcards:0,exams:0} };
  localStorage.setItem(ANALYTICS_KEY, JSON.stringify(blank));
  localStorage.setItem(FLAG, '1');
  // Clear Firebase visits too once SDK is ready
  setTimeout(async () => { try { if (FireDB.ready) await FireDB.clearVisits(); } catch(e){} }, 4000);
})();

// Initialize app
document.addEventListener("DOMContentLoaded", () => {
  App.init();
  createFAB();
  PWA.init();

  // Click-based dropdowns (no hover gap glitch)
  document.querySelectorAll('.nav-dropdown-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const li = btn.closest('.nav-dropdown');
      const isOpen = li.classList.contains('open');
      document.querySelectorAll('.nav-dropdown').forEach(d => d.classList.remove('open'));
      if (!isOpen) li.classList.add('open');
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.nav-dropdown').forEach(d => d.classList.remove('open'));
  });
  document.querySelectorAll('.nav-dropdown-menu a').forEach(a => {
    a.addEventListener('click', () => {
      document.querySelectorAll('.nav-dropdown').forEach(d => d.classList.remove('open'));
    });
  });
});

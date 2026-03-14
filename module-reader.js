/**
 * SparkStudy Module Reader
 * Fetches module JSON and renders full lesson content inline.
 * Drop <script src="module-reader.js"></script> into any page.
 */
(function () {

  // Map module number -> JSON path (relative to site root)
  const MODULE_DATA = {
    1:  'modules/module01_extracted.json',
    3:  'modules/module03_extracted.json',
    22: 'modules/module22_extracted.json',
  };

  // ── Styles ────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .mr-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 10000;
      display: flex; align-items: flex-start; justify-content: center;
      padding: 20px;
      overflow-y: auto;
      animation: mr-fade-in 0.2s ease;
    }
    @keyframes mr-fade-in { from { opacity:0 } to { opacity:1 } }

    .mr-panel {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 16px;
      width: 100%;
      max-width: 860px;
      min-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 24px 64px rgba(0,0,0,0.8);
      margin: auto;
    }

    .mr-header {
      display: flex; align-items: center; gap: 14px;
      padding: 20px 24px;
      border-bottom: 1px solid #21262d;
      position: sticky; top: 0;
      background: #0d1117;
      border-radius: 16px 16px 0 0;
      z-index: 2;
    }
    .mr-header-info { flex: 1; }
    .mr-header-info h2 { font-size: 1.15rem; font-weight: 700; color: #e6edf3; margin: 0 0 3px; }
    .mr-header-info span { font-size: 0.8rem; color: #8b949e; }
    .mr-close {
      width: 36px; height: 36px;
      background: #21262d; border: 1px solid #30363d;
      border-radius: 8px; color: #8b949e;
      cursor: pointer; font-size: 18px;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.15s;
    }
    .mr-close:hover { background: #30363d; color: #e6edf3; }

    .mr-progress-bar {
      height: 3px; background: #21262d;
      border-radius: 0;
    }
    .mr-progress-fill {
      height: 100%; background: linear-gradient(90deg, #f59e0b, #f97316);
      transition: width 0.3s ease;
      border-radius: 0;
    }

    .mr-body {
      padding: 28px 32px;
      flex: 1;
      color: #c9d1d9;
      font-size: 0.95rem;
      line-height: 1.75;
    }

    .mr-section-title {
      font-size: 0.72rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.08em;
      color: #f59e0b; margin-bottom: 8px;
    }
    .mr-page-title {
      font-size: 1.35rem; font-weight: 700;
      color: #e6edf3; margin: 0 0 20px;
      line-height: 1.3;
    }

    .mr-body p { margin-bottom: 14px; }
    .mr-body h3 { color: #f59e0b; font-size: 1rem; margin: 20px 0 8px; }
    .mr-body h4 { color: #c9d1d9; font-size: 0.92rem; font-weight: 600; margin: 16px 0 6px; }
    .mr-body ul, .mr-body ol { padding-left: 20px; margin-bottom: 14px; }
    .mr-body li { margin-bottom: 5px; }
    .mr-body strong { color: #e6edf3; }

    .mr-figure {
      background: linear-gradient(135deg, #161b22, #1c2128);
      border: 1px solid #30363d;
      border-left: 3px solid #58a6ff;
      border-radius: 10px;
      padding: 16px 18px;
      margin: 18px 0;
      display: flex; align-items: flex-start; gap: 12px;
    }
    .mr-figure-icon {
      font-size: 1.4rem; flex-shrink: 0; margin-top: 2px;
    }
    .mr-figure-text { flex: 1; }
    .mr-figure-label {
      font-size: 0.72rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.06em;
      color: #58a6ff; margin-bottom: 4px;
    }
    .mr-figure-caption {
      font-size: 0.88rem; color: #8b949e; line-height: 1.5;
      font-style: italic;
    }

    .mr-table-wrap { overflow-x: auto; margin: 18px 0; border-radius: 10px; border: 1px solid #30363d; }
    .mr-table {
      width: 100%; border-collapse: collapse;
      font-size: 0.875rem;
    }
    .mr-table th {
      background: #161b22; color: #f59e0b;
      padding: 10px 14px; text-align: left;
      font-weight: 700; font-size: 0.78rem;
      text-transform: uppercase; letter-spacing: 0.05em;
      border-bottom: 1px solid #30363d;
    }
    .mr-table td {
      padding: 9px 14px; border-bottom: 1px solid #21262d;
      color: #c9d1d9;
    }
    .mr-table tr:last-child td { border-bottom: none; }
    .mr-table tr:nth-child(even) td { background: rgba(255,255,255,0.02); }

    .mr-formula {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 12px 16px;
      font-family: 'Courier New', monospace;
      font-size: 0.95rem;
      color: #fbbf24;
      margin: 14px 0;
      text-align: center;
    }

    .mr-note {
      background: rgba(245,158,11,0.06);
      border: 1px solid rgba(245,158,11,0.2);
      border-radius: 8px;
      padding: 12px 16px;
      margin: 14px 0;
      font-size: 0.875rem;
      color: #c9d1d9;
    }
    .mr-note strong { color: #f59e0b; }

    .mr-objective-badge {
      display: inline-block;
      background: rgba(88,166,255,0.1);
      border: 1px solid rgba(88,166,255,0.3);
      color: #58a6ff;
      font-size: 0.72rem; font-weight: 700;
      padding: 3px 10px; border-radius: 20px;
      text-transform: uppercase; letter-spacing: 0.05em;
      margin-bottom: 12px;
    }

    .mr-footer {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 24px;
      border-top: 1px solid #21262d;
      gap: 12px;
      flex-wrap: wrap;
    }
    .mr-page-count { font-size: 0.82rem; color: #8b949e; white-space: nowrap; }
    .mr-nav { display: flex; gap: 8px; }
    .mr-btn {
      padding: 9px 18px;
      border-radius: 8px;
      font-size: 0.85rem; font-weight: 600;
      cursor: pointer; transition: all 0.15s;
      border: 1px solid #30363d;
    }
    .mr-btn-secondary { background: #21262d; color: #e6edf3; }
    .mr-btn-secondary:hover { background: #30363d; }
    .mr-btn-secondary:disabled { opacity: 0.3; cursor: not-allowed; }
    .mr-btn-primary {
      background: linear-gradient(135deg, #f59e0b, #f97316);
      color: #fff; border-color: transparent;
    }
    .mr-btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }

    .mr-ask-btn {
      background: rgba(249,115,22,0.1);
      border: 1px solid rgba(249,115,22,0.3);
      color: #f97316;
      border-radius: 8px;
      padding: 7px 14px;
      font-size: 0.82rem; font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      display: flex; align-items: center; gap: 6px;
    }
    .mr-ask-btn:hover { background: rgba(249,115,22,0.2); }

    @media (max-width: 600px) {
      .mr-overlay { padding: 8px; }
      .mr-body { padding: 20px 16px; }
      .mr-header { padding: 16px; }
      .mr-footer { padding: 12px 16px; }
    }
  `;
  document.head.appendChild(style);

  // ── State ─────────────────────────────────────────────────────────────────
  let currentModule = null;
  let currentPage = 0;
  let overlay = null;

  // ── Open module ────────────────────────────────────────────────────────────
  async function openModule(num) {
    const path = MODULE_DATA[num];
    if (!path) {
      alert('Module content coming soon!');
      return;
    }

    try {
      // Resolve path relative to site root
      const base = window.location.origin;
      const res = await fetch(base + '/' + path);
      if (!res.ok) throw new Error('Not found');
      currentModule = await res.json();
      currentPage = 0;
      renderOverlay();
    } catch (e) {
      alert('Could not load module content. Try again shortly.');
    }
  }

  // ── Render overlay ─────────────────────────────────────────────────────────
  function renderOverlay() {
    if (overlay) overlay.remove();

    overlay = document.createElement('div');
    overlay.className = 'mr-overlay';
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModule();
    });

    const m = currentModule;
    const page = m.pages[currentPage];
    const pct = Math.round(((currentPage + 1) / m.pages.length) * 100);

    overlay.innerHTML = `
      <div class="mr-panel">
        <div class="mr-header">
          <div style="width:40px;height:40px;border-radius:10px;background:rgba(245,158,11,0.12);color:#f59e0b;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:0.9rem;flex-shrink:0;">
            ${String(m.module_number).padStart(2,'0')}
          </div>
          <div class="mr-header-info">
            <h2>${m.title}</h2>
            <span>${m.course}</span>
          </div>
          <button class="mr-close" onclick="window._mrClose()">✕</button>
        </div>
        <div class="mr-progress-bar">
          <div class="mr-progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="mr-body" id="mr-body-content">
          ${renderPage(page, currentPage)}
        </div>
        <div class="mr-footer">
          <span class="mr-page-count">Page ${currentPage + 1} of ${m.pages.length}</span>
          <button class="mr-ask-btn" onclick="window._mrAskAI()">⚡ Ask AI about this</button>
          <div class="mr-nav">
            <button class="mr-btn mr-btn-secondary" onclick="window._mrPrev()" ${currentPage === 0 ? 'disabled' : ''}>← Previous</button>
            <button class="mr-btn mr-btn-primary" onclick="window._mrNext()">
              ${currentPage === m.pages.length - 1 ? '✓ Done' : 'Next →'}
            </button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
  }

  // ── Render a single page ──────────────────────────────────────────────────
  function renderPage(page, idx) {
    const isIntro = idx === 0;
    let html = '';

    // Section badge
    if (page.section) {
      const isObjective = /objective/i.test(page.section);
      if (isObjective) {
        html += `<div class="mr-objective-badge">📘 ${page.section}</div>`;
      } else {
        html += `<div class="mr-section-title">${page.section}</div>`;
      }
    }

    // Page title for intro
    if (isIntro && currentModule) {
      html += `<div class="mr-page-title">${currentModule.title}</div>`;
    }

    // Figures first (as callout boxes)
    if (page.figures && page.figures.length > 0) {
      for (const fig of page.figures) {
        html += `
          <div class="mr-figure">
            <div class="mr-figure-icon">📊</div>
            <div class="mr-figure-text">
              <div class="mr-figure-label">Diagram / Figure</div>
              <div class="mr-figure-caption">${escapeHtml(fig)}</div>
            </div>
          </div>`;
      }
    }

    // Parse and render content
    if (page.content) {
      html += renderContent(page.content);
    }

    return html;
  }

  // ── Content renderer ──────────────────────────────────────────────────────
  function renderContent(raw) {
    // Clean up OCR artifacts
    let text = raw
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Detect and render inline tables (e.g. "TC 1: Current 3.792, % 63.2")
    const tableMatch = detectTable(text);
    let tableHtml = '';
    if (tableMatch) {
      tableHtml = tableMatch.html;
      text = text.replace(tableMatch.raw, '\n[[TABLE]]\n');
    }

    // Detect formulas (lines that are mostly symbols/variables, short)
    const lines = text.split('\n');
    let html = '';
    let inList = false;
    let paraBuffer = '';

    const flushPara = () => {
      if (paraBuffer.trim()) {
        if (inList) { html += '</ul>'; inList = false; }
        html += `<p>${formatInline(paraBuffer.trim())}</p>`;
        paraBuffer = '';
      }
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { flushPara(); continue; }

      if (trimmed === '[[TABLE]]') {
        flushPara();
        html += tableHtml;
        continue;
      }

      // NOTE blocks
      if (/^NOTE$/i.test(trimmed)) {
        flushPara();
        html += '<div class="mr-note"><strong>NOTE</strong><br>';
        continue;
      }

      // Heading-like lines (short, capitalized, no period at end)
      if (trimmed.length < 60 && /^[A-Z]/.test(trimmed) && !trimmed.endsWith('.') && !trimmed.endsWith(',') && /[A-Z]{2}/.test(trimmed)) {
        flushPara();
        html += `<h3>${escapeHtml(trimmed)}</h3>`;
        continue;
      }

      // Formula lines (contains = and short math expressions)
      if (/^[A-Za-z\s]*=\s*[A-Za-z0-9\s\/\+\-\*\(\)\.]+$/.test(trimmed) && trimmed.length < 50) {
        flushPara();
        html += `<div class="mr-formula">${escapeHtml(trimmed)}</div>`;
        continue;
      }

      // Bullet points
      if (/^[•\-\*◆◉○●e]\s+/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
        flushPara();
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${formatInline(trimmed.replace(/^[•\-\*◆◉○●e\d\.]\s+/, ''))}</li>`;
        continue;
      }

      if (inList) { html += '</ul>'; inList = false; }
      paraBuffer += (paraBuffer ? ' ' : '') + trimmed;
    }

    flushPara();
    if (inList) html += '</ul>';

    return html;
  }

  function formatInline(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\b(NOTE|WARNING|CAUTION|IMPORTANT)\b/g, '<strong style="color:#f59e0b">$1</strong>');
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Table detector ─────────────────────────────────────────────────────────
  function detectTable(text) {
    // Look for "TC 1: ..., TC 2: ..." style tables embedded in text
    const tcMatch = text.match(/(TC\s*\d+:\s*Current[\s\S]{0,300}TC\s*5:[\s\d.,]+)/);
    if (tcMatch) {
      const rows = tcMatch[0].match(/TC\s*(\d+):\s*Current\s*([\d.]+),\s*%\s*([\d.]+)/g) || [];
      if (rows.length > 0) {
        let tableHtml = `<div class="mr-table-wrap"><table class="mr-table"><thead><tr><th>Time Constant</th><th>Current (A)</th><th>% of Steady State</th></tr></thead><tbody>`;
        for (const row of rows) {
          const m = row.match(/TC\s*(\d+):\s*Current\s*([\d.]+),\s*%\s*([\d.]+)/);
          if (m) tableHtml += `<tr><td>TC ${m[1]}</td><td>${m[2]}</td><td>${m[3]}%</td></tr>`;
        }
        tableHtml += '</tbody></table></div>';
        return { html: tableHtml, raw: tcMatch[0] };
      }
    }
    return null;
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  window._mrClose = function () { closeModule(); };
  window._mrPrev = function () {
    if (currentPage > 0) { currentPage--; renderOverlay(); scrollTop(); }
  };
  window._mrNext = function () {
    if (currentPage < currentModule.pages.length - 1) {
      currentPage++;
      renderOverlay();
      scrollTop();
    } else {
      closeModule();
    }
  };
  window._mrAskAI = function () {
    const page = currentModule.pages[currentPage];
    const topic = page.section || currentModule.title;
    // Pre-fill the AI chat with context about current page
    const inputEl = document.getElementById('ss-ai-input');
    if (inputEl) {
      inputEl.value = `I'm studying "${topic}" from the ${currentModule.title} module. Can you explain the key concepts on this page in plain language?`;
      // Open the AI panel
      document.getElementById('askaiBtn')?.click();
    }
  };

  function closeModule() {
    if (overlay) { overlay.remove(); overlay = null; }
    document.body.style.overflow = '';
  }

  function scrollTop() {
    const body = document.getElementById('mr-body-content');
    if (body) body.scrollTop = 0;
    if (overlay) overlay.scrollTop = 0;
  }

  // ── Wire up module cards ───────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    // Find all module cards and make them clickable if data available
    const cards = document.querySelectorAll('.module-card');
    cards.forEach(function (card) {
      const numEl = card.querySelector('.module-number');
      if (!numEl) return;
      const num = parseInt(numEl.textContent.trim(), 10);
      if (!MODULE_DATA[num]) return; // no data yet

      // Style as clickable
      card.style.cursor = 'pointer';
      card.style.borderColor = 'rgba(245,158,11,0.3)';

      // Add "Open Lesson" button
      const btn = document.createElement('button');
      btn.textContent = 'Open Lesson →';
      btn.style.cssText = 'margin-top:8px;padding:7px 14px;background:linear-gradient(135deg,#f59e0b,#f97316);color:#fff;border:none;border-radius:8px;font-size:0.8rem;font-weight:700;cursor:pointer;width:100%;';
      card.appendChild(btn);

      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        openModule(num);
      });
      card.addEventListener('click', function () { openModule(num); });
    });
  });

  // Expose globally for manual use
  window.SparkModule = { open: openModule };

})();

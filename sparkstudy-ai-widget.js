/**
 * SparkStudy AI Widget
 * Drop this script tag into your HTML before </body>:
 * <script src="sparkstudy-ai-widget.js"></script>
 *
 * Or paste the contents directly into your existing JS file.
 *
 * API endpoint: https://web-production-a1f63.up.railway.app/api/chat
 */

(function () {
  const API_URL = 'https://web-production-a1f63.up.railway.app/api/chat';

  // ── Inject CSS ────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #ss-ai-panel {
      position: fixed;
      bottom: 90px;
      right: 20px;
      width: 380px;
      max-width: calc(100vw - 32px);
      height: 560px;
      max-height: calc(100vh - 110px);
      background: #12131a;
      border: 1px solid #2a2b38;
      border-radius: 16px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,165,0,0.08);
      z-index: 9998;
      opacity: 0;
      transform: translateY(16px) scale(0.97);
      transition: opacity 0.22s ease, transform 0.22s ease;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #ss-ai-panel.ss-open {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: all;
    }
    #ss-ai-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      border-bottom: 1px solid #1e1f2a;
      flex-shrink: 0;
    }
    #ss-ai-header .ss-avatar {
      width: 34px;
      height: 34px;
      background: linear-gradient(135deg, #f97316, #fb923c);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      flex-shrink: 0;
    }
    #ss-ai-header .ss-title {
      flex: 1;
    }
    #ss-ai-header .ss-title strong {
      display: block;
      color: #f1f1f1;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.01em;
    }
    #ss-ai-header .ss-title span {
      font-size: 11px;
      color: #4ade80;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    #ss-ai-header .ss-title span::before {
      content: '';
      width: 6px;
      height: 6px;
      background: #4ade80;
      border-radius: 50%;
      display: inline-block;
    }
    #ss-ai-close {
      background: none;
      border: none;
      color: #6b7280;
      cursor: pointer;
      padding: 4px;
      border-radius: 6px;
      font-size: 18px;
      line-height: 1;
      transition: color 0.15s, background 0.15s;
    }
    #ss-ai-close:hover { color: #f1f1f1; background: #1e1f2a; }

    #ss-ai-suggestions {
      display: flex;
      gap: 6px;
      padding: 10px 12px 0;
      flex-wrap: wrap;
      flex-shrink: 0;
    }
    .ss-suggestion {
      font-size: 11px;
      color: #f97316;
      background: rgba(249,115,22,0.1);
      border: 1px solid rgba(249,115,22,0.25);
      border-radius: 20px;
      padding: 4px 10px;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
      white-space: nowrap;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ss-suggestion:hover { background: rgba(249,115,22,0.2); border-color: rgba(249,115,22,0.5); }

    #ss-ai-messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      scrollbar-width: thin;
      scrollbar-color: #2a2b38 transparent;
    }
    #ss-ai-messages::-webkit-scrollbar { width: 4px; }
    #ss-ai-messages::-webkit-scrollbar-track { background: transparent; }
    #ss-ai-messages::-webkit-scrollbar-thumb { background: #2a2b38; border-radius: 2px; }

    .ss-msg {
      max-width: 88%;
      padding: 10px 13px;
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.55;
      animation: ss-fadein 0.18s ease;
    }
    @keyframes ss-fadein { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .ss-msg.ss-user {
      align-self: flex-end;
      background: linear-gradient(135deg, #f97316, #ea580c);
      color: #fff;
      border-bottom-right-radius: 4px;
    }
    .ss-msg.ss-ai {
      align-self: flex-start;
      background: #1a1b26;
      color: #d1d5db;
      border-bottom-left-radius: 4px;
      border: 1px solid #252636;
    }
    .ss-msg.ss-ai h1,.ss-msg.ss-ai h2,.ss-msg.ss-ai h3 {
      color: #f97316;
      margin: 8px 0 4px;
      font-size: 13px;
    }
    .ss-msg.ss-ai strong { color: #f1f1f1; }
    .ss-msg.ss-ai code {
      background: #0d0e14;
      padding: 1px 5px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 12px;
      color: #fb923c;
    }
    .ss-sources {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #252636;
      font-size: 11px;
      color: #6b7280;
    }
    .ss-sources span {
      background: #0d0e14;
      border: 1px solid #1e1f2a;
      border-radius: 4px;
      padding: 2px 6px;
      margin: 2px 2px 0 0;
      display: inline-block;
      color: #9ca3af;
      font-family: monospace;
    }
    .ss-typing {
      align-self: flex-start;
      background: #1a1b26;
      border: 1px solid #252636;
      border-radius: 12px;
      border-bottom-left-radius: 4px;
      padding: 12px 16px;
    }
    .ss-typing-dots {
      display: flex;
      gap: 4px;
      align-items: center;
    }
    .ss-typing-dots span {
      width: 6px; height: 6px;
      background: #f97316;
      border-radius: 50%;
      animation: ss-bounce 1.2s infinite;
    }
    .ss-typing-dots span:nth-child(2) { animation-delay: 0.2s; }
    .ss-typing-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes ss-bounce {
      0%,80%,100% { transform: translateY(0); opacity: 0.4; }
      40% { transform: translateY(-6px); opacity: 1; }
    }

    #ss-ai-input-row {
      display: flex;
      gap: 8px;
      padding: 12px;
      border-top: 1px solid #1e1f2a;
      flex-shrink: 0;
    }
    #ss-ai-input {
      flex: 1;
      background: #1a1b26;
      border: 1px solid #2a2b38;
      border-radius: 10px;
      padding: 9px 12px;
      color: #f1f1f1;
      font-size: 13px;
      outline: none;
      resize: none;
      font-family: inherit;
      line-height: 1.4;
      max-height: 96px;
      transition: border-color 0.15s;
    }
    #ss-ai-input::placeholder { color: #4b5563; }
    #ss-ai-input:focus { border-color: rgba(249,115,22,0.4); }
    #ss-ai-send {
      width: 38px;
      height: 38px;
      background: linear-gradient(135deg, #f97316, #ea580c);
      border: none;
      border-radius: 10px;
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      align-self: flex-end;
      transition: opacity 0.15s, transform 0.15s;
      font-size: 16px;
    }
    #ss-ai-send:hover { opacity: 0.9; transform: scale(1.05); }
    #ss-ai-send:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
    .ss-upload-btn {
      width: 38px; height: 38px;
      background: #1a1b26;
      border: 1px solid #2a2b38;
      border-radius: 10px;
      color: #9ca3af;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; align-self: flex-end;
      font-size: 16px;
      transition: border-color 0.15s, color 0.15s;
    }
    .ss-upload-btn:hover { border-color: #f97316; color: #f97316; }
    #ss-file-preview {
      padding: 0 12px 8px;
      font-size: 11px;
      color: #f97316;
      display: none;
    }

    @media (max-width: 420px) {
      #ss-ai-panel { right: 8px; left: 8px; width: auto; bottom: 80px; }
    }
  `;
  document.head.appendChild(style);

  // ── Build Panel HTML ──────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'ss-ai-panel';
  panel.innerHTML = `
    <div id="ss-ai-header">
      <div class="ss-avatar">⚡</div>
      <div class="ss-title">
        <strong>SparkStudy AI</strong>
        <span>CEC 2024 · Red Seal Study Assistant</span>
      </div>
      <button id="ss-ai-close" title="Close">✕</button>
    </div>
    <div id="ss-ai-suggestions">
      <button class="ss-suggestion">Practice exam: branch circuits</button>
      <button class="ss-suggestion">Explain bonding vs grounding</button>
      <button class="ss-suggestion">AFCI requirements dwelling</button>
    </div>
    <div id="ss-ai-messages"></div>
    <div id="ss-file-preview"></div>
    <div id="ss-ai-input-row">
      <label class="ss-upload-btn" title="Upload document or image">
        📎
        <input type="file" id="ss-file-input" accept=".txt,.pdf,image/*" style="display:none;">
      </label>
      <label class="ss-upload-btn" title="Take a photo">
        📷
        <input type="file" id="ss-camera-input" accept="image/*" capture="environment" style="display:none;">
      </label>
      <textarea id="ss-ai-input" placeholder="Ask about CEC rules, get a practice exam…" rows="1"></textarea>
      <button id="ss-ai-send">➤</button>
    </div>
  `;
  document.body.appendChild(panel);

  // ── State ─────────────────────────────────────────────────────────────────
  let history = [];
  let isLoading = false;
  let suggestionsShown = true;

  const messagesEl = panel.querySelector('#ss-ai-messages');
  const inputEl = panel.querySelector('#ss-ai-input');
  const sendBtn = panel.querySelector('#ss-ai-send');
  const suggestionsEl = panel.querySelector('#ss-ai-suggestions');
  const filePreviewEl = panel.querySelector('#ss-file-preview');
  let pendingFileText = '';

  // ── File / Camera handling ────────────────────────────────────────────────
  async function handleFile(file) {
    if (!file) return;
    const name = file.name || 'photo';
    if (file.type.startsWith('image/')) {
      // Show image preview in chat and ask AI to describe content
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsDataURL(file);
      });
      const img = document.createElement('div');
      img.className = 'ss-msg ss-user';
      img.innerHTML = `<img src="${dataUrl}" style="max-width:100%;border-radius:8px;display:block;margin-bottom:4px;"><span style="font-size:11px;opacity:0.7;">📷 ${name}</span>`;
      messagesEl.appendChild(img);
      scrollToBottom();
      hideSuggestions();
      pendingFileText = `[User uploaded an image: ${name}. Describe what study material or electrical content you can see, and help them understand it.]`;
      filePreviewEl.style.display = 'none';
      await sendRaw(pendingFileText);
      pendingFileText = '';
    } else if (file.type === 'text/plain') {
      const text = await file.text();
      pendingFileText = text.slice(0, 8000);
      filePreviewEl.textContent = `📎 ${name} ready — type a question or just hit send to have me summarize it.`;
      filePreviewEl.style.display = 'block';
    } else {
      filePreviewEl.textContent = `⚠️ PDF text extraction coming soon — paste the text directly for now.`;
      filePreviewEl.style.display = 'block';
    }
  }

  panel.querySelector('#ss-file-input').addEventListener('change', e => { handleFile(e.target.files[0]); e.target.value=''; });
  panel.querySelector('#ss-camera-input').addEventListener('change', e => { handleFile(e.target.files[0]); e.target.value=''; });

  // ── Open/close ────────────────────────────────────────────────────────────
  function openPanel() {
    panel.classList.add('ss-open');
    inputEl.focus();
    if (history.length === 0) addWelcomeMessage();
  }
  function closePanel() {
    panel.classList.remove('ss-open');
  }

  // Hook into askaiBtn via event delegation (works even if button is added after widget loads)
  document.addEventListener('click', function (e) {
    if (e.target && e.target.closest('#askaiBtn')) {
      e.stopPropagation();
      panel.classList.contains('ss-open') ? closePanel() : openPanel();
    }
  });
  panel.querySelector('#ss-ai-close').addEventListener('click', closePanel);

  // ── Welcome message ───────────────────────────────────────────────────────
  function addWelcomeMessage() {
    addAIMessage(
      "Hey! I'm your SparkStudy AI.\n\nI already have the full **2024 Canadian Electrical Code** locked in. Share any additional course notes, modules, or study material with me and I'll learn every bit of it front to back — then break it all down in plain language so it actually makes sense.\n\nAsk me anything or upload your material using the buttons below. ⚡",
      []
    );
  }

  // ── Suggestions ───────────────────────────────────────────────────────────
  suggestionsEl.querySelectorAll('.ss-suggestion').forEach(btn => {
    btn.addEventListener('click', () => {
      inputEl.value = btn.textContent;
      hideSuggestions();
      sendMessage();
    });
  });
  function hideSuggestions() {
    if (suggestionsShown) {
      suggestionsEl.style.display = 'none';
      suggestionsShown = false;
    }
  }

  // ── Markdown renderer (lightweight) ───────────────────────────────────────
  function renderMarkdown(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/^---$/gm, '<hr style="border-color:#252636;margin:8px 0">')
      .replace(/\n/g, '<br>');
  }

  // ── Add messages ──────────────────────────────────────────────────────────
  function addUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'ss-msg ss-user';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function addAIMessage(text, sources) {
    const el = document.createElement('div');
    el.className = 'ss-msg ss-ai';
    el.innerHTML = renderMarkdown(text);
    if (sources && sources.length > 0) {
      const src = document.createElement('div');
      src.className = 'ss-sources';
      src.innerHTML = '📖 Sources: ' + sources.map(s =>
        '<span>' + s.section + ' p.' + s.page + '</span>'
      ).join('');
      el.appendChild(src);
    }
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function addTyping() {
    const el = document.createElement('div');
    el.className = 'ss-typing';
    el.innerHTML = '<div class="ss-typing-dots"><span></span><span></span><span></span></div>';
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  async function sendRaw(question) {
    isLoading = true;
    sendBtn.disabled = true;
    const typing = addTyping();
    history.push({ role: 'user', content: question });
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history: history.slice(-6) })
      });
      const data = await res.json();
      typing.remove();
      if (data.error) {
        addAIMessage('Sorry, something went wrong: ' + data.error, []);
      } else {
        addAIMessage(data.answer, data.sources);
        history.push({ role: 'assistant', content: data.answer });
        if (history.length > 20) history = history.slice(-20);
      }
    } catch (err) {
      typing.remove();
      addAIMessage('Connection error — make sure you have internet access and try again.', []);
    }
    isLoading = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }

  async function sendMessage() {
    let q = inputEl.value.trim();
    if (!q && !pendingFileText) return;
    if (isLoading) return;

    hideSuggestions();
    filePreviewEl.style.display = 'none';
    inputEl.value = '';
    inputEl.style.height = 'auto';

    // If there's a pending file, prepend it to the question
    const fullQuestion = pendingFileText
      ? (q ? `Here is my material:\n\n${pendingFileText}\n\nMy question: ${q}` : `Here is my material — please read it and summarize the key points so I can understand it clearly:\n\n${pendingFileText}`)
      : q;
    pendingFileText = '';

    if (q) addUserMessage(q);
    await sendRaw(fullQuestion);
  }

  // ── Input events ──────────────────────────────────────────────────────────
  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  // Auto-resize textarea
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 96) + 'px';
  });

})();

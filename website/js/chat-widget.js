/**
 * EstimateAce marketing chat widget.
 * Calls https://app.estimateace.com/api/marketing/chat
 */
(function () {
  var API = 'https://app.estimateace.com/api/marketing/chat';
  var history = [];
  var chatStarted = false;

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (html != null) n.innerHTML = html;
    return n;
  }

  function addMsg(box, role, text) {
    var row = el('div', {
      class: 'ea-chat-msg ' + (role === 'user' ? 'ea-chat-user' : 'ea-chat-bot'),
    });
    row.textContent = text;
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  }

  function resetConversation(box) {
    history = [];
    chatStarted = false;
    if (!box) return;
    box.innerHTML = '';
    addMsg(
      box,
      'bot',
      'Hi! Ask about EstimateAce pricing, AI estimates, trials, or features. If I am not sure, we will get back to you within 48 hours.'
    );
  }

  function mount() {
    if (document.getElementById('ea-chat-root')) return;

    var style = el('style', {}, [
      '#ea-chat-root{position:fixed;z-index:99999;right:16px;bottom:16px;font-family:system-ui,-apple-system,sans-serif}',
      '#ea-chat-btn{background:#059669;color:#fff;border:0;border-radius:999px;padding:14px 20px;font-weight:700;font-size:15px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.25)}',
      '#ea-chat-btn:hover{background:#047857}',
      '#ea-chat-panel{display:none;position:absolute;right:0;bottom:64px;width:min(400px,calc(100vw - 24px));height:min(560px,calc(100vh - 100px));background:#fff;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.28);flex-direction:column;overflow:hidden;border:1px solid #e2e8f0}',
      '#ea-chat-panel.open{display:flex}',
      '#ea-chat-head{background:#0f172a;color:#fff;padding:12px 14px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '#ea-chat-head-text{font-weight:700;font-size:15px;line-height:1.3;padding-right:4px}',
      '#ea-chat-head-text small{display:block;font-weight:500;opacity:.8;margin-top:4px;font-size:12px}',
      '#ea-chat-close{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:6px;background:#ef4444;color:#fff;border:0;border-radius:10px;padding:10px 12px;font-weight:800;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)}',
      '#ea-chat-close:hover{background:#dc2626}',
      '#ea-chat-close span{font-size:18px;line-height:1;font-weight:900}',
      '#ea-chat-box{flex:1;overflow:auto;padding:12px;background:#f8fafc}',
      '.ea-chat-msg{margin:0 0 10px;padding:10px 12px;border-radius:12px;font-size:14px;line-height:1.45;white-space:pre-wrap}',
      '.ea-chat-bot{background:#fff;border:1px solid #e2e8f0;color:#0f172a}',
      '.ea-chat-user{background:#059669;color:#fff;margin-left:40px}',
      '#ea-chat-form{border-top:1px solid #e2e8f0;padding:10px;background:#fff;display:grid;gap:8px}',
      '#ea-chat-form input,#ea-chat-form textarea{width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:8px 10px;font-size:14px;box-sizing:border-box}',
      '#ea-chat-form textarea{min-height:64px;resize:vertical}',
      '#ea-chat-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '#ea-chat-send{background:#0f172a;color:#fff;border:0;border-radius:10px;padding:12px;font-weight:700;cursor:pointer}',
      '#ea-chat-send:disabled{opacity:.6;cursor:wait}',
      '#ea-chat-exit{background:#fff;color:#0f172a;border:2px solid #94a3b8;border-radius:10px;padding:12px;font-weight:700;cursor:pointer}',
      '#ea-chat-exit:hover{background:#f1f5f9;border-color:#64748b}',
    ].join(''));
    document.head.appendChild(style);

    var root = el('div', { id: 'ea-chat-root' });
    var btn = el('button', { id: 'ea-chat-btn', type: 'button' }, 'Message us');
    var panel = el('div', { id: 'ea-chat-panel' });
    panel.innerHTML =
      '<div id="ea-chat-head">' +
      '<div id="ea-chat-head-text">EstimateAce Assistant' +
      '<small>Ask about the product. If we cannot answer, we will reply within 48 hours.</small></div>' +
      '<button type="button" id="ea-chat-close" aria-label="Close chat"><span>&times;</span> Close</button>' +
      '</div>' +
      '<div id="ea-chat-box"></div>' +
      '<form id="ea-chat-form">' +
      '<input id="ea-chat-name" type="text" placeholder="Your name (optional)" autocomplete="name" />' +
      '<input id="ea-chat-email" type="email" placeholder="Email (optional - for follow-up)" autocomplete="email" />' +
      '<textarea id="ea-chat-q" placeholder="Ask a question..." required></textarea>' +
      '<div id="ea-chat-actions">' +
      '<button type="button" id="ea-chat-exit">Close chat</button>' +
      '<button type="submit" id="ea-chat-send">Send</button>' +
      '</div>' +
      '</form>';

    root.appendChild(panel);
    root.appendChild(btn);
    document.body.appendChild(root);

    var box = document.getElementById('ea-chat-box');
    var closeBtn = document.getElementById('ea-chat-close');
    var exitBtn = document.getElementById('ea-chat-exit');

    function openPanel() {
      panel.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }

    function closePanel(reset) {
      panel.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      btn.textContent = 'Message us';
      if (reset) {
        resetConversation(box);
        var nameEl = document.getElementById('ea-chat-name');
        var emailEl = document.getElementById('ea-chat-email');
        var qEl = document.getElementById('ea-chat-q');
        if (nameEl) nameEl.value = '';
        if (emailEl) emailEl.value = '';
        if (qEl) qEl.value = '';
      }
    }

    addMsg(
      box,
      'bot',
      'Hi! Ask about EstimateAce pricing, AI estimates, trials, or features. If I am not sure, we will get back to you within 48 hours.'
    );

    btn.addEventListener('click', function () {
      if (panel.classList.contains('open')) {
        closePanel(false);
      } else {
        openPanel();
      }
    });

    closeBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      closePanel(true);
    });

    exitBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      closePanel(true);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.classList.contains('open')) {
        closePanel(false);
      }
    });

    document.getElementById('ea-chat-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var qEl = document.getElementById('ea-chat-q');
      var question = (qEl.value || '').trim();
      if (!question) return;
      var name = (document.getElementById('ea-chat-name').value || '').trim();
      var email = (document.getElementById('ea-chat-email').value || '').trim();
      var sendBtn = document.getElementById('ea-chat-send');

      chatStarted = true;
      addMsg(box, 'user', question);
      history.push({ role: 'user', text: question });
      qEl.value = '';
      sendBtn.disabled = true;
      sendBtn.textContent = 'Thinking…';

      fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question, name: name, email: email, history: history }),
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          var answer =
            (res.j && res.j.answer) ||
            'Thanks — we saved your question and will get back to you within 48 hours.';
          addMsg(box, 'bot', answer);
          history.push({ role: 'assistant', text: answer });
        })
        .catch(function () {
          var fallback =
            'Thanks — we could not reach the assistant just now. We will get back to you within 48 hours.';
          addMsg(box, 'bot', fallback);
        })
        .finally(function () {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send';
        });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();

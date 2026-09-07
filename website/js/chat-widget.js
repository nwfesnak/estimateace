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

  function closeChat(panel, btn, box, endWrap) {
    panel.classList.remove('open');
    btn.textContent = 'Message us';
    if (chatStarted) {
      history = [];
      chatStarted = false;
      if (box) {
        box.innerHTML = '';
        addMsg(
          box,
          'bot',
          'Hi! Ask about EstimateAce pricing, AI estimates, trials, or features. If I am not sure, we will get back to you within 48 hours.'
        );
      }
      if (endWrap) endWrap.style.display = 'none';
      var nameEl = document.getElementById('ea-chat-name');
      var emailEl = document.getElementById('ea-chat-email');
      var qEl = document.getElementById('ea-chat-q');
      if (nameEl) nameEl.value = '';
      if (emailEl) emailEl.value = '';
      if (qEl) qEl.value = '';
    }
  }

  function mount() {
    if (document.getElementById('ea-chat-root')) return;

    var style = el('style', {}, [
      '#ea-chat-root{position:fixed;z-index:99999;right:20px;bottom:20px;font-family:system-ui,sans-serif}',
      '#ea-chat-btn{background:#059669;color:#fff;border:0;border-radius:999px;padding:14px 20px;font-weight:700;font-size:15px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.25)}',
      '#ea-chat-btn:hover{background:#047857}',
      '#ea-chat-panel{display:none;position:absolute;right:0;bottom:64px;width:min(380px,calc(100vw - 32px));height:520px;background:#fff;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.28);flex-direction:column;overflow:hidden;border:1px solid #e2e8f0}',
      '#ea-chat-panel.open{display:flex}',
      '#ea-chat-head{background:#0f172a;color:#fff;padding:14px 16px 12px;font-weight:700;position:relative;padding-right:48px}',
      '#ea-chat-head small{display:block;font-weight:500;opacity:.75;margin-top:4px;padding-right:8px}',
      '#ea-chat-close{position:absolute;top:10px;right:10px;width:32px;height:32px;border:0;border-radius:8px;background:rgba(255,255,255,.12);color:#fff;font-size:18px;line-height:1;cursor:pointer}',
      '#ea-chat-close:hover{background:rgba(255,255,255,.22)}',
      '#ea-chat-box{flex:1;overflow:auto;padding:12px;background:#f8fafc}',
      '.ea-chat-msg{margin:0 0 10px;padding:10px 12px;border-radius:12px;font-size:14px;line-height:1.45;white-space:pre-wrap}',
      '.ea-chat-bot{background:#fff;border:1px solid #e2e8f0;color:#0f172a}',
      '.ea-chat-user{background:#059669;color:#fff;margin-left:40px}',
      '#ea-chat-end-wrap{display:none;padding:0 10px 8px;background:#fff;border-top:1px solid #e2e8f0}',
      '#ea-chat-end{width:100%;border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;border-radius:10px;padding:9px;font-weight:600;font-size:13px;cursor:pointer}',
      '#ea-chat-end:hover{background:#e2e8f0}',
      '#ea-chat-form{border-top:1px solid #e2e8f0;padding:10px;background:#fff;display:grid;gap:8px}',
      '#ea-chat-form input,#ea-chat-form textarea{width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:8px 10px;font-size:14px;box-sizing:border-box}',
      '#ea-chat-form textarea{min-height:64px;resize:vertical}',
      '#ea-chat-form button[type=submit]{background:#0f172a;color:#fff;border:0;border-radius:10px;padding:10px;font-weight:700;cursor:pointer}',
      '#ea-chat-form button[type=submit]:disabled{opacity:.6;cursor:wait}',
    ].join(''));
    document.head.appendChild(style);

    var root = el('div', { id: 'ea-chat-root' });
    var btn = el('button', { id: 'ea-chat-btn', type: 'button' }, 'Message us');
    var panel = el('div', { id: 'ea-chat-panel' });
    panel.innerHTML =
      '<div id="ea-chat-head">EstimateAce Assistant' +
      '<small>Ask about the product. If we cannot answer, we will reply within 48 hours.</small>' +
      '<button type="button" id="ea-chat-close" aria-label="Close chat" title="Close">×</button></div>' +
      '<div id="ea-chat-box"></div>' +
      '<div id="ea-chat-end-wrap"><button type="button" id="ea-chat-end">End chat / Exit</button></div>' +
      '<form id="ea-chat-form">' +
      '<input id="ea-chat-name" type="text" placeholder="Your name (optional)" autocomplete="name" />' +
      '<input id="ea-chat-email" type="email" placeholder="Email (optional - for follow-up)" autocomplete="email" />' +
      '<textarea id="ea-chat-q" placeholder="Ask a question..." required></textarea>' +
      '<button type="submit" id="ea-chat-send">Send</button>' +
      '</form>';

    root.appendChild(panel);
    root.appendChild(btn);
    document.body.appendChild(root);

    var box = document.getElementById('ea-chat-box');
    var endWrap = document.getElementById('ea-chat-end-wrap');
    var endBtn = document.getElementById('ea-chat-end');
    var closeBtn = document.getElementById('ea-chat-close');

    addMsg(
      box,
      'bot',
      'Hi! Ask about EstimateAce pricing, AI estimates, trials, or features. If I am not sure, we will get back to you within 48 hours.'
    );

    function openPanel() {
      panel.classList.add('open');
    }

    function onExit() {
      closeChat(panel, btn, box, endWrap);
    }

    btn.addEventListener('click', function () {
      if (panel.classList.contains('open')) {
        onExit();
      } else {
        openPanel();
      }
    });

    closeBtn.addEventListener('click', onExit);
    endBtn.addEventListener('click', onExit);

    document.getElementById('ea-chat-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var qEl = document.getElementById('ea-chat-q');
      var question = (qEl.value || '').trim();
      if (!question) return;
      var name = (document.getElementById('ea-chat-name').value || '').trim();
      var email = (document.getElementById('ea-chat-email').value || '').trim();
      var sendBtn = document.getElementById('ea-chat-send');

      chatStarted = true;
      endWrap.style.display = 'block';

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

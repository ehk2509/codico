(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var renderMd = window.CodicoMarkdown.renderMd;
  var streamNotices = window.CodicoStreamNotices.create({
    scrollBottom: scrollBottom,
    sendMessage: function(text) {
      vscode.postMessage({ type: 'sendMessage', text: text, contentParts: undefined });
    },
    compactAndContinue: function() {
      _pendingContinueAfterCompact = true;
      vscode.postMessage({ type: 'compactChat' });
    }
  });
  var showStreamFinishReason = streamNotices.showStreamFinishReason;
  var showStreamInlineError = streamNotices.showStreamInlineError;

  // ── Custom dropdown helpers ─────────────────────────────────────────────
  var _openDrop = null;
  function _closeDrop() {
    if (_openDrop) { _openDrop.classList.remove('open'); _openDrop = null; }
  }
  document.addEventListener('click', _closeDrop);
  function _makeDrop(el, onChange, searchable) {
    var valEl = el.querySelector('.csel-val');
    var dropEl = el.querySelector('.csel-drop');
    var listEl = dropEl;
    var searchInput = null;

    if (searchable) {
      var searchWrap = document.createElement('div');
      searchWrap.className = 'csel-search-wrap';
      searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.className = 'csel-search';
      searchInput.placeholder = '🔍 Search models…';
      searchWrap.appendChild(searchInput);
      dropEl.appendChild(searchWrap);
      listEl = document.createElement('div');
      listEl.className = 'csel-list';
      dropEl.appendChild(listEl);
      searchInput.addEventListener('input', function () {
        var q = searchInput.value.toLowerCase().trim();
        listEl.querySelectorAll('.csel-opt,.csel-group').forEach(function (node) {
          if (node.classList.contains('csel-group')) {
            node.style.display = '';
          } else {
            var match = !q || node.textContent.toLowerCase().includes(q) || (node.dataset.value || '').toLowerCase().includes(q);
            node.style.display = match ? '' : 'none';
          }
        });
        // hide group headers that have no visible options
        listEl.querySelectorAll('.csel-group').forEach(function (grp) {
          var next = grp.nextElementSibling;
          var hasVisible = false;
          while (next && !next.classList.contains('csel-group')) {
            if (next.style.display !== 'none') { hasVisible = true; break; }
            next = next.nextElementSibling;
          }
          grp.style.display = hasVisible ? '' : 'none';
        });
      });
      searchInput.addEventListener('click', function (e) { e.stopPropagation(); });
    }

    el.addEventListener('click', function (e) {
      e.stopPropagation();
      if (_openDrop === el) { _closeDrop(); return; }
      _closeDrop();
      var r = el.getBoundingClientRect();
      dropEl.style.top = (r.bottom + 2) + 'px';
      dropEl.style.left = r.left + 'px';
      el.classList.add('open');
      _openDrop = el;
      // Clamp dropdown to viewport so it never overflows right or bottom
      setTimeout(function () {
        var dr = dropEl.getBoundingClientRect();
        if (dr.right > window.innerWidth - 4) {
          dropEl.style.left = Math.max(4, window.innerWidth - dr.width - 4) + 'px';
        }
        if (dr.bottom > window.innerHeight - 8) {
          dropEl.style.top = Math.max(4, r.top - dr.height - 2) + 'px';
        }
      }, 0);
      if (searchInput) {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input'));
        setTimeout(function () { searchInput.focus(); }, 0);
      }
    });
    return {
      getValue: function () { return el.dataset.value || ''; },
      setValue: function (v) {
        var opts = listEl.querySelectorAll('.csel-opt');
        for (var i = 0; i < opts.length; i++) {
          if (opts[i].dataset.value === v) {
            el.dataset.value = v;
            valEl.textContent = opts[i].textContent;
            opts[i].classList.add('selected');
          } else { opts[i].classList.remove('selected'); }
        }
      },
      addGroup: function (label) {
        var g = document.createElement('div');
        g.className = 'csel-group';
        g.textContent = label;
        listEl.appendChild(g);
      },
      addOpt: function (value, label, isSelected) {
        var opt = document.createElement('div');
        opt.className = 'csel-opt' + (isSelected ? ' selected' : '');
        opt.dataset.value = value;
        opt.textContent = label;
        if (isSelected) { el.dataset.value = value; valEl.textContent = label; }
        opt.addEventListener('click', function (e) {
          e.stopPropagation();
          el.dataset.value = value;
          valEl.textContent = label;
          listEl.querySelectorAll('.csel-opt').forEach(function (o) {
            o.classList.toggle('selected', o === opt);
          });
          _closeDrop();
          onChange(value);
        });
        listEl.appendChild(opt);
      }
    };
  }

  // ── Build model dropdown from models.json ────────────────────────────────
  var modelDrop = _makeDrop(document.getElementById('model-csel'), function (v) {
    vscode.postMessage({ type: 'changeModel', model: v });
  }, true);
  (function () {
    var groups = window.__MODELS__ || [];
    var tiers = ['free', 'premium', 'direct'];
    var icons = { free: '\uD83C\uDD93', premium: '\uD83D\uDC8E', direct: '\uD83D\uDD11' };
    tiers.forEach(function (tier) {
      groups.filter(function (g) { return g.tier === tier; }).forEach(function (g) {
        modelDrop.addGroup(icons[tier] + ' ' + g.provider);
        g.models.forEach(function (m) { modelDrop.addOpt(m.id, m.label, !!m.default); });
      });
    });
  }());

  // ── Build effort dropdown ────────────────────────────────────────────────
  var effortDrop = _makeDrop(document.getElementById('effort-csel'), function (v) {
    vscode.postMessage({ type: 'changeEffort', effort: v });
  });
  effortDrop.addOpt('high',   '\uD83E\uDDE0 High', false);
  effortDrop.addOpt('medium', '\uD83E\uDDE0 Med',  true);
  effortDrop.addOpt('low',    '\uD83E\uDDE0 Low',  false);

  var streaming = false;
  // Reset stale streaming-state that retainContextWhenHidden may have preserved
  document.getElementById('send-btn').textContent    = 'Send';
  document.getElementById('send-btn').className      = '';
  document.getElementById('stop-btn').style.display  = 'none';
  document.getElementById('s-text').textContent      = 'Ready';
  document.getElementById('s-dot').className         = 's-dot';
  var curId = null;
  var curThinkRaw = '';
  var curContentRaw = '';  // full raw (for copy)
  var curAoEl = null;      // current active text segment element
  var curSegRaw = '';      // raw text for current segment only
  var curThinkWrap = null; // active think-wrap element (null = create new block on next chunk)
  var curThinkBody = null; // active think-body element
  var curThinkIdx  = 0;    // per-message counter → unique block IDs
  var msgContents = {}; // id -> final plain text content
  var ctxAttachments = []; // { kind, label, text }
  var _planGoals = {}; // msgId -> plan goal, for replies the extension marked as plans
  var _allowAllWrites   = false; // set by "Allow All" on a write-perm card; reset each user turn
  var _allowAllTerminal = false; // set by "Allow All" on a terminal-perm card; reset each user turn
  var _pendingContinueAfterCompact = false; // set when Continue is clicked after context overflow
  var _planTasks       = [];   // [{n, text, status}] parsed from plan
  var _todoTrackerEl   = null; // live tracker DOM element during execution
  var _isExecutingPlan = false;// flag to inject tracker in next startMsg

  var msgs     = document.getElementById('messages');
  var welcome  = document.getElementById('welcome');
  var input    = document.getElementById('msg-input');
  var sendBtn  = document.getElementById('send-btn');
  var stopBtn  = document.getElementById('stop-btn');
  var sDot     = document.getElementById('s-dot');
  var sText    = document.getElementById('s-text');
  var sStep    = document.getElementById('s-step');
  var bgBtn    = document.getElementById('bg-btn');
  bgBtn.addEventListener('click', function() {
    bgBtn.disabled = true;
    vscode.postMessage({ type: 'killBackgroundProcesses' });
  });
  /** Pending follow-up: { rawInput, attachments } — sent automatically when stream ends. */
  var _queuedMsg = null;
  var _queuedBarEl = null;
  /** Set when the follow-up message bubble was already rendered at queue time. */
  var _skipNextAppendUserMsg = false;
  /** Last message payload — used by the Retry button after an API failure. */
  var _lastSentPayload = null;
  var sTokens  = document.getElementById('s-tokens');
  var ctxChips   = document.getElementById('ctx-chips');

  var slashHintEl = document.getElementById('slash-hint');
  var imgPreviewWrap = document.getElementById('img-preview-wrap');
  var activeAgentBar = document.getElementById('active-agent-bar');
  var _pastedImages = []; // [{dataUrl}]
  var _activeAgent = null; // 'workspace' | 'terminal' | 'vscode' | null

  var AGENTS = [
    { name: '@workspace', desc: 'Answer questions about the codebase' },
    { name: '@terminal',  desc: 'Help with shell commands and terminal output' },
    { name: '@vscode',    desc: 'Help with VS Code settings, API, and extensions' },
    { name: '@github',    desc: 'Search GitHub issues, PRs, and repositories' },
  ];

  var SLASH_COMMANDS = [
    { cmd: '/fix',      desc: 'Fix bugs and errors in the selected/active code' },
    { cmd: '/explain',  desc: 'Explain the selected/active code step by step' },
    { cmd: '/doc',      desc: 'Add JSDoc/TSDoc documentation to the code' },
    { cmd: '/tests',    desc: 'Write unit tests for the selected/active code' },
    { cmd: '/plan',     desc: 'Create a step-by-step plan for a goal' },
    { cmd: '/review',   desc: 'Review the active file or selection for issues' },
    { cmd: '/pr',       desc: 'Fetch GitHub PR context for the current branch and review it' },
    { cmd: '/coverage', desc: 'Read coverage report and generate tests for untested lines' },
    { cmd: '/test',     desc: 'Run test suite and auto-fix failures until all pass' },
    { cmd: '/new',      desc: 'Create a new file or project scaffold from a description' },
    { cmd: '/compact',  desc: 'Summarize conversation history to reduce context size' },
  ];

  var _slashHintIdx = -1;
  var _hintMode = null; // 'slash' | 'mention' | null

  function _setHintMode(mode) {
    _hintMode = mode;
    _slashHintIdx = -1;
  }

  // ── @mention popup ─────────────────────────────────────────────────────────
  function _showMentionHints(filter) {
    var q = filter.toLowerCase();
    var matches = AGENTS.filter(function(a) { return a.name.startsWith(q); });
    if (matches.length === 0) { slashHintEl.style.display = 'none'; _setHintMode(null); return; }
    _setHintMode('mention');
    slashHintEl.innerHTML = '';
    matches.forEach(function(a) {
      var item = document.createElement('div');
      item.className = 'slash-hint-item';
      item.dataset.cmd = a.name;
      item.innerHTML = '<span class="mention-cmd">' + esc(a.name) + '</span><span class="slash-hint-desc">' + esc(a.desc) + '</span>';
      item.addEventListener('mousedown', function(e) {
        e.preventDefault();
        _applyAgentMention(a.name.slice(1)); // strip '@'
      });
      slashHintEl.appendChild(item);
    });
    slashHintEl.style.display = 'block';
  }

  function _applyAgentMention(agentName) {
    // Remove any @mention from input text, set badge instead
    input.value = input.value.replace(/@\S*/g, '').trim();
    slashHintEl.style.display = 'none';
    _setHintMode(null);
    _setActiveAgent(agentName);
    input.focus();
  }

  function _setActiveAgent(agentName) {
    _activeAgent = agentName;
    _renderAgentBadge();
  }

  function _clearActiveAgent() {
    _activeAgent = null;
    _renderAgentBadge();
  }

  function _renderAgentBadge() {
    activeAgentBar.innerHTML = '';
    if (!_activeAgent) { activeAgentBar.style.display = 'none'; return; }
    activeAgentBar.style.display = 'flex';
    var badge = document.createElement('button');
    badge.className = 'mention-badge';
    badge.title = 'Click to remove agent';
    badge.innerHTML = '<span>@' + esc(_activeAgent) + '</span><span class="badge-x">×</span>';
    badge.addEventListener('click', function() { _clearActiveAgent(); });
    activeAgentBar.appendChild(badge);
  }

  // ── MCP Status ────────────────────────────────────────────────────────────
  function _updateMcpStatus(servers) {
    var bar = document.getElementById('mcp-status-bar');
    if (!bar) { return; }
    bar.innerHTML = '';
    if (!servers || servers.length === 0) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    servers.forEach(function(s) {
      var pill = document.createElement('span');
      pill.className = 'mcp-server-pill' + (s.connected ? '' : ' mcp-pill-offline');
      pill.title = s.connected
        ? (s.toolCount + ' tool' + (s.toolCount === 1 ? '' : 's') + ' available')
        : ('Offline' + (s.error ? ': ' + s.error : ''));
      pill.textContent = (s.connected ? '⚡ ' : '○ ') + s.name + (s.connected ? ' (' + s.toolCount + ')' : '');
      bar.appendChild(pill);
    });
  }

  // Handle agentActive message from extension (confirms agent was applied)
  // already handled in the main message switch below

  function _showSlashHints(filter) {
    var matches = SLASH_COMMANDS.filter(function(s) {
      return s.cmd.startsWith(filter.toLowerCase());
    });
    if (matches.length === 0 || filter === matches[0].cmd) {
      slashHintEl.style.display = 'none'; _setHintMode(null); return;
    }
    _setHintMode('slash');
    slashHintEl.innerHTML = '';
    matches.forEach(function(s, i) {
      var item = document.createElement('div');
      item.className = 'slash-hint-item';
      item.dataset.cmd = s.cmd;
      item.innerHTML = '<span class="slash-hint-cmd">' + esc(s.cmd) + '</span><span class="slash-hint-desc">' + esc(s.desc) + '</span>';
      item.addEventListener('mousedown', function(e) {
        e.preventDefault();
        input.value = s.cmd + ' ';
        slashHintEl.style.display = 'none';
        _setHintMode(null);
        input.focus();
      });
      slashHintEl.appendChild(item);
    });
    slashHintEl.style.display = 'block';
  }

  function _slashHintNavigate(dir) {
    var items = slashHintEl.querySelectorAll('.slash-hint-item');
    if (!items.length) { return false; }
    items.forEach(function(el) { el.classList.remove('active'); });
    _slashHintIdx = (_slashHintIdx + dir + items.length) % items.length;
    items[_slashHintIdx].classList.add('active');
    return true;
  }

  // Auto-resize textarea
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    var val = input.value;
    // Slash command hints: /... at start, no space yet
    if (val.startsWith('/') && !val.includes(' ')) {
      _showSlashHints(val);
    // @mention hints: last word starts with @
    } else {
      var mentionMatch = val.match(/@(\S*)$/);
      if (mentionMatch) {
        _showMentionHints('@' + mentionMatch[1]);
      } else {
        slashHintEl.style.display = 'none';
        _setHintMode(null);
      }
    }
  });

  input.addEventListener('keydown', function (e) {
    // Navigate popup (slash or mention) with ArrowUp/Down, Tab/Enter to select
    if (slashHintEl.style.display !== 'none') {
      if (e.key === 'ArrowDown') { e.preventDefault(); _slashHintNavigate(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); _slashHintNavigate(-1); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && _slashHintIdx >= 0)) {
        e.preventDefault();
        var active = slashHintEl.querySelector('.slash-hint-item.active') || slashHintEl.querySelector('.slash-hint-item');
        if (active) {
          if (_hintMode === 'mention') {
            _applyAgentMention(active.dataset.cmd.slice(1)); // strip '@'
          } else {
            input.value = active.dataset.cmd + ' ';
            slashHintEl.style.display = 'none';
            _setHintMode(null);
          }
        }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); slashHintEl.style.display = 'none'; _setHintMode(null); return; }
    }
    // Up in an empty input edits your last message (like most chat apps)
    if (e.key === 'ArrowUp' && !input.value && !streaming) {
      var mine = msgs.querySelectorAll('.msg.user[data-editable="1"]');
      if (mine.length > 0) { e.preventDefault(); _startEditUserMsg(mine[mine.length - 1]); }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // ── Vision model detection ─────────────────────────────────────────────────
  var VISION_MODEL_RE = /^(anthropic\/|openai\/gpt-4|openai\/gpt-5|openai\/o[134]|google\/gemini|google\/gemma-4|x-ai\/grok|z-ai\/glm-5v|moonshotai\/kimi|minimax\/minimax-m)/;
  function _isVisionModel() {
    var id = modelDrop.getValue();
    if (!id) { return true; }
    if (id.startsWith('ollama/')) { return false; }
    return VISION_MODEL_RE.test(id);
  }

  // ── Image reading helper ───────────────────────────────────────────────────
  function _readImageFile(file) {
    var reader = new FileReader();
    reader.onload = function(ev) {
      _pastedImages.push({ dataUrl: ev.target.result });
      _renderImgPreviews();
    };
    reader.readAsDataURL(file);
  }

  // Image paste handling — use items (captures OS screenshots), fall back to files
  input.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items || items.length === 0) { return; }
    var hasImg = false;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        var f = items[i].getAsFile();
        if (f) { hasImg = true; _readImageFile(f); }
      }
    }
    if (hasImg) { e.preventDefault(); }
  });

  // ── File picker button ─────────────────────────────────────────────────────
  var attachImgBtn   = document.getElementById('attach-img-btn');
  var attachImgInput = document.getElementById('attach-img-input');
  attachImgBtn.addEventListener('click', function() { attachImgInput.click(); });
  attachImgInput.addEventListener('change', function() {
    Array.from(attachImgInput.files).forEach(_readImageFile);
    attachImgInput.value = '';
  });

  // ── Drag-and-drop images onto the input area ───────────────────────────────
  var inputArea = document.getElementById('input-area');
  inputArea.addEventListener('dragover', function(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    if (types && (types.indexOf('Files') !== -1 || types.indexOf('application/x-moz-file') !== -1)) {
      e.preventDefault();
      inputArea.classList.add('drag-over');
    }
  });
  inputArea.addEventListener('dragleave', function(e) {
    if (!inputArea.contains(e.relatedTarget)) { inputArea.classList.remove('drag-over'); }
  });
  inputArea.addEventListener('drop', function(e) {
    inputArea.classList.remove('drag-over');
    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files || files.length === 0) { return; }
    var hasImg = false;
    for (var i = 0; i < files.length; i++) {
      if (files[i].type.startsWith('image/')) { hasImg = true; _readImageFile(files[i]); }
    }
    if (hasImg) { e.preventDefault(); }
  });

  function _renderImgPreviews() {
    imgPreviewWrap.innerHTML = '';
    if (_pastedImages.length === 0) { imgPreviewWrap.style.display = 'none'; return; }
    imgPreviewWrap.style.display = 'flex';
    _pastedImages.forEach(function(img, idx) {
      var wrap = document.createElement('div');
      wrap.className = 'img-preview-item';
      var imgEl = document.createElement('img');
      imgEl.src = img.dataUrl;
      var removeBtn = document.createElement('button');
      removeBtn.className = 'img-preview-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove image';
      removeBtn.addEventListener('click', function() {
        _pastedImages.splice(idx, 1);
        _renderImgPreviews();
      });
      wrap.appendChild(imgEl);
      wrap.appendChild(removeBtn);
      imgPreviewWrap.appendChild(wrap);
    });
    if (!_isVisionModel()) {
      var warn = document.createElement('div');
      warn.className = 'img-vision-warn';
      warn.textContent = '⚠ Current model may not support images — switch to Claude, GPT-4o, or Gemini for vision.';
      imgPreviewWrap.appendChild(warn);
    }
  }

  sendBtn.addEventListener('click', function () {
    send();
  });

  document.getElementById('clear-btn').addEventListener('click', clearChat);
  document.getElementById('new-thread-btn').addEventListener('click', function() {
    vscode.postMessage({ type: 'createThread' });
  });

  // ── Thread search ──────────────────────────────────────────────────────────
  var _searchOverlay = document.getElementById('thread-search-overlay');
  var _searchInput = document.getElementById('thread-search-input');
  var _searchResults = document.getElementById('thread-search-results');
  var _searchBtn = document.getElementById('search-threads-btn');
  var _searchDebounce = null;
  var _currentThreadIdForSearch = null; // set when threadList arrives

  function _openSearch() {
    _searchOverlay.classList.add('open');
    _searchBtn.classList.add('active');
    _searchInput.value = '';
    _searchResults.innerHTML = '<div class="ts-empty">Type to search across all conversations</div>';
    setTimeout(function() { _searchInput.focus(); }, 30);
  }
  function _closeSearch() {
    _searchOverlay.classList.remove('open');
    _searchBtn.classList.remove('active');
  }

  _searchBtn.addEventListener('click', function() {
    if (_searchOverlay.classList.contains('open')) { _closeSearch(); }
    else { _openSearch(); }
  });
  document.getElementById('thread-search-close').addEventListener('click', _closeSearch);

  _searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { e.preventDefault(); _closeSearch(); }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      var first = _searchResults.querySelector('.ts-result');
      if (first) { first.focus(); }
    }
  });

  _searchInput.addEventListener('input', function() {
    var q = _searchInput.value.trim();
    clearTimeout(_searchDebounce);
    if (!q) {
      _searchResults.innerHTML = '<div class="ts-empty">Type to search across all conversations</div>';
      return;
    }
    _searchResults.innerHTML = '<div class="ts-empty">Searching…</div>';
    _searchDebounce = setTimeout(function() {
      vscode.postMessage({ type: 'searchThreads', query: q });
    }, 220);
  });

  function _highlightMatch(text, query) {
    var q = query.trim();
    if (!q) { return esc(text); }
    var lower = text.toLowerCase();
    var lq = q.toLowerCase();
    var out = ''; var i = 0;
    while (i < text.length) {
      var idx = lower.indexOf(lq, i);
      if (idx === -1) { out += esc(text.slice(i)); break; }
      out += esc(text.slice(i, idx));
      out += '<span class="ts-hi">' + esc(text.slice(idx, idx + lq.length)) + '</span>';
      i = idx + lq.length;
    }
    return out;
  }

  function _renderSearchResults(query, results) {
    if (!results || results.length === 0) {
      _searchResults.innerHTML = '<div class="ts-empty">No results for <strong>' + esc(query) + '</strong></div>';
      return;
    }
    var html = '';
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var isActive = r.threadId === _currentThreadIdForSearch;
      html += '<div class="ts-result' + (isActive ? ' ts-active-thread' : '') + '" tabindex="0" data-tid="' + esc(r.threadId) + '">';
      html += '<div class="ts-thread-name">' + _highlightMatch(r.threadName, query);
      if (isActive) { html += '<span class="ts-badge">current</span>'; }
      html += '</div>';
      for (var j = 0; j < r.snippets.length; j++) {
        var s = r.snippets[j];
        html += '<div class="ts-snippet"><span class="ts-role">' + (s.role === 'user' ? '▶' : '◀') + '</span>' + _highlightMatch(s.snippet, query) + '</div>';
      }
      html += '</div>';
    }
    _searchResults.innerHTML = html;

    // Attach click + keyboard handlers
    var items = _searchResults.querySelectorAll('.ts-result');
    for (var k = 0; k < items.length; k++) {
      (function(el) {
        el.addEventListener('click', function() {
          var tid = el.dataset.tid;
          _closeSearch();
          vscode.postMessage({ type: 'switchThread', id: tid });
        });
        el.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { el.click(); }
          if (e.key === 'ArrowDown') { e.preventDefault(); var n = el.nextElementSibling; if (n) { n.focus(); } }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            var p = el.previousElementSibling;
            if (p && p.classList.contains('ts-result')) { p.focus(); }
            else { _searchInput.focus(); }
          }
          if (e.key === 'Escape') { e.preventDefault(); _closeSearch(); }
        });
      })(items[k]);
    }
  }

  document.getElementById('diag-badge').addEventListener('click', function() {
    vscode.postMessage({ type: 'openProblems' });
  });
  // ── Edits Mode toggle ────────────────────────────────────────────────────
  var _editsMode = false;
  var editsModeWrap = document.getElementById('edits-mode-wrap');
  var editsModeCb   = document.getElementById('edits-mode-cb');
  editsModeCb.addEventListener('change', function () {
    _editsMode = editsModeCb.checked;
    editsModeWrap.classList.toggle('active', _editsMode);
    var inp = document.getElementById('msg-input');
    if (inp) { inp.placeholder = _editsMode ? 'Edits Mode: describe changes across files…' : 'Ask Codico… (/ for commands, @ for agents)'; }
    vscode.postMessage({ type: 'toggleEditsMode', enabled: _editsMode });
  });

  // ── Ask / Plan / Agent mode toggle ──────────────────────────────────────
  var _mode = 'agent'; // 'ask' | 'plan' | 'agent'
  var modeAskBtn   = document.getElementById('mode-ask-btn');
  var modePlanBtn  = document.getElementById('mode-plan-btn');
  var modeAgentBtn = document.getElementById('mode-agent-btn');
  var PLACEHOLDERS = { ask: 'Ask about your code… (read-only)', plan: 'Describe the task to plan…', agent: 'Ask Codico… (/ for commands, @ for agents)' };
  function _setMode(mode) {
    _mode = mode;
    modeAskBtn.classList.toggle('mode-active',   mode === 'ask');
    modePlanBtn.classList.toggle('mode-active',  mode === 'plan');
    modeAgentBtn.classList.toggle('mode-active', mode === 'agent');
    var inp = document.getElementById('msg-input');
    if (inp) { inp.placeholder = PLACEHOLDERS[mode]; }
    vscode.postMessage({ type: 'toggleChatMode', chatMode: mode === 'ask' });
  }
  modeAskBtn.addEventListener('click',   function () { if (_mode !== 'ask')   { _setMode('ask');   } });
  modePlanBtn.addEventListener('click',  function () { if (_mode !== 'plan')  { _setMode('plan');  } });
  modeAgentBtn.addEventListener('click', function () { if (_mode !== 'agent') { _setMode('agent'); } });

  // ── Auto-commit toggle ───────────────────────────────────────────────────
  var _autoCommit = false;
  var autoCommitWrap = document.getElementById('auto-commit-wrap');
  var autoCommitCb   = document.getElementById('auto-commit-cb');
  autoCommitCb.addEventListener('change', function () {
    _autoCommit = autoCommitCb.checked;
    autoCommitWrap.classList.toggle('active', _autoCommit);
    vscode.postMessage({ type: 'toggleAutoCommit', enabled: _autoCommit });
  });

  // ── Auto-compact toggle (default ON) ────────────────────────────────────
  var _autoCompact = true;
  var autoCompactWrap = document.getElementById('auto-compact-wrap');
  var autoCompactCb   = document.getElementById('auto-compact-cb');
  // Enable by default on first load
  autoCompactCb.checked = true;
  autoCompactWrap.classList.add('active');
  vscode.postMessage({ type: 'toggleAutoCompact', enabled: true });
  autoCompactCb.addEventListener('change', function () {
    _autoCompact = autoCompactCb.checked;
    autoCompactWrap.classList.toggle('active', _autoCompact);
    vscode.postMessage({ type: 'toggleAutoCompact', enabled: _autoCompact });
  });

  // ── Compact button ───────────────────────────────────────────────────────
  document.getElementById('compact-btn').addEventListener('click', function () {
    vscode.postMessage({ type: 'compactChat' });
  });

  // ── Session resume offer ──────────────────────────────────────────────────
  var resumeOffer      = document.getElementById('resume-offer');
  var resumeOfferText  = document.getElementById('resume-offer-text');
  var resumeResumeBtn  = document.getElementById('resume-offer-resume');
  var resumeDismissBtn = document.getElementById('resume-offer-dismiss');

  resumeDismissBtn.addEventListener('click', function () {
    resumeOffer.classList.remove('visible');
  });
  resumeResumeBtn.addEventListener('click', function () {
    resumeOffer.classList.remove('visible');
    vscode.postMessage({ type: 'resumeSession' });
  });

  // \u2500\u2500 Proactive error offer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  var _proactiveOfferFile = '';  // filename currently shown in the offer
  var proactiveOffer     = document.getElementById('proactive-offer');
  var proactiveText      = document.getElementById('proactive-offer-text');
  var proactiveFixBtn    = document.getElementById('proactive-offer-fix');
  var proactiveDismissBtn = document.getElementById('proactive-offer-dismiss');

  proactiveDismissBtn.addEventListener('click', function () {
    proactiveOffer.classList.remove('visible');
    _proactiveOfferFile = '';
  });

  proactiveFixBtn.addEventListener('click', function () {
    proactiveOffer.classList.remove('visible');
    var fname = _proactiveOfferFile;
    _proactiveOfferFile = '';
    // Send a /fix-style message that injects active diagnostics
    vscode.postMessage({ type: 'sendMessage', text: 'Fix all errors in ' + fname, injectActiveDiagnostics: true });
  });

  // ── Proposals panel ──────────────────────────────────────────────────────
  var proposalsPanel = document.getElementById('proposals-panel');
  var proposalsList  = document.getElementById('proposals-list');

  function _showProposals(proposals) {
    proposalsList.innerHTML = '';
    proposals.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'proposal-item';
      row.dataset.filepath = p.filepath;

      var badge = document.createElement('span');
      badge.className = 'prop-badge ' + (p.isNew ? 'prop-new' : 'prop-edit');
      badge.textContent = p.isNew ? 'NEW' : 'EDIT';

      var fp = document.createElement('span');
      fp.className = 'prop-filepath';
      fp.textContent = p.filepath;
      fp.title = p.filepath;

      var lines = document.createElement('span');
      lines.className = 'prop-lines';
      lines.textContent = p.lines + ' lines';

      var previewBtn = document.createElement('button');
      previewBtn.className = 'prop-btn prop-preview';
      previewBtn.textContent = '⊞ Diff';
      previewBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'previewEditDiff', filepath: p.filepath });
      });

      var acceptBtn = document.createElement('button');
      acceptBtn.className = 'prop-btn prop-accept';
      acceptBtn.textContent = '✓';
      acceptBtn.title = 'Accept this change';
      acceptBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'acceptEdit', filepath: p.filepath });
      });

      var rejectBtn = document.createElement('button');
      rejectBtn.className = 'prop-btn prop-reject';
      rejectBtn.textContent = '✗';
      rejectBtn.title = 'Reject this change';
      rejectBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'rejectEdit', filepath: p.filepath });
      });

      row.appendChild(badge);
      row.appendChild(fp);
      row.appendChild(lines);
      row.appendChild(previewBtn);
      row.appendChild(acceptBtn);
      row.appendChild(rejectBtn);
      proposalsList.appendChild(row);
    });

    var titleText = document.getElementById('proposals-title-text');
    if (titleText) { titleText.textContent = proposals.length + ' file' + (proposals.length === 1 ? '' : 's') + ' proposed'; }
    proposalsPanel.style.display = 'flex';
  }

  function _removeProposalRow(filepath) {
    var row = proposalsList.querySelector('[data-filepath="' + CSS.escape(filepath) + '"]');
    if (row) { row.remove(); }
    var remaining = proposalsList.querySelectorAll('.proposal-item').length;
    if (remaining === 0) {
      proposalsPanel.style.display = 'none';
    } else {
      var titleText = document.getElementById('proposals-title-text');
      if (titleText) { titleText.textContent = remaining + ' file' + (remaining === 1 ? '' : 's') + ' proposed'; }
    }
  }

  document.getElementById('proposals-accept-all').addEventListener('click', function () {
    vscode.postMessage({ type: 'acceptAllEdits' });
  });
  document.getElementById('proposals-reject-all').addEventListener('click', function () {
    vscode.postMessage({ type: 'rejectAllEdits' });
  });
  // ────────────────────────────────────────────────────────────────────────
  document.getElementById('undo-btn').addEventListener('click', function () {
    vscode.postMessage({ type: 'undo' });
  });
  document.getElementById('redo-btn').addEventListener('click', function () {
    vscode.postMessage({ type: 'redo' });
  });
  document.getElementById('settings-btn').addEventListener('click', function () {
    vscode.postMessage({ type: 'openSettings' });
  });
  document.getElementById('close-btn').addEventListener('click', function () {
    vscode.postMessage({ type: 'closePanel' });
  });

  document.getElementById('ctx-file-btn').addEventListener('click', function () {
    vscode.postMessage({ type: 'requestContext', kind: 'file' });
  });
  document.getElementById('ctx-files-btn').addEventListener('click', function () {
    vscode.postMessage({ type: 'requestContext', kind: 'files-pick' });
  });
  document.getElementById('ctx-sel-btn').addEventListener('click', function () {
    vscode.postMessage({ type: 'requestContext', kind: 'selection' });
  });
  document.getElementById('ctx-diag-btn').addEventListener('click', function () {
    vscode.postMessage({ type: 'requestContext', kind: 'diagnostics' });
  });
  document.getElementById('ctx-review-file-btn').addEventListener('click', function () {
    if (streaming) { return; }
    vscode.postMessage({ type: 'startReview', target: 'file' });
  });
  document.getElementById('ctx-review-sel-btn').addEventListener('click', function () {
    if (streaming) { return; }
    vscode.postMessage({ type: 'startReview', target: 'selection' });
  });
  document.getElementById('ctx-test-btn').addEventListener('click', function () {
    if (streaming) { return; }
    vscode.postMessage({ type: 'runAndFixTests' });
  });

  document.getElementById('ctx-plan-btn').addEventListener('click', function () {
    if (streaming) { return; }
    var goal = input.value.trim();
    if (!goal) {
      input.placeholder = 'Describe the task to plan…';
      input.focus();
      return;
    }
    input.value = '';
    input.style.height = 'auto';
    triggerPlan(goal);
  });

  function triggerPlan(goal) {
    hideWelcome();
    appendUserMsg('\uD83D\uDCCB Plan: ' + goal, []);
    setStreaming(true);
    vscode.postMessage({ type: 'startPlan', goal: goal });
  }

  function addCtxAttachment(kind, label, text) {
    if (!text) { return; } // nothing to attach (e.g. no active file)
    if (kind === 'file') {
      // Multiple files allowed — dedup by label so the same path can't appear twice
      ctxAttachments = ctxAttachments.filter(function(a) { return !(a.kind === 'file' && a.label === label); });
    } else {
      // selection / diagnostics: only one at a time, replace by kind
      ctxAttachments = ctxAttachments.filter(function(a) { return a.kind !== kind; });
    }
    ctxAttachments.push({ kind: kind, label: label, text: text });
    renderChips();
  }

  var _selBadgeEl = null;

  function _updateSelectionBadge(label) {
    if (_selBadgeEl && _selBadgeEl.parentNode) {
      _selBadgeEl.parentNode.removeChild(_selBadgeEl);
      _selBadgeEl = null;
    }
    if (!label) { return; }
    var chip = document.createElement('span');
    chip.className = 'chip chip-sel';
    chip.title = 'Selection auto-included in context';
    chip.textContent = '\u2702 ' + label;
    _selBadgeEl = chip;
    ctxChips.appendChild(chip);
  }

  function renderChips() {
    ctxChips.innerHTML = '';
    // Re-attach selection badge first (renderChips clears innerHTML)
    if (_selBadgeEl) { ctxChips.appendChild(_selBadgeEl); }
    ctxAttachments.forEach(function(a, idx) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.title = a.text.slice(0, 200);
      var lines = a.text.split('\n').length;
      var cut = /\n\u2026 \(truncated\)$/.test(a.text);
      if (cut) { chip.classList.add('chip-warn'); chip.title = 'Only the first 20,000 characters are attached.\n\n' + chip.title; }
      chip.innerHTML = esc(a.label) + '<span class="chip-size">' + lines + (lines === 1 ? ' line' : ' lines') + (cut ? ', cut' : '') + '</span>' +
        '<button class="chip-x" data-idx="' + idx + '" title="Remove">\u00D7</button>';
      chip.querySelector('.chip-x').addEventListener('click', function(e) {
        e.stopPropagation();
        ctxAttachments.splice(idx, 1);
        renderChips();
      });
      ctxChips.appendChild(chip);
    });
  }

  function send() {
    var text = input.value.trim();
    var rawInput = text;
    if (!text) { return; }

    if (streaming) {
      // Queue the follow-up. The current response continues uninterrupted.
      // When streaming ends the agent receives the full completed response +
      // this follow-up in context and adapts its next reply accordingly.
      // The message bubble is rendered by send() after the stream ends so it
      // appears in the correct position (after the completed assistant turn).
      _queuedMsg = { rawInput: rawInput, attachments: ctxAttachments.slice() };
      ctxAttachments = [];
      renderChips();
      _showQueuedBanner(rawInput);
      input.value = '';
      input.style.height = 'auto';
      return;
    }

    // Prepend @agent mention if a badge is active (and not already in text)
    if (_activeAgent && !text.includes('@' + _activeAgent)) {
      text = '@' + _activeAgent + ' ' + text;
    }

    // Slash command: /compact
    if (/^\/compact$/i.test(text)) {
      input.value = '';
      input.style.height = 'auto';
      slashHintEl.style.display = 'none';
      _setHintMode(null);
      vscode.postMessage({ type: 'compactChat' });
      return;
    }

    // Slash command: /review [file|selection]
    var reviewMatch = text.match(/^\/review(?:\s+(file|selection))?$/i);
    if (reviewMatch) {
      var target = (reviewMatch[1] || 'file').toLowerCase();
      input.value = '';
      input.style.height = 'auto';
      vscode.postMessage({ type: 'startReview', target: target });
      return;
    }

    // Slash command: /plan <goal>
    var planMatch = text.match(/^\/plan\s+(.+)$/is);
    if (planMatch) {
      var planGoal = planMatch[1].trim();
      input.value = '';
      input.style.height = 'auto';
      triggerPlan(planGoal);
      return;
    }

    // Plan mode: redirect every send to triggerPlan
    if (_mode === 'plan') {
      input.value = '';
      input.style.height = 'auto';
      slashHintEl.style.display = 'none';
      triggerPlan(rawInput);
      return;
    }

    // Slash commands: /fix /explain /doc /tests /pr /coverage /new
    var slashCmd = text.match(/^\/(fix|explain|doc|tests|pr|coverage|new)(?:\s+(.*))?$/is);
    var injectActiveDiags = false;
    if (slashCmd) {
      var cmd = slashCmd[1].toLowerCase();
      var slashExtra = (slashCmd[2] || '').trim();
      var SLASH_PROMPTS = {
        fix:     'Fix all bugs, errors, and issues in the code below. Clearly explain each fix you make.',
        explain: 'Explain the following code clearly and step by step. Describe what it does, how it works, and any important patterns.',
        doc:     'Add comprehensive JSDoc/TSDoc documentation comments to all functions, methods, and classes in the code below. Return the fully documented code.',
        tests:   'Write thorough unit tests for the following code using the most appropriate test framework for the language. Cover edge cases. Return only the test code.',
        pr:      'You have been provided with the GitHub PR context below. Please review this PR: summarise the changes, identify potential issues, suggest improvements, and note anything that looks risky or incomplete.',
        new:     'You are a senior software engineer. Create the requested file or project scaffold in the workspace using the write_file tool for every file. Do NOT output code blocks in chat — instead call write_file for each file so it is actually created on disk. After all files are written, briefly explain the structure and any next steps needed to wire things together.'
      };
      var slashPrompt = SLASH_PROMPTS[cmd];
      if (cmd === 'fix') { injectActiveDiags = true; }
      if (cmd === 'pr') {
        // Send a message that tells the extension to inject PR context server-side
        vscode.postMessage({ type: 'sendMessage', text: '/pr ' + slashExtra, contentParts: undefined });
        hideWelcome();
        appendUserMsg('/pr ' + slashExtra, [], []);
        input.value = '';
        input.style.height = 'auto';
        slashHintEl.style.display = 'none';
        _setHintMode(null);
        setStreaming(true);
        return;
      }
      if (cmd === 'coverage') {
        vscode.postMessage({ type: 'generateTestsFromCoverage' });
        input.value = '';
        input.style.height = 'auto';
        slashHintEl.style.display = 'none';
        _setHintMode(null);
        return;
      }
      if (cmd === 'test') {
        // Let the extension detect the test command and confirm with the user
        vscode.postMessage({ type: 'runAndFixTests' });
        input.value = '';
        input.style.height = 'auto';
        slashHintEl.style.display = 'none';
        _setHintMode(null);
        return;
      }
      if (cmd === 'new') {
        if (!slashExtra) {
          // Prompt the user to provide a description
          input.value = '/new ';
          input.style.height = 'auto';
          input.focus();
          return;
        }
        text = SLASH_PROMPTS['new'] + '\n\nDescription: ' + slashExtra;
      }
      // Use any extra text or attached context as the code; if neither, fall back to active file via preamble
      var slashCode = slashExtra || (ctxAttachments.length > 0 ? ctxAttachments.map(function(a){ return a.text; }).join('\n\n') : '');
      text = slashPrompt + (slashCode ? '\n\n```\n' + slashCode + '\n```' : ' (use the active file as context)');
      if (slashCode && ctxAttachments.length > 0) { ctxAttachments = []; renderChips(); }
    }

    var fullText = text;
    var ctxLabels = [];
    if (ctxAttachments.length > 0) {
      var ctxParts = ctxAttachments.map(function(a) { return a.text; }).join('\n\n');
      fullText = ctxParts + '\n\n' + text;
      ctxLabels = ctxAttachments.map(function(a) { return a.label; });
      ctxAttachments = [];
      renderChips();
    }

    hideWelcome();
    // Skip rendering the user bubble if it was already shown at queue time
    if (_skipNextAppendUserMsg) {
      _skipNextAppendUserMsg = false;
    } else {
      appendUserMsg(rawInput, ctxLabels, _pastedImages.slice());
    }
    input.value = '';
    input.style.height = 'auto';
    slashHintEl.style.display = 'none';
    _setHintMode(null);
    // Keep agent badge across messages (same as Copilot keeping @workspace active)
    setStreaming(true);

    // Build message payload — if images pasted, use multimodal content
    if (_pastedImages.length > 0) {
      var contentParts = [{ type: 'text', text: fullText }];
      _pastedImages.forEach(function(img) {
        contentParts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      });
      _pastedImages = [];
      _renderImgPreviews();
      _lastSentPayload = { text: fullText, contentParts: contentParts, injectActiveDiagnostics: injectActiveDiags };
      vscode.postMessage({ type: 'sendMessage', text: fullText, contentParts: contentParts, injectActiveDiagnostics: injectActiveDiags });
    } else {
      _lastSentPayload = { text: fullText, contentParts: undefined, injectActiveDiagnostics: injectActiveDiags };
      vscode.postMessage({ type: 'sendMessage', text: fullText, injectActiveDiagnostics: injectActiveDiags });
    }
  }

  /** Re-send the last message payload without re-rendering the user bubble. */
  function _retrySend() {
    if (!_lastSentPayload) { return; }
    setStreaming(true);
    if (_lastSentPayload.contentParts) {
      vscode.postMessage({ type: 'sendMessage', text: _lastSentPayload.text, contentParts: _lastSentPayload.contentParts, injectActiveDiagnostics: _lastSentPayload.injectActiveDiagnostics });
    } else {
      vscode.postMessage({ type: 'sendMessage', text: _lastSentPayload.text, injectActiveDiagnostics: _lastSentPayload.injectActiveDiagnostics });
    }
  }

  function clearChat() {
    msgs.innerHTML = '';
    msgs.appendChild(welcome);
    welcome.style.display = 'flex';
    curId = null;
    msgContents = {};
    ctxAttachments = [];
    _lastSentPayload = null;
    renderChips();
    if (sTokens) { sTokens.textContent = ''; }
    setStreaming(false);
    vscode.postMessage({ type: 'clearChat' });
  }

  function hideWelcome() { welcome.style.display = 'none'; }

  // Suggestions on an empty panel; the problems count comes from diagnosticsChanged
  var _workspaceErrors = 0;
  function _renderStarters() {
    var box = document.getElementById('wlc-starters');
    if (!box) { return; }
    var starters = [
      'Explain how this project is organised',
      _workspaceErrors > 0 ? 'Fix the ' + _workspaceErrors + ' error' + (_workspaceErrors === 1 ? '' : 's') + ' in the Problems panel' : 'Find bugs in the open file',
      'Write tests for the open file',
      'Suggest improvements to the open file',
    ];
    box.innerHTML = '';
    starters.forEach(function (text) {
      var b = document.createElement('button');
      b.className = 'wlc-starter';
      b.textContent = text;
      b.addEventListener('click', function () { input.value = text; send(); });
      box.appendChild(b);
    });
  }
  _renderStarters();

  function setStreaming(on) {
    streaming = on;
    // Message actions (edit, delete, regenerate, code toggles) are hidden while a reply streams
    document.body.classList.toggle('is-streaming', !!on);
    if (_progress) { if (on) { _progress.start(); } else { _progress.stop(); } }
    if (on) {
      sendBtn.textContent = 'Queue \u2192';
      sendBtn.title = 'Queue a follow-up (sent after current response)';
      sendBtn.className = 'queue-mode';
      stopBtn.style.display = 'inline-flex';
    } else {
      sendBtn.textContent = 'Send';
      sendBtn.title = 'Send message';
      sendBtn.className = '';
      stopBtn.style.display = 'none';
    }
    sDot.className = 's-dot' + (on ? ' thinking' : '');
    sText.textContent = on ? 'Thinking\u2026' : 'Ready';
    if (!on) {
      sStep.textContent = '';
      document.querySelectorAll('.checkpoint-notice').forEach(function(el) { el.remove(); });
    }

    if (!on && _queuedMsg) {
      var queued = _queuedMsg;
      _queuedMsg = null;
      _hideQueuedBanner();
      ctxAttachments = queued.attachments || [];
      renderChips();
      input.value = queued.rawInput;
      setTimeout(function() { send(); }, 80);
    }
  }

  function _showQueuedBanner(text) {
    _hideQueuedBanner();
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 10px 5px 12px;' +
      'background:rgba(109,40,217,.12);border:1px solid rgba(109,40,217,.35);' +
      'border-radius:6px;font-size:11.5px;color:var(--vscode-descriptionForeground);margin-bottom:4px;';
    var lbl = document.createElement('span');
    lbl.textContent = '\u26a1 Queued:';
    lbl.style.cssText = 'font-weight:600;color:var(--vscode-foreground);white-space:nowrap;flex-shrink:0';
    var txt = document.createElement('span');
    txt.textContent = text.length > 80 ? text.slice(0, 80) + '\u2026' : text;
    txt.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8';
    var btn = document.createElement('button');
    btn.textContent = '\u00d7';
    btn.title = 'Cancel queued message';
    btn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:14px;line-height:1;padding:0 2px;flex-shrink:0;opacity:.6';
    btn.addEventListener('click', function() { _queuedMsg = null; _hideQueuedBanner(); });
    bar.appendChild(lbl); bar.appendChild(txt); bar.appendChild(btn);
    var row = document.getElementById('input-area-row');
    if (row) { row.parentNode.insertBefore(bar, row); }
    _queuedBarEl = bar;
  }

  function _hideQueuedBanner() {
    if (_queuedBarEl) { _queuedBarEl.parentNode && _queuedBarEl.parentNode.removeChild(_queuedBarEl); _queuedBarEl = null; }
  }

  // Esc stops the reply, unless something else (a menu, an edit box) used it first
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && streaming && !e.defaultPrevented) { e.preventDefault(); stopBtn.click(); }
  });

  stopBtn.addEventListener('click', function() {
    _queuedMsg = null;
    _hideQueuedBanner();
    vscode.postMessage({ type: 'abortStream' });
  });

  // ── Message actions: edit & resend, delete, regenerate ─────────────────────
  // A user message carries its turn id (data-turn); "none" means it cannot be changed.
  // ── Grouped tool steps: when a reply ends, runs of 3+ steps collapse into one line ───
  var STEP_WORDS = {
    read_file: ['read', 'file', 'files'], list_directory: ['listed', 'folder', 'folders'],
    search_files: ['searched'], find_files: ['looked for', 'file', 'files'], get_diagnostics: ['checked problems'],
    run_terminal: ['ran', 'command', 'commands'], edit_file: ['edited', 'file', 'files'], write_file: ['wrote', 'file', 'files'],
    fetch_url: ['fetched', 'page', 'pages'], lsp_symbol: ['looked up', 'symbol', 'symbols'], mcp_call: ['called', 'MCP tool', 'MCP tools'],
    update_todo: ['updated the task list']
  };
  var _stepRunSeq = 0;
  function _stepSummary(pills) {
    var counts = {}, order = [];
    pills.forEach(function (p) {
      var t = p.dataset.pillTool || 'other';
      if (!counts[t]) { counts[t] = 0; order.push(t); }
      counts[t]++;
    });
    return order.map(function (t) {
      var w = STEP_WORDS[t], n = counts[t];
      if (!w) { return n + ' other step' + (n === 1 ? '' : 's'); }
      if (w.length === 1) { return n > 1 ? w[0] + ' ' + n + '\u00D7' : w[0]; }
      return w[0] + ' ' + n + ' ' + (n === 1 ? w[1] : w[2]);
    }).join(', ');
  }
  function _collapseStepRuns(wrap) {
    if (wrap.dataset.stepsGrouped) { return; }
    wrap.dataset.stepsGrouped = '1';
    var run = [];
    var flush = function () {
      if (run.length >= 3) {
        var id = 'run' + (++_stepRunSeq);
        var summary = document.createElement('button');
        summary.className = 'step-summary';
        summary.dataset.run = id;
        summary.innerHTML = '<span class="step-summary-arrow">\u25B8</span> ' + run.length + ' steps \u00B7 ' + esc(_stepSummary(run));
        run[0].parentNode.insertBefore(summary, run[0]);
        // Failed steps stay visible: they are what the reader needs to see
        run.forEach(function (p) { p.dataset.run = id; if (!p.querySelector('.step-pill-verb.fail')) { p.classList.add('step-hidden'); } });
      }
      run = [];
    };
    Array.prototype.forEach.call(wrap.children, function (el) {
      if (el.classList.contains('step-pill')) { run.push(el); }
      else if (el.classList.contains('agent-out') && !el.textContent.trim()) { /* empty text between steps */ }
      else { flush(); }
    });
    flush();
  }

  // ── Long replies: an outline of their headings, and a link to the summary ─────────
  function _addReplyOutline(wrap) {
    if (wrap.querySelector('.reply-outline')) { return; }
    var text = wrap.textContent || '';
    if (text.length < 2500) { return; }
    var heads = Array.prototype.slice.call(wrap.querySelectorAll('.agent-out h1, .agent-out h2, .agent-out h3'));
    var summary = Array.prototype.slice.call(wrap.querySelectorAll('.agent-out h1, .agent-out h2, .agent-out h3, .agent-out p > strong:first-child'))
      .filter(function (el) { return /^\s*(summary|conclusion)\b/i.test(el.textContent); }).pop();
    if (heads.length < 3 && !summary) { return; }
    var nav = document.createElement('div');
    nav.className = 'reply-outline';
    var targets = heads.length >= 3 ? heads.slice(0, 8) : [];
    if (summary && targets.indexOf(summary) < 0) { targets.push(summary); }
    targets.forEach(function (el) {
      var link = document.createElement('button');
      link.className = 'reply-outline-link';
      link.textContent = el === summary ? '\u2193 Summary' : el.textContent.trim().slice(0, 40);
      link.addEventListener('click', function () { el.scrollIntoView({ block: 'start' }); });
      nav.appendChild(link);
    });
    var label = wrap.querySelector('.msg-label');
    wrap.insertBefore(nav, label ? label.nextSibling : wrap.firstChild);
  }

  // ── Progress header while a task runs: activity, elapsed time, tokens and cost, plan ──
  var _progress = (function () {
    var el = null, timer = null, showTimer = null, started = 0, parts = { activity: 'Thinking\u2026', usage: '', plan: '' };
    function ensure() {
      if (el) { return el; }
      el = document.createElement('div');
      el.id = 'task-progress';
      el.innerHTML = '<span class="tp-spinner"></span><span class="tp-activity"></span><span class="tp-meta"></span>';
      msgs.parentNode.insertBefore(el, msgs);
      return el;
    }
    function render() {
      if (!el) { return; }
      var secs = Math.floor((Date.now() - started) / 1000);
      var time = Math.floor(secs / 60) + ':' + ('0' + secs % 60).slice(-2);
      el.querySelector('.tp-activity').textContent = parts.activity;
      el.querySelector('.tp-meta').textContent = [parts.plan, time, parts.usage].filter(Boolean).join(' \u00B7 ');
    }
    return {
      start: function () {
        if (timer || showTimer) { return; }
        started = Date.now();
        parts = { activity: 'Thinking\u2026', usage: '', plan: '' };
        // Only tasks that take a while get the header (quick replies would flicker)
        showTimer = setTimeout(function () { showTimer = null; ensure().style.display = 'flex'; render(); timer = setInterval(render, 1000); }, 1500);
      },
      stop: function () {
        clearTimeout(showTimer); showTimer = null;
        clearInterval(timer); timer = null;
        if (el) { el.style.display = 'none'; }
      },
      set: function (key, value) { parts[key] = value; render(); }
    };
  })();

  /** A tool step's label; for file tools it opens the file ("src/a.ts lines 1–300 of 484" → src/a.ts). */
  function _pillLabelHtml(tool, label) {
    var FILE_TOOLS = { read_file: 1, edit_file: 1, write_file: 1 };
    if (!FILE_TOOLS[tool] || !label) { return '<span class="step-pill-label">' + esc(label) + '</span>'; }
    var path = String(label).split(' lines ')[0];
    return '<span class="step-pill-label file-link" data-path="' + esc(path) + '" title="Open ' + esc(path) + '">' + esc(label) + '</span>';
  }

  function _tagUserMsg(el, turnId, editable) {
    el.dataset.turn = turnId || 'none';
    el.dataset.editable = turnId && editable ? '1' : '0';
  }

  function _oldestUntaggedUserMsg() {
    return msgs.querySelector('.msg.user:not([data-turn])');
  }

  /** Regenerate is offered on the reply to the newest message that can be changed. */
  function _placeRegenerate() {
    document.querySelectorAll('.regen-btn').forEach(function (b) { b.remove(); });
    var users = msgs.querySelectorAll('.msg.user');
    var last = users[users.length - 1];
    if (!last || !last.dataset.turn || last.dataset.turn === 'none') { return; }
    var reply = last.nextElementSibling;
    while (reply && !reply.classList.contains('assistant')) { reply = reply.nextElementSibling; }
    if (!reply) { return; }
    var btn = document.createElement('button');
    btn.className = 'regen-btn';
    btn.title = 'Run this message again and replace the reply';
    btn.textContent = '↻ Regenerate';
    reply.appendChild(btn);
  }

  function _startEditUserMsg(el) {
    if (el.querySelector('.msg-editor')) { return; }
    var bubble = el.querySelector('.user-bubble');
    var editor = document.createElement('div');
    editor.className = 'msg-editor';
    var area = document.createElement('textarea');
    area.value = el.dataset.editText || '';
    area.rows = Math.min(12, Math.max(3, area.value.split('\n').length));
    var hint = document.createElement('div');
    hint.className = 'msg-editor-hint';
    hint.textContent = 'Sending replaces this message and everything after it.';
    var send = document.createElement('button');
    send.className = 'msg-editor-send';
    send.textContent = 'Send';
    var cancel = document.createElement('button');
    cancel.className = 'msg-editor-cancel';
    cancel.textContent = 'Cancel';
    var close = function () { editor.remove(); if (bubble) { bubble.style.display = ''; } };
    send.addEventListener('click', function () {
      var text = area.value.trim();
      if (!text || streaming) { return; }
      vscode.postMessage({ type: 'editMessage', turnId: el.dataset.turn, text: text });
    });
    cancel.addEventListener('click', close);
    area.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send.click(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    editor.appendChild(area);
    editor.appendChild(hint);
    editor.appendChild(send);
    editor.appendChild(cancel);
    if (bubble) { bubble.style.display = 'none'; bubble.parentNode.insertBefore(editor, bubble.nextSibling); } else { el.appendChild(editor); }
    area.focus();
  }

  function _confirmDeleteUserMsg(el) {
    if (el.querySelector('.msg-confirm')) { return; }
    var row = document.createElement('div');
    row.className = 'msg-confirm';
    var text = document.createElement('span');
    text.textContent = 'Delete this message and everything after it?';
    var del = document.createElement('button');
    del.className = 'msg-confirm-delete';
    del.textContent = 'Delete';
    var cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    del.addEventListener('click', function () {
      if (!streaming) { vscode.postMessage({ type: 'deleteMessage', turnId: el.dataset.turn }); }
    });
    cancel.addEventListener('click', function () { row.remove(); });
    row.appendChild(text);
    row.appendChild(del);
    row.appendChild(cancel);
    el.appendChild(row);
  }

  // One listener for every message: actions, regenerate, and code block toggles
  msgs.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.msg-edit, .msg-del, .regen-btn, .code-toggle, .file-link, .step-summary') : null;
    if (!btn) { return; }
    if (btn.classList.contains('step-summary')) {
      var open = btn.classList.toggle('open');
      btn.querySelector('.step-summary-arrow').textContent = open ? '\u25BE' : '\u25B8';
      btn.parentNode.querySelectorAll('.step-pill[data-run="' + btn.dataset.run + '"]').forEach(function (p) {
        if (!p.querySelector('.step-pill-verb.fail')) { p.classList.toggle('step-hidden', !open); }
      });
      return;
    }
    if (btn.classList.contains('file-link')) {
      var line = Number(btn.dataset.line);
      vscode.postMessage(line > 0 ? { type: 'openFile', path: btn.dataset.path, line: line } : { type: 'openFile', path: btn.dataset.path });
      return;
    }
    if (btn.classList.contains('code-toggle')) {
      var wrap = btn.closest('.code-wrap');
      var collapsed = wrap.classList.toggle('collapsed');
      btn.textContent = collapsed ? 'Expand' : 'Collapse';
      btn.title = collapsed ? 'Show the whole block' : 'Collapse the block';
      return;
    }
    if (streaming) { return; }
    if (btn.classList.contains('regen-btn')) { vscode.postMessage({ type: 'regenerate' }); return; }
    var el = btn.closest('.msg.user');
    if (!el || !el.dataset.turn || el.dataset.turn === 'none') { return; }
    if (btn.classList.contains('msg-edit')) { _startEditUserMsg(el); } else { _confirmDeleteUserMsg(el); }
  });

  // ── Message times ("2m ago"), refreshed every minute ─────────────────────────
  function _relTime(ts) {
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 45) { return 'just now'; }
    if (s < 3600) { return Math.max(1, Math.round(s / 60)) + 'm ago'; }
    if (s < 86400) { return Math.floor(s / 3600) + 'h ago'; }
    if (s < 7 * 86400) { return Math.floor(s / 86400) + 'd ago'; }
    return new Date(ts).toLocaleDateString();
  }
  function _timeHtml(ts) {
    return '<span class="msg-time" data-ts="' + Number(ts) + '" title="' + esc(new Date(ts).toLocaleString()) + '">' + _relTime(ts) + '</span>';
  }
  function _refreshTime(el) {
    var ts = Number(el.dataset.ts);
    if (!ts) { return; }
    el.textContent = _relTime(ts);
    el.title = new Date(ts).toLocaleString();
  }
  setInterval(function () { document.querySelectorAll('.msg-time').forEach(_refreshTime); }, 60000);

  // ── Drag and drop files onto the chat ────────────────────────────────────────
  // From the OS the files themselves arrive; from VS Code's Explorer (hold Shift) only their
  // URIs, which the extension reads. Images become image attachments, other files file context.
  var IMAGE_NAME_RE = /\.(png|jpe?g|gif|webp)$/i;
  var _dropDepth = 0;
  var _dropOverlay = null;
  function _isFileDrag(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.some.call(types, function (t) {
      return t === 'Files' || t === 'text/uri-list' || t === 'application/vnd.code.uri-list';
    });
  }
  function _showDropOverlay(on) {
    if (on && !_dropOverlay) {
      _dropOverlay = document.createElement('div');
      _dropOverlay.className = 'drop-overlay';
      _dropOverlay.textContent = 'Drop files to attach them (hold Shift when dragging from the Explorer)';
      document.body.appendChild(_dropOverlay);
    }
    if (_dropOverlay) { _dropOverlay.style.display = on ? 'flex' : 'none'; }
  }
  document.addEventListener('dragenter', function (e) {
    if (!_isFileDrag(e)) { return; }
    e.preventDefault();
    _dropDepth++;
    _showDropOverlay(true);
  });
  document.addEventListener('dragover', function (e) {
    if (!_isFileDrag(e)) { return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', function () {
    _dropDepth = Math.max(0, _dropDepth - 1);
    if (_dropDepth === 0) { _showDropOverlay(false); }
  });
  document.addEventListener('drop', function (e) {
    if (!_isFileDrag(e)) { return; }
    e.preventDefault();
    _dropDepth = 0;
    _showDropOverlay(false);
    var dt = e.dataTransfer;
    var uris = (dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list') || '')
      .split(/\r?\n/).map(function (u) { return u.trim(); }).filter(function (u) { return u && u.charAt(0) !== '#'; });
    var files = Array.prototype.slice.call(dt.files || []);
    // Only paths (a drag from the Explorer): the extension reads them, applying .codicoignore
    if (files.length === 0) {
      if (uris.length > 0) { vscode.postMessage({ type: 'attachDroppedFiles', uris: uris }); }
      return;
    }
    files.forEach(function (f) {
      if (/^image\//.test(f.type) || IMAGE_NAME_RE.test(f.name)) { _readImageFile(f); return; }
      if (f.size > 1024 * 1024) { showError('Cannot attach ' + f.name + ': larger than 1 MB.'); return; }
      f.text().then(function (text) {
        if (text.indexOf('\u0000') >= 0) { showError('Cannot attach ' + f.name + ': it is not a text file.'); return; }
        addCtxAttachment('file', f.name, 'File: ' + f.name + '\n```\n' + text.slice(0, 20000) + '\n```' + (text.length > 20000 ? '\n\u2026 (truncated)' : ''));
      });
    });
  });

  /**
   * @param meta for a saved message: { id, at, editable, editText }. A live message gets its turn
   * id when its reply starts (startMessage); until then it has no actions.
   */
  function appendUserMsg(text, ctxLabels, images, meta) {
    var d = document.createElement('div');
    d.className = 'msg user';
    d.dataset.editText = (meta && meta.editText) || text;
    if (meta) { _tagUserMsg(d, meta.id, meta.editable); }
    var ctxHtml = '';
    if (ctxLabels && ctxLabels.length > 0) {
      ctxHtml = '<div class="user-ctx">' +
        ctxLabels.map(function(l) { return '<span class="chip">' + esc(l) + '</span>'; }).join('') +
        '</div>';
    }
    var imgHtml = '';
    if (images && images.length > 0) {
      imgHtml = '<div class="user-images">' +
        images.map(function(img) {
          return '<img src="' + img.dataUrl + '" style="max-height:120px;border-radius:4px;margin-top:4px;" />';
        }).join('') +
        '</div>';
    }
    // Extract @agent mention from text to show as a badge, not raw text
    var displayText = text;
    var agentBadgeHtml = '';
    var agentMatch = text.match(/(?:^|\s)@(workspace|terminal|vscode)\b/i);
    if (agentMatch) {
      agentBadgeHtml = '<span class="mention-badge" style="font-size:10px;padding:1px 6px;cursor:default;">' + esc('@' + agentMatch[1].toLowerCase()) + '</span> ';
      displayText = text.replace(agentMatch[0], '').replace(/^\s+/, '').trim() || text;
    }

    d.innerHTML =
      '<div class="msg-label">You' + _timeHtml(meta && meta.at || Date.now()) +
        '<span class="msg-actions">' +
          '<button class="msg-act msg-edit" title="Edit and resend">\u270E</button>' +
          '<button class="msg-act msg-del" title="Delete this message and everything after it">\uD83D\uDDD1</button>' +
        '</span></div>' +
      ctxHtml +
      '<div class="user-bubble">' + agentBadgeHtml + esc(displayText) + '</div>' +
      imgHtml;
    msgs.appendChild(d);
    scrollBottom(true);
  }

  function addCompactNotice(messageCount) {
    var d = document.createElement('div');
    d.className = 'compact-notice';
    d.innerHTML =
      '<span style="font-size:14px;flex-shrink:0">&#8597;</span>' +
      '<span><strong>Context compacted</strong> &mdash; history summarised' +
      (messageCount > 0 ? ', ' + messageCount + ' recent message' + (messageCount !== 1 ? 's' : '') + ' kept' : '') +
      '</span>';
    msgs.appendChild(d);
    scrollBottom();
  }

  function startMsg(id) {
    curId = id;
    curThinkRaw = '';
    curContentRaw = '';
    curSegRaw = '';
    curAoEl = null; // set after out element is created
    curThinkWrap = null;
    curThinkBody = null;
    curThinkIdx  = 0;

    var wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    wrap.id = 'msg-' + id;

    var label = document.createElement('div');
    label.className = 'msg-label';
    label.innerHTML = 'Codico' + _timeHtml(Date.now());

    // Think-wraps are created dynamically by appendThinking() at the current DOM
    // position so they appear inline in execution order rather than all at the top.

    var out = document.createElement('div');
    out.className = 'agent-out stream-cursor';
    out.id = 'ao-' + id;

    var copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.id = 'copy-' + id;
    copyBtn.title = 'Copy response';
    copyBtn.textContent = '\uD83D\uDCCB Copy';
    copyBtn.style.display = 'none'; // shown in endMsg

    wrap.appendChild(label);
    // If this is a plan execution message, prepend the todo tracker
    if (_isExecutingPlan && _planTasks.length > 0) {
      _isExecutingPlan = false;
      var planItems = _planTasks.map(function(t) { return { status: 'pending', n: t.n, title: t.text, detail: t.detail }; });
      var tracker = _buildOrUpdateTodoTracker('todo-tracker-plan-' + id, null, wrap, planItems, true);
      // Keep id-based lookups working for [TASK_START/DONE/FAIL:N] markers
      _planTasks.forEach(function(task) {
        var row = tracker.querySelectorAll('.todo-item')[task.n - 1];
        if (row) { row.id = 'todo-task-' + task.n; }
      });
      _todoTrackerEl = tracker;
    } else {
      _isExecutingPlan = false;
    }
    wrap.appendChild(out);
    wrap.appendChild(copyBtn);
    msgs.appendChild(wrap);
    curAoEl = out;
    scrollBottom();
  }

  function toggleThink(blockKey) {
    var tb = document.getElementById('tb-' + blockKey);
    var tc = document.getElementById('tc-' + blockKey);
    if (!tb || !tc) { return; }
    var open = tb.classList.toggle('open');
    tc.className = 'think-chevron' + (open ? ' open' : '');
    tc.innerHTML = open ? '\u25BC' : '\u25B6';
  }

  function appendThinking(id, text) {
    if (id !== curId) { return; }
    curThinkRaw += text;

    if (!curThinkWrap) {
      // Create a new collapsible think block at the current DOM position so it
      // appears inline between tools and content rather than all at the top.
      var wrap = document.getElementById('msg-' + id);
      var copyBtn = document.getElementById('copy-' + id);
      var blockKey = id + '-' + curThinkIdx;
      curThinkIdx++;

      var thinkWrap = document.createElement('div');
      thinkWrap.className = 'think-wrap';
      thinkWrap.id = 'tw-' + blockKey;

      var thinkBtn = document.createElement('button');
      thinkBtn.className = 'think-btn';
      thinkBtn.dataset.blockKey = blockKey;
      thinkBtn.addEventListener('click', function () { toggleThink(this.dataset.blockKey); });
      thinkBtn.innerHTML =
        '<span class="think-pulse" id="tp-' + blockKey + '"></span>' +
        '<span class="think-chevron" id="tc-' + blockKey + '">\u25b6</span>' +
        '<span class="think-label" id="tl-' + blockKey + '">Thinking\u2026</span>';

      var thinkBody = document.createElement('div');
      thinkBody.className = 'think-body';
      thinkBody.id = 'tb-' + blockKey;

      thinkWrap.appendChild(thinkBtn);
      thinkWrap.appendChild(thinkBody);

      // Insert before the current text segment (curAoEl) so think block sits
      // just above the content that follows it, not above earlier content/tools.
      var anchor = curAoEl || copyBtn;
      if (anchor && wrap) { wrap.insertBefore(thinkWrap, anchor); }
      else if (wrap) { wrap.appendChild(thinkWrap); }

      curThinkWrap = thinkWrap;
      curThinkBody = thinkBody;
      curThinkRaw  = text; // reset \u2014 this block only shows its own iteration's thinking
    }

    if (curThinkBody) { curThinkBody.textContent = curThinkRaw; curThinkBody.scrollTop = curThinkBody.scrollHeight; }
    sText.textContent = 'Thinking\u2026';
    sDot.className = 's-dot thinking';
  }

  var _mdRafPending = false;

  // ── Todo tracker builder ──────────────────────────────────────────────────
  function _buildOrUpdateTodoTracker(trackerId, anchorEl, parentEl, items, startOpen) {
    var tracker = document.getElementById(trackerId);
    var isNew = !tracker;
    if (isNew) {
      tracker = document.createElement('div');
      tracker.id = trackerId;
      tracker.className = 'todo-tracker' + (startOpen !== false ? ' open' : '');
      if (anchorEl) { parentEl.insertBefore(tracker, anchorEl); }
      else { parentEl.appendChild(tracker); }
    }

    var done  = items.filter(function(i){ return i.status === 'done'; }).length;
    var active = items.filter(function(i){ return i.status === 'active'; }).length;
    var total = items.length;
    var pct   = total > 0 ? Math.round((done / total) * 100) : 0;

    // Header
    var hdr = tracker.querySelector('.todo-tracker-header');
    if (!hdr) {
      hdr = document.createElement('div');
      hdr.className = 'todo-tracker-header';
      hdr.addEventListener('click', function() {
        tracker.classList.toggle('open');
      });
      tracker.appendChild(hdr);
    }
    hdr.innerHTML =
      '<span class="todo-tracker-chevron">\u25B6</span>' +
      '<span class="todo-tracker-label">Tasks</span>' +
      '<span class="tt-current"></span>' +
      '<span class="tt-count">' + done + ' of ' + total + ' done</span>' +
      '<span class="tt-progress" title="' + pct + '% done">' +
        '<span class="tt-progress-fill" style="width:' + pct + '%"></span>' +
      '</span>';

    // Body
    var body = tracker.querySelector('.todo-tracker-body');
    if (!body) {
      body = document.createElement('div');
      body.className = 'todo-tracker-body';
      tracker.appendChild(body);
    }
    body.innerHTML = '';
    var md = window.CodicoMarkdown;
    var fmt = function (t) { return md && md.renderInline ? md.renderInline(t) : esc(t); };
    items.forEach(function(item, idx) {
      // Plan steps come as { n, title, detail }; update_todo items as { text }
      var title = item.title || item.text || '';
      var row = document.createElement('div');
      row.className = 'todo-item ' + item.status;
      row.innerHTML =
        '<span class="todo-badge"><span class="todo-num">' + (item.n || idx + 1) + '</span></span>' +
        '<div class="todo-body"><div class="todo-title">' + fmt(title) + '</div>' +
        (item.detail ? '<div class="todo-detail">' + fmt(item.detail) + '</div>' : '') + '</div>';
      body.appendChild(row);
    });
    _showCurrentTask(tracker);

    // Auto-open if there's an active item; auto-collapse when all done and none active
    if (active > 0) { tracker.classList.add('open'); }
    else if (done === total && total > 0) { tracker.classList.remove('open'); }

    return tracker;
  }

  function appendContent(id, text) {
    if (id !== curId) { return; }
    // Strip task markers and update tracker
    var filtered = text.replace(/\[TASK_(START|DONE|FAIL):(\d+)\]/g, function (_, status, n) {
      var num = parseInt(n, 10);
      if (status === 'START') { _setTodoStatus(num, 'active'); }
      else if (status === 'DONE') { _setTodoStatus(num, 'done'); }
      else if (status === 'FAIL') { _setTodoStatus(num, 'failed'); }
      return '';
    });
    curContentRaw += filtered;  // full accumulation (for copy button)
    curSegRaw += filtered;      // current segment only
    sText.textContent = 'Writing response\u2026';
    sDot.className = 's-dot writing';

    // Live markdown render — throttled to one repaint per animation frame
    if (!_mdRafPending) {
      _mdRafPending = true;
      requestAnimationFrame(function () {
        // Skip if the segment was finalized meanwhile (tool start / message end)
        if (!_mdRafPending) { return; }
        _mdRafPending = false;
        if (!curAoEl) { return; }
        curAoEl.innerHTML = renderMd(curSegRaw.replace(CLARIFY_RE, '')) + '<span class="stream-cursor-inline"></span>';
        scrollBottom();
      });
    }
  }

  /** While the list is collapsed, its header names the task in progress. */
  function _showCurrentTask(tracker) {
    var cur = tracker.querySelector('.todo-item.active .todo-title');
    var el = tracker.querySelector('.tt-current');
    if (el) { el.textContent = cur ? cur.textContent : ''; el.title = el.textContent; }
  }

  function _setTodoStatus(n, status) {
    if (!_todoTrackerEl) { return; }
    var item = _todoTrackerEl.querySelector('#todo-task-' + n);
    if (!item) { return; }
    item.className = 'todo-item ' + status;
    // Keep active items visible
    if (status === 'active') { _todoTrackerEl.classList.add('open'); }
    // Refresh header progress
    var allItems = _todoTrackerEl.querySelectorAll('.todo-item');
    var doneCount = _todoTrackerEl.querySelectorAll('.todo-item.done').length;
    var total = allItems.length;
    var pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
    var countEl = _todoTrackerEl.querySelector('.tt-count');
    if (countEl) { countEl.textContent = doneCount + ' of ' + total + ' done'; }
    _showCurrentTask(_todoTrackerEl);
    _progress.set('plan', total ? 'step ' + Math.min(doneCount + 1, total) + ' of ' + total : '');
    var fillEl = _todoTrackerEl.querySelector('.tt-progress-fill');
    if (fillEl) { fillEl.style.width = pct + '%'; }
    // Auto-collapse when fully done
    if (doneCount === total && total > 0) { _todoTrackerEl.classList.remove('open'); }
  }

  function endMsg(id) {
    setStreaming(false);
    _placeRegenerate();
    var endedWrap = document.getElementById('msg-' + id);
    if (endedWrap) { _collapseStepRuns(endedWrap); setTimeout(function () { _addReplyOutline(endedWrap); }, 0); }
    // Mark any still-pending tool pills as interrupted (token limit / early stop)
    var wrap = document.getElementById('msg-' + id);
    if (wrap) {
      wrap.querySelectorAll('.step-pill-verb.pending').forEach(function(el) {
        el.classList.remove('pending');
        el.textContent = 'Interrupted';
        el.style.opacity = '0.5';
      });
    }
    // Reset tracker reference after execution completes
    if (_todoTrackerEl) { _todoTrackerEl = null; }
    // Finalize all think blocks in this message (there may be several, one per iteration).
    if (wrap) {
      wrap.querySelectorAll('.think-pulse').forEach(function(tp) {
        tp.style.animation = 'none'; tp.style.opacity = '0.4';
      });
      wrap.querySelectorAll('.think-label').forEach(function(tl) {
        tl.textContent = 'Reasoning trace';
      });
    }
    curThinkWrap = null;
    curThinkBody = null;

    // Finalize the current (last) text segment using curAoEl / curSegRaw
    var ao = curAoEl || document.getElementById('ao-' + id);
    _mdRafPending = false;
    if (ao) {
      ao.classList.remove('stream-cursor');
      var displayContent = curSegRaw.replace(CLARIFY_RE, '').trim();
      ao.innerHTML = renderMd(displayContent);
      // Wire up per-code-block copy buttons (new lang bar style)
      ao.querySelectorAll('.code-lang-bar button[data-code]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var code = btn.dataset.code || '';
          if (navigator.clipboard) {
            navigator.clipboard.writeText(code).then(function () {
              btn.textContent = '\u2713 Copied';
              setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
            });
          }
        });
      });

      // Wrap the trailing Summary block (after last <hr>) in a styled div.
      // Guard: only wrap when the first non-empty node after the <hr> contains
      // the word "Summary" — prevents mis-styling any other <hr> in the response.
      var hrs = ao.querySelectorAll('hr');
      if (hrs.length > 0) {
        var lastHr = hrs[hrs.length - 1];
        var summaryNodes = [];
        var node = lastHr.nextSibling;
        while (node) { summaryNodes.push(node); node = node.nextSibling; }
        var firstText = '';
        for (var si = 0; si < summaryNodes.length; si++) {
          var t = (summaryNodes[si].textContent || '').trim();
          if (t) { firstText = t; break; }
        }
        var isSummary = /summary/i.test(firstText);
        var fullText = summaryNodes.map(function(n) { return n.textContent || ''; }).join('').trim();
        if (isSummary && fullText.length > 30) {
          var summaryDiv = document.createElement('div');
          summaryDiv.className = 'msg-summary';
          summaryNodes.forEach(function (n) { summaryDiv.appendChild(n); });
          lastHr.parentNode.replaceChild(summaryDiv, lastHr);
        }
      }
    }

    // Store final content and show copy button
    var savedContent = curContentRaw;
    msgContents[id] = savedContent;
    var copyBtn = document.getElementById('copy-' + id);
    if (copyBtn) {
      copyBtn.style.display = 'inline-flex';
      copyBtn.addEventListener('click', function () {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(savedContent).then(function () {
            copyBtn.textContent = '\u2713 Copied';
            setTimeout(function () { copyBtn.textContent = '\uD83D\uDCCB Copy'; }, 1500);
          });
        }
      });
    }

    curAoEl = null;
    curSegRaw = '';
    curId = null;

    // Render any <clarify> widgets embedded in the response
    var clarifyWrap = document.getElementById('msg-' + id);
    if (clarifyWrap) {
      var clarifyMatch;
      CLARIFY_RE.lastIndex = 0;
      while ((clarifyMatch = CLARIFY_RE.exec(savedContent)) !== null) {
        var spec = _parseClarify(clarifyMatch[1]);
        if (spec.question) { _renderClarifyWidget(spec, clarifyWrap); }
      }
    }

    // If this message is a plan (marked by the extension on startMessage), inject the
    // checklist and approval buttons. Keyed by message id so no other reply can take them.
    var planGoal = _planGoals[id];
    delete _planGoals[id];
    if (planGoal) {
      var planContent = savedContent;

      _planTasks = _parsePlanSteps(planContent);
      // The planner prompt asks the model to end with this line, so a reply carrying it
      // is a real plan even if its steps use a format the parser doesn't recognise
      var hasPlanFooter = /approve the plan to begin execution/i.test(planContent);

      var wrap = document.getElementById('msg-' + id);
      if (wrap && _planTasks.length === 0 && !hasPlanFooter) {
        // No steps and no plan footer (failed or empty reply): there is nothing to approve
        var noPlan = document.createElement('div');
        noPlan.className = 'stream-stop-notice warn';
        noPlan.textContent = '\u26A0 No plan steps were produced, so there is nothing to approve. Rephrase the goal or try again.';
        wrap.appendChild(noPlan);
      } else if (wrap) {
        // Render the plan card: numbered steps, short title + clamped details
        if (_planTasks.length > 0) {
          wrap.appendChild(_buildPlanCard(_planTasks));
        }

        // Approval buttons
        var actions = document.createElement('div');
        actions.className = 'plan-actions';

        var approveBtn = document.createElement('button');
        approveBtn.className = 'plan-approve-btn';
        approveBtn.textContent = '\u25B6 Approve & Execute';
        approveBtn.addEventListener('click', function () {
          actions.remove();
          _isExecutingPlan = true;
          var markerInstructions = '\n\nIMPORTANT: As you work through the steps, output [TASK_START:N] immediately before starting step N and [TASK_DONE:N] immediately after completing it (or [TASK_FAIL:N] if it fails). These markers are consumed by the UI and must not be wrapped in code blocks.';
          var executionPrompt = 'The user has approved the following plan. Execute every step now, one by one, using your tools (write_file, edit_file, run_terminal, etc.).\n\nOriginal goal: ' + planGoal + '\n\nApproved plan:\n' + planContent + markerInstructions;
          hideWelcome();
          appendUserMsg('\u2705 Plan approved \u2014 executing\u2026', []);
          setStreaming(true);
          vscode.postMessage({ type: 'approvePlan', executionPrompt: executionPrompt });
        });

        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'plan-cancel-btn';
        cancelBtn.textContent = '\u2715 Cancel';
        cancelBtn.addEventListener('click', function () { actions.remove(); _planTasks = []; });

        actions.appendChild(approveBtn);
        actions.appendChild(cancelBtn);
        wrap.appendChild(actions);
      }
    }

    scrollBottom();
  }

  // ── Diff block builder ────────────────────────────────────────────────────
  /** @param filepath set for a change already made: adds "Open diff" (VS Code's diff editor) */
  function buildDiffBlock(diffStr, filepath) {
    if (!diffStr) { return null; }
    var lines = diffStr.split('\n');
    var adds = 0, rems = 0;
    for (var li = 0; li < lines.length; li++) {
      if (lines[li].charAt(0) === '+') { adds++; }
      else if (lines[li].charAt(0) === '-') { rems++; }
    }
    if (adds === 0 && rems === 0) { return null; } // identical — nothing to show

    var block = document.createElement('div');
    block.className = 'diff-block';

    var toggle = document.createElement('div');
    toggle.className = 'diff-toggle';
    var arrow = document.createElement('span');
    arrow.className = 'diff-toggle-arrow';
    arrow.textContent = '\u25B6';
    var stats = document.createElement('span');
    stats.className = 'diff-stats';
    if (adds) {
      var sa = document.createElement('span');
      sa.className = 'diff-stat-add';
      sa.textContent = '+' + adds;
      stats.appendChild(sa);
    }
    if (rems) {
      var sr = document.createElement('span');
      sr.className = 'diff-stat-rem';
      sr.textContent = '\u2212' + rems;
      stats.appendChild(sr);
    }
    var lbl = document.createElement('span');
    lbl.style.opacity = '0.55';
    lbl.textContent = (adds + rems) + ' line' + (adds + rems !== 1 ? 's' : '') + ' changed';
    toggle.appendChild(arrow);
    toggle.appendChild(stats);
    toggle.appendChild(lbl);
    if (filepath) {
      var openDiff = document.createElement('button');
      openDiff.className = 'diff-open-btn';
      openDiff.textContent = 'Open diff';
      openDiff.title = 'Compare in VS Code\u2019s diff editor (side by side, highlighted)';
      openDiff.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ type: 'openChangeDiff', path: filepath }); });
      toggle.appendChild(openDiff);
    }
    toggle.addEventListener('click', function() { block.classList.toggle('open'); scrollBottom(); });
    block.appendChild(toggle);

    var content = document.createElement('div');
    content.className = 'diff-content';
    var pre = document.createElement('pre');
    pre.className = 'diff-pre';
    for (var di = 0; di < lines.length; di++) {
      var line = lines[di];
      var span = document.createElement('span');
      var ch = line.charAt(0);
      if (line === '@@' || line === '\u2026' || line.slice(0,3) === '\u2026 (') {
        span.className = 'diff-line hunk';
        span.textContent = line === '@@' ? '\u00B7\u00B7\u00B7' : line;
      } else if (ch === '+') {
        span.className = 'diff-line add';
        span.textContent = line;
      } else if (ch === '-') {
        span.className = 'diff-line rem';
        span.textContent = line;
      } else {
        span.className = 'diff-line ctx';
        span.textContent = line;
      }
      if (di >= DIFF_PREVIEW_LINES) { span.classList.add('diff-more'); }
      pre.appendChild(span);
    }
    content.appendChild(pre);
    // Long diffs show their start; the rest on request (or in the diff editor)
    if (lines.length > DIFF_PREVIEW_LINES) {
      pre.classList.add('diff-clipped');
      var more = document.createElement('button');
      more.className = 'diff-show-all';
      more.textContent = 'Show all ' + lines.length + ' lines';
      more.addEventListener('click', function () { pre.classList.remove('diff-clipped'); more.remove(); });
      content.appendChild(more);
    }
    block.appendChild(content);
    return block;
  }
  var DIFF_PREVIEW_LINES = 40;

  function showWritePermCard(msgId, permId, filepath, preview, diff, editableContent) {
    // If the user already clicked "Allow All" this turn, auto-grant silently
    if (_allowAllWrites) {
      vscode.postMessage({ type: 'allowAllWrites', permId: permId });
      return;
    }

    var wrap = document.getElementById('msg-' + msgId);
    if (!wrap) { return; }

    var card = document.createElement('div');
    card.className = 'write-perm-card';
    card.id = 'perm-' + permId;

    var header = document.createElement('div');
    header.className = 'write-perm-header';
    header.innerHTML = '<span class="perm-icon">\uD83D\uDCDD</span><span>Allow Codico to write <strong>' + esc(filepath) + '</strong>?</span>';
    card.appendChild(header);

    // Show diff when available (open by default), fall back to plain preview
    var diffBlock = diff ? buildDiffBlock(diff) : null;
    if (diffBlock) {
      diffBlock.classList.add('open');
      diffBlock.style.margin = '0';
      diffBlock.style.borderRadius = '0';
      diffBlock.style.borderLeft = 'none';
      diffBlock.style.borderRight = 'none';
      diffBlock.style.borderTop = 'none';
      card.appendChild(diffBlock);
    } else if (preview) {
      var pre = document.createElement('div');
      pre.className = 'write-perm-preview';
      pre.textContent = preview;
      card.appendChild(pre);
    }

    var actions = document.createElement('div');
    actions.className = 'write-perm-actions';

    function resolveCard(granted) {
      card.innerHTML = '<div class="write-perm-resolved">' +
        (granted ? '\u2705 You allowed writing <strong>' + esc(filepath) + '</strong>' : '\u274C Write denied: <strong>' + esc(filepath) + '</strong>') +
        '</div>';
      vscode.postMessage({ type: 'writePermissionResponse', permId: permId, granted: granted });
    }

    var denyBtn = document.createElement('button');
    denyBtn.className = 'write-perm-btn deny';
    denyBtn.textContent = 'Deny';
    denyBtn.addEventListener('click', function() { resolveCard(false); });

    var allowBtn = document.createElement('button');
    allowBtn.className = 'write-perm-btn allow';
    allowBtn.textContent = 'Allow';
    allowBtn.addEventListener('click', function() { resolveCard(true); });

    var allowAllBtn = document.createElement('button');
    allowAllBtn.className = 'write-perm-btn allow-all';
    allowAllBtn.textContent = 'Allow all writes this task';
    allowAllBtn.title = 'Don\u2019t ask again for file writes until this task ends';
    allowAllBtn.addEventListener('click', function() {
      _allowAllWrites = true;
      card.innerHTML = '<div class="write-perm-resolved">\u2705 Allowed all writes &mdash; <strong>' + esc(filepath) + '</strong></div>';
      vscode.postMessage({ type: 'allowAllWrites', permId: permId });
    });

    actions.appendChild(allowBtn);
    actions.appendChild(allowAllBtn);
    if (editableContent) {
      var editBtn = document.createElement('button');
      editBtn.className = 'write-perm-btn edit';
      editBtn.textContent = 'Edit';
      editBtn.title = 'Modify the proposed content before applying';
      editBtn.addEventListener('click', function() {
        actions.style.display = 'none';
        editArea.classList.add('visible');
        editTextarea.focus();
        editTextarea.setSelectionRange(0, 0);
      });
      actions.appendChild(editBtn);
    }
    actions.appendChild(denyBtn);
    card.appendChild(actions);

    // Edit textarea area (hidden until Edit is clicked)
    var editArea = document.createElement('div');
    editArea.className = 'write-perm-edit-area';
    var editTextarea = document.createElement('textarea');
    editTextarea.className = 'write-perm-edit-textarea';
    editTextarea.value = editableContent || '';
    editArea.appendChild(editTextarea);
    var editActionsDiv = document.createElement('div');
    editActionsDiv.className = 'write-perm-edit-actions';
    var cancelEditBtn = document.createElement('button');
    cancelEditBtn.className = 'write-perm-btn deny';
    cancelEditBtn.textContent = 'Cancel';
    cancelEditBtn.addEventListener('click', function() {
      editArea.classList.remove('visible');
      actions.style.display = '';
    });
    var applyEditBtn = document.createElement('button');
    applyEditBtn.className = 'write-perm-btn apply-edit';
    applyEditBtn.textContent = 'Apply Edited';
    applyEditBtn.addEventListener('click', function() {
      card.innerHTML = '<div class="write-perm-resolved">\u270F\uFE0F Applied your edited version of <strong>' + esc(filepath) + '</strong></div>';
      vscode.postMessage({ type: 'writePermissionEdit', permId: permId, content: editTextarea.value });
    });
    editActionsDiv.appendChild(cancelEditBtn);
    editActionsDiv.appendChild(applyEditBtn);
    editArea.appendChild(editActionsDiv);
    card.appendChild(editArea);

    var copyBtn = document.getElementById('copy-' + msgId);
    if (copyBtn) { wrap.insertBefore(card, copyBtn); } else { wrap.appendChild(card); }
    scrollBottom();
  }

  function showTerminalPermCard(msgId, permId, command, note) {
    // If the user already clicked "Allow All" this turn, auto-grant silently, unless
    // the extension asks again (the agent read external content this turn)
    if (_allowAllTerminal && !note) {
      vscode.postMessage({ type: 'allowAllTerminal', permId: permId });
      return;
    }

    var wrap = document.getElementById('msg-' + msgId);
    if (!wrap) { return; }

    var card = document.createElement('div');
    card.className = 'write-perm-card';
    card.id = 'perm-' + permId;

    var header = document.createElement('div');
    header.className = 'write-perm-header';
    header.innerHTML = '<span class="perm-icon">\u26A1</span><span>Allow Codico to run a terminal command?</span>';
    card.appendChild(header);

    var pre = document.createElement('div');
    pre.className = 'write-perm-preview';
    pre.textContent = command;
    card.appendChild(pre);

    if (note) {
      var noteEl = document.createElement('div');
      noteEl.className = 'write-perm-preview';
      noteEl.style.color = 'var(--vscode-editorWarning-foreground, #d4a017)';
      noteEl.textContent = '\u26A0 ' + note;
      card.appendChild(noteEl);
    }

    var actions = document.createElement('div');
    actions.className = 'write-perm-actions';

    function resolveCard(granted) {
      card.innerHTML = '<div class="write-perm-resolved">' +
        (granted ? '\u2705 Allowed: <strong>' + esc(command.slice(0, 80)) + (command.length > 80 ? '\u2026' : '') + '</strong>'
                 : '\u274C Denied terminal command') +
        '</div>';
      vscode.postMessage({ type: 'terminalPermissionResponse', permId: permId, granted: granted });
    }

    var denyBtn = document.createElement('button');
    denyBtn.className = 'write-perm-btn deny';
    denyBtn.textContent = 'Deny';
    denyBtn.addEventListener('click', function() { resolveCard(false); });

    var allowBtn = document.createElement('button');
    allowBtn.className = 'write-perm-btn allow';
    allowBtn.textContent = 'Allow';
    allowBtn.addEventListener('click', function() { resolveCard(true); });

    var allowAllBtn = document.createElement('button');
    allowAllBtn.className = 'write-perm-btn allow-all';
    allowAllBtn.textContent = 'Allow all commands this task';
    allowAllBtn.title = 'Don\u2019t ask again for commands until this task ends (unless it reads web or MCP content)';
    allowAllBtn.addEventListener('click', function() {
      _allowAllTerminal = true;
      card.innerHTML = '<div class="write-perm-resolved">\u2705 Allowed all commands &mdash; <strong>' + esc(command.slice(0, 80)) + (command.length > 80 ? '\u2026' : '') + '</strong></div>';
      vscode.postMessage({ type: 'allowAllTerminal', permId: permId });
    });

    actions.appendChild(allowBtn);
    actions.appendChild(allowAllBtn);
    actions.appendChild(denyBtn);
    card.appendChild(actions);
    var copyBtn = document.getElementById('copy-' + msgId);
    if (copyBtn) { wrap.insertBefore(card, copyBtn); } else { wrap.appendChild(card); }
    scrollBottom();
  }

  // ── Live terminal output ──────────────────────────────────────────────────
  var _termBlocks = {}; // msgId → { block, body, cmd, autoScroll }

  function _getOrCreateTermBlock(msgId) {
    if (_termBlocks[msgId]) { return _termBlocks[msgId]; }
    var wrap = document.getElementById('msg-' + msgId);
    if (!wrap) { return null; }

    // The running command's pill: the last pending run_terminal pill (earlier ones are finished)
    var pills = wrap.querySelectorAll('.step-pill[data-pill-tool="run_terminal"]');
    var pill = null;
    for (var pi = pills.length - 1; pi >= 0; pi--) {
      if (pills[pi].querySelector('.step-pill-spinner')) { pill = pills[pi]; break; }
    }
    if (!pill && pills.length) { pill = pills[pills.length - 1]; }
    var cmd = pill ? (pill.dataset.pillLabel || '') : '';

    var block = document.createElement('div');
    block.className = 'terminal-block open';
    block.id = 'term-block-' + msgId;

    var hdr = document.createElement('div');
    hdr.className = 'terminal-block-header';
    hdr.addEventListener('click', function() { block.classList.toggle('open'); });

    var chev = document.createElement('span');
    chev.className = 'terminal-block-chevron';
    chev.textContent = '\u25B6';

    var cmdSpan = document.createElement('span');
    cmdSpan.className = 'terminal-block-cmd';
    cmdSpan.textContent = cmd || 'Running\u2026';

    var statusSpan = document.createElement('span');
    statusSpan.className = 'terminal-block-status running';
    statusSpan.textContent = '\u25CF Running';

    hdr.appendChild(chev);
    hdr.appendChild(cmdSpan);
    hdr.appendChild(statusSpan);

    var body = document.createElement('div');
    body.className = 'terminal-block-body';

    block.appendChild(hdr);
    block.appendChild(body);

    // Place the output directly under its command's pill. Appending at the end would put
    // it below the text the model writes next (even after the final conclusion).
    var copyBtn = document.getElementById('copy-' + msgId);
    if (pill && pill.parentNode === wrap) { wrap.insertBefore(block, pill.nextSibling); }
    else if (copyBtn) { wrap.insertBefore(block, copyBtn); }
    else { wrap.appendChild(block); }

    var state = { block: block, body: body, hdr: hdr, statusSpan: statusSpan, cmdSpan: cmdSpan, autoScroll: true };
    _termBlocks[msgId] = state;

    // Stop auto-scroll when user scrolls up
    body.addEventListener('scroll', function() {
      state.autoScroll = (body.scrollTop + body.clientHeight >= body.scrollHeight - 10);
    });

    return state;
  }

  function appendTerminalChunk(msgId, text) {
    var state = _getOrCreateTermBlock(msgId);
    if (!state || !text) { return; }
    // Append as text (not HTML) to prevent injection
    state.body.appendChild(document.createTextNode(text));
    if (state.autoScroll) { state.body.scrollTop = state.body.scrollHeight; }
    scrollBottom();
  }

  function finalizeTermBlock(msgId, success) {
    var state = _termBlocks[msgId];
    if (!state) { return; }
    state.statusSpan.className = 'terminal-block-status ' + (success ? 'ok' : 'err');
    state.statusSpan.textContent = success ? '\u2713 Done' : '\u2717 Failed';
    // Auto-collapse on success after a short delay
    if (success) {
      setTimeout(function() {
        if (state.block.classList.contains('open')) {
          state.block.classList.remove('open');
        }
      }, 2200);
    }
    delete _termBlocks[msgId];
  }

  function showToolPending(id, tool, label) {
    var wrap = document.getElementById('msg-' + id);
    if (!wrap) { return; }
    var copyBtn = document.getElementById('copy-' + id);

    // A tool is starting — any thinking that arrives after this tool completes
    // belongs to the next iteration and must open a fresh collapsible block.
    if (id === curId) { curThinkWrap = null; curThinkBody = null; }

    // If this is the active streaming message, finalize the current text segment
    // and create a new one after the pill, so pills appear inline between text blocks
    if (id === curId && curAoEl) {
      _mdRafPending = false;
      curAoEl.classList.remove('stream-cursor');
      curAoEl.innerHTML = renderMd(curSegRaw.replace(CLARIFY_RE, ''));
    }

    // Sync terminal block header with the real command label now that we have it
    if (tool === 'run_terminal' && _termBlocks[id]) {
      _termBlocks[id].cmdSpan.textContent = label;
    }

    var icons = {
      read_file: '\uD83D\uDCC4', list_directory: '\uD83D\uDCC1', run_terminal: '\u26A1',
      search_files: '\uD83D\uDD0D', find_files: '\uD83D\uDD0D', edit_file: '\u270F\uFE0F',
      get_diagnostics: '\uD83D\uDD0D', fetch_url: '\uD83C\uDF10',
      browser_navigate: '\uD83C\uDF10', browser_click: '\uD83D\uDDB1\uFE0F',
      browser_type: '\u2328\uFE0F', browser_get_text: '\uD83D\uDCDD',
      browser_screenshot: '\uD83D\uDCF8', browser_close: '\u274C',
      write_file: '\uD83D\uDCDD', lsp_symbol: '\uD83E\uDDE0', mcp_call: '\uD83E\uDDE9',
      debug_get_variables: '\uD83D\uDD0D', debug_get_callstack: '\uD83E\uDDF5', debug_list_breakpoints: '\uD83D\uDED1'
    };
    var pill = document.createElement('div');
    pill.className = 'step-pill';
    pill.dataset.pillTool = tool;
    pill.dataset.pillLabel = label;
    pill.innerHTML =
      '<span class="step-pill-spinner"></span>' +
      '<span class="step-pill-verb pending">' + ({
        read_file: 'Reading', list_directory: 'Listing', run_terminal: 'Running',
        search_files: 'Searching', find_files: 'Finding', edit_file: 'Editing',
        get_diagnostics: 'Analyzing', fetch_url: 'Fetching', write_file: 'Writing',
        browser_navigate: 'Navigating', browser_click: 'Clicking',
        browser_type: 'Typing', browser_get_text: 'Reading', browser_screenshot: 'Capturing',
        browser_close: 'Closing', lsp_symbol: 'Resolving', mcp_call: 'Calling',
        debug_get_variables: 'Inspecting', debug_get_callstack: 'Reading stack', debug_list_breakpoints: 'Listing'
      }[tool] || 'Running') + '\u2026</span>' +
      _pillLabelHtml(tool, label);
    _progress.set('activity', (pill.querySelector('.step-pill-verb') || {}).textContent + ' ' + label);

    // Insert pill before copyBtn so it appears in correct DOM order
    if (copyBtn) { wrap.insertBefore(pill, copyBtn); }
    else { wrap.appendChild(pill); }

    // Create a new text segment after the pill for content that follows the tool
    if (id === curId) {
      var newAo = document.createElement('div');
      newAo.className = 'agent-out stream-cursor';
      if (copyBtn) { wrap.insertBefore(newAo, copyBtn); }
      else { wrap.appendChild(newAo); }
      curAoEl = newAo;
      curSegRaw = '';
    }

    scrollBottom();
  }

  function showFileResult(id, filepath, granted, error, diff) {
    var wrap = document.getElementById('msg-' + id);
    if (!wrap) { return; }

    var targetPill = null;

    // Find the pending write_file pill for this filepath and update it in-place
    var pills = wrap.querySelectorAll('.step-pill[data-pill-tool="write_file"]');
    for (var c = 0; c < pills.length; c++) {
      var p = pills[c];
      // Only pending pills: two writes to the same file must each resolve their own pill
      if (!p.querySelector('.step-pill-spinner')) { continue; }
      if (p.dataset.pillLabel === filepath || filepath.endsWith(p.dataset.pillLabel) || p.dataset.pillLabel.endsWith(filepath.split('/').pop())) {
        var spinner = p.querySelector('.step-pill-spinner');
        if (spinner) {
          var iconSpan = document.createElement('span');
          iconSpan.className = 'step-pill-icon';
          iconSpan.textContent = '\uD83D\uDCDD';
          spinner.parentNode.replaceChild(iconSpan, spinner);
        }
        var vb = p.querySelector('.step-pill-verb');
        if (vb) {
          vb.className = 'step-pill-verb ' + (granted ? 'ok' : 'fail');
          vb.textContent = granted ? 'Written' : (error ? 'Error' : 'Denied');
        }
        targetPill = p;
        break;
      }
    }

    if (!targetPill) {
      var pill = document.createElement('div');
      pill.className = 'step-pill';
      pill.dataset.filepath = filepath;
      pill.dataset.pillTool = 'write_file';
      pill.innerHTML =
        '<span class="step-pill-icon">\uD83D\uDCDD</span>' +
        '<span class="step-pill-verb ' + (granted ? 'ok' : 'fail') + '">' +
          (granted ? 'Written' : (error ? 'Error' : 'Denied')) +
        '</span>' +
        _pillLabelHtml('write_file', filepath);
      var copyBtn = document.getElementById('copy-' + id);
      if (copyBtn) { wrap.insertBefore(pill, copyBtn); } else { wrap.appendChild(pill); }
      targetPill = pill;
    }

    // Attach diff block after the pill when write succeeded
    if (granted && diff) {
      var db = buildDiffBlock(diff, filepath);
      if (db) {
        db.style.marginLeft = '14px';
        var next = targetPill.nextSibling;
        if (next) { wrap.insertBefore(db, next); } else { wrap.appendChild(db); }
      }
    }

    scrollBottom();
  }

  function showToolResult(id, tool, label, success, error, diff) {
    var wrap = document.getElementById('msg-' + id);
    if (!wrap) { return; }
    // write_file pill is updated by showFileResult (which has the granted/denied state)
    if (tool === 'write_file') { return; }

    // Finalize the live terminal block (sets status dot, collapses on success)
    if (tool === 'run_terminal') { finalizeTermBlock(id, success); }

    var verbs = {
      read_file: 'Read', list_directory: 'Listed', run_terminal: 'Ran',
      search_files: 'Searched', find_files: 'Found', edit_file: 'Edited',
      get_diagnostics: 'Analyzed', fetch_url: 'Fetched',
      browser_navigate: 'Navigated', browser_click: 'Clicked',
      browser_type: 'Typed', browser_get_text: 'Read page',
      browser_screenshot: 'Screenshot', browser_close: 'Closed browser',
      write_file: 'Written', lsp_symbol: 'Resolved', mcp_call: 'Called',
      debug_get_variables: 'Inspected', debug_get_callstack: 'Read stack', debug_list_breakpoints: 'Listed'
    };
    var icons = {
      read_file: '\uD83D\uDCC4', list_directory: '\uD83D\uDCC1', run_terminal: '\u26A1',
      search_files: '\uD83D\uDD0D', find_files: '\uD83D\uDD0D', edit_file: '\u270F\uFE0F',
      get_diagnostics: '\uD83D\uDD0D', fetch_url: '\uD83C\uDF10',
      browser_navigate: '\uD83C\uDF10', browser_click: '\uD83D\uDDB1\uFE0F',
      browser_type: '\u2328\uFE0F', browser_get_text: '\uD83D\uDCDD',
      browser_screenshot: '\uD83D\uDCF8', browser_close: '\u274C',
      write_file: '\uD83D\uDCDD', lsp_symbol: '\uD83E\uDDE0', mcp_call: '\uD83E\uDDE9',
      debug_get_variables: '\uD83D\uDD0D', debug_get_callstack: '\uD83E\uDDF5', debug_list_breakpoints: '\uD83D\uDED1'
    };

    var verb = success ? (verbs[tool] || 'Done') : 'Failed';
    var icon = icons[tool] || '\uD83D\uDD27';

    var targetPill = null;

    // Find matching pending pill by tool+label and update it in-place
    var pills = wrap.querySelectorAll('.step-pill[data-pill-tool]');
    for (var i = 0; i < pills.length; i++) {
      var p = pills[i];
      // Only pending pills: repeated calls on the same target must each resolve their own pill
      if (!p.querySelector('.step-pill-spinner')) { continue; }
      if (p.dataset.pillTool === tool && (p.dataset.pillLabel === label || label.startsWith(p.dataset.pillLabel) || p.dataset.pillLabel.startsWith(label))) {
        var spinner = p.querySelector('.step-pill-spinner');
        if (spinner) {
          var iconSpan = document.createElement('span');
          iconSpan.className = 'step-pill-icon';
          iconSpan.textContent = icon;
          p.replaceChild(iconSpan, spinner);
        }
        var vb = p.querySelector('.step-pill-verb');
        if (vb) {
          vb.className = 'step-pill-verb ' + (success ? 'ok' : 'fail');
          vb.textContent = verb;
        }
        var lbl = p.querySelector('.step-pill-label');
        if (lbl) { lbl.textContent = label; }
        targetPill = p;
        break;
      }
    }

    if (!targetPill) {
      // No pending pill found — append a new completed pill
      var pill = document.createElement('div');
      pill.className = 'step-pill';
      pill.dataset.pillTool = tool;
      pill.innerHTML =
        '<span class="step-pill-icon">' + icon + '</span>' +
        '<span class="step-pill-verb ' + (success ? 'ok' : 'fail') + '">' + verb + '</span>' +
        _pillLabelHtml(tool, label);
      wrap.appendChild(pill);
      targetPill = pill;
    }

    // Attach diff block after edit_file pill on success
    if (tool === 'edit_file' && success && diff) {
      var db = buildDiffBlock(diff, String(label).split(' lines ')[0]);
      if (db) {
        db.style.marginLeft = '14px';
        var next = targetPill.nextSibling;
        if (next) { wrap.insertBefore(db, next); } else { wrap.appendChild(db); }
      }
    }

    scrollBottom();
  }

  function showBrowserScreenshot(id, dataUrl, url) {
    var wrap = document.getElementById('msg-' + id);
    if (!wrap) { return; }
    var card = document.createElement('div');
    card.className = 'browser-shot';
    var bar = document.createElement('div');
    bar.className = 'browser-shot-bar';
    bar.innerHTML = '\uD83C\uDF10 <span>' + esc(url) + '</span>';
    var img = document.createElement('img');
    img.src = dataUrl;
    img.alt = 'Browser screenshot';
    img.title = 'Click to zoom';
    img.addEventListener('click', function () { img.classList.toggle('zoomed'); });
    card.appendChild(bar);
    card.appendChild(img);
    // Insert before copy button if present
    var copyBtn = document.getElementById('copy-' + id);
    if (copyBtn) { wrap.insertBefore(card, copyBtn); } else { wrap.appendChild(card); }
    scrollBottom();
  }

  // Stream finish/error notices live in media/streamNotices.js.

  function showError(message) {
    setStreaming(false);
    var isCtxOverflow = /context.length|maximum context|context window|token.limit|too.long|exceed/i.test(message);
    var el = document.createElement('div');
    el.className = 'err-msg';

    var errText = document.createElement('span');
    errText.className = 'err-msg-text';
    errText.textContent = isCtxOverflow
      ? '\u26A0 Context limit reached \u2014 conversation history is too long for the model.'
      : '\u26A0 ' + message;
    el.appendChild(errText);

    if (isCtxOverflow) {
      var ctxBtn = document.createElement('button');
      ctxBtn.className = 'err-retry-btn';
      ctxBtn.textContent = '\u21BA Compact & Continue';
      ctxBtn.title = 'Summarize conversation history to free up context, then continue';
      ctxBtn.addEventListener('click', function() {
        el.remove();
        _pendingContinueAfterCompact = true;
        vscode.postMessage({ type: 'compactChat' });
      });
      el.appendChild(ctxBtn);
    } else if (_lastSentPayload) {
      var retryBtn = document.createElement('button');
      retryBtn.className = 'err-retry-btn';
      retryBtn.textContent = '\u21BA Retry';
      retryBtn.addEventListener('click', function() {
        el.remove();
        _retrySend();
      });
      el.appendChild(retryBtn);
    }

    msgs.appendChild(el);
    scrollBottom();
  }

  // Numbered plan steps in the formats models actually use: "1. x", "1) x", "**1. x**",
  // "### 1. x", "- **Step 1:** x", "Step 1 — x". Markdown emphasis is stripped from the text.
  // ":" and dash separators only count after the word "Step", so "10:30 …" is not a step.
  var PLAN_STEP_RE = /^[ \t]*(?:[-*+][ \t]+)?(?:#{1,6}[ \t]+)?(?:\*\*|__)?[ \t]*(step[ \t]+)?(\d{1,3})[ \t]*([.):]|[—–-])[ \t]*(.+)$/gim;
  function _parsePlanSteps(text) {
    var found = [];
    var m;
    PLAN_STEP_RE.lastIndex = 0;
    while ((m = PLAN_STEP_RE.exec(text)) !== null) {
      var sep = m[3];
      if (!m[1] && sep !== '.' && sep !== ')') { continue; }
      var stepText = _stripHeadingEmphasis(m[4]);
      if (stepText) { found.push({ n: parseInt(m[2], 10), line: stepText, start: m.index, end: PLAN_STEP_RE.lastIndex }); }
    }
    return found.map(function (f, i) {
      // Lines after the step line (e.g. under a bold "**1. Title**") are its description,
      // up to the next step or the next heading / quote / rule
      var stop = i + 1 < found.length ? found[i + 1].start : text.length;
      var following = text.slice(f.end, stop).split('\n');
      var cut = following.findIndex(function (l) { return /^\s*(#{1,6}\s|>|---)/.test(l); });
      if (cut >= 0) { following = following.slice(0, cut); }
      var extra = following.join(' ').replace(/\s+/g, ' ').trim();
      var split = _splitPlanStep(f.line);
      var detail = [split.detail, extra].filter(Boolean).join(' ');
      return { n: f.n, text: split.title, detail: detail, status: 'pending' };
    });
  }

  function _buildPlanCard(tasks) {
    var md = window.CodicoMarkdown;
    var fmt = function (t) { return md && md.renderInline ? md.renderInline(t) : esc(t); };
    var card = document.createElement('div');
    card.className = 'plan-card';
    card.innerHTML =
      '<div class="plan-card-header">' +
        '<span class="plan-card-icon">📋</span>' +
        '<span class="plan-card-title">Plan</span>' +
        '<span class="plan-card-count">' + tasks.length + (tasks.length === 1 ? ' step' : ' steps') + '</span>' +
      '</div>';
    var list = document.createElement('ol');
    list.className = 'plan-steps';
    // Every step and its full description are shown: the user reads the whole plan before approving
    tasks.forEach(function (task) {
      var li = document.createElement('li');
      li.className = 'plan-step';
      li.innerHTML =
        '<span class="plan-step-num">' + task.n + '</span>' +
        '<div class="plan-step-body">' +
          '<div class="plan-step-title">' + fmt(task.text) + '</div>' +
          (task.detail ? '<div class="plan-step-detail">' + fmt(task.detail) + '</div>' : '') +
        '</div>';
      list.appendChild(li);
    });
    card.appendChild(list);
    return card;
  }

  // Remove the emphasis wrapping a step heading ("**1. Title**", "- **Step 1:** x") while
  // keeping balanced inline emphasis inside the step ("uses **built-in** providers")
  function _stripHeadingEmphasis(text) {
    var t = text.replace(/^\s*(\*\*|__)\s*/, '').trim();
    ['**', '__'].forEach(function (mark) {
      if ((t.split(mark).length - 1) % 2 === 1) {
        var i = t.indexOf(mark);
        t = (t.slice(0, i) + t.slice(i + mark.length)).trim();
      }
    });
    return t;
  }

  // "Add x.ts — does y" / "Add x.ts: does y" / "Add x.ts. Then y" -> short title + details
  function _splitPlanStep(line) {
    var m = line.match(/^(.{3,120}?)\s+[—–]\s+(.+)$/) || line.match(/^(.{3,90}?):\s+(.+)$/);
    if (m) { return { title: m[1].trim(), detail: m[2].trim() }; }
    var s = line.match(/^(.{12,120}?[.!?])\s+(.+)$/);
    if (s) { return { title: s[1].replace(/\.$/, '').trim(), detail: s[2].trim() }; }
    return { title: line, detail: '' };
  }

  // 950 -> "950", 12345 -> "12.3k", 2400000 -> "2.4M"
  function _fmtTokens(n) {
    if (!n) { return '0'; }
    if (n < 1000) { return String(n); }
    if (n < 1000000) { return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k'; }
    return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  // While a reply streams, the view follows it only if the reader is at the bottom; scrolling up
  // to read stops that and offers a "Jump to latest" pill. Sending or opening a thread re-attaches.
  var _followStream = true;
  var _lastAutoTop = 0;
  var _jumpPill = null;
  function scrollBottom(force) {
    if (force) { _followStream = true; }
    // Scroll events arrive a frame late: if the view moved up since our last scroll, the reader did it
    else if (msgs.scrollTop < _lastAutoTop - 4) { _followStream = false; }
    if (_followStream) {
      // Instant: a smooth (animated) scroll per chunk lags behind the stream and its in-between
      // positions would look like the reader scrolling up
      msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'instant' });
      _lastAutoTop = msgs.scrollTop;
      _showJumpPill(false);
    } else {
      _showJumpPill(true);
    }
  }
  function _showJumpPill(on) {
    if (on && !_jumpPill) {
      _jumpPill = document.createElement('button');
      _jumpPill.className = 'jump-latest';
      _jumpPill.textContent = '\u2193 Jump to latest';
      _jumpPill.addEventListener('click', function () { scrollBottom(true); });
      document.body.appendChild(_jumpPill);
    }
    if (!_jumpPill) { return; }
    // Just above the bottom edge of the messages, clear of the status bar and toolbars below
    _jumpPill.style.bottom = Math.max(10, window.innerHeight - msgs.getBoundingClientRect().bottom + 10) + 'px';
    _jumpPill.style.display = on ? 'block' : 'none';
  }
  msgs.addEventListener('scroll', function () {
    var atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
    if (atBottom) { _followStream = true; _lastAutoTop = msgs.scrollTop; _showJumpPill(false); }
    else if (msgs.scrollTop < _lastAutoTop - 4) { _followStream = false; }
  });
  // Upward wheel or touch movement stops following at once, before the next chunk renders
  msgs.addEventListener('wheel', function (e) { if (e.deltaY < 0) { _followStream = false; } }, { passive: true });
  msgs.addEventListener('touchmove', function () { _followStream = false; }, { passive: true });

  function _relativeTime(ts) {
    var diff = Math.max(0, Date.now() - ts);
    var s = Math.floor(diff / 1000);
    if (s < 60) { return s + 's'; }
    var m = Math.floor(s / 60);
    if (m < 60) { return m + 'm'; }
    var h = Math.floor(m / 60);
    if (h < 24) { return h + 'h'; }
    var d = Math.floor(h / 24);
    if (d < 30) { return d + 'd'; }
    return Math.floor(d / 30) + 'mo';
  }

  function _renderThreadTabs(threads) {
    var listEl = document.getElementById('sessions-list');
    var activeNameEl = document.getElementById('sessions-active-name');
    listEl.innerHTML = '';
    var lastGroup = null;
    threads.forEach(function(t) {
      var group = _threadGroup(t);
      if (group !== lastGroup) {
        var head = document.createElement('div');
        head.className = 'session-group';
        head.textContent = group;
        listEl.appendChild(head);
        lastGroup = group;
      }
      if (t.active) {
        _currentThreadIdForSearch = t.id;
        if (activeNameEl) { activeNameEl.textContent = t.name; }
      }

      var card = document.createElement('div');
      card.className = 'session-card' + (t.active ? ' session-active' : '') + (t.pinned ? ' session-pinned' : '');
      card.title = (t.preview || '(empty)') + '\n' + t.messageCount + ' message(s)' +
        (t.tokens ? '\n' + _fmtTokens(t.tokens) + ' tokens' + (typeof t.costUsd === 'number' ? ' \u00B7 $' + t.costUsd.toFixed(t.costUsd < 1 ? 3 : 2) : '') : '');
      card.dataset.id = t.id;

      var nameEl = document.createElement('div');
      nameEl.className = 'session-card-name';
      nameEl.textContent = t.name;
      var textEl = document.createElement('div');
      textEl.className = 'session-card-text';
      textEl.appendChild(nameEl);
      if (t.preview && t.preview !== t.name) {
        var previewEl = document.createElement('div');
        previewEl.className = 'session-card-preview';
        previewEl.textContent = t.preview;
        textEl.appendChild(previewEl);
      }

      var rightEl = document.createElement('div');
      rightEl.className = 'session-card-right';

      var timeEl = document.createElement('span');
      timeEl.className = 'session-card-time';
      timeEl.textContent = _relativeTime(t.updatedAt || Date.now());

      var actionsEl = document.createElement('div');
      actionsEl.className = 'session-card-actions';

      var editBtn = document.createElement('button');
      editBtn.className = 'session-action-btn';
      editBtn.title = 'Rename';
      editBtn.innerHTML = '&#9998;';
      editBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        _inlineRenameCard(card, nameEl, t);
      });

      var pinBtn = document.createElement('button');
      pinBtn.className = 'session-action-btn' + (t.pinned ? ' pinned' : '');
      pinBtn.title = t.pinned ? 'Unpin' : 'Pin to the top';
      pinBtn.textContent = '\uD83D\uDCCC';
      pinBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'pinThread', id: t.id });
      });
      actionsEl.appendChild(pinBtn);
      actionsEl.appendChild(editBtn);

      var hasOtherNonEmpty = threads.some(function(other) { return other.id !== t.id && other.messageCount > 0; });
      if (t.messageCount > 0 || hasOtherNonEmpty) {
        var delBtn = document.createElement('button');
        delBtn.className = 'session-action-btn danger';
        delBtn.title = 'Delete';
        delBtn.textContent = '🗑';
        delBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          _confirmDeleteThread(t.id, t.name);
        });
        actionsEl.appendChild(delBtn);
      }
      rightEl.appendChild(timeEl);
      rightEl.appendChild(actionsEl);

      card.appendChild(textEl);
      card.appendChild(rightEl);

      card.addEventListener('click', function() {
        if (!t.active) {
          vscode.postMessage({ type: 'switchThread', id: t.id });
          _closeSessions();
        }
      });

      listEl.appendChild(card);
    });
  }

  function _threadGroup(t) {
    if (t.pinned) { return 'Pinned'; }
    var day = new Date(); day.setHours(0, 0, 0, 0);
    var at = t.updatedAt || Date.now();
    if (at >= day.getTime()) { return 'Today'; }
    if (at >= day.getTime() - 86400000) { return 'Yesterday'; }
    if (at >= day.getTime() - 6 * 86400000) { return 'This week'; }
    return 'Older';
  }

  function _confirmDeleteThread(threadId, threadName) {
    window._showDeleteModal(threadId, threadName);
  }

  document.addEventListener('codico:deleteThread', function(e) {
    vscode.postMessage({ type: 'deleteThread', id: e.detail.id });
  });

  function _inlineRenameCard(card, nameEl, thread) {
    if (card.querySelector('.session-rename-input')) { return; } // already editing
    var inp = document.createElement('input');
    inp.className = 'session-rename-input';
    inp.value = thread.name;
    inp.setAttribute('maxlength', '60');
    inp.style.cssText = 'flex:1;min-width:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-focusBorder,#a78bfa);border-radius:4px;padding:1px 6px;font-size:12px;font-family:inherit;outline:none;';
    nameEl.replaceWith(inp);
    inp.focus();
    inp.select();

    function commit() {
      var v = inp.value.trim();
      if (v && v !== thread.name) {
        vscode.postMessage({ type: 'renameThread', id: thread.id, name: v });
        thread.name = v;
      }
      var restored = document.createElement('div');
      restored.className = 'session-card-name';
      restored.textContent = thread.name;
      inp.replaceWith(restored);
    }
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); inp.value = thread.name; inp.blur(); }
    });
  }

  // ── Sessions panel toggle ──────────────────────────────────────────────────
  var _sessionsOpen = false;
  var _sessionsToggleBtn = document.getElementById('sessions-toggle-btn');
  var _sessionsListEl = document.getElementById('sessions-list');

  function _openSessions() {
    _sessionsOpen = true;
    _sessionsListEl.classList.add('open');
    _sessionsToggleBtn.classList.add('open');
  }
  function _closeSessions() {
    _sessionsOpen = false;
    _sessionsListEl.classList.remove('open');
    _sessionsToggleBtn.classList.remove('open');
  }
  _sessionsToggleBtn.addEventListener('click', function() {
    if (_sessionsOpen) { _closeSessions(); } else { _openSessions(); }
  });

  function _renderFollowUps(msgId, suggestions) {
    if (!suggestions || suggestions.length === 0) { return; }
    var wrap = document.getElementById('msg-' + msgId);
    if (!wrap) { return; }
    // Remove any existing follow-up row (re-render guard)
    var existing = wrap.querySelector('.followup-row');
    if (existing) { existing.remove(); }

    var row = document.createElement('div');
    row.className = 'followup-row';

    suggestions.forEach(function (text) {
      var chip = document.createElement('button');
      chip.className = 'followup-chip';
      chip.textContent = '↩ ' + text;
      chip.title = text;
      chip.addEventListener('click', function () {
        row.remove(); // dismiss after clicking
        hideWelcome();
        appendUserMsg(text, [], []);
        setStreaming(true);
        vscode.postMessage({ type: 'sendFollowUp', text: text });
      });
      row.appendChild(chip);
    });

    wrap.appendChild(row);
    scrollBottom();
  }

  // ── Clarify widget parser & renderer ───────────────────────────────────
  var CLARIFY_RE = /<clarify>([\s\S]*?)<\/clarify>/g;

  function _parseClarify(raw) {
    var lines = raw.trim().split('\n');
    var result = { question: '', type: 'single', options: [], freeInput: false };
    var inOptions = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^question:\s*/.test(line)) {
        result.question = line.replace(/^question:\s*/, '').trim();
        inOptions = false;
      } else if (/^type:\s*/.test(line)) {
        result.type = line.replace(/^type:\s*/, '').trim() === 'multi' ? 'multi' : 'single';
        inOptions = false;
      } else if (/^free_input:\s*/.test(line)) {
        result.freeInput = /true/i.test(line);
        inOptions = false;
      } else if (/^options:\s*$/.test(line.trim())) {
        inOptions = true;
      } else if (inOptions && /^\s*-\s+/.test(line)) {
        result.options.push(line.replace(/^\s*-\s+/, '').trim());
      }
    }
    return result;
  }

  function _renderClarifyWidget(spec, msgWrap) {
    var widget = document.createElement('div');
    widget.className = 'clarify-widget';

    var header = document.createElement('div');
    header.className = 'clarify-header';
    header.textContent = spec.type === 'multi' ? '🔲 Clarification needed (select all that apply)' : '❓ Clarification needed';
    widget.appendChild(header);

    var qEl = document.createElement('div');
    qEl.className = 'clarify-question';
    qEl.textContent = spec.question;
    widget.appendChild(qEl);

    var selected = new Set();

    if (spec.options.length > 0) {
      var optsEl = document.createElement('div');
      optsEl.className = 'clarify-opts';
      spec.options.forEach(function (opt, idx) {
        var row = document.createElement('div');
        row.className = 'clarify-opt';
        row.dataset.value = opt;
        var icon = document.createElement('span');
        icon.className = 'clarify-opt-icon';
        icon.textContent = spec.type === 'multi' ? '☐' : '○';
        var label = document.createElement('span');
        label.textContent = opt;
        row.appendChild(icon);
        row.appendChild(label);
        row.addEventListener('click', function () {
          if (spec.type === 'single') {
            selected.clear();
            optsEl.querySelectorAll('.clarify-opt').forEach(function (o) {
              o.classList.remove('selected');
              o.querySelector('.clarify-opt-icon').textContent = '○';
            });
            selected.add(opt);
            row.classList.add('selected');
            icon.textContent = '●';
          } else {
            if (selected.has(opt)) {
              selected.delete(opt);
              row.classList.remove('selected');
              icon.textContent = '☐';
            } else {
              selected.add(opt);
              row.classList.add('selected');
              icon.textContent = '☑';
            }
          }
          submitBtn.disabled = selected.size === 0 && !freeInput;
        });
        optsEl.appendChild(row);
      });
      widget.appendChild(optsEl);
    }

    var freeInput = null;
    if (spec.freeInput) {
      var freeWrap = document.createElement('div');
      freeWrap.className = 'clarify-free';
      freeInput = document.createElement('input');
      freeInput.type = 'text';
      freeInput.className = 'clarify-free-input';
      freeInput.placeholder = spec.options.length > 0 ? 'Or type a custom answer…' : 'Type your answer…';
      freeInput.addEventListener('input', function () {
        submitBtn.disabled = selected.size === 0 && freeInput.value.trim() === '';
      });
      freeInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !submitBtn.disabled) { submitBtn.click(); }
      });
      freeWrap.appendChild(freeInput);
      widget.appendChild(freeWrap);
    }

    var actions = document.createElement('div');
    actions.className = 'clarify-actions';

    var submitBtn = document.createElement('button');
    submitBtn.className = 'clarify-submit-btn';
    submitBtn.textContent = 'Send';
    // Disabled until selection or text is provided
    submitBtn.disabled = spec.options.length > 0 || spec.freeInput;
    if (!spec.options.length && !spec.freeInput) { submitBtn.disabled = false; }

    submitBtn.addEventListener('click', function () {
      var parts = [];
      selected.forEach(function (v) { parts.push(v); });
      if (freeInput && freeInput.value.trim()) { parts.push(freeInput.value.trim()); }
      if (parts.length === 0) { return; }

      var answer = parts.join(', ');
      // Mark widget as answered
      widget.classList.add('answered');
      var answeredLabel = document.createElement('div');
      answeredLabel.className = 'clarify-answered-label';
      answeredLabel.textContent = '✓ You answered: ' + answer;
      widget.appendChild(answeredLabel);

      // Display as a user message and resume flow
      hideWelcome();
      appendUserMsg(answer, []);
      setStreaming(true);
      vscode.postMessage({ type: 'clarifyResponse', text: answer });
    });

    var skipBtn = document.createElement('button');
    skipBtn.className = 'clarify-skip-btn';
    skipBtn.textContent = 'Skip';
    skipBtn.addEventListener('click', function () {
      widget.classList.add('answered');
      var answeredLabel = document.createElement('div');
      answeredLabel.className = 'clarify-answered-label';
      answeredLabel.textContent = '— Skipped';
      widget.appendChild(answeredLabel);
    });

    actions.appendChild(submitBtn);
    actions.appendChild(skipBtn);
    widget.appendChild(actions);
    msgWrap.appendChild(widget);
  }

  function esc(t) {
    return String(t)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Markdown rendering lives in media/markdown.js.

  // ── Message handler ─────────────────────────────────────────────────────
  window.addEventListener('message', function (event) { handleExtMessage(event.data); });

  // Rebuilds a stored assistant reply by replaying the events it streamed through
  // the normal handlers, so a reopened thread looks exactly like the live one.
  var _replaySeq = 0;
  function _replayAssistant(events, at) {
    var rid = 'replay-' + (++_replaySeq);
    handleExtMessage({ type: 'startMessage', id: rid });
    events.forEach(function(ev) { handleExtMessage(Object.assign({}, ev, { id: rid })); });
    handleExtMessage({ type: 'endMessage', id: rid });
    // Saved replies show when they were written, not when they were replayed
    var t = document.querySelector('#msg-' + rid + ' .msg-time');
    if (t) { if (at) { t.dataset.ts = String(at); _refreshTime(t); } else { t.remove(); } }
  }

  function handleExtMessage(data) {
    switch (data.type) {
      // setStreaming: replies the extension starts itself (CodeLens, editor commands, /test…)
      // must also show Stop and a working status, not only ones sent from this panel
      case 'startMessage':    _allowAllWrites = false; _allowAllTerminal = false; _hideQueuedBanner(); if (data.planGoal) { _planGoals[data.id] = data.planGoal; }
        // Messages start their turns in the order they were sent: the oldest untagged bubble is this turn's
        if (data.turnId) { var ub = _oldestUntaggedUserMsg(); if (ub) { _tagUserMsg(ub, data.turnId, data.editable); if (data.planGoal) { ub.dataset.editText = data.planGoal; } } }
        startMsg(data.id); setStreaming(true); break;
      case 'uiSettings':
        document.body.classList.toggle('density-compact', data.density === 'compact');
        document.body.classList.toggle('hide-reasoning', data.showReasoning === false);
        break;
      case 'turnSkipped':     var sb = _oldestUntaggedUserMsg(); if (sb) { _tagUserMsg(sb, null, false); } break;
      case 'droppedImage':    _pastedImages.push({ dataUrl: data.dataUrl }); _renderImgPreviews(); break;
      case 'appendThinking':  appendThinking(data.id, data.text); break;
      case 'appendContent':   appendContent(data.id, data.text); break;
      case 'endMessage':      endMsg(data.id); break;
      case 'writePermissionRequest': showWritePermCard(data.id, data.permId, data.filepath, data.preview, data.diff, data.editableContent); break;
      case 'terminalPermissionRequest': showTerminalPermCard(data.id, data.permId, data.command, data.note); break;
      case 'fileWriteResult': showFileResult(data.id, data.filepath, data.granted, data.error, data.diff); break;
      case 'toolStart':      showToolPending(data.id, data.tool, data.label); break;
      case 'toolResult':      showToolResult(data.id, data.tool, data.label, data.success, data.error, data.diff); break;
      case 'terminalChunk':   appendTerminalChunk(data.id, data.text); break;
      case 'error':           showError(data.message); break;
      case 'streamFinishReason': showStreamFinishReason(data.id, data.reason); break;
      case 'streamError':        showStreamInlineError(data.id, data.message); break;
      case 'autoCommitDone': {
        var sText = document.getElementById('s-text');
        if (sText) { sText.textContent = '\u2714 Committed: ' + data.message.slice(0, 60) + (data.message.length > 60 ? '\u2026' : ''); }
        setTimeout(function() { var t = document.getElementById('s-text'); if (t && t.textContent.startsWith('\u2714 Committed')) { t.textContent = 'Ready'; } }, 6000);
        break;
      }
      case 'autoCommitError':
        showError('Auto-commit failed: ' + data.message);
        break;
      case 'browserScreenshot':
        showBrowserScreenshot(data.id, data.dataUrl, data.url);
        break;
      case 'reviewReady':
        if (data.error) {
          showError(data.error);
        } else {
          hideWelcome();
          appendUserMsg('\uD83D\uDD0D Code Review: ' + data.label, []);
          setStreaming(true);
        }
        break;
      case 'tokenUsage':
        if (sTokens) {
          var tokText = data.totalTokens
            ? (_fmtTokens(data.promptTokens) + '\u2191 ' + _fmtTokens(data.completionTokens) + '\u2193')
            : '';
          // Share of the prompt the provider served from its cache (billed at a fraction of the price)
          if (data.cachedTokens && data.promptTokens) {
            tokText += ' (' + Math.round(100 * data.cachedTokens / data.promptTokens) + '% cached)';
          }
          if (data.taskTokens) {
            // Cached tokens are counted in the total but billed at a fraction of the price: say how many
            var taskCached = data.taskCachedTokens ? ' (' + Math.round(100 * data.taskCachedTokens / data.taskTokens) + '% cached)' : '';
            _progress.set('usage', _fmtTokens(data.taskTokens) + ' tok' + taskCached + (typeof data.taskCostUsd === 'number' ? ' \u00B7 $' + data.taskCostUsd.toFixed(data.taskCostUsd < 1 ? 3 : 2) : ''));
            tokText += ' \u00b7 task ' + _fmtTokens(data.taskTokens) + ' tok' + taskCached;
            if (typeof data.taskCostUsd === 'number') {
              tokText += ' \u00b7 $' + data.taskCostUsd.toFixed(data.taskCostUsd < 1 ? 3 : 2);
            }
          }
          sTokens.textContent = tokText;
          sTokens.title = 'Last request: ' + data.promptTokens + ' prompt' +
            (data.cachedTokens ? ' (' + data.cachedTokens + ' from cache)' : '') +
            ' + ' + data.completionTokens + ' completion tokens' +
            (data.taskTokens ? '\nThis task: ' + data.taskTokens + ' tokens' : '') +
            (typeof data.taskCostUsd === 'number' ? ' (provider-reported cost $' + data.taskCostUsd.toFixed(4) + ')' : '');
        }
        break;
      case 'compactStart': {
        var cmpSt = document.getElementById('s-text');
        if (cmpSt) { cmpSt.textContent = 'Compacting\u2026'; }
        // If a stream is active, insert an inline "Compacting\u2026" pill inside the current bubble
        if (curId) {
          var cmpWrap = document.getElementById('msg-' + curId);
          var cmpCopyBtn = document.getElementById('copy-' + curId);
          if (cmpWrap) {
            var cmpPill = document.createElement('div');
            cmpPill.className = 'compact-notice compact-notice-inline';
            cmpPill.id = 'compact-inline-' + curId;
            cmpPill.innerHTML = '<span style="font-size:14px;flex-shrink:0">&#8597;</span><span>Compacting context\u2026</span>';
            if (cmpCopyBtn) { cmpWrap.insertBefore(cmpPill, cmpCopyBtn); }
            else { cmpWrap.appendChild(cmpPill); }
            scrollBottom();
          }
        }
        break;
      }
      case 'compactDone': {
        // If compact ran mid-stream, update the inline pill and keep the status as streaming
        var inlinePill = curId ? document.getElementById('compact-inline-' + curId) : null;
        if (inlinePill) {
          inlinePill.innerHTML =
            '<span style="font-size:14px;flex-shrink:0">&#8597;</span>' +
            '<span><strong>Context compacted</strong> &mdash; resuming\u2026</span>';
          inlinePill.removeAttribute('id'); // detach so a second compact gets a fresh pill
        } else {
          // Stand-alone compact (triggered manually or post-stream)
          var cmpDt = document.getElementById('s-text');
          if (cmpDt) { cmpDt.textContent = 'Ready'; }
          if (sTokens) { sTokens.textContent = ''; }
          addCompactNotice(data.messageCount || 0);
        }
        if (_pendingContinueAfterCompact) {
          _pendingContinueAfterCompact = false;
          vscode.postMessage({ type: 'sendFollowUp', text: 'Continue from where you left off.' });
        }
        break;
      }
      case 'compactCancelled': {
        // Compaction was stopped with the turn: drop the "Compacting…" indicator quietly
        var cmpPill = curId ? document.getElementById('compact-inline-' + curId) : null;
        if (cmpPill) { cmpPill.remove(); }
        if (!streaming) { var cmpSt2 = document.getElementById('s-text'); if (cmpSt2) { cmpSt2.textContent = 'Ready'; } }
        break;
      }
      case 'compactError': {
        var cmpEr = document.getElementById('s-text');
        if (cmpEr) { cmpEr.textContent = 'Ready'; }
        showError('Compact failed: ' + (data.message || 'unknown error'));
        break;
      }
      case 'iterationLimit': {
        var ilWrap = document.getElementById('msg-' + data.id);
        var ilAo = curAoEl || (ilWrap && ilWrap.querySelector('.agent-out'));
        var ilTarget = ilAo || ilWrap;
        if (ilTarget) {
          var ilEl = document.createElement('div');
          ilEl.className = 'stream-stop-notice warn';
          var ilTxt = document.createElement('span');
          ilTxt.textContent = '⚠ Reached the ' + data.limit + '-step limit.';
          ilEl.appendChild(ilTxt);
          var ilBtn = document.createElement('button');
          ilBtn.className = 'continue-btn';
          ilBtn.textContent = '▶ Continue';
          ilBtn.title = 'Continue from where the agent left off';
          ilBtn.addEventListener('click', function() {
            ilBtn.disabled = true;
            ilBtn.textContent = '…';
            vscode.postMessage({ type: 'sendMessage', text: 'Continue', contentParts: undefined });
          });
          ilEl.appendChild(ilBtn);
          ilTarget.appendChild(ilEl);
          scrollBottom();
        }
        break;
      }
      case 'stepProgress':
        if (data.id === curId) { sStep.textContent = '\u00b7 step ' + data.step; }
        break;
      case 'activity':
        if (streaming) {
          if (data.text) { _progress.set('activity', data.text); }
          sText.textContent = data.text || 'Thinking\u2026';
          sDot.className = 's-dot ' + (data.text ? 'writing' : 'thinking');
        }
        break;
      case 'checkpoint': {
        var cpWrap = document.getElementById('msg-' + data.id);
        if (!cpWrap) { break; }
        var cpEl = document.createElement('div');
        cpEl.className = 'stream-stop-notice warn checkpoint-notice';
        var cpTxt = document.createElement('span');
        cpTxt.textContent = '\u23F8 ' + (data.reason || (data.steps + ' steps so far. Keep going?'));
        var cpGo = document.createElement('button');
        cpGo.className = 'continue-btn';
        cpGo.textContent = '\u25B6 Continue';
        var cpStop = document.createElement('button');
        cpStop.className = 'checkpoint-stop-btn';
        cpStop.textContent = 'Stop here';
        var cpAnswer = function(keepGoing) {
          vscode.postMessage({ type: 'checkpointResponse', continue: keepGoing });
          cpEl.remove();
        };
        cpGo.addEventListener('click', function() { cpAnswer(true); });
        cpStop.addEventListener('click', function() { cpAnswer(false); });
        cpEl.appendChild(cpTxt);
        cpEl.appendChild(cpGo);
        cpEl.appendChild(cpStop);
        var cpCopy = document.getElementById('copy-' + data.id);
        if (cpCopy) { cpWrap.insertBefore(cpEl, cpCopy); } else { cpWrap.appendChild(cpEl); }
        sText.textContent = 'Waiting for you\u2026';
        sDot.className = 's-dot';
        scrollBottom();
        break;
      }
      case 'backgroundProcesses': {
        var procs = data.processes || [];
        bgBtn.disabled = false;
        bgBtn.style.display = procs.length ? 'inline-block' : 'none';
        bgBtn.textContent = '\u2699 ' + procs.length + ' background ' + (procs.length === 1 ? 'process' : 'processes') + ' \u2715';
        bgBtn.title = 'Click to stop:\n' + procs.map(function(p) { return p.command.slice(0, 120); }).join('\n');
        break;
      }
      case 'contextSnippet':
        addCtxAttachment(data.kind, data.label, data.text);
        break;
      case 'setModel':
        if (data.model) { modelDrop.setValue(data.model); }
        break;
      case 'selectionBadge':
        _updateSelectionBadge(data.label || '');
        break;
      case 'focusInput':
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        break;
      case 'setEffort':
        if (data.effort) { effortDrop.setValue(data.effort); }
        break;
      case 'agentActive':
        if (data.agent) { _setActiveAgent(data.agent); }
        break;
      case 'mcpStatus':
        _updateMcpStatus(data.servers ?? []);
        break;
      case 'undoRedoState':
        document.getElementById('undo-btn').disabled = !data.canUndo;
        document.getElementById('redo-btn').disabled = !data.canRedo;
        document.getElementById('undo-btn').title = data.canUndo
          ? ('Undo: ' + (data.undoLabel || 'last AI change'))
          : 'Undo last AI file change';
        document.getElementById('redo-btn').title = data.canRedo
          ? ('Redo: ' + (data.redoLabel || 'last AI change'))
          : 'Redo last AI file change';
        break;
      case 'diagnosticsChanged': {
        _workspaceErrors = data.errorCount || 0;
        _renderStarters();
        var diagBadge = document.getElementById('diag-badge');
        var ec = data.errorCount || 0;
        var wc = data.warningCount || 0;
        diagBadge.classList.remove('has-errors', 'has-warnings', 'clean');
        if (ec > 0) {
          diagBadge.className = 'has-errors';
          diagBadge.textContent = '\u24d8 ' + ec + ' error' + (ec !== 1 ? 's' : '') + (wc > 0 ? ', ' + wc + ' warn' : '');
          diagBadge.title = 'Workspace Problems: ' + ec + ' error(s), ' + wc + ' warning(s) \u2014 automatically included in AI context';
        } else if (wc > 0) {
          diagBadge.className = 'has-warnings';
          diagBadge.textContent = '\u26a0 ' + wc + ' warning' + (wc !== 1 ? 's' : '');
          diagBadge.title = 'Workspace Problems: ' + wc + ' warning(s) \u2014 automatically included in AI context';
        } else {
          diagBadge.className = 'clean';
          diagBadge.textContent = '\u2714 clean';
          diagBadge.title = 'No errors or warnings in workspace';
          // Auto-hide the green badge after 4 s so it doesn\u2019t clutter the header permanently
          setTimeout(function () {
            if (diagBadge.classList.contains('clean')) { diagBadge.style.display = 'none'; }
          }, 4000);
        }
        break;
      }
      case 'resumeOffer': {
        var rSummary = data.summary || 'previous task';
        resumeOfferText.innerHTML = '⚡ Session was interrupted — resume <strong>' + esc(rSummary.slice(0, 60)) + (rSummary.length > 60 ? '…' : '') + '</strong>?';
        resumeOffer.classList.add('visible');
        break;
      }
      case 'proactiveOffer': {
        // errorCount === 0 means "dismiss"
        if (!data.errorCount) {
          proactiveOffer.classList.remove('visible');
          _proactiveOfferFile = '';
        } else {
          _proactiveOfferFile = data.filename;
          var fname = data.filename.split('/').pop();
          var errLabel = data.errorCount + ' error' + (data.errorCount !== 1 ? 's' : '');
          var warnLabel = data.warningCount > 0 ? ' \u00b7 ' + data.warningCount + ' warning' + (data.warningCount !== 1 ? 's' : '') : '';
          proactiveText.innerHTML = 'I see <strong>' + errLabel + '</strong>' + warnLabel + ' in <strong>' + esc(fname) + '</strong> \u2014 want me to fix them?';
          proactiveOffer.classList.add('visible');
        }
        break;
      }
      case 'proposalQueued':
        // A single file was queued — subtle status (full panel arrives on proposalsReady)
        break;
      case 'proposalsReady':
        _showProposals(data.proposals);
        break;
      case 'proposalAccepted':
      case 'proposalRejected':
        _removeProposalRow(data.filepath);
        break;
      case 'allProposalsResolved':
        proposalsPanel.style.display = 'none';
        proposalsList.innerHTML = '';
        break;
      case 'followUps':
        _renderFollowUps(data.id, data.suggestions);
        break;
      case 'threadList':
        _renderThreadTabs(data.threads);
        break;
      case 'threadSearchResults':
        _renderSearchResults(data.query, data.results);
        break;
      case 'todoUpdate': {
        var msgWrap = document.getElementById('msg-' + data.id);
        if (!msgWrap) { break; }
        var aoEl = document.getElementById('ao-' + data.id);
        _buildOrUpdateTodoTracker('todo-tracker-' + data.id, aoEl, msgWrap, data.items, true);
        scrollBottom();
        break;
      }
      case 'threadLoaded':
        msgs.innerHTML = '';
        msgs.appendChild(welcome);
        curId = null;
        msgContents = {};
        _lastSentPayload = null;
        setStreaming(false);
        if (data.displayMessages && data.displayMessages.length > 0) {
          welcome.style.display = 'none';
          data.displayMessages.forEach(function(m) {
            if (m.role === 'user') {
              appendUserMsg(m.text, [], [], { id: m.id, at: m.at, editable: !!m.id && (m.plan !== undefined || m.prompt === undefined),
                editText: m.plan !== undefined ? m.plan : m.text });
            } else if (m.events && m.events.length > 0) {
              _replayAssistant(m.events, m.at);
            } else {
              var d = document.createElement('div');
              d.className = 'msg assistant';
              var lbl = document.createElement('div');
              lbl.className = 'msg-label';
              lbl.innerHTML = 'Codico Agent' + (m.at ? _timeHtml(m.at) : '');
              var out = document.createElement('div');
              out.className = 'agent-out';
              out.innerHTML = renderMd(m.text + (m.text.length >= 297 ? '\n\n*\u2026 (truncated)*' : ''));
              d.appendChild(lbl);
              d.appendChild(out);
              msgs.appendChild(d);
            }
          });
        } else {
          welcome.style.display = 'flex';
        }
        // An edited or regenerated message is being sent again: show it, its reply follows
        if (data.pendingUserText) {
          hideWelcome();
          appendUserMsg(data.pendingUserText, [], []);
          setStreaming(true);
        }
        _placeRegenerate();
        scrollBottom(true);
        break;
    }
  }

})();

(function () {
  'use strict';

  var FINISH_REASON_LABELS = {
    length: '⚠ Response cut off — model reached its output token limit.',
    content_filter: '⚠ Response stopped by content filter.',
    error: '⚠ Model returned an error and stopped early.',
  };

  function create(options) {
    function insertNotice(msgId, el) {
      var wrap = document.getElementById('msg-' + msgId);
      if (!wrap) { return false; }
      var copyBtn = document.getElementById('copy-' + msgId);
      if (copyBtn) { wrap.insertBefore(el, copyBtn); }
      else { wrap.appendChild(el); }
      options.scrollBottom();
      return true;
    }

    function showStreamFinishReason(msgId, reason) {
      var label = FINISH_REASON_LABELS[reason] || ('⚠ Stream ended: ' + reason);
      var el = document.createElement('div');
      el.className = 'stream-stop-notice warn';
      var txt = document.createElement('span');
      txt.textContent = label;
      el.appendChild(txt);

      if (reason === 'length') {
        var btn = document.createElement('button');
        btn.className = 'continue-btn';
        btn.textContent = '▶ Continue';
        btn.title = 'Ask the model to continue from where it left off';
        btn.addEventListener('click', function () {
          btn.disabled = true;
          btn.textContent = '…';
          options.sendMessage('Continue');
        });
        el.appendChild(btn);
      }

      insertNotice(msgId, el);
    }

    function showStreamInlineError(msgId, message) {
      var isCtxOverflow = /context.length|maximum context|context window|token.limit|too.long|exceed/i.test(message);
      var isInterrupted = /stream interrupted|stream transport error|automatic recovery failed/i.test(message);
      var el = document.createElement('div');
      el.className = 'stream-stop-notice ' + (isCtxOverflow ? 'warn' : 'err');

      var txt = document.createElement('span');
      txt.textContent = isCtxOverflow
        ? '⚠ Context limit reached — history is too long for the model.'
        : isInterrupted
          ? '⚠ Connection interrupted — Codico could not resume automatically.'
          : '✕ Stream error: ' + message;
      el.appendChild(txt);

      if (isCtxOverflow) {
        var compactBtn = document.createElement('button');
        compactBtn.className = 'continue-btn';
        compactBtn.textContent = '↓↑ Compact & Continue';
        compactBtn.title = 'Summarize conversation history to free up context, then continue';
        compactBtn.addEventListener('click', function () {
          compactBtn.disabled = true;
          compactBtn.textContent = 'Compacting…';
          options.compactAndContinue();
        });
        el.appendChild(compactBtn);
      } else if (isInterrupted) {
        var retryBtn = document.createElement('button');
        retryBtn.className = 'continue-btn';
        retryBtn.textContent = '▶ Continue';
        retryBtn.title = 'Continue from the partial response';
        retryBtn.addEventListener('click', function () {
          retryBtn.disabled = true;
          retryBtn.textContent = '…';
          options.sendMessage('Continue exactly from where you stopped.');
        });
        el.appendChild(retryBtn);
      }

      insertNotice(msgId, el);
    }

    return {
      showStreamFinishReason: showStreamFinishReason,
      showStreamInlineError: showStreamInlineError,
    };
  }

  var api = { create: create };
  if (typeof window !== 'undefined') { window.CodicoStreamNotices = api; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();

(function () {
  'use strict';

  var TOOL_FENCE_RE = /`{3,}(?:write_file|read_file|list_directory|run_terminal|search_files|find_files|edit_file|get_diagnostics|fetch_url|browser_navigate|browser_click|browser_type|browser_get_text|browser_screenshot|browser_close|mcp_call|lsp_symbol|debug_get_variables|debug_get_callstack|debug_list_breakpoints|update_todo)[\s\S]*/g;

  var TOOL_LANGS = {
    write_file:1, read_file:1, list_directory:1, run_terminal:1,
    search_files:1, find_files:1, edit_file:1, get_diagnostics:1, fetch_url:1,
    browser_navigate:1, browser_click:1, browser_type:1, browser_get_text:1,
    browser_screenshot:1, browser_close:1, mcp_call:1, lsp_symbol:1,
    debug_get_variables:1, debug_get_callstack:1, debug_list_breakpoints:1, update_todo:1
  };

  function esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function inline(text) {
    var s = esc(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    return s;
  }

  function renderMd(raw) {
    if (!raw) { return ''; }
    raw = raw.replace(TOOL_FENCE_RE, '');
    var lines = raw.replace(/\n{3,}/g, '\n\n').split('\n');
    var out = '';
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];
      var fenceMatch = /^(`{3,})(.*)$/.exec(line);
      if (fenceMatch) {
        var fence = fenceMatch[1];
        var lang = fenceMatch[2].trim();
        var codeLines = [];
        i++;
        var closedFence = false;
        while (i < lines.length) {
          if (lines[i].slice(0, fence.length) === fence) {
            closedFence = true;
            i++;
            break;
          }
          codeLines.push(lines[i]);
          i++;
        }
        if (!closedFence) { continue; }

        if (!TOOL_LANGS[lang]) {
          var code = codeLines.join('\n');
          var escapedCode = esc(code);
          var langLabel = lang || 'plaintext';
          var la = lang ? ' class="language-' + esc(lang) + '"' : '';
          out += '<div class="code-wrap">'
            + '<div class="code-lang-bar"><span>' + esc(langLabel) + '</span><button data-code="' + escapedCode + '">Copy</button></div>'
            + '<pre><code' + la + '>' + escapedCode + '</code></pre>'
            + '</div>';
        }
        continue;
      }

      if (line.slice(0, 4) === '### ') { out += '<h3>' + inline(line.slice(4)) + '</h3>'; i++; continue; }
      if (line.slice(0, 3) === '## ') { out += '<h2>' + inline(line.slice(3)) + '</h2>'; i++; continue; }
      if (line.slice(0, 2) === '# ')  { out += '<h1>' + inline(line.slice(2)) + '</h1>'; i++; continue; }
      if (line.slice(0, 2) === '> ')  { out += '<blockquote>' + inline(line.slice(2)) + '</blockquote>'; i++; continue; }
      if (/^-{3,}$/.test(line.trim())) { out += '<hr>'; i++; continue; }

      if (/^\s*[-*+] /.test(line)) {
        out += '<ul>';
        while (i < lines.length && /^\s*[-*+] /.test(lines[i])) {
          out += '<li>' + inline(lines[i].replace(/^\s*[-*+] /, '')) + '</li>';
          i++;
        }
        out += '</ul>';
        continue;
      }

      if (/^\s*\d+\.\s/.test(line)) {
        out += '<ol>';
        while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
          out += '<li>' + inline(lines[i].replace(/^\s*\d+\.\s/, '')) + '</li>';
          i++;
        }
        out += '</ol>';
        continue;
      }

      if (line.trim() === '') {
        if (out && !/(<\/(?:p|h[1-6]|ul|ol|li|blockquote|pre|hr|div)>|<br>)\s*$/.test(out)) {
          out += '<br>';
        }
        i++;
        continue;
      }

      out += '<p>' + inline(line) + '</p>';
      i++;
    }

    return out;
  }

  window.CodicoMarkdown = { renderMd: renderMd };
})();

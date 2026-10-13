const test = require('node:test');
const assert = require('node:assert/strict');
const { searchRequest, parseDuckDuckGo, duckDuckGoRefused, parseBrave, renderResults, engineName, MAX_RESULTS } = require('../out/webSearch.js');
const { parseToolBody } = require('../out/toolParser.js');
const { getNativeToolDefinitions, nativeToolCallToToolCall } = require('../out/nativeTools.js');
const { SUBAGENT_TOOLS } = require('../out/subagent.js');

// The markup of DuckDuckGo's no-script results page, as fetched
const ddgResult = (target, title, snippet) => `
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&amp;rut=a3f4ab06">${title}</a>
    </h2>
    <div class="result__extras"><div class="result__extras__url">
      <a class="result__url" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&amp;rut=a3f4ab06"> ${target.replace(/^https?:\/\//, '')} </a>
    </div></div>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&amp;rut=a3f4ab06">${snippet}</a>
  </div>
</div>`;

test('the request: the query is encoded, trimmed and bounded; a key goes in a header, never in the address', () => {
  const ddg = searchRequest('duckduckgo', '  vscode   webview "postMessage" & csp?  ');
  assert.equal(ddg.url, 'https://html.duckduckgo.com/html/?q=vscode%20webview%20%22postMessage%22%20%26%20csp%3F');
  assert.deepEqual(ddg.headers, {});
  const brave = searchRequest('brave', 'rust borrow checker', 'SECRET-KEY');
  assert.equal(brave.url, 'https://api.search.brave.com/res/v1/web/search?q=rust%20borrow%20checker&count=8');
  assert.equal(brave.headers['X-Subscription-Token'], 'SECRET-KEY');
  assert.doesNotMatch(brave.url, /SECRET-KEY/);
  assert.ok(searchRequest('duckduckgo', 'x'.repeat(5000)).url.length < 500);
  assert.deepEqual([engineName('duckduckgo'), engineName('brave')], ['DuckDuckGo', 'Brave Search']);
});

test('DuckDuckGo results: the real address behind its redirect, the title and the text, in order', () => {
  const html = '<html><body>' +
    ddgResult('https://code.visualstudio.com/api/extension-guides/webview', 'Webview API | Visual <b>Studio</b> Code', 'The <b>webview</b> API lets extensions&nbsp;create custom views &amp; more.') +
    ddgResult('https://stackoverflow.com/questions/72698819/how-to-post?a=1&b=2', 'How to post message from VSCode extension &#x27;custom&#x27; webview', 'I am building a <b>VSCode</b> extension…') +
    '</body></html>';
  assert.deepEqual(parseDuckDuckGo(html), [
    { title: 'Webview API | Visual Studio Code', url: 'https://code.visualstudio.com/api/extension-guides/webview', snippet: 'The webview API lets extensions create custom views & more.' },
    { title: "How to post message from VSCode extension 'custom' webview", url: 'https://stackoverflow.com/questions/72698819/how-to-post?a=1&b=2', snippet: 'I am building a VSCode extension…' },
  ]);
  assert.deepEqual(parseDuckDuckGo('<html><body>No results.</body></html>'), []);
  assert.deepEqual(parseDuckDuckGo(''), []);
});

test('what is not a result is left out: advertisements, repeats, other schemes, and more than the limit', () => {
  const ad = '<div class="result result--ad"><h2><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.example&amp;u3=x">Buy now</a></h2><a class="result__snippet">Sponsored</a></div>';
  const script = '<a class="result__a" href="//duckduckgo.com/l/?uddg=' + encodeURIComponent('javascript:alert(1)') + '">Click</a>';
  const file = '<a class="result__a" href="//duckduckgo.com/l/?uddg=' + encodeURIComponent('file:///etc/passwd') + '">Local</a>';
  const good = ddgResult('https://example.org/a', 'A', 'first');
  const html = ad + script + file + good + good + ddgResult('https://example.org/b', 'B', '');
  assert.deepEqual(parseDuckDuckGo(html).map(r => [r.title, r.url, r.snippet]), [['A', 'https://example.org/a', 'first'], ['B', 'https://example.org/b', '']]);
  // A snippet belongs to its own result, not to the next one
  const noSnippetThenSnippet = '<a class="result__a" href="https://example.org/x">X</a>' + ddgResult('https://example.org/y', 'Y', 'text of Y');
  assert.deepEqual(parseDuckDuckGo(noSnippetThenSnippet).map(r => r.snippet), ['', 'text of Y']);
  const many = Array.from({ length: 30 }, (_, i) => ddgResult(`https://example.org/${i}`, 'T' + i, 's')).join('');
  assert.equal(parseDuckDuckGo(many).length, MAX_RESULTS);
  assert.ok(parseDuckDuckGo(ddgResult('https://example.org/long', 'L', 'w '.repeat(1000)))[0].snippet.length <= 300);
});

test('a page that is DuckDuckGo declining the request is recognised, so it is not read as "no results"', () => {
  assert.equal(duckDuckGoRefused('<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div><form id="challenge-form">'), true);
  assert.equal(duckDuckGoRefused(ddgResult('https://example.org/a', 'A', 'a page about unusual things')), false);
});

test('Brave results: from its JSON, with the same care about addresses', () => {
  const body = JSON.stringify({ web: { results: [
    { title: 'Rust <strong>Borrow</strong> Checker', url: 'https://doc.rust-lang.org/book/ch04-02.html', description: 'References &amp; <strong>borrowing</strong>.' },
    { title: 'Bad', url: 'javascript:alert(1)', description: 'x' },
    { title: '', url: 'https://example.org/untitled' },
    { title: 'No text', url: 'https://example.org/n' },
  ] } });
  assert.deepEqual(parseBrave(body), [
    { title: 'Rust Borrow Checker', url: 'https://doc.rust-lang.org/book/ch04-02.html', snippet: 'References & borrowing.' },
    { title: 'No text', url: 'https://example.org/n', snippet: '' },
  ]);
  for (const bad of ['', 'not json', '{}', '{"web":{}}', '{"web":{"results":"x"}}', 'null']) { assert.deepEqual(parseBrave(bad), [], bad); }
});

test('what the agent reads: numbered results and the reminder that these are not the pages themselves', () => {
  const text = renderResults([{ title: 'A', url: 'https://example.org/a', snippet: 'about a' }, { title: 'B', url: 'https://example.org/b', snippet: '' }]);
  assert.equal(text, '1. A\n   https://example.org/a\n   about a\n2. B\n   https://example.org/b\n\nThese are search results, not the pages: read one with fetch_url before relying on what it says.');
  assert.equal(renderResults([]), 'No results. Try other words, or fewer of them.');
});

test('the tool is known in both formats, allowed in Ask mode, and not given to subagents', () => {
  assert.deepEqual(parseToolBody('web_search', 'query: vscode webview csp nonce'), [{ type: 'web_search', query: 'vscode webview csp nonce' }]);
  assert.deepEqual(parseToolBody('web_search', 'url: https://example.org'), [], 'a search needs a query');
  assert.deepEqual(nativeToolCallToToolCall({ id: 'c', name: 'web_search', arguments: { query: 'x y' } }), { type: 'web_search', query: 'x y' });
  assert.equal(nativeToolCallToToolCall({ id: 'c', name: 'web_search', arguments: {} }), null);
  const names = (readOnly) => getNativeToolDefinitions(readOnly).map(t => t.name);
  assert.ok(names(false).includes('web_search') && names(true).includes('web_search'));
  assert.equal(SUBAGENT_TOOLS.has('web_search'), false);
});

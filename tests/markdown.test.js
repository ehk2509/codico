const test = require('node:test');
const assert = require('node:assert/strict');

const { renderMd } = require('../media/markdown.js');

test('renderer strips tool fences from visible assistant text', () => {
  const html = renderMd('Before\n\n\`\`\`read_file\nfilepath: secret.ts\n\`\`\`\nAfter');
  assert.match(html, /Before/);
  assert.equal(html.includes('secret.ts'), false);
});

test('renderer keeps normal code fences and escapes HTML', () => {
  const html = renderMd('### Example\n\n\`\`\`js\nconst x = "<tag>";\n\`\`\`');
  assert.match(html, /<h3>Example<\/h3>/);
  assert.match(html, /language-js/);
  assert.match(html, /&lt;tag&gt;/);
});

test('long code blocks start collapsed with a toggle; short ones do not', () => {
  const long = renderMd('```js\n' + Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n') + '\n```');
  assert.match(long, /class="code-wrap collapsible collapsed"/);
  assert.match(long, /js · 30 lines<\/span><button class="code-toggle"/);
  assert.match(long, /line29/, 'the whole code is still there');
  assert.doesNotMatch(long, /<script/, 'no inline script (the panel handles the toggle)');
  const short = renderMd('```js\nx = 1\n```');
  assert.match(short, /class="code-wrap">/);
  assert.match(short, /js · 1 line<\/span>/);
  assert.doesNotMatch(short, /code-toggle/);
});

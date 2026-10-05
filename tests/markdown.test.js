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

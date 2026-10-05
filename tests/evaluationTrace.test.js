const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluationToolTarget } = require('../out/evaluationTrace.js');

test('evaluation tool labels preserve routing context without edit bodies', () => {
  assert.equal(evaluationToolTarget({ type: 'read_file', filepath: 'src/a.ts' }), 'src/a.ts');
  assert.equal(
    evaluationToolTarget({ type: 'edit_file', filepath: 'src/a.ts', oldStr: 'SECRET OLD BODY', newStr: 'SECRET NEW BODY' }),
    'src/a.ts',
  );
  assert.equal(evaluationToolTarget({ type: 'browser_type', selector: '#password', text: 'super-secret' }), '#password');
});

/**
 * Checks a holdout suite for tasks no agent can pass without guessing: the hidden verifier
 * imports a function that neither exists at the task's base nor is named in its prompt.
 *
 *   node scripts/eval/suiteCheck.js [eval/tasks.json]
 *
 * Needs the repository's history (the base commits and the verifiers' commits).
 */
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const show = (commit, file) => {
  const r = cp.spawnSync('git', ['show', `${commit}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};

/** The verifier's source: a file in eval/verifiers, or the test file at the verifier's commit. */
function verifierSource(task) {
  return task.verifierPath ? fs.readFileSync(path.join(root, task.verifierPath), 'utf8') : show(task.verifierCommit, `tests/${task.verifierFile}`);
}

/** The file's header (before its first test) and the tests the task runs. */
function selectedSource(source, testNamePattern) {
  const pattern = new RegExp(testNamePattern);
  const [header, ...tests] = source.split(/^(?=test\()/m);
  const chosen = tests.filter(block => {
    const m = /^test\(\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(block);
    return m && pattern.test(m[2].replace(/\\(.)/g, '$1'));
  });
  return { header, body: chosen.join('') || source };
}

/** Names the task's tests import from the project that its base lacks and its prompt does not name. */
function unguessableNames(task) {
  const source = verifierSource(task);
  if (source === null) { return null; }
  const { header, body } = selectedSource(source, task.testNamePattern);
  const missing = new Set();
  const imports = /(?:\/\* )?(?:const|let)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]\.\.\/(out|media)\/([\w./-]+?)(?:\.js)?['"]\s*\)/g;
  // A function reached as a property of the required module (require('../out/x.js').name), as destructuring would
  const text = (header + body).replace(/require\(\s*(['"])\.\.\/(out|media)\/([\w./-]+?)(?:\.js)?\1\s*\)\.(\w+)/g, (all, q, dir, mod, name) => `${all}\n/* const { ${name} } = require('../${dir}/${mod}.js') */`);
  // (the marker comment makes the import pattern below match from '/*')
  let m;
  while ((m = imports.exec(text)) !== null) {
    const base = show(task.baseCommit, m[2] === 'out' ? `src/${m[3]}.ts` : `media/${m[3]}.js`);
    for (const name of m[1].split(',').map(n => n.split(':')[0].trim()).filter(Boolean)) {
      // Loaded by name from the module (require(...).name) counts as used, even inside a helper the tests call
      const used = m[0].startsWith('/*') || new RegExp(`\\b${name}\\b`).test(body);
      const atBase = base !== null && new RegExp(`\\b${name}\\b`).test(base);
      if (used && !atBase && !task.prompt.includes(name)) { missing.add(`${m[3]}.${name}`); }
      // Options passed to it as an object ({ maxCurrentReadChars: 60_000 }): a key the base lacks must be named too
      for (const call of body.matchAll(new RegExp(`\\b${name}\\(([^;()]*)\\)`, 'g'))) {
        for (const key of [...call[1].matchAll(/[{,]\s*([a-z][A-Za-z0-9]{3,})\s*:/g)].map(k => k[1])) {
          if (base !== null && !new RegExp(`\\b${key}\\b`).test(base) && !task.prompt.includes(key)) { missing.add(`${m[3]}.${name}({ ${key} })`); }
        }
      }
    }
  }
  return [...missing];
}

if (require.main === module) {
  const suite = JSON.parse(fs.readFileSync(path.resolve(process.argv[2] || path.join(root, 'eval', 'tasks.json')), 'utf8'));
  let problems = 0;
  for (const task of suite.tasks) {
    const names = unguessableNames(task);
    if (names === null) { console.log(`${task.id}: verifier not found (is the history fetched?)`); problems++; }
    else if (names.length) { console.log(`${task.id}: the verifier needs ${names.join(', ')}, which the base lacks and the prompt does not name`); problems++; }
  }
  console.log(problems ? `${problems} task(s) need attention` : `All ${suite.tasks.length} tasks: every name the verifiers import exists at the base or is named in the prompt.`);
  process.exitCode = problems ? 1 : 0;
}

module.exports = { unguessableNames, selectedSource };

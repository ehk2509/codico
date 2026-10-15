const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const R = require('../out/repositories.js');
const { integrate, publish, linkedBody, describe } = require('../out/crossRepo.js');
const { GitHubEvents } = require('../out/githubEvents.js');
const { createWorktree } = require('../out/backgroundGit.js');
const { TeamService } = require('../out/teamService.js');
const { BackgroundTaskStore } = require('../out/backgroundTaskStore.js');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codico-xrepo-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const sh = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test('manifests: what each repository publishes and uses (npm with workspaces, Go, Python), and the order changes go in', () => {
  const dir = path.join(root, 'manifests');
  write(path.join(dir, 'sdk/package.json'), JSON.stringify({ name: '@acme/sdk', dependencies: { zod: '^3' } }));
  write(path.join(dir, 'web/package.json'), JSON.stringify({ name: 'web', private: true, workspaces: ['packages/*'] }));
  write(path.join(dir, 'web/packages/ui/package.json'), JSON.stringify({ name: '@acme/ui', dependencies: { '@acme/sdk': 'workspace:*' } }));
  write(path.join(dir, 'api/go.mod'), 'module github.com/acme/api\n\ngo 1.22\n\nrequire (\n\tgithub.com/acme/gosdk v1.4.0\n\tgithub.com/x/y v0.1.0\n)\n');
  write(path.join(dir, 'gosdk/go.mod'), 'module github.com/acme/gosdk\n\ngo 1.22\n');
  write(path.join(dir, 'ml/pyproject.toml'), '[project]\nname = "acme_ml"\ndependencies = [\n  "acme-sdk-py>=1.0",\n  "numpy",\n]\n');
  write(path.join(dir, 'pysdk/pyproject.toml'), '[project]\nname = "acme-sdk-py"\n');
  assert.deepEqual(R.readManifests(path.join(dir, 'web')), { provides: ['web', '@acme/ui'], uses: ['@acme/sdk'] });
  assert.deepEqual(R.readManifests(path.join(dir, 'api')).uses, ['github.com/acme/gosdk', 'github.com/x/y']);
  assert.deepEqual(R.readManifests(path.join(dir, 'ml')), { provides: ['acme-ml'], uses: ['acme-sdk-py', 'numpy'] });
  const repos = describe(R.nameRepositories(['web', 'sdk', 'api', 'gosdk', 'ml', 'pysdk'].map(n => path.join(dir, n))));
  const order = R.dependencyOrder(repos);
  const before = (a, b) => order.order.indexOf(a) < order.order.indexOf(b);
  assert.ok(before('sdk', 'web') && before('gosdk', 'api') && before('pysdk', 'ml'), order.order.join(' '));
  assert.deepEqual(order.edges.find(e => e.from === 'web'), { from: 'web', to: 'sdk', via: '@acme/sdk' });
  assert.equal(order.cycle, undefined);
  const circle = R.dependencyOrder([{ name: 'a', root: 'a', provides: ['a'], uses: ['b'] }, { name: 'b', root: 'b', provides: ['b'], uses: ['a'] }, { name: 'c', root: 'c', provides: [], uses: [] }]);
  assert.deepEqual([circle.order, circle.cycle], [['c', 'a', 'b'], ['a', 'b']]);
  assert.deepEqual(R.nameRepositories(['/x/api', '/y/API', '/x/api']).map(r => r.name), ['api', 'api-2']);
  assert.match(R.repositoriesSection(repos.slice(0, 2), R.dependencyOrder(repos.slice(0, 2))), /\[Repositories\][\s\S]*- web: [\s\S]*Dependency order \(a dependency first\): sdk → web — because web uses @acme\/sdk \(from sdk\)/);
  assert.equal(R.repositoriesSection(repos.slice(0, 1), R.dependencyOrder(repos.slice(0, 1))), '');
});

/** Two repositories side by side (sdk, app) with GitHub remotes reached through local bare repositories. */
function workspace(name) {
  const dir = path.join(root, name); fs.mkdirSync(dir);
  const repos = {};
  for (const repo of ['sdk', 'app']) {
    const r = path.join(dir, repo); const bare = path.join(dir, `${repo}.git`);
    sh(dir, 'init', '-q', '--bare', '-b', 'main', bare);
    fs.mkdirSync(r); sh(r, 'init', '-q', '-b', 'main'); sh(r, 'config', 'user.email', 't@example.com'); sh(r, 'config', 'user.name', 'T'); sh(r, 'config', 'core.autocrlf', 'false');
    sh(r, 'remote', 'add', 'origin', `https://github.com/acme/${repo}.git`); sh(r, 'config', `url.${bare}.insteadOf`, `https://github.com/acme/${repo}.git`);
    repos[repo] = { name: repo, root: r, bare };
  }
  write(path.join(repos.sdk.root, 'package.json'), JSON.stringify({ name: '@acme/sdk' }));
  write(path.join(repos.sdk.root, 'lib.js'), 'module.exports = { version: 1 };\n');
  write(path.join(repos.app.root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@acme/sdk': 'file:../sdk' } }));
  write(path.join(repos.app.root, 'test.js'), "const sdk = require('../sdk/lib.js'); const app = require('./app.js'); if (sdk.version !== 2 || app.uses !== 2) { console.error('FAIL', sdk.version, app.uses); process.exit(1); } console.log('INTEGRATED-OK');\n");
  write(path.join(repos.app.root, 'app.js'), 'module.exports = { uses: 1 };\n');
  for (const repo of Object.values(repos)) { sh(repo.root, 'add', '-A'); sh(repo.root, 'commit', '-q', '-m', 'start'); sh(repo.root, 'push', '-q', 'origin', 'main'); }
  return { dir, repos, list: [repos.app, repos.sdk].map(({ name, root }) => ({ name, root })) };
}

/** A worker of the team: a branch and worktree in a repository, with its changes made. */
async function worker(repo, name, files) {
  const id = crypto.randomBytes(8).toString('hex');
  const worktree = path.join(root, `wt-${name}-${id.slice(0, 6)}`); const branch = `codico/${name}-${id.slice(0, 6)}`;
  const made = await createWorktree(repo.root, worktree, branch);
  for (const [file, text] of Object.entries(files)) { write(path.join(worktree, file), text); }
  return { id, prompt: `Change ${repo.name}`, repoRoot: repo.root, worktree, branch, baseCommit: made.baseCommit, permissions: 'edits', status: 'finished', createdAt: Date.now(), updatedAt: Date.now(), name, team: 't', report: `Changed ${repo.name}.` };
}

const run = (command, cwd) => new Promise(resolve => cp.exec(command, { cwd }, (error, stdout, stderr) => resolve({ exitCode: error ? error.code ?? 1 : 0, output: stdout + stderr })));

test('integrate: every repository side by side, each with its workers\' branches merged, and the integrated test run there', async () => {
  const w = workspace('integrate');
  const sdk = await worker(w.repos.sdk, 'sdk', { 'lib.js': 'module.exports = { version: 2 };\n' });
  const app = await worker(w.repos.app, 'app', { 'app.js': 'module.exports = { uses: 2 };\n' });
  const folder = path.join(root, 'integration-1');
  const commands = [];
  const call = { signal: new AbortController().signal, runCommand: async (command, cwd) => { commands.push(cwd); return run(command, cwd); } };
  // Only the app's worker: the test fails, since the SDK it needs is not changed
  const half = await integrate({ repos: w.list, workers: [app], folder, command: 'node test.js', runIn: 'app' }, call);
  assert.match(half, /^Integrated test FAILED \(exit 1\)[\s\S]*app: with app[\s\S]*sdk: as it is \(no worker in it\)[\s\S]*FAIL 1 2/);
  // Both: it passes, and was run in the app's folder of the integration, next to the SDK's
  const both = await integrate({ repos: w.list, workers: [app, sdk], folder, command: 'node test.js', runIn: 'app' }, call);
  assert.match(both, /^Integrated test PASSED: `node test\.js` in app[\s\S]*app: with app[\s\S]*sdk: with sdk[\s\S]*INTEGRATED-OK/);
  assert.equal(commands.at(-1), path.join(folder, 'app'));
  assert.equal(sh(w.repos.app.root, 'status', '--porcelain'), '', 'the repositories themselves are not touched');
  // Two workers in one repository that conflict: the second is left out, and said
  const other = await worker(w.repos.sdk, 'sdk2', { 'lib.js': 'module.exports = { version: 3 };\n' });
  const conflict = await integrate({ repos: w.list, workers: [app, sdk, other], folder, command: 'node test.js', runIn: 'app' }, call);
  assert.match(conflict, /✗ sdk: worker sdk2 \([0-9a-f]{8}\)'s branch conflicts with the other workers' \(sdk \([0-9a-f]{8}\)\); it is left out/);
  assert.match(await integrate({ repos: w.list, workers: [], folder, command: 'x', runIn: 'nope' }, call), /no repository "nope"/);
});

function fakeGitHub() {
  const state = { created: [], patched: [], requests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      state.requests.push(`${req.method} ${req.url}`);
      const json = (v, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
      let m;
      if ((m = /^\/repos\/acme\/(\w+)$/.exec(req.url))) { return json({ default_branch: 'main' }); }
      if ((m = /^\/repos\/acme\/(\w+)\/pulls$/.exec(req.url)) && req.method === 'POST') { const number = 100 + state.created.length; state.created.push({ repo: m[1], number, ...JSON.parse(body) }); return json({ number, html_url: `https://github.com/acme/${m[1]}/pull/${number}` }, 201); }
      if ((m = /^\/repos\/acme\/(\w+)\/pulls\/(\d+)$/.exec(req.url)) && req.method === 'PATCH') { state.patched.push({ repo: m[1], number: Number(m[2]), ...JSON.parse(body) }); return json({}); }
      json({ message: 'Not Found' }, 404);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, api: { protocol: 'http:', host: '127.0.0.1', port: server.address().port } })));
}

test('publish: each repository\'s branch pushed and a draft pull request opened, a dependency first, each linked to the others', async () => {
  const w = workspace('publish');
  const gh = await fakeGitHub(); test.after(() => gh.server.close());
  const sdk = await worker(w.repos.sdk, 'sdk', { 'lib.js': 'module.exports = { version: 2 };\n' });
  const app = await worker(w.repos.app, 'app', { 'app.js': 'module.exports = { uses: 2 };\n' });
  let asked = '';
  const call = (answer) => ({ signal: new AbortController().signal, runCommand: async () => ({ exitCode: 0, output: '' }),
    github: async rootDir => new GitHubEvents(gh.api, 'T', { owner: 'acme', repo: path.basename(rootDir) }), approvePublish: async plan => { asked = plan; return answer; } });
  // Declined: nothing pushed or opened
  assert.equal(await publish({ repos: w.list, workers: [app, sdk] }, call(false)), 'The user declined publishing. Nothing was pushed.');
  assert.match(asked, /^Push 2 branches and open 2 linked draft pull requests, in this order:\n1\. acme\/sdk: push codico\/sdk-[\s\S]*2\. acme\/app: push codico\/app-/);
  assert.equal(gh.state.created.length, 0);
  assert.throws(() => sh(w.repos.sdk.bare, 'rev-parse', '--verify', sdk.branch));
  // Agreed: the SDK first (the app uses it), both pushed, both linked
  const out = await publish({ repos: w.list, workers: [app, sdk] }, call(true));
  assert.match(out, /^Opened 2 linked draft pull requests, to be merged in this order:\n1\. https:\/\/github\.com\/acme\/sdk\/pull\/100 \(sdk\)\n2\. https:\/\/github\.com\/acme\/app\/pull\/101 \(app\)$/);
  assert.deepEqual(gh.state.created.map(c => [c.repo, c.head, c.base, c.draft]), [['sdk', sdk.branch, 'main', true], ['app', app.branch, 'main', true]]);
  assert.equal(sh(w.repos.sdk.bare, 'show', `${sdk.branch}:lib.js`), 'module.exports = { version: 2 };\n');
  const sdkBody = gh.state.patched.find(p => p.repo === 'sdk').body; const appBody = gh.state.patched.find(p => p.repo === 'app').body;
  assert.match(sdkBody, /^Part of one change across 2 repositories\. Merge them in this order:\n\n1\. acme\/sdk#100 \(sdk\) — this pull request\n2\. acme\/app#101 \(app\)\n\n\*\*Merge this one first\*\*/);
  assert.match(appBody, /2\. acme\/app#101 \(app\) — this pull request\n\n\*\*Depends on\*\* acme\/sdk#100: merge it first\.[\s\S]*Changed app\./);
  // One worker per repository
  const extra = await worker(w.repos.sdk, 'sdk2', { 'x.js': '1' });
  assert.match(await publish({ repos: w.list, workers: [sdk, extra] }, call(true)), /one worker per repository can be published; sdk has sdk/);
  assert.match(linkedBody({ repo: 'a/x', number: 1 }, [{ repo: 'a/x', number: 1, name: 'x' }], ''), /Merge this one first/);
});

test('a team worker starts in the repository named, and is merged into it', async () => {
  const w = workspace('team');
  const store = new BackgroundTaskStore(path.join(root, 'team-store'));
  const created = [];
  const service = new TeamService({
    store, settings: () => ({ maxWorkers: 3, permissions: 'edits' }), launch: async () => undefined,
    repositories: async () => w.list, integrationFolder: () => path.join(root, 'team-integration'),
    async createTask(options) {
      created.push(options);
      const t = await worker({ name: 'x', root: options.repoRoot ?? w.repos.app.root }, options.name ?? 'w', {});
      const task = { ...t, team: options.team, role: options.role, name: options.name, status: 'starting' };
      await store.save(task); return task;
    },
  });
  const call = { team: 'thread', repoRoot: w.repos.app.root, signal: new AbortController().signal, approveMerge: async () => true, review: async () => '' };
  assert.match(await service.run({ type: 'team', action: 'start', repo: 'sdk', name: 'sdk', text: 'Add v2' }, call), /Started worker sdk/);
  assert.equal(created[0].repoRoot, w.repos.sdk.root);
  assert.match(await service.run({ type: 'team', action: 'start', repo: 'frontend', text: 'x' }, call), /no repository "frontend"\. The repositories: app, sdk/);
  // Merged into its own repository, not the workspace's
  const [task] = await service.workers('thread');
  write(path.join(task.worktree, 'lib.js'), 'module.exports = { version: 2 };\n');
  await store.update(task.id, { status: 'finished' });
  assert.match(await service.run({ type: 'team', action: 'merge', worker: 'sdk' }, call), new RegExp(`into ${w.repos.sdk.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(fs.readFileSync(path.join(w.repos.sdk.root, 'lib.js'), 'utf8'), 'module.exports = { version: 2 };\n');
  assert.match(await service.repositoriesSection(), /sdk → app — because app uses @acme\/sdk \(from sdk\)/);
});

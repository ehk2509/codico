const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const vscode = require('vscode');
const PORT = process.env.LIVE_PORT, OUT = process.env.LIVE_OUT;
const getLog = () => new Promise((res, rej) => http.get(`http://127.0.0.1:${PORT}/log`, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
async function run() {
  const results = [];
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const read = p => { try { return fs.readFileSync(path.join(ws, p), 'utf8'); } catch { return null; } };
  await vscode.extensions.getExtension('codico.codico').activate();
  const cfg = vscode.workspace.getConfiguration('codico');
  const set = (k, v) => cfg.update(k, v, vscode.ConfigurationTarget.Global);
  for (const [k, v] of Object.entries({ model: 'ollama/fake-model', ollamaBaseUrl: `http://127.0.0.1:${PORT}`, checkpointSteps: 0,
    maxIterations: 12, followUpSuggestionsEnabled: false, completionNotificationsEnabled: false, responseSummaryEnabled: false,
    autoIndex: false, terminalTimeoutSeconds: 10 })) { await set(k, v); }
  await vscode.commands.executeCommand('codico.openChat');
  await new Promise(r => setTimeout(r, 1500));
  const all = (reqs) => reqs.map(r => r.lastUser).join('\n=====\n');
  const scenario = async (name, check, limitMs = 60000) => {
    const before = (await getLog()).length; const t0 = Date.now(); let error = null;
    try {
      await Promise.race([
        vscode.commands.executeCommand('codico.__evalRunTask', `[SCENARIO:${name}] please do the task`),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${limitMs / 1000} s`)), limitMs)),
      ]);
    } catch (e) { error = String(e && e.message || e); }
    const ms = Date.now() - t0;
    const reqs = (await getLog()).slice(before).filter(e => e.scenario === name && e.stream);
    let verdict;
    try { verdict = check({ ms, reqs, read, text: all(reqs), error }); } catch (e) { verdict = { ok: false, why: 'check threw: ' + e.message }; }
    if (error && verdict.ok && !verdict.allowError) { verdict = { ok: false, why: 'task error: ' + error + ' | ' + verdict.why }; }
    results.push({ name, ms, requests: reqs.length, ok: verdict.ok, why: verdict.why });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  };
  const has = (t, re) => re.test(t);

  await scenario('readme', ({ read, reqs }) => { const g = read('live/README.md'); return { ok: g !== null && g.trimEnd() === '# Demo\n\n## Run\n\n```bash\nnpm start\n```\n\nEnd of file.' && reqs.length === 2, why: `${g === null ? 'not written' : JSON.stringify(g.slice(0, 80))}; ${reqs.length} req (docs need no verification)` }; });
  await scenario('background', ({ ms, text }) => ({ ok: ms < 20000 && /started/.test(text), why: `${ms} ms; output reached model: ${/started/.test(text)}` }));
  await scenario('clarify', ({ reqs }) => ({ ok: reqs.length === 1, why: `${reqs.length} request(s)` }));
  await scenario('announce', ({ text }) => ({ ok: has(text, /announced an action/) && has(text, /port=80/), why: `nudge: ${has(text, /announced an action/)}; file content reached model: ${has(text, /port=80/)}` }));
  await scenario('cutoff', ({ reqs, text }) => ({ ok: has(text, /\[System Recovery\]/) && reqs.length === 2, why: `recovery: ${has(text, /\[System Recovery\]/)}; ${reqs.length} req` }));
  await scenario('unclosed', ({ read, reqs }) => { const g = read('live/unclosed.txt'); return { ok: g !== null && g.trimEnd() === 'hello\nworld' && reqs.length < 10, why: `${g === null ? 'not written' : JSON.stringify(g)}; ${reqs.length} req` }; });
  await scenario('edit_missing', ({ read, text }) => { const g = read('fixtures/config.txt'); const err = /not found|no match|did not match|0 occurrences|could not find|not present/i.test(text); return { ok: err && g === 'host=localhost\nport=80\n', why: `error reported: ${err}; file unchanged: ${g === 'host=localhost\nport=80\n'}` }; });
  await scenario('edit_ok', ({ read }) => { const g = read('fixtures/config.txt'); return { ok: g === 'host=localhost\nport=8080\n', why: JSON.stringify(g) }; });
  await scenario('traversal', ({ text }) => { const outside = fs.existsSync(path.join(ws, '..', 'outside-LIVE.txt')); const blocked = /outside|denied|not allowed|blocked|escape|workspace/i.test(text.split('[write_file')[1] || ''); return { ok: !outside && blocked, why: `file created outside workspace: ${outside}; error reported: ${blocked}` }; });
  await scenario('ignored', ({ text }) => { const leaked = /SECRET-TOKEN-12345/.test(text); const blocked = /ignor|denied|blocked|not allowed|excluded/i.test(text.split('[read_file')[1] || ''); return { ok: !leaked && blocked, why: `secret leaked to model: ${leaked}; error reported: ${blocked}` }; });
  await scenario('fetch_local', ({ text }) => { const leaked = /"scenario"/.test(text); const blocked = /private|blocked|denied|not allowed|local|refus/i.test(text.split('[fetch_url')[1] || text); return { ok: !leaked && blocked, why: `local response leaked: ${leaked}; blocked message: ${blocked}` }; });
  await scenario('loop', ({ text }) => ({ ok: /You are in a loop/.test(text), why: `loop warning sent: ${/You are in a loop/.test(text)}` }));
  await scenario('timeout', ({ ms, text }) => ({ ok: ms >= 9000 && ms < 30000 && /timed out/i.test(text), why: `${ms} ms; reported timed out: ${/timed out/i.test(text)}` }), 45000);
  await scenario('bigoutput', ({ ms, text }) => ({ ok: ms < 20000 && /\n1\n2\n3\n/.test(text) && !/199999/.test(text), why: `${ms} ms; truncated: ${!/199999/.test(text)}` }));
  await scenario('plain_code', ({ reqs, read }) => ({ ok: read('live/keep-me.txt') !== null && reqs.length === 1, why: `keep-me.txt still exists: ${read('live/keep-me.txt') !== null}; ${reqs.length} req` }));
  await scenario('multitool', ({ text }) => ({ ok: /port=8080/.test(text) && /NOTES-MARKER/.test(text), why: `both results returned: ${/port=8080/.test(text) && /NOTES-MARKER/.test(text)}` }));
  await scenario('unicode', ({ read }) => { const g = read('live/unicode.txt'); return { ok: g !== null && g.trimEnd() === 'Café ☕ — naïve 日本語 🚀\nline2', why: JSON.stringify(g) }; });
  await scenario('disconnect', ({ reqs, text }) => ({ ok: /\[System Recovery\]/.test(text) && /network|interrupt/i.test(text) && reqs.length === 2, why: `recovery prompt: ${/\[System Recovery\]/.test(text)}; ${reqs.length} req` }));
  await scenario('http500', ({ ms }) => ({ ok: ms < 15000, allowError: true, why: `${ms} ms (must end, not hang)` }), 30000);
  await scenario('todo', ({ text }) => ({ ok: /Task list updated/i.test(text), why: `todo accepted (and agent usable after HTTP 500): ${/Task list updated/i.test(text)}` }));
  await scenario('verify_ok', ({ read, reqs, text }) => ({ ok: read('live/verified.js') !== null && /acceptance gate is satisfied/.test(text) && reqs.length <= 5, why: `gate satisfied: ${/acceptance gate is satisfied/.test(text)}; ${reqs.length} req` }));
  await scenario('stuck_verify', ({ reqs, error }) => ({ ok: !error && reqs.length <= 6, why: `${reqs.length} requests; turn ended on its own: ${!error} (model never verifies)` }), 30000);

  // Browser automation: playwright-core is loaded lazily on first use; page text must
  // reach the model wrapped as untrusted content
  await set('browserAllowPrivateNetwork', true);
  await scenario('browser', ({ text }) => {
    const wrapped = /<untrusted_content source="browser page">[\s\S]*PAGE-MARKER[\s\S]*IGNORE ALL PREVIOUS[\s\S]*<\/untrusted_content>/.test(text);
    return { ok: wrapped, why: `page text returned inside <untrusted_content>: ${wrapped}${/Error|ERROR/.test(text) ? ' | ' + (text.match(/.*ERROR.*/) || [''])[0].slice(0, 160) : ''}` };
  }, 90000);
  await set('browserAllowPrivateNetwork', false);

  // ── Native tool calling, through the OpenRouter client pointed at the fake server ──
  await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model: 'fake/native-model', maxIterations: 12 });
  await set('nativeToolCalling', true);
  const nativeOnly = (reqs) => reqs.length > 0 && reqs.every(r => r.native);
  await scenario('native_text', ({ reqs }) => ({ ok: nativeOnly(reqs) && reqs.length === 1, why: `native tools sent: ${nativeOnly(reqs)}; ${reqs.length} req` }));
  await scenario('native_read', ({ reqs }) => {
    const result = reqs.find(r => r.lastRole === 'tool');
    return { ok: nativeOnly(reqs) && !!result && /NOTES-MARKER/.test(result.lastText), why: `tool result returned as role=tool: ${!!result}; content: ${result ? JSON.stringify(result.lastText.slice(0, 60)) : '-'}` };
  });
  await scenario('native_clarify', ({ reqs }) => ({ ok: nativeOnly(reqs) && reqs.length === 1, why: `${reqs.length} req; a clarify call must end the turn` }));
  await scenario('native_unknown', ({ reqs }) => {
    const result = reqs.find(r => r.lastRole === 'tool');
    const corrective = !!result && /no tool named "ask_user"/.test(result.lastText);
    return { ok: nativeOnly(reqs) && corrective, why: `corrective tool result for unknown tool: ${corrective}` };
  });
}
module.exports = { run };

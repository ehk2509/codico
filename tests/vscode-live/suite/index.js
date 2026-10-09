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
  const scenario = async (name, check, limitMs = 60000, command = 'codico.__evalRunTask') => {
    const before = (await getLog()).length; const t0 = Date.now(); let error = null;
    try {
      await Promise.race([
        vscode.commands.executeCommand(command, `[SCENARIO:${name}] please do the task`),
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

  // Auto-compaction mid-task must keep the request and leave no orphaned tool results
  await set('autoCompactThreshold', 10000);
  await scenario('compaction', ({ reqs }) => {
    const after = reqs.filter(r => r.hasSummary);
    const keptRequest = after.length > 0 && after.every(r => r.hasRequest);
    // Fenced tools: each [Tool Results] user message must follow an assistant message
    const wellFormed = after.every(r => r.roles.every((role, i) => i === 0 || !(role === 'user' && r.roles[i - 1] === 'user')));
    return { ok: after.length > 0 && keptRequest && wellFormed,
      why: `${reqs.length} req, ${after.length} after compaction; request kept: ${keptRequest}; roles alternate: ${wellFormed}` };
  }, 90000);
  await set('autoCompactThreshold', 100000);

  {
    // Plan → clarifying question → the user answers (two commands, one scenario)
    const before = (await getLog()).length; const t0 = Date.now(); let error = null;
    try {
      await vscode.commands.executeCommand('codico.__evalRunPlan', '[SCENARIO:plan_clarify] plan the storage layer');
      await vscode.commands.executeCommand('codico.__evalAnswerClarify', 'Postgres');
    } catch (e) { error = String(e && e.message || e); }
    const reqs = (await getLog()).slice(before).filter(e => e.scenario === 'plan_clarify' && e.stream);
    const afterAnswer = reqs.slice(1);
    const continuedPlan = afterAnswer.length > 0 && afterAnswer.every(r => /task planner/.test(r.lastUser) || /^\[Tool Results\]/.test(r.lastUser));
    const answerIncluded = afterAnswer.some(r => /plan the storage layer[\s\S]*answer to your clarifying question: Postgres/.test(r.lastUser));
    const blocked = afterAnswer.some(r => /Not available in Ask mode/.test(r.lastUser));
    const written = read('live/eager.js') !== null;
    const ok = !error && reqs.length === 3 && continuedPlan && answerIncluded && blocked && !written;
    results.push({ name: 'plan_clarify', ms: Date.now() - t0, requests: reqs.length, ok,
      why: `answer continued the plan: ${continuedPlan}; goal + answer sent: ${answerIncluded}; write blocked: ${blocked}; file written: ${written}${error ? '; error: ' + error : ''}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // Messages and plans that arrive while the agent is busy are queued (not dropped), and a
  // queued plan keeps its read-only mode
  const waitFor = async (pred, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred(await getLog())) { return true; } await new Promise(r => setTimeout(r, 100)); } return false; };
  {
    const before = (await getLog()).length; const t0 = Date.now();
    const a = vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:queue_a] first task');
    await new Promise(r => setTimeout(r, 300));
    await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:queue_b] second task, sent while busy');
    await a;
    const ran = await waitFor(log => log.slice(before).some(e => e.scenario === 'queue_b'));
    const log = (await getLog()).slice(before);
    const firstB = log.findIndex(e => e.scenario === 'queue_b'), lastA = log.map(e => e.scenario).lastIndexOf('queue_a');
    results.push({ name: 'queue_busy', ms: Date.now() - t0, requests: log.length, ok: ran && firstB > lastA,
      why: `message sent while busy ran: ${ran}; after the first finished: ${firstB > lastA}` });
    await waitFor(log => false, 800); // let B finish
  }
  {
    const before = (await getLog()).length; const t0 = Date.now();
    const a = vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:herr_a] first task');
    await new Promise(r => setTimeout(r, 300));
    // searchThreads without a query throws inside the panel message handler
    await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'searchThreads' });
    await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:herr_b] second task, sent while busy');
    await a;
    // A replies only after 1.5 s; B must not have reached the model before A finished
    const early = (await getLog()).slice(before).some(e => e.scenario === 'herr_b');
    const ran = await waitFor(log => log.slice(before).some(e => e.scenario === 'herr_b'));
    results.push({ name: 'handler_error', ms: Date.now() - t0, requests: (await getLog()).length - before, ok: ran && !early,
      why: `queued message ran: ${ran}; ran alongside the unfinished task: ${early}` });
    await waitFor(log => false, 800);
  }
  {
    // Stop pressed while the turn is still preparing its request (keys, context, lookups)
    const before = (await getLog()).length; const t0 = Date.now();
    void vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'sendMessage', text: '[SCENARIO:stop_setup] please do the task' });
    await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'abortStream' });
    await waitFor(log => false, 2000);
    const sent = (await getLog()).slice(before).filter(e => e.scenario === 'stop_setup').length;
    results.push({ name: 'stop_setup', ms: Date.now() - t0, requests: sent, ok: sent === 0,
      why: `requests sent after Stop: ${sent}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
  {
    const before = (await getLog()).length; const t0 = Date.now();
    const a = vscode.commands.executeCommand('codico.__evalRunPlan', '[SCENARIO:plan_q_a] first plan');
    await new Promise(r => setTimeout(r, 300));
    await vscode.commands.executeCommand('codico.__evalRunPlan', '[SCENARIO:plan_q_b] second plan, queued');
    await a;
    await waitFor(log => log.slice(before).filter(e => e.scenario === 'plan_q_b').length >= 2);
    await waitFor(log => false, 800);
    const b = (await getLog()).slice(before).filter(e => e.scenario === 'plan_q_b' && e.stream);
    const blocked = b.some(r => /Not available in Ask mode/.test(r.lastUser));
    const written = read('live/queued-plan.js') !== null;
    results.push({ name: 'plan_queued', ms: Date.now() - t0, requests: b.length, ok: b.length >= 2 && blocked && !written,
      why: `queued plan ran: ${b.length > 0}; its write blocked: ${blocked}; file written: ${written}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  await scenario('plan_readonly', ({ reqs, text, read }) => {
    const blocked = /Not available in Ask mode/.test(text);
    const written = read('live/planned.js') !== null;
    const nudged = /\[System Action\]/.test(text);
    return { ok: blocked && !written && !nudged && reqs.length === 2,
      why: `write blocked: ${blocked}; file written: ${written}; "make a change" nudge: ${nudged}; ${reqs.length} req` };
  }, 60000, 'codico.__evalRunPlan');

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
  await scenario('native_plan', ({ reqs }) => {
    const names = (reqs[0] && reqs[0].toolNames) || [];
    const writable = names.filter(n => /write_file|edit_file|run_terminal|browser_(click|type|navigate)|mcp_call/.test(n));
    return { ok: reqs.length === 1 && names.includes('read_file') && writable.length === 0,
      why: `${reqs.length} req; tools offered while planning: ${names.length} (write/run tools: ${writable.join(',') || 'none'})` };
  }, 60000, 'codico.__evalRunPlan');
  await scenario('native_unknown', ({ reqs }) => {
    const result = reqs.find(r => r.lastRole === 'tool');
    const corrective = !!result && /no tool named "ask_user"/.test(result.lastText);
    return { ok: nativeOnly(reqs) && corrective, why: `corrective tool result for unknown tool: ${corrective}` };
  });
}
module.exports = { run };

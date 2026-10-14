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
  for (const [k, v] of Object.entries({ model: 'ollama/fake-model', ollamaBaseUrl: `http://127.0.0.1:${PORT}`,
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
  await scenario('bigoutput', ({ ms, reqs }) => {
    // The model gets the start and the end (where failures and summaries are), not 1.2 MB
    const r = reqs.find(x => /\[run_terminal: seq/.test(x.lastUser)) || { lastUser: '', lastUserTail: '', lastUserChars: 0 };
    const start = /\n1\n2\n3\n/.test(r.lastUser), end = /199999\n200000/.test(r.lastUserTail);
    return { ok: ms < 20000 && start && end && r.lastUserChars < 6000, why: `${ms} ms; start kept: ${start}; end kept: ${end}; ${r.lastUserChars} chars sent` };
  });
  await scenario('plain_code', ({ reqs, read }) => ({ ok: read('live/keep-me.txt') !== null && reqs.length === 1, why: `keep-me.txt still exists: ${read('live/keep-me.txt') !== null}; ${reqs.length} req` }));
  await scenario('multitool', ({ text }) => ({ ok: /port=8080/.test(text) && /NOTES-MARKER/.test(text), why: `both results returned: ${/port=8080/.test(text) && /NOTES-MARKER/.test(text)}` }));
  await scenario('unicode', ({ read }) => { const g = read('live/unicode.txt'); return { ok: g !== null && g.trimEnd() === 'Café ☕ — naïve 日本語 🚀\nline2', why: JSON.stringify(g) }; });
  await scenario('disconnect', ({ reqs, text }) => ({ ok: /\[System Recovery\]/.test(text) && /network|interrupt/i.test(text) && reqs.length === 2, why: `recovery prompt: ${/\[System Recovery\]/.test(text)}; ${reqs.length} req` }));
  await scenario('http500', ({ ms }) => ({ ok: ms < 15000, allowError: true, why: `${ms} ms (must end, not hang)` }), 30000);
  await scenario('todo', ({ text }) => ({ ok: /Task list updated/i.test(text), why: `todo accepted (and agent usable after HTTP 500): ${/Task list updated/i.test(text)}` }));
  await scenario('verify_ok', ({ read, reqs, text }) => ({ ok: read('live/verified.js') !== null && /acceptance gate is satisfied/.test(text) && reqs.length <= 5, why: `gate satisfied: ${/acceptance gate is satisfied/.test(text)}; ${reqs.length} req` }));
  await scenario('reread', ({ read, text }) => {
    const flagged = /You are in a loop/.test(text);
    return { ok: !flagged && read('fixtures/reread.txt') === 'n=3\n', why: `flagged as a loop: ${flagged}; file: ${JSON.stringify(read('fixtures/reread.txt'))}` };
  });
  await scenario('stuck_loop', ({ reqs, error, text }) => ({ ok: !error && reqs.length <= 10, why: `${reqs.length} requests (must stop, not loop); loop warning sent: ${/You are in a loop/.test(text)}` }), 60000);
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
  {
    // A summary that copies the transcript must not replace the history (the agent would forget its work)
    const before = (await getLog()).length; const t0 = Date.now(); let error = null;
    try { await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:bad_summary] please do the task'); } catch (e) { error = String(e && e.message || e); }
    const all = (await getLog()).slice(before).filter(e => e.scenario === 'bad_summary');
    const asks = all.filter(e => e.summaryRequest), reqs = all.filter(e => e.stream);
    const replaced = reqs.some(r => r.copiedSummary), kept = reqs.every(r => r.hasRequest);
    results.push({ name: 'bad_summary', ms: Date.now() - t0, requests: reqs.length,
      ok: !error && asks.length >= 2 && asks.length <= 4 && !replaced && kept && reqs.length >= 7,
      why: `summary attempts: ${asks.length} (one retry, then waits for the history to grow); history replaced by the bad summary: ${replaced}; request kept in every step: ${kept}; task finished: ${!error} (${reqs.length} req)` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
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
  // ── File safety: changes the user made must never be silently overwritten ──
  const pollApproval = async (ms = 15000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const ids = await vscode.commands.executeCommand('codico.__evalApprovals');
      if (ids.length) { return ids[0]; }
      await new Promise(r => setTimeout(r, 50));
    }
    return null;
  };
  // The user edits the file while the approval prompt is open, then approves
  const approveAfterUserEdit = async (name, file, userContent) => {
    const before = (await getLog()).length; const t0 = Date.now();
    await vscode.commands.executeCommand('codico.__evalApprovals', true);
    const task = vscode.commands.executeCommand('codico.__evalRunTask', `[SCENARIO:${name}] please do the task`);
    const permId = await pollApproval();
    fs.writeFileSync(path.join(ws, file), userContent);
    if (permId) { await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'writePermissionResponse', permId, granted: true }); }
    await task;
    await vscode.commands.executeCommand('codico.__evalApprovals', false);
    const reqs = (await getLog()).slice(before).filter(e => e.scenario === name && e.stream);
    return { ms: Date.now() - t0, permId, reqs, text: all(reqs), file: read(file) };
  };
  {
    const r = await approveAfterUserEdit('approve_edit', 'fixtures/approve-edit.txt', 'alpha=USER\nbeta=2\n');
    results.push({ name: 'approve_edit', ms: r.ms, requests: r.reqs.length, ok: !!r.permId && r.file === 'alpha=USER\nbeta=3\n',
      why: `approval shown: ${!!r.permId}; file: ${JSON.stringify(r.file)} (must keep the user's change and apply the edit)` });
  }
  {
    const r = await approveAfterUserEdit('approve_write', 'fixtures/approve-write.txt', 'user\n');
    const told = /Not written: the file changed/.test(r.text);
    results.push({ name: 'approve_write', ms: r.ms, requests: r.reqs.length, ok: !!r.permId && r.file === 'user\n' && told,
      why: `approval shown: ${!!r.permId}; file: ${JSON.stringify(r.file)}; model told it was not written: ${told}` });
  }
  {
    // Unsaved editor changes: the agent must see and edit the buffer, not the stale disk copy
    const uri = vscode.Uri.file(path.join(ws, 'fixtures/dirty.txt'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const we = new vscode.WorkspaceEdit();
    we.replace(uri, new vscode.Range(1, 0, 1, 3), 'TWO-UNSAVED');
    await vscode.workspace.applyEdit(we);
    const dirtyBefore = doc.isDirty;
    await scenario('dirty_edit', ({ read }) => {
      const disk = read('fixtures/dirty.txt');
      return { ok: dirtyBefore && disk === 'one\ntwo-final\n' && !doc.isDirty && doc.getText() === disk,
        why: `buffer was unsaved: ${dirtyBefore}; disk: ${JSON.stringify(disk)}; editor saved and in sync: ${!doc.isDirty && doc.getText() === disk}` };
    });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
  {
    // Undo/Redo work normally, but never overwrite a file changed since
    const t0 = Date.now();
    const msg = (m) => vscode.commands.executeCommand('codico.__evalWebviewMessage', m);
    await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:undo_write] please do the task');
    const written = read('fixtures/undo.txt');
    await msg({ type: 'undo' }); const undone = read('fixtures/undo.txt');
    await msg({ type: 'redo' }); const redone = read('fixtures/undo.txt');
    fs.writeFileSync(path.join(ws, 'fixtures/undo.txt'), 'user\n');
    await msg({ type: 'undo' }); const kept = read('fixtures/undo.txt');
    const ok = /^v2/.test(written || '') && undone === 'v1\n' && /^v2/.test(redone || '') && kept === 'user\n';
    results.push({ name: 'undo_changed', ms: Date.now() - t0, requests: 0, ok,
      why: `write ${JSON.stringify(written)} → undo ${JSON.stringify(undone)} → redo ${JSON.stringify(redone)} → user edit, undo keeps it: ${JSON.stringify(kept)}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
  {
    // Undo after a write addressed by absolute path must restore that file, not a nested copy
    const t0 = Date.now();
    await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:abs_undo] please do the task');
    const written = read('fixtures/abs.txt');
    await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'undo' });
    const undone = read('fixtures/abs.txt');
    const stray = fs.existsSync(path.join(ws, ws.replace(/^\/+/, '')));
    results.push({ name: 'abs_undo', ms: Date.now() - t0, requests: 0, ok: /^v2/.test(written || '') && undone === 'v1\n' && !stray,
      why: `write ${JSON.stringify(written)} → undo ${JSON.stringify(undone)}; stray nested copy created: ${stray}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
  await scenario('symlink', ({ text }) => {
    const work = path.dirname(ws);
    const leaked = /OUTSIDE-SECRET/.test(text);
    const escapedDir = fs.existsSync(path.join(work, 'outside/new.txt'));
    const escapedDangling = fs.existsSync(path.join(work, 'outside/dangling-target.txt'));
    const refusals = (text.match(/symbolic link/g) || []).length;
    return { ok: !leaked && !escapedDir && !escapedDangling && refusals >= 3,
      why: `outside secret read: ${leaked}; written through link: ${escapedDir}; written through dangling link: ${escapedDangling}; refusals: ${refusals}/3` };
  });
  {
    // A real stdio MCP server (tests/fixtures/fakeMcpServer.js), registered through settings
    const server = path.join(__dirname, '..', '..', 'fixtures', 'fakeMcpServer.js');
    await set('mcpServers', [{ name: 'fake', command: 'node', args: [server, 'normal'] }]);
    await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'refreshMcp' });
    await scenario('mcp_big', ({ reqs }) => {
      // The request log keeps only the start of each message: check its full length and its end
      const result = reqs.find(r => /\[mcp_call: fake\/big\]/.test(r.lastUser));
      const chars = result ? result.lastUserChars : 0;
      const capped = !!result && /more characters omitted/.test(result.lastUserTail);
      return { ok: !!result && chars < 22000 && capped, why: `MCP result reached the model: ${!!result}; message length: ${chars} (result was 50000); cap noted: ${capped}` };
    });
    await set('mcpServers', []);
    await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'refreshMcp' });
  }
  {
    // Regenerate cuts the last turn from the model history and sends it again
    const before = (await getLog()).length; const t0 = Date.now();
    await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:regen] please do the task');
    const first = (await getLog()).slice(before).filter(e => e.scenario === 'regen' && e.stream);
    const mid = (await getLog()).length;
    await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'regenerate' });
    const again = (await getLog()).slice(mid).filter(e => e.scenario === 'regen' && e.stream);
    const same = !!first[0] && !!again[0] && JSON.stringify(again[0].roles) === JSON.stringify(first[0].roles) && again[0].lastUser === first[0].lastUser;
    results.push({ name: 'regenerate', ms: Date.now() - t0, requests: first.length + again.length, ok: first.length === 2 && again.length === 2 && same,
      why: `first run ${first.length} req, regenerated ${again.length} req; regenerated request identical to the original (old reply gone): ${same}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
  {
    // A file path clicked in the chat opens that file at its line
    const t0 = Date.now();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'openFile', path: 'fixtures/config.txt', line: 2 });
    const ed = vscode.window.activeTextEditor;
    const opened = !!ed && ed.document.uri.fsPath.endsWith(path.join('fixtures', 'config.txt'));
    const line = ed ? ed.selection.active.line + 1 : 0;
    let outside = 'none';
    try { await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'openFile', path: '../outside/secret.txt' }); outside = vscode.window.activeTextEditor?.document.uri.fsPath ?? 'none'; } catch (e) { outside = 'threw: ' + e.message; }
    const blocked = !/secret\.txt$/.test(outside);
    results.push({ name: 'open_file_link', ms: Date.now() - t0, requests: 0, ok: opened && line === 2 && blocked,
      why: `opened: ${opened}; at line ${line}; path outside the workspace refused: ${blocked}` });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
  {
    // "Open diff" on a change shows VS Code's diff editor: the file before the change against now
    const t0 = Date.now();
    await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:diff_change] please do the task');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'openChangeDiff', path: 'fixtures/diffme.txt' });
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab && tab.input;
    const isDiff = input instanceof vscode.TabInputTextDiff;
    let before = '', after = '';
    if (isDiff) {
      before = (await vscode.workspace.openTextDocument(input.original)).getText();
      after = (await vscode.workspace.openTextDocument(input.modified)).getText();
    }
    results.push({ name: 'open_change_diff', ms: Date.now() - t0, requests: 0, ok: isDiff && before === 'before\n' && /^after/.test(after),
      why: `diff editor opened: ${isDiff}; before ${JSON.stringify(before)} → now ${JSON.stringify(after)}` });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
  await scenario('big_read', ({ reqs }) => {
    const r = reqs.find(x => /\[read_file: fixtures\/big\.md lines 1–80 of/.test(x.lastUser));
    const outline = !!r && /Outline of this \d+-line file[\s\S]*L\d+–\d+\s+## Section 14/.test(r.lastUser);
    return { ok: outline && r.lastUserChars < 6000, why: `outline with line ranges: ${outline}; first 80 lines only: ${!!r}; ${r ? r.lastUserChars : 0} chars sent (a 300-line page was ~9,000)${outline ? '' : ' | ' + JSON.stringify(r ? r.lastUser.slice(0, 700) : '')}` };
  });
  await scenario('binary_write', ({ read, text }) => {
    const reported = /\[write_file: live\/blob\.bin\] Written successfully/.test(text);
    return { ok: reported && read('live/blob.bin') !== null, why: `reported as written: ${reported}; on disk: ${read('live/blob.bin') !== null}` };
  });
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

  // ── Direct DeepSeek through its adapter; the fake server enforces DeepSeek's reasoning rule ──
  await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model: 'direct:deepseek/deepseek-flash', maxIterations: 12, directApiKeys: { deepseek: 'ds-test-key' } });
  await scenario('ds_tools', ({ reqs, error }) => {
    const [first, second] = reqs;
    const settings = !!first && first.deepseek && first.model === 'deepseek-flash' && first.thinking && first.thinking.type === 'enabled' && first.effort === 'high';
    // The thread also holds replies from earlier scenarios (other providers): they carry an empty field
    const back = second ? second.reasoningBack : [];
    const replayed = back.length > 0 && back.every(r => typeof r === 'string') && back[back.length - 1] === 'Thinking about step 0. Deciding what to do.';
    const readResult = !!second && second.lastRole === 'tool' && /NOTES-MARKER/.test(second.lastText);
    return { ok: !error && reqs.length === 2 && settings && replayed && readResult,
      why: `${reqs.length} req (no 400, no fallback); model and thinking settings sent: ${settings}; reasoning sent back with the tool result: ${replayed}; tool result delivered: ${readResult}` };
  });

  // ── Direct OpenAI through its adapter; the fake server refuses max_tokens like the real API ──
  await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model: 'direct:openai/gpt-5.5', maxIterations: 12, directApiKeys: { openai: 'oa-test-key' } });
  await scenario('oa_tools', ({ reqs, error }) => {
    const [first, second] = reqs;
    const settings = !!first && first.openai && first.model === 'gpt-5.5' && first.maxTokens === undefined && first.maxCompletionTokens === 64000 && first.effort === 'medium';
    const readResult = !!second && second.lastRole === 'tool' && /NOTES-MARKER/.test(second.lastText);
    return { ok: !error && reqs.length === 2 && settings && !!first.native && readResult,
      why: `${reqs.length} req (no 400); max_completion_tokens and effort sent, no max_tokens: ${settings}; native tools: ${!!first && first.native}; tool result delivered: ${readResult}` };
  });
  // A model that refuses the effort option: asked once more without it, tools kept
  await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model: 'direct:openai/gpt-5.4-mini', maxIterations: 12, directApiKeys: { openai: 'oa-test-key' } });
  await scenario('oa_plain', ({ reqs, error }) => {
    const [refused, retried] = reqs;
    const retry = reqs.length === 2 && refused.effort === 'medium' && retried.effort === undefined && retried.native && retried.maxCompletionTokens === 64000;
    return { ok: !error && retry, why: `${reqs.length} req; refused with the effort option, answered without it and with tools kept: ${retry}${error ? '; error: ' + error : ''}` };
  });

  // No OpenRouter key, a DeepSeek key, and the default (OpenRouter) model selected: use the DeepSeek key
  await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: '', model: 'deepseek/deepseek-v4-flash', maxIterations: 12, directApiKeys: { deepseek: 'ds-test-key' } });
  await scenario('ds_fallback', ({ reqs, error }) => {
    const viaDeepSeek = reqs.length === 1 && reqs[0].deepseek && reqs[0].model === 'deepseek-flash';
    const setting = vscode.workspace.getConfiguration('codico').get('model');
    return { ok: !error && viaDeepSeek && setting === 'direct:deepseek/deepseek-flash',
      why: `answered through the DeepSeek key: ${viaDeepSeek}; model setting is now ${setting}${error ? '; error: ' + error : ''}` };
  });
  // ── Local code search: the search_code tool ──
  await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model: 'deepseek/deepseek-v4-flash', maxIterations: 12 });
  await scenario('cs_native', ({ reqs, error }) => {
    const results = ((reqs[1] || {}).toolResults || []).join('\n=====\n');
    const [first, second] = (reqs[1] || {}).toolResults || [];
    // The definition first, with what it defines and who imports it
    const ranked = /^\[search_code: compute the shipping cost for an order\][^\n]*\n\n1\. shop\/shipping\.ts:1-\d+  defines: shippingCost\n/.test(first || '') && /2\texport function shippingCost/.test(first || '') && /used by: shop\/checkout\.ts/.test(first || '');
    // The file excluded by .codicoignore holds "SECRET-TOKEN": it is not indexed
    // Nor is the file outside the workspace that a symbolic link inside it points to
    const noSecret = !!second && !/SECRET-TOKEN-12345|OUTSIDE-SECRET|fixtures\/link\b|^\d+\. fixtures\/secret\.txt/m.test(results);
    return { ok: !error && reqs.length === 2 && ranked && noSecret, why: `${reqs.length} requests; the definition ranked first, with its symbol and importer: ${ranked}; neither the ignored secret file nor the file behind a symbolic link out of the workspace is in any result: ${noSecret}` };
  });
  await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model: 'ollama/fake-model', maxIterations: 12 });
  await scenario('cs_fresh', ({ reqs, error }) => {
    const text = reqs.map(r => r.lastUser).join('\n');
    const found = /\[search_code: zebra quokka handler\][^\n]*\n\n1\. live\/cs-new\.ts:1-\d+  defines: zebraQuokkaHandler/.test(text);
    return { ok: !error && found, why: `a file the agent wrote a moment before is found by the next search: ${found}` };
  });

  // ── Leaner context: open tabs are named, never sent; a large search result is capped with an exact count ──
  {
    const t0 = Date.now(); const before = (await getLog()).length;
    // Tabs open besides the active file: an ignored file with a secret, a lock file, an ordinary file
    fs.writeFileSync(path.join(ws, 'package-lock.json'), '{ "lockfileVersion": 3, "LOCK-CONTENT-MARKER": true }\n');
    for (const file of ['fixtures/secret.txt', 'package-lock.json', 'fixtures/notes.txt', 'shop/shipping.ts']) {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ws, file))), { preview: false });
    }
    await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'sendMessage', text: '[SCENARIO:lean_search] please do the task' });
    await waitFor(log => log.slice(before).filter(e => e.scenario === 'lean_search' && e.stream).length >= 2, 15000);
    await new Promise(r => setTimeout(r, 500));
    const reqs = (await getLog()).slice(before).filter(e => e.scenario === 'lean_search' && e.stream);
    const context = (reqs[0] || {}).lastUser || ''; const found = (reqs[1] || {}).lastUser || '';
    const named = /Other open tabs \(names only; read a file if it matters\): [^\n]*fixtures\/notes\.txt/.test(context);
    const nothingSent = !/SECRET-TOKEN-12345|LOCK-CONTENT-MARKER|NOTES-MARKER/.test(context) && !/secret\.txt|package-lock\.json/.test(context.split('[User request]')[0].split('Other open tabs')[1] || '');
    const capped = /fixtures\/long\.txt:6:row 6 of the long file\n… showing 6 of 60 matches in 1 file\. Not shown: fixtures\/long\.txt \(54\)\. Narrow the search/.test(found) && !/long\.txt:7:/.test(found);
    results.push({ name: 'lean_context', ms: Date.now() - t0, requests: reqs.length, ok: named && nothingSent && capped,
      why: `the other tabs are named: ${named}; no tab's content is sent, and the ignored file and the lock file are not even named: ${nothingSent}; 60 matches in one file are shown as 6 with the exact count left out: ${capped}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── A read does not repeat lines that are already in the conversation and unchanged ──
  {
    const t0 = Date.now(); const before = (await getLog()).length;
    const run = async (name) => { const from = (await getLog()).length; await vscode.commands.executeCommand('codico.__evalRunTask', `[SCENARIO:${name}] please do the task`); return (await getLog()).slice(from).filter(e => e.scenario === name && e.stream).map(r => r.lastUser || '').join('\n=====\n'); };
    const first = await run('rr_first');
    const full = /\[read_file: fixtures\/long\.txt lines 1–40 of 60; [^\]]*\]\n```\n1\trow 1 of the long file\n/.test(first) && /40\trow 40 of the long file/.test(first);
    const again = await run('rr_again');
    // The same lines again: a pointer, no text. An overlapping range (the path written another way): only its new lines
    const declined = /\[read_file: fixtures\/long\.txt lines 1–40 of 60\] Not repeated: these lines are already in this conversation/.test(again) && !/\n5\trow 5 of the long file/.test(again);
    const partial = /lines 21–40 are left out because they are already in this conversation, unchanged\]\n```\n… lines 21–40 not repeated: already shown above, unchanged …\n41\trow 41 of the long file\n/.test(again) && /60\trow 60 of the long file/.test(again);
    // Changed outside Codico: the changed line is sent, the rest still is not
    const lines = read('fixtures/long.txt').split('\n'); lines[9] = 'row 10 CHANGED-BY-HAND'; fs.writeFileSync(path.join(ws, 'fixtures/long.txt'), lines.join('\n'));
    const changed = await run('rr_changed');
    const seesChange = /… lines 2–9 not repeated: already shown above, unchanged …\n10\trow 10 CHANGED-BY-HAND\n… lines 11–40 not repeated/.test(changed);
    // Declined once, asked for exactly the same lines again: the text is given
    const declinedOnce = /\[read_file: fixtures\/long\.txt lines 41–60 of 60\] Not repeated/.test(await run('rr_declined'));
    const insisted = /\[read_file: fixtures\/long\.txt lines 41–60 of 60; [^\]]*\]\n```\n41\trow 41 of the long file\n/.test(await run('rr_insist'));
    const reqs = (await getLog()).slice(before).filter(e => /^rr_/.test(e.scenario) && e.stream).length;
    results.push({ name: 'no_repeat', ms: Date.now() - t0, requests: reqs, ok: full && declined && partial && seesChange && declinedOnce && insisted,
      why: `first read is whole: ${full}; the same lines again are not repeated: ${declined}; an overlapping read returns only its new lines: ${partial}; a line changed by hand is sent, the unchanged ones are not: ${seesChange}; asking a second time for declined lines returns them: ${declinedOnce && insisted}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── The same with native tool calls: results are tool messages, not text ──
  {
    const t0 = Date.now(); const before = (await getLog()).length;
    await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model: 'deepseek/deepseek-v4-flash', maxIterations: 12 });
    await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:rrn_first] please do the task');
    await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:rrn_again] please do the task');
    // What the task cost is kept with its reply, one entry per request
    const usage = await vscode.commands.executeCommand('codico.__evalUsage') || {};
    const recorded = Array.isArray(usage.requests) && usage.requests.length >= 1 && usage.requests.every(r => r[0] === 1500 && r[1] === 20 && r[3] === 'main') && usage.tokens === 1520 * usage.requests.length && Array.isArray(usage.compactions) && usage.tokens > 0;
    await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model: 'ollama/fake-model', maxIterations: 12 });
    const reqs = (await getLog()).slice(before).filter(e => /^rrn_/.test(e.scenario) && e.stream);
    const got = reqs.map(r => (r.toolResults || []).join('\n')).join('\n=====\n');
    // This thread already holds lines 1–40 from the scenario above, so even the first read here is declined;
    // asked a second time for exactly those lines (the next turn), the text is given
    const whole = /\[read_file: fixtures\/long\.txt lines 1–30 of 60; [^\]]*\]\n```\n1\trow 1 of the long file/.test(got);
    const sameTurn = /\[read_file: fixtures\/long\.txt lines 5–30 of 60\] Not repeated/.test(got);
    const nextTurn = /\[read_file: fixtures\/long\.txt lines 1–30 of 60\] Not repeated/.test(got);
    results.push({ name: 'no_repeat_native', ms: Date.now() - t0, requests: reqs.length, ok: whole && sameTurn && nextTurn && recorded,
      why: `lines already in the thread are declined on a native read: ${nextTurn}; an overlapping range in the next step too: ${sameTurn}; asked again, the text is returned as a tool result: ${whole}; the task's requests are recorded with the reply: ${recorded} (${JSON.stringify(usage).slice(0, 160)})` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── Command sandbox: with it on, a command cannot write outside the workspace, and the agent is told why ──
  {
    const t0 = Date.now(); const before = (await getLog()).length;
    // In the home folder: the workspace's own parent is a temporary folder, which a sandboxed command gets a private copy of
    const escaped = path.join(require('os').homedir(), 'codico-sandbox-escaped.txt');
    await set('commandSandbox', 'auto');
    await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:sandbox] please do the task');
    await set('commandSandbox', undefined);
    const reqs = (await getLog()).slice(before).filter(e => e.scenario === 'sandbox' && e.stream);
    const text = (reqs[1] || {}).lastUser || '';
    const confined = /\[Sandbox\] This command ran in Codico's sandbox/.test(text);
    const inside = read('live/sandbox-in.txt') === 'inside';
    // Where this machine has no sandbox, "auto" runs the command as before: the file is then written, and that is the expected result there
    const ok = confined ? inside && !fs.existsSync(escaped) && /Exit: [1-9]/.test(text) : inside && fs.existsSync(escaped);
    try { fs.rmSync(escaped, { force: true }); } catch { /* not there */ }
    results.push({ name: 'sandbox', ms: Date.now() - t0, requests: reqs.length, ok,
      why: confined ? `the write in the workspace happened: ${inside}; the write outside it was stopped by the system and the agent was told it ran in the sandbox: ${!fs.existsSync(escaped)}` : `no sandbox is available on this machine: the command ran unconfined, as "auto" says (${inside})` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── Project memory: a note the agent saves is a file in the project, and the next turn starts with it ──
  {
    const t0 = Date.now(); const before = (await getLog()).length;
    const run = async (name) => { const from = (await getLog()).length; await vscode.commands.executeCommand('codico.__evalRunTask', `[SCENARIO:${name}] please do the task`); return (await getLog()).slice(from).filter(e => e.scenario === name && e.stream); };
    const save = await run('mem_save');
    const file = read('.codico/memory.md') || '';
    const written = /^# Project memory\n[\s\S]*## Commands\n- MEMORY-MARKER the tests run with node --test\n$/.test(file);
    const told = /\[remember\] Saved under "Commands"\. \(\.codico\/memory\.md\)/.test((save[1] || {}).lastUser || '');
    // Not in the prompt of the turn that saved it (the prompt stays the same for a whole task), in the next one it is
    const notYet = save.every(r => !r.sawMemory);
    const recall = await run('mem_recall');
    const recalled = !!recall[0] && recall[0].sawMemory;
    // A note that is wrong is removed the same way, and is gone from the turn after
    await run('mem_fix');
    const removed = !/MEMORY-MARKER/.test(read('.codico/memory.md') || '') && (await run('mem_recall')).every(r => !r.sawMemory);
    results.push({ name: 'project_memory', ms: Date.now() - t0, requests: (await getLog()).length - before, ok: written && told && notYet && recalled && removed,
      why: `the note is in .codico/memory.md under its heading: ${written}; the agent is told it was saved: ${told}; the prompt of the running task is not changed: ${notYet}; the next turn's system prompt has it, as a reminder to check: ${recalled}; removed with "replaces", it is gone from the file and the prompt: ${removed}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── Web search: the tool is offered and dispatched in both formats; here it is turned off, so nothing leaves the machine ──
  {
    const t0 = Date.now(); const before = (await getLog()).length;
    await set('webSearch', 'off');
    await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:ws_fenced] please do the task');
    await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model: 'deepseek/deepseek-v4-flash', maxIterations: 12 });
    await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:ws_native] please do the task');
    await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model: 'ollama/fake-model', maxIterations: 12 });
    await set('webSearch', undefined);
    const fenced = (await getLog()).slice(before).filter(e => e.scenario === 'ws_fenced' && e.stream);
    const native = (await getLog()).slice(before).filter(e => e.scenario === 'ws_native' && e.stream);
    const off = /\[web_search: codico vscode extension\] ERROR: Web search is turned off \(the codico\.webSearch setting\)/;
    const viaText = off.test((fenced[1] || {}).lastUser || '');
    const viaNative = (native[0] || {}).toolNames.includes('web_search') && off.test(((native[1] || {}).toolResults || []).join('\n'));
    results.push({ name: 'web_search', ms: Date.now() - t0, requests: fenced.length + native.length, ok: viaText && viaNative,
      why: `the text format reaches the search tool: ${viaText}; the native tool is offered to the model and reaches it too: ${viaNative}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── Background task: a window opened for a task runs it and reports its state through the shared registry ──
  {
    const t0 = Date.now(); const before = (await getLog()).length; const now = Date.now();
    const task = { id: 'ab12cd34ef567890', prompt: '[SCENARIO:bg_task] write the result file', repoRoot: path.join(ws, '..', 'origin-repo'), worktree: ws,
      branch: 'codico/write-the-result-file-ab12cd', baseCommit: '0123456789abcdef', baseBranch: 'main', permissions: 'ask', status: 'starting', createdAt: now, updatedAt: now };   // 'ask': the window keeps a task's permissions, and later scenarios test approvals
    const done = await vscode.commands.executeCommand('codico.__evalBackground', task) || {};
    const reqs = (await getLog()).slice(before).filter(e => e.scenario === 'bg_task' && e.stream);
    const told = /\[Background task\] You are working in a separate git worktree of the project, on its own branch "codico\/write-the-result-file-ab12cd" \(started from "main"\)/.test((reqs[0] || {}).lastUser || '');
    const ran = read('live/bg-result.txt') !== null && reqs.length >= 2;
    const listed = (await vscode.commands.executeCommand('codico.__evalBackground') || []).find(t => t.id === task.id) || {};
    // Opening the same window again must not run the task a second time
    const again = (await getLog()).length;
    await vscode.commands.executeCommand('codico.__evalBackground', { ...listed });
    const once = (await getLog()).slice(again).filter(e => e.scenario === 'bg_task').length === 0;
    results.push({ name: 'background_task', ms: Date.now() - t0, requests: reqs.length, ok: told && ran && done.status === 'finished' && listed.status === 'finished' && listed.heartbeat > now - 1000 && once,
      why: `the agent was told where it works: ${told}; the task ran in this window: ${ran}; reported as ${done.status} to the caller and ${listed.status} in the registry other windows read; not run again when the window reopens: ${once}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── Duplicate thread: refused while a reply runs; the copy has the conversation and is independent ──
  {
    const t0 = Date.now(); const msg = (m) => vscode.commands.executeCommand('codico.__evalWebviewMessage', m);
    const active = async () => (await vscode.commands.executeCommand('codico.__evalTurns', true))[0];
    const turns = () => vscode.commands.executeCommand('codico.__evalTurns');
    const original = await active();
    const before = (await getLog()).length;
    const task = vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:dup_slow] please do the task');
    await waitFor(log => log.slice(before).some(e => e.scenario === 'dup_slow' && e.stream), 8000);
    await msg({ type: 'duplicateThread', id: original });
    const refused = await active() === original;
    await task;
    const turnsBefore = await turns();
    await msg({ type: 'duplicateThread', id: original });
    const copy = await active();
    const sameConversation = copy !== original && JSON.stringify(await turns()) === JSON.stringify(turnsBefore);
    // What the model sees in the copy is the original conversation plus the new message
    const mid = (await getLog()).length;
    await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:dup_after] please do the task');
    const slow = (await getLog()).slice(before).filter(e => e.scenario === 'dup_slow' && e.stream);
    const after = (await getLog()).slice(mid).filter(e => e.scenario === 'dup_after' && e.stream)[0] || {};
    const historyCopied = slow.length === 2 && Array.isArray(after.roles) && after.roles.length === slow[1].roles.length + 2;
    const copyGrew = (await turns()).length === turnsBefore.length + 1;
    // Back in the original: it has not gained the copy's message
    await msg({ type: 'switchThread', id: original });
    const independent = await active() === original && JSON.stringify(await turns()) === JSON.stringify(turnsBefore);
    await msg({ type: 'deleteThread', id: copy });
    const cleaned = await active() === original;
    results.push({ name: 'duplicate_thread', ms: Date.now() - t0, requests: 0, ok: refused && sameConversation && historyCopied && copyGrew && independent && cleaned,
      why: `refused while a reply was running: ${refused}; the copy opened with the same messages: ${sameConversation}; the model in the copy sees the original conversation: ${historyCopied}; a message in the copy stays in the copy: ${copyGrew && independent}; original active again after deleting the copy: ${cleaned}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── Stop after a tool has finished: its result stays in the conversation (text-format tools) ──
  {
    const before = (await getLog()).length; const t0 = Date.now();
    const task = vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:stop_keep] please do the task');
    // The first command has run and the second (a long sleep) is under way
    const t = Date.now(); while (read('live/stop-first.txt') === null && Date.now() - t < 10000) { await new Promise(r => setTimeout(r, 50)); }
    await new Promise(r => setTimeout(r, 400));
    const stopAt = Date.now();
    await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'abortStream' });
    await task;
    const stopMs = Date.now() - stopAt;
    const mid = (await getLog()).length;
    await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:stop_next] please do the task');
    const next = (await getLog()).slice(mid).filter(e => e.scenario === 'stop_next' && e.stream)[0] || {};
    const sent = (await getLog()).slice(before).filter(e => e.scenario === 'stop_keep' && e.stream).length;
    // The stopped turn ends: tool call, its results, the stop note; then the new message. No two user turns in a row
    const tail = Array.isArray(next.roles) ? next.roles.slice(-4).join(' ') : '';
    const alternates = tail === 'assistant user assistant user';
    results.push({ name: 'stop_keep', ms: Date.now() - t0, requests: sent, ok: sent === 1 && stopMs < 6000 && !!next.sawStopResult && !!next.endsStopped && alternates,
      why: `Stop ended the running command in ${stopMs} ms with no further request (${sent}); the next request still has the first command's output: ${!!next.sawStopResult}; the stop is marked: ${!!next.endsStopped}; the conversation ends "${tail}": ${alternates}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── Remembered commands: "always allow\" answers the next ones, but not a command with another attached ──
  {
    const before = (await getLog()).length; const t0 = Date.now(); const msg = (m) => vscode.commands.executeCommand('codico.__evalWebviewMessage', m);
    await vscode.commands.executeCommand('codico.__evalApprovals', 'commands');
    const task = vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:remember] please do the task');
    const first = await pollApproval();
    if (first) { await msg({ type: 'terminalPermissionResponse', permId: first, granted: true, remember: 'git status *' }); }
    // The second command (same tool, other arguments) must not ask; the next request to wait is the chained one
    const second = await pollApproval();
    const reqsSoFar = (await getLog()).slice(before).filter(e => e.scenario === 'remember' && e.stream);
    if (second) { await msg({ type: 'terminalPermissionResponse', permId: second, granted: false }); }
    await task;
    await vscode.commands.executeCommand('codico.__evalApprovals', false);
    const reqs = (await getLog()).slice(before).filter(e => e.scenario === 'remember' && e.stream);
    const text = all(reqs);
    const ranUnasked = reqsSoFar.length === 3 && /\[run_terminal: git status --short\]/.test(text);
    const chainedAsked = !!second && second !== first && /\[run_terminal\] Denied by user:\ngit status; echo CHAINED/.test(text) && read('live/rem-chained.txt') === null;
    results.push({ name: 'remember', ms: Date.now() - t0, requests: reqs.length, ok: !!first && ranUnasked && chainedAsked,
      why: `the first command asked: ${!!first}; after "always allow git status *" the next one ran without asking: ${ranUnasked}; the same command with a second one attached still asked, and denied it did not run: ${chainedAsked}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── Edits mode: a proposed edit is accepted and rejected one change at a time ──
  {
    const t0 = Date.now(); const msg = (m) => vscode.commands.executeCommand('codico.__evalWebviewMessage', m);
    const ORIGINAL = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9';
    await msg({ type: 'toggleEditsMode', enabled: true });
    await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:hunk_edit] please do the task');
    const proposedOnly = read('fixtures/hunks.txt') === ORIGINAL;
    await msg({ type: 'acceptHunk', filepath: 'fixtures/hunks.txt', index: 1 });
    const second = read('fixtures/hunks.txt');
    await msg({ type: 'rejectHunk', filepath: 'fixtures/hunks.txt', index: 0 });
    // Nothing is left to accept: the first change was dropped
    await msg({ type: 'acceptAllEdits' });
    const after = read('fixtures/hunks.txt');
    await msg({ type: 'undo' });
    const undone = read('fixtures/hunks.txt') === ORIGINAL;
    await msg({ type: 'toggleEditsMode', enabled: false });
    const one = second === ORIGINAL.replace('l8', 'L8-CHANGED') && after === second;
    results.push({ name: 'hunk_review', ms: Date.now() - t0, requests: 0, ok: proposedOnly && one && undone,
      why: `the edit was proposed, not written: ${proposedOnly}; accepting the second change wrote only it, and the rejected first one never reached the file: ${one}; undo takes the accepted change back: ${undone}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── A message sent while the agent works is delivered with its next step ──
  {
    const before = (await getLog()).length; const t0 = Date.now();
    const task = vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:steer] please do the task');
    await waitFor(log => log.slice(before).some(e => e.scenario === 'steer' && e.stream), 8000);
    await new Promise(r => setTimeout(r, 500));
    await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'queueMessage', text: 'STEER-MARKER use the other file' });
    await task;
    const reqs = (await getLog()).slice(before).filter(e => e.scenario === 'steer' && e.stream);
    const second = (reqs[1] || {}).lastUser || '';
    // In the same request as the command's result, after it, and only once
    const delivered = /STEER-STEP-DONE[\s\S]*\[Message from the user, sent while you were working on the task above\]\nSTEER-MARKER use the other file/.test(second);
    const once = reqs.length === 2 && reqs.every(r => !/STEER-MARKER/.test(r.lastUser || '') || r === reqs[1]);
    results.push({ name: 'steer', ms: Date.now() - t0, requests: reqs.length, ok: delivered && once,
      why: `${reqs.length} requests; the message arrived with the result of the step that was running: ${delivered}; delivered once and the task was not stopped: ${once}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── Rewind: the conversation and the files go back to before a message ──
  {
    const t0 = Date.now(); const run = (name) => vscode.commands.executeCommand('codico.__evalRunTask', `[SCENARIO:${name}] please do the task`);
    const firstOf = async (name, from) => (await getLog()).slice(from).filter(e => e.scenario === name && e.stream)[0];
    await run('rw_first');
    const mark = (await getLog()).length;
    await run('rw_second');
    const secondTurn = (await vscode.commands.executeCommand('codico.__evalTurns')).at(-1);
    await run('rw_third');
    // The second turn also ran a command that created one file and appended to another
    const changed = read('fixtures/rewind.txt') === 'v3\n' && read('live/rw-new.txt') !== null && read('live/rw-cmd.txt') !== null && /^k2\r?\nappended-by-a-command/.test(read('fixtures/rewind-kept.txt') || '');
    const turnsBefore = (await vscode.commands.executeCommand('codico.__evalTurns')).length;
    await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'rewind', turnId: secondTurn });
    // Both later turns' changes are gone, the file the second turn created too; the first turn's change stays.
    // What the command did is undone as well: its file is deleted and its appended line removed
    const restored = read('fixtures/rewind.txt') === 'v1\n' && read('live/rw-new.txt') === null && read('fixtures/rewind-kept.txt') === 'k2\n';
    const commandUndone = read('live/rw-cmd.txt') === null;
    const turnsAfter = (await vscode.commands.executeCommand('codico.__evalTurns')).length;
    const mid = (await getLog()).length;
    await run('rw_after');
    // The next request is sent from where the second turn started: same conversation length, none of the later turns in it
    const second = await firstOf('rw_second', mark); const after = await firstOf('rw_after', mid);
    const cut = !!second && !!after && after.roles.length === second.roles.length && turnsBefore - turnsAfter === 2;
    // Undo Last Rewind brings back the files as they were just before it (the third turn's state)
    await vscode.commands.executeCommand('codico.undoRewind');
    const redone = read('fixtures/rewind.txt') === 'v3\n' && read('live/rw-cmd.txt') !== null && read('live/rw-new.txt') !== null;
    // …and the scenarios that follow start from the rewound state again
    await vscode.commands.executeCommand('codico.undoRewind');
    const back = read('fixtures/rewind.txt') === 'v1\n' && read('live/rw-cmd.txt') === null;
    results.push({ name: 'rewind', ms: Date.now() - t0, requests: 0, ok: changed && restored && commandUndone && cut && redone && back,
      why: `three turns changed the files: ${changed}; after rewinding to the second, its and the third's changes are undone and the first's kept: ${restored}; two turns left the conversation and the next request starts from there: ${cut}; what a terminal command created and appended is undone too: ${commandUndone}; Undo Last Rewind brings the pre-rewind files back, and again returns to the checkpoint: ${redone && back}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── Project hooks from .codico/hooks.json ──
  await scenario('hook_refuse', ({ read, reqs, text }) => {
    const told = /\[edit_file\] Refused by the project's beforeEdit hook "locked files": it exited with code 1, so hooked\/locked\.txt was not changed\.\nThe hook said:\nHOOK-SAYS this file is locked/.test(text);
    const unchanged = read('hooked/locked.txt') === 'locked=1\n';
    return { ok: told && unchanged && reqs.length === 2, why: `${reqs.length} requests; the model was told why: ${told}; the file is unchanged: ${unchanged}` };
  });
  await scenario('hook_after', ({ read, text }) => {
    // The hook ran after the edit was on disk, with the file name and the call as its input
    const reported = /Edit applied successfully[\s\S]*\[Project afterEdit hook "config check" failed \(exit 1\)\]\nHOOK-AFTER hooked\/app\.cfg now mode=b via edit_file/.test(text);
    const applied = read('hooked/app.cfg') === 'mode=b\n';
    return { ok: reported && applied, why: `the edit was applied: ${applied}; the hook's output follows the edit result: ${reported}` };
  });
  await scenario('hook_command', ({ read, text }) => {
    const told = /\[run_terminal\] Refused by the project's beforeCommand hook "node -e [^\n]*": it exited with code 2, so the command was not run\./.test(text);
    const notRun = read('live/hook-ran.txt') === null;
    return { ok: told && notRun, why: `the model was told: ${told}; the command did not run: ${notRun}` };
  });

  // ── Subagents: the delegate tool runs a second agent with its own conversation ──
  for (const [main, child, model, marker, sawFile] of [['sub_main', 'sub_child', 'deepseek/deepseek-v4-flash', 'SUBAGENT-FOUND', 'sawNotesFile'], ['subf_main', 'subf_child', 'ollama/fake-model', 'FENCED-SUB', 'sawConfigFile']]) {
    await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model, maxIterations: 12 });
    const before = (await getLog()).length; const t0 = Date.now(); let error = null;
    try { await vscode.commands.executeCommand('codico.__evalRunTask', `[SCENARIO:${main}] please do the task`); } catch (e) { error = String(e && e.message || e); }
    const log = (await getLog()).slice(before).filter(e => e.stream);
    const mainReqs = log.filter(e => e.scenario === main); const childReqs = log.filter(e => e.scenario === child);
    const followUp = mainReqs[1] || {};
    const reportBack = new RegExp(`Its reads are not in this conversation[\\s\\S]*## Subagent report\\n\\nREPORT: ${marker}`).test(followUp.lastText || followUp.lastUser || '');
    // The file the child read never enters the main conversation
    const isolated = mainReqs.length > 0 && mainReqs.every(r => !r[sawFile]) && childReqs.length === 2 && childReqs[1][sawFile];
    const ownPrompt = childReqs.length > 0 && childReqs.every(r => r.subagentPrompt) && mainReqs.every(r => !r.subagentPrompt);
    const native = model.startsWith('deepseek');
    const readOnly = !native || (!childReqs[0].toolNames.some(n => ['edit_file', 'write_file', 'run_terminal', 'delegate'].includes(n)) && childReqs[1].refusedTool && read('fixtures/sub-native.txt') === 'SUB-NATIVE-CONTENT\n');
    results.push({ name: main, ms: Date.now() - t0, requests: log.length, ok: !error && mainReqs.length === 2 && reportBack && isolated && ownPrompt && readOnly,
      why: `main ${mainReqs.length} requests, subagent ${childReqs.length}; report returned to the main agent: ${reportBack}; the file it read stayed out of the main conversation: ${isolated}; its own system prompt: ${ownPrompt}; read-only (edit refused, file unchanged): ${readOnly}${error ? '; error: ' + error : ''}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── Fewer requests: several looks in one reply, and reads that carry line numbers ──
  await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model: 'deepseek/deepseek-v4-flash', maxIterations: 12 });
  await scenario('batch_native', ({ reqs, error }) => {
    const second = reqs[1];
    const all = !!second && second.roles.filter(r => r === 'tool').length >= 3;
    return { ok: !error && reqs.length === 2 && all, why: `${reqs.length} requests for three tool calls (2 = one reply, one follow-up); all three results in the follow-up: ${all}` };
  });
  await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model: 'ollama/fake-model', maxIterations: 12 });
  await scenario('batch_fenced', ({ reqs, error }) => {
    const text = reqs[1] ? reqs[1].lastUser : '';
    // Numbered like cat -n, and a ranged read starts at its own line number
    const first = /1\tNOTES-MARKER/.test(text);
    const ranged = /lines 2–2 of \d+[^\n]*\n```\n2\tport=\d+\n```/.test(text);
    return { ok: !error && reqs.length === 2 && first && ranged, why: `${reqs.length} requests for two fenced reads; first file numbered from 1: ${first}; ranged read numbered from its own line: ${ranged}` };
  });
  await scenario('numbered_edit', ({ reqs, error }) => {
    const now = read('fixtures/numbered.txt');
    // The edit's result: numbered lines around the change
    const result = (reqs[2] || {}).lastUser || '';
    const numbered = /Edit applied successfully[\s\S]*numbered like read_file\):\n```\n1\talpha=1\n2\tbeta=20\n3\tgamma=30/.test(result);
    return { ok: !error && now === 'alpha=1\nbeta=20\ngamma=30\n' && numbered, why: `file after an edit pasted with line numbers: ${JSON.stringify(now)}; edit result numbered: ${numbered}` };
  });

  // ── Code block actions, as the panel sends them ──
  {
    const t0 = Date.now(); let why = ''; let ok = false;
    try {
      await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'codeBlock', action: 'newFile', code: 'const fresh: number = 1;\n', language: 'ts' });
      const created = vscode.window.activeTextEditor;
      const newFile = !!created && created.document.isUntitled && created.document.getText() === 'const fresh: number = 1;\n' && created.document.languageId === 'typescript';
      // Insert replaces the selection of the editor in use
      const doc = await vscode.workspace.openTextDocument(path.join(ws, 'fixtures/config.txt'));
      const editor = await vscode.window.showTextDocument(doc);
      const line = doc.lineAt(0);
      editor.selection = new vscode.Selection(line.range.start, line.range.end);
      await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'codeBlock', action: 'insert', code: 'INSERTED-LINE' });
      const inserted = doc.getText().startsWith('INSERTED-LINE\n') && !doc.getText().includes(line.text + '\nINSERTED');
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      ok = newFile && inserted;
      why = `New file opened untitled, in TypeScript, with the code: ${newFile}; Insert replaced the selected line: ${inserted}`;
    } catch (e) { why = 'threw: ' + (e && e.message || e); }
    results.push({ name: 'code_block_actions', ms: Date.now() - t0, requests: 0, ok, why });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── The change report: built from the files written and the commands run ──
  await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model: 'ollama/fake-model', maxIterations: 12 });
  await scenario('pp_fixed', ({ error }) => 0, 60000).catch(() => {});
  results.pop();
  {
    const p = await vscode.commands.executeCommand('codico.__evalPassport');
    const files = p ? p.files.map(f => `${f.path} ${f.status} +${f.added} -${f.removed}`) : [];
    const check = p && p.checks.find(c => /pp\.test\.js/.test(c.command));
    const ok = !!p && files.includes('fixtures/pp.txt modified +1 -1') && files.includes('live/pp-notes.txt created +2 -0') &&
      !!check && check.kind === 'test' && check.outcome === 'passed' && check.fixed && !check.stale && check.runs === 2 && /1 passed, 0 failed/.test(check.detail) &&
      read('fixtures/pp.txt') === 'value=2\n';
    results.push({ name: 'pp_fixed', ms: 0, requests: 0, ok,
      why: `verdict ${p && p.verdict}; files: ${files.join(' | ')}; test check: ${check ? `${check.outcome} (${check.detail}), was failing: ${check.fixed}, runs: ${check.runs}` : 'none'}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
  await scenario('pp_unchecked', ({ error }) => 0, 60000).catch(() => {});
  results.pop();
  {
    const p = await vscode.commands.executeCommand('codico.__evalPassport');
    const ok = !!p && p.files.length === 1 && p.files[0].path === 'live/pp-unchecked.txt' && p.files[0].status === 'created';
    results.push({ name: 'pp_unchecked', ms: 0, requests: 0, ok: ok && (p.verdict === 'unverified' || p.checks.length > 0),
      why: `verdict ${p && p.verdict}; files: ${p ? p.files.map(f => f.path).join(', ') : 'none'}; checks: ${p ? p.checks.map(c => c.command + ' ' + c.outcome).join(', ') || 'none' : 'none'}; notes: ${p ? p.notes.join(' / ') : ''}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── The project's own skills and agents, from the workspace's .codico folder ──
  await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model: 'ollama/fake-model', maxIterations: 12 });
  for (const [name, prompt, check] of [
    // An ordinary request: the skill is offered by name and path, its text and the agent are not sent
    ['sk_list', '[SCENARIO:sk_list] please do the task', r => r.skillsListed && !r.skillBodyInSystem && !r.badSkillInSystem && !r.agentInSystem && !/SKILL-BODY-MARKER/.test(r.lastUser)],
    // "/shout …" sends the skill's instructions with the request
    ['sk_run', '/shout [SCENARIO:sk_run] say hello', r => /^\[Skill: shout\][\s\S]*SKILL-BODY-MARKER[\s\S]*\[Request\]\n\[SCENARIO:sk_run\] say hello/.test(r.lastUser) || /\[Skill: shout\][\s\S]*SKILL-BODY-MARKER[\s\S]*\[Request\]\n\[SCENARIO:sk_run\] say hello/.test(r.lastUser)],
    // "@pirate …" puts the agent's instructions in the system prompt and takes the mention out of the request
    ['sk_agent', '@pirate [SCENARIO:sk_agent] say hello', r => r.agentInSystem && r.skillsListed && !/@pirate/.test(r.lastUser) && /\[SCENARIO:sk_agent\] say hello/.test(r.lastUser)],
  ]) {
    const before = (await getLog()).length; const t0 = Date.now(); let error = null;
    try { await vscode.commands.executeCommand('codico.__evalRunTask', prompt); } catch (e) { error = String(e && e.message || e); }
    const reqs = (await getLog()).slice(before).filter(e => e.scenario === name && e.stream);
    const ok = !error && reqs.length >= 1 && check(reqs[0]);
    const r = reqs[0] || {};
    results.push({ name, ms: Date.now() - t0, requests: reqs.length, ok,
      why: `skill listed in the system prompt: ${r.skillsListed}; skill text in the system prompt: ${r.skillBodyInSystem}; unusable skill loaded: ${r.badSkillInSystem}; agent in the system prompt: ${r.agentInSystem}; request sent: ${JSON.stringify((r.lastUser || '').slice(0, 90))}${error ? '; error: ' + error : ''}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── Claude Code as a provider: the agent loop through the `claude` command (a stand-in here) ──
  {
    const t0 = Date.now(); let error = null;
    await set('claudeCodePath', process.env.LIVE_FAKE_CLAUDE);
    await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: '', model: 'claude-code/sonnet', maxIterations: 12, directApiKeys: {} });
    try { await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:cc_tools] please do the task'); } catch (e) { error = String(e && e.message || e); }
    const calls = fs.existsSync(process.env.FAKE_CLAUDE_LOG) ? fs.readFileSync(process.env.FAKE_CLAUDE_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
    const [first, second] = calls;
    const noTools = !!first && first.args[first.args.indexOf('--tools') + 1] === '' && first.args[first.args.indexOf('--model') + 1] === 'sonnet';
    const fenced = !!first && /fenced-code-block formats/.test(first.args[first.args.indexOf('--system-prompt') + 1]);
    const resultBack = !!second && /<conversation>/.test(second.prompt) && /\[Tool Results\][\s\S]*NOTES-MARKER/.test(second.prompt);
    results.push({ name: 'cc_tools', ms: Date.now() - t0, requests: calls.length, ok: !error && calls.length === 2 && noTools && fenced && resultBack,
      why: `${calls.length} runs of claude; its own tools off, model sonnet: ${noTools}; Codico's tool format in the system prompt: ${fenced}; file read by Codico and sent back: ${resultBack}; no key needed: ${!error}${error ? ' (' + error + ')' : ''}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
  // ── ChatGPT as a provider: the agent loop through the `codex` command (a stand-in here) ──
  {
    const t0 = Date.now(); let error = null;
    await set('codexPath', process.env.LIVE_FAKE_CODEX);
    await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: '', model: 'chatgpt/gpt-5.5', maxIterations: 12, directApiKeys: {} });
    try { await vscode.commands.executeCommand('codico.__evalRunTask', '[SCENARIO:cx_tools] please do the task'); } catch (e) { error = String(e && e.message || e); }
    const calls = (fs.existsSync(process.env.FAKE_CODEX_LOG) ? fs.readFileSync(process.env.FAKE_CODEX_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []).filter(c => c.args[0] === 'exec');
    const [first, second] = calls;
    const after = (c, flag) => c.args[c.args.indexOf(flag) + 1];
    const locked = !!first && after(first, '-s') === 'read-only' && after(first, '-m') === 'gpt-5.5' && first.args.includes('shell_tool');
    const fenced = !!first && /fenced-code-block formats/.test(first.instructions || '');
    const resultBack = !!second && /<conversation>/.test(second.prompt) && /\[Tool Results\][\s\S]*NOTES-MARKER/.test(second.prompt);
    results.push({ name: 'cx_tools', ms: Date.now() - t0, requests: calls.length, ok: !error && calls.length === 2 && locked && fenced && resultBack,
      why: `${calls.length} runs of codex; read-only, its shell off, model gpt-5.5: ${locked}; Codico's tool format as its instructions: ${fenced}; file read by Codico and sent back: ${resultBack}; no key needed: ${!error}${error ? ' (' + error + ')' : ''}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
  await vscode.commands.executeCommand('codico.__evalConfigure', { openRouterApiKey: 'test-key', model: 'ollama/fake-model', maxIterations: 12 });

  // ── Agent team: /team makes this thread the orchestrator; a worker (its window simulated here) is waited for, merged and checked ──
  // Last: it makes the workspace a git repository, and the thread a team's
  {
    const t0 = Date.now(); const before = (await getLog()).length;
    const git = (...args) => require('node:child_process').execFileSync('git', args, { cwd: ws, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'main'); git('config', 'core.autocrlf', 'false'); git('config', 'user.email', 'live@example.com'); git('config', 'user.name', 'Live');
    git('add', '-A'); git('commit', '-q', '-m', 'workspace');
    const worktrees = path.join(ws, '..', 'team-worktrees');
    await set('backgroundTasksDirectory', worktrees);
    const lead = vscode.commands.executeCommand('codico.__evalRunTask', '/team [SCENARIO:team_lead] write the team file');
    // The worker's own window is not opened in tests: do its work and report as it would
    let worker;
    for (let i = 0; i < 100 && !worker; i++) {
      await new Promise(r => setTimeout(r, 200));
      worker = (await vscode.commands.executeCommand('codico.__evalBackground') || []).find(t => t.team && t.role === 'developer');
    }
    const isolated = !!worker && worker.worktree.startsWith(worktrees) && fs.existsSync(path.join(worker.worktree, 'fixtures/config.txt')) && !fs.existsSync(path.join(ws, 'live/team-result.txt'));
    if (worker) {
      fs.writeFileSync(path.join(worker.worktree, 'live/team-result.txt'), 'TEAM-WORK\n');
      await vscode.commands.executeCommand('codico.__evalBackground', { ...worker, status: 'finished', heartbeat: Date.now(), report: 'Wrote live/team-result.txt; checked it with cat.' });
    }
    let error = null;
    try { await Promise.race([lead, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 90 s')), 90000))]); } catch (e) { error = String(e && e.message || e); }
    const reqs = (await getLog()).slice(before).filter(e => e.scenario === 'team_lead' && e.stream);
    const said = reqs.map(r => r.lastUser).join('\n');
    const started = /\[team start\] Started worker [0-9a-f]{8} \(developer\)/.test(said);
    const reported = /\[team wait\] All of them have stopped[\s\S]*live\/team-result\.txt[\s\S]*Report:\nWrote live\/team-result\.txt/.test(said);
    const merged = /\[team merge\] Merged worker [\s\S]*Acceptance gate/.test(said) && (read('live/team-result.txt') || '').trim() === 'TEAM-WORK';
    const checked = /TEAM-WORK/.test((reqs[4] || {}).lastUser || '');
    const listed = ((await vscode.commands.executeCommand('codico.__evalBackground')) || []).find(t => worker && t.id === worker.id) || {};
    try { git('worktree', 'remove', '--force', worker.worktree); } catch { /* reported by the checks */ }
    fs.rmSync(path.join(ws, '.git'), { recursive: true, force: true });
    await set('backgroundTasksDirectory', undefined);
    results.push({ name: 'agent_team', ms: Date.now() - t0, requests: reqs.length, ok: !error && started && isolated && reported && merged && listed.merged === true && checked,
      why: `the worker started in its own worktree, outside the workspace: ${started && isolated}; the wait returned its changes and report: ${reported}; merged into the workspace with the acceptance gate asked for: ${merged}; recorded as merged: ${listed.merged === true}; the result was checked in the workspace: ${checked}${error ? '; error: ' + error : ''}` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  // ── A team's worker, in its own window: it reports, then answers a message from the orchestrator and reports again ──
  {
    const t0 = Date.now(); const before = (await getLog()).length; const now = Date.now();
    await vscode.commands.executeCommand('codico.__evalWebviewMessage', { type: 'createThread' });
    const task = { id: 'fe12cd34ab567890', prompt: '[SCENARIO:team_worker] what do the tests of the parser say?', repoRoot: path.join(ws, '..', 'origin-repo'), worktree: ws,
      branch: 'codico/test-the-parser-fe12cd', baseCommit: '0123456789abcdef', permissions: 'edits', status: 'starting', createdAt: now, updatedAt: now, role: 'tester', team: 'lead-thread' };
    const done = await vscode.commands.executeCommand('codico.__evalBackground', task) || {};
    const first = done.status === 'finished' && /Tests pass: 3 of 3/.test(done.report || '');
    const briefed = /\[Team: tester\]/.test(((await getLog()).slice(before).find(e => e.scenario === 'team_worker') || {}).lastUser || '');
    // The orchestrator's message, as its team tool writes it
    const listed = ((await vscode.commands.executeCommand('codico.__evalBackground')) || []).find(t => t.id === task.id);
    const saveOnly = { ...listed, worktree: path.join(ws, '..', 'not-this-window'), inbox: [{ at: Date.now(), text: '[SCENARIO:team_followup] Check the empty input too.' }], status: 'running' };
    await vscode.commands.executeCommand('codico.__evalBackground', saveOnly);
    let after;
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 200));
      after = ((await vscode.commands.executeCommand('codico.__evalBackground')) || []).find(t => t.id === task.id) || {};
      if (/empty input/.test(after.report || '') && after.status === 'finished') { break; }
    }
    const answered = after.status === 'finished' && /Checked the empty input too/.test(after.report || '') && after.inboxRead === 1;
    const sent = /\[Message from the orchestrator\]\n\[SCENARIO:team_followup\]/.test(((await getLog()).slice(before).find(e => e.scenario === 'team_followup') || {}).lastUser || '');
    results.push({ name: 'team_worker', ms: Date.now() - t0, requests: (await getLog()).length - before, ok: first && briefed && answered && sent,
      why: `told it is the team's tester: ${briefed}; finished with its reply as the report: ${first}; the orchestrator's message reached it as a new message: ${sent}; its answer became the report, and the message counts as read: ${answered} (${after.status}, read ${after.inboxRead}, first report ${JSON.stringify(done.report)}, last ${JSON.stringify(after.report)})` });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
}
module.exports = { run };

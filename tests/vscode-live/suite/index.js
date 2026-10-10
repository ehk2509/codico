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
}
module.exports = { run };

// Minimal stdio MCP server for tests. Usage: node fakeMcpServer.js <mode> <statusFile>
//   normal     - pings the client with an id equal to the client's pending tools/list id
//   badhandshake - answers initialize with an error and keeps running
//   deaf       - after tools/list, stops reading its input, then exits shortly after
const fs = require('node:fs');
const [mode, statusFile] = process.argv.slice(2);
const status = { pid: process.pid, pingAnswered: false, cancelled: null };
// Written atomically: the test may read the file while it is being replaced
const save = () => { if (statusFile) { fs.writeFileSync(statusFile + '.tmp', JSON.stringify(status)); fs.renameSync(statusFile + '.tmp', statusFile); } };
save();
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { handle(JSON.parse(line)); }
  }
});
function handle(msg) {
  if (msg.id === 900 && msg.result) { status.pingAnswered = true; save(); return; }
  if (msg.method === 'notifications/cancelled') { status.cancelled = msg.params; save(); return; }
  if (msg.method === 'initialize') {
    if (mode === 'badhandshake') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'refusing' } }); return; }
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake' } } });
    return;
  }
  if (msg.method === 'tools/list') {
    // A server request that reuses the client's own pending id must not be taken as the reply
    if (mode === 'normal') { send({ jsonrpc: '2.0', id: msg.id, method: 'ping' }); send({ jsonrpc: '2.0', id: 900, method: 'ping' }); }
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } });
    if (mode === 'deaf') { process.stdin.destroy(); setTimeout(() => process.exit(0), 300); }
    return;
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    if (name === 'slow') { return; } // never answers; cancelled through notifications/cancelled
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: name === 'big' ? 'x'.repeat(args.size) : String(args.text) }] } });
  }
}

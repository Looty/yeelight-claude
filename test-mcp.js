// Drives mcp-server.js over stdio like an MCP client would, against the real lights.
// Usage: node test-mcp.js '<tool>' '<json args>' ['<tool>' '<json args>' ...]   (pauses 4s between calls)
const { spawn } = require('child_process');
const path = require('path');

const srv = spawn(process.execPath, [path.join(__dirname, 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '', id = 0;
const pending = {};
srv.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (pending[msg.id]) { pending[msg.id](msg); delete pending[msg.id]; }
  }
});
const rpc = (method, params) => new Promise((res) => { const i = ++id; pending[i] = res; srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const r = await rpc('tools/call', { name: args[i], arguments: JSON.parse(args[i + 1] || '{}') });
    const out = r.error ? 'RPC ERROR ' + JSON.stringify(r.error) : (r.result.isError ? 'TOOL ERROR: ' : '') + r.result.content.map((c) => c.text).join('\n');
    console.log(`--- ${args[i]} ${args[i + 1] || ''}\n${out}`);
    if (i + 2 < args.length) await sleep(4000);
  }
  srv.stdin.end();
  setTimeout(() => process.exit(0), 500);
})();

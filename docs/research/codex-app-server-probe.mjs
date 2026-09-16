import { spawn } from 'node:child_process';
const child = spawn('codex', ['app-server'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
const lines = [];
let buf = '';
child.stdout.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
let err = '';
child.stderr.on('data', (d) => { err += d.toString(); });
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'styx-probe', title: 'Styx probe', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } } });
send({ jsonrpc: '2.0', method: 'initialized' });
setTimeout(() => {
  send({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} });
  send({ jsonrpc: '2.0', id: 3, method: 'account/read', params: { refreshToken: false } });
  send({ jsonrpc: '2.0', id: 4, method: 'getAuthStatus', params: { includeToken: false, refreshToken: false } });
  send({ jsonrpc: '2.0', id: 5, method: 'thread/start', params: { cwd: process.cwd(), ephemeral: true, sandbox: 'read-only', approvalPolicy: 'on-request' } });
  send({ jsonrpc: '2.0', id: 6, method: 'skills/list', params: { cwds: [process.cwd()] } });
  send({ jsonrpc: '2.0', id: 7, method: 'permissionProfile/list', params: {} });
}, 500);
setTimeout(() => {
  child.kill();
  const trunc = (s, n = 700) => (s.length > n ? s.slice(0, n) + ' …[' + s.length + ' chars]' : s);
  for (const l of lines) {
    try { const o = JSON.parse(l); const key = o.id !== undefined ? `id=${o.id}` : `notif=${o.method}`; console.log(key, trunc(JSON.stringify(o.result ?? o.error ?? o.params))); } catch { console.log('raw', trunc(l)); }
  }
  console.log('STDERR', trunc(err, 600));
  process.exit(0);
}, 12000);

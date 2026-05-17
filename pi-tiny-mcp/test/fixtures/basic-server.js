#!/usr/bin/env node
const tools = [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', chunk => { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); } });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function handle(msg) {
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'basic', version: '1' } } });
  else if (msg.method === 'notifications/initialized') {}
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(msg.params.arguments.text) }], isError: false } });
  else if (msg.method === 'ping') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } });
}

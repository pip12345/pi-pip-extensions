#!/usr/bin/env node
let connected = false;
const staticTools = [{ name: 'connect_instance', description: 'Connect and add dynamic tool', inputSchema: { type: 'object', properties: {} } }];
const dynamicTools = [...staticTools, { name: 'decompile_function', description: 'Decompile function', inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] } }];
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', chunk => { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); } });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function handle(msg) {
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'dynamic', version: '1' } } });
  else if (msg.method === 'notifications/initialized') {}
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: connected ? dynamicTools : staticTools } });
  else if (msg.method === 'tools/call' && msg.params.name === 'connect_instance') { connected = true; send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'connected' }] } }); setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }), 10); }
  else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'decompiled ' + msg.params.arguments.address }] } });
  else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } });
}

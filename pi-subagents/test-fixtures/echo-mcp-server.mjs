// Minimal MCP stdio server for tests: newline-delimited JSON-RPC with one `echo` tool.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Optional argument: a file to receive this process's pid, so tests can check it exits.
if (process.argv[2]) writeFileSync(process.argv[2], String(process.pid));

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    send({ id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } } });
  } else if (request.method === "tools/list") {
    send({ id: request.id, result: { tools: [{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  } else if (request.method === "tools/call") {
    send({ id: request.id, result: { content: [{ type: "text", text: `echo: ${request.params.arguments.text}` }] } });
  } else if (request.method === "ping") {
    send({ id: request.id, result: {} });
  } else {
    send({ id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
  }
});

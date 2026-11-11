#!/usr/bin/env node
// Protocol fixture only. It never reads credentials, opens network connections, or executes tools.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv.slice(-2).join(" ") === "auth status") {
  if (process.env.CLAUDE_FIXTURE_AUTH_LOG) appendFileSync(process.env.CLAUDE_FIXTURE_AUTH_LOG, "status\n");
  if (process.env.CLAUDE_FIXTURE_AUTH_FAIL) process.exit(2);
  const loggedIn = !process.env.CLAUDE_FIXTURE_LOGGED_OUT;
  console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none" }));
  process.exit(loggedIn ? 0 : 1);
}

let initialize;
let requestID = 0;
let messageID = 0;
let turns = 0;
const waiting = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const response = (id, value = {}) => send({ type: "control_response", response: { subtype: "success", request_id: id, response: value } });
const request = (value) => new Promise((resolve, reject) => {
  const id = `fixture-${++requestID}`;
  waiting.set(id, { resolve, reject });
  send({ type: "control_request", request_id: id, request: value });
});
const mcp = async (message) => (await request({ subtype: "mcp_message", server_name: "pi", message })).mcp_response;
const result = () => send({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "done", num_turns: 1, usage: { input_tokens: 9, output_tokens: 3 } });
function reply(text, call) {
  const id = `native-${++messageID}`;
  const usage = { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const message = { id, model: "claude-sonnet-5-5", usage };
  const event = (event) => send({ type: "stream_event", parent_tool_use_id: null, event });
  event({ type: "message_start", message });
  if (text) {
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    event({ type: "content_block_stop", index: 0 });
  }
  send({ type: "assistant", uuid: `uuid-${id}`, session_id: "fixture-session", parent_tool_use_id: null, message: { ...message, content: [...(text ? [{ type: "text", text }] : []), ...(call ? [{ type: "tool_use", ...call }] : [])] } });
  event({ type: "message_delta", usage, delta: { stop_reason: call ? "tool_use" : "end_turn" } });
  event({ type: "message_stop" });
}
async function handle(message) {
  if (message.type === "control_response") {
    const call = waiting.get(message.response.request_id);
    waiting.delete(message.response.request_id);
    if (message.response.subtype === "error") call?.reject(new Error(message.response.error));
    else call?.resolve(message.response.response ?? {});
    return;
  }
  if (message.type === "control_request") {
    switch (message.request.subtype) {
      case "initialize":
        initialize = message.request;
        response(message.request_id, {
          commands: [], agents: [], claude_code_version: process.env.CLAUDE_FIXTURE_VERSION ?? "2.1.301",
          account: process.env.CLAUDE_FIXTURE_LOGGED_OUT ? { tokenSource: "none", apiProvider: "firstParty" } : { apiProvider: "firstParty", subscriptionType: "Claude Max" },
          models: [{ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet", description: "", supportedEffortLevels: ["low", "medium", "high", "max"], supportsThinkingOff: false }],
        });
        break;
      case "get_context_usage": response(message.request_id, { rawMaxTokens: 1_000_000 }); break;
      case "interrupt": response(message.request_id); result(); break;
      default: response(message.request_id);
    }
    return;
  }
  if (message.type === "user") {
    turns++;
    const hasTools = initialize.sdkMcpServers?.includes("pi");
    send({ type: "system", subtype: "init", mcp_servers: hasTools ? [{ name: "pi", status: "connected" }] : [] });
    if (hasTools && turns === 1) {
      await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });
      await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
      const list = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const name = list.result.tools[0].name;
      for (const group of initialize.hooks?.PreToolUse ?? []) {
        for (const id of group.hookCallbackIds) await request({ subtype: "hook_callback", callback_id: id, input: { hook_event_name: "PreToolUse", tool_use_id: "native-call", tool_name: `mcp__pi__${name}`, tool_input: { path: "example" } } });
      }
      reply("", { id: "native-call", name: `mcp__pi__${name}`, input: { path: "example" } });
      const output = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: { path: "example" } } });
      reply(`Pi returned: ${output.result.content[0].text}`);
    } else reply("native SDK response 🦊");
    result();
  }
}
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  void handle(JSON.parse(line)).catch((error) => {
    send({ type: "result", subtype: "error_during_execution", is_error: true, errors: [error.message], usage: {} });
  });
});

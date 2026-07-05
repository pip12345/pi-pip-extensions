export type TinyMcpTransportType = "stdio" | "http" | "streamable-http" | "sse";

export interface TinyMcpServerConfig {
  type?: TinyMcpTransportType;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  disabled?: boolean;
}

export interface TinyMcpConfig {
  settings?: Record<string, unknown>;
  mcpServers: Record<string, TinyMcpServerConfig>;
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  _meta?: Record<string, unknown>;
}

export interface VisibleToolInfo {
  visibleName: string;
  serverName: string;
  originalName: string;
  description: string;
  inputSchema?: unknown;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpCallResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export type ServerStatus = "disconnected" | "connecting" | "connected" | "error";

export interface MockPi {
  tools: Map<string, any>;
  commands: Map<string, any>;
  handlers: Map<string, any[]>;
  shortcuts: Map<string, any>;
  messages: any[];
  userMessages: any[];
  entries: any[];
  events: object;
  registerTool(tool: any): void;
  registerCommand(name: string, command: any): void;
  registerShortcut(shortcut: string, shortcutDef: any): void;
  on(event: string, handler: any): void;
  sendMessage(message: any, options?: any): void;
  sendUserMessage(message: any, options?: any): void;
  appendEntry(customType: string, data?: any): void;
}

export function createMockPi(): MockPi {
  return {
    tools: new Map(),
    commands: new Map(),
    handlers: new Map(),
    shortcuts: new Map(),
    messages: [],
    userMessages: [],
    entries: [],
    events: {},
    registerTool(tool: any) {
      this.tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      this.commands.set(name, command);
    },
    registerShortcut(shortcut: string, shortcutDef: any) {
      this.shortcuts.set(shortcut, shortcutDef);
    },
    on(event: string, handler: any) {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    },
    sendMessage(message: any, options?: any) {
      this.messages.push({ message, options });
    },
    sendUserMessage(message: any, options?: any) {
      this.userMessages.push({ message, options });
    },
    appendEntry(customType: string, data?: any) {
      this.entries.push({ customType, data });
    },
  };
}

export function createMockSessionManager(entries: any[] = [], leafId?: string) {
  return {
    getEntries: () => entries,
    getBranch: () => entries,
    getLeafId: () => leafId ?? entries.at(-1)?.id,
    getSessionFile: () => undefined,
    getLabel: (id: string) => entries.find((entry) => entry.type === "label" && entry.targetId === id)?.label,
  };
}

export function createMockCtx(options: any = {}) {
  const entries = options.entries ?? [];
  const ctx: any = {
    cwd: options.cwd ?? process.cwd(),
    hasUI: options.hasUI ?? true,
    model: options.model,
    signal: options.signal,
    sessionManager: options.sessionManager ?? createMockSessionManager(entries, options.leafId),
    ui: {
      notifications: [] as any[],
      statuses: new Map<string, string>(),
      widgets: new Map<string, any>(),
      editorText: "",
      notify(message: string, level = "info") {
        this.notifications.push({ message, level });
      },
      confirm: async () => options.confirm ?? true,
      select: async (_title: string, choices: any[]) => options.select ?? choices?.[0],
      input: async () => options.input ?? "",
      editor: async (_title: string, value: string) => options.editor ?? value,
      setStatus(key: string, value: string) {
        this.statuses.set(key, value);
      },
      setWidget(key: string, value: any) {
        this.widgets.set(key, value);
      },
      setEditorText(value: string) {
        this.editorText = value;
      },
      custom: options.custom ?? (async () => undefined),
    },
    isIdle: () => options.idle ?? true,
    isProjectTrusted: () => options.projectTrusted ?? true,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    reload: async () => {
      options.reloaded = true;
    },
    switchSession: async (sessionPath: string, switchOptions: any = {}) => {
      options.switchedSession = sessionPath;
      await switchOptions.withSession?.(options.replacementCtx ?? ctx);
      return { cancelled: false };
    },
    getContextUsage: () => options.contextUsage,
    getSystemPrompt: () => options.systemPrompt ?? "",
    getSystemPromptOptions: options.systemPromptOptions === undefined ? undefined : () => options.systemPromptOptions,
  };
  return ctx;
}

export async function emitEvent(pi: MockPi, eventName: string, event: any = {}, ctx: any = createMockCtx()) {
  const results = [];
  for (const handler of pi.handlers.get(eventName) ?? []) results.push(await handler(event, ctx));
  return results;
}

export async function runCommand(pi: MockPi, name: string, args = "", ctx: any = createMockCtx()) {
  const command = pi.commands.get(name);
  if (!command) throw new Error(`Command not registered: ${name}`);
  return command.handler(args, ctx);
}

export function getRegisteredCommand(pi: MockPi, name: string) {
  return pi.commands.get(name);
}

export function getRegisteredTool(pi: MockPi, name: string) {
  return pi.tools.get(name);
}

export function getRegisteredShortcut(pi: MockPi, shortcut: string) {
  return pi.shortcuts.get(shortcut);
}

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { boxLines, branchEntries, firstResultText, hasTuiCustom, PipCustomComponent, registerPipTool, registerSettingsSection, restoreLatestCustomState, setting, settingsFor, themeFg, truncateToWidth } from "../pip-common/index.ts";

export type TodoStatus = "pending" | "active" | "done";

export interface TodoItem {
  id: number;
  text: string;
  status: TodoStatus;
}

export interface TodoState {
  todos: TodoItem[];
  nextId: number;
  updatedAt: number;
}

type ShowCompleted = "smart" | "always" | "never";
type DoneStyle = "strike+dim" | "dim" | "plain";
type Placement = "above" | "below";

const SETTINGS_ID = "todo";
const CUSTOM_TYPE = "pip.todo.state";
const WIDGET_KEY = "pi-todo";
const STATUSES = ["pending", "active", "done"] as const;

registerSettingsSection({
  id: SETTINGS_ID,
  title: "Todo",
  description: "Minimal session todo tools and compact widget.",
  order: 40,
  settings: {
    enabled: setting.boolean({ label: "Enabled", default: true, order: 1, description: "Enable todo tools, the /todo command, and the compact todo widget." }),
    compactRows: setting.enum({ label: "Compact rows", default: "4", choices: ["2", "3", "4", "6"] as const, order: 2, description: "Fixed height for the always-on todo widget while todos exist." }),
    showCompleted: setting.enum({ label: "Show completed", default: "smart", choices: ["smart", "always", "never"] as const, order: 3, description: "Controls whether completed todos appear in the compact widget." }),
    hideWhenAllDone: setting.boolean({ label: "Hide when all done", default: false, order: 4, description: "Hide the compact widget once every todo is marked done." }),
    doneStyle: setting.enum({ label: "Done style", default: "strike+dim", choices: ["strike+dim", "dim", "plain"] as const, order: 5, description: "Visual style for completed todo text in the compact widget and /todo view." }),
    placement: setting.enum({ label: "Placement", default: "above", choices: ["above", "below"] as const, order: 6, description: "Place the compact todo widget above or below the editor." }),
  },
});

const scopedSettings = settingsFor(SETTINGS_ID);
const settingValue = scopedSettings.get;

function emptyState(): TodoState {
  return { todos: [], nextId: 1, updatedAt: Date.now() };
}

function isStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

function normalizeTodos(input: Array<Partial<TodoItem> & { text?: unknown; status?: unknown }>, startId = 1): TodoState {
  let nextId = Math.max(1, startId);
  let activeSeen = false;
  const todos: TodoItem[] = [];

  for (const raw of input) {
    const text = String(raw.text ?? "").trim();
    if (!text) continue;
    const explicitId = typeof raw.id === "number" && Number.isInteger(raw.id) && raw.id > 0 ? raw.id : undefined;
    const id = explicitId ?? nextId++;
    nextId = Math.max(nextId, id + 1);
    let status: TodoStatus = isStatus(raw.status) ? raw.status : "pending";
    if (status === "active") {
      if (activeSeen) status = "pending";
      else activeSeen = true;
    }
    todos.push({ id, text, status });
  }

  return { todos, nextId: Math.max(nextId, 1), updatedAt: Date.now() };
}

function cloneState(state: TodoState): TodoState {
  return { todos: state.todos.map((todo) => ({ ...todo })), nextId: state.nextId, updatedAt: state.updatedAt };
}

function normalizeState(data: any): TodoState {
  if (!data || typeof data !== "object" || !Array.isArray(data.todos)) return emptyState();
  const startId = typeof data.nextId === "number" ? data.nextId : 1;
  const state = normalizeTodos(data.todos, startId);
  state.updatedAt = typeof data.updatedAt === "number" ? data.updatedAt : Date.now();
  return state;
}

export function stateFromBranch(entries: any[]): TodoState {
  return restoreLatestCustomState(entries, CUSTOM_TYPE, normalizeState, emptyState);
}

function stateSummary(todos: TodoItem[]): string {
  const active = todos.filter((todo) => todo.status === "active").length;
  const done = todos.filter((todo) => todo.status === "done").length;
  const pending = todos.length - active - done;
  const parts = [`${todos.length} todo${todos.length === 1 ? "" : "s"}`];
  if (active) parts.push(`${active} active`);
  if (pending) parts.push(`${pending} pending`);
  if (done) parts.push(`${done} done`);
  return parts.join(", ");
}

function strike(value: string): string {
  return `\x1b[9m${value}\x1b[29m`;
}

function renderTodoText(todo: TodoItem, theme: any, doneStyle: DoneStyle): string {
  if (todo.status !== "done") return todo.text;
  if (doneStyle === "plain") return todo.text;
  const text = doneStyle === "strike+dim" ? strike(todo.text) : todo.text;
  return themeFg(theme, "dim", text);
}

function renderIcon(todo: TodoItem, theme: any): string {
  if (todo.status === "done") return themeFg(theme, "success", "✔");
  if (todo.status === "active") return themeFg(theme, "success", "●");
  return themeFg(theme, "muted", "□");
}

function chooseVisibleTodos(todos: TodoItem[], rows: number, showCompleted: ShowCompleted): { items: TodoItem[]; hiddenAbove: number; hiddenBelow: number } {
  const maxItems = Math.max(1, rows);
  const indexed = todos.map((todo, index) => ({ todo, index }));
  let candidates = indexed;
  if (showCompleted === "never") candidates = indexed.filter((item) => item.todo.status !== "done");

  if (candidates.length === 0) return { items: [], hiddenAbove: 0, hiddenBelow: 0 };
  if (candidates.length <= maxItems) {
    const first = candidates[0].index;
    const last = candidates[candidates.length - 1].index;
    return { items: candidates.map((item) => item.todo), hiddenAbove: first, hiddenBelow: Math.max(0, todos.length - last - 1) };
  }

  const itemSlots = Math.max(1, maxItems - 1);
  const activeIndex = candidates.findIndex((item) => item.todo.status === "active");

  let start = 0;
  if (activeIndex >= 0) start = Math.max(0, Math.min(activeIndex - Math.floor(itemSlots / 2), candidates.length - itemSlots));
  else if (showCompleted === "smart") {
    const firstPending = candidates.findIndex((item) => item.todo.status === "pending");
    start = Math.max(0, firstPending);
  }

  const slice = candidates.slice(start, start + itemSlots);
  const first = slice[0]?.index ?? 0;
  const last = slice.at(-1)?.index ?? -1;
  return { items: slice.map((item) => item.todo), hiddenAbove: first, hiddenBelow: Math.max(0, todos.length - last - 1) };
}

export function renderCompactTodos(state: TodoState, width: number, theme: any = {}, options: { rows?: number; showCompleted?: ShowCompleted; doneStyle?: DoneStyle; hideWhenAllDone?: boolean } = {}): string[] {
  const rows = options.rows ?? 4;
  const showCompleted = options.showCompleted ?? "smart";
  const doneStyle = options.doneStyle ?? "strike+dim";
  const hideWhenAllDone = options.hideWhenAllDone ?? false;
  const todos = state.todos;
  if (!todos.length) return [];
  if (hideWhenAllDone && todos.every((todo) => todo.status === "done")) return [];

  const { items, hiddenAbove, hiddenBelow } = chooseVisibleTodos(todos, rows, showCompleted);
  if (!items.length) return [];
  const displayRows: Array<TodoItem | { overflow: string }> = [...items];
  const overflowParts = [hiddenBelow > 0 ? `${hiddenBelow} below` : ""].filter(Boolean);
  if (overflowParts.length && displayRows.length < rows) displayRows.push({ overflow: overflowParts.join(" · ") });
  else if (overflowParts.length && displayRows.length === rows) displayRows[displayRows.length - 1] = { overflow: overflowParts.join(" · ") };
  if (!displayRows.length) return [];

  const visibleCount = displayRows.length;
  const rail = (glyph: string) => themeFg(theme, "borderMuted", glyph);
  const lines = displayRows.map((row, index) => {
    if ("overflow" in row) {
      const prefix = visibleCount === 1 ? rail("╴") : rail(index === 0 ? "╭" : index === visibleCount - 1 ? "╰" : "├");
      return truncateToWidth(`${prefix} ${themeFg(theme, "dim", `… ${row.overflow}`)}`, width);
    }

    const prefix = visibleCount === 1 ? rail("╴") : rail(index === 0 ? "╭" : index === visibleCount - 1 ? "╰" : "├");
    return truncateToWidth(`${prefix} ${renderIcon(row, theme)} ${themeFg(theme, "accent", `#${row.id}`)} ${renderTodoText(row, theme, doneStyle)}`, width);
  });

  while (lines.length < rows) lines.push("");
  return lines.slice(0, rows);
}

function compactList(todos: TodoItem[]): string {
  if (!todos.length) return "No todos";
  return todos.map((todo) => `[${todo.status}] #${todo.id} ${todo.text}`).join("\n");
}

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function statesEqual(a: TodoState, b: TodoState): boolean {
  return JSON.stringify(a.todos) === JSON.stringify(b.todos) && a.nextId === b.nextId;
}

function findTodoIndex(todos: TodoItem[], update: { id?: number; match?: string }): number {
  if (update.id !== undefined) return validId(update.id) ? todos.findIndex((todo) => todo.id === update.id) : -1;
  const match = update.match?.trim().toLowerCase();
  if (!match) return -1;
  return todos.findIndex((todo) => todo.text.toLowerCase().includes(match));
}

function applyUpdates(state: TodoState, updates: Array<{ id?: number; match?: string; text?: string; status?: TodoStatus }>): { state: TodoState; updated: number; errors: string[]; changed: boolean } {
  const next = cloneState(state);
  let updated = 0;
  const errors: string[] = [];

  for (const update of updates) {
    const hasSelector = validId(update.id) || Boolean(update.match?.trim());
    const hasMutation = (typeof update.text === "string" && update.text.trim().length > 0) || Boolean(update.status);
    if (!hasSelector) {
      errors.push("Update requires id or match");
      continue;
    }
    if (!hasMutation) {
      errors.push(update.id !== undefined ? `No change specified for #${update.id}` : `No change specified for ${JSON.stringify(update.match)}`);
      continue;
    }

    const index = findTodoIndex(next.todos, update);
    if (index < 0) {
      errors.push(update.id !== undefined ? `No todo matched id #${update.id}` : `No todo matched: ${JSON.stringify(update.match ?? "")}`);
      continue;
    }
    const todo = next.todos[index];
    if (typeof update.text === "string") {
      const text = update.text.trim();
      if (text) todo.text = text;
    }
    if (update.status) {
      if (update.status === "active") for (const other of next.todos) if (other.status === "active") other.status = "pending";
      todo.status = update.status;
    }
    updated++;
  }

  next.updatedAt = Date.now();
  const normalized = normalizeState(next);
  return { state: normalized, updated, errors, changed: !statesEqual(state, normalized) };
}

class TodoInspector extends PipCustomComponent<void> {
  private selected = 0;

  constructor(tui: any, theme: any, done: () => void, private getState: () => TodoState, private mutate: (state: TodoState) => void) {
    super(tui, theme, done, { closeKeys: ["escape", "ctrl+c", "ctrl+d", "q", "Q"] });
  }

  protected handleKey(key: string): void {
    const state = this.getState();
    if (key === "up" || key === "k") this.selected = Math.max(0, this.selected - 1);
    else if (key === "down" || key === "j") this.selected = Math.min(Math.max(0, state.todos.length - 1), this.selected + 1);
    else if (key === "space") {
      const next = cloneState(state);
      const todo = next.todos[this.selected];
      if (todo) {
        todo.status = todo.status === "pending" ? "active" : todo.status === "active" ? "done" : "pending";
        if (todo.status === "active") for (const other of next.todos) if (other !== todo && other.status === "active") other.status = "pending";
        this.mutate(normalizeState(next));
      }
    } else if (key === "d") {
      const next = cloneState(state);
      next.todos.splice(this.selected, 1);
      this.selected = Math.max(0, Math.min(this.selected, next.todos.length - 1));
      this.mutate(normalizeState(next));
    } else if (key === "c") {
      const next = cloneState(state);
      next.todos = next.todos.filter((todo) => todo.status !== "done");
      this.selected = Math.max(0, Math.min(this.selected, next.todos.length - 1));
      this.mutate(normalizeState(next));
    }
    this.requestRender();
  }

  render(width: number): string[] {
    const state = this.getState();
    const th = this.theme;
    const bodyWidth = Math.max(1, width);
    const innerWidth = bodyWidth - 4;
    const lines: string[] = [themeFg(th, "dim", "j/k move · space cycle · d delete · c clear done · q close"), ""];
    if (!state.todos.length) lines.push(themeFg(th, "dim", "No todos."));
    for (const [index, todo] of state.todos.entries()) {
      const marker = index === this.selected ? themeFg(th, "accent", "›") : " ";
      lines.push(truncateToWidth(`${marker} ${renderIcon(todo, th)} ${themeFg(th, "accent", `#${todo.id}`)} ${renderTodoText(todo, th, "strike+dim")}`, innerWidth));
    }
    return boxLines(lines, bodyWidth, th, { title: "Todos" });
  }
}

const TodoWriteParams = Type.Object({
  todos: Type.Array(
    Type.Object({
      text: Type.String({ description: "Todo text" }),
      status: Type.Optional(StringEnum(["pending", "active", "done"] as const)),
    }),
    { description: "Full replacement todo list" }
  ),
});

const TodoUpdateParams = Type.Object({
  updates: Type.Array(
    Type.Object({
      id: Type.Optional(Type.Number({ description: "Todo id" })),
      match: Type.Optional(Type.String({ description: "Case-insensitive text match if id is omitted" })),
      text: Type.Optional(Type.String({ description: "New todo text" })),
      status: Type.Optional(StringEnum(["pending", "active", "done"] as const)),
    }),
    { description: "Batch todo updates" }
  ),
});

function normalTodoWriteCall(args: any, theme: any): Text {
  return new Text(themeFg(theme, "toolTitle", `todo_write`) + themeFg(theme, "muted", ` ${(args.todos ?? []).length} todos`), 0, 0);
}

function normalTodoUpdateCall(args: any, theme: any): Text {
  return new Text(themeFg(theme, "toolTitle", `todo_update`) + themeFg(theme, "muted", ` ${(args.updates ?? []).length} updates`), 0, 0);
}

function normalTodoReadCall(theme: any): Text {
  return new Text(themeFg(theme, "toolTitle", "todo_read"), 0, 0);
}

function normalTodoSuccessResult(result: any, theme: any): Text {
  return new Text(themeFg(theme, "success", "✓ ") + themeFg(theme, "muted", firstResultText(result) || "todos updated"), 0, 0);
}

function normalTodoUpdateResult(result: any, theme: any): Text {
  const errors = result?.details?.errors?.length;
  return new Text(themeFg(theme, errors ? "warning" : "success", errors ? "⚠ " : "✓ ") + themeFg(theme, "muted", firstResultText(result) || "todos updated"), 0, 0);
}

function normalTodoReadResult(state: TodoState, theme: any): Text {
  return new Text(themeFg(theme, "muted", stateSummary(state.todos)), 0, 0);
}

export default function todoExtension(pi: ExtensionAPI) {
  let state = emptyState();
  let currentCtx: any;

  const refreshWidget = (ctx = currentCtx) => {
    currentCtx = ctx;
    if (!ctx?.ui?.setWidget) return;
    if (!settingValue("enabled", true)) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const rows = Number(settingValue<string>("compactRows", "4"));
    const showCompleted = settingValue<ShowCompleted>("showCompleted", "smart");
    const doneStyle = settingValue<DoneStyle>("doneStyle", "strike+dim");
    const hideWhenAllDone = settingValue<boolean>("hideWhenAllDone", false);
    const linesFactory = (_tui: any, theme: any) => ({
      invalidate() {},
      render(width: number) {
        return renderCompactTodos(state, width, theme, { rows, showCompleted, doneStyle, hideWhenAllDone });
      },
    });
    const rendered = renderCompactTodos(state, 80, {}, { rows, showCompleted, doneStyle, hideWhenAllDone });
    if (!rendered.length) ctx.ui.setWidget(WIDGET_KEY, undefined);
    else ctx.ui.setWidget(WIDGET_KEY, linesFactory, { placement: settingValue<Placement>("placement", "above") === "below" ? "belowEditor" : "aboveEditor" });
  };

  const persist = (next: TodoState, ctx = currentCtx) => {
    state = normalizeState(next);
    pi.appendEntry(CUSTOM_TYPE, cloneState(state));
    refreshWidget(ctx);
  };

  const reconstruct = (ctx: any) => {
    currentCtx = ctx;
    state = stateFromBranch(branchEntries(ctx));
    refreshWidget(ctx);
  };

  pi.on("session_start", async (_event: any, ctx: any) => reconstruct(ctx));
  pi.on("session_tree", async (_event: any, ctx: any) => reconstruct(ctx));
  pi.on("session_shutdown", async (_event: any, ctx: any) => ctx?.ui?.setWidget?.(WIDGET_KEY, undefined));

  registerPipTool(pi, {
    tool: {
    name: "todo_write",
    label: "Todo Write",
    description: "Batch create, replace, or clear the session todo list.",
    promptSnippet: "Batch create or replace the session todo list",
    promptGuidelines: [
      "Use todo_write for complex multi-step work or when the user asks for todos; skip todos for trivial one-step or informational requests.",
      "Use todo_write to set multiple todos at once; use todo_update to mark existing todos active/done or edit them in batches.",
      "Use todo_read only when you need to recover the current todo state.",
      "Keep at most one todo active.",
    ],
    parameters: TodoWriteParams,
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const next = normalizeTodos(params.todos ?? []);
      persist(next, ctx);
      return { content: [{ type: "text", text: `Set ${stateSummary(state.todos)}` }], details: cloneState(state) };
    },
    renderCall(args: any, theme: any) {
      return normalTodoWriteCall(args, theme);
    },
    renderResult(result: any, _options: any, theme: any) {
      return normalTodoSuccessResult(result, theme);
    },
    },
    metadata: {
      pluginId: "todo",
      label: "Todo write",
      display: {
        kind: "mutation",
        call: (args) => `${args?.todos?.length ?? 0} todos`,
        expandedResult: (result) => compactList(result?.details?.todos ?? []),
        hideSuccessfulResult: true,
      },
    },
  });

  registerPipTool(pi, {
    tool: {
    name: "todo_update",
    label: "Todo Update",
    description: "Batch update existing session todos by id or text match.",
    promptSnippet: "Batch update existing session todos by id or text match",
    parameters: TodoUpdateParams,
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const result = applyUpdates(state, params.updates ?? []);
      if (result.changed) persist(result.state, ctx);
      const suffix = result.errors.length ? ` (${result.errors.join("; ")})` : "";
      return { content: [{ type: "text", text: `Updated ${result.updated} todo${result.updated === 1 ? "" : "s"}${suffix}` }], details: { ...cloneState(result.changed ? state : result.state), errors: result.errors, updated: result.updated } };
    },
    renderCall(args: any, theme: any) {
      return normalTodoUpdateCall(args, theme);
    },
    renderResult(result: any, _options: any, theme: any) {
      return normalTodoUpdateResult(result, theme);
    },
    },
    metadata: {
      pluginId: "todo",
      label: "Todo update",
      display: {
        kind: "mutation",
        call: (args) => `${args?.updates?.length ?? 0} updates`,
        result: (result) => (result?.details?.errors?.length ? firstResultText(result) : undefined),
        expandedResult: (result) => compactList(result?.details?.todos ?? []),
        hideSuccessfulResult: true,
      },
    },
  });

  registerPipTool(pi, {
    tool: {
    name: "todo_read",
    label: "Todo Read",
    description: "Read the current session todo list.",
    promptSnippet: "Read the current session todo list",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: compactList(state.todos) }], details: cloneState(state) };
    },
    renderCall(_args: any, theme: any) {
      return normalTodoReadCall(theme);
    },
    renderResult(_result: any, _options: any, theme: any) {
      return normalTodoReadResult(state, theme);
    },
    },
    metadata: {
      pluginId: "todo",
      label: "Todo read",
      display: {
        kind: "query",
        expandedResult: (result) => compactList(result?.details?.todos ?? []),
        hideSuccessfulResult: true,
      },
    },
  });

  pi.registerCommand("todo", {
    description: "Inspect and edit session todos",
    handler: async (args: string, ctx: any) => {
      currentCtx = ctx;
      const [cmd = "", first = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const textRest = [first, ...rest].join(" ").trim();

      const byId = (idText: string) => state.todos.find((todo) => todo.id === Number(idText));
      if (cmd === "add" && textRest) persist(normalizeState({ ...state, todos: [...state.todos, { id: state.nextId, text: textRest, status: "pending" }], nextId: state.nextId + 1 }), ctx);
      else if (cmd === "edit" && first && rest.join(" ").trim()) {
        const todo = byId(first);
        if (todo) persist({ ...state, todos: state.todos.map((item) => (item.id === todo.id ? { ...item, text: rest.join(" ").trim() } : item)), updatedAt: Date.now() }, ctx);
        else ctx.ui?.notify?.(`Todo #${first} not found`, "warning");
      } else if (["done", "active", "pending"].includes(cmd) && first) {
        const status = cmd as TodoStatus;
        const result = applyUpdates(state, [{ id: Number(first), status }]);
        if (result.changed) persist(result.state, ctx);
        else ctx.ui?.notify?.(result.errors[0] ?? `Todo #${first} not changed`, "warning");
      } else if (cmd === "delete" && first) {
        const id = Number(first);
        if (!validId(id) || !state.todos.some((todo) => todo.id === id)) ctx.ui?.notify?.(`Todo #${first} not found`, "warning");
        else persist({ ...state, todos: state.todos.filter((todo) => todo.id !== id), updatedAt: Date.now() }, ctx);
      }
      else if (cmd === "clear-done") persist({ ...state, todos: state.todos.filter((todo) => todo.status !== "done"), updatedAt: Date.now() }, ctx);
      else if (cmd === "clear") persist(emptyState(), ctx);
      else if (cmd) ctx.ui?.notify?.(`Unknown /todo command: ${cmd}`, "warning");
      else if (hasTuiCustom(ctx)) {
        await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => new TodoInspector(tui, theme, done, () => state, (next) => persist(next, ctx)), {
          overlay: true,
          overlayOptions: { anchor: "center", width: "70%", maxHeight: "80%", minWidth: 50 },
        });
      } else ctx.ui?.notify?.(compactList(state.todos), "info");

      refreshWidget(ctx);
    },
  });
}

export const __test = { SETTINGS_ID, CUSTOM_TYPE, WIDGET_KEY, normalizeTodos, applyUpdates, compactList };

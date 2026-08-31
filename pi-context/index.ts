import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import {
  boxLines,
  formatTokenCount,
  normalizeUsage,
  freshInputTokensFromUsage,
  padAnsi,
  padLeftAnsi,
  hasTuiCustom,
  PipCustomComponent,
  scrollForKey,
  scrollWindow,
  textFromContent,
  truncateToWidth,
  wrapAnsi,
  type TokenUsage,
} from "../pip-common/index.ts";

type ExtensionAPI = any;
type Theme = any;
type View = "context" | "prompt";

interface PromptInspectorSection {
  key: string;
  label: string;
  detail: string;
  content: string;
}

interface SizeInfo {
  chars: number;
  lines: number;
  bytes: number;
  estimatedTokens: number;
}

interface ContextSection extends SizeInfo {
  key: string;
  label: string;
  detail: string;
}

interface ContextSnapshot {
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  contextWindow: number;
  latestUsage?: TokenUsage;
  maxOutputTokens: number;
  sections: ContextSection[];
  systemPrompt: string;
  options: any;
}

function sizeOf(value: string): SizeInfo {
  const chars = value.length;
  return {
    chars,
    lines: value ? value.split(/\r?\n/).length : 0,
    bytes: Buffer.byteLength(value, "utf8"),
    estimatedTokens: Math.ceil(chars / 4),
  };
}

function section(key: string, label: string, detail: string, content: string): ContextSection {
  return { key, label, detail, ...sizeOf(content) };
}

function joinRecord(record: any): string {
  if (!record || typeof record !== "object") return "";
  return Object.entries(record)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
}

function skillTitle(skill: any): string {
  return String(skill?.name ?? skill?.frontmatter?.name ?? skill?.title ?? skill?.path ?? "skill");
}

function skillText(skill: any): string {
  return [skillTitle(skill), skill?.description, skill?.frontmatter?.description, skill?.content, skill?.body].filter(Boolean).map(String).join("\n");
}

function promptOptionsSections(options: any, systemPrompt: string): ContextSection[] {
  if (!options) return [section("effective", "Effective prompt", "full assembled", systemPrompt)];
  const selectedTools = Array.isArray(options.selectedTools) ? options.selectedTools.join("\n") : "";
  const snippets = joinRecord(options.toolSnippets);
  const guidelines = Array.isArray(options.promptGuidelines) ? options.promptGuidelines.join("\n") : "";
  const contextFiles = Array.isArray(options.contextFiles)
    ? options.contextFiles.map((file: any) => `# ${file.path ?? "context"}\n${file.content ?? ""}`).join("\n\n")
    : "";
  const skills = Array.isArray(options.skills) ? options.skills.map(skillText).join("\n\n") : "";
  const rows = [section("effective", "Effective prompt", "full assembled", systemPrompt)];
  if (options.customPrompt) rows.push(section("custom", "Custom prompt", "source input", String(options.customPrompt)));
  rows.push(
    section("tools", "Tools", `${Array.isArray(options.selectedTools) ? options.selectedTools.length : 0} selected`, [selectedTools, snippets, guidelines].filter(Boolean).join("\n\n")),
    section("files", "Context files", `${Array.isArray(options.contextFiles) ? options.contextFiles.length : 0} file(s)`, contextFiles),
    section("skills", "Skills", `${Array.isArray(options.skills) ? options.skills.length : 0} loaded`, skills),
    section("append", "Appended prompt", options.appendSystemPrompt ? "present" : "none", String(options.appendSystemPrompt ?? ""))
  );
  return rows;
}

function sessionEntries(ctx: any): any[] {
  return ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
}

function effectiveContextMessages(ctx: any): any[] {
  const built = ctx.sessionManager?.buildSessionContext?.();
  if (Array.isArray(built?.messages)) return built.messages;
  const entries = ctx.sessionManager?.getEntries?.();
  if (Array.isArray(entries)) return buildSessionContext(entries, ctx.sessionManager?.getLeafId?.()).messages;
  return sessionEntries(ctx).flatMap((entry) => entry?.message ? [entry.message] : []);
}

function latestObservedUsage(ctx: any): TokenUsage | undefined {
  for (const entry of [...sessionEntries(ctx)].reverse()) {
    const msg = entry?.message ?? entry?.messages?.[0];
    if (msg?.role !== "assistant" || msg.stopReason === "aborted" || msg.stopReason === "error") continue;
    const usage = normalizeUsage(msg.usage);
    if (usage) return usage;
  }
  return undefined;
}

function buildConversationSection(ctx: any): ContextSection {
  const messages = effectiveContextMessages(ctx);
  const text = messages.map((message) => `${message.role}: ${textFromContent(message.content)}`).join("\n\n");
  return section("conversation", "Conversation", `${messages.length} effective messages`, text);
}

function buildContextSnapshot(ctx: any): ContextSnapshot {
  const systemPrompt = String(ctx.getSystemPrompt?.() ?? "");
  const options = ctx.getSystemPromptOptions?.();
  const contextUsage = ctx.getContextUsage?.();
  const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  return {
    contextUsage,
    contextWindow,
    latestUsage: latestObservedUsage(ctx),
    maxOutputTokens: Math.max(0, Number(ctx.model?.maxTokens ?? 0) || 0),
    sections: [...promptOptionsSections(options, systemPrompt), buildConversationSection(ctx)],
    systemPrompt,
    options,
  };
}

function fmt(n: number): string {
  return formatTokenCount(Math.max(0, n));
}

function pctText(value: number | null | undefined): string {
  return typeof value === "number" ? `${Math.round(value)}%` : "?";
}

function bar(value: number | null | undefined, width: number, theme: Theme): string {
  const pct = typeof value === "number" ? Math.max(0, Math.min(100, value)) : 0;
  const filled = Math.round((pct / 100) * width);
  const color = pct >= 90 ? "error" : pct >= 70 ? "warning" : "accent";
  return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
}

function sizeText(size: SizeInfo): string {
  return `${size.chars.toLocaleString()} chars · ${size.lines.toLocaleString()} lines · ${size.bytes.toLocaleString()} bytes · ~${fmt(size.estimatedTokens)} tok`;
}

function sectionTokens(snapshot: ContextSnapshot, key: string): number {
  return snapshot.sections.find((s) => s.key === key)?.estimatedTokens ?? 0;
}

interface AllocationItem {
  key: string;
  label: string;
  glyph: string;
  color: string;
  tokens: number;
}

function contextPercent(tokens: number, contextWindow: number): number {
  return contextWindow > 0 ? (tokens / contextWindow) * 100 : 0;
}

function buildAllocationItems(snapshot: ContextSnapshot): AllocationItem[] {
  const contextWindow = snapshot.contextWindow;
  const observedUsed = typeof snapshot.contextUsage?.tokens === "number" ? snapshot.contextUsage.tokens : undefined;
  const tools = sectionTokens(snapshot, "tools");
  const files = sectionTokens(snapshot, "files");
  const skills = sectionTokens(snapshot, "skills");
  const append = sectionTokens(snapshot, "append");
  const effective = sectionTokens(snapshot, "effective");
  const maxOutput = snapshot.maxOutputTokens;
  const system = Math.max(0, effective - tools - files - skills - append);
  const estimatedMessages = sectionTokens(snapshot, "conversation");
  const nonMessages = system + tools + files + skills + append + maxOutput;
  const messages = Math.max(estimatedMessages, (observedUsed ?? 0) - nonMessages);
  const free = Math.max(0, contextWindow - Math.max(observedUsed ?? 0, nonMessages + messages));

  return [
    { key: "system", label: "System prompt", glyph: "◉", color: "accent", tokens: system },
    { key: "tools", label: "System tools", glyph: "◎", color: "dim", tokens: tools + append },
    { key: "max-output", label: "Max output cap", glyph: "▧", color: "warning", tokens: maxOutput },
    { key: "files", label: "Context files", glyph: "◍", color: "success", tokens: files },
    { key: "skills", label: "Skills", glyph: "◌", color: "success", tokens: skills },
    { key: "messages", label: "Messages", glyph: "◈", color: "accent", tokens: messages },
    { key: "free", label: "Free space", glyph: "□", color: "dim", tokens: free },
  ];
}

function allocationGrid(items: AllocationItem[], contextWindow: number, theme: Theme): string[] {
  const width = 10;
  const height = 10;
  const cells = width * height;
  if (contextWindow <= 0) return Array.from({ length: height }, () => theme.fg("dim", "□".repeat(width)));
  const out: string[] = [];
  const weighted = items.map((item) => ({ item, cells: Math.max(0, Math.round((item.tokens / contextWindow) * cells)) }));
  let used = weighted.reduce((sum, row) => sum + row.cells, 0);
  const freeRow = weighted.find((row) => row.item.key === "free");
  if (freeRow) freeRow.cells = Math.max(0, freeRow.cells + (cells - used));
  used = 0;
  const flat: string[] = [];
  for (const row of weighted) {
    const count = Math.min(cells - used, row.cells);
    for (let i = 0; i < count; i++) flat.push(theme.fg(row.item.color, row.item.glyph));
    used += count;
    if (used >= cells) break;
  }
  while (flat.length < cells) flat.push(theme.fg("dim", "□"));
  for (let y = 0; y < height; y++) out.push(flat.slice(y * width, y * width + width).join(" "));
  return out;
}

function renderClaudeStylePanel(snapshot: ContextSnapshot, width: number, theme: Theme): string[] {
  const used = snapshot.contextUsage?.tokens;
  const percent = snapshot.contextUsage?.percent;
  const items = buildAllocationItems(snapshot);
  const lines: string[] = [];
  lines.push("");
  lines.push(theme.fg("accent", `Context Usage ${used == null ? "?" : fmt(used)}/${fmt(snapshot.contextWindow)} tokens (${pctText(percent)})`));
  const grid = allocationGrid(items, snapshot.contextWindow, theme);
  const legend = items.map((item) => `${theme.fg(item.color, item.glyph)} ${padAnsi(item.label + ":", 16)} ${fmt(item.tokens)} tokens (${contextPercent(item.tokens, snapshot.contextWindow).toFixed(1)}%)`);
  const rows = Math.max(grid.length, legend.length);
  for (let i = 0; i < rows; i++) lines.push(`${padAnsi(grid[i] ?? "", 22)} ${legend[i] ?? ""}`);

  const files = snapshot.options?.contextFiles;
  if (Array.isArray(files) && files.length) {
    lines.push("");
    lines.push(theme.fg("accent", "Context files"));
    for (const file of files.slice(0, 4)) lines.push(`└ ${truncateToWidth(String(file.path ?? "context"), Math.max(20, width - 18))}: ~${fmt(sizeOf(String(file.content ?? "")).estimatedTokens)} tokens`);
    if (files.length > 4) lines.push(theme.fg("dim", `└ ${files.length - 4} more file(s)`));
  }

  const skills = snapshot.options?.skills;
  if (Array.isArray(skills) && skills.length) {
    lines.push("");
    lines.push(theme.fg("accent", "Skills"));
    for (const skill of skills.slice(0, 4)) lines.push(`└ ${truncateToWidth(skillTitle(skill), Math.max(20, width - 18))}: ~${fmt(sizeOf(skillText(skill)).estimatedTokens)} tokens`);
    if (skills.length > 4) lines.push(theme.fg("dim", `└ ${skills.length - 4} more skill(s)`));
  }
  return lines;
}

function promptSectionContent(section: PromptInspectorSection, width: number): string[] {
  const inner = Math.max(20, width - 4);
  return section.content.split(/\r?\n/).flatMap((line) => (line ? wrapAnsi(line, inner) : [""]));
}

function buildPromptInspectorSections(snapshot: ContextSnapshot): PromptInspectorSection[] {
  const options = snapshot.options;
  const sections: PromptInspectorSection[] = [{ key: "effective", label: "System", detail: "full assembled system prompt", content: snapshot.systemPrompt }];
  if (!options) return sections;

  if (options.customPrompt) sections.push({ key: "custom", label: "Custom", detail: "custom system prompt source", content: String(options.customPrompt) });

  const selectedTools = Array.isArray(options.selectedTools) ? options.selectedTools : [];
  const snippets = options.toolSnippets && typeof options.toolSnippets === "object" ? options.toolSnippets : {};
  const toolsContent = selectedTools
    .map((name: string) => {
      const snippet = snippets[name];
      return snippet ? `${name}: ${String(snippet)}` : String(name);
    })
    .join("\n");
  sections.push({ key: "tools", label: "Tools", detail: `${selectedTools.length} selected`, content: toolsContent });

  const guidelines = Array.isArray(options.promptGuidelines) ? options.promptGuidelines.map((line: any) => `- ${String(line)}`).join("\n") : "";
  sections.push({ key: "guidelines", label: "Guidelines", detail: `${Array.isArray(options.promptGuidelines) ? options.promptGuidelines.length : 0} guideline(s)`, content: guidelines });

  const files = Array.isArray(options.contextFiles) ? options.contextFiles : [];
  sections.push({
    key: "files",
    label: "Context files",
    detail: `${files.length} file(s)`,
    content: files.map((file: any) => `# ${file.path ?? "context"}\n${file.content ?? ""}`).join("\n\n"),
  });

  const skills = Array.isArray(options.skills) ? options.skills : [];
  sections.push({ key: "skills", label: "Skills", detail: `${skills.length} loaded`, content: skills.map(skillText).join("\n\n") });
  sections.push({ key: "append", label: "Append", detail: options.appendSystemPrompt ? "present" : "none", content: String(options.appendSystemPrompt ?? "") });
  return sections;
}

function promptInspectorLines(snapshot: ContextSnapshot, width: number, theme: Theme, scroll: number, sectionIndex: number): string[] {
  const inner = Math.max(20, width - 4);
  const sections = buildPromptInspectorSections(snapshot);
  const selectedIndex = Math.max(0, Math.min(sections.length - 1, sectionIndex));
  const selected = sections[selectedIndex];
  const lines: string[] = [];
  lines.push(`${theme.fg("accent", "Prompt inspector")} ${theme.fg("dim", "· tab/h/l sections · b back · q close · ↑/↓ scroll")}`);
  lines.push(theme.fg("dim", "Shows Pi's effective system prompt and loaded source prompt pieces; provider payload rewrites after this may differ."));
  if (!snapshot.options) lines.push(theme.fg("warning", "Structured prompt options unavailable; only effective prompt is available."));
  lines.push("");
  lines.push(
    sections
      .map((section, i) => (i === selectedIndex ? theme.fg("accent", `[${section.label}]`) : section.label))
      .join(theme.fg("dim", "  "))
  );
  lines.push(theme.fg("dim", `${selected.detail} · ${sizeText(sizeOf(selected.content))}`));
  lines.push("");
  const content = promptSectionContent(selected, width);
  const visible = scrollWindow(content, scroll, 28);
  if (!content.length || (content.length === 1 && content[0] === "")) lines.push(theme.fg("dim", "(empty)"));
  else lines.push(...visible.items.map((line) => truncateToWidth(line, inner)));
  if (content.length > 28) lines.push(theme.fg("dim", `showing ${visible.offset + 1}-${visible.end} of ${content.length}`));
  return lines;
}

class ContextInspector extends PipCustomComponent<void> {
  private view: View = "context";
  private promptScroll = 0;
  private promptSection = 0;
  private lastRenderWidth = 100;
  private readonly ctx: any;

  constructor(tui: any, ctx: any, theme: Theme, done: () => void) {
    super(tui, theme, done, { closeKeys: ["escape", "ctrl+c", "ctrl+d", "q"] });
    this.ctx = ctx;
  }

  protected handleKey(key: string): void {
    const snapshot = buildContextSnapshot(this.ctx);
    if (this.view === "prompt") {
      const sections = buildPromptInspectorSections(snapshot);
      if (key === "b") this.view = "context";
      else if (key === "tab" || key === "right" || key === "l") {
        this.promptSection = (this.promptSection + 1) % sections.length;
        this.promptScroll = 0;
      } else if (key === "left" || key === "h") {
        this.promptSection = (this.promptSection - 1 + sections.length) % sections.length;
        this.promptScroll = 0;
      } else {
        const selected = sections[Math.max(0, Math.min(sections.length - 1, this.promptSection))];
        this.promptScroll = scrollForKey(key, this.promptScroll, promptSectionContent(selected, this.lastRenderWidth).length, 28) ?? this.promptScroll;
      }
      this.requestRender();
      return;
    }

    if (key === "p") {
      this.view = "prompt";
      this.promptScroll = 0;
      this.promptSection = 0;
      this.requestRender();
    }
  }

  render(width: number): string[] {
    this.lastRenderWidth = width;
    const snapshot = buildContextSnapshot(this.ctx);
    const lines = this.view === "prompt" ? promptInspectorLines(snapshot, width, this.theme, this.promptScroll, this.promptSection) : this.renderContext(snapshot, width);
    return boxLines(lines, Math.max(1, width), this.theme, { title: this.view === "prompt" ? " Prompt " : " Context " });
  }

  private renderContext(snapshot: ContextSnapshot, width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    const used = snapshot.contextUsage?.tokens;
    const percent = snapshot.contextUsage?.percent;
    lines.push(`${th.fg("accent", "Context inspector")} ${th.fg("dim", "· p prompt · q close")}`);
    lines.push(`${th.fg("dim", "total")} ${used == null ? "?" : fmt(used)}/${fmt(snapshot.contextWindow)} ${pctText(percent)}  ${bar(percent, 18, th)}`);
    if (snapshot.latestUsage) {
      lines.push(`${th.fg("dim", "latest observed")} input ${fmt(freshInputTokensFromUsage(snapshot.latestUsage))} · cached ${fmt(snapshot.latestUsage.cacheRead)} · output ${fmt(snapshot.latestUsage.output)} · total ${fmt(snapshot.latestUsage.total)}`);
    } else {
      lines.push(th.fg("dim", "latest observed unavailable until an assistant response records usage"));
    }
    lines.push("");
    lines.push(th.fg("accent", "Breakdown") + th.fg("dim", "  effective compacted conversation + prompt source sizes; not additive; ~tokens are estimates"));
    const maxTokens = Math.max(1, ...snapshot.sections.map((s) => s.estimatedTokens));
    for (const s of snapshot.sections) {
      const pct = (s.estimatedTokens / maxTokens) * 100;
      lines.push(`${padAnsi(s.label, 18)} ${padLeftAnsi(`~${fmt(s.estimatedTokens)}`, 8)} ${bar(pct, 10, th)}  ${th.fg("dim", `${s.detail} · ${s.chars.toLocaleString()} chars`)}`);
    }
    lines.push(...renderClaudeStylePanel(snapshot, width, th));
    lines.push(th.fg("dim", "Max output cap is the model's response limit; Pi's compaction reserve is separate and not exposed here."));
    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("context", {
    description: "Open context usage and prompt inspector",
    handler: async (_args: string, ctx: any) => {
      if (!hasTuiCustom(ctx)) {
        ctx.ui?.notify?.("/context requires interactive UI", "error");
        return;
      }
      await (ctx.ui.custom as any)((tui: any, theme: Theme, _kb: any, done: () => void) => new ContextInspector(tui, ctx, theme, done), {
        overlay: true,
        overlayOptions: { anchor: "center", width: "92%", maxHeight: "85%", minWidth: 90 },
      });
    },
  });
}

export const __test = { buildContextSnapshot, latestObservedUsage, buildPromptInspectorSections, promptOptionsSections, promptSectionContent, sizeOf, ContextInspector };

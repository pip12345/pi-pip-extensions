import { PipCustomComponent } from "./custom-component.ts";
import { truncateToWidth } from "./keys.ts";
import { createSettingsRegistry, pipSettings, type SettingsRegistry, type SettingRow } from "./settings.ts";
import { boxLines, padAnsi, themeFg, wrapAnsi } from "./tui.ts";

function valueColor(row: SettingRow, value: string, theme: any, registry: SettingsRegistry): string {
  const current = registry.get(row.path);
  if (row.definition.type === "boolean") return themeFg(theme, current ? "success" : "dim", value);
  return themeFg(theme, "accent", value);
}

interface PipSettingsResult {
  dirty: boolean;
  values: Record<string, Record<string, unknown>>;
}

function createDraftRegistry(registry: SettingsRegistry): SettingsRegistry {
  const draft = createSettingsRegistry(registry.all(), { persistPath: false });
  for (const section of registry.sections()) draft.registerSection(section);
  return draft;
}

function settingsEqual(a: Record<string, Record<string, unknown>>, b: Record<string, Record<string, unknown>>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function applySettingsValues(registry: SettingsRegistry, values: Record<string, Record<string, unknown>>): void {
  for (const row of registry.rows()) {
    if (Object.hasOwn(values[row.section.id] ?? {}, row.key)) registry.set(row.path, values[row.section.id][row.key]);
  }
}

class PipSettingsComponent extends PipCustomComponent<PipSettingsResult> {
  private selected = 0;
  private scroll = 0;
  private readonly originalValues: Record<string, Record<string, unknown>>;

  constructor(tui: any, theme: any, done: (result?: PipSettingsResult) => void, private registry: SettingsRegistry = pipSettings) {
    super(tui, theme, done, { closeKeys: ["escape", "ctrl+c", "ctrl+d", "q", "Q"] });
    this.originalValues = registry.all();
  }

  protected override close(result?: PipSettingsResult): void {
    const values = this.registry.all();
    super.close(result ?? { dirty: !settingsEqual(this.originalValues, values), values });
  }

  protected handleKey(key: string): void {
    const rows = this.registry.rows();
    let changed = false;

    if (key === "up" || key === "k") {
      this.move(-1);
      changed = true;
    } else if (key === "down" || key === "j") {
      this.move(1);
      changed = true;
    } else if (key === "right" || key === "l" || key === "return") {
      const row = rows[this.selected];
      if (row) changed = this.edit(row, 1);
    } else if (key === "left" || key === "h") {
      const row = rows[this.selected];
      if (row) changed = this.edit(row, -1);
    } else if (key === "r") {
      const row = rows[this.selected];
      if (row) {
        this.registry.reset(row.path);
        changed = true;
      }
    }

    if (changed) this.requestRender();
  }

  private edit(row: SettingRow, direction: 1 | -1): boolean {
    if (this.registry.choices(row.path).length) return this.registry.cycle(row.path, direction);
    if (row.definition.type === "number" && row.definition.step) {
      const current = Number(this.registry.get(row.path));
      const next = Math.max(row.definition.min ?? -Infinity, Math.min(row.definition.max ?? Infinity, current + row.definition.step * direction));
      this.registry.set(row.path, next);
      return true;
    }
    return false;
  }

  private move(delta: number): void {
    const count = this.registry.rows().length;
    this.selected = Math.max(0, Math.min(Math.max(0, count - 1), this.selected + delta));
    const pageSize = 18;
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + pageSize) this.scroll = this.selected - pageSize + 1;
  }

  render(width: number): string[] {
    const bodyWidth = Math.max(50, Math.min(width - 4, 100));
    const rows = this.registry.rows();
    const theme = this.theme;
    const lines: string[] = [];

    const dirty = !settingsEqual(this.originalValues, this.registry.all());
    lines.push(themeFg(theme, "accent", "Pip Settings") + themeFg(theme, "dim", `  q close · j/k move · enter/←/→ change · r reset${dirty ? " · unsaved" : ""}`));
    lines.push("");

    if (!rows.length) {
      lines.push(themeFg(theme, "dim", "No pip settings registered."));
      return boxLines(lines, bodyWidth, theme);
    }

    const selectedRow = rows[this.selected];
    if (selectedRow?.definition.description) {
      for (const line of wrapAnsi(selectedRow.definition.description, bodyWidth - 4)) {
        lines.push(`  ${themeFg(theme, "dim", line)}`);
      }
      lines.push("");
    }

    const visibleRows = rows.slice(this.scroll, this.scroll + 16);
    let previousSection = "";
    for (const row of visibleRows) {
      if (row.section.id !== previousSection) {
        if (previousSection) lines.push("");
        lines.push(themeFg(theme, "accent", row.section.title));
        if (row.section.description) lines.push(`  ${themeFg(theme, "dim", truncateToWidth(row.section.description, bodyWidth - 4))}`);
        previousSection = row.section.id;
      }

      const realIndex = rows.indexOf(row);
      const selected = realIndex === this.selected;
      const marker = selected ? themeFg(theme, "accent", "›") : " ";
      const label = this.registry.settingLabel(row);
      const value = this.registry.valueLabel(row.path);
      const left = `  ${marker} ${padAnsi(label + ":", 28)}`;
      const rendered = `${left} ${valueColor(row, value, theme, this.registry)}`;
      lines.push(truncateToWidth(rendered, bodyWidth - 2));
    }

    if (rows.length > 16) lines.push(themeFg(theme, "dim", `${this.selected + 1}/${rows.length}`));
    return boxLines(lines, bodyWidth, theme);
  }
}

export function createPipSettingsComponent(tui: any, theme: any, done: (result?: PipSettingsResult) => void, registry: SettingsRegistry = pipSettings) {
  return new PipSettingsComponent(tui, theme, done, createDraftRegistry(registry));
}

export function registerPipSettingsCommand(pi: any, registry: SettingsRegistry = pipSettings): void {
  pi.registerCommand("pip-settings", {
    description: "Configure pip extension settings",
    handler: async (_args: string, ctx: any) => {
      if (!ctx.ui?.custom) {
        ctx.ui?.notify?.("/pip-settings requires interactive UI", "warning");
        return;
      }
      const result = await (ctx.ui.custom as any)((tui: any, theme: any, _kb: any, done: (result?: PipSettingsResult) => void) => createPipSettingsComponent(tui, theme, done, registry), {
        overlay: true,
        overlayOptions: { anchor: "center", width: "80%", maxHeight: "85%", minWidth: 60 },
      });
      if (!result?.dirty) return;
      const choice = await ctx.ui.select?.("Save pip settings?", ["No, discard changes", "Yes, save changes"]);
      if (choice === "Yes, save changes") {
        applySettingsValues(registry, result.values);
        ctx.ui.notify?.("Saved pip settings", "info");
      } else {
        ctx.ui.notify?.("Discarded pip settings changes", "info");
      }
    },
  });
}

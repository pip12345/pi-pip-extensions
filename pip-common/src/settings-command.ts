import { PipCustomComponent } from "./custom-component.ts";
import { hasTuiCustom } from "./pi-api.ts";
import { truncateToWidth } from "./keys.ts";
import { moveSelection, selectionOffset } from "./scroll.ts";
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

const MAX_VISIBLE_SETTING_ROWS = 30;
const MIN_VISIBLE_SETTING_ROWS = 8;
const SETTINGS_OVERLAY_MAX_HEIGHT_RATIO = 0.85;
const SETTINGS_CHROME_LINES = 8;

type SettingsDisplayRow = { kind: "section"; section: ReturnType<SettingsRegistry["sections"]>[number] } | { kind: "setting"; row: SettingRow };

function buildDisplayRows(registry: SettingsRegistry): SettingsDisplayRow[] {
  const out: SettingsDisplayRow[] = [];
  for (const section of registry.sections()) {
    out.push({ kind: "section", section });
    const settings = registry.rows().filter((row) => row.section.id === section.id);
    for (const row of settings) out.push({ kind: "setting", row });
  }
  return out;
}

function firstSettingIndex(rows: SettingsDisplayRow[]): number {
  const index = rows.findIndex((row) => row.kind === "setting");
  return Math.max(0, index);
}

class PipSettingsComponent extends PipCustomComponent<PipSettingsResult> {
  private selected = 1;
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
    const displayRows = buildDisplayRows(this.registry);
    const selectedItem = displayRows[this.selected];
    const selectedRow = selectedItem?.kind === "setting" ? selectedItem.row : undefined;
    let changed = false;

    if (key === "up" || key === "k") {
      this.move(-1);
      changed = true;
    } else if (key === "down" || key === "j") {
      this.move(1);
      changed = true;
    } else if (key === "right" || key === "l" || key === "return") {
      if (selectedRow) changed = this.edit(selectedRow, 1);
    } else if (key === "left" || key === "h") {
      if (selectedRow) changed = this.edit(selectedRow, -1);
    } else if (key === "r") {
      if (selectedRow) {
        this.registry.reset(selectedRow.path);
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

  private visibleSettingRows(): number {
    return this.overlayRowBudget({
      maxRows: MAX_VISIBLE_SETTING_ROWS,
      minRows: MIN_VISIBLE_SETTING_ROWS,
      reservedRows: SETTINGS_CHROME_LINES,
      maxHeightRatio: SETTINGS_OVERLAY_MAX_HEIGHT_RATIO,
    });
  }

  private move(delta: number): void {
    const count = buildDisplayRows(this.registry).length;
    const visibleSettingRows = this.visibleSettingRows();
    this.selected = moveSelection(this.selected, delta, count);
    this.scroll = selectionOffset(this.selected, this.scroll, count, visibleSettingRows);
  }

  render(width: number): string[] {
    const bodyWidth = Math.max(1, width);
    const rows = this.registry.rows();
    const displayRows = buildDisplayRows(this.registry);
    if (this.selected >= displayRows.length) this.selected = firstSettingIndex(displayRows);
    const theme = this.theme;
    const lines: string[] = [];

    const dirty = !settingsEqual(this.originalValues, this.registry.all());
    lines.push(themeFg(theme, "accent", "Pip Settings") + themeFg(theme, "dim", `  q close · j/k move · enter/←/→ change · r reset${dirty ? " · unsaved" : ""}`));
    lines.push("");

    if (!rows.length) {
      lines.push(themeFg(theme, "dim", "No pip settings registered."));
      return boxLines(lines, bodyWidth, theme);
    }

    const selectedItem = displayRows[this.selected];
    const selectedDescription = selectedItem?.kind === "setting" ? selectedItem.row.definition.description : selectedItem?.section.description;
    const descriptionLines = selectedDescription ? wrapAnsi(selectedDescription, bodyWidth - 4).slice(0, 2) : [];
    for (let i = 0; i < 2; i++) {
      lines.push(descriptionLines[i] ? `  ${themeFg(theme, "dim", descriptionLines[i])}` : "");
    }
    lines.push("");

    const visibleSettingRows = this.visibleSettingRows();
    const visibleRows = displayRows.slice(this.scroll, this.scroll + visibleSettingRows);
    for (const [offset, item] of visibleRows.entries()) {
      const realIndex = this.scroll + offset;
      const selected = realIndex === this.selected;
      const marker = selected ? themeFg(theme, "accent", "›") : " ";
      if (item.kind === "section") {
        lines.push(truncateToWidth(`${marker} ${themeFg(theme, "accent", item.section.title)}`, bodyWidth - 2));
        continue;
      }

      const row = item.row;
      const label = this.registry.settingLabel(row);
      const value = this.registry.valueLabel(row.path);
      const left = `  ${marker} ${padAnsi(label + ":", 28)}`;
      const rendered = `${left} ${valueColor(row, value, theme, this.registry)}`;
      lines.push(truncateToWidth(rendered, bodyWidth - 2));
    }

    if (displayRows.length > visibleSettingRows) lines.push(themeFg(theme, "dim", `${this.selected + 1}/${displayRows.length}`));
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
      if (!hasTuiCustom(ctx)) {
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

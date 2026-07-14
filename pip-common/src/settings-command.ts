import { fuzzyFilter, Input } from "@earendil-works/pi-tui";
import { PipCustomComponent } from "./custom-component.ts";
import { hasTuiCustom } from "./pi-api.ts";
import { truncateToWidth } from "./keys.ts";
import { moveSelection, selectionOffset } from "./scroll.ts";
import { createSettingsRegistry, type SettingsRegistry, type SettingRow } from "./settings.ts";
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

function applySettingsValues(registry: SettingsRegistry, values: Record<string, Record<string, unknown>>) {
  return registry.apply(values);
}

const MAX_VISIBLE_SETTING_ROWS = 30;
const MIN_VISIBLE_SETTING_ROWS = 8;
const SETTINGS_OVERLAY_MAX_HEIGHT_RATIO = 0.85;
const SETTINGS_CHROME_LINES = 10;

type SettingsDisplayRow = { kind: "section"; section: ReturnType<SettingsRegistry["sections"]>[number] } | { kind: "setting"; row: SettingRow };

function searchText(registry: SettingsRegistry, row: SettingRow): string {
  return [registry.settingLabel(row), row.section.title, row.path].join(" ");
}

function buildDisplayRows(registry: SettingsRegistry, query = ""): SettingsDisplayRow[] {
  const trimmedQuery = query.trim();
  if (trimmedQuery) return fuzzyFilter(registry.rows(), trimmedQuery, (row) => searchText(registry, row)).map((row) => ({ kind: "setting", row }));

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
  private readonly searchInput = new Input();

  constructor(tui: any, theme: any, done: (result?: PipSettingsResult) => void, private registry: SettingsRegistry) {
    super(tui, theme, done, { closeKeys: ["escape", "ctrl+c", "ctrl+d"] });
    this.originalValues = registry.all();
  }

  protected override close(result?: PipSettingsResult): void {
    const values = this.registry.all();
    super.close(result ?? { dirty: !settingsEqual(this.originalValues, values), values });
  }

  protected handleKey(key: string, raw: string): void {
    const displayRows = this.displayRows();
    const selectedItem = displayRows[this.selected];
    const selectedRow = selectedItem?.kind === "setting" ? selectedItem.row : undefined;
    let changed = false;

    if (key === "up") {
      changed = this.move(-1);
    } else if (key === "down") {
      changed = this.move(1);
    } else if (key === "right" || key === "return" || raw === " ") {
      if (selectedRow) changed = this.edit(selectedRow, 1);
    } else if (key === "left") {
      if (selectedRow) changed = this.edit(selectedRow, -1);
    } else if (key === "ctrl+r") {
      if (selectedRow) {
        this.registry.reset(selectedRow.path);
        changed = true;
      }
    } else {
      changed = this.updateSearch(raw);
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

  private searchQuery(): string {
    return this.searchInput.getValue();
  }

  private displayRows(): SettingsDisplayRow[] {
    return buildDisplayRows(this.registry, this.searchQuery());
  }

  private updateSearch(raw: string): boolean {
    const before = this.searchQuery();
    this.searchInput.handleInput(raw);
    const after = this.searchQuery();
    if (after === before) return false;

    const displayRows = this.displayRows();
    this.selected = firstSettingIndex(displayRows);
    this.scroll = 0;
    return true;
  }

  private move(delta: number): boolean {
    const count = this.displayRows().length;
    if (!count) return false;

    const visibleSettingRows = this.visibleSettingRows();
    const previousSelected = this.selected;
    const previousScroll = this.scroll;
    this.selected = moveSelection(this.selected, delta, count);
    this.scroll = selectionOffset(this.selected, this.scroll, count, visibleSettingRows);
    return this.selected !== previousSelected || this.scroll !== previousScroll;
  }

  render(width: number): string[] {
    const bodyWidth = Math.max(1, width);
    const rows = this.registry.rows();
    const displayRows = this.displayRows();
    if (this.selected >= displayRows.length) this.selected = firstSettingIndex(displayRows);
    const theme = this.theme;
    const lines: string[] = [];

    const dirty = !settingsEqual(this.originalValues, this.registry.all());
    lines.push(themeFg(theme, "accent", "Pip Settings") + themeFg(theme, "dim", `${dirty ? " · unsaved" : ""}  Esc close · type search · ↑/↓ move · enter/space/←/→ change · ctrl+r reset`));
    lines.push("");
    lines.push(...this.searchInput.render(Math.max(1, bodyWidth - 2)));
    lines.push("");

    if (!rows.length) {
      lines.push(themeFg(theme, "dim", "No pip settings registered."));
      return boxLines(lines, bodyWidth, theme);
    }

    if (!displayRows.length) {
      lines.push(themeFg(theme, "dim", "No matching settings"));
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
      const label = this.searchQuery().trim() ? `${row.section.title} › ${this.registry.settingLabel(row)}` : this.registry.settingLabel(row);
      const value = this.registry.valueLabel(row.path);
      const left = `  ${marker} ${padAnsi(label + ":", 28)}`;
      const rendered = `${left} ${valueColor(row, value, theme, this.registry)}`;
      lines.push(truncateToWidth(rendered, bodyWidth - 2));
    }

    if (displayRows.length > visibleSettingRows) lines.push(themeFg(theme, "dim", `${this.selected + 1}/${displayRows.length}`));
    return boxLines(lines, bodyWidth, theme);
  }
}

export function createPipSettingsComponent(tui: any, theme: any, done: (result?: PipSettingsResult) => void, registry: SettingsRegistry) {
  return new PipSettingsComponent(tui, theme, done, createDraftRegistry(registry));
}

export function registerPipSettingsCommand(pi: any, registry: SettingsRegistry): void {
  pi.registerCommand("pip-settings", {
    description: "Configure pip extension settings",
    handler: async (_args: string, ctx: any) => {
      if (!hasTuiCustom(ctx)) {
        ctx.ui?.notify?.("/pip-settings requires interactive UI", "warning");
        return;
      }
      const loadError = registry.loadError();
      if (loadError) {
        ctx.ui?.notify?.(`${loadError.message}. Fix or remove the malformed file before saving settings.`, "error");
        return;
      }
      const result = await (ctx.ui.custom as any)((tui: any, theme: any, _kb: any, done: (result?: PipSettingsResult) => void) => createPipSettingsComponent(tui, theme, done, registry), {
        overlay: true,
        overlayOptions: { anchor: "center", width: "80%", maxHeight: "85%", minWidth: 60 },
      });
      if (!result?.dirty) return;
      const choice = await ctx.ui.select?.("Save pip settings?", ["No, discard changes", "Yes, save changes"]);
      if (choice === "Yes, save changes") {
        try {
          const changes = applySettingsValues(registry, result.values);
          ctx.ui.notify?.("Saved pip settings", "info");
          const reloadLabels = changes
            .filter((change) => registry.definition(change.section)?.[change.key]?.requiresReload)
            .map((change) => {
              const section = registry.section(change.section);
              const definition = registry.definition(change.section)?.[change.key];
              return `${section?.title ?? change.section}: ${definition?.label ?? change.key}`;
            });
          if (reloadLabels.length) ctx.ui.notify?.(`Reload required to apply: ${reloadLabels.join(", ")}`, "warning");
        } catch (error) {
          ctx.ui.notify?.(`Failed to save pip settings: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      } else {
        ctx.ui.notify?.("Discarded pip settings changes", "info");
      }
    },
  });
}

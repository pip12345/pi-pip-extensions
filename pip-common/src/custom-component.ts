import { normalizeInputKey } from "./keys.ts";

export type Done<Result = void> = (result?: Result) => void;

export interface CustomComponentOptions {
  closeKeys?: readonly string[];
}

/**
 * Base class for pi custom/overlay components.
 *
 * Pi TUI calls `handleInput(data)`, not `onInput`. This class centralizes the
 * correct contract plus robust key normalization so extensions don't keep
 * reimplementing terminal escape handling and accidentally trapping the TUI.
 */
export abstract class PipCustomComponent<Result = void> {
  protected readonly closeKeys: Set<string>;
  private closed = false;

  protected constructor(protected readonly tui: any, protected readonly theme: any, protected readonly done: Done<Result>, options: CustomComponentOptions = {}) {
    this.closeKeys = new Set(options.closeKeys ?? ["escape", "ctrl+c", "ctrl+d"]);
  }

  invalidate(): void {}

  dispose(): void {}

  handleInput(data: string): void {
    const key = normalizeInputKey(data);
    if (this.closeKeys.has(key)) {
      this.close();
      return;
    }
    this.handleKey(key, data);
  }

  protected abstract handleKey(key: string, raw: string): void;

  protected close(result?: Result): void {
    if (this.closed) return;
    this.closed = true;
    this.done(result);
  }

  protected requestRender(): void {
    this.tui?.requestRender?.();
  }
}

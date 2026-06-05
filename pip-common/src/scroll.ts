export interface ScrollWindow<T> {
  offset: number;
  end: number;
  items: T[];
  maxOffset: number;
}

export interface SelectionWindow<T> extends ScrollWindow<T> {
  selected: number;
}

export function maxScrollOffset(total: number, pageSize: number): number {
  return Math.max(0, Math.max(0, total) - Math.max(1, pageSize));
}

export function clampScrollOffset(offset: number, total: number, pageSize: number): number {
  const max = maxScrollOffset(total, pageSize);
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.min(max, Math.trunc(offset)));
}

export function scrollBy(offset: number, delta: number, total: number, pageSize: number): number {
  return clampScrollOffset(offset + delta, total, pageSize);
}

export function scrollForKey(key: string, offset: number, total: number, pageSize: number): number | undefined {
  if (key === "up" || key === "k") return scrollBy(offset, -1, total, pageSize);
  if (key === "down" || key === "j") return scrollBy(offset, 1, total, pageSize);
  if (key === "pageup") return scrollBy(offset, -pageSize, total, pageSize);
  if (key === "pagedown") return scrollBy(offset, pageSize, total, pageSize);
  if (key === "home") return 0;
  if (key === "end") return maxScrollOffset(total, pageSize);
  return undefined;
}

export function scrollWindow<T>(items: readonly T[], offset: number, pageSize: number): ScrollWindow<T> {
  const safePageSize = Math.max(1, pageSize);
  const safeOffset = clampScrollOffset(offset, items.length, safePageSize);
  const end = Math.min(items.length, safeOffset + safePageSize);
  return {
    offset: safeOffset,
    end,
    items: items.slice(safeOffset, end),
    maxOffset: maxScrollOffset(items.length, safePageSize),
  };
}

export function clampSelectedIndex(selected: number, total: number): number {
  if (!Number.isFinite(selected)) return 0;
  return Math.max(0, Math.min(Math.max(0, total - 1), Math.trunc(selected)));
}

export function selectionOffset(selected: number, offset: number, total: number, pageSize: number): number {
  const safePageSize = Math.max(1, pageSize);
  const safeSelected = clampSelectedIndex(selected, total);
  let nextOffset = clampScrollOffset(offset, total, safePageSize);
  if (safeSelected < nextOffset) nextOffset = safeSelected;
  if (safeSelected >= nextOffset + safePageSize) nextOffset = safeSelected - safePageSize + 1;
  return clampScrollOffset(nextOffset, total, safePageSize);
}

export function moveSelection(selected: number, delta: number, total: number): number {
  return clampSelectedIndex(selected + delta, total);
}

export function selectionWindow<T>(items: readonly T[], selected: number, offset: number, pageSize: number): SelectionWindow<T> {
  const safeSelected = clampSelectedIndex(selected, items.length);
  const safeOffset = selectionOffset(safeSelected, offset, items.length, pageSize);
  return { ...scrollWindow(items, safeOffset, pageSize), selected: safeSelected };
}

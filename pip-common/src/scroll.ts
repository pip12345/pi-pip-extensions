export interface ScrollWindow<T> {
  offset: number;
  end: number;
  items: T[];
  maxOffset: number;
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

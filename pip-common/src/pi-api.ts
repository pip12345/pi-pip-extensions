export interface SessionManagerLike {
  getBranch?: () => any[];
  getEntries?: () => any[];
  getLeafId?: () => string | null | undefined;
  getLeafEntry?: () => { id?: string } | undefined;
  getSessionFile?: () => string | undefined;
  getSessionId?: () => string | undefined;
}

export interface ExtensionContextLike {
  cwd?: string;
  hasUI?: boolean;
  model?: any;
  sessionManager?: SessionManagerLike;
  ui?: {
    setWidget?: (key: string, content: any, options?: any) => any;
    notify?: (message: string, level?: string) => any;
    [key: string]: any;
  };
  [key: string]: any;
}

export function branchEntries(ctx: ExtensionContextLike | undefined): any[] {
  return ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
}

export function sessionEntries(ctx: ExtensionContextLike | undefined): any[] {
  return ctx?.sessionManager?.getEntries?.() ?? [];
}

export function leafId(ctx: ExtensionContextLike | undefined): string | null | undefined {
  return ctx?.sessionManager?.getLeafId?.() ?? ctx?.sessionManager?.getLeafEntry?.()?.id;
}

export function sessionFile(ctx: ExtensionContextLike | undefined): string | undefined {
  return ctx?.sessionManager?.getSessionFile?.();
}

export function sessionKey(ctx: ExtensionContextLike | undefined, fallback = "unknown"): string {
  return ctx?.sessionManager?.getSessionFile?.() ?? ctx?.sessionManager?.getSessionId?.() ?? fallback;
}

export function restoreLatestCustomState<T>(entries: any[] | undefined, customType: string, normalize: (data: any) => T, empty: () => T): T {
  let state = empty();
  for (const entry of entries ?? []) {
    if ((entry?.type === "custom" && entry.customType === customType) || entry?.customType === customType) {
      state = normalize(entry.data);
    }
  }
  return state;
}

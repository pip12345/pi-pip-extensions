import type { Component } from "@earendil-works/pi-tui";
import { safePadToWidth, safeTruncateToWidth, themeBg, themeBold } from "pip-common";

const SAFE_CACHED = Symbol("tool-ui.safeCachedComponent");

export type ThemeLike = Parameters<typeof themeBg>[0];
export { themeBg, themeBold };

export function blockLine(theme: ThemeLike | undefined, bg: string, line: string, width: number): string {
  return themeBg(theme, bg, safePadToWidth(line, width));
}

export function safeCachedComponent(component: Component): Component {
  const anyComponent = component as any;
  if (anyComponent[SAFE_CACHED]) return component;
  const originalRender = component.render;
  const originalInvalidate = component.invalidate;
  const renderCache = new Map<number, string[]>();
  const safe = Object.assign(Object.create(Object.getPrototypeOf(component)), component) as Component;
  safe.render = function (this: Component, width: number) {
    const cached = renderCache.get(width);
    if (cached) return cached;
    const rendered = originalRender.call(this, width).map((line) => safeTruncateToWidth(line, width));
    renderCache.set(width, rendered);
    return rendered;
  };
  safe.invalidate = function (this: Component) {
    renderCache.clear();
    return originalInvalidate?.call(this);
  };
  (safe as any)[SAFE_CACHED] = true;
  return safe;
}

export type ToolShellRole = "call" | "result" | "joinedResult";
export type ToolShellStatus = "pending" | "success" | "error";

export interface ToolShellOptions {
  bg?: string;
  paddingX?: number;
  role?: ToolShellRole;
  status?: ToolShellStatus;
}

function verticalPadding(role: ToolShellRole): { top: number; bottom: number } {
  if (role === "joinedResult") return { top: 0, bottom: 1 };
  return { top: 1, bottom: 1 };
}

function defaultBgForRole(role: ToolShellRole, status?: ToolShellStatus): string {
  if (status === "error") return "toolErrorBg";
  if (status === "success") return "toolSuccessBg";
  if (status === "pending") return "toolPendingBg";
  return role === "call" ? "toolPendingBg" : "toolSuccessBg";
}

export function toolShellComponent(component: Component, theme: ThemeLike | undefined, options: ToolShellOptions = {}): Component {
  const role = options.role ?? "call";
  const bg = options.bg ?? defaultBgForRole(role, options.status);
  const paddingX = options.paddingX ?? 2;
  const { top, bottom } = verticalPadding(role);
  const cache = new Map<number, string[]>();
  const shell = Object.assign(Object.create(Object.getPrototypeOf(component)), component) as Component;
  shell.render = function (width: number) {
    const cached = cache.get(width);
    if (cached) return cached;
    const innerWidth = Math.max(1, width - paddingX * 2);
    const blank = blockLine(theme, bg, "", width);
    const leftPadding = " ".repeat(paddingX);
    const rendered = [
      ...Array.from({ length: top }, () => blank),
      ...component.render(innerWidth).map((line) => blockLine(theme, bg, `${leftPadding}${safeTruncateToWidth(line, innerWidth)}`, width)),
      ...Array.from({ length: bottom }, () => blank),
    ];
    cache.set(width, rendered);
    return rendered;
  };
  shell.invalidate = function () {
    cache.clear();
    component.invalidate?.();
  };
  return shell;
}

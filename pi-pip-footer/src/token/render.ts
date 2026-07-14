import { formatTokenCount } from "pip-common";

export function renderTokenMetric(label: string, value: number, changed: boolean, theme: any, suffix = ""): string {
  const labelColor = (s: string) => theme.fg("dim", s);
  const valueColor = (s: string) => theme.fg(changed ? "success" : "accent", s);
  return `${labelColor(`${label}:`)}${valueColor(formatTokenCount(value))}${suffix ? labelColor(suffix) : ""}`;
}

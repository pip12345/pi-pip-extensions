import { formatTokenCount } from "../../../pip-common/index.ts";

export function renderTokenMetric(label: string, value: number, changed: boolean, theme: any): string {
  const labelColor = (s: string) => theme.fg("dim", s);
  const valueColor = (s: string) => theme.fg(changed ? "success" : "accent", s);
  return `${labelColor(`${label}:`)}${valueColor(formatTokenCount(value))}`;
}

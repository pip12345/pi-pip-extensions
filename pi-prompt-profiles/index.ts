import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pipSettings, registerSettingsSection, setting } from "pip-common";

type Mode = "append" | "prepend" | "replace";

type Profile = { id: string; label: string; path: string };

const SETTINGS_ID = "prompt-profiles";
const NONE = "";
const DEFAULT_PROFILE = "default.md";
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(EXTENSION_DIR, "prompts");

function isMarkdownFile(name: string): boolean {
  return /\.md$/i.test(name);
}

function isSafeProfileId(id: string): boolean {
  if (!id || id.includes("\0")) return false;
  const normalized = normalize(id);
  return normalized === id && !normalized.startsWith("..") && !resolve(PROMPTS_DIR, id).split(sep).includes("..");
}

export function discoverProfiles(promptsDir = PROMPTS_DIR): Profile[] {
  if (!existsSync(promptsDir)) return [];
  return readdirSync(promptsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isMarkdownFile(entry.name))
    .map((entry) => {
      const path = join(promptsDir, entry.name);
      return { id: entry.name, label: basename(entry.name, ".md"), path };
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

const profiles = discoverProfiles();
const profileChoices = [
  { value: NONE, label: "off" },
  ...profiles.map((profile) => ({ value: profile.id, label: profile.label })),
];

registerSettingsSection({
  id: SETTINGS_ID,
  title: "Prompt Profiles",
  description: "Select one markdown file from pi-prompt-profiles/prompts and apply it to the system prompt.",
  order: 30,
  settings: {
    enabled: setting.boolean({ label: "Enabled", default: true, order: 1 }),
    profile: setting.enum({ label: "Profile", default: DEFAULT_PROFILE, choices: profileChoices, order: 2 }),
    mode: setting.enum({ label: "Mode", default: "append", choices: ["append", "prepend", "replace"] as const, order: 3 }),
  },
});

function selectedProfilePath(profileId: string, promptsDir = PROMPTS_DIR): string | undefined {
  if (!isSafeProfileId(profileId)) return undefined;
  const path = resolve(promptsDir, profileId);
  const root = resolve(promptsDir);
  if (relative(root, path).startsWith("..")) return undefined;
  if (!existsSync(path) || !statSync(path).isFile() || !isMarkdownFile(path)) return undefined;
  return path;
}

function readSelectedProfile(profileId: string, promptsDir = PROMPTS_DIR): string | undefined {
  const path = selectedProfilePath(profileId, promptsDir);
  if (!path) return undefined;
  const text = readFileSync(path, "utf8").trim();
  return text || undefined;
}

export function applyPromptProfile(systemPrompt: string, profileText: string, mode: Mode): string {
  if (mode === "replace") return profileText;
  if (mode === "prepend") return `${profileText}\n\n${systemPrompt}`;
  return `${systemPrompt}\n\n${profileText}`;
}

function settingValue<T>(key: string, fallback: T): T {
  try {
    return pipSettings.get<T>(`${SETTINGS_ID}.${key}`);
  } catch {
    return fallback;
  }
}

export default function promptProfilesExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event: any) => {
    if (!settingValue("enabled", true)) return;
    const profileId = settingValue<string>("profile", DEFAULT_PROFILE);
    const profileText = readSelectedProfile(profileId);
    if (!profileText) return;
    const mode = settingValue<Mode>("mode", "append");
    return { systemPrompt: applyPromptProfile(event.systemPrompt ?? "", profileText, mode) };
  });
}

export const __test = { SETTINGS_ID, PROMPTS_DIR, DEFAULT_PROFILE, discoverProfiles, readSelectedProfile, applyPromptProfile, selectedProfilePath };

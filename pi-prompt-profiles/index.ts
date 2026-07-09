import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePipSubdir, pipPath, registerSettingsSection, setting, settingsFor } from "../pip-common/index.ts";

type Mode = "append" | "prepend" | "replace";
type ProfileSource = "bundled" | "user";
type Profile = { id: string; label: string; path: string; source: ProfileSource };

const SETTINGS_ID = "prompt-profiles";
const NONE = "";
const DEFAULT_PROFILE = "default.md";
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(EXTENSION_DIR, "prompts");
const USER_PROMPTS_DIR = pipPath("prompt-profiles");

function isMarkdownFile(name: string): boolean {
  return /\.md$/i.test(name);
}

function isSafeProfileId(id: string): boolean {
  return Boolean(id) && !id.includes("\0") && basename(id) === id && isMarkdownFile(id);
}

function compareProfiles(a: Profile, b: Profile): number {
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

export function discoverProfiles(promptsDir = PROMPTS_DIR, source: ProfileSource = "bundled"): Profile[] {
  if (!existsSync(promptsDir)) return [];
  return readdirSync(promptsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isMarkdownFile(entry.name))
    .map((entry) => ({ id: entry.name, label: basename(entry.name, ".md"), path: join(promptsDir, entry.name), source }))
    .sort(compareProfiles);
}

export function discoverAvailableProfiles(bundledDir = PROMPTS_DIR, userDir = USER_PROMPTS_DIR): Profile[] {
  const profilesById = new Map(discoverProfiles(bundledDir, "bundled").map((profile) => [profile.id, profile]));
  for (const profile of discoverProfiles(userDir, "user")) profilesById.set(profile.id, profile);
  return [...profilesById.values()].sort(compareProfiles);
}

const profiles = discoverAvailableProfiles();
const profileChoices = [
  { value: NONE, label: "off" },
  ...profiles.map((profile) => ({ value: profile.id, label: profile.label })),
];

registerSettingsSection({
  id: SETTINGS_ID,
  title: "Prompt Profiles",
  description: "Select a bundled or user-managed markdown file and apply it to the system prompt.",
  order: 30,
  settings: {
    enabled: setting.boolean({ label: "Enabled", default: true, order: 1, description: "Include the selected markdown file as a system prompt overlay." }),
    profile: setting.enum({ label: "Profile", default: DEFAULT_PROFILE, choices: profileChoices, order: 2, description: "Bundled profile or user markdown file from ~/.pi/agent/pip/prompt-profiles." }),
    mode: setting.enum({ label: "Mode", default: "append", choices: ["append", "prepend", "replace"] as const, order: 3, description: "Append to, prepend to, or replace the normal system prompt." }),
  },
});

function selectedProfilePath(profileId: string, promptsDirs: string | readonly string[] = [USER_PROMPTS_DIR, PROMPTS_DIR]): string | undefined {
  if (!isSafeProfileId(profileId)) return undefined;
  const directories = typeof promptsDirs === "string" ? [promptsDirs] : promptsDirs;
  for (const promptsDir of directories) {
    const path = join(promptsDir, profileId);
    if (existsSync(path) && lstatSync(path).isFile()) return path;
  }
  return undefined;
}

function readSelectedProfile(profileId: string, promptsDirs: string | readonly string[] = [USER_PROMPTS_DIR, PROMPTS_DIR]): string | undefined {
  const path = selectedProfilePath(profileId, promptsDirs);
  if (!path) return undefined;
  const text = readFileSync(path, "utf8").trim();
  return text || undefined;
}

export function applyPromptProfile(systemPrompt: string, profileText: string, mode: Mode): string {
  if (mode === "replace") return profileText;
  if (mode === "prepend") return `${profileText}\n\n${systemPrompt}`;
  return `${systemPrompt}\n\n${profileText}`;
}

const scopedSettings = settingsFor(SETTINGS_ID);
const settingValue = scopedSettings.get;

export default function promptProfilesExtension(pi: ExtensionAPI) {
  ensurePipSubdir("prompt-profiles");
  pi.on("before_agent_start", async (event: any) => {
    if (!settingValue("enabled", true)) return;
    const profileId = settingValue<string>("profile", DEFAULT_PROFILE);
    const profileText = readSelectedProfile(profileId);
    if (!profileText) return;
    const mode = settingValue<Mode>("mode", "append");
    return { systemPrompt: applyPromptProfile(event.systemPrompt ?? "", profileText, mode) };
  });
}

export const __test = { SETTINGS_ID, PROMPTS_DIR, USER_PROMPTS_DIR, DEFAULT_PROFILE, discoverProfiles, discoverAvailableProfiles, readSelectedProfile, applyPromptProfile, selectedProfilePath };

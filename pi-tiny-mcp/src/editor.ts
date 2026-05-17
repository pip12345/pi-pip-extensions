import { spawn } from "node:child_process";
import { ensureConfigFile } from "./config.ts";

export async function openInEditor(path: string): Promise<void> {
  ensureConfigFile(path);
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(`${editor} ${JSON.stringify(path)}`, { stdio: "inherit", shell: true });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${editor} exited with ${signal ?? code}`));
    });
  });
}

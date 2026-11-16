/**
 * Reads the system clipboard as text, for terminals that deliver Ctrl+V to the
 * app as a plain keystroke (e.g. classic Windows console) instead of pasting.
 * argv only, no shell; undefined when nothing could be read.
 */
import { execFile } from "node:child_process";

function run(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: 3000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout) => resolve(err ? undefined : String(stdout))
    );
  });
}

export async function readClipboardText(platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (platform === "win32") {
    return run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-Clipboard -Raw",
    ]);
  }
  if (platform === "darwin") return run("pbpaste", []);
  return (
    (await run("wl-paste", ["--no-newline"])) ??
    (await run("xclip", ["-selection", "clipboard", "-o"])) ??
    (await run("xsel", ["-b", "-o"]))
  );
}

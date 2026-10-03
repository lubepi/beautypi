import { execSync } from "node:child_process";

/**
 * Read the platform's primary selection (X11 primary selection, macOS/Windows
 * clipboard via the platform paste command). Returns an empty string when no
 * selection is available or the helper tools are missing.
 */
export function readPrimarySelection(): string {
  try {
    let text: string;
    if (process.platform === "darwin") {
      text = execSync("pbpaste", { encoding: "utf8", timeout: 500 });
    } else if (process.platform === "win32") {
      text = execSync("powershell -command Get-Clipboard", { encoding: "utf8", timeout: 1000 });
    } else {
      text = execSync(
        "xclip -o -selection primary 2>/dev/null || xsel -o -p 2>/dev/null || wl-paste -p 2>/dev/null",
        { encoding: "utf8", timeout: 1000, shell: true },
      );
    }
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  } catch {
    return "";
  }
}

/**
 * Write the X11 primary selection (the middle-click buffer). Best effort:
 * silently does nothing when no supported tool is available.
 */
export function writePrimarySelection(text: string): void {
  if (!text || process.platform !== "linux") return;

  for (const command of ["xclip -selection primary", "xsel --primary", "wl-copy --primary"]) {
    try {
      execSync(command, { input: text, timeout: 2000, stdio: ["pipe", "ignore", "ignore"] });
      return;
    } catch {
      // Try the next clipboard tool.
    }
  }
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSplashScreen } from "./splash.ts";
import powerlineFooter from "./powerline.ts";

/**
 * Beautypi — Combined splash screen + powerline-style status bar
 * for the pi coding agent.
 *
 * Merges pi-splash and pi-powerline-footer into a single extension.
 */
export default function beautypi(pi: ExtensionAPI): void {
  // Install splash screen (shows on session start, auto-dismisses)
  installSplashScreen(pi);

  // Install powerline footer (status bar with segments, fixed editor, etc.)
  powerlineFooter(pi);
}

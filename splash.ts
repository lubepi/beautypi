import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ═══════════════════════════════════════════════════════════════════════════
// Colors & Logo
// ═══════════════════════════════════════════════════════════════════════════

const RESET = "\x1b[0m";

const GRADIENT_COLORS = [
  "\x1b[38;5;199m",
  "\x1b[38;5;171m",
  "\x1b[38;5;135m",
  "\x1b[38;5;99m",
  "\x1b[38;5;75m",
  "\x1b[38;5;51m",
];

const PI_LOGO = [
  "██████████    ",
  "████  ████    ",
  "████  ████    ",
  "████████  ████",
  "████      ████",
  "████      ████",
];

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

function gradientLine(line: string): string {
  let result = "";
  let colorIdx = 0;
  const step = Math.max(1, Math.floor(line.length / GRADIENT_COLORS.length));

  for (let i = 0; i < line.length; i++) {
    if (i > 0 && i % step === 0 && colorIdx < GRADIENT_COLORS.length - 1) colorIdx++;
    const char = line[i];
    if (char !== " ") {
      result += GRADIENT_COLORS[colorIdx] + char + RESET;
    } else {
      result += char;
    }
  }
  return result;
}

function centerText(text: string, width: number): string {
  const visLen = visibleWidth(text);
  if (visLen > width) return truncateToWidth(text, width, "…");
  if (visLen === width) return text;
  const leftPad = Math.floor((width - visLen) / 2);
  const rightPad = width - visLen - leftPad;
  return " ".repeat(leftPad) + text + " ".repeat(rightPad);
}

// ═══════════════════════════════════════════════════════════════════════════
// Left column: logo + welcome info
// ═══════════════════════════════════════════════════════════════════════════

function buildLeftColumn(modelName: string, providerName: string, colWidth: number): string[] {
  const logoColored = PI_LOGO.map((line) => gradientLine(line));

  return [
    "",
    centerText(bold("Welcome back!"), colWidth),
    "",
    ...logoColored.map((l) => centerText(l, colWidth)),
    "",
    centerText(bold(modelName), colWidth),
    centerText(providerName, colWidth),
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// Right column: tips & navigation
// ═══════════════════════════════════════════════════════════════════════════

function wrapRightText(text: string, colWidth: number, firstIndent: number): string[] {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  const hasBullet = /^\s*[•\-]\s/.test(plain);
  const contIndent = hasBullet ? firstIndent + 2 : firstIndent;

  // Ensure at least `firstIndent` spaces of right margin so the text
  // doesn't run flush against the right border.
  const rightMargin = firstIndent;

  const firstPad = " ".repeat(firstIndent);
  const contPad = " ".repeat(contIndent);
  const lines: string[] = [];
  let remaining = plain;
  let isFirst = true;
  while (remaining.length > 0) {
    const pad = isFirst ? firstPad : contPad;
    const avail = colWidth - visibleWidth(pad) - rightMargin;
    if (avail <= 0) break;
    if (visibleWidth(remaining) <= avail) {
      lines.push(pad + remaining);
      break;
    }
    let breakAt = remaining.lastIndexOf(" ", avail);
    if (breakAt <= 0) breakAt = avail;
    lines.push(pad + remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
    isFirst = false;
  }
  return lines;
}

function buildRightColumn(colWidth: number, theme: Theme): string[] {
  const dim = (s: string) => `${theme.fg("border", s)}`;
  const accent = (s: string) => `${theme.fg("success", s)}`;
  const lines: string[] = [];

  lines.push(` ${accent("Keys")}`);
  lines.push(` ${dim("─".repeat(colWidth - 2))}`);
  for (const l of wrapRightText(`${dim("•")} ${theme.bold("Esc")}  ${dim("Interrupt")}`, colWidth, 2)) lines.push(l);
  for (const l of wrapRightText(`${dim("•")} ${theme.bold("Ctrl+C")}  ${dim("Clear")}`, colWidth, 2)) lines.push(l);
  for (const l of wrapRightText(`${dim("•")} ${theme.bold("Ctrl+D")}  ${dim("Exit")}`, colWidth, 2)) lines.push(l);
  for (const l of wrapRightText(`${dim("•")} ${theme.bold("Ctrl+O")}  ${dim("Toggle tool output / More")}`, colWidth, 2)) lines.push(l);
  lines.push("");

  lines.push(` ${accent("Commands")}`);
  lines.push(` ${dim("─".repeat(colWidth - 2))}`);
  for (const l of wrapRightText(`${dim("•")} ${theme.bold("/command")}  ${dim("Run slash commands")}`, colWidth, 2)) lines.push(l);
  for (const l of wrapRightText(`${dim("•")} ${theme.bold("! cmd")}  ${dim("Run bash directly")}`, colWidth, 2)) lines.push(l);
  lines.push("");

  lines.push(` ${accent("Tip")}`);
  lines.push(` ${dim("─".repeat(colWidth - 2))}`);
  for (const l of wrapRightText(`${dim("Pi can explain its own features and look up its docs.")}`, colWidth, 2)) lines.push(l);
  for (const l of wrapRightText(`${dim("Ask it how to use or extend Pi.")}`, colWidth, 2)) lines.push(l);

  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// Splash rendering
// ═══════════════════════════════════════════════════════════════════════════

function renderSplashLines(
  termWidth: number,
  theme: Theme,
  modelName: string,
  providerName: string,
): string[] {
  const minLayoutWidth = 80;
  if (termWidth < minLayoutWidth) return [];

  const boxWidth = Math.max(80, Math.floor(termWidth * 0.8));
  const leftPad = " ".repeat(Math.floor((termWidth - boxWidth) / 2));

  const leftCol = Math.max(48, Math.floor(boxWidth * 0.6));
  const rightCol = Math.max(1, boxWidth - leftCol - 3);

  const leftLines = buildLeftColumn(modelName, providerName, leftCol);
  const rightLines = buildRightColumn(rightCol, theme);

  const maxRows = Math.max(leftLines.length, rightLines.length);
  const leftPadTop = Math.floor((maxRows - leftLines.length) / 2);

  const hChar = "─";
  const dim = (s: string) => `${theme.fg("border", s)}`;
  const v = dim("│");
  const tl = dim("╭");
  const tr = dim("╮");
  const bl = dim("╰");
  const br = dim("╯");

  const lines: string[] = [];
  lines.push("");
  lines.push("");
  const topLeft = dim(hChar.repeat(leftCol));
  const topRight = dim(hChar.repeat(rightCol));
  lines.push(leftPad + tl + topLeft + dim("┬") + topRight + tr);

  function padToWidth(text: string, width: number): string {
    const visLen = visibleWidth(text);
    return text + " ".repeat(Math.max(0, width - visLen));
  }

  const emptyLeft = " ".repeat(leftCol);
  for (let i = 0; i < maxRows; i++) {
    let left: string;
    if (i < leftPadTop || i >= leftPadTop + leftLines.length) {
      left = emptyLeft;
    } else {
      left = padToWidth(leftLines[i - leftPadTop] ?? "", leftCol);
    }
    const right = padToWidth(rightLines[i] ?? "", rightCol);
    lines.push(leftPad + v + left + v + right + v);
  }

  const bottomLeft = dim(hChar.repeat(leftCol));
  const bottomRight = dim(hChar.repeat(rightCol));
  lines.push(leftPad + bl + bottomLeft + dim("┴") + bottomRight + br);
  lines.push("");
  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// Splash screen extension
// ═══════════════════════════════════════════════════════════════════════════

export function installSplashScreen(pi: ExtensionAPI): void {
  let headerActive = false;

  function dismiss(ctx: { ui: { setHeader: (f: undefined) => void } }) {
    if (headerActive) {
      headerActive = false;
      ctx.ui.setHeader(undefined);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const isResume = ctx.sessionManager
      .getBranch()
      .some((e) => e.type === "message");

    if (isResume) return;

    const model = ctx.model;
    const modelName = model?.id ?? "Unknown";
    const providerName = model?.provider ?? "";

    headerActive = true;

    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() {},
      render(termWidth: number): string[] {
        return renderSplashLines(termWidth, theme, modelName, providerName);
      },
    }));
  });

  pi.on("user_message", async (_event, ctx) => { dismiss(ctx); });
  pi.on("session_shutdown", async (_event, ctx) => { dismiss(ctx); });
}

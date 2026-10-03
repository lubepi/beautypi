import {
  copyToClipboard,
  type ExtensionAPI,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isKeyRelease, matchesKey, truncateToWidth, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, hostname } from "node:os";

import type { ColorScheme, SegmentContext, StatusLinePreset, StatusLineSegmentId } from "./types.ts";
import type { PowerlineConfig } from "./powerline-config.ts";
import { PowerlineEditor } from "./editor.ts";
import { installStartupResourceGating } from "./startup-resources.ts";
import { getPreset, PRESETS } from "./presets.ts";
import { collectHiddenExtensionStatusKeys, getNotificationExtensionStatuses, mergeSegmentOptions, mergeSegmentsWithCustomItems, nextPowerlineSettingWithOptions, nextPowerlineSettingWithPreset, parsePowerlineConfig } from "./powerline-config.ts";
import { getSeparator } from "./separators.ts";
import { renderSegment } from "./segments.ts";
import { getGitStatus, invalidateGitStatus, invalidateGitBranch } from "./git-status.ts";
import { ansi, getFgAnsiCode } from "./colors.ts";
import { writePrimarySelection } from "./clipboard.ts";
import { createRenderScheduler } from "./render-scheduler.ts";
import { readCoreContextUsage } from "./context-usage.ts";
import { renderFixedEditorCluster } from "./fixed-editor/cluster.ts";
import { emergencyTerminalModeReset, TerminalSplitCompositor } from "./fixed-editor/terminal-split.ts";
import { getDefaultColors } from "./theme.ts";
import {
  isSupportedSuperShortcut,
  matchesConfiguredShortcut,
  shortcutConflictKey,
  shortcutUsesSuper,
} from "./shortcuts.ts";

let config: PowerlineConfig = {
  preset: "default",
  customItems: [],
  segmentOptions: {},
  mouseScroll: true,
  fixedEditor: true,
};

const CUSTOM_COMPACTION_STATUS_KEY = "compact-policy";
let customCompactionEnabled = false;

type ShortcutBinding = string | null;

interface PowerlineShortcuts {
  copyEditor: ShortcutBinding;
  cutEditor: ShortcutBinding;
  jumpPreviousUserMessage: ShortcutBinding;
  jumpNextUserMessage: ShortcutBinding;
  jumpPreviousLlmMessage: ShortcutBinding;
  jumpNextLlmMessage: ShortcutBinding;
  jumpChatBottom: ShortcutBinding;
  scrollChatUp: ShortcutBinding;
  scrollChatDown: ShortcutBinding;
  editorStart: ShortcutBinding;
  editorEnd: ShortcutBinding;
}

type PowerlineShortcutKey = keyof PowerlineShortcuts;
type ChatJumpShortcutKey = Extract<PowerlineShortcutKey,
  | "jumpPreviousUserMessage"
  | "jumpNextUserMessage"
  | "jumpPreviousLlmMessage"
  | "jumpNextLlmMessage"
  | "jumpChatBottom"
>;
type ChatJumpRole = "user" | "assistant";
type ChatJumpDirection = "previous" | "next";
type ChatJumpShortcutAction =
  | { kind: "message"; role: ChatJumpRole; direction: ChatJumpDirection }
  | { kind: "bottom" };
type PowerlineShortcutAction =
  | { kind: "copyEditor" }
  | { kind: "cutEditor" }
  | { kind: "chat"; action: ChatJumpShortcutAction };

const DEFAULT_SHORTCUTS: PowerlineShortcuts = {
  copyEditor: "ctrl+alt+c",
  cutEditor: "ctrl+alt+x",
  jumpPreviousUserMessage: "ctrl+shift+u",
  jumpNextUserMessage: "ctrl+shift+i",
  jumpPreviousLlmMessage: "ctrl+alt+,",
  jumpNextLlmMessage: "ctrl+alt+.",
  jumpChatBottom: "ctrl+alt+g",
  scrollChatUp: "super+up",
  scrollChatDown: "super+down",
  editorStart: "super+shift+up",
  editorEnd: "super+shift+down",
};
const CHAT_JUMP_SHORTCUTS: Array<{
  shortcutKey: ChatJumpShortcutKey;
  description: string;
  action: ChatJumpShortcutAction;
}> = [
  {
    shortcutKey: "jumpPreviousUserMessage",
    description: "Jump to previous user message",
    action: { kind: "message", role: "user", direction: "previous" },
  },
  {
    shortcutKey: "jumpNextUserMessage",
    description: "Jump to next user message",
    action: { kind: "message", role: "user", direction: "next" },
  },
  {
    shortcutKey: "jumpPreviousLlmMessage",
    description: "Jump to previous LLM message",
    action: { kind: "message", role: "assistant", direction: "previous" },
  },
  {
    shortcutKey: "jumpNextLlmMessage",
    description: "Jump to next LLM message",
    action: { kind: "message", role: "assistant", direction: "next" },
  },
  {
    shortcutKey: "jumpChatBottom",
    description: "Jump chat to bottom",
    action: { kind: "bottom" },
  },
];
const SHORTCUT_KEYS: PowerlineShortcutKey[] = [
  "copyEditor",
  "cutEditor",
  "jumpPreviousUserMessage",
  "jumpNextUserMessage",
  "jumpPreviousLlmMessage",
  "jumpNextLlmMessage",
  "jumpChatBottom",
  "scrollChatUp",
  "scrollChatDown",
  "editorStart",
  "editorEnd",
];
const APP_RESERVED_SHORTCUTS = [
  "escape",
  "ctrl+c",
  "ctrl+d",
  "ctrl+z",
  "shift+tab",
  "ctrl+p",
  "shift+ctrl+p",
  "ctrl+l",
  "ctrl+o",
  "shift+ctrl+o",
  "ctrl+t",
  "ctrl+n",
  "ctrl+g",
  "alt+enter",
  "alt+up",
  "alt+down",
  "ctrl+v",
  "alt+v",
  "shift+l",
  "shift+t",
  "ctrl+s",
  "ctrl+r",
  "ctrl+backspace",
  "ctrl+a",
  "ctrl+x",
  "ctrl+u",
] as const;
const EXTRA_RESERVED_SHORTCUTS = ["ctrl+alt+s"] as const;
const SHORTCUT_MODIFIER_ORDER = ["ctrl", "alt", "super", "shift"] as const;
const SHORTCUT_MODIFIERS = new Set(SHORTCUT_MODIFIER_ORDER);
const SHORTCUT_NAMED_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
]);
const SHORTCUT_SYMBOL_KEYS = new Set([
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/",
  "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "|", "~", "{", "}", ":", "<", ">", "?",
]);
const LAYOUT_CACHE_TTL_MS = 250;
const STREAMING_LAYOUT_CACHE_TTL_MS = 1000;
const STATUS_RENDER_DEBOUNCE_MS = 33;
const CONTEXT_STATUS_RENDER_MS = 250;
const EDITOR_STATUS_DEFER_MS = 150;
type SessionAssistantUsage = AssistantMessage["usage"];

function getUsageTokenTotal(usage: SessionAssistantUsage): number {
  const totalTokens = "totalTokens" in usage && typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
  return totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function hasSessionAssistantUsage(value: unknown): value is SessionAssistantUsage {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.input !== "number" ||
    typeof value.output !== "number" ||
    typeof value.cacheRead !== "number" ||
    typeof value.cacheWrite !== "number"
  ) {
    return false;
  }

  return isRecord(value.cost) && typeof value.cost.total === "number";
}

function isSessionAssistantMessage(value: unknown): value is AssistantMessage {
  return isRecord(value)
    && value.role === "assistant"
    && hasSessionAssistantUsage(value.usage)
    && (value.stopReason === undefined || typeof value.stopReason === "string");
}

function getSettingsPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "settings.json");
}

function getProjectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

function getGlobalCompactionPolicyPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "compaction-policy.json");
}

function getCustomCompactionExtensionPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "extensions", "pi-custom-compaction");
}

function mergeSettings(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = merged[key];
    merged[key] = isRecord(baseValue) && isRecord(overrideValue)
      ? mergeSettings(baseValue, overrideValue)
      : overrideValue;
  }

  return merged;
}

function readSettingsFile(settingsPath: string): Record<string, unknown> {
  try {
    if (!existsSync(settingsPath)) {
      return {};
    }

    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[beautypi] Ignoring non-object settings at ${settingsPath}`);
      return {};
    }

    return parsed;
  } catch (error) {
    console.debug(`[beautypi] Failed to read settings from ${settingsPath}:`, error);
    return {};
  }
}

function readWritableSettingsFile(settingsPath: string): Record<string, unknown> | null {
  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[beautypi] Refusing to write settings to non-object file at ${settingsPath}`);
      return null;
    }

    return parsed;
  } catch (error) {
    console.debug(`[beautypi] Failed to parse settings at ${settingsPath}:`, error);
    return null;
  }
}

function readCompactionPolicyEnabled(configPath: string): boolean | undefined {
  if (!existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!isRecord(parsed) || typeof parsed.enabled !== "boolean") return false;
    return parsed.enabled;
  } catch (error) {
    console.debug(`[beautypi] Failed to read compaction policy from ${configPath}:`, error);
    return false;
  }
}

function detectCustomCompactionEnabled(cwd: string): boolean {
  if (!existsSync(getCustomCompactionExtensionPath())) return false;

  const projectSetting = readCompactionPolicyEnabled(join(cwd, ".pi", "compaction-policy.json"));
  if (projectSetting !== undefined) return projectSetting;

  return readCompactionPolicyEnabled(getGlobalCompactionPolicyPath()) ?? false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(cwd: string = process.cwd()): Record<string, unknown> {
  return mergeSettings(readSettingsFile(getSettingsPath()), readSettingsFile(getProjectSettingsPath(cwd)));
}

function writePowerlineSetting(cwd: string, update: (existingPowerlineSetting: unknown) => unknown): boolean {
  const globalSettingsPath = getSettingsPath();
  const projectSettingsPath = getProjectSettingsPath(cwd);
  const globalSettings = readWritableSettingsFile(globalSettingsPath);
  const projectSettings = readWritableSettingsFile(projectSettingsPath);

  if (globalSettings === null || projectSettings === null) {
    return false;
  }

  const writeToProject = Object.prototype.hasOwnProperty.call(projectSettings, "powerline");
  const settingsPath = writeToProject ? projectSettingsPath : globalSettingsPath;
  const settings = writeToProject ? projectSettings : globalSettings;

  settings.powerline = update(settings.powerline);

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    return true;
  } catch (error) {
    console.debug(`[beautypi] Failed to persist powerline setting to ${settingsPath}:`, error);
    return false;
  }
}

function writePowerlinePresetSetting(preset: StatusLinePreset, cwd: string = process.cwd()): boolean {
  return writePowerlineSetting(cwd, (existingPowerlineSetting) => (
    nextPowerlineSettingWithPreset(existingPowerlineSetting, preset)
  ));
}

function writePowerlineOptionSetting(
  cwd: string,
  updates: Partial<Pick<PowerlineConfig, "mouseScroll" | "fixedEditor">>,
  currentPreset: StatusLinePreset,
): boolean {
  return writePowerlineSetting(cwd, (existingPowerlineSetting) => (
    nextPowerlineSettingWithOptions(existingPowerlineSetting, updates, currentPreset)
  ));
}

const PRESET_NAMES = Object.keys(PRESETS) as StatusLinePreset[];

function isValidPreset(value: unknown): value is StatusLinePreset {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PRESETS, value);
}

function normalizePreset(value: unknown): StatusLinePreset | null {
  if (typeof value !== "string") {
    return null;
  }

  const preset = value.trim().toLowerCase();
  return isValidPreset(preset) ? preset : null;
}

function hasNonWhitespaceText(text: string): boolean {
  return text.trim().length > 0;
}

function getCurrentEditorText(ctx: any, editor: any): string {
  return editor?.getExpandedText?.() ?? ctx.ui.getEditorText();
}

function normalizeShortcut(value: string): string {
  const parts = value.trim().toLowerCase().split("+");
  if (parts.length <= 1) return parts[0] ?? "";

  const modifierRank = new Map(SHORTCUT_MODIFIER_ORDER.map((modifier, index) => [modifier, index]));
  const modifiers = parts.slice(0, -1).sort((a, b) => (modifierRank.get(a) ?? 99) - (modifierRank.get(b) ?? 99));
  return [...modifiers, parts[parts.length - 1]].join("+");
}

function reservedShortcuts(): Set<string> {
  const shortcuts = new Set<string>([
    ...EXTRA_RESERVED_SHORTCUTS,
    ...APP_RESERVED_SHORTCUTS,
  ].map(normalizeShortcut));

  for (const definition of Object.values(TUI_KEYBINDINGS)) {
    const defaultKeys = definition.defaultKeys;
    const keys = defaultKeys === undefined ? [] : Array.isArray(defaultKeys) ? defaultKeys : [defaultKeys];
    for (const key of keys) {
      shortcuts.add(normalizeShortcut(key));
    }
  }

  return shortcuts;
}

function isValidShortcutKeyPart(keyPart: string): boolean {
  const lowerKeyPart = keyPart.toLowerCase();

  if (/^[a-z0-9]$/i.test(keyPart)) return true;
  if (/^f([1-9]|1[0-2])$/i.test(keyPart)) return true;
  if (SHORTCUT_NAMED_KEYS.has(lowerKeyPart)) return true;

  return SHORTCUT_SYMBOL_KEYS.has(keyPart);
}

function parseShortcutOverride(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }

  const parts = trimmed.split("+");
  if (parts.some((part) => part.length === 0)) {
    return null;
  }

  const modifierParts = parts.slice(0, -1).map((part) => {
    const modifier = part.toLowerCase();
    return modifier === "cmd" || modifier === "command" ? "super" : modifier;
  });
  if (new Set(modifierParts).size !== modifierParts.length) {
    return null;
  }

  for (const modifier of modifierParts) {
    if (!SHORTCUT_MODIFIERS.has(modifier)) {
      return null;
    }
  }

  const keyPart = parts[parts.length - 1];
  if (!isValidShortcutKeyPart(keyPart)) {
    return null;
  }

  const normalizedKey = SHORTCUT_SYMBOL_KEYS.has(keyPart) ? keyPart : keyPart.toLowerCase();
  const normalizedShortcut = normalizeShortcut([...modifierParts, normalizedKey].join("+"));
  if (shortcutUsesSuper(normalizedShortcut) && !isSupportedSuperShortcut(normalizedShortcut)) {
    return null;
  }

  return normalizedShortcut;
}

function shortcutUsageKey(shortcut: string): string {
  return shortcutConflictKey(normalizeShortcut(shortcut));
}

function parseShortcutSetting(value: unknown): ShortcutBinding | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return parseShortcutOverride(value) ?? undefined;
}

function findShortcutReplacement(key: PowerlineShortcutKey, used: Set<string>): string | null {
  const preferred = DEFAULT_SHORTCUTS[key];
  if (preferred && !used.has(shortcutUsageKey(preferred))) {
    return preferred;
  }
  return null;
}

function shortcutBelongsToOtherDefault(key: PowerlineShortcutKey, shortcut: string): boolean {
  const usageKey = shortcutUsageKey(shortcut);
  return SHORTCUT_KEYS.some((shortcutKey) => {
    const defaultShortcut = DEFAULT_SHORTCUTS[shortcutKey];
    return shortcutKey !== key && defaultShortcut !== null && shortcutUsageKey(defaultShortcut) === usageKey;
  });
}

function resolveShortcutConfig(settings: Record<string, unknown>): PowerlineShortcuts {
  const resolved: PowerlineShortcuts = { ...DEFAULT_SHORTCUTS };
  const shortcutSettings = settings.powerlineShortcuts;

  if (isRecord(shortcutSettings)) {
    for (const key of SHORTCUT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(shortcutSettings, key)) {
        continue;
      }

      const override = parseShortcutSetting(shortcutSettings[key]);
      if (override !== undefined) {
        resolved[key] = override;
      }
    }
  }

  const used = new Set(Array.from(reservedShortcuts(), shortcutUsageKey));

  for (const key of SHORTCUT_KEYS) {
    const configured = resolved[key];
    if (configured === null) {
      continue;
    }

    const configuredUsageKey = shortcutUsageKey(configured);

    if (!used.has(configuredUsageKey) && !shortcutBelongsToOtherDefault(key, configured)) {
      used.add(configuredUsageKey);
      continue;
    }

    const replacement = findShortcutReplacement(key, used);
    if (!replacement) {
      console.debug(`[beautypi] Shortcut conflict for ${key}: "${configured}" is already in use`);
      resolved[key] = null;
      continue;
    }

    console.debug(
      `[beautypi] Shortcut conflict for ${key}: "${configured}" replaced with "${replacement}"`,
    );

    resolved[key] = replacement;
    used.add(shortcutUsageKey(replacement));
  }

  return resolved;
}

// ═══════════════════════════════════════════════════════════════════════════
// Status Line Builder
// ═══════════════════════════════════════════════════════════════════════════

/** Render a single segment and return its content with width */
function renderSegmentWithWidth(
  segId: StatusLineSegmentId,
  ctx: SegmentContext
): { content: string; width: number; visible: boolean } {
  const rendered = renderSegment(segId, ctx);
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }
  return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

/** Build content string from pre-rendered parts */
function buildContentFromParts(
  parts: string[],
  presetDef: ReturnType<typeof getPreset>,
  frameColor?: (text: string) => string
): string {
  if (parts.length === 0) return "";
  const separatorDef = getSeparator(presetDef.separator);
  const sep = separatorDef.left;
  const sepStyled = frameColor ? frameColor(sep) : `${getFgAnsiCode("sep")}${sep}${ansi.reset}`;
  return " " + parts.join(` ${sepStyled} `) + ansi.reset + " ";
}

interface LaidOutTopSegment {
  id: StatusLineSegmentId;
  /** Zero-based visible column where the segment starts (without the bar prefix). */
  start: number;
  /** Zero-based visible column where the segment ends (exclusive). */
  end: number;
}

interface ResponsiveLayoutResult {
  topContent: string;
  secondaryContent: string;
  topSegments: LaidOutTopSegment[];
}

function isFullscreenTui(tui: any): boolean {
  try {
    return tui?.mode === "fullscreen";
  } catch {
    return false;
  }
}

/**
 * Responsive segment layout - fits segments into top bar, overflows to secondary row.
 * When terminal is wide enough, secondary segments move up to top bar.
 * When narrow, top bar segments overflow down to secondary row.
 */
function computeResponsiveLayout(
  ctx: SegmentContext,
  presetDef: ReturnType<typeof getPreset>,
  availableWidth: number,
  frameColor?: (text: string) => string
): ResponsiveLayoutResult {
  const separatorDef = getSeparator(presetDef.separator);
  const sepWidth = visibleWidth(separatorDef.left) + 2; // separator + spaces around it

  // Get all segments: primary first, then secondary
  const mergedSegments = mergeSegmentsWithCustomItems(presetDef, config.customItems);
  const primaryIds = [...mergedSegments.leftSegments, ...mergedSegments.rightSegments];
  const secondaryIds = mergedSegments.secondarySegments;
  const allSegmentIds = [...primaryIds, ...secondaryIds];

  // Render all segments and get their widths
  const renderedSegments: { id: StatusLineSegmentId; content: string; width: number }[] = [];
  for (const segId of allSegmentIds) {
    const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
    if (visible) {
      renderedSegments.push({ id: segId, content, width });
    }
  }

  if (renderedSegments.length === 0) {
    return { topContent: "", secondaryContent: "", topSegments: [] };
  }

  // Calculate how many segments fit in top bar
  // Account for: leading space (1) + trailing space (1) = 2 chars overhead
  const baseOverhead = 2;
  let currentWidth = baseOverhead;
  let topSegments: { id: StatusLineSegmentId; content: string; width: number }[] = [];
  let overflowSegments: { content: string; width: number }[] = [];
  let overflow = false;

  for (const seg of renderedSegments) {
    const neededWidth = seg.width + (topSegments.length > 0 ? sepWidth : 0);

    if (!overflow && currentWidth + neededWidth <= availableWidth) {
      topSegments.push(seg);
      currentWidth += neededWidth;
    } else {
      overflow = true;
      overflowSegments.push(seg);
    }
  }

  // Fit overflow segments into secondary row (same width constraint)
  // Stop at first non-fitting segment to preserve ordering
  let secondaryWidth = baseOverhead;
  let secondarySegments: string[] = [];

  for (const seg of overflowSegments) {
    const neededWidth = seg.width + (secondarySegments.length > 0 ? sepWidth : 0);
    if (secondaryWidth + neededWidth <= availableWidth) {
      secondarySegments.push(seg.content);
      secondaryWidth += neededWidth;
    } else {
      break;
    }
  }

  const laidOutTopSegments: LaidOutTopSegment[] = [];
  let topOffset = 0;
  for (const seg of topSegments) {
    laidOutTopSegments.push({ id: seg.id, start: topOffset, end: topOffset + seg.width });
    topOffset += seg.width + sepWidth;
  }

  return {
    topContent: buildContentFromParts(topSegments.map((seg) => seg.content), presetDef, frameColor),
    secondaryContent: buildContentFromParts(secondarySegments, presetDef, frameColor),
    topSegments: laidOutTopSegments,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

let blinkOn = true;
let hasFocus = true;
let isBlinking = false;
let blinkTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimeout: ReturnType<typeof setTimeout> | null = null;
let focusCleanup: (() => void) | null = null;
let inputCleanup: (() => void) | null = null;
const BLINK_IDLE_MS = 500;
const BLINK_CYCLE_MS = 600;

export default function powerlineFooter(pi: ExtensionAPI) {
  function scheduleNextBlink() {
    blinkTimer = setTimeout(() => {
      if (!hasFocus || !isBlinking) return;
      blinkOn = !blinkOn;
      tuiRef?.requestRender();
      scheduleNextBlink();
    }, BLINK_CYCLE_MS);
  }

  const startupSettings = readSettings();
  config = parsePowerlineConfig(startupSettings.powerline, PRESET_NAMES);
  let resolvedShortcuts = resolveShortcutConfig(startupSettings);
  let enabled = true;
  let sessionStartTime = Date.now();
  let sessionGeneration = 0;
  let currentCtx: any = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  let getThinkingLevelFn: (() => string) | null = null;
  let currentThinkingLevel: string | null = null;
  let liveAssistantUsage: SessionAssistantUsage | null = null;
  let isStreaming = false;
  let tuiRef: any = null;
  let restoreFooterStatusRepaintHook: (() => void) | null = null;
  let fixedEditorCompositor: TerminalSplitCompositor | null = null;
  let fixedStatusContainer: any = null;
  let fixedEditorContainer: any = null;
  let fixedWidgetContainerAbove: any = null;
  let fixedWidgetContainerBelow: any = null;
  let lastUserPrompt = "";
  let showLastPrompt = true;
  let currentEditor: any = null;

  // Cache for the top and secondary powerline widgets.
  let lastLayoutWidth = 0;
  let lastLayoutResult: ResponsiveLayoutResult | null = null;
  let lastLayoutTimestamp = 0;
  let layoutDirty = true;
  let forceNextLayoutRecompute = false;
  let lastEditorInputAt = 0;

  const statusRenderScheduler = createRenderScheduler(() => {
    const msSinceInput = Date.now() - lastEditorInputAt;
    if (layoutDirty && !forceNextLayoutRecompute && msSinceInput < EDITOR_STATUS_DEFER_MS) {
      statusRenderScheduler.schedule(Math.max(0, EDITOR_STATUS_DEFER_MS - msSinceInput));
      return;
    }

    tuiRef?.requestRender();
  }, STATUS_RENDER_DEBOUNCE_MS);

  const resetLayoutCache = () => {
    lastLayoutResult = null;
    layoutDirty = true;
  };

  const requestStatusRender = (delayMs?: number) => {
    layoutDirty = true;
    statusRenderScheduler.schedule(delayMs);
  };

  const requestImmediateStatusRender = (options: { deferDuringTyping?: boolean } = {}) => {
    layoutDirty = true;
    if (options.deferDuringTyping !== false && Date.now() - lastEditorInputAt < EDITOR_STATUS_DEFER_MS) {
      statusRenderScheduler.schedule();
      return;
    }

    forceNextLayoutRecompute = true;
    statusRenderScheduler.cancel();
    statusRenderScheduler.schedule(0);
  };

  const installFooterStatusRepaintHook = (footerData: ReadonlyFooterDataProvider) => {
    restoreFooterStatusRepaintHook?.();
    restoreFooterStatusRepaintHook = null;

    const writableFooterData = footerData as ReadonlyFooterDataProvider & {
      setExtensionStatus?: (key: string, text: string | undefined) => void;
      clearExtensionStatuses?: () => void;
    };
    if (typeof writableFooterData.setExtensionStatus !== "function") return;

    const originalSetExtensionStatus = writableFooterData.setExtensionStatus;
    const originalClearExtensionStatuses = writableFooterData.clearExtensionStatuses;
    const setExtensionStatusAndRepaint = function setExtensionStatusAndRepaint(this: unknown, key: string, text: string | undefined) {
      originalSetExtensionStatus.call(this, key, text);
      requestImmediateStatusRender();
    };
    writableFooterData.setExtensionStatus = setExtensionStatusAndRepaint;

    let clearExtensionStatusesAndRepaint: (() => void) | null = null;
    if (typeof originalClearExtensionStatuses === "function") {
      clearExtensionStatusesAndRepaint = function clearExtensionStatusesAndRepaint(this: unknown) {
        originalClearExtensionStatuses.call(this);
        requestImmediateStatusRender();
      };
      writableFooterData.clearExtensionStatuses = clearExtensionStatusesAndRepaint;
    }

    restoreFooterStatusRepaintHook = () => {
      if (writableFooterData.setExtensionStatus === setExtensionStatusAndRepaint) {
        writableFooterData.setExtensionStatus = originalSetExtensionStatus;
      }
      if (clearExtensionStatusesAndRepaint && writableFooterData.clearExtensionStatuses === clearExtensionStatusesAndRepaint) {
        writableFooterData.clearExtensionStatuses = originalClearExtensionStatuses;
      }
    };
  };

  // Track session start
  pi.on("session_start", async (event, ctx) => {
    sessionGeneration++;
    sessionStartTime = Date.now();
    currentCtx = ctx;
    customCompactionEnabled = detectCustomCompactionEnabled(ctx.cwd);
    lastUserPrompt = "";
    isStreaming = false;
    liveAssistantUsage = null;

    const settings = readSettings(ctx.cwd);
    resolvedShortcuts = resolveShortcutConfig(settings);
    showLastPrompt = false;
    config = parsePowerlineConfig(settings.powerline, PRESET_NAMES);

    getThinkingLevelFn = typeof ctx.getThinkingLevel === "function"
      ? () => ctx.getThinkingLevel()
      : null;
    currentThinkingLevel = getThinkingLevelFn?.() ?? null;

    if (enabled && ctx.hasUI) {
      setupCustomEditor(ctx);
    }

  });

  pi.on("session_shutdown", async () => {
    sessionGeneration++;
    statusRenderScheduler.cancel();
    restoreFooterStatusRepaintHook?.();
    restoreFooterStatusRepaintHook = null;
    teardownFixedEditorCompositor({ resetExtendedKeyboardModes: true });
    currentCtx = null;
    footerDataRef = null;
    getThinkingLevelFn = null;
    currentThinkingLevel = null;
    liveAssistantUsage = null;
    tuiRef = null;
    currentEditor = null;
    resetLayoutCache();
  });

  // Check if a bash command might change git branch
  const mightChangeGitBranch = (cmd: string): boolean => {
    const gitBranchPatterns = [
      /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
      /\bgit\s+stash\s+(pop|apply)/,
    ];
    return gitBranchPatterns.some(p => p.test(cmd));
  };

  // Invalidate git status on file changes, trigger re-render on potential branch changes
  pi.on("tool_result", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      invalidateGitStatus();
    }
    // Check for bash commands that might change git branch
    if (event.toolName === "bash" && event.input?.command) {
      const cmd = String(event.input.command);
      if (mightChangeGitBranch(cmd)) {
        invalidateGitStatus();
        invalidateGitBranch();
        setTimeout(() => requestStatusRender(), 100);
      }
    }
  });

  // Also catch user escape commands (! prefix)
  pi.on("user_bash", async (event) => {
    if (mightChangeGitBranch(event.command)) {
      invalidateGitStatus();
      invalidateGitBranch();
      setTimeout(() => requestStatusRender(), 100);
      setTimeout(() => requestStatusRender(), 300);
      setTimeout(() => requestStatusRender(), 500);
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    currentCtx = ctx;
    requestStatusRender();
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    currentCtx = ctx;
    currentThinkingLevel = getThinkingLevelFn?.() ?? (typeof event.level === "string" ? event.level : null);
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("session_tree", async (_event, ctx) => {
    currentCtx = ctx;
    currentThinkingLevel = null;
    liveAssistantUsage = null;
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  // Track streaming state (footer only shows status during streaming)
  pi.on("before_agent_start", async (event, ctx) => {
    lastUserPrompt = event.prompt;
  });

  pi.on("agent_start", async (_event, ctx) => {
    isStreaming = true;
    liveAssistantUsage = null;
    currentCtx = ctx;
  });

  pi.on("message_update", async (event, ctx) => {
    if (isSessionAssistantMessage(event.message)
      && event.message.stopReason !== "error"
      && event.message.stopReason !== "aborted"
      && getUsageTokenTotal(event.message.usage) > 0) {
      liveAssistantUsage = event.message.usage;
      currentCtx = ctx;
      layoutDirty = true;
      statusRenderScheduler.schedule(CONTEXT_STATUS_RENDER_MS);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    currentCtx = ctx;
    if (isSessionAssistantMessage(event.message)) {
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        liveAssistantUsage = null;
      } else if (getUsageTokenTotal(event.message.usage) > 0) {
        liveAssistantUsage = event.message.usage;
      }
    }
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("turn_end", async (_event, ctx) => {
    currentCtx = ctx;
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  function copyTextToClipboard(ctx: any, text: string, successMessage?: string): void {
    copyToClipboard(text);
    if (successMessage) {
      ctx.ui.notify(successMessage, "info");
    }
  }

  function getEditorTextForClipboard(ctx: any): string | null {
    const text = getCurrentEditorText(ctx, currentEditor);
    if (hasNonWhitespaceText(text)) {
      return text;
    }

    ctx.ui.notify("Editor is empty", "info");
    return null;
  }

  function getChatJumpShortcutAction(data: string): ChatJumpShortcutAction | null {
    return CHAT_JUMP_SHORTCUTS.find(({ shortcutKey }) => matchesConfiguredShortcut(data, resolvedShortcuts[shortcutKey]))?.action ?? null;
  }

  function getPowerlineShortcutAction(data: string): PowerlineShortcutAction | null {
    if (isKeyRelease(data)) return null;

    if (matchesConfiguredShortcut(data, resolvedShortcuts.copyEditor)) {
      return { kind: "copyEditor" };
    }
    if (matchesConfiguredShortcut(data, resolvedShortcuts.cutEditor)) {
      return { kind: "cutEditor" };
    }

    const chatJumpAction = getChatJumpShortcutAction(data);
    return chatJumpAction ? { kind: "chat", action: chatJumpAction } : null;
  }

  function runPowerlineShortcut(ctx: any, action: PowerlineShortcutAction): void {
    if (action.kind === "copyEditor" || action.kind === "cutEditor") {
      const text = getEditorTextForClipboard(ctx);
      if (!text) return;

      copyTextToClipboard(ctx, text, action.kind === "copyEditor" ? "Copied editor text" : undefined);
      if (action.kind === "cutEditor") {
        ctx.ui.setEditorText("");
        ctx.ui.notify("Cut editor text", "info");
      }
      return;
    }

    if (action.action.kind === "bottom") {
      jumpChatToBottom(ctx);
      return;
    }

    jumpToChatMessage(ctx, action.action.role, action.action.direction);
  }

  pi.on("agent_end", async (_event, ctx) => {
    isStreaming = false;
    liveAssistantUsage = null;
    currentCtx = ctx;
    requestStatusRender();
  });

  // Command to toggle/configure
  pi.registerCommand("powerline", {
    description: "Configure powerline status (toggle, preset)",
    handler: async (args, ctx) => {
      currentCtx = ctx;

      if (!args?.trim()) {
        // Toggle
        enabled = !enabled;
        if (enabled) {
          setupCustomEditor(ctx);
          ctx.ui.notify("Powerline enabled", "info");
        } else {
          restoreFooterStatusRepaintHook?.();
          restoreFooterStatusRepaintHook = null;
          teardownFixedEditorCompositor();
          ctx.ui.setEditorComponent(undefined);
          ctx.ui.setFooter(undefined);
          ctx.ui.setHeader(undefined);
          ctx.ui.setWidget("powerline-top", undefined);
          ctx.ui.setWidget("powerline-secondary", undefined);
          ctx.ui.setWidget("powerline-status", undefined);
          ctx.ui.setWidget("powerline-last-prompt", undefined);
          footerDataRef = null;
          tuiRef = null;
          currentEditor = null;
          statusRenderScheduler.cancel();
          resetLayoutCache();
          ctx.ui.notify("Powerline disabled", "info");
        }
        return;
      }

      const normalizedArgs = args.trim().toLowerCase();
      const mouseScrollMatch = /^mouse-scroll(?:\s+(on|off|toggle))?$/.exec(normalizedArgs);
      if (mouseScrollMatch) {
        const mode = mouseScrollMatch[1] ?? "toggle";
        config.mouseScroll = mode === "toggle" ? !config.mouseScroll : mode === "on";
        if (enabled && ctx.hasUI && config.fixedEditor && tuiRef && currentEditor && !isFullscreenTui(tuiRef)) {
          installFixedEditorCompositor(ctx, tuiRef);
        }

        if (writePowerlineOptionSetting(ctx.cwd, { mouseScroll: config.mouseScroll }, config.preset)) {
          ctx.ui.notify(`Powerline mouse scroll ${config.mouseScroll ? "enabled" : "disabled"}`, "info");
        } else {
          ctx.ui.notify(`Powerline mouse scroll ${config.mouseScroll ? "enabled" : "disabled"} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      const fixedEditorMatch = /^fixed-editor(?:\s+(on|off|toggle))?$/.exec(normalizedArgs);
      if (fixedEditorMatch) {
        if (isFullscreenTui(tuiRef)) {
          ctx.ui.notify("Fixed editor is regular-mode only; Pi manages layout and mouse in fullscreen", "info");
          return;
        }

        const mode = fixedEditorMatch[1] ?? "toggle";
        config.fixedEditor = mode === "toggle" ? !config.fixedEditor : mode === "on";
        if (enabled && ctx.hasUI) {
          setupCustomEditor(ctx);
        }

        if (writePowerlineOptionSetting(ctx.cwd, { fixedEditor: config.fixedEditor }, config.preset)) {
          ctx.ui.notify(`Powerline fixed editor ${config.fixedEditor ? "enabled" : "disabled"}`, "info");
        } else {
          ctx.ui.notify(`Powerline fixed editor ${config.fixedEditor ? "enabled" : "disabled"} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      const preset = normalizePreset(args);
      if (preset) {
        config.preset = preset;
        resetLayoutCache();
        if (enabled) {
          setupCustomEditor(ctx);
        }

        if (writePowerlinePresetSetting(preset, ctx.cwd)) {
          ctx.ui.notify(`Preset set to: ${preset}`, "info");
        } else {
          ctx.ui.notify(`Preset set to: ${preset} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      // Show available presets
      const presetList = Object.keys(PRESETS).join(", ");
      ctx.ui.notify(`Available presets: ${presetList}`, "info");
    },
  });

  pi.registerCommand("stash-history", {
    description: "Open prompt history picker",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      if (!enabled) {
        ctx.ui.notify("Powerline is disabled", "info");
        return;
      }

      ctx.ui.notify("Unknown command. Use /powerline <preset> or /powerline fixed-editor on|off|toggle", "warning");
    },
  });

  if (resolvedShortcuts.copyEditor) {
    pi.registerShortcut(resolvedShortcuts.copyEditor, {
      description: "Copy full editor text",
      handler: async (ctx) => {
        if (!enabled || !ctx.hasUI) return;

        const text = getEditorTextForClipboard(ctx);
        if (!text) return;

        copyTextToClipboard(ctx, text, "Copied editor text");
      },
    });
  }

  if (resolvedShortcuts.cutEditor) {
    pi.registerShortcut(resolvedShortcuts.cutEditor, {
      description: "Cut full editor text",
      handler: async (ctx) => {
        if (!enabled || !ctx.hasUI) return;

        const text = getEditorTextForClipboard(ctx);
        if (!text) return;

        copyTextToClipboard(ctx, text);
        ctx.ui.setEditorText("");
        ctx.ui.notify("Cut editor text", "info");
      },
    });
  }

  for (const { shortcutKey, description, action } of CHAT_JUMP_SHORTCUTS) {
    const shortcut = resolvedShortcuts[shortcutKey];
    if (!shortcut) continue;

    pi.registerShortcut(shortcut, {
      description,
      handler: async (ctx) => {
        if (!enabled || !ctx.hasUI) return;
        runPowerlineShortcut(ctx, { kind: "chat", action });
      },
    });
  }

  function buildSegmentContext(ctx: any, theme: Theme): SegmentContext {
    const presetDef = getPreset(config.preset);
    const colors: ColorScheme = presetDef.colors ?? getDefaultColors();

    // Build usage stats and get thinking level from session
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    let lastAssistant: AssistantMessage | undefined;
    let thinkingLevelFromSession: string | null = null;

    const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
    for (const e of sessionEvents) {
      if (!isRecord(e)) {
        continue;
      }

      // Check for thinking level change entries
      if (e.type === "thinking_level_change" && typeof e.thinkingLevel === "string") {
        thinkingLevelFromSession = e.thinkingLevel;
      }

      if (e.type !== "message" || !isSessionAssistantMessage(e.message)) {
        continue;
      }

      const m = e.message;
      if (m.stopReason === "error" || m.stopReason === "aborted") {
        continue;
      }
      input += m.usage.input;
      output += m.usage.output;
      cacheRead += m.usage.cacheRead;
      cacheWrite += m.usage.cacheWrite;
      cost += m.usage.cost.total;
      if (getUsageTokenTotal(m.usage) > 0) {
        lastAssistant = m;
      }
    }

    // Calculate context percentage.
    const latestUsage = isStreaming ? liveAssistantUsage ?? lastAssistant?.usage : lastAssistant?.usage;
    const coreContextUsage = isStreaming && liveAssistantUsage ? null : readCoreContextUsage(ctx);
    const contextTokens = coreContextUsage?.contextTokens ?? (latestUsage ? getUsageTokenTotal(latestUsage) : 0);
    const contextWindow = coreContextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const contextPercent = coreContextUsage?.contextPercent ?? (contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0);

    // Get git status (cached)
    const segmentOptions = mergeSegmentOptions(presetDef.segmentOptions, config.segmentOptions);
    const gitBranch = footerDataRef?.getGitBranch() ?? null;
    const gitStatus = getGitStatus(gitBranch, segmentOptions.git?.polling);
    const extensionStatuses = footerDataRef?.getExtensionStatuses() ?? new Map();
    const customItemsById = new Map(config.customItems.map((item) => [item.id, item]));
    const hiddenExtensionStatusKeys = collectHiddenExtensionStatusKeys(config.customItems);

    // Check if using OAuth subscription
    const usingSubscription = ctx.model
      ? ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false
      : false;

    const thinkingLevel = currentThinkingLevel ?? thinkingLevelFromSession ?? getThinkingLevelFn?.() ?? "off";

    return {
      model: ctx.model,
      thinkingLevel,
      sessionId: ctx.sessionManager?.getSessionId?.(),
      cwd: ctx.cwd,
      usageStats: { input, output, cacheRead, cacheWrite, cost },
      contextPercent,
      contextWindow,
      autoCompactEnabled: ctx.settingsManager?.getCompactionSettings?.()?.enabled ?? true,
      customCompactionEnabled: customCompactionEnabled || extensionStatuses.has(CUSTOM_COMPACTION_STATUS_KEY),
      usingSubscription,
      sessionStartTime,
      git: gitStatus,
      extensionStatuses,
      hiddenExtensionStatusKeys,
      customItemsById,
      options: segmentOptions,
      theme,
      colors,
    };
  }

  /**
   * Get cached responsive layout or compute fresh one.
   */
  function getResponsiveLayout(width: number, theme: Theme): ResponsiveLayoutResult {
    const now = Date.now();
    const cacheTtl = isStreaming ? STREAMING_LAYOUT_CACHE_TTL_MS : LAYOUT_CACHE_TTL_MS;

    if (lastLayoutResult && lastLayoutWidth === width) {
      const msSinceInput = now - lastEditorInputAt;
      const typingRecently = msSinceInput < EDITOR_STATUS_DEFER_MS;

      if (!forceNextLayoutRecompute && typingRecently && (layoutDirty || now - lastLayoutTimestamp >= cacheTtl)) {
        return lastLayoutResult;
      }

      if (!layoutDirty && now - lastLayoutTimestamp < cacheTtl) {
        return lastLayoutResult;
      }
    }

    const presetDef = getPreset(config.preset);
    const segmentCtx = buildSegmentContext(currentCtx, theme);

    lastLayoutWidth = width;
    lastLayoutResult = computeResponsiveLayout(segmentCtx, presetDef, width, resolveFrameColor(theme));
    lastLayoutTimestamp = now;
    layoutDirty = false;
    forceNextLayoutRecompute = false;

    return lastLayoutResult;
  }

  function renderPowerlineStatusLines(width: number): string[] {
    if (!currentCtx || !footerDataRef) return [];

    const statuses = footerDataRef.getExtensionStatuses();
    if (!statuses || statuses.size === 0) return [];
    const hiddenExtensionStatusKeys = collectHiddenExtensionStatusKeys(config.customItems);

    const notifications: string[] = [];
    for (const value of getNotificationExtensionStatuses(statuses, hiddenExtensionStatusKeys)) {
      const lineContent = ` ${value}`;
      if (visibleWidth(lineContent) <= width) {
        notifications.push(lineContent);
      }
    }

    return notifications;
  }

  function wrapText(text: string, maxWidth: number): { lines: string[]; positions: number[] } {
    const lines: string[] = [];
    const positions: number[] = [];
    let pos = 0;
    const len = text.length;
    while (pos < len) {
      const remaining = len - pos;
      if (remaining <= maxWidth) {
        lines.push(text.slice(pos));
        positions.push(pos);
        break;
      }
      const segment = text.slice(pos, pos + maxWidth);
      const spaceIdx = segment.lastIndexOf(" ");
      if (spaceIdx > 0) {
        lines.push(segment.slice(0, spaceIdx));
        positions.push(pos);
        pos += spaceIdx + 1;
      } else {
        lines.push(segment);
        positions.push(pos);
        pos += maxWidth;
      }
    }
    if (lines.length === 0) {
      lines.push("");
      positions.push(0);
    }
    return { lines, positions };
  }

  const MAX_FOOTER_LINES = 5;
  const MAX_CONTENT_LINES = 4;

  /**
   * Color for the footer frame (bar outline, segment separators, side bars,
   * bottom cap). Always the theme's border color — the same color as the
   * splash screen outline — so it never changes with the thinking level.
   */
  function resolveFrameColor(theme: Theme): (text: string) => string {
    return (text: string) => {
      try {
        return theme.fg("border", text);
      } catch {
        try {
          return theme.fg("borderMuted", text);
        } catch {
          return text;
        }
      }
    };
  }

  /** Render the powerline bar line (also used as the fullscreen editor frame top). */
  function renderPowerlineBarLine(width: number, theme: Theme, hiddenAbove = 0): string | null {
    if (!currentCtx) return null;

    const layout = getResponsiveLayout(width, theme);
    if (!layout.topContent) return null;

    const bc = resolveFrameColor(theme);
    const raw = layout.topContent;
    const stripped = raw.replace(/\x1b\[[0-9;]*m/g, "");
    const indicator = hiddenAbove > 0 ? ` ↑ ${hiddenAbove} more ` : "";
    const visibleRawLen = visibleWidth(stripped) + visibleWidth(indicator);

    const fill = Math.max(0, width - visibleRawLen - 5);
    return bc("╭── ") + raw.trim() + " " + (indicator ? bc(indicator) : "") + bc("─".repeat(fill + 1)) + bc("╮");
  }

  function renderPowerlineTopLines(width: number, ctx: any, theme: Theme): string[] {
    if (!ctx) return [];

    const topLine = renderPowerlineBarLine(width, theme);
    if (!topLine) return [];

    const bc = resolveFrameColor(theme);

    // Collect all visual lines from all editor lines with wrapping
    const fullText = (currentEditor?.getText?.() ?? ctx.ui?.getEditorText?.() ?? "").replace(/\r/g, "");
    const editorLines = fullText.split("\n");
    const REV_ON = "\x1b[7m";
    const REV_OFF = "\x1b[27m";

    // Get editor cursor position
    const cursorLine = currentEditor?.state?.cursorLine ?? 0;
    const cursorCol = currentEditor?.state?.cursorCol ?? 0;
    const showCursor = hasFocus && (!isBlinking || blinkOn);
    const wrapWidth = Math.max(1, width - 6);

    // Build all wrapped visual lines with cursor tracking
    type VLine = { text: string; hasCursor: boolean; cursorOffset: number };
    const allVisualLines: VLine[] = [];

    for (let li = 0; li < editorLines.length; li++) {
      const { lines: wrapped, positions } = wrapText(editorLines[li], wrapWidth);
      for (let wi = 0; wi < wrapped.length; wi++) {
        const seg = wrapped[wi];
        const startCol = positions[wi];
        const hasCursor = li === cursorLine && cursorCol >= startCol && cursorCol <= startCol + seg.length;
        const cursorOffset = hasCursor ? (cursorCol - startCol) : -1;
        allVisualLines.push({ text: seg, hasCursor, cursorOffset });
      }
    }

    // Empty text: one empty line with cursor
    if (allVisualLines.length === 0) {
      allVisualLines.push({ text: "", hasCursor: true, cursorOffset: 0 });
    }

    // Determine visible window (keep cursor in view, fixed total height)
    let startIdx = 0;
    if (allVisualLines.length > MAX_FOOTER_LINES) {
      const cursorVisIdx = allVisualLines.findIndex(vl => vl.hasCursor);
      if (cursorVisIdx >= 0) {
        if (cursorVisIdx >= MAX_CONTENT_LINES) {
          startIdx = cursorVisIdx - MAX_CONTENT_LINES + 1;
        }
      } else {
        startIdx = allVisualLines.length - MAX_FOOTER_LINES;
      }
    }

    const showEllipsis = startIdx > 0;
    const maxLines = showEllipsis ? MAX_CONTENT_LINES : MAX_FOOTER_LINES;
    const visibleLines = allVisualLines.slice(startIdx, startIdx + maxLines);

    const lines: string[] = [];
    if (showEllipsis) {
      lines.push(bc("│  ") + theme.fg("dim", "\u2026") + " ".repeat(Math.max(0, width - 7)) + bc("  │"));
    }

    for (let i = 0; i < visibleLines.length; i++) {
      const vl = visibleLines[i];
      const isLast = i === visibleLines.length - 1;

      let displayText: string;
      if (vl.hasCursor && showCursor) {
        const before = vl.text.slice(0, vl.cursorOffset);
        const atCursor = vl.text.slice(vl.cursorOffset, vl.cursorOffset + 1) || " ";
        const after = vl.text.slice(vl.cursorOffset + 1);
        displayText = before + REV_ON + atCursor + REV_OFF + after;
      } else {
        displayText = vl.text;
      }

      const cw = visibleWidth(displayText);
      if (isLast) {
        lines.push(truncateToWidth(bc("╰─ ") + displayText + " ".repeat(Math.max(0, width - 5 - cw)) + bc("─╯"), width, "", true));
      } else {
        lines.push(truncateToWidth(bc("│  ") + displayText + " ".repeat(Math.max(0, width - 6 - cw)) + bc("  │"), width, "", true));
      }
    }

    return [topLine, ...lines];
  }

  function renderPowerlineSecondaryLines(width: number, theme: Theme): string[] {
    if (!currentCtx) return [];

    const layout = getResponsiveLayout(width, theme);
    return layout.secondaryContent ? [layout.secondaryContent] : [];
  }

  function renderLastPromptLines(width: number, theme: Theme): string[] {
    if (!showLastPrompt || !lastUserPrompt) return [];

    const frameColor = resolveFrameColor(theme);
    const prefix = ` ${frameColor("\u21B3")} `;
    const availableWidth = width - visibleWidth(prefix);
    if (availableWidth < 10) return [];

    let promptText = lastUserPrompt.replace(/\s+/g, " ").trim();
    if (!promptText) return [];

    promptText = truncateToWidth(promptText, availableWidth, "\u2026");

    const styledPrompt = frameColor(promptText);
    const line = `${prefix}${styledPrompt}`;
    return [truncateToWidth(line, width, "\u2026")];
  }

  function teardownFixedEditorCompositor(options?: { resetExtendedKeyboardModes?: boolean }) {
    const hadCompositor = fixedEditorCompositor !== null;
    fixedEditorCompositor?.dispose(options);
    if (!hadCompositor && options?.resetExtendedKeyboardModes) {
      try {
        process.stdout.write(emergencyTerminalModeReset());
      } catch {
        // Shutdown cleanup cannot surface useful terminal write failures.
      }
    }
    fixedEditorCompositor = null;
    fixedStatusContainer = null;
    fixedEditorContainer = null;
    fixedWidgetContainerAbove = null;
    fixedWidgetContainerBelow = null;
  }

  /**
   * Pi's fullscreen mode copies mouse selections to the system clipboard
   * (`fullscreenCopyOnSelect`) and flashes "Copied!". Beautypi unifies the
   * clipboard model with its regular-mode compositor instead: marking text
   * writes the X11 primary selection (middle-click buffer), while an explicit
   * Ctrl+Shift+C copies to the system clipboard.
   */
  function installFullscreenClipboardSemantics(tui: any): void {
    if (!isFullscreenTui(tui)) return;

    try {
      if (Reflect.get(tui, "beautypiClipboardPatched") === true) return;
      Reflect.set(tui, "beautypiClipboardPatched", true);

      // Keep the release path active so the redirect below always runs.
      if (typeof tui.setCopyOnSelect === "function") {
        tui.setCopyOnSelect(true);
      }

      if (typeof tui.copySelectionToClipboard === "function") {
        tui.copySelectionToClipboard = () => {
          try {
            const text = tui.getActiveSelectionText?.();
            if (typeof text === "string" && text.length > 0) {
              writePrimarySelection(text);
            }
          } catch {
            // Clipboard sync is best effort.
          }
          return Promise.resolve(true);
        };
      }
    } catch {
      // Keep Pi's default behavior when the renderer internals differ.
    }
  }

  function findContainerWithChild(tui: any, child: any): { container: any; index: number } | null {
    const children = Array.isArray(tui?.children) ? tui.children : [];
    const index = children.findIndex((candidate: any) => Array.isArray(candidate?.children) && candidate.children.includes(child));
    if (index === -1) return null;

    return { container: children[index], index };
  }

  function installFixedEditorCompositor(ctx: any, tui: any) {
    teardownFixedEditorCompositor();

    if (!ctx.hasUI || !config.fixedEditor || isFullscreenTui(tui)) return;
    if (!tui?.terminal || typeof tui.terminal.write !== "function") {
      throw new Error("[beautypi] Fixed editor compositor could not find tui.terminal.write()");
    }
    if (!currentEditor) {
      throw new Error("[beautypi] Fixed editor compositor expected the custom editor to be installed first");
    }

    const editorContainerMatch = findContainerWithChild(tui, currentEditor);
    if (!editorContainerMatch) {
      throw new Error("[beautypi] Fixed editor compositor could not find the editor container in TUI children");
    }

    const tuiChildren = Array.isArray(tui.children) ? tui.children : [];
    fixedEditorContainer = editorContainerMatch.container;
    const statusContainerCandidate = tuiChildren[editorContainerMatch.index - 2] ?? null;
    fixedStatusContainer = statusContainerCandidate && typeof statusContainerCandidate.render === "function"
      ? statusContainerCandidate
      : null;
    fixedWidgetContainerAbove = tuiChildren[editorContainerMatch.index - 1] ?? null;
    fixedWidgetContainerBelow = tuiChildren[editorContainerMatch.index + 1] ?? null;

    let compositor: TerminalSplitCompositor;
    compositor = new TerminalSplitCompositor({
      tui,
      terminal: tui.terminal,
      mouseScroll: config.mouseScroll,
      keyboardScrollShortcuts: {
        up: resolvedShortcuts.scrollChatUp,
        down: resolvedShortcuts.scrollChatDown,
      },
      onCopySelection: (text) => {
        writePrimarySelection(text);
      },
      onKeyboardCopy: (text) => {
        copyToClipboard(text);
      },
      onEditorTextClick: (col, visLineIndex) => {
        currentEditor?.setCursorFromTerminalPosition(col, visLineIndex);
        blinkOn = true;
        isBlinking = false;
        if (hideTimeout) clearTimeout(hideTimeout);
        if (blinkTimer) { clearTimeout(blinkTimer); blinkTimer = null; }
        hideTimeout = setTimeout(() => {
          if (!hasFocus || isBlinking) return;
          isBlinking = true;
          blinkOn = false;
          tuiRef?.requestRender();
          scheduleNextBlink();
        }, BLINK_IDLE_MS);
      },
      getShowHardwareCursor: () => typeof tui.getShowHardwareCursor === "function" && tui.getShowHardwareCursor(),
      renderCluster: (width, terminalRows) => {
        const theme = currentCtx?.ui?.theme ?? ctx.ui.theme;
        let showMore = false;
        try { showMore = currentCtx?.ui?.getToolsExpanded?.() ?? false; } catch {}
        const statusContainerLines = showMore && fixedStatusContainer
          ? compositor.renderHidden(fixedStatusContainer, width).filter((line) => visibleWidth(line) > 0)
          : [];
        const aboveWidgetLines = fixedWidgetContainerAbove ? compositor.renderHidden(fixedWidgetContainerAbove, width) : [];
        const belowWidgetLines = fixedWidgetContainerBelow ? compositor.renderHidden(fixedWidgetContainerBelow, width) : [];
        const statusLines = showMore
          ? [...aboveWidgetLines, ...renderPowerlineStatusLines(width), ...statusContainerLines]
          : [""];
        return renderFixedEditorCluster({
          width,
          terminalRows,
          statusLines,
          topLines: renderPowerlineTopLines(width, currentCtx, theme),
          editorLines: fixedEditorContainer ? compositor.renderHidden(fixedEditorContainer, width) : [],
          secondaryLines: [...renderPowerlineSecondaryLines(width, theme), ...belowWidgetLines],
          transcriptLines: [],
          lastPromptLines: renderLastPromptLines(width),
        });
      },
    });

    fixedEditorCompositor = compositor;
    if (fixedStatusContainer?.render) compositor.hideRenderable(fixedStatusContainer);
    if (fixedWidgetContainerAbove?.render) compositor.hideRenderable(fixedWidgetContainerAbove);
    compositor.hideRenderable(fixedEditorContainer);
    if (fixedWidgetContainerBelow?.render) compositor.hideRenderable(fixedWidgetContainerBelow);
    compositor.install();

    // Wire compositor → editor so backspace/delete can delete selections
    if (currentEditor) {
      currentEditor.compositorRef = compositor;
    }

    function patchCompRender(comp: any): void {
      const orig = comp.render.bind(comp);
      comp.render = (w: number): string[] => {
        const lines = orig(w);
        const text = lines.join("");
        if (/(?:Update|Package).*?Available|What's New|Error:|Warning:/i.test(text)) return lines;
        try { if (ctx.ui?.getToolsExpanded?.()) return lines; } catch {}
        return [];
      };
    }

    function collectAllUnpatched(_node: any, out: any[] = []): any[] {
      if (!collectAllUnpatched._chat) {
        if (!Array.isArray(tui.children)) return out;
        collectAllUnpatched._chat = tui.children.find((c: any) =>
          c !== fixedEditorContainer && Array.isArray(c.children) &&
          c.children.some((cc: any) => typeof cc.setExpanded === "function")
        );
      }
      const chat = collectAllUnpatched._chat;
      if (!chat || !Array.isArray(chat.children)) return out;
      for (const child of chat.children) {
        if (child === currentEditor) continue;
        if (typeof child.setExpanded === "function" && typeof child.setText === "function" && !child.__expPatched) {
          out.push(child);
          child.__expPatched = true;
        }
        if (typeof child.setExpanded !== "function" && typeof child.setText === "function" && child.constructor?.name !== "Markdown" && !child.__txtPatched) {
          out.push(child);
          child.__txtPatched = true;
        }
        if (typeof child.setLines === "function" && !child.__spPatched) {
          out.push(child);
          child.__spPatched = true;
        }
      }
      return out;
    }

    const compositorDoRender = tui.doRender.bind(tui);
    tui.doRender = () => {
      for (const comp of collectAllUnpatched(tui)) {
        patchCompRender(comp);
      }
      compositorDoRender();
    };

    tui.requestRender(true);
  }

  function isChatMessageComponentForRole(component: unknown, role: ChatJumpRole): boolean {
    const componentName = typeof component === "object" && component !== null ? component.constructor?.name : undefined;
    if (role === "assistant") {
      return componentName === "AssistantMessageComponent";
    }

    return componentName === "UserMessageComponent" || componentName === "SkillInvocationMessageComponent";
  }

  function renderLineCount(component: unknown, width: number): number {
    if (typeof component !== "object" || component === null) return 0;

    const render = Reflect.get(component, "render");
    if (typeof render !== "function") return 0;

    const lines = render.call(component, width);
    return Array.isArray(lines) ? lines.length : 0;
  }

  function collectMessageStartLines(component: unknown, width: number, role: ChatJumpRole, offset: number): {
    targets: number[];
    lineCount: number;
  } {
    const lineCount = renderLineCount(component, width);
    if (isChatMessageComponentForRole(component, role)) {
      return { targets: [offset], lineCount };
    }

    const children = typeof component === "object" && component !== null ? Reflect.get(component, "children") : null;
    if (!Array.isArray(children) || children.length === 0) {
      return { targets: [], lineCount };
    }

    const targets: number[] = [];
    let childOffset = offset;
    let childrenLineCount = 0;
    for (const child of children) {
      const result = collectMessageStartLines(child, width, role, childOffset);
      targets.push(...result.targets);
      childOffset += result.lineCount;
      childrenLineCount += result.lineCount;
    }

    return { targets, lineCount: Math.max(lineCount, childrenLineCount) };
  }

  function collectChatMessageStartLines(role: ChatJumpRole): number[] {
    const children = Array.isArray(tuiRef?.children) ? tuiRef.children : [];
    const width = Math.max(1, tuiRef?.terminal?.columns ?? 80);
    const targets: number[] = [];
    let offset = 0;

    for (const child of children) {
      const result = collectMessageStartLines(child, width, role, offset);
      targets.push(...result.targets);
      offset += result.lineCount;
    }

    return [...new Set(targets)].sort((a, b) => a - b);
  }

  function jumpToChatMessage(ctx: any, role: ChatJumpRole, direction: ChatJumpDirection): void {
    if (isFullscreenTui(tuiRef)) return;

    if (!fixedEditorCompositor) {
      ctx.ui.notify("Chat message jumps require /powerline fixed-editor on", "warning");
      return;
    }

    const targets = collectChatMessageStartLines(role);
    const label = role === "assistant" ? "LLM" : "user";
    if (targets.length === 0) {
      ctx.ui.notify(`No ${label} messages found`, "info");
      return;
    }

    const jumped = direction === "previous"
      ? fixedEditorCompositor.jumpToPreviousRootTarget(targets)
      : fixedEditorCompositor.jumpToNextRootTarget(targets);
    if (!jumped) {
      ctx.ui.notify(`No ${direction} ${label} message`, "info");
    }
  }

  function jumpChatToBottom(ctx: any): void {
    if (isFullscreenTui(tuiRef)) return;

    if (!fixedEditorCompositor) {
      ctx.ui.notify("Chat bottom jump requires /powerline fixed-editor on", "warning");
      return;
    }

    fixedEditorCompositor.jumpToRootBottom();
  }

  let widgetRendersTopLine = true;

  function formatUsageNumber(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "0";
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return String(Math.round(value));
  }

  function formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  function buildSegmentInfo(segId: StatusLineSegmentId, theme: Theme): { title: string; lines: string[] } {
    const segmentCtx = buildSegmentContext(currentCtx, theme);
    const usage = segmentCtx.usageStats;
    const sessionId = currentCtx?.sessionManager?.getSessionId?.();
    const label = (name: string, value: string) => `${theme.fg("muted", `${name}:`)} ${value}`;

    switch (segId) {
      case "model":
        return {
          title: "Model",
          lines: [
            label("Modell", segmentCtx.model?.id ?? "unbekannt"),
            label("Provider", segmentCtx.model?.provider ?? "unbekannt"),
            label("Kontextfenster", segmentCtx.contextWindow ? formatUsageNumber(segmentCtx.contextWindow) : "unbekannt"),
          ],
        };
      case "thinking":
        return { title: "Thinking", lines: [label("Level", segmentCtx.thinkingLevel || "unbekannt")] };
      case "path":
        copyToClipboard(segmentCtx.cwd);
        return { title: "Pfad", lines: [label("CWD", segmentCtx.cwd), theme.fg("dim", "In die Zwischenablage kopiert.")] };
      case "git":
        return {
          title: "Git",
          lines: [
            label("Branch", segmentCtx.git.branch ?? "–"),
            label("Staged", String(segmentCtx.git.staged)),
            label("Unstaged", String(segmentCtx.git.unstaged)),
            label("Untracked", String(segmentCtx.git.untracked)),
          ],
        };
      case "context_pct":
      case "context_total":
        return {
          title: "Kontext",
          lines: [
            label("Nutzung", `${segmentCtx.contextPercent}% von ${formatUsageNumber(segmentCtx.contextWindow)}`),
            label("Auto-Compact", segmentCtx.autoCompactEnabled ? "an" : "aus"),
            label("Custom Compaction", segmentCtx.customCompactionEnabled ? "an" : "aus"),
          ],
        };
      case "token_in":
        return { title: "Tokens (Input)", lines: [label("Input", formatUsageNumber(usage.input))] };
      case "token_out":
        return { title: "Tokens (Output)", lines: [label("Output", formatUsageNumber(usage.output))] };
      case "token_total":
        return {
          title: "Tokens",
          lines: [
            label("Input", formatUsageNumber(usage.input)),
            label("Output", formatUsageNumber(usage.output)),
            label("Gesamt", formatUsageNumber(usage.input + usage.output)),
          ],
        };
      case "cache_read":
        return { title: "Cache (Read)", lines: [label("Cache Read", formatUsageNumber(usage.cacheRead))] };
      case "cache_write":
        return { title: "Cache (Write)", lines: [label("Cache Write", formatUsageNumber(usage.cacheWrite))] };
      case "cost":
        return {
          title: "Kosten",
          lines: [
            label("Gesamt", `$${usage.cost.toFixed(4)}`),
            label("Subscription", segmentCtx.usingSubscription ? "ja" : "nein"),
          ],
        };
      case "session": {
        const id = sessionId ?? "unbekannt";
        if (sessionId) copyToClipboard(id);
        return {
          title: "Session",
          lines: [label("ID", id), label("CWD", segmentCtx.cwd), theme.fg("dim", "ID in die Zwischenablage kopiert.")],
        };
      }
      case "hostname":
        return { title: "Host", lines: [label("Hostname", hostname())] };
      case "time":
        return { title: "Zeit", lines: [label("Jetzt", new Date().toLocaleTimeString())] };
      case "time_spent":
        return {
          title: "Laufzeit",
          lines: [
            label("Session-Start", new Date(segmentCtx.sessionStartTime).toLocaleTimeString()),
            label("Dauer", formatDuration(Date.now() - segmentCtx.sessionStartTime)),
          ],
        };
      case "extension_statuses": {
        const statuses = footerDataRef?.getExtensionStatuses() ?? new Map<string, string>();
        const lines = [...statuses.entries()].map(([key, value]) => label(key, value));
        return { title: "Extension-Status", lines: lines.length > 0 ? lines : [theme.fg("dim", "Keine Statusmeldungen")] };
      }
      case "subagents": {
        const rendered = renderSegmentWithWidth("subagents", segmentCtx);
        return { title: "Subagents", lines: [rendered.content || theme.fg("dim", "Keine Subagents aktiv")] };
      }
      case "shell_mode": {
        const rendered = renderSegmentWithWidth("shell_mode", segmentCtx);
        return { title: "Shell-Modus", lines: [rendered.content || theme.fg("dim", "Inaktiv")] };
      }
      default: {
        const rendered = renderSegmentWithWidth(segId, segmentCtx);
        return { title: String(segId), lines: [rendered.content || theme.fg("dim", "Keine Details verfügbar")] };
      }
    }
  }

  async function showSegmentInfo(ctx: any, theme: Theme, segId: StatusLineSegmentId): Promise<void> {
    const { title, lines } = buildSegmentInfo(segId, theme);

    const maxWidth = Math.max(visibleWidth(title) + 2, ...lines.map((line) => visibleWidth(line)), 24);
    const termWidth = Math.max(40, tuiRef?.terminal?.columns ?? 100);
    const overlayWidth = Math.min(maxWidth + 4, termWidth - 4);

    if (typeof ctx?.ui?.custom === "function") {
      try {
        await ctx.ui.custom((_tui: any, overlayTheme: Theme, _keybindings: any, done: (result?: undefined) => void) => {
          const close = () => done(undefined);
          return {
            dispose() {},
            invalidate() {},
            handleInput() {
              close();
            },
            handleMouse() {
              close();
              return { handled: true };
            },
            render(width: number): string[] {
              const boxWidth = Math.min(overlayWidth, Math.max(24, width - 2));
              const innerWidth = Math.max(1, boxWidth - 4);
              const border = (text: string) => overlayTheme.fg("border", text);
              const out: string[] = [];

              const titleText = ` ${title} `;
              out.push(border("╭─" + titleText + "─".repeat(Math.max(0, boxWidth - 3 - visibleWidth(titleText))) + "╮"));

              for (const line of lines) {
                const truncated = truncateToWidth(line, innerWidth, "…");
                const padding = Math.max(0, innerWidth - visibleWidth(truncated));
                out.push(border("│ ") + truncated + " ".repeat(padding) + border(" │"));
              }

              const hint = " Esc/Klick: schließen ";
              out.push(border("╰─" + hint + "─".repeat(Math.max(0, boxWidth - 3 - visibleWidth(hint))) + "╯"));
              return out;
            },
          };
        }, { overlay: true, overlayOptions: { width: overlayWidth, anchor: "center" } });
        return;
      } catch {
        // Fall through to a notification when the overlay cannot be shown.
      }
    }

    ctx.ui.notify(`${title}: ${lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join(" · ")}`, "info");
  }

  function handlePowerlineBarClick(ctx: any, theme: Theme, event: any): { handled: boolean } | null {
    try {
      if (event?.type !== "click" || event.button !== "left" || event.y !== 0) return null;
      const width = Math.max(1, event.width ?? tuiRef?.terminal?.columns ?? 80);
      const layout = getResponsiveLayout(width, theme);
      const x = event.x - 4; // bar prefix: "╭── "
      const hit = layout.topSegments.find((segment) => x >= segment.start && x < segment.end);
      if (!hit) return null;
      void showSegmentInfo(ctx, theme, hit.id);
      return { handled: true };
    } catch {
      return null;
    }
  }

  function installPowerlineWidgets(ctx: any, renderTopLine = true) {
    widgetRendersTopLine = renderTopLine;

    ctx.ui.setWidget("powerline-status", () => ({
      dispose() {},
      invalidate() {
        requestStatusRender();
      },
      render(width: number): string[] {
        return renderPowerlineStatusLines(width);
      },
    }), { placement: "aboveEditor" });

    ctx.ui.setWidget("powerline-top", (_tui: any, theme: Theme) => ({
      dispose() {},
      invalidate() {
        resetLayoutCache();
      },
      render(width: number): string[] {
        // In fullscreen mode the editor frame draws the bar itself.
        return widgetRendersTopLine ? renderPowerlineTopLines(width, currentCtx, theme) : [];
      },
      handleMouse(event: any): { handled: boolean } | undefined {
        // Pi only synthesizes the "click" event for presses that a component
        // claimed, so the left press on the bar row must be handled here.
        if (event?.type === "press" && event.button === "left" && event.y === 0) {
          return { handled: true };
        }
        return handlePowerlineBarClick(ctx, theme, event) ?? undefined;
      },
    }), { placement: "aboveEditor" });

    ctx.ui.setWidget("powerline-secondary", (_tui: any, theme: Theme) => ({
      dispose() {},
      invalidate() {
        resetLayoutCache();
      },
      render(width: number): string[] {
        return renderPowerlineSecondaryLines(width, theme);
      },
    }), { placement: "belowEditor" });

    ctx.ui.setWidget("powerline-last-prompt", (_tui: any, theme: Theme) => ({
      dispose() {},
      invalidate() {},
      render(width: number): string[] {
        return renderLastPromptLines(width, theme);
      },
    }), { placement: "belowEditor" });
  }

  function setupCustomEditor(ctx: any) {
    if (!enabled) {
      return;
    }

    teardownFixedEditorCompositor();
    ctx.ui.setWidget("powerline-top", undefined);
    ctx.ui.setWidget("powerline-secondary", undefined);
    ctx.ui.setWidget("powerline-status", undefined);
    ctx.ui.setWidget("powerline-last-prompt", undefined);

    let autocompleteReady = false;

    const editorFactory = (tui: any, editorTheme: any, keybindings: any) => {
      installStartupResourceGating(tui, {
        isToolOutputExpanded: typeof ctx.ui?.getToolsExpanded === "function"
          ? () => ctx.ui.getToolsExpanded() === true
          : undefined,
        theme: editorTheme,
      });

      const fullscreenTui = isFullscreenTui(tui);
      const editor = new PowerlineEditor(tui, editorTheme, keybindings, {
        keybindings,
        editorBoundaryShortcuts: {
          start: resolvedShortcuts.editorStart,
          end: resolvedShortcuts.editorEnd,
        },
        onNotify: (message, level = "info") => ctx.ui.notify(message, level),
        // In fullscreen mode Pi renders the editor natively; rebuild the
        // frame (bar, side borders, bottom cap) on top of its render output
        // instead of using the terminal compositor. The editor factory only
        // receives a minimal editor theme, so the full theme comes from
        // ctx.ui.theme.
        renderFrameBar: fullscreenTui
          ? (width: number, hiddenAbove: number) => {
              try {
                return renderPowerlineBarLine(width, ctx.ui.theme, hiddenAbove);
              } catch {
                return null;
              }
            }
          : undefined,
        frameColor: fullscreenTui
          ? (text: string) => resolveFrameColor(ctx.ui.theme)(text)
          : undefined,
        onFrameBarClick: fullscreenTui
          ? (x: number, width: number) => handlePowerlineBarClick(ctx, ctx.ui.theme, {
              type: "click",
              button: "left",
              y: 0,
              x,
              width,
            }) !== null
          : undefined,
      });

      currentEditor = editor;

      const originalHandleInput = editor.handleInput.bind(editor);
      editor.handleInput = (data: string) => {
        lastEditorInputAt = Date.now();

        const powerlineShortcutAction = getPowerlineShortcutAction(data);
        if (powerlineShortcutAction) {
          runPowerlineShortcut(ctx, powerlineShortcutAction);
          return;
        }

        if (!autocompleteReady) {
          autocompleteReady = true;
          const candidate = Reflect.get(editor, "autocompleteProvider");
          const hasProvider = candidate
            && typeof candidate === "object"
            && typeof Reflect.get(candidate, "getSuggestions") === "function";
          if (!hasProvider) {
            ctx.ui.setEditorComponent(editorFactory);
            if (config.fixedEditor && tuiRef && !isFullscreenTui(tuiRef)) {
              installFixedEditorCompositor(ctx, tuiRef);
            }
            currentEditor?.handleInput(data);
            return;
          }
        }

        originalHandleInput(data);
      };

      if (!isFullscreenTui(tui)) {
        const originalRender = editor.render.bind(editor);
        editor.render = (width: number): string[] => {
          if (width < 10) return originalRender(width);
          if (editor.autocompleteState && editor.autocompleteList) {
            const contentWidth = Math.max(1, width - (editor.paddingX || 0) * 2);
            return editor.autocompleteList.render(contentWidth);
          }
          return [];
        };
      }

      return editor;
    };

    ctx.ui.setEditorComponent(editorFactory);

    ctx.ui.setFooter((tui: any, footerTheme: Theme, footerData: ReadonlyFooterDataProvider) => {
      footerDataRef = footerData;
      tuiRef = tui;
      installStartupResourceGating(tui, {
        isToolOutputExpanded: typeof ctx.ui?.getToolsExpanded === "function"
          ? () => ctx.ui.getToolsExpanded() === true
          : undefined,
        theme: footerTheme,
      });
      installFooterStatusRepaintHook(footerData);
      installFullscreenClipboardSemantics(tui);

      process.stdout.write("\x1b[?1004h");

      if (typeof tui.addInputListener === "function") {
        focusCleanup = tui.addInputListener((data: string) => {
          if (data === "\x1b[I") {
            hasFocus = true;
            blinkOn = true;
            isBlinking = false;
            if (hideTimeout) clearTimeout(hideTimeout);
            if (blinkTimer) { clearTimeout(blinkTimer); blinkTimer = null; }
            hideTimeout = setTimeout(() => {
              if (!hasFocus || isBlinking) return;
              isBlinking = true;
              blinkOn = false;
              tuiRef?.requestRender();
              scheduleNextBlink();
            }, BLINK_IDLE_MS);
            tuiRef?.requestRender();
            return { consume: true };
          }
          if (data === "\x1b[O") {
            hasFocus = false;
            blinkOn = false;
            tuiRef?.requestRender();
            return { consume: true };
          }
          if (
            isFullscreenTui(tui)
            && !isKeyRelease(data)
            && matchesKey(data, "ctrl+shift+c")
          ) {
            try {
              const hasSelection = typeof tui.hasActiveSelection === "function" && tui.hasActiveSelection();
              if (hasSelection && typeof tui.copyActiveSelectionToClipboard === "function") {
                void tui.copyActiveSelectionToClipboard();
                return { consume: true };
              }
            } catch {
              // Fall through to the default key handling.
            }
          }
          return undefined;
        });
      }

      if (typeof tui.addInputListener === "function") {
        inputCleanup = tui.addInputListener((data: string) => {
          if (data === "\x1b[I" || data === "\x1b[O") return undefined;
          if (data.startsWith("\x1b[M") || data.startsWith("\x1b[<")) return undefined;
          blinkOn = true;
          isBlinking = false;
          if (hideTimeout) clearTimeout(hideTimeout);
          if (blinkTimer) { clearTimeout(blinkTimer); blinkTimer = null; }
          hideTimeout = setTimeout(() => {
            if (!hasFocus || isBlinking) return;
            isBlinking = true;
            blinkOn = false;
            tuiRef?.requestRender();
            scheduleNextBlink();
          }, BLINK_IDLE_MS);
          return undefined;
        });
      }

      if (!blinkTimer) {
        hideTimeout = setTimeout(() => {
          if (!hasFocus || isBlinking) return;
          isBlinking = true;
          blinkOn = false;
          tuiRef?.requestRender();
          scheduleNextBlink();
        }, BLINK_IDLE_MS);
      }

      const unsub = footerData.onBranchChange(() => requestStatusRender());

      return {
        dispose() {
          unsub();
          restoreFooterStatusRepaintHook?.();
          restoreFooterStatusRepaintHook = null;
        },
        invalidate() {
          requestStatusRender();
        },
        render(): string[] {
          return [];
        },
      };
    });

    if (isFullscreenTui(tuiRef)) {
      installPowerlineWidgets(ctx, false);
    } else if (config.fixedEditor) {
      if (tuiRef) {
        installFixedEditorCompositor(ctx, tuiRef);
      }
    } else {
      installPowerlineWidgets(ctx, true);
    }
  }
}

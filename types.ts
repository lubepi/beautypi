import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

// Theme color - either a pi theme color name or a custom hex color
export type ColorValue = ThemeColor | `#${string}`;
export type ThemeLike = Pick<Theme, "fg">;

// Semantic color names for segments
export type SemanticColor =
  | "model"
  | "path"
  | "gitDirty"
  | "gitClean"
  | "thinking"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "context"
  | "contextWarn"
  | "contextError"
  | "cost"
  | "tokens"
  | "separator"
  | "border";

// Color scheme mapping semantic names to actual colors
export type ColorScheme = Partial<Record<SemanticColor, ColorValue>>;

// Built-in segment identifiers
export type BuiltinStatusLineSegmentId =
  | "model"
  | "shell_mode"
  | "git"
  | "subagents"
  | "token_in"
  | "token_out"
  | "token_total"
  | "cost"
  | "context_pct"
  | "context_total"
  | "time_spent"
  | "time"
  | "session"
  | "hostname"
  | "cache_read"
  | "cache_write"
  | "thinking"
  | "extension_statuses";

// Segment identifiers (built-in + dynamically registered custom items)
export type StatusLineSegmentId = BuiltinStatusLineSegmentId | `custom:${string}`;

// Separator styles
export type StatusLineSeparatorStyle =
  | "powerline"
  | "powerline-thin"
  | "slash"
  | "pipe"
  | "block"
  | "none"
  | "ascii"
  | "dot"
  | "chevron"
  | "star";

// Preset names
export type StatusLinePreset =
  | "default"
  | "minimal"
  | "compact"
  | "full"
  | "nerd"
  | "ascii"
  | "custom";

// Per-segment options
export interface StatusLineSegmentOptions {
  model?: { showThinkingLevel?: boolean };
  path?: {
    mode?: "basename" | "abbreviated" | "full";
    maxLength?: number;
  };
  git?: { showBranch?: boolean; showStaged?: boolean; showUnstaged?: boolean; showUntracked?: boolean; polling?: "full" | "branch" | "off" };
  time?: { format?: "12h" | "24h"; showSeconds?: boolean };
}

export type CustomItemPosition = "left" | "right" | "secondary";

export interface CustomStatusItem {
  id: string;
  statusKey: string;
  position: CustomItemPosition;
  color?: ColorValue;
  prefix?: string;
  hideWhenMissing: boolean;
  excludeFromExtensionStatuses: boolean;
}

// Preset definition
export interface PresetDef {
  leftSegments: BuiltinStatusLineSegmentId[];
  rightSegments: BuiltinStatusLineSegmentId[];
  secondarySegments?: BuiltinStatusLineSegmentId[];
  separator: StatusLineSeparatorStyle;
  colors: ColorScheme;
  segmentOptions: StatusLineSegmentOptions;
}

// Separator definition
export interface SeparatorDef {
  left: string;
  right: string;
  endCaps?: {
    left: string;
    right: string;
    useBgAsFg?: boolean;
  };
}

// Rendered segment
export interface RenderedSegment {
  content: string;
  visible: boolean;
}

// Segment renderer
export interface StatusLineSegment {
  id: BuiltinStatusLineSegmentId;
  render(ctx: SegmentContext): RenderedSegment;
}

// Git status
export interface GitStatus {
  branch: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
}

// Context for segment rendering
export interface SegmentContext {
  model?: { name?: string; id?: string; provider?: string; reasoning?: boolean; contextWindow?: number };
  thinkingLevel: string;
  sessionId?: string;
  cwd: string;
  usageStats: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  contextPercent: number;
  contextWindow: number;
  autoCompactEnabled: boolean;
  customCompactionEnabled: boolean;
  usingSubscription: boolean;
  sessionStartTime: number;
  git: GitStatus;
  extensionStatuses: Map<string, string>;
  hiddenExtensionStatusKeys: Set<string>;
  customItemsById: Map<string, CustomStatusItem>;
  options: StatusLineSegmentOptions;
  theme: ThemeLike;
  colors: ColorScheme;
}

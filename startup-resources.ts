import { Container } from "@earendil-works/pi-tui";

// ═══════════════════════════════════════════════════════════════════════════
// Startup resource gating
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pi lists the loaded resources in the startup document. The [Skills] and
 * [Extensions] sections are rendered as compact comma-separated summaries even
 * while tool output is collapsed. Keep both sections hidden until tool output
 * is expanded (Ctrl+O / app.tools.expand) so the startup view stays tidy.
 *
 * The same treatment applies to dim info/status lines in the chat (e.g.
 * "claude-permissions: ...", "Tool output: expanded/collapsed"): they stay
 * hidden while tool output is collapsed and appear when it is expanded.
 * Warnings and errors stay visible at all times.
 *
 * Pi exposes no API for this, so the sections are located structurally in the
 * TUI tree. Two mechanisms keep them from ever flashing on screen:
 *  - Container.addChild is intercepted at extension load time, so sections are
 *    patched the moment they are inserted (covers early and late builds);
 *  - the TUI's render pass runs a scan before composing each frame, so any
 *    section the addChild hook could not catch is patched before drawing.
 *
 * Everything is best-effort and degrades to a no-op when Pi changes its
 * internal layout.
 */

export interface StartupGatingOptions {
  /** Live tool-output expansion state; section setExpanded calls are used as fallback. */
  isToolOutputExpanded?: () => boolean;
  /** Theme used to recognize dim status lines (`theme.fg("dim", ...)`). */
  theme?: unknown;
}

const GATED_SECTION_HEADERS = new Set(["[skills]", "[extensions]"]);
const CONTAINER_PROTOTYPE_PATCHED = "__beautypiStartupResourceGatingPatched";

const patchedNodes = new WeakSet<object>();
const wrappedTuis = new WeakSet<object>();
const pendingSpacerStates = new WeakMap<object, () => boolean>();
const dimPrefixCache = new WeakMap<object, string | null>();

let isToolOutputExpandedProvider: (() => boolean) | null = null;
let themeRef: unknown = null;

function readToolOutputExpanded(fallback: boolean): boolean {
  try {
    if (isToolOutputExpandedProvider) {
      return isToolOutputExpandedProvider() === true;
    }
  } catch {
    // Malformed providers fall back to the tracked state.
  }
  return fallback;
}

function resolveDimPrefix(): string | null {
  const theme = themeRef as { fg?: (token: string, text: string) => string } | null;
  if (!theme || typeof theme.fg !== "function") return null;

  const cacheKey = theme as object;
  const cached = dimPrefixCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let prefix: string | null = null;
  try {
    const probe = theme.fg("dim", "\u0001");
    const index = probe.indexOf("\u0001");
    if (index > 0) prefix = probe.slice(0, index);
  } catch {
    // Themes without a dim token leave status lines visible.
  }
  dimPrefixCache.set(cacheKey, prefix);
  return prefix;
}

interface ExpandableSectionLike {
  render(width: number): string[];
  setExpanded(expanded: boolean): void;
  state?: { expanded?: boolean };
}

interface ChildContainerLike {
  children?: unknown[];
  addChild?: (child: unknown) => void;
  render?: (width: number) => string[];
}

function isExpandableSection(value: unknown): value is ExpandableSectionLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ExpandableSectionLike>;
  return typeof candidate.render === "function"
    && typeof candidate.setExpanded === "function"
    && typeof candidate.state?.expanded === "boolean";
}

/**
 * Resource sections are plain ExpandableText instances. Other collapsible
 * components (tool output, bash executions, ...) share the shape but are much
 * more expensive to render, so they are excluded before rendering a header.
 */
function isResourceSection(value: unknown): value is ExpandableSectionLike {
  if (!isExpandableSection(value)) return false;
  return (value as { constructor?: { name?: string } }).constructor?.name === "ExpandableText";
}

function isSpacerLike(value: unknown): value is { render: (width: number) => string[] } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { render?: unknown; constructor?: { name?: string } };
  return candidate.constructor?.name === "Spacer" && typeof candidate.render === "function";
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function readSectionHeader(section: ExpandableSectionLike): string | null {
  try {
    for (const line of section.render(120)) {
      const text = stripAnsi(line).trim();
      if (text.length > 0) return text.toLowerCase();
    }
  } catch {
    // Rendering is best-effort; unreadable sections stay untouched.
  }
  return null;
}

/** Hide a section while collapsed; returns an accessor for its expansion state. */
function patchSection(section: ExpandableSectionLike): (() => boolean) | null {
  if (patchedNodes.has(section)) return null;
  patchedNodes.add(section);

  const originalRender = section.render.bind(section);
  const originalSetExpanded = section.setExpanded.bind(section);
  let localExpanded = section.state?.expanded === true;

  const state = (): boolean => readToolOutputExpanded(localExpanded);
  section.render = (width: number) => (state() ? originalRender(width) : []);
  section.setExpanded = (value: boolean) => {
    localExpanded = value === true;
    originalSetExpanded(value);
  };

  return state;
}

/** Hide the spacer that Pi inserts after a gated section together with it. */
function patchSpacer(spacer: unknown, isExpanded: () => boolean): void {
  if (!isSpacerLike(spacer) || patchedNodes.has(spacer as object)) return;
  patchedNodes.add(spacer as object);

  const originalRender = spacer.render.bind(spacer);
  spacer.render = (width: number) => (isExpanded() ? originalRender(width) : []);
}

function isThemedTextLike(value: unknown): value is { render(width: number): string[] } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { render?: unknown; constructor?: { name?: string } };
  return candidate.constructor?.name === "ThemedText" && typeof candidate.render === "function";
}

/** True for single-purpose info/status lines rendered with `theme.fg("dim", ...)`. */
function isDimStatusText(value: unknown): boolean {
  if (!isThemedTextLike(value)) return false;
  const prefix = resolveDimPrefix();
  if (!prefix) return false;
  try {
    for (const line of value.render(240)) {
      const text = line.replace(/^\s+/, "");
      if (text.length === 0) continue;
      return text.startsWith(prefix);
    }
  } catch {
    // Unreadable components stay visible.
  }
  return false;
}

/** Hide dim status lines while tool output is collapsed. */
function gateStatusNotice(container: object, child: unknown): void {
  if (!isDimStatusText(child)) return;
  const notice = child as { render(width: number): string[] } & object;
  if (!patchedNodes.has(notice)) {
    patchedNodes.add(notice);
    const originalRender = notice.render.bind(notice);
    notice.render = (width: number) => (readToolOutputExpanded(false) ? originalRender(width) : []);
  }

  // showStatus adds a spacer right before the status line; hide it together.
  const siblings = (container as ChildContainerLike).children;
  const previous = Array.isArray(siblings) && siblings.length > 0 ? siblings[siblings.length - 1] : undefined;
  if (previous && previous !== notice && isSpacerLike(previous)) {
    patchSpacer(previous, () => readToolOutputExpanded(false));
  }
}

/**
 * Catch section insertions at the source. Pi creates the resource sections via
 * Container.addChild; patching the prototype at extension load time runs
 * before the first frame that could contain them, so the sections never flash
 * on screen even when they are built before the session hooks run.
 */
function installContainerPrototypeHook(): void {
  const prototype = Container?.prototype as (Record<string, unknown> & {
    addChild?: (child: unknown) => void;
  }) | undefined;
  if (!prototype || prototype[CONTAINER_PROTOTYPE_PATCHED] || typeof prototype.addChild !== "function") {
    return;
  }
  prototype[CONTAINER_PROTOTYPE_PATCHED] = true;

  const originalAddChild = prototype.addChild;
  prototype.addChild = function addChildWithResourceGating(this: object, child: unknown) {
    try {
      gateStatusNotice(this, child);
    } catch {
      // Cosmetic gating must never break rendering.
    }
    try {
      const pending = pendingSpacerStates.get(this);
      if (isResourceSection(child)) {
        const header = readSectionHeader(child);
        if (header && GATED_SECTION_HEADERS.has(header)) {
          const state = patchSection(child);
          if (state) pendingSpacerStates.set(this, state);
        } else {
          pendingSpacerStates.delete(this);
        }
      } else if (pending && isSpacerLike(child)) {
        patchSpacer(child, pending);
        pendingSpacerStates.delete(this);
      } else {
        pendingSpacerStates.delete(this);
      }
    } catch {
      // Cosmetic gating must never break rendering.
    }
    return originalAddChild.call(this, child);
  };
}

installContainerPrototypeHook();

/** Returns true once gated sections are found (the render wrapper can settle). */
function scanForGatedSections(node: unknown, seen: Set<unknown>, depth: number): boolean {
  if (!node || typeof node !== "object" || seen.has(node) || depth > 16) return false;
  seen.add(node);

  if (Array.isArray(node)) {
    let hooked = false;
    for (const child of node) hooked = scanForGatedSections(child, seen, depth + 1) || hooked;
    return hooked;
  }

  const children = (node as ChildContainerLike).children;
  if (!Array.isArray(children)) return false;

  let hooked = false;
  children.forEach((child, index) => {
    if (patchedNodes.has(child as object)) {
      hooked = true;
      return;
    }
    if (isResourceSection(child)) {
      const header = readSectionHeader(child);
      if (header && GATED_SECTION_HEADERS.has(header)) {
        const state = patchSection(child);
        if (state) {
          const spacer = children[index + 1];
          if (spacer && spacer !== child) patchSpacer(spacer, state);
        }
        hooked = true;
      }
    }
    hooked = scanForGatedSections(child, seen, depth + 1) || hooked;
  });
  return hooked;
}

/** Keep [Skills], [Extensions] and dim info lines hidden until tool output is expanded. */
export function installStartupResourceGating(tui: unknown, options?: StartupGatingOptions): void {
  if (!tui || typeof tui !== "object") return;
  if (options?.isToolOutputExpanded) {
    isToolOutputExpandedProvider = options.isToolOutputExpanded;
  }
  if (options?.theme) {
    themeRef = options.theme;
  }
  const renderer = tui as { render?: (width: number) => string[] };

  const runScan = (): boolean => {
    try {
      return scanForGatedSections(tui, new Set(), 0);
    } catch {
      return false;
    }
  };

  installContainerPrototypeHook();

  // Patch sections before the frame that would show them is composed.
  if (typeof renderer.render === "function" && !wrappedTuis.has(tui as object)) {
    wrappedTuis.add(tui as object);
    const originalRender = renderer.render.bind(renderer);
    const expiresAt = Date.now() + 15000;
    let settled = false;

    const wrappedRender = (width: number): string[] => {
      if (!settled && (runScan() || Date.now() > expiresAt)) settled = true;
      return originalRender(width);
    };
    renderer.render = wrappedRender;
  }

  // Fallback in case the render wrapper cannot be installed or a rebuild
  // happens without a render in between.
  for (const delay of [0, 250, 750, 1500, 3000]) {
    setTimeout(runScan, delay);
  }
}

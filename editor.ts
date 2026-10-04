import { fileURLToPath } from "node:url";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { readPrimarySelection } from "./clipboard.ts";
import { matchesConfiguredShortcut } from "./shortcuts.ts";

interface EditorBoundaryShortcuts {
  start: string | null;
  end: string | null;
}

interface PowerlineEditorOptions {
  keybindings: KeybindingsManager;
  editorBoundaryShortcuts?: EditorBoundaryShortcuts;
  onNotify: (message: string, level?: "info" | "warning" | "error") => void;
  /** Fullscreen only: renders the powerline bar as the frame's top row. */
  renderFrameBar?: (width: number, hiddenAbove: number) => string | null;
  /** Fullscreen only: frame stroke color (splash outline color). */
  frameColor?: (text: string) => string;
  /** Fullscreen only: whether the soft cursor cell is currently visible (blink phase). */
  cursorBlinkVisible?: () => boolean;
}

const DEFAULT_EDITOR_BOUNDARY_SHORTCUTS: EditorBoundaryShortcuts = {
  start: "super+shift+up",
  end: "super+shift+down",
};

/** Parse "↑ 3 more" / "↓ 12 more" scroll hints from native border rows. */
function hiddenLineCount(row: string, arrow: string): number {
  const plain = row.replace(/\x1b\[[0-9;]*m/g, "");
  const match = plain.match(new RegExp(`${arrow}\\s*(\\d+)\\s*more`));
  return match ? Number.parseInt(match[1], 10) : 0;
}

function trimTrailingPadding(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === " ") end--;
  return text.slice(0, end);
}

/** Text row of the fullscreen frame: "│  text  │". */
function frameBodyRow(row: string, width: number, border: (text: string) => string): string {
  const content = truncateToWidth(trimTrailingPadding(row), Math.max(1, width - 6), "…");
  const padding = Math.max(0, width - 6 - visibleWidth(content));
  return border("│  ") + content + " ".repeat(padding) + border("  │");
}

/** Bottom row of the fullscreen frame: "╰─ text ───╯" with the last input line inside. */
function frameCapRow(row: string, width: number, border: (text: string) => string, hiddenBelow: number): string {
  const content = truncateToWidth(trimTrailingPadding(row), Math.max(1, width - 6), "…");
  const indicator = hiddenBelow > 0 ? ` ↓ ${hiddenBelow} more ` : "";
  const padding = Math.max(0, width - 5 - visibleWidth(content) - visibleWidth(indicator));
  return border("╰─ ") + content + " ".repeat(padding) + (indicator ? border(indicator) : "") + border("─╯");
}

function isCommandUndoShortcut(data: string): boolean {
  return data === "\x1b[122;9u"
    || data === "\x1b[122;9:1u"
    || data === "\x1b[122;9:2u"
    || data === "\x1b[27;9;122~";
}

/**
 * True when the input actually inserts text: plain characters or characters
 * encoded by the kitty keyboard protocol ("\x1b[<codepoint>u" with no or
 * only the shift modifier). Navigation and control keys are not text input
 * and must not replace an active selection.
 */
function isTextInput(data: string): boolean {
  if (data.length === 0) return false;
  const kitty = /^\x1b\[(\d+)(?:;(\d+))?u$/.exec(data);
  if (kitty) {
    const codepoint = Number(kitty[1]);
    const mods = kitty[2] === undefined ? 1 : Number(kitty[2]);
    return codepoint >= 32 && (mods === 1 || mods === 2);
  }
  return !/[\x00-\x1f\x7f]/.test(data);
}

function bracketedPasteContent(data: string): string | null {
  const startMarker = "\x1b[200~";
  const endMarker = "\x1b[201~";
  const start = data.indexOf(startMarker);
  if (start !== 0) return null;

  const end = data.indexOf(endMarker, startMarker.length);
  if (end === -1 || end + endMarker.length !== data.length) return null;

  return data.slice(startMarker.length, end);
}

function decodeFileUriList(text: string): string | null {
  const entries = text
    .split(/\r?\n|\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("#"));

  if (entries.length === 0 || entries.some((entry) => !entry.startsWith("file://"))) {
    return null;
  }

  try {
    return entries.map((entry) => fileURLToPath(entry)).join(" ");
  } catch {
    return null;
  }
}

function droppedPathTextFromInput(data: string): string | null {
  const pasteContent = bracketedPasteContent(data);
  const text = pasteContent ?? data;
  const uriList = decodeFileUriList(text);
  if (uriList) return uriList;

  const trimmed = text.replace(/^[\r\n]+|[\r\n]+$/g, "");
  if (trimmed.length <= 1 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(trimmed)) {
    return null;
  }

  if (/^(?:\/|~\/|\.\.?\/)/.test(trimmed) && !/[\r\n]/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

export class PowerlineEditor extends CustomEditor {
  private readonly keybindingsRef: KeybindingsManager;
  private readonly optionsRef: PowerlineEditorOptions;
  /** Text selection captured on middle press, before Pi clears it. */
  private pendingMiddleSelection: string | null = null;
  /** Keyboard selection (fullscreen, Shift+Arrows): anchor park cell. */
  private keyboardSelecting = false;
  private keyboardAnchor: { row: number; col: number } | null = null;
  /** Keyboard selection (regular mode): anchor in editor line/col. */
  private keyboardAnchorLogical: { line: number; col: number } | null = null;
  /** Last cursor park seen while the keyboard selection is active. */
  private keyboardLastPark: { row: number; col: number } | null = null;
  /**
   * Upper-edge offset while extending a mouse selection in fullscreen: the
   * mouse focus cell is part of the selection while a keyboard cursor marks
   * the gap after it, so the moving edge sits one cell further right.
   */
  private keyboardUpperOffset = 0;
  /** Reference to the compositor for selection queries. */
  compositorRef: {
    getEditorSelectionRange: () => { startLine: number; startCol: number; endLine: number; endCol: number } | null;
    clearEditorSelection: () => void;
    setEditorTextSelection?: (anchorVisLine: number, anchorCol: number, focusVisLine: number, focusCol: number) => void;
    copyEditorSelection?: () => string;
    getEditorSelectionAnchor?: () => { visLine: number; col: number } | null;
  } | null = null;

  constructor(tui: any, theme: any, keybindings: KeybindingsManager, options: PowerlineEditorOptions) {
    super(tui, theme, keybindings);
    this.keybindingsRef = keybindings;
    this.optionsRef = options;
  }

  handleInput(data: string): void {
    const droppedPathText = droppedPathTextFromInput(data);
    if (droppedPathText !== null) {
      this.insertTextAtCursor(droppedPathText);
      return;
    }

    const pasteInProgress = data.includes("\x1b[200~") || Reflect.get(this, "isInPaste") === true;
    if (pasteInProgress) {
      super.handleInput(data);
      if (Reflect.get(this, "isInPaste") === true) {
        return;
      }
    } else {
      if ((this.optionsRef.renderFrameBar || this.compositorRef) && this.handleKeyboardSelectionKey(data)) {
        return;
      }

      // Backspace (\x7f, \b) or Delete (\x1b[3~): delete selection if active
      if (
        data === "\x7f"
        || data === "\x08"
        || data === "\x1b[3~"
      ) {
        if (this.deleteKeyboardSelectionIfAny() || this.deleteSelectionIfAny() || this.deleteFullscreenSelectionIfAny()) {
          this.resetKeyboardSelectionState();
          return;
        }
        super.handleInput(data);
        return;
      }

      if (isCommandUndoShortcut(data)) {
        this.undo();
        return;
      }

      const editorBoundaryShortcuts = this.optionsRef.editorBoundaryShortcuts ?? DEFAULT_EDITOR_BOUNDARY_SHORTCUTS;
      if (!isKeyRelease(data) && matchesConfiguredShortcut(data, editorBoundaryShortcuts.start)) {
        this.moveCursorToEditorBoundary("start");
        return;
      }

      if (!isKeyRelease(data) && matchesConfiguredShortcut(data, editorBoundaryShortcuts.end)) {
        this.moveCursorToEditorBoundary("end");
        return;
      }

      // Plain navigation collapses an active selection (mouse or keyboard)
      // instead of deleting its content, like any editor.
      if (!isKeyRelease(data) && this.isPlainMovementKey(data)) {
        this.collapseSelections();
        super.handleInput(data);
        return;
      }

      // Typing replaces an active selection: delete it first, then insert.
      if (isTextInput(data) && (this.deleteKeyboardSelectionIfAny() || this.deleteSelectionIfAny() || this.deleteFullscreenSelectionIfAny())) {
        this.resetKeyboardSelectionState();
        super.handleInput(data);
        return;
      }

      super.handleInput(data);
    }
  }

  /**
   * Fullscreen frame: replaces Pi's plain editor borders with the powerline
   * bar (top row), side-bordered text rows and a rounded bottom cap that
   * carries the last input line, matching the regular-mode cluster.
   */
  render(width: number): string[] {
    const renderBar = this.optionsRef.renderFrameBar;
    // Fullscreen frame: render the inner editor six columns narrower so Pi
    // wraps its text at the frame's inner width (three border columns on each
    // side). With Pi's native width the text outgrows the frame's text area
    // and the frame had to cut the overflow with an ellipsis instead of
    // wrapping — the regular cluster wraps at the same width.
    const rows = renderBar ? super.render(Math.max(10, width - 6)) : super.render(width);
    if (!renderBar) return rows;

    try {
      const visibleLineCount = Number(Reflect.get(this, "renderedVisibleLineCount") ?? 0);
      if (visibleLineCount < 1 || rows.length < visibleLineCount + 2) return rows;

      const topRow = rows[0] ?? "";
      const bottomRow = rows[visibleLineCount + 1] ?? "";
      const textRows = rows.slice(1, 1 + visibleLineCount);
      const autocompleteRows = rows.slice(2 + visibleLineCount);

      const barLine = renderBar(width, hiddenLineCount(topRow, "↑"));
      if (!barLine) return rows;

      const frameColor = this.optionsRef.frameColor;
      const editorBorder = Reflect.get(this, "borderColor");
      const border = typeof frameColor === "function"
        ? frameColor
        : typeof editorBorder === "function"
          ? (text: string) => String(editorBorder(text))
          : (text: string) => text;

      // Blink phase and cursor-cell normalization. Pi writes the cursor cell
      // as "\x1b[7m<char>\x1b[0m" — a full SGR reset in the middle of the line.
      // Inside a selection highlight the renderer rebuilds the line and turns
      // that into reset/re-enable cascades; Ghostty mishandles them (the text
      // after the cell flickers with the blink). Use the selective inverse-off
      // instead — the highlight rebuild re-enables inverse by itself — and
      // drop the inverse entirely while the soft cursor is hidden.
      const blinkVisible = this.optionsRef.cursorBlinkVisible;
      const adjustCursorCell = (row: string): string => {
        const markerIndex = row.indexOf(CURSOR_MARKER);
        if (markerIndex < 0) return row;
        const before = row.slice(0, markerIndex + CURSOR_MARKER.length);
        const after = row.slice(markerIndex + CURSOR_MARKER.length);
        const visible = !blinkVisible || blinkVisible();
        return before + after.replace(/^\x1b\[7m[\s\S]*?\x1b\[0m/, (match) =>
          visible ? `${match.slice(0, -4)}\x1b[27m` : match.slice(4, -4));
      };

      const lines: string[] = [barLine];
      for (const row of textRows.slice(0, -1)) {
        lines.push(frameBodyRow(adjustCursorCell(row), width, border));
      }
      lines.push(frameCapRow(adjustCursorCell(textRows[textRows.length - 1] ?? ""), width, border, hiddenLineCount(bottomRow, "↓")));
      lines.push(...autocompleteRows);
      return lines;
    } catch {
      // A broken frame must never take down the render loop.
      return rows;
    }
  }

  /**
   * Middle-click pastes the X11 primary selection (Pi's fullscreen mode does
   * not implement this itself). The cursor is positioned at the clicked cell
   * first by delegating a synthesized left click to the base editor.
   *
   * Pi only synthesizes the "click" event for presses that a component
   * claimed, so the middle press/release must be handled here; otherwise the
   * middle click never reaches us.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "press") {
      // A mouse press replaces or cancels a keyboard selection (Pi re-anchors
      // its own selection from the press point).
      this.resetKeyboardSelectionState();
    }

    if (this.optionsRef.renderFrameBar) {
      event = this.mapFrameMouse(event);
    }

    if (event.button === "middle" && event.type === "press") {
      // X11 middle click pastes the last text selection. Pi clears its
      // selection when the press is handled, so capture the renderer's
      // active selection text right now and prefer it over X11 primary.
      this.pendingMiddleSelection = this.readRendererSelection() ?? null;
      return { handled: true, focus: true };
    }

    if (event.button === "middle" && event.type === "release") {
      return { handled: true, focus: true };
    }

    if (event.type === "click" && event.button === "middle") {
      const text = this.pendingMiddleSelection ?? readPrimarySelection();
      this.pendingMiddleSelection = null;
      if (text) {
        try {
          super.handleMouse({ ...event, button: "left" });
        } catch {
          // Cursor positioning is best-effort; the paste still happens below.
        }
        this.insertTextAtCursor(text);
      }
      return { handled: true, focus: true };
    }

    return super.handleMouse(event);
  }

  /** The fullscreen renderer's currently selected text, if any. */
  private readRendererSelection(): string | undefined {
    try {
      const tui = Reflect.get(this, "tui");
      const text = typeof tui?.getActiveSelectionText === "function"
        ? tui.getActiveSelectionText()
        : undefined;
      return typeof text === "string" && text.length > 0 ? text : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The fixed anchor cell of an active renderer selection (0-based screen
   * coordinates) when it covers the editor text, or null. Used to extend a
   * mouse selection with Shift+Arrows instead of replacing it.
   */
  private readRendererSelectionAnchor(tui: any): { row: number; col: number } | null {
    try {
      const anchor = Reflect.get(tui, "selectionAnchor");
      const focus = Reflect.get(tui, "selectionFocus");
      if (!anchor || typeof anchor !== "object" || anchor.scrollView) return null;
      if (!focus || typeof focus !== "object" || focus.scrollView) return null;
      const row = Number(anchor.row);
      const col = Number(anchor.col);
      if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
      return { row, col };
    } catch {
      return null;
    }
  }

  /** Shift+Arrow keys: the plain movement sequence to delegate. */
  private keyboardSelectionMovement(data: string): string | null {
    if (matchesKey(data, "shift+left")) return "\x1b[D";
    if (matchesKey(data, "shift+right")) return "\x1b[C";
    if (matchesKey(data, "shift+up")) return "\x1b[A";
    if (matchesKey(data, "shift+down")) return "\x1b[B";
    return null;
  }

  /** True for the editor's own unshifted navigation keys. */
  private isPlainMovementKey(data: string): boolean {
    const keybindings = this.keybindingsRef;
    return keybindings.matches(data, "tui.editor.cursorLeft")
      || keybindings.matches(data, "tui.editor.cursorRight")
      || keybindings.matches(data, "tui.editor.cursorUp")
      || keybindings.matches(data, "tui.editor.cursorDown")
      || keybindings.matches(data, "tui.editor.cursorWordLeft")
      || keybindings.matches(data, "tui.editor.cursorWordRight")
      || keybindings.matches(data, "tui.editor.cursorLineStart")
      || keybindings.matches(data, "tui.editor.cursorLineEnd");
  }

  /**
   * Keyboard selection for the fullscreen frame (Shift+Arrows, Ctrl+X cut).
   * Pi's renderer owns the on-screen selection in screen coordinates — the
   * same space as mouse selections — so the anchor is the parked cursor cell
   * of the last frame and every cursor move updates the focus through
   * {@link handleFullscreenCursorPark}. Highlight, copy (Ctrl+Shift+C), cut,
   * Backspace/Delete and replace-on-typing then reuse the existing fullscreen
   * selection paths unchanged. Returns true when the key was consumed.
   */
  private handleKeyboardSelectionKey(data: string): boolean {
    const movement = this.keyboardSelectionMovement(data);
    if (movement) {
      // Key releases must not move the cursor a second time.
      if (!isKeyRelease(data)) this.extendKeyboardSelection(movement);
      return true;
    }

    if (isKeyRelease(data)) return false;

    if (matchesKey(data, "ctrl+x")) {
      if (this.optionsRef.renderFrameBar) {
        const tui = Reflect.get(this, "tui");
        const hasSelection = typeof tui?.hasActiveSelection === "function"
          && tui.hasActiveSelection() === true;
        if (hasSelection) {
          this.cutFullscreenSelection();
          return true;
        }
      } else if (this.keyboardSelecting) {
        this.cutRegularKeyboardSelection();
        return true;
      }
    }

    return false;
  }

  /** Start (or continue) a keyboard selection and move the editor cursor. */
  private extendKeyboardSelection(plainMovement: string): void {
    if (!this.optionsRef.renderFrameBar) {
      this.extendRegularKeyboardSelection(plainMovement);
      return;
    }

    const tui = Reflect.get(this, "tui");
    if (!this.keyboardSelecting) {
      const row = tui ? Reflect.get(tui, "beautypiCursorScreenRow") : undefined;
      const col = tui ? Reflect.get(tui, "beautypiCursorScreenCol") : undefined;
      if (typeof row !== "number" || typeof col !== "number") {
        // Without a parked cursor cell the selection cannot be anchored.
        super.handleInput(plainMovement);
        return;
      }
      // An existing mouse selection is extended instead of replaced: its
      // anchor stays the fixed edge and the cursor keeps following the
      // moving edge. The mouse focus cell is part of the selection while
      // the keyboard cursor marks the gap after it (upper offset 1).
      const existingAnchor = this.readRendererSelectionAnchor(tui);
      this.keyboardSelecting = true;
      this.keyboardAnchor = existingAnchor ?? { row, col };
      this.keyboardUpperOffset = existingAnchor ? 1 : 0;
      this.keyboardLastPark = { row, col };
    }
    super.handleInput(plainMovement);
  }

  /**
   * Called by the fullscreen cursor tracking after every rendered frame with
   * the parked cursor cell (0-based screen coordinates). While a keyboard
   * selection is active the focus follows the cursor; the cell under the
   * cursor stays unselected, matching the base editor where the cursor marks
   * the gap at the selection edge.
   */
  handleFullscreenCursorPark(row: number, col: number): void {
    if (!this.keyboardSelecting || !this.keyboardAnchor) return;
    const last = this.keyboardLastPark;
    if (last && last.row === row && last.col === col) return;
    this.keyboardLastPark = { row, col };

    const tui = Reflect.get(this, "tui");
    if (!tui) return;

    const anchor = this.keyboardAnchor;
    const cursorPoint = this.keyboardUpperOffset === 1 ? { row, col: col + 1 } : { row, col };
    if (anchor.row === cursorPoint.row && anchor.col === cursorPoint.col) {
      // The cursor is back on the anchor cell: nothing is selected.
      Reflect.set(tui, "selectionAnchor", undefined);
      Reflect.set(tui, "selectionFocus", undefined);
      if (typeof tui.requestRender === "function") tui.requestRender();
      return;
    }

    const anchorFirst = anchor.row < cursorPoint.row || (anchor.row === cursorPoint.row && anchor.col < cursorPoint.col);
    const lower = anchorFirst ? anchor : cursorPoint;
    const upper = anchorFirst ? cursorPoint : anchor;
    if (lower.row === upper.row && upper.col - 1 === lower.col) {
      // Exactly one cell: the renderer treats equal anchor/focus as no
      // selection, so mark the cell with an exclusive boundary end instead.
      Reflect.set(tui, "selectionAnchor", { row: lower.row, col: lower.col, boundary: false });
      Reflect.set(tui, "selectionFocus", { row: lower.row, col: lower.col + 1, boundary: true });
      if (typeof tui.requestRender === "function") tui.requestRender();
      return;
    }
    // Pull the upper end back by one cell: the cursor cell itself is not part
    // of the selection. (Only when the cursor wrapped to column 0 does the
    // pull-back fall on the previous row; keep the cell in that rare case.)
    const focus = upper.col > 0 ? { row: upper.row, col: upper.col - 1 } : upper;
    Reflect.set(tui, "selectionAnchor", { row: lower.row, col: lower.col, boundary: false });
    Reflect.set(tui, "selectionFocus", { row: focus.row, col: focus.col, boundary: false });
    if (typeof tui.requestRender === "function") tui.requestRender();
  }

  /**
   * True when a screen row is inside the fullscreen editor's visible text
   * rows. Used to restrict the selection-drop (cursor move on mouse release)
   * to releases over the editor, so other components never see a synthetic
   * click.
   */
  isFullscreenTextRow(row: number): boolean {
    if (!this.optionsRef.renderFrameBar) return false;
    try {
      const tui = Reflect.get(this, "tui");
      const cursorScreenRow = Reflect.get(tui, "beautypiCursorScreenRow");
      const visibleLineCount = Number(Reflect.get(this, "renderedVisibleLineCount") ?? 0);
      const layoutWidth = Number(Reflect.get(this, "lastWidth") ?? 0);
      const layoutFn = Reflect.get(this, "layoutText");
      if (typeof cursorScreenRow !== "number" || visibleLineCount < 1 || layoutWidth < 1) return false;
      if (typeof layoutFn !== "function") return false;
      const layoutLines: Array<{ hasCursor?: boolean }> = layoutFn.call(this, layoutWidth);
      if (!Array.isArray(layoutLines) || layoutLines.length === 0) return false;
      let cursorLineIndex = layoutLines.findIndex((line) => line.hasCursor === true);
      if (cursorLineIndex < 0) cursorLineIndex = 0;
      const topScreenRow = cursorScreenRow - cursorLineIndex;
      return row >= topScreenRow && row < topScreenRow + visibleLineCount;
    } catch {
      return false;
    }
  }

  /**
   * Clear any active selection without deleting text: keyboard bookkeeping,
   * the fullscreen renderer's mouse selection and the regular compositor's
   * editor selection.
   */
  private collapseSelections(): void {
    this.resetKeyboardSelectionState();
    this.compositorRef?.clearEditorSelection?.();
    if (!this.optionsRef.renderFrameBar) return;
    const tui = Reflect.get(this, "tui");
    if (!tui) return;
    try {
      Reflect.set(tui, "selectionAnchor", undefined);
      Reflect.set(tui, "selectionFocus", undefined);
      if (typeof tui.requestRender === "function") tui.requestRender();
    } catch {
      // Clearing the renderer selection is best effort.
    }
  }

  /** Forget the keyboard-selection bookkeeping without touching the renderer. */
  private resetKeyboardSelectionState(): void {
    this.keyboardSelecting = false;
    this.keyboardAnchor = null;
    this.keyboardAnchorLogical = null;
    this.keyboardLastPark = null;
    this.keyboardUpperOffset = 0;
  }

  /**
   * A mouse selection started in the regular-mode compositor: drop stale
   * keyboard-selection state so the next Shift+Arrow anchors at the cursor.
   */
  handleExternalSelectionStart(): void {
    this.resetKeyboardSelectionState();
  }

  /**
   * Regular mode: start (or continue) a keyboard selection. The anchor is the
   * cursor's logical line/col, the range is reflected on the compositor
   * overlay after every cursor move.
   */
  private extendRegularKeyboardSelection(plainMovement: string): void {
    const state = Reflect.get(this, "state");
    if (!this.keyboardSelecting) {
      if (!state || !this.compositorRef) {
        super.handleInput(plainMovement);
        return;
      }
      const line = Number(Reflect.get(state, "cursorLine") ?? 0);
      const col = Number(Reflect.get(state, "cursorCol") ?? 0);
      // An existing mouse selection is extended instead of replaced: keep
      // its anchor as the fixed edge.
      const existing = typeof this.compositorRef.getEditorSelectionAnchor === "function"
        ? this.compositorRef.getEditorSelectionAnchor()
        : null;
      const anchor = existing
        ? this.logicalPositionFromVisual(existing.visLine, existing.col)
        : null;
      this.keyboardSelecting = true;
      this.keyboardAnchorLogical = anchor ?? { line, col };
    }
    super.handleInput(plainMovement);
    this.syncRegularKeyboardSelection();
  }

  /** Map a visual (wrapped row, text column) back to logical editor coordinates. */
  private logicalPositionFromVisual(visLine: number, withinCol: number): { line: number; col: number } | null {
    const state = Reflect.get(this, "state");
    if (!state || typeof state !== "object") return null;
    const lines: unknown = Reflect.get(state, "lines");
    if (!Array.isArray(lines)) return null;
    const width = this.tui?.terminal?.columns ?? 80;
    const wrapWidth = Math.max(1, width - 6);
    const visualLines: { editorLine: number; startCol: number }[] = [];
    for (let li = 0; li < lines.length; li++) {
      const line = (lines[li] as string) ?? "";
      if (line.length === 0) {
        visualLines.push({ editorLine: li, startCol: 0 });
      } else {
        for (let ci = 0; ci < line.length; ci += wrapWidth) {
          visualLines.push({ editorLine: li, startCol: ci });
        }
      }
    }
    if (visualLines.length === 0 || visLine < 0 || visLine >= visualLines.length) return null;
    const target = visualLines[visLine];
    const lineLen = ((lines[target.editorLine] as string) ?? "").length;
    const segEnd = Math.min(target.startCol + wrapWidth, lineLen);
    const clamped = Math.min(Math.max(0, withinCol), segEnd - target.startCol);
    return { line: target.editorLine, col: target.startCol + clamped };
  }

  /**
   * Regular mode: reflect the keyboard selection on the compositor overlay.
   * Endpoints are mapped through the editor's own wrap model (visual lines at
   * width - 6 with a three-column border prefix) and the range end is
   * exclusive, matching the compositor's selection conventions.
   */
  private syncRegularKeyboardSelection(): void {
    const compositor = this.compositorRef;
    const state = Reflect.get(this, "state");
    const anchor = this.keyboardAnchorLogical;
    if (!compositor?.setEditorTextSelection || !state || !this.keyboardSelecting || !anchor) return;

    const lines: unknown = Reflect.get(state, "lines");
    if (!Array.isArray(lines)) return;
    const cursorLine = Number(Reflect.get(state, "cursorLine") ?? 0);
    const cursorCol = Number(Reflect.get(state, "cursorCol") ?? 0);
    if (anchor.line === cursorLine && anchor.col === cursorCol) {
      compositor.clearEditorSelection?.();
      return;
    }

    const anchorFirst = anchor.line < cursorLine || (anchor.line === cursorLine && anchor.col < cursorCol);
    const lower = anchorFirst ? anchor : { line: cursorLine, col: cursorCol };
    const upper = anchorFirst ? { line: cursorLine, col: cursorCol } : anchor;

    const wrapWidth = Math.max(1, (this.tui?.terminal?.columns ?? 80) - 6);
    const start = this.regularVisualPosition(lines as string[], lower.line, lower.col, wrapWidth);
    const end = this.regularVisualPosition(lines as string[], upper.line, upper.col, wrapWidth);
    compositor.setEditorTextSelection(start.visLine, start.col, end.visLine, end.col);
  }

  /**
   * Map a logical (line, col) to its wrapped visual position — the same model
   * {@link setCursorFromTerminalPosition} uses (inverse direction).
   */
  private regularVisualPosition(
    lines: string[],
    line: number,
    col: number,
    wrapWidth: number,
  ): { visLine: number; col: number } {
    const clampedLine = Math.max(0, Math.min(line, Math.max(0, lines.length - 1)));
    let visLine = 0;
    for (let i = 0; i < clampedLine; i++) {
      const length = (lines[i] ?? "").length;
      visLine += length === 0 ? 1 : Math.ceil(length / wrapWidth);
    }
    const length = (lines[clampedLine] ?? "").length;
    const clampedCol = Math.max(0, Math.min(col, length));
    const segments = length === 0 ? 1 : Math.ceil(length / wrapWidth);
    const segment = Math.min(Math.floor(clampedCol / wrapWidth), segments - 1);
    return { visLine: visLine + segment, col: clampedCol - segment * wrapWidth };
  }

  /** Delete a keyboard selection through the mode's own path. */
  private deleteKeyboardSelectionIfAny(): boolean {
    if (!this.keyboardSelecting) return false;
    if (this.optionsRef.renderFrameBar) return this.deleteFullscreenSelectionIfAny();
    return this.deleteRegularKeyboardSelection();
  }

  /**
   * Regular mode: delete the selected range in logical text coordinates.
   * [lower, upper) is exactly the selected character range — the upper end
   * (the cursor cell) is already exclusive.
   */
  private deleteRegularKeyboardSelection(): boolean {
    const anchor = this.keyboardAnchorLogical;
    const state = Reflect.get(this, "state");
    if (!anchor || !state || typeof state !== "object") return false;
    const cursorLine = Number(Reflect.get(state, "cursorLine") ?? 0);
    const cursorCol = Number(Reflect.get(state, "cursorCol") ?? 0);
    if (anchor.line === cursorLine && anchor.col === cursorCol) return false;
    const anchorFirst = anchor.line < cursorLine || (anchor.line === cursorLine && anchor.col < cursorCol);
    const lower = anchorFirst ? anchor : { line: cursorLine, col: cursorCol };
    const upper = anchorFirst ? { line: cursorLine, col: cursorCol } : anchor;
    return this.deleteSelectionRange(lower.line, lower.col, upper.line, upper.col, () => {
      this.compositorRef?.clearEditorSelection?.();
    });
  }

  /** Regular mode Ctrl+X: copy through the compositor path, then remove the range. */
  private cutRegularKeyboardSelection(): void {
    try {
      this.compositorRef?.copyEditorSelection?.();
    } catch {
      // Clipboard copy is best effort; the range is removed regardless.
    }
    if (this.deleteRegularKeyboardSelection()) {
      this.resetKeyboardSelectionState();
    }
  }

  /** Ctrl+X: copy the active selection to the system clipboard, then remove it. */
  private cutFullscreenSelection(): void {
    const tui = Reflect.get(this, "tui");
    try {
      void tui?.copyActiveSelectionToClipboard?.();
    } catch {
      // Clipboard copy is best effort; the range is removed regardless.
    }
    if (this.deleteFullscreenSelectionIfAny()) {
      this.resetKeyboardSelectionState();
    }
  }

  /**
   * Translate mouse coordinates of the rebuilt fullscreen frame into the
   * coordinate space the base editor expects: text and cap rows carry a
   * three-column border prefix, and the autocomplete list sits one row higher
   * because the frame replaces two native border rows with the bar and cap.
   */
  private mapFrameMouse(event: TuiMouseEvent): TuiMouseEvent {
    const visibleLineCount = Number(Reflect.get(this, "renderedVisibleLineCount") ?? 0);
    if (visibleLineCount < 1) return event;
    if (event.y >= visibleLineCount + 1) {
      return { ...event, y: event.y + 1 };
    }
    if (event.y >= 1) {
      return { ...event, x: Math.max(0, event.x - 3) };
    }
    return event;
  }

  /**
   * If there is an active selection in the editor text area, delete the
   * selected range and return true. Otherwise return false.
   */
  private deleteSelectionIfAny(): boolean {
    const range = this.compositorRef?.getEditorSelectionRange();
    if (!range) return false;

    // Normalize: ensure start <= end
    const startLine = Math.min(range.startLine, range.endLine);
    const endLine = Math.max(range.startLine, range.endLine);
    const startCol = range.startLine < range.endLine ? range.startCol :
      Math.min(range.startCol, range.endCol);
    const endCol = range.startLine < range.endLine ? range.endCol :
      Math.max(range.startCol, range.endCol);

    return this.deleteSelectionRange(startLine, startCol, endLine, endCol, () => this.compositorRef?.clearEditorSelection());
  }

  /**
   * Fullscreen counterpart of {@link deleteSelectionIfAny}: Pi's renderer owns
   * the mouse selection (screen coordinates) instead of the fixed-editor
   * compositor, so translate it into input-line coordinates and delete the
   * range. Positions come from the renderer's last frame: every frame parks
   * the (hidden) hardware cursor on the marker cell of the focused editor, and
   * installFullscreenCursorTracking records that screen row.
   */
  private deleteFullscreenSelectionIfAny(): boolean {
    if (!this.optionsRef.renderFrameBar) return false;

    try {
      const tui = Reflect.get(this, "tui");
      const bounds = typeof tui?.getSelectionBounds === "function" ? tui.getSelectionBounds() : undefined;
      if (!bounds || bounds.start.scrollView || bounds.end.scrollView) return false;

      const cursorScreenRow = Reflect.get(tui, "beautypiCursorScreenRow");
      if (typeof cursorScreenRow !== "number") return false;

      const layoutWidth = Number(Reflect.get(this, "lastWidth") ?? 0);
      const scrollOffset = Number(Reflect.get(this, "scrollOffset") ?? 0);
      const visibleLineCount = Number(Reflect.get(this, "renderedVisibleLineCount") ?? 0);
      if (layoutWidth < 1 || visibleLineCount < 1) return false;

      const layoutFn = Reflect.get(this, "layoutText");
      if (typeof layoutFn !== "function") return false;
      const layoutLines: Array<{ text?: string; hasCursor?: boolean; startIndex?: number }> =
        layoutFn.call(this, layoutWidth);
      if (!Array.isArray(layoutLines) || layoutLines.length === 0) return false;

      let cursorLineIndex = layoutLines.findIndex((line) => line.hasCursor === true);
      if (cursorLineIndex < 0) cursorLineIndex = 0;

      // Screen rows covered by the visible input lines (0-based).
      const topScreenRow = cursorScreenRow - (cursorLineIndex - scrollOffset);
      if (bounds.start.row < topScreenRow || bounds.end.row > topScreenRow + visibleLineCount - 1) return false;

      const layoutIndexStart = cursorLineIndex + (bounds.start.row - cursorScreenRow);
      const layoutIndexEnd = cursorLineIndex + (bounds.end.row - cursorScreenRow);
      if (layoutIndexStart < 0 || layoutIndexEnd >= layoutLines.length) return false;

      // Map layout lines onto input lines, calibrated at the cursor line.
      const state = Reflect.get(this, "state");
      const cursorLine = Number(state && typeof state === "object" ? Reflect.get(state, "cursorLine") ?? 0 : 0);
      const isLineStart = (entry: { startIndex?: number } | undefined): boolean =>
        entry !== undefined && (entry.startIndex === undefined || entry.startIndex === 0);
      const logicLineOf = new Map<number, number>();
      logicLineOf.set(cursorLineIndex, cursorLine);
      for (let i = cursorLineIndex + 1; i < layoutLines.length; i++) {
        logicLineOf.set(i, (logicLineOf.get(i - 1) ?? cursorLine) + (isLineStart(layoutLines[i]) ? 1 : 0));
      }
      for (let i = cursorLineIndex - 1; i >= 0; i--) {
        logicLineOf.set(i, (logicLineOf.get(i + 1) ?? cursorLine) - (isLineStart(layoutLines[i + 1]) ? 1 : 0));
      }

      // Frame text rows carry a three-column border prefix ("│  " / "╰─ ").
      const FRAME_PREFIX_WIDTH = 3;
      const logicColFor = (layoutIndex: number, screenCol: number): number => {
        const entry = layoutLines[layoutIndex];
        const startIndex = Number(entry?.startIndex ?? 0);
        const visCol = Math.max(0, screenCol - FRAME_PREFIX_WIDTH);
        const textLength = typeof entry?.text === "string" ? entry.text.length : 0;
        return startIndex + Math.min(visCol, textLength);
      };

      const startLine = logicLineOf.get(layoutIndexStart);
      const endLine = logicLineOf.get(layoutIndexEnd);
      if (startLine === undefined || endLine === undefined || startLine > endLine) return false;

      const startCol = logicColFor(layoutIndexStart, bounds.start.col);
      let endCol = logicColFor(layoutIndexEnd, bounds.end.col);
      if (!bounds.end.boundary) endCol += 1;
      if (startLine === endLine && endCol <= startCol) return false;

      const deleted = this.deleteSelectionRange(startLine, startCol, endLine, endCol, () => {
        try {
          Reflect.set(tui, "selectionAnchor", undefined);
          Reflect.set(tui, "selectionFocus", undefined);
          if (typeof tui.requestRender === "function") tui.requestRender();
        } catch {
          // Clearing the renderer selection is best effort.
        }
      });
      return deleted;
    } catch {
      // A failed mapping must not swallow the key press.
      return false;
    }
  }

  /** Delete [startLine, startCol) .. [endLine, endCol) from the input lines. */
  private deleteSelectionRange(
    startLine: number,
    startCol: number,
    endLine: number,
    endCol: number,
    afterDelete?: () => void,
  ): boolean {
    const state = Reflect.get(this, "state");
    if (!state || typeof state !== "object") return false;
    const lines: string[] | undefined = Reflect.get(state, "lines");
    if (!Array.isArray(lines)) return false;
    if (startLine < 0 || endLine >= lines.length || startLine > endLine) return false;

    // Build new lines
    if (startLine === endLine) {
      // Single line: delete characters from startCol to endCol
      const line = lines[startLine] ?? "";
      lines[startLine] = line.slice(0, startCol) + line.slice(endCol);
    } else {
      // Multi-line: join the kept head of the first line with the kept tail of
      // the last line. Everything in between lies inside the selection and is
      // deleted with it (it must not be re-appended).
      const first = (lines[startLine] ?? "").slice(0, startCol);
      const last = (lines[endLine] ?? "").slice(endCol);
      lines.splice(startLine, endLine - startLine + 1, first + last);
    }

    Reflect.set(state, "cursorLine", startLine);
    Reflect.set(state, "cursorCol", startCol);
    Reflect.set(this, "lastAction", null);
    Reflect.set(this, "preferredVisualCol", null);
    Reflect.set(this, "snappedFromCursorCol", null);
    this.tui?.requestRender();
    afterDelete?.();

    return true;
  }

  /**
   * Set the editor cursor from a mouse click on the editor text.
   * `termCol` is the 1-based SGR terminal column.
   * `visLineIndex` is the index into the editor's visual (wrapped) lines,
   * computed by the compositor from the actual cluster layout.
   */
  setCursorFromTerminalPosition(termCol: number, visLineIndex: number): void {
    const state = Reflect.get(this, "state");
    if (!state || typeof state !== "object") return;
    const lines: string[] | undefined = Reflect.get(state, "lines");
    if (!Array.isArray(lines)) return;

    const width = this.tui?.terminal?.columns ?? 80;
    const wrapWidth = Math.max(1, width - 6);

    // Build all visual (wrapped) lines
    const visualLines: { editorLine: number; startCol: number }[] = [];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li] ?? "";
      const lineLen = line.length;
      if (lineLen === 0) {
        visualLines.push({ editorLine: li, startCol: 0 });
      } else {
        for (let ci = 0; ci < lineLen; ci += wrapWidth) {
          visualLines.push({ editorLine: li, startCol: ci });
        }
      }
    }
    if (visualLines.length === 0) {
      visualLines.push({ editorLine: 0, startCol: 0 });
    }

    if (visLineIndex < 0 || visLineIndex >= visualLines.length) return;

    // Map back to editor (line, col)
    const target = visualLines[visLineIndex];
    // termCol is 1-based; adjust for the box border prefix (╰─ or │  )
    const prefixWidth = 3;
    const lineLen = lines[target.editorLine]?.length ?? 0;
    // Clamp column: not beyond line end, not before start
    const visCol = Math.max(0, termCol - 1 - prefixWidth);
    const segEnd = Math.min(target.startCol + wrapWidth, lineLen);
    const clampedCol = Math.min(visCol, segEnd - target.startCol);
    const finalCol = target.startCol + clampedCol;

    Reflect.set(state, "cursorLine", target.editorLine);
    Reflect.set(state, "cursorCol", finalCol);
    Reflect.set(this, "lastAction", null);
    Reflect.set(this, "preferredVisualCol", null);
    Reflect.set(this, "snappedFromCursorCol", null);
    this.tui?.requestRender();
  }

  private moveCursorToEditorBoundary(position: "start" | "end"): void {
    const state = Reflect.get(this, "state");
    const lines = state && typeof state === "object" ? Reflect.get(state, "lines") : null;
    if (!Array.isArray(lines)) {
      throw new Error("Editor cursor state is unavailable");
    }

    if (position === "start") {
      Reflect.set(state, "cursorLine", 0);
      Reflect.set(state, "cursorCol", 0);
    } else {
      const lastLine = Math.max(0, lines.length - 1);
      Reflect.set(state, "cursorLine", lastLine);
      Reflect.set(state, "cursorCol", typeof lines[lastLine] === "string" ? lines[lastLine].length : 0);
    }

    Reflect.set(this, "lastAction", null);
    Reflect.set(this, "preferredVisualCol", null);
    Reflect.set(this, "snappedFromCursorCol", null);
    this.tui.requestRender();
  }
}

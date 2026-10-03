import { fileURLToPath } from "node:url";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { isKeyRelease } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { matchesConfiguredShortcut } from "./shortcuts.ts";

interface EditorBoundaryShortcuts {
  start: string | null;
  end: string | null;
}

interface PowerlineEditorOptions {
  keybindings: KeybindingsManager;
  editorBoundaryShortcuts?: EditorBoundaryShortcuts;
  onNotify: (message: string, level?: "info" | "warning" | "error") => void;
}

const DEFAULT_EDITOR_BOUNDARY_SHORTCUTS: EditorBoundaryShortcuts = {
  start: "super+shift+up",
  end: "super+shift+down",
};

function isCommandUndoShortcut(data: string): boolean {
  return data === "\x1b[122;9u"
    || data === "\x1b[122;9:1u"
    || data === "\x1b[122;9:2u"
    || data === "\x1b[27;9;122~";
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
  /** Reference to the compositor for selection queries. */
  compositorRef: {
    getEditorSelectionRange: () => { startLine: number; startCol: number; endLine: number; endCol: number } | null;
    clearEditorSelection: () => void;
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
      // Backspace (\x7f, \b) or Delete (\x1b[3~): delete selection if active
      if (
        data === "\x7f"
        || data === "\x08"
        || data === "\x1b[3~"
      ) {
        if (this.deleteSelectionIfAny()) return;
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

      // Any printable character: delete selection first, then insert
      if (this.deleteSelectionIfAny()) {
        // After deletion, re-insert the character via super
        super.handleInput(data);
        return;
      }

      super.handleInput(data);
    }
  }

  /**
   * If there is an active selection in the editor text area, delete the
   * selected range and return true. Otherwise return false.
   */
  private deleteSelectionIfAny(): boolean {
    const range = this.compositorRef?.getEditorSelectionRange();
    if (!range) return false;

    const state = Reflect.get(this, "state");
    if (!state || typeof state !== "object") return false;
    const lines: string[] | undefined = Reflect.get(state, "lines");
    if (!Array.isArray(lines)) return false;

    // Normalize: ensure start <= end
    const startLine = Math.min(range.startLine, range.endLine);
    const endLine = Math.max(range.startLine, range.endLine);
    const startCol = range.startLine < range.endLine ? range.startCol :
      Math.min(range.startCol, range.endCol);
    const endCol = range.startLine < range.endLine ? range.endCol :
      Math.max(range.startCol, range.endCol);

    // Build new lines
    if (startLine === endLine) {
      // Single line: delete characters from startCol to endCol
      const line = lines[startLine] ?? "";
      lines[startLine] = line.slice(0, startCol) + line.slice(endCol);
    } else {
      // Multi-line: combine start of first line with end of last line
      const first = (lines[startLine] ?? "").slice(0, startCol);
      const last = (lines[endLine] ?? "").slice(endCol);
      const middle = lines.slice(startLine + 1, endLine);
      lines.splice(startLine, endLine - startLine + 1, [first, ...middle, last].join(""));
    }

    Reflect.set(state, "cursorLine", startLine);
    Reflect.set(state, "cursorCol", startCol);
    Reflect.set(this, "lastAction", null);
    Reflect.set(this, "preferredVisualCol", null);
    Reflect.set(this, "snappedFromCursorCol", null);
    this.tui?.requestRender();
    this.compositorRef?.clearEditorSelection();

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

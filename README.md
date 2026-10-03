# beautypi

An Extension for the [pi coding agent](https://github.com/badlogic/pi-mono).

## Features

- **Splash screen** — Gradient pi logo, welcome message, keyboard shortcuts reference, and tips on session start.
- **Powerline status bar** — Rounded box design with configurable segments (model, path, git, thinking, tokens, cost, context, etc.).
- **Fixed editor cluster** — Scrollable chat with a fixed editor at the bottom.
- **Live thinking level indicator** — Shows current thinking level.
- **Smart defaults** — Nerd Font auto-detection with ASCII fallbacks.
- **Git integration** — Async status fetching with branch, staged, unstaged, and untracked counts.
- **Context awareness** — Color-coded warnings at 70% (yellow) and 90% (red) context usage.
- **Multiple presets** — default, minimal, compact, full, nerd, ascii, custom.
- **Custom items** — Promote any extension status key into its own powerline item.
- **Custom editor** — Prompt box with path dropping, bracketed paste, cursor boundary shortcuts, and mouse click positioning.
- **Mouse support** — Left-click positions cursor, middle-click pastes at click, drag selects, Backspace/Delete removes selection.
- **Editor shortcuts** — `ctrl+alt+c` copy, `ctrl+alt+x` cut, chat jump shortcuts.

## Installation

Copy the `beautypi` directory to your pi extensions folder (`~/.pi/agent/extensions/`).

## Usage

The splash screen appears automatically on session start.

The powerline footer activates automatically. Toggle with `/powerline`, switch presets with `/powerline <name>`, fixed-editor mode with `/powerline fixed-editor on|off|toggle`.

In fullscreen mode (`--tui-mode fullscreen`), pi reprints the whole screen as a transcript when quitting by default. Set `"fullscreenExitOutput": "resume-hint"` in `~/.pi/agent/settings.json` to leave the terminal clean on exit — only the shell prompt (and pi's resume hint, if a session file exists) remains.

| Preset | Description |
|--------|-------------|
| `default` | Model, thinking, path (basename), git, context %, cache read, cost |
| `minimal` | Path (basename), git, context % |
| `compact` | Model, git, cost, context % |
| `full` | Hostname, model, thinking, path (abbreviated), git, tokens, cache, cost, context %, time |
| `nerd` | Hostname, model, thinking, path (abbreviated), git, session, tokens, cache, cost, context %, time |
| `ascii` | Model, path (abbreviated), git, tokens, cost, context % |

## Environment

`POWERLINE_NERD_FONTS=1` to force Nerd Fonts, `=0` for ASCII.

## Configuration

Powerline settings are stored in `~/.pi/agent/settings.json` or project-local `.pi/settings.json`:

```json
{
  "powerline": {
    "preset": "default",
    "fixedEditor": true,
    "mouseScroll": true,
    "customItems": [],
    "segmentOptions": {}
  }
}
```

## License

MIT

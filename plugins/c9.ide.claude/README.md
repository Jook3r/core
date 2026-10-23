# c9.ide.claude

A chat panel for [Claude Code](https://docs.claude.com/en/docs/claude-code) on the
right side of the IDE, next to Outline and Debugger.

It does not call the API itself: it runs the `claude` CLI that is installed on
the server, in headless streaming mode, as the user Cloud9 runs as. Your login,
settings, `CLAUDE.md`, MCP servers and permission rules apply exactly as in the
terminal.

## Usage

1. Install Claude Code on the server and log in once from a terminal:
   `curl -fsSL https://claude.ai/install.sh | bash` (or
   `npm install -g @anthropic-ai/claude-code`), then run `claude`.
2. Open the **Claude** panel (right edge of the window, or Window > Claude).
3. Type a message. Enter sends, Shift+Enter adds a line, Esc stops Claude.
   Paste, drop or attach (paperclip) images; large images are downscaled in the
   browser to at most 1568 px on the long edge.

- Tool calls show as cards (Read, Edit with an inline diff, Write, Bash, ...).
  Click a file name to open it in the editor.
- When Claude needs permission, the panel asks: **Allow**, **Deny**, or the
  option the CLI offers (for example "Allow all edits this session"). Typing a
  message while a prompt is open denies it and sends your text to Claude
  instead.
- The header has the model (Default, Opus, Sonnet, Haiku), the permission mode
  (Ask before edits, Accept edits, Plan, or "Mode from Claude's settings", the
  default, which keeps your `defaultMode` and shows the mode the CLI reports),
  **New session** and **Resume last session**. A resumed session shows its
  earlier messages.
- Each answer ends with its cost and duration.

If `claude` is not on the server's `PATH` (systemd services get a minimal one),
the panel also looks in `~/.local/bin`, `~/.claude/local`, `/usr/local/bin`,
`/usr/bin` and npm's global `bin`. You can set the full path in
Preferences > User Settings > Claude.

## How it works

- `claude.js`: the panel (plain DOM, styles in `claude.less` built into every
  skin). Markdown is rendered with remarkable (raw HTML off) and filtered
  through a whitelist (`markdown.js`); code is highlighted with Ace's
  tokenizers.
- `claude-service.js`: runs in the vfs process (`ext.loadRemotePlugin`). It
  spawns `claude -p --input-format stream-json --output-format stream-json
  --verbose --include-partial-messages --permission-prompt-tool stdio` with an
  argument list built from whitelisted values only, and relays its output.
  Permission answers, Stop (`interrupt`), the mode (`set_permission_mode`) and
  the model (`set_model`) use the CLI's control messages.
- One CLI process per chat, started by the first message. It is stopped after
  20 minutes without activity (never in the middle of a turn), on New session,
  and when the IDE connection goes away; the next message resumes it with
  `--resume <session id>`.
- A CLI whose vfs process was killed with SIGKILL (for example by the OOM
  killer) is stopped by the next IDE connection, after checking that it really
  is that process (records in `~/.c9/claude-panel/`).

## Known limitations

- After such a SIGKILL, if the CLI has already exited by itself, commands it
  started (for example a long build run by the Bash tool) can keep running:
  their process group can no longer be identified safely, so they are left
  alone.
- Messages from claude longer than 16 MB (a huge tool result) are not shown in
  the panel; Claude still gets them.

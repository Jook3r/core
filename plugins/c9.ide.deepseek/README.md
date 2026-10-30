# c9.ide.deepseek

A chat panel for DeepSeek on the right side of the IDE, next to the Claude
panel. It is a copy of [c9.ide.claude](../c9.ide.claude/README.md) and works
the same way: it runs the `claude` CLI (Claude Code) on the server in headless
streaming mode, but points it at [DeepSeek's Anthropic-compatible
API](https://api-docs.deepseek.com/guides/anthropic_api) with your DeepSeek
API key. Claude Code does the agent work (reading and editing files, running
commands, asking for permission); DeepSeek's models answer. No Claude login
or subscription is needed, and your Claude login is never used.

## Usage

1. Install Claude Code on the server:
   `curl -fsSL https://claude.ai/install.sh | bash` (or
   `npm install -g @anthropic-ai/claude-code`). You don't need to log in.
2. Create an API key at [platform.deepseek.com](https://platform.deepseek.com)
   (API keys). DeepSeek is pay as you go: top up a balance there.
3. Open the **DeepSeek** panel (right edge of the window, or Window >
   DeepSeek) and press **Set API key…**, or go to Preferences > DeepSeek >
   Accounts. **Check balance** asks DeepSeek for the balance, which also checks
   the key.
4. Type a message. Everything else (tool cards, permission prompts, the
   mode, Esc to stop, images, session history, accounts and folders) works
   as in the Claude panel.

Right-click in the editor for **Ask DeepSeek...** (the selected code or the
current line, with its path and line numbers) and **Fix with DeepSeek** (the
error markers of the line), and in a terminal or a run's output for **Ask
DeepSeek About Selection**. As in the Claude panel, they put the text in the
input box without sending it (commands `askdeepseek`, `fixwithdeepseek`).

## Peak and off-peak hours

DeepSeek charges half price outside its peak hours: 01:00-04:00 and
06:00-10:00 UTC, Monday to Friday, except on Chinese public holidays (as of
October 2026). The line above the input ends with a badge:

- **Off-peak · until Mon 09:00** (green), **Off-peak · peak in 25m** (with an
  amber outline in the last hour), or **Peak · until 18:00** (amber). Times
  are in your browser's time zone.
- Click it for the schedule, the same hours in your time zone, the next
  change (also in UTC), and every model's price right now.
- When peak hours start or end while the panel is open, the chat says so
  (you can turn that off).

The badge uses the server's clock, not your computer's: the panel measures
the difference once when it connects. It converts to UTC itself
(`getUTCDay()`, `getUTCHours()`), so neither time zone matters.

**Preferences > DeepSeek > Peak hours** changes the schedule if DeepSeek
changes it:

- **Peak hours (UTC)**: ranges like `01:00-04:00, 06:00-10:00`. A range
  across midnight (`22:00-02:00`) counts each part on its own day. Leave it
  empty for no peak hours.
- **On (UTC weekdays)**: `Mon-Fri`, or `Mon, Wed, Fri`.
- **No peak hours on**: Chinese public holidays, as dates in China time
  (UTC+8), e.g. `2026-10-01..2026-10-08, 2027-01-01`. DeepSeek doesn't
  publish a list, so add the dates once China announces them (usually in
  November for the next year).
- **Off-peak price, % of peak**: 50.

A value that doesn't parse is shown with the reason and is not saved; Enter
or leaving the field saves. **Reset to DeepSeek's schedule** restores the
hours, days and percentage (your dates stay).

## Models and prices

**Preferences > DeepSeek > Models and prices** lists the models the panel
offers: DeepSeek Flash (`deepseek-flash[1m]`, reads images) and DeepSeek V4
Pro (`deepseek-v4-pro[1m]`, text only), with DeepSeek's peak prices in USD
per 1M tokens (cache hit, cache miss, output). `[1m]` tells Claude Code that
the model has a 1M-token context. Add, edit or remove models when DeepSeek
changes them; **Reset to DeepSeek's models** restores the list.

- The model menu shows each model's price right now (peak or off-peak).
  Effort starts at **Max**, as DeepSeek recommends for Claude Code.
- Each answer ends with its estimated cost, e.g. **≈$0.0012 · off-peak**.
  The tooltip has the tokens (and how many came from the cache) and the
  total for the chat. Tokens of a model without a price are not counted
  (shown as **≈$0.0012+**). Sub-agents and background tasks are included.
- Web searches are counted at the price set there: 0.75 USD per 1000,
  DeepSeek's price for searches from Claude Code from November 1, 2026 (free
  before).
- **Sub-agents and background tasks use**: the model for Claude Code's
  sub-agents and short background tasks (titles, summaries). Default:
  DeepSeek Flash.
- A model that can't read images (V4 Pro) dims the paperclip, and a message
  with images is not sent to it.

## Accounts and API keys

- An account is a folder of its own with its API key, settings and chats:
  **Default** is `~/.claude-deepseek`; **Add an account…** makes another
  (`~/.deepseek-work`, ...), e.g. for a second key. `~/.claude` (your Claude
  login) can't be used.
- The key is kept in the account's folder as `.deepseek-api-key` (0600, in
  a 0700 folder). The browser sends it to the server once and never gets it
  back: the panel only shows its last 4 characters. For the Default account
  the server can also take it from `DEEPSEEK_API_KEY` in its environment.
- An account can share `CLAUDE.md` (an import line), `agents`, `commands`,
  `skills` and `output styles` with Claude Code's `~/.claude`. It never
  shares `settings.json`: an `env` or `apiKeyHelper` there could send
  another key to DeepSeek, or the DeepSeek key elsewhere.
- Settings for Claude Code itself go in the account's `settings.json`, e.g.
  `{"env": {"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}}`.
- Session history lists the DeepSeek accounts' sessions only, and the Claude
  panel never lists DeepSeek's.

## How it works

- `deepseek.js`: the panel (from `claude.js`, under the `ds-` CSS prefix and
  `user/deepseek` settings). `peak.js`: the schedule (parsing, whether a
  moment is peak, the next change). `deepseek.less`: the styles, in
  DeepSeek's blue.
- `deepseek-service.js` (the vfs process) starts `claude` with
  `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`,
  `ANTHROPIC_AUTH_TOKEN=<the account's key>`, `CLAUDE_CONFIG_DIR=<the
  account's folder>`, the chosen model as `--model` and as the CLI's default
  and bigger aliases, the fast model for its small alias and sub-agents,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432` (DeepSeek's recommendation),
  `--effort`, and an `--append-system-prompt` that tells the model it is
  DeepSeek, not Claude.
- No `ANTHROPIC_*`, `CLAUDE_*` or `CCR_*` variable of the server reaches the
  CLI. Tested: with `ANTHROPIC_API_KEY` set, the CLI sends it to DeepSeek
  next to the DeepSeek key, and with `CLAUDE_CODE_REMOTE` set (Cloud9 running
  in a Claude Code cloud session) it sends that session's token instead of
  the DeepSeek key. `CLAUDE_CODE_EFFORT_LEVEL`, which DeepSeek's guide
  suggests, would also override `--effort` and every change in the panel.
- The CLI's own cost is in Anthropic's prices, so the service sends the
  turn's tokens per model and the panel prices them.
- `DEEPSEEK_ANTHROPIC_BASE_URL` in the server's environment points the
  panel at another endpoint (a proxy, a test server); the panel itself
  can't change it.
- CLI processes left behind by a killed vfs process are tracked in
  `~/.c9/deepseek-panel/`, apart from the Claude panel's.

## Known limitations

- Costs are estimates with the prices in your settings, at the rate of the
  moment an answer ends. DeepSeek bills each request at its own time, so an
  answer that runs across the start or end of peak hours is approximate (the
  tooltip says so).
- It depends on DeepSeek's compatibility with Claude Code. DeepSeek ignores
  `cache_control` (it caches by itself) and the error flag of tool results.
  If a new Claude Code version sends something DeepSeek rejects, add
  `"CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1"` to the account's
  `settings.json` `env`.
- Ultracode is offered as in the Claude panel; it is untested with
  DeepSeek.
- Commands that Claude Code runs (the Bash tool) run as you, as in a
  terminal, so they could read the key from the CLI's environment or from
  its file. That is the same for any Claude Code setup with DeepSeek.
- **Check balance** connects directly; it doesn't use `HTTPS_PROXY`. The
  CLI does.
- After pulling this, rebuild the packed client (`scripts/install-sdk.sh`)
  if you run Cloud9 with `--packed`, so the skins include the panel's
  styles. Without `--packed`, delete `build/standalone/skin/` if the panel
  shows the old styles.

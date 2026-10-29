/**
 * Claude chat panel: a right side panel that drives the user's own `claude`
 * CLI (Claude Code) in headless streaming mode through claude-service.js.
 *
 * Plain DOM inside the panel, styled by claude.less with the skin's
 * variables. Model output, tool input and tool output are only ever inserted
 * as text, or as markdown rendered and filtered by ./markdown.
 */
define(function(require, exports, module) {
    "use strict";

    main.consumes = [
        "Panel", "c9", "ui", "ext", "settings", "preferences", "tabManager",
        "layout", "ace", "commands", "tree", "dialog.file", "dialog.confirm"
    ];
    main.provides = ["claude"];
    return main;

    function main(options, imports, register) {
        var Panel = imports.Panel;
        var c9 = imports.c9;
        var ui = imports.ui;
        var ext = imports.ext;
        var settings = imports.settings;
        var prefs = imports.preferences;
        var tabManager = imports.tabManager;
        var layout = imports.layout;
        var aceHandle = imports.ace;
        var commands = imports.commands;
        var tree = imports.tree;
        var fileDialog = imports["dialog.file"];
        var confirm = imports["dialog.confirm"].show;

        var markdown = require("./markdown");
        var images = require("./images");
        var diff = require("./diff");

        /***** Constants *****/

        // until claude has run once and reported its own list (list_models)
        // levels of a model that supports effort but does not list them
        var FALLBACK_LEVELS = ["low", "medium", "high"];
        var FALLBACK_MODELS = [
            { value: "default", displayName: "Default", description: "Claude's default model", supportsEffort: true, supportedEffortLevels: FALLBACK_LEVELS },
            { value: "opus", displayName: "Opus", description: "", supportsEffort: true, supportedEffortLevels: FALLBACK_LEVELS },
            { value: "sonnet", displayName: "Sonnet", description: "", supportsEffort: true, supportedEffortLevels: FALLBACK_LEVELS },
            { value: "haiku", displayName: "Haiku", description: "", supportsEffort: true, supportedEffortLevels: FALLBACK_LEVELS }
        ];
        var EFFORTS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
        var MODEL_RE = /^[a-z][a-z0-9.\-]{0,63}(\[1m\])?$/i;
        var THINKING_GAP = 30000;       // a pause this long: the thinking time is not shown
        var PROMPT_GUARD = 500;         // clicks on a new prompt are ignored this long (ms)
        // "": no --permission-mode flag, the CLI uses the user's own default
        // (defaultMode in ~/.claude/settings.json); the label then shows the
        // mode the CLI reports
        var MODES = [
            { value: "", caption: "Mode from Claude's settings", short: "From settings", icon: "gear",
                desc: "The default mode in your Claude settings" },
            { value: "default", caption: "Ask before edits", short: "Ask", icon: "shield",
                desc: "Claude asks before it edits files or runs commands" },
            { value: "acceptEdits", caption: "Accept edits", short: "Accept edits", icon: "edit",
                desc: "Claude edits files without asking; it still asks for commands" },
            { value: "plan", caption: "Plan mode", short: "Plan", icon: "plan",
                desc: "Claude looks around and proposes a plan; it changes nothing" }
        ];
        // Shift+Tab in the input goes through these
        var MODE_CYCLE = ["default", "acceptEdits", "plan"];
        // effort levels in the model menu's segmented control
        var SEGMENTS = { "": "Auto", low: "Low", medium: "Med", high: "High", xhigh: "Extra", max: "Max" };
        var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        // an added account: the name of its config folder in the home folder
        var ACCOUNT_RE = /^[A-Za-z0-9._-]{1,64}$/;
        var DEFAULT_ACCOUNT_NAME = "Personal";
        var MAX_ACCOUNTS = 20;
        var RECENT_FOLDERS = 8;         // folders offered for a new chat
        var HISTORY_PAGE = 50;          // sessions listed, and added by "Show older"
        // what an added account can share with the default one
        var SHARES = [
            { key: "claudeMd", caption: "CLAUDE.md", desc: "your instructions (imported)" },
            { key: "agents", caption: "agents" },
            { key: "commands", caption: "commands" },
            { key: "skills", caption: "skills" },
            { key: "outputStyles", caption: "output styles" },
            { key: "settings", caption: "settings.json",
                desc: "read only from this account: Claude can't save settings through the link" }
        ];
        var LOGIN_RE = /\/login\b|not logged in|invalid api key|authentication_error|oauth token|please run .{0,20}login/i;
        var BILLING_RE = /credit balance|billing|payment required|insufficient credit/i;
        var MAX_ATTACHMENTS = 10;
        var RENDER_DELAY = 60;          // markdown re-render throttle while streaming (ms)
        var PREVIEW_LINES = 60;         // Write previews
        var INSTALL_HELP = "Install Claude Code with `curl -fsSL https://claude.ai/install.sh | bash` "
            + "or `npm install -g @anthropic-ai/claude-code`, then log in once: Preferences › User Settings › "
            + "Claude › Log in… (or run `claude` in a new terminal).";

        // 16px icons, drawn with currentColor (static markup only)
        var ICONS = {
            spark: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 1.2c.4 0 .7.3.8.7l.6 3.4 3-1.7a.8.8 0 0 1 1 1.2L11 7.2l3.3 1.2a.8.8 0 0 1-.3 1.5l-3.5-.2 1.4 3.2a.8.8 0 0 1-1.3.9L8.3 11l-1 3.4a.8.8 0 0 1-1.5-.1l-.3-3.5-3 1.9a.8.8 0 0 1-1.1-1.1l2-2.9L.9 8.1a.8.8 0 0 1 .2-1.5l3.5-.4L2.9 3.1a.8.8 0 0 1 1.2-1l2.6 2.4.5-2.6c.1-.4.4-.7.8-.7z"/></svg>',
            plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>',
            history: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8"/><path d="M2.4 2.6v2.6H5"/><path d="M8 5.2V8l2 1.4"/></svg>',
            attach: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 7.6 8.3 12.5a3.2 3.2 0 0 1-4.6-4.6l5.4-5.4a2.2 2.2 0 0 1 3.1 3.1L6.9 10.9a1.1 1.1 0 0 1-1.6-1.6l4.6-4.6"/></svg>',
            image: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.1"/><path d="M2.5 11.5 6 8.5l2.5 2 2-1.5 3 2.5"/></svg>',
            send: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3.5M3.8 7.6 8 3.4l4.2 4.2"/></svg>',
            stop: '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
            chevron: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
            down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3.8 8.8 8 13l4.2-4.2"/></svg>',
            close: '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7m0-7-7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
            copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.8c0-.7-.6-1.3-1.3-1.3H3.8c-.7 0-1.3.6-1.3 1.3v5.4c0 .7.6 1.3 1.3 1.3h1.7"/></svg>',
            check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>',
            error: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.8v3.8M8 11v.2"/></svg>',
            file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/></svg>',
            edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M10.8 2.6l2.6 2.6-7.6 7.6-3.2.6.6-3.2z"/><path d="M9.4 4l2.6 2.6"/></svg>',
            terminal: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.5"/><path d="M4.5 6.5 6.5 8.2 4.5 10M8.3 10.2h3"/></svg>',
            search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5"/></svg>',
            globe: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.7 1.7 2.5 3.8 2.5 6S9.7 12.3 8 14C6.3 12.3 5.5 10.2 5.5 8S6.3 3.7 8 2z"/></svg>',
            agent: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2.5V5M6 8.6v.8M10 8.6v.8"/></svg>',
            list: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7"/><path d="M2.8 4.5h.4M2.8 8h.4M2.8 11.5h.4" stroke-width="1.8"/></svg>',
            tool: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M9.6 2.4a3.4 3.4 0 0 0-3.9 4.5L2.4 10.2a1.4 1.4 0 0 0 2 2l3.3-3.3a3.4 3.4 0 0 0 4.5-3.9l-2 2-1.8-.5-.5-1.8z"/></svg>',
            plan: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><rect x="3" y="2.5" width="10" height="11.5" rx="1.5"/><path d="M5.6 6h4.8M5.6 8.6h4.8M5.6 11.2h2.8" stroke-linecap="round"/></svg>',
            question: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.6c-.5.2-.8.6-.8 1.1v.4M8 11.3v.2"/></svg>',
            shield: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M8 1.8 13 3.7v4c0 3.2-2.1 5.4-5 6.5-2.9-1.1-5-3.3-5-6.5v-4z"/></svg>',
            thinking: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M5.5 12.5h5M6.3 14.3h3.4M8 1.8a4.4 4.4 0 0 0-2.6 8c.4.3.6.7.6 1.2v.3h4v-.3c0-.5.2-.9.6-1.2A4.4 4.4 0 0 0 8 1.8z"/></svg>',
            gear: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M8 1.8l1 1.6 1.8-.5.5 1.8 1.6 1-.8 1.6.8 1.6-1.6 1-.5 1.8-1.8-.5-1 1.6-1-1.6-1.8.5-.5-1.8-1.6-1 .8-1.6-.8-1.6 1.6-1 .5-1.8 1.8.5z"/></svg>',
            up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 9.8 8 6.3l3.5 3.5"/></svg>',
            archive: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><rect x="2" y="3" width="12" height="3" rx=".8"/><path d="M3 6v6.5c0 .6.4 1 1 1h8c.6 0 1-.4 1-1V6M6.5 9h3"/></svg>',
            unarchive: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><rect x="2" y="3" width="12" height="3" rx=".8"/><path d="M3 6v6.5c0 .6.4 1 1 1h8c.6 0 1-.4 1-1V6M8 12V8.2M6.4 9.6 8 8l1.6 1.6"/></svg>',
            folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M1.8 4.2c0-.6.5-1 1-1h3.3l1.5 1.6h5.6c.6 0 1 .4 1 1v6.9c0 .6-.4 1-1 1H2.8c-.5 0-1-.4-1-1z"/></svg>',
            user: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><circle cx="8" cy="5.6" r="2.7"/><path d="M2.8 13.8c.6-2.6 2.7-4.1 5.2-4.1s4.6 1.5 5.2 4.1"/></svg>',
            trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M2.8 4.3h10.4M6.3 4.3V3c0-.4.3-.7.7-.7h2c.4 0 .7.3.7.7v1.3M4.2 4.3l.6 8.6c0 .5.5.9 1 .9h4.4c.5 0 1-.4 1-.9l.6-8.6M6.8 6.8v4.6M9.2 6.8v4.6"/></svg>'
        };

        /***** Initialization *****/

        var plugin = new Panel("Cloud9", main.consumes, {
            index: options.index || 40,
            width: options.width || 400,
            caption: "Claude",
            buttonCSSClass: "claude",
            panelCSSClass: "claude-bar",
            minWidth: 280,
            where: options.where || "right"
        });

        // UI elements
        var root, header, statusDot, statusText, titleEl, btnNew, btnHistory;
        var modelSelect, effortSelect, modeSelect;      // the choices (see choice())
        var modelPill, modePill, wherePill, modelPop, modePop, wherePop, historyPop;
        var pops = [];                                  // the popover menus
        var actEl, actText, actMeta, actHint;
        var logEl, welcomeEl, jumpBtn, composer, composerBox, noteEl, promptSlot, attachRow, chipPreview;
        var textarea, btnAttach, btnSend, fileInput, dropOverlay;

        // connection with claude-service.js
        var api = null;
        var stream = null;
        var connecting = false;
        var cliInfo = null;             // last status() result

        // chat state
        var sessionId = null;           // the CLI session of the current chat
        var running = false;            // a CLI process is alive for it
        var cliPid = null;              // ... with this pid
        var busy = false;               // a turn is in progress
        var stopping = false;
        var stopTimer = null;           // gives up waiting for a Stop
        var turn = null;                // the turn being rendered
        var toolCards = Object.create(null);    // tool_use_id -> card
        var permCards = Object.create(null);    // request_id -> card
        var attachments = [];
        var autoScroll = true;
        var activity = { parts: "", kind: "", tokens: 0 };  // what Claude does now (the activity row)
        var turnStart = 0;              // when the turn started (elapsed time)
        var actTimer = null;            // ticks the elapsed times while busy
        var liveTools = [];             // tool cards running in this turn, oldest first
        var liveThinking = null;        // the thinking block being streamed
        var taskSummary = "";           // the CLI's summary of the task (header)
        var debug = false;              // localStorage "claude-debug": log event times

        // the account and folder of the chat (see "Accounts and folders")
        var chatAccount = "";           // "" (the default account) or an added account's folder name
        var chatFolder = "";            // the folder it runs in ("": the workspace)
        var chatCwd = "";               // the folder the CLI reports (relative paths)
        var acctInfo = {};              // account -> what the service knows (login, email, sharing)
        var defaultEnvDir = null;       // the server's own CLAUDE_CONFIG_DIR (the default account's)
        var tabMemory = Object.create(null);    // account -> { effort, ultracode } in this tab

        // model and effort: the CLI's model list, and what it really applies
        var modelList = null;           // list_models (null: FALLBACK_MODELS)
        var applied = null;             // { model, effort } from get_settings
        var appliedFor = null;          // ... for this choice in the menus: { model, effort }
        var confirmNext = false;        // a choice made while claude was not running
        var ultraAvail = {};            // model choice -> ultracode available (get_settings)
        var ultraToggled = false;       // the user switched ultracode: say so in the note
        var confirmModeNext = false;
        var hasMessages = false;
        var sessionTitle = "";          // the first prompt of the chat (header)
        var lastTotalCost = 0;
        var lastResultError = false;    // the last turn ended with an error that is shown

        var accountsBar = null;         // Preferences > Claude > Accounts

        var loaded = false;
        function load() {
            if (loaded) return false;
            loaded = true;

            plugin.setCommand({
                name: "toggleclaude",
                hint: "show the Claude panel"
            });

            // the CSS of the panel and of its preferences (Accounts)
            ui.insertCss(require("text!./claude.less"), options.staticPrefix, plugin);

            settings.on("read", function() {
                // model, effort and mode: the default account's; an added
                // account keeps its own in user/claude/accounts
                settings.setDefaults("user/claude", [
                    ["path", ""],
                    ["model", "default"],
                    ["effort", ""],
                    ["mode", ""]
                ]);
                settings.setDefaults("state/claude", [
                    ["session", ""],
                    ["sessionAccount", ""],
                    ["title", ""],
                    ["account", ""]
                ]);
                updateButton();
            }, plugin);

            settings.on("user/claude/@path", function() {
                binChecked = false;
                refreshStatus();
            }, plugin);
            // the default account's choices, changed elsewhere (another
            // window, the settings file)
            ["model", "effort", "mode"].forEach(function(name) {
                settings.on("user/claude/@" + name, function(value) {
                    if (name == "effort" && tabMemory[""]) tabMemory[""].effort = value || "";
                    var node = { model: modelSelect, effort: effortSelect, mode: modeSelect }[name];
                    if (!drawn || chatAccount || !node || node.value == (value || "") || name == "model" && !value) return;
                    setSelect(node, value || "");
                    updateSettingLabels();
                }, plugin);
            });

            prefs.add({
                "General": {
                    "Claude": {
                        position: 950,
                        "Path to the claude CLI (empty: find it automatically)": {
                            type: "textbox",
                            path: "user/claude/@path",
                            position: 100
                        },
                        "Accounts": {
                            type: "custom",
                            position: 200,
                            node: accountsBar = new ui.bar({ "class": "claude-accounts-bar" })
                        }
                    }
                }
            }, plugin);
            accountsBar.on("DOMNodeInsertedIntoDocument", function() {
                renderAccountsPrefs();
                if (!api && c9.connected) loadRemote();
                else refreshAccounts();
            });

            // the file tree: a new chat in the folder (of the file) picked
            tree.getElement("mnuCtxTree", function(mnuCtxTree) {
                ui.insertByIndex(mnuCtxTree, new ui.item({
                    match: "",
                    caption: "New Claude Chat Here",
                    onclick: function() {
                        var node = tree.selectedNode;
                        if (!node) return;
                        var folder = node.isFolder ? node.path : node.parent && node.parent.path;
                        if (folder) newChatIn(folder);
                    }
                }), 1025, plugin);
            });

            layout.on("themeChange", function() {
                updateButton();
            }, plugin);
            aceHandle.on("themeChange", function() {
                updateCodeTheme();
            }, plugin);
            settings.on("user/ace", updateCodeFont, plugin);

            c9.on("connect", function() {
                if (drawn || accountsBar && accountsBar.$int) loadRemote();
            }, plugin);
            c9.on("disconnect", function() {
                api = null;
                stream = null;
                connecting = false;
                updateStatus();
            }, plugin);

            window.addEventListener("pagehide", onUnload);
            plugin.addOther(function() {
                window.removeEventListener("pagehide", onUnload);
            });
        }

        function onUnload(e) {
            // kept in the back/forward cache: the page may come back as it is
            if (e && e.persisted) return;
            // the session is resumed by id after a reload: free the memory now
            if (api && (running || busy)) api.stop(function() {});
        }

        // Skins with glyph panel buttons (jett, code-server): an icon instead
        // of the rotated caption. claude.less styles .claude-glyph.
        function updateButton() {
            var button = plugin.button;
            if (!button || !button.$ext) return;
            var skin = layout.theme || settings.get("user/general/@skin") || "";
            var glyph = /^(jett|code-server)/.test(skin);
            if (glyph) button.$ext.classList.add("claude-glyph");
            else button.$ext.classList.remove("claude-glyph");
        }

        /***** Remote service *****/

        function loadRemote(useCode) {
            if (connecting || api) return;
            connecting = true;
            updateStatus();
            ext.loadRemotePlugin("claude", {
                file: useCode ? undefined : "c9.ide.claude/claude-service.js",
                code: useCode ? require("text!./claude-service.js") : undefined
            }, function(err, remote) {
                connecting = false;
                // When the service is already loaded in this vfs (a
                // reconnect), vfs reports EEXIST but still returns its API,
                // which is reused. No API at all: the vfs could not load the
                // file (e.g. a remote workspace): send the code instead.
                if (!remote && !useCode)
                    return loadRemote(true);
                if (!remote) {
                    showError("Could not load the Claude service: " + (err && err.message || err));
                    return updateStatus();
                }
                connecting = true;
                remote.connect(function(err, meta) {
                    connecting = false;
                    if (err || !meta || !meta.stream) {
                        showError("Could not connect to the Claude service: " + (err && err.message || err));
                        return updateStatus();
                    }
                    // usable once its events can reach us
                    api = remote;
                    stream = meta.stream;
                    debug = debugOn();
                    refreshAccounts();
                    whenConnected.waiting.splice(0).forEach(function(fn) { fn(); });
                    stream.on("data", function(chunk) {
                        var events;
                        try {
                            events = JSON.parse(chunk);
                        } catch (e) {
                            return console.error("[claude] bad event from the service", e);
                        }
                        if (!Array.isArray(events)) events = [events];
                        if (debug) debugLog(events);
                        events.forEach(function(event) {
                            try {
                                onEvent(event);
                            } catch (e) {
                                console.error("[claude] event failed", event && event.ev, e);
                            }
                        });
                    });
                    stream.on("end", function() { if (stream === meta.stream) stream = null; });
                    stream.on("close", function() { if (stream === meta.stream) stream = null; });
                    refreshStatus();
                });
            });
        }

        // fn runs once the service is connected (now, if it is)
        function whenConnected(fn) {
            if (api) return fn();
            whenConnected.waiting.push(fn);
            if (c9.connected) loadRemote();
        }
        whenConnected.waiting = [];

        var binChecked = false;
        function refreshStatus(callback) {
            if (!api) return callback && callback();
            api.status({ path: settings.get("user/claude/@path") }, function(err, info) {
                cliInfo = err ? { found: false, error: err.message } : info;
                binChecked = true;
                renderWelcome();
                updateStatus();
                callback && callback();
            });
        }

        /***** Drawing *****/

        var drawn = false;
        function draw(e) {
            if (drawn) return;
            drawn = true;

            root = el("div", { className: "claude-root" });
            e.html.appendChild(root);
            // apf cancels mousedown (and so text selection) inside UI
            // elements that don't allow it; let the chat be selected
            e.aml.textselect = true;
            updateCodeFont();

            // header: status, the session's title, New and History
            statusDot = el("span", { className: "claude-status-dot" });
            statusText = el("span", { className: "claude-status-text", text: "Claude" });
            titleEl = el("span", { className: "claude-title" });
            chatAccount = defaultAccount();
            restoreModelCache(chatAccount);
            modelSelect = choice(modelItems);
            effortSelect = choice(effortItems);
            modeSelect = choice(MODES);
            btnNew = iconButton("plus", "New session", newSession);
            btnHistory = el("button", { className: "claude-icon-btn", title: "Session history", type: "button",
                "aria-haspopup": "true", "aria-expanded": "false" }, [icon("history")]);
            header = el("div", { className: "claude-header" }, [
                el("div", { className: "claude-status" }, [statusDot, statusText]),
                titleEl,
                el("div", { className: "claude-header-tools" }, [btnNew, btnHistory])
            ]);
            root.appendChild(header);

            // conversation
            logEl = el("div", { className: "claude-log", tabindex: "-1" });
            logEl.addEventListener("scroll", function() {
                autoScroll = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 32;
                jumpBtn.classList.toggle("claude-show", !autoScroll && hasMessages);
            });
            logEl.addEventListener("click", onLogClick);
            welcomeEl = el("div", { className: "claude-welcome" });
            logEl.appendChild(welcomeEl);
            jumpBtn = iconButton("down", "Scroll to the latest message", function() {
                autoScroll = true;
                scrollToEnd(true);
            });
            jumpBtn.classList.add("claude-jump");
            root.appendChild(el("div", { className: "claude-log-wrap" }, [logEl, jumpBtn]));

            // activity: what Claude does now, while a turn runs
            actText = el("span", { className: "claude-activity-text", "aria-live": "polite" });
            actMeta = el("span", { className: "claude-activity-meta" });
            actHint = el("span", { className: "claude-activity-hint", text: "Esc to stop" });
            actEl = el("div", { className: "claude-activity" }, [
                icon("spark", "claude-activity-spark"), actText, actMeta, actHint
            ]);
            root.appendChild(actEl);

            // composer
            attachRow = el("div", { className: "claude-attachments" });
            attachRow.style.display = "none";
            textarea = el("textarea", {
                className: "claude-input",
                rows: "1",
                placeholder: "Ask Claude…",
                spellcheck: "false"
            });
            textarea.addEventListener("input", autosize);
            textarea.addEventListener("keydown", onComposerKey);
            textarea.addEventListener("paste", onPaste);
            fileInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", multiple: "multiple" });
            fileInput.style.display = "none";
            fileInput.addEventListener("change", function() {
                addFiles([].slice.call(fileInput.files || []));
                fileInput.value = "";
            });
            btnAttach = iconButton("attach", "Attach images (or paste / drop them)", function() {
                fileInput.click();
            });
            btnSend = iconButton("send", "Send (Enter)", onSendButton);
            btnSend.classList.add("claude-send");
            // where the chat runs (account and folder): a line above the input
            wherePill = el("button", { type: "button", className: "claude-where-pill",
                "aria-haspopup": "true", "aria-expanded": "false" });
            // the model (with its effort) and the mode, as pills in the footer
            modelPill = el("button", { type: "button", className: "claude-pill claude-model-pill",
                "aria-haspopup": "true", "aria-expanded": "false" }, [
                el("span", { className: "claude-pill-name" }),
                el("span", { className: "claude-pill-effort" }),
                el("span", { className: "claude-pill-badge", text: "Ultracode" })
            ]);
            modePill = el("button", { type: "button", className: "claude-pill claude-mode-pill",
                "aria-haspopup": "true", "aria-expanded": "false" }, [
                el("span", { className: "claude-pill-icon" }),
                el("span", { className: "claude-pill-label" })
            ]);
            noteEl = el("div", { className: "claude-composer-note", "aria-live": "polite" });
            composerBox = el("div", { className: "claude-composer-box" }, [
                el("div", { className: "claude-where" }, [wherePill]),
                attachRow,
                textarea,
                el("div", { className: "claude-composer-bar" }, [
                    btnAttach,
                    modelPill,
                    modePill,
                    el("span", { className: "claude-composer-gap" }),
                    btnSend
                ])
            ]);
            // a permission prompt takes the place of the input box
            promptSlot = el("div", { className: "claude-prompt-slot" });
            promptSlot.style.display = "none";
            composer = el("div", { className: "claude-composer" }, [noteEl, composerBox, promptSlot, fileInput]);
            root.appendChild(composer);
            chipPreview = el("div", { className: "claude-chip-preview" });
            root.appendChild(chipPreview);

            modelPop = popover({ button: modelPill, className: "claude-pop-model", place: "up", build: buildModelPop });
            modePop = popover({ button: modePill, className: "claude-pop-mode", place: "up", build: buildModePop });
            wherePop = popover({ button: wherePill, className: "claude-pop-where", place: "up", build: buildWherePop,
                onopen: function() { refreshAccounts(); } });
            historyPop = popover({ button: btnHistory, className: "claude-pop-history", place: "down", align: "right",
                build: buildHistoryPop, onopen: loadHistory });

            // Esc stops Claude from anywhere in the panel (in a prompt: denies
            // it), except in an open menu
            root.addEventListener("keydown", function(e) {
                if (e.keyCode != 27 || e.defaultPrevented || menuOpen()) return;
                if (promptShown) {
                    e.preventDefault();
                    e.stopPropagation();
                    return promptShown.escape();
                }
                if (!(busy || stopping)) return;
                e.preventDefault();
                e.stopPropagation();
                interrupt();
            });
            composer.addEventListener("click", function(e) {
                if (e.target == composer || e.target == composerBox || e.target.classList.contains("claude-composer-gap"))
                    textarea.focus();
            });
            // narrow panel: the pills lose their labels
            if (typeof window.ResizeObserver == "function") {
                new window.ResizeObserver(fitWidth).observe(root);
            }
            window.addEventListener("resize", closePops);
            plugin.addOther(function() { window.removeEventListener("resize", closePops); });

            // drag and drop of images anywhere on the panel
            dropOverlay = el("div", { className: "claude-drop", text: "Drop images to attach them" });
            root.appendChild(dropOverlay);
            var dragDepth = 0;
            root.addEventListener("dragenter", function(e) {
                if (!images.hasFiles(e.dataTransfer)) return;
                e.preventDefault();
                dragDepth++;
                dropOverlay.classList.add("claude-show");
            });
            root.addEventListener("dragover", function(e) {
                if (!images.hasFiles(e.dataTransfer)) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "copy";
            });
            root.addEventListener("dragleave", function(e) {
                if (!images.hasFiles(e.dataTransfer)) return;
                dragDepth = Math.max(0, dragDepth - 1);
                if (!dragDepth) dropOverlay.classList.remove("claude-show");
            });
            root.addEventListener("drop", function(e) {
                if (!images.hasFiles(e.dataTransfer)) return;
                e.preventDefault();
                e.stopPropagation();
                dragDepth = 0;
                dropOverlay.classList.remove("claude-show");
                var files = images.filesFrom(e.dataTransfer);
                if (!files.length)
                    return flashHint("Only images can be attached");
                addFiles(files);
            });

            setSelect(modelSelect, acctPref("model") || "default");
            setSelect(effortSelect, memory().effort);
            setSelect(modeSelect, acctPref("mode"));
            updateSettingLabels();
            renderWhere();
            fitWidth();

            renderWelcome();
            updateStatus();
            updateButton();

            if (c9.connected) loadRemote();
        }

        /***** DOM helpers *****/

        function el(tag, attrs, children) {
            var node = document.createElement(tag);
            if (attrs) {
                Object.keys(attrs).forEach(function(key) {
                    var value = attrs[key];
                    if (value == null) return;
                    if (key == "className") node.className = value;
                    else if (key == "text") node.textContent = value;
                    else node.setAttribute(key, value);
                });
            }
            (children || []).forEach(function(child) {
                if (child == null || child === false) return;
                node.appendChild(typeof child == "string" ? document.createTextNode(child) : child);
            });
            return node;
        }

        function icon(name, className) {
            var span = document.createElement("span");
            span.className = "claude-icon" + (className ? " " + className : "");
            span.innerHTML = ICONS[name] || ""; // static markup from ICONS only
            return span;
        }

        function iconButton(name, title, onclick) {
            var button = el("button", { className: "claude-icon-btn", title: title, type: "button" }, [icon(name)]);
            button.addEventListener("click", function(e) {
                e.preventDefault();
                if (!button.disabled) onclick(e);
            });
            return button;
        }

        function textButton(caption, className, onclick, title) {
            var button = el("button", { className: "claude-btn " + (className || ""), type: "button", title: title, text: caption });
            button.addEventListener("click", function(e) {
                e.preventDefault();
                if (!button.disabled) onclick(e);
            });
            return button;
        }

        /***** Popover menus: inside the panel, never wider than it *****/

        var popIds = 0;

        // A menu that opens above (the footer's pills) or below (the
        // header's buttons) its button, inside the panel and at most as wide
        // as it. opts: { button, className, place: "up" | "down", align:
        // "right", build(pop), onopen() }. build fills the menu with
        // pop.heading(), pop.item() and pop.row(). Keyboard: Enter or Space
        // on the button opens it on the current choice; Up, Down, Home, End
        // move; Enter picks; Escape closes and gives the focus back.
        function popover(opts) {
            var node = el("div", { className: "claude-pop " + opts.className, role: "menu", tabindex: "-1" });
            node.style.display = "none";
            root.appendChild(node);
            var button = opts.button;
            var pop = { el: node, button: button, visible: false, rows: [], active: -1 };

            pop.clear = function() {
                node.textContent = "";
                pop.rows = [];
                pop.active = -1;
            };
            pop.heading = function(text, hint) {
                node.appendChild(el("div", { className: "claude-pop-heading" }, [
                    el("span", { text: text }),
                    hint ? el("span", { className: "claude-pop-hint", text: hint }) : null
                ]));
            };
            pop.info = function(text) {
                node.appendChild(el("div", { className: "claude-pop-info", text: text }));
            };
            // a row the keyboard reaches: { el, onpick(), onKey(e) -> handled }
            pop.row = function(row) {
                var index = pop.rows.length;
                row.el.id = row.el.id || "claude-pop-" + (++popIds);
                pop.rows.push(row);
                row.el.addEventListener("mousemove", function() {
                    if (pop.active != index) pop.highlight(index);
                });
                node.appendChild(row.el);
                return row;
            };
            // { label, desc, icon, checked, title, onpick, actions: [{ icon,
            // title, run, danger, disabled }] }. Actions: buttons on the right
            // (on hover), and with Right/Left on the highlighted row; Delete
            // runs the danger one.
            pop.item = function(item) {
                var actions = (item.actions || []).map(function(a) {
                    var b = el("button", { type: "button", tabindex: "-1", title: a.title, "aria-label": a.title,
                        className: "claude-pop-action" + (a.danger ? " claude-danger" : "") }, [icon(a.icon)]);
                    b.disabled = !!a.disabled;
                    b.addEventListener("click", function(e) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!b.disabled) a.run();
                    });
                    return b;
                });
                var row = el("div", { className: "claude-pop-item" + (item.checked ? " claude-checked" : ""),
                    role: "menuitemradio", "aria-checked": item.checked ? "true" : "false", title: item.title || null }, [
                    item.icon ? icon(item.icon, "claude-pop-icon") : null,
                    el("span", { className: "claude-pop-text" }, [
                        el("span", { className: "claude-pop-label", text: item.label }),
                        item.desc ? el("span", { className: "claude-pop-desc", text: item.desc }) : null
                    ]),
                    actions.length ? el("span", { className: "claude-pop-actions" }, actions) : null,
                    icon("check", "claude-pop-check")
                ]);
                row.addEventListener("click", function(e) {
                    e.preventDefault();
                    item.onpick();
                });
                var sub = -1;   // the action the keyboard is on
                function focusAction(i) {
                    sub = i;
                    actions.forEach(function(b, k) { b.classList.toggle("claude-focus", k == i); });
                    row.setAttribute("aria-label", i >= 0 ? actions[i].title : "");
                    if (i < 0) row.removeAttribute("aria-label");
                }
                return pop.row({
                    el: row,
                    checked: !!item.checked,
                    onpick: function() {
                        if (sub >= 0) actions[sub].click();
                        else item.onpick();
                    },
                    leave: function() { focusAction(-1); },
                    onKey: !actions.length ? null : function(e) {
                        var enabled = actions.map(function(b, k) { return b.disabled ? -1 : k; }).filter(function(k) { return k >= 0; });
                        if (e.keyCode == 39 || e.keyCode == 37) {
                            var at = enabled.indexOf(sub);
                            if (e.keyCode == 39) focusAction(at + 1 < enabled.length ? enabled[at + 1] : sub);
                            else focusAction(at > 0 ? enabled[at - 1] : -1);
                            return true;
                        }
                        if (e.keyCode == 46) {
                            var danger = (item.actions || []).filter(function(a) { return a.danger && !a.disabled; })[0];
                            if (danger) danger.run();
                            return true;
                        }
                        return false;
                    }
                });
            };
            pop.highlight = function(i) {
                var old = pop.rows[pop.active];
                if (old) old.el.classList.remove("claude-active");
                if (old && old.leave && pop.active != i) old.leave();
                pop.active = i;
                var row = pop.rows[i];
                if (!row) return node.removeAttribute("aria-activedescendant");
                row.el.classList.add("claude-active");
                node.setAttribute("aria-activedescendant", row.el.id);
                var top = row.el.offsetTop, bottom = top + row.el.offsetHeight;
                if (top < node.scrollTop) node.scrollTop = top;
                else if (bottom > node.scrollTop + node.clientHeight) node.scrollTop = bottom - node.clientHeight;
            };
            pop.open = function(byKeyboard) {
                if (pop.visible) return;
                closePops();
                pop.visible = true;
                if (opts.onopen) opts.onopen(pop);
                pop.clear();
                opts.build(pop);
                node.style.display = "";
                button.classList.add("claude-open");
                button.setAttribute("aria-expanded", "true");
                pop.place();
                var current = 0;
                pop.rows.forEach(function(row, i) { if (row.checked) current = i; });
                if (byKeyboard) pop.highlight(current);
                try { node.focus({ preventScroll: true }); } catch (e) {}
                document.addEventListener("mousedown", onOutside, true);
            };
            pop.close = function(refocus) {
                if (!pop.visible) return;
                pop.visible = false;
                node.style.display = "none";
                button.classList.remove("claude-open");
                button.setAttribute("aria-expanded", "false");
                document.removeEventListener("mousedown", onOutside, true);
                if (refocus) button.focus();
            };
            // rebuilt while open (e.g. when the sessions have loaded)
            pop.refresh = function() {
                if (!pop.visible) return;
                var keep = pop.active;
                pop.clear();
                opts.build(pop);
                pop.place();
                if (keep >= 0) pop.highlight(Math.min(keep, pop.rows.length - 1));
                // the focused element may have gone with the old rows
                var focus = document.activeElement;
                if (!focus || focus == document.body || node.contains(focus)) {
                    try { node.focus({ preventScroll: true }); } catch (e) {}
                }
            };
            pop.place = function() {
                var r = root.getBoundingClientRect();
                var b = button.getBoundingClientRect();
                node.style.maxWidth = Math.max(120, r.width - 16) + "px";
                var w = node.offsetWidth;
                var left = opts.align == "right" ? b.right - r.left - w : b.left - r.left;
                node.style.left = Math.max(8, Math.min(left, r.width - w - 8)) + "px";
                if (opts.place == "up") {
                    node.style.top = "";
                    node.style.bottom = (r.bottom - b.top + 4) + "px";
                    node.style.maxHeight = Math.max(100, b.top - r.top - header.offsetHeight - 8) + "px";
                }
                else {
                    node.style.bottom = "";
                    node.style.top = (b.bottom - r.top + 4) + "px";
                    node.style.maxHeight = Math.max(100, r.bottom - b.bottom - 12) + "px";
                }
            };
            function onOutside(e) {
                if (node.contains(e.target) || button.contains(e.target)) return;
                pop.close(false);
            }
            function move(step) {
                var n = pop.rows.length;
                if (!n) return;
                var i = pop.active < 0 ? (step > 0 ? -1 : n) : pop.active;
                pop.highlight(Math.max(0, Math.min(n - 1, i + step)));
            }
            // buttons in the menu do not take the focus from it
            node.addEventListener("mousedown", function(e) {
                if (e.target.closest && e.target.closest("button")) e.preventDefault();
            });
            node.addEventListener("keydown", function(e) {
                var row = pop.rows[pop.active];
                if (row && row.onKey && row.onKey(e)) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                switch (e.keyCode) {
                    case 40: move(1); break;
                    case 38: move(-1); break;
                    case 36: pop.highlight(0); break;
                    case 35: pop.highlight(pop.rows.length - 1); break;
                    case 13:
                    case 32: if (row && row.onpick) row.onpick(); break;
                    case 27: pop.close(true); break;
                    case 9: pop.close(true); break;
                    default: return;
                }
                e.preventDefault();
                e.stopPropagation();
            });
            button.addEventListener("click", function(e) {
                e.preventDefault();
                if (button.disabled) return;
                if (pop.visible) pop.close(e.detail === 0);
                else pop.open(e.detail === 0);
            });
            pops.push(pop);
            return pop;
        }

        function closePops() {
            pops.forEach(function(pop) { pop.close(false); });
        }

        function menuOpen() {
            return pops.some(function(pop) { return pop.visible; });
        }

        // A choice (model, effort, mode). source: the items, or a function
        // that returns them (the model list and the effort levels change).
        // An item: { value, caption, short (the label), desc, icon }.
        // node.label and node.tip: what the CLI really applies.
        function choice(source) {
            var node = { value: "", items: [], extra: [], label: null, tip: "" };
            node.refresh = function() {
                var items = typeof source == "function" ? source() : source;
                node.items = items.concat(node.extra.filter(function(x) {
                    return !items.some(function(i) { return i.value == x.value; });
                }));
            };
            node.find = function(value) {
                return node.items.filter(function(i) { return i.value == value; })[0];
            };
            node.refresh();
            return node;
        }

        function setSelect(node, value) {
            value = value == null ? "" : String(value);
            node.refresh();
            // a value the panel does not offer (e.g. bypassPermissions from
            // the user's settings, a model id): show it as it is
            if (value && !node.find(value)) {
                node.extra.push({ value: value, caption: value, short: value, icon: "tool" });
                node.refresh();
            }
            node.value = node.find(value) ? value : node.items[0].value;
            renderPills();
        }

        // the model menu: the CLI's models, then the effort of the chosen one
        function buildModelPop(pop) {
            pop.heading("Select a model");
            modelSelect.refresh();
            modelSelect.items.forEach(function(item) {
                pop.item({ label: item.caption, desc: item.desc, checked: item.value == modelSelect.value, onpick: function() {
                    pop.close(true);
                    if (item.value == modelSelect.value) return;
                    modelSelect.value = item.value;
                    onModelChange(item.value);
                } });
            });
            var levels = effortLevels(modelSelect.value);
            if (levels.length) pop.row(effortControl(pop, [""].concat(levels)));
            // ultracode: where the model supports it, or while it is requested
            var ultra = ultracodeState();
            if (ultraAvail[modelSelect.value] === true || ultra != "off" || applied && applied.ultracodeAvailable
                && appliedFor && appliedFor.model == modelSelect.value)
                pop.row(ultracodeControl(pop, ultra));
        }

        // a switch below the effort
        function ultracodeControl(pop, state) {
            var on = state != "off";
            var knob = el("span", { className: "claude-switch" + (on ? " claude-on" : ""), role: "switch",
                "aria-checked": on ? "true" : "false", "aria-label": "Ultracode" }, [el("span", { className: "claude-switch-knob" })]);
            var box = el("div", { className: "claude-ultracode" + (state == "unavailable" ? " claude-unavailable" : "") }, [
                el("div", { className: "claude-ultracode-head" }, [el("span", { text: "Ultracode" }), knob]),
                el("div", { className: "claude-ultracode-note", text: state == "unavailable"
                    ? "Requested, but " + (modelEntry(modelSelect.value) ? modelEntry(modelSelect.value).displayName : "this model")
                        + " does not support it"
                    : "Multi-agent workflows for big tasks · uses many more tokens" })
            ]);
            function toggle() {
                onUltracodeChange(!on);
                pop.refresh();
            }
            box.addEventListener("click", function(e) {
                e.preventDefault();
                toggle();
            });
            return {
                el: box,
                onpick: toggle,
                onKey: function(e) {
                    if ((e.keyCode == 39 && !on) || (e.keyCode == 37 && on)) {
                        toggle();
                        return true;
                    }
                    return e.keyCode == 37 || e.keyCode == 39;
                }
            };
        }

        // Effort as a segmented control at the bottom of the model menu:
        // Auto (Claude's settings decide) and the levels the model supports.
        // Left and Right change it when its row is highlighted.
        function effortControl(pop, values) {
            var valueEl = el("span", { className: "claude-effort-value" });
            var seg = el("div", { className: "claude-seg", role: "radiogroup", "aria-label": "Effort" });
            var note = el("div", { className: "claude-effort-note", text: "Max may use many tokens and respond slowly" });
            var buttons = values.map(function(value) {
                var b = el("button", { type: "button", tabindex: "-1", className: "claude-seg-btn", role: "radio",
                    title: value ? effortCaption(value) : "Auto: Claude's settings decide", text: SEGMENTS[value] || value });
                b.addEventListener("click", function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    set(value);
                });
                seg.appendChild(b);
                return b;
            });
            var box = el("div", { className: "claude-effort" }, [
                el("div", { className: "claude-effort-head" }, [el("span", { text: "Effort" }), valueEl]),
                seg,
                note
            ]);
            function render() {
                var current = effortSelect.value;
                valueEl.textContent = current ? effortCaption(current) : "Auto";
                box.setAttribute("aria-label", "Effort: " + valueEl.textContent);
                buttons.forEach(function(b, i) {
                    var on = values[i] == current;
                    b.classList.toggle("claude-on", on);
                    b.setAttribute("aria-checked", on ? "true" : "false");
                });
                note.style.display = current == "max" ? "" : "none";
            }
            function set(value) {
                if (value == effortSelect.value) return;
                effortSelect.value = value;
                onEffortChange(value);
                render();
                pop.place();
            }
            render();
            return {
                el: box,
                onpick: function() { pop.close(true); },
                onKey: function(e) {
                    if (e.keyCode != 37 && e.keyCode != 39) return false;
                    var i = Math.max(0, values.indexOf(effortSelect.value)) + (e.keyCode == 39 ? 1 : -1);
                    set(values[Math.max(0, Math.min(values.length - 1, i))]);
                    return true;
                }
            };
        }

        function buildModePop(pop) {
            pop.heading("Mode", "Shift+Tab switches");
            modeSelect.refresh();
            modeSelect.items.forEach(function(item) {
                pop.item({ label: item.caption, desc: item.desc, icon: item.icon || "tool", checked: item.value == modeSelect.value,
                    onpick: function() {
                        pop.close(true);
                        if (item.value == modeSelect.value) return;
                        setSelect(modeSelect, item.value);
                        onModeChange(item.value);
                    } });
            });
        }

        // the next mode, from the input (Shift+Tab)
        function cycleMode() {
            var i = MODE_CYCLE.indexOf(modeSelect.value || "default");
            var next = MODE_CYCLE[(i + 1) % MODE_CYCLE.length];
            setSelect(modeSelect, next);
            onModeChange(next);
            flashHint("Mode: " + modeCaption(next) + " (Shift+Tab switches)", true);
        }

        // the footer's pills: the model (and its effort) and the mode
        function renderPills() {
            if (!modelPill || !modelSelect || !effortSelect || !modeSelect) return;
            var entry = modelSelect.find(modelSelect.value);
            var name = modelSelect.label || (entry ? entry.short || entry.caption : modelSelect.value);
            var effort = "";
            if (effortLevels(modelSelect.value).length)
                effort = effortSelect.label || (effortSelect.value ? effortCaption(effortSelect.value) : "");
            modelPill.querySelector(".claude-pill-name").textContent = name;
            modelPill.querySelector(".claude-pill-effort").textContent = effort ? " · " + effort : "";
            var ultra = ultracodeState();
            var badge = modelPill.querySelector(".claude-pill-badge");
            badge.style.display = ultra == "off" ? "none" : "";
            badge.classList.toggle("claude-badge-off", ultra == "unavailable");
            var ultraTip = ultra == "on" ? "Ultracode: on"
                : ultra == "unavailable" ? "Ultracode: requested, but this model does not support it" : "";
            modelPill.title = (modelSelect.tip || "Model: " + name) + (effortSelect.tip && effortLevels(modelSelect.value).length
                ? "\n" + effortSelect.tip : "") + (ultraTip ? "\n" + ultraTip : "");
            var mode = modeSelect.find(modeSelect.value) || { caption: modeSelect.value, short: modeSelect.value, icon: "tool" };
            var iconEl = modePill.querySelector(".claude-pill-icon");
            iconEl.textContent = "";
            iconEl.appendChild(icon(mode.icon || "tool"));
            modePill.querySelector(".claude-pill-label").textContent = mode.short || mode.caption;
            modePill.title = "Permission mode: " + mode.caption + " (Shift+Tab in the input switches)";
        }

        // a narrow panel: the mode pill shows its icon only, then the model pill its name only
        function fitWidth() {
            if (!root) return;
            var w = root.clientWidth;
            if (!w) return;
            root.classList.toggle("claude-narrow", w < 360);
            root.classList.toggle("claude-tiny", w < 310);
            pops.forEach(function(pop) { if (pop.visible) pop.place(); });
        }

        /***** Accounts and folders *****/

        // An account is a Claude Code config folder: its login, settings and
        // history. "" is the default one ("Personal": Claude Code as in a
        // terminal); added ones are { dir, name, model, effort, mode } in
        // user/claude/accounts, dir being the folder's name in the home
        // folder (".claude-work"). A chat runs as one account in one folder,
        // both fixed by its first message.

        function addedAccounts() {
            var list = settings.getJson("user/claude/accounts");
            var seen = {};
            return (Array.isArray(list) ? list : []).filter(function(a) {
                var ok = a && typeof a.dir == "string" && ACCOUNT_RE.test(a.dir) && !/^\.+$/.test(a.dir)
                    && a.dir != ".claude" && !seen[a.dir];
                if (ok) seen[a.dir] = true;
                return ok;
            }).slice(0, MAX_ACCOUNTS);
        }

        function allAccounts() {
            return [{ dir: "", name: DEFAULT_ACCOUNT_NAME }].concat(addedAccounts());
        }

        // more than the default account: the pill and the history name them
        function several() {
            return addedAccounts().length > 0;
        }

        function accountByKey(key) {
            return allAccounts().filter(function(a) { return a.dir == key; })[0] || null;
        }

        function accountName(key) {
            var a = accountByKey(key);
            return a ? String(a.name || a.dir || DEFAULT_ACCOUNT_NAME) : String(key || DEFAULT_ACCOUNT_NAME);
        }

        // the account a new chat starts with: the one picked last
        function defaultAccount() {
            var key = settings.get("state/claude/@account") || "";
            return accountByKey(key) ? key : "";
        }

        // "w@x.com", "Not logged in", ...: from the service
        function accountStatus(key) {
            var info = acctInfo[key];
            if (!info) return "";
            if (info.exists === false) return "Folder " + info.dir + " not found";
            if (info.email) return info.email + (info.org ? " · " + info.org : "");
            if (info.auth == "env") return "Key or token from the server's environment";
            return info.loggedIn ? "Logged in" : "Not logged in";
        }

        // the model, effort and mode an account uses (as last chosen)
        function acctPref(name, key) {
            if (key === undefined) key = chatAccount;
            if (!key) return settings.get("user/claude/@" + name) || "";
            var a = accountByKey(key);
            return a && typeof a[name] == "string" ? a[name] : "";
        }

        function setAcctPref(name, value, key) {
            if (key === undefined) key = chatAccount;
            if (!key) return settings.set("user/claude/@" + name, value);
            var list = settings.getJson("user/claude/accounts");
            if (!Array.isArray(list)) return;
            list.forEach(function(a) { if (a && a.dir == key) a[name] = value; });
            settings.setJson("user/claude/accounts", list);
        }

        // Effort and Ultracode as this tab left them. A tab starts with the
        // effort last chosen, but not above High, and with Ultracode off.
        function memory(key) {
            if (key === undefined) key = chatAccount;
            if (!tabMemory[key]) {
                var effort = acctPref("effort", key);
                tabMemory[key] = { effort: effort == "xhigh" || effort == "max" ? "high" : effort, ultracode: false };
            }
            return tabMemory[key];
        }

        // the model list and applied settings an account's claude reported
        function cacheGet(name, key) {
            if (!key) return settings.getJson("state/claude/" + name);
            var all = settings.getJson("state/claude/cache");
            return all && typeof all == "object" && all[key] && all[key][name] || null;
        }

        function cacheSet(name, value, key) {
            if (key === undefined) key = chatAccount;
            if (!key) return settings.setJson("state/claude/" + name, value);
            var all = settings.getJson("state/claude/cache");
            if (!all || typeof all != "object" || Array.isArray(all)) all = {};
            Object.keys(all).forEach(function(k) { if (!accountByKey(k)) delete all[k]; });
            all[key] = all[key] && typeof all[key] == "object" ? all[key] : {};
            all[key][name] = value;
            settings.setJson("state/claude/cache", all);
        }

        // For a new chat: its account, with that account's model, effort and mode
        function useAccount(key) {
            chatAccount = accountByKey(key) ? key : "";
            if (!drawn) return;
            restoreModelCache(chatAccount);
            setSelect(modelSelect, acctPref("model") || "default");
            setSelect(effortSelect, memory().effort);
            setSelect(modeSelect, acctPref("mode"));
            updateSettingLabels();
            renderWhere();
        }

        function chatLocked() {
            return !!sessionId || hasSentInSession;
        }

        function workspaceDir() {
            return String(c9.workspaceDir || "/").replace(/(.)\/$/, "$1");
        }

        // the folder of the chat: the one the CLI reports, the chosen one, or the workspace
        function currentFolder() {
            return chatCwd || chatFolder || workspaceDir();
        }

        function tildePath(abs) {
            var home = String(cliInfo && cliInfo.home || c9.home || "").replace(/\/$/, "");
            if (home && abs == home) return "~";
            if (home && abs.indexOf(home + "/") === 0) return "~" + abs.slice(home.length);
            return abs;
        }

        // "~/IDM", "/var/www/html"; a long one as "…/www/html"
        function shortFolder(abs) {
            var t = tildePath(abs);
            if (t.length <= 40) return t;
            return "\u2026/" + t.replace(/\/$/, "").split("/").slice(-2).join("/");
        }

        // a path of the editor ("/IDM", "~/x", "/zoot/var/www") as an absolute path
        function editorToAbsolute(p) {
            p = String(p || "");
            if (/^~(\/|$)/.test(p)) return String(c9.home || "").replace(/\/$/, "") + p.slice(1);
            var ws = workspaceDir().replace(/\/$/, "");
            return !p || p == "/" ? workspaceDir() : ws + (p.charAt(0) == "/" ? "" : "/") + p;
        }

        function recentFolders() {
            var list = settings.getJson("state/claude/folders");
            return (Array.isArray(list) ? list : []).filter(function(f) {
                return typeof f == "string" && /^\//.test(f);
            }).slice(0, RECENT_FOLDERS);
        }

        function rememberFolder(folder, on) {
            var list = recentFolders().filter(function(f) { return f != folder; });
            if (on) list.unshift(folder);
            settings.setJson("state/claude/folders", list.slice(0, RECENT_FOLDERS));
        }

        // The folder of a new chat: a full path ("~/..." too); "" for the
        // workspace. The service checks that it exists and gives its real path.
        function setFolder(p, callback) {
            callback = callback || function(err) {
                if (err) flashHint(err.message || String(err));
            };
            if (chatLocked()) return callback(new Error("The folder of a chat is fixed once it has started"));
            if (!p) {
                chatFolder = "";
                renderWhere();
                return callback(null, workspaceDir());
            }
            // e.g. a chat started from the file tree in a panel that just opened
            if (!api) return whenConnected(function() { setFolder(p, callback); });
            api.checkFolder(p, function(err, res) {
                if (err || !res || typeof res.path != "string") return callback(err || new Error("Could not check the folder"));
                if (chatLocked()) return callback(new Error("The folder of a chat is fixed once it has started"));
                chatFolder = res.workspace ? "" : res.path;
                if (chatFolder) rememberFolder(chatFolder, true);
                renderWhere();
                callback(null, res.path);
            });
        }

        function chooseFolder() {
            var start = workspacePath(chatFolder || workspaceDir()) || "/";
            fileDialog.show("Choose the folder for the chat", start, function(path, stat, done) {
                done();
                setFolder(editorToAbsolute(path));
            }, null, { hideFileInput: true, chooseCaption: "Choose", showFilesCheckbox: false, createFolderButton: false });
        }

        // From the file tree: a new chat in that folder (a path of the editor)
        function newChatIn(editorPath) {
            function go() {
                if (!drawn) return;
                newSession();
                setFolder(editorToAbsolute(editorPath));
            }
            function start() {
                plugin.show();
                if (drawn) go();
                else plugin.once("draw", function() { setTimeout(go, 0); });
            }
            if (busy || stopping)
                return confirm("New Claude chat", "Claude is still working in the current chat.",
                    "Stop it and start a new chat in " + tildePath(editorToAbsolute(editorPath)) + "?", start, function() {});
            start();
        }

        // the line above the input: [account] [folder] (the account only
        // when there are several), a chevron while it can still change
        function renderWhere() {
            if (!wherePill) return;
            var folder = chatFolder || workspaceDir();
            var locked = chatLocked();
            wherePill.textContent = "";
            if (several()) {
                wherePill.appendChild(icon("user", "claude-where-icon"));
                wherePill.appendChild(el("span", { className: "claude-where-account", text: accountName(chatAccount) }));
            }
            wherePill.appendChild(icon("folder", "claude-where-icon"));
            wherePill.appendChild(el("span", { className: "claude-where-folder", text: shortFolder(folder) }));
            if (!locked) wherePill.appendChild(icon("chevron", "claude-where-chevron"));
            wherePill.classList.toggle("claude-locked", locked);
            var status = accountStatus(chatAccount);
            wherePill.title = "Account: " + accountName(chatAccount) + (status ? " (" + status + ")" : "")
                + "\nFolder: " + tildePath(folder)
                + (locked ? "\nFixed for this chat; a new session can use another" : "\nClick to choose another for this chat");
        }

        function buildWherePop(pop) {
            var folder = chatFolder || workspaceDir();
            if (chatLocked()) {
                pop.heading("This chat");
                pop.info("Account: " + accountName(chatAccount) + (accountStatus(chatAccount) ? " · " + accountStatus(chatAccount) : ""));
                pop.info("Folder: " + tildePath(folder));
                pop.item({ label: "New session here", desc: "The same account and folder", icon: "plus", onpick: function() {
                    var account = chatAccount, keep = chatFolder;
                    pop.close(true);
                    newSession();
                    useAccount(account);
                    if (keep && keep != workspaceDir()) setFolder(keep);
                } });
                return;
            }
            pop.heading("Account");
            allAccounts().forEach(function(a) {
                pop.item({ label: a.name || a.dir, desc: accountStatus(a.dir) || (a.dir ? "~/" + a.dir : ""), icon: "user",
                    checked: a.dir == chatAccount, onpick: function() {
                        pop.close(true);
                        settings.set("state/claude/@account", a.dir);
                        if (a.dir != chatAccount) useAccount(a.dir);
                    } });
            });
            pop.item({ label: "Manage accounts…", icon: "gear", onpick: function() {
                pop.close(false);
                openAccountPrefs();
            } });
            pop.heading("Folder");
            pop.item({ label: shortFolder(workspaceDir()), desc: "The workspace", icon: "folder", checked: !chatFolder,
                title: tildePath(workspaceDir()), onpick: function() {
                pop.close(true);
                setFolder("");
            } });
            recentFolders().forEach(function(f) {
                if (f == workspaceDir()) return;
                pop.item({ label: shortFolder(f), icon: "folder", checked: chatFolder == f, title: tildePath(f), onpick: function() {
                    pop.close(true);
                    setFolder(f, function(err) {
                        if (!err) return;
                        rememberFolder(f, false);
                        flashHint(err.message || String(err));
                    });
                }, actions: [{ icon: "close", title: "Remove from this list", run: function() {
                    rememberFolder(f, false);
                    pop.refresh();
                } }] });
            });
            pop.item({ label: "Choose folder…", icon: "search", onpick: function() {
                pop.close(false);
                chooseFolder();
            } });
            pop.row(folderInput(pop));
        }

        // "Or type a full path": Enter uses it
        function folderInput(pop) {
            var input = el("input", { type: "text", className: "claude-folder-input", spellcheck: "false",
                placeholder: "Or type a full path, e.g. /var/www/html", "aria-label": "Folder path" });
            var error = el("div", { className: "claude-folder-error", role: "alert" });
            input.addEventListener("keydown", function(e) {
                if (e.keyCode == 27 || e.keyCode == 9) return;  // the menu closes
                e.stopPropagation();
                if (e.keyCode != 13) return;
                e.preventDefault();
                var value = input.value.trim();
                if (!value) return;
                setFolder(value, function(err) {
                    if (!err) return pop.close(true);
                    error.textContent = err.message || String(err);
                    pop.place();
                });
            });
            return { el: el("div", { className: "claude-folder-row" }, [input, error]), onpick: function() { input.focus(); } };
        }

        // what the service knows about each account (login, email, sharing)
        function refreshAccounts(callback) {
            if (!api) return callback && callback();
            api.accounts(allAccounts().map(function(a) { return a.dir; }), function(err, res) {
                if (!err && res && res.accounts && typeof res.accounts == "object") {
                    acctInfo = res.accounts;
                    defaultEnvDir = typeof res.defaultEnv == "string" && /^\//.test(res.defaultEnv) ? res.defaultEnv : null;
                }
                renderWhere();
                if (wherePop && wherePop.visible) wherePop.refresh();
                renderAccountsPrefs();
                callback && callback(err);
            });
        }

        function openAccountPrefs() {
            commands.exec("openpreferences", null, { panel: "general", section: "Claude" });
        }

        // A terminal that runs claude with the account's folder, to log in
        // (/login) the way Claude Code does it. The default account: with the
        // server's CLAUDE_CONFIG_DIR, if it has one.
        function loginAccount(key) {
            // where the panel found it: ~/.local/bin may not be on the
            // terminal's PATH
            var bin = settings.get("user/claude/@path")
                || cliInfo && cliInfo.found && cliInfo.path || "claude";
            var home = String(cliInfo && cliInfo.home || c9.home || "").replace(/\/$/, "");
            var rest = defaultEnvDir && home && defaultEnvDir.indexOf(home + "/") === 0 ? defaultEnvDir.slice(home.length) : null;
            // only the "$HOME" written here is expanded by the shell
            var dir = key ? "\"$HOME/" + key + "\""
                : !defaultEnvDir ? ""
                : rest && /^[A-Za-z0-9_\/.+-]+$/.test(rest) ? "\"$HOME" + rest + "\""
                : quote(defaultEnvDir);
            var command = (dir ? "CLAUDE_CONFIG_DIR=" + dir + " " : "")
                + (/^[A-Za-z0-9_\/.~+-]+$/.test(bin) ? bin : quote(bin));
            function quote(text) {
                return "'" + text.replace(/'/g, "'\\''") + "'";
            }
            // the terminal's cwd is relative to the workspace unless it
            // starts with "~" (the server expands that to the home folder)
            tabManager.open({ focus: true, active: true, editorType: "terminal",
                document: { terminal: { cwd: "~" } } }, function(err, tab) {
                if (err || !tab || !tab.editor || !tab.editor.write) return;
                tab.editor.write(command + "\n");
            });
        }

        /***** Preferences > Claude > Accounts *****/

        var acctUi = { adding: null, removing: null, error: "", notes: {} };

        function renderAccountsPrefs() {
            var host = accountsBar && accountsBar.$int;
            if (!host) return;
            var box = el("div", { className: "claude-accounts" });
            box.appendChild(el("div", { className: "claude-acct-intro", text: "Each account is a Claude Code "
                + "folder with its own login, settings and chats. A chat uses the account chosen when it starts "
                + "(above the input in the Claude panel)." }));
            allAccounts().forEach(function(a) { box.appendChild(accountRow(a)); });
            box.appendChild(addAccountForm());
            if (!api) box.appendChild(el("div", { className: "claude-acct-note", text: "Connecting to the server…" }));
            host.textContent = "";
            host.appendChild(box);
        }

        function accountRow(a) {
            var key = a.dir;
            var info = acctInfo[key] || {};
            var row = el("div", { className: "claude-acct" + (key == chatAccount ? " claude-acct-current" : "") });
            var name = key
                ? el("input", { type: "text", className: "claude-acct-name", value: a.name || key, "aria-label": "Name of the account" })
                : el("span", { className: "claude-acct-name claude-acct-fixed", text: DEFAULT_ACCOUNT_NAME });
            if (key) name.addEventListener("change", function() {
                var value = name.value.trim().slice(0, 40) || key;
                var list = settings.getJson("user/claude/accounts");
                (Array.isArray(list) ? list : []).forEach(function(x) { if (x && x.dir == key) x.name = value; });
                settings.setJson("user/claude/accounts", list);
                renderWhere();
            });
            var status = accountStatus(key);
            row.appendChild(el("div", { className: "claude-acct-head" }, [
                name,
                el("span", { className: "claude-acct-dir", text: info.dir || (key ? "~/" + key : "~/.claude") }),
                el("span", { className: "claude-acct-status" + (info.loggedIn ? " claude-acct-ok" : ""), text: status || "…" })
            ]));
            row.appendChild(el("div", { className: "claude-acct-buttons" }, [
                textButton(info.loggedIn ? "Log in again…" : "Log in…", "claude-btn-secondary", function() {
                    acctUi.notes[key] = info.loggedIn
                        ? "In the terminal, type /login in Claude Code and follow the steps; then press Check."
                        : "In the terminal, Claude Code starts for this account: on a first start it asks for a text "
                            + "style and how to log in (your Claude account), then shows a link to open and a code to "
                            + "paste back. Otherwise type /login. Then press Check.";
                    loginAccount(key);
                    renderAccountsPrefs();
                }, "Opens a terminal with claude for this account"),
                textButton("Check", "claude-btn-secondary", function() { refreshAccounts(); }, "Check the login again"),
                key ? textButton("Remove…", "claude-btn-secondary", function() {
                    acctUi.removing = key;
                    renderAccountsPrefs();
                }) : null
            ]));
            if (key && info.share) {
                var shares = el("div", { className: "claude-acct-share" }, [
                    el("span", { className: "claude-acct-label", text: "Shares with " + DEFAULT_ACCOUNT_NAME + ":" })
                ]);
                SHARES.forEach(function(item) {
                    var state = info.share[item.key];
                    var box = el("input", { type: "checkbox" });
                    box.checked = state === true;
                    box.disabled = state == "own";
                    box.addEventListener("change", function() {
                        var share = {};
                        share[item.key] = box.checked;
                        setShare(key, share);
                    });
                    shares.appendChild(el("label", { className: "claude-acct-check", title: state == "own"
                        ? "This account has its own " + item.caption + "; it is left as it is"
                        : item.desc || "" }, [box, item.caption + (state == "own" ? " (its own)" : "")]));
                });
                row.appendChild(shares);
            }
            if (acctUi.notes[key])
                row.appendChild(el("div", { className: "claude-acct-note", text: acctUi.notes[key] }));
            if (acctUi.removing == key) {
                row.appendChild(el("div", { className: "claude-acct-confirm" }, [
                    el("span", { text: "Remove " + (a.name || key) + " from this list? Its folder ~/" + key
                        + " (login, settings, chats) stays on the server." }),
                    textButton("Remove", "claude-btn-danger", function() { removeAccount(key); }),
                    textButton("Cancel", "claude-btn-secondary", function() {
                        acctUi.removing = null;
                        renderAccountsPrefs();
                    })
                ]));
            }
            return row;
        }

        function addAccountForm() {
            var form = acctUi.adding;
            if (!form) {
                return el("div", { className: "claude-acct-add" }, [
                    textButton("Add an account…", "claude-btn-secondary", function() {
                        acctUi.adding = { name: "", dir: "", dirEdited: false, share: {}, busy: false };
                        acctUi.error = "";
                        renderAccountsPrefs();
                        var input = accountsBar.$int.querySelector(".claude-acct-new-name");
                        if (input) input.focus();
                    })
                ]);
            }
            var nameEl = el("input", { type: "text", className: "claude-acct-new-name", value: form.name,
                placeholder: "Name, e.g. Work", "aria-label": "Name of the new account" });
            var dirEl = el("input", { type: "text", className: "claude-acct-new-dir", value: form.dir,
                placeholder: ".claude-work", spellcheck: "false", "aria-label": "Folder of the new account" });
            nameEl.addEventListener("input", function() {
                form.name = nameEl.value;
                if (!form.dirEdited) {
                    var slug = form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
                    form.dir = slug ? ".claude-" + slug.slice(0, 40) : "";
                    dirEl.value = form.dir;
                }
            });
            dirEl.addEventListener("input", function() {
                form.dir = dirEl.value;
                form.dirEdited = true;
            });
            var checks = el("div", { className: "claude-acct-share" }, [
                el("span", { className: "claude-acct-label", text: "Share with " + DEFAULT_ACCOUNT_NAME + ":" })
            ]);
            SHARES.forEach(function(item) {
                var box = el("input", { type: "checkbox" });
                box.checked = !!form.share[item.key];
                box.addEventListener("change", function() { form.share[item.key] = box.checked; });
                checks.appendChild(el("label", { className: "claude-acct-check", title: item.desc || "" }, [box, item.caption]));
            });
            var add = textButton(form.busy ? "Adding…" : "Add account", "claude-btn-primary", function() { addAccount(form); });
            add.disabled = form.busy;
            [nameEl, dirEl].forEach(function(input) {
                input.addEventListener("keydown", function(e) {
                    if (e.keyCode == 13) {
                        e.preventDefault();
                        addAccount(form);
                    }
                });
            });
            return el("div", { className: "claude-acct-add claude-acct-form" }, [
                el("div", { className: "claude-acct-fields" }, [
                    el("label", { className: "claude-acct-field" }, [el("span", { text: "Name" }), nameEl]),
                    el("label", { className: "claude-acct-field" }, [el("span", { text: "Folder  ~/" }), dirEl])
                ]),
                checks,
                el("div", { className: "claude-acct-note", text: "Nothing is shared unless ticked; you can change it later. "
                    + "settings.json can only be read through the link: Claude can't save settings from this account." }),
                acctUi.error ? el("div", { className: "claude-acct-error", role: "alert", text: acctUi.error }) : null,
                el("div", { className: "claude-acct-buttons" }, [
                    add,
                    textButton("Cancel", "claude-btn-secondary", function() {
                        acctUi.adding = null;
                        acctUi.error = "";
                        renderAccountsPrefs();
                    })
                ])
            ]);
        }

        function addAccount(form) {
            if (form.busy) return;
            var name = form.name.trim().slice(0, 40);
            var dir = form.dir.trim().replace(/^~\//, "");
            var error = !name ? "Give the account a name"
                : !ACCOUNT_RE.test(dir) || /^\.+$/.test(dir) ? "The folder is a name in your home folder, e.g. .claude-work (letters, digits, . _ -)"
                : dir == ".claude" ? "~/.claude is the folder of " + DEFAULT_ACCOUNT_NAME
                : accountByKey(dir) ? "~/" + dir + " is already in the list"
                : addedAccounts().length >= MAX_ACCOUNTS ? "At most " + MAX_ACCOUNTS + " accounts"
                : !api ? "Not connected to the server" : "";
            acctUi.error = error;
            if (error) return renderAccountsPrefs();
            form.busy = true;
            renderAccountsPrefs();
            api.setupAccount({ account: dir, create: true, share: form.share }, function(err, res) {
                form.busy = false;
                if (err) {
                    acctUi.error = err.message || String(err);
                    return renderAccountsPrefs();
                }
                var list = settings.getJson("user/claude/accounts");
                list = Array.isArray(list) ? list : [];
                list.push({ dir: dir, name: name });
                settings.setJson("user/claude/accounts", list);
                acctUi.adding = null;
                acctUi.notes[dir] = "Added. Press “Log in…” to sign in to this account."
                    + (res && res.warnings && res.warnings.length ? " " + res.warnings.join(" ") : "");
                renderWhere();
                refreshAccounts();
            });
        }

        function removeAccount(key) {
            var list = settings.getJson("user/claude/accounts");
            settings.setJson("user/claude/accounts", (Array.isArray(list) ? list : []).filter(function(a) {
                return !(a && a.dir == key);
            }));
            acctUi.removing = null;
            delete acctUi.notes[key];
            delete acctInfo[key];
            delete tabMemory[key];
            if (settings.get("state/claude/@account") == key) settings.set("state/claude/@account", "");
            if (chatAccount == key && !chatLocked()) useAccount("");
            renderWhere();
            renderAccountsPrefs();
        }

        function setShare(key, share) {
            if (!api) return;
            api.setupAccount({ account: key, share: share }, function(err, res) {
                if (err) acctUi.notes[key] = err.message || String(err);
                else {
                    if (acctInfo[key]) acctInfo[key].share = res.share;
                    acctUi.notes[key] = res.warnings && res.warnings.length ? res.warnings.join(" ")
                        : "Saved; it applies to chats that start from now on.";
                }
                renderAccountsPrefs();
            });
        }

        /***** Session history *****/

        function relativeTime(ms, now) {
            var s = Math.max(0, (now - ms) / 1000);
            if (s < 60) return "just now";
            if (s < 3600) return Math.round(s / 60) + " min ago";
            if (s < 86400) return Math.round(s / 3600) + " h ago";
            if (s < 7 * 86400) {
                var d = Math.round(s / 86400);
                return d + (d == 1 ? " day ago" : " days ago");
            }
            return new Date(ms).toLocaleDateString();
        }

        // The recent Claude Code sessions of this workspace (the panel's and
        // the terminal's), newest first. The service reads the transcripts.
        // Archived ones (a list in the state settings, this panel only) are
        // listed apart; a deleted one is gone for good.
        var historyData = null;
        var historyView = "list";       // or "archived"
        var historyConfirm = null;      // the session whose deletion is being confirmed
        var historyError = "";
        var historyBusy = false;
        var historyLimit = HISTORY_PAGE;
        var ARCHIVE_MAX = 500;

        function archivedIds() {
            var ids = settings.getJson("state/claude/archived");
            return (Array.isArray(ids) ? ids : []).filter(function(id) {
                return typeof id == "string" && UUID_RE.test(id);
            }).slice(-ARCHIVE_MAX);
        }

        function setArchived(id, on) {
            var ids = archivedIds().filter(function(x) { return x != id; });
            if (on) ids.push(id);
            settings.setJson("state/claude/archived", ids.slice(-ARCHIVE_MAX));
        }

        // keep: reload with more sessions ("Show older"), on the same view
        function loadHistory(pop, keep) {
            if (!keep) {
                historyData = { loading: true };
                historyView = "list";
                historyLimit = HISTORY_PAGE;
            }
            historyConfirm = null;
            historyError = "";
            if (!api) return;
            api.sessions({
                archived: archivedIds(),
                accounts: allAccounts().map(function(a) { return a.dir; }),
                limit: historyLimit
            }, function(err, res) {
                historyData = err ? { error: err.message || String(err) } : {
                    list: res && Array.isArray(res.sessions) ? res.sessions : [],
                    archived: res && Array.isArray(res.archived) ? res.archived : [],
                    more: !!(res && res.more),
                    now: res && res.now || Date.now()
                };
                pop.refresh();
            });
        }

        // moves a session between the list and the archived ones
        function archiveSession(pop, item, on) {
            setArchived(item.id, on);
            var from = on ? historyData.list : historyData.archived;
            var to = on ? historyData.archived : historyData.list;
            var i = from.indexOf(item);
            if (i != -1) from.splice(i, 1);
            to.push(item);
            to.sort(function(x, y) { return y.mtime - x.mtime; });
            if (!historyData.archived.length) historyView = "list";
            pop.refresh();
        }

        function deleteSession(pop, item) {
            if (!api || historyBusy) return;
            historyBusy = true;
            historyError = "";
            pop.refresh();
            api.deleteSession(item.id, item.account || "", function(err) {
                historyBusy = false;
                if (err) {
                    historyError = err.message || String(err);
                    return pop.refresh();
                }
                historyConfirm = null;
                [historyData.list, historyData.archived].forEach(function(list) {
                    var i = list.indexOf(item);
                    if (i != -1) list.splice(i, 1);
                });
                setArchived(item.id, false);
                // it was the "Resume last session" one
                if (settings.get("state/claude/@session") == item.id) {
                    settings.set("state/claude/@session", "");
                    settings.set("state/claude/@title", "");
                    renderWelcome();
                }
                if (!historyData.archived.length) historyView = "list";
                pop.refresh();
                flashHint("Conversation deleted: " + firstLine(item.title || "", 60), true);
            });
        }

        function buildHistoryPop(pop) {
            if (historyConfirm) return buildDeleteConfirm(pop, historyConfirm);
            var archivedView = historyView == "archived";
            pop.heading(archivedView ? "Archived sessions" : "Sessions");
            if (!api) return pop.info("Not connected to the server");
            if (!historyData || historyData.loading) return pop.info("Loading sessions…");
            if (historyData.error) return pop.info("Could not read the sessions: " + historyData.error);
            var list = (archivedView ? historyData.archived : historyData.list).filter(function(item) {
                return item && UUID_RE.test(item.id || "");
            });
            if (!list.length && !archivedView) pop.info("No Claude Code sessions yet.");
            var named = several();
            list.forEach(function(item) {
                var title = String(item.title || "Untitled");
                var open = item.elsewhere && typeof item.elsewhere == "object";
                var current = item.id == sessionId;
                var folder = typeof item.cwd == "string" ? tildePath(item.cwd) : "";
                var account = accountName(item.account || "");
                var meta = [named ? account : "", folder && shortFolder(item.cwd), relativeTime(item.mtime, historyData.now), open ? "open elsewhere" : ""]
                    .filter(Boolean).join(" · ");
                pop.item({
                    label: title.length > 100 ? title.slice(0, 99) + "…" : title,
                    desc: meta,
                    checked: current,
                    title: title + "\nAccount: " + account + "\n" + (folder ? "Folder: " + folder + "\n" : "")
                        + "Last activity: " + new Date(item.mtime).toLocaleString()
                        + (open ? item.elsewhere.how == "process" ? "\nOpen in another process (e.g. a terminal)"
                            : "\nIt may still be open elsewhere" : ""),
                    onpick: function() {
                        pop.close(true);
                        if (item.id != sessionId) resumeSession(item.id, item);
                    },
                    actions: [
                        archivedView
                            ? { icon: "unarchive", title: "Unarchive", run: function() { archiveSession(pop, item, false); } }
                            : { icon: "archive", title: "Archive (hide from this list)", run: function() { archiveSession(pop, item, true); } },
                        { icon: "trash", title: current ? "This conversation is open in the panel" : open ? "Open in another process" : "Delete…",
                            danger: true, disabled: current || open, run: function() {
                                historyConfirm = item;
                                historyError = "";
                                pop.refresh();
                            } }
                    ]
                });
            });
            if (!archivedView && historyData.more)
                pop.item({ label: "Show older sessions", icon: "down", onpick: function() {
                    historyLimit += HISTORY_PAGE;
                    loadHistory(pop, true);
                } });
            if (archivedView)
                pop.item({ label: "Back to the sessions", icon: "history", onpick: function() {
                    historyView = "list";
                    pop.refresh();
                } });
            else if (historyData.archived.length)
                pop.item({ label: "Show archived (" + historyData.archived.length + ")", icon: "archive", onpick: function() {
                    historyView = "archived";
                    pop.refresh();
                } });
        }

        // "Delete this conversation?" in the menu: Delete or Cancel
        function buildDeleteConfirm(pop, item) {
            pop.heading("Delete this conversation?");
            pop.info(firstLine(item.title || "Untitled", 100));
            pop.el.lastChild.classList.add("claude-pop-title");
            pop.info("Its transcript will be removed from " + ((acctInfo[item.account || ""] || {}).dir || "~/.claude")
                + "/projects. This can't be undone.");
            if (historyError) node(el("div", { className: "claude-pop-error", role: "alert", text: historyError }));
            var cancel = el("button", { type: "button", tabindex: "-1", className: "claude-btn claude-btn-secondary", text: "Cancel" });
            var del = el("button", { type: "button", tabindex: "-1", className: "claude-btn claude-btn-danger", text: historyBusy ? "Deleting…" : "Delete" });
            del.disabled = historyBusy;
            var buttons = [del, cancel];
            var focus = 1;      // Cancel first
            function show() {
                buttons.forEach(function(b, i) { b.classList.toggle("claude-focus", i == focus); });
            }
            function back() {
                historyConfirm = null;
                historyError = "";
                pop.refresh();
            }
            del.addEventListener("click", function(e) {
                e.preventDefault();
                e.stopPropagation();
                deleteSession(pop, item);
            });
            cancel.addEventListener("click", function(e) {
                e.preventDefault();
                e.stopPropagation();
                back();
            });
            show();
            pop.row({
                el: el("div", { className: "claude-pop-buttons" }, buttons),
                checked: true,
                onpick: function() { buttons[focus].click(); },
                onKey: function(e) {
                    if (e.keyCode == 37 || e.keyCode == 39 || e.keyCode == 9) {
                        focus = 1 - focus;
                        show();
                        return true;
                    }
                    if (e.keyCode == 27) {
                        back();
                        return true;
                    }
                    return false;
                }
            });
            function node(n) { pop.el.appendChild(n); }
        }

        function codeSpan(text) {
            return el("code", { className: "claude-inline-code", text: text });
        }

        /***** Paths *****/

        // A path from Claude (absolute, ~/..., or relative to the chat's
        // folder) as an absolute path, or null
        function absolutePath(file) {
            if (!file) return null;
            file = String(file);
            var home = (c9.home || "").replace(/\/$/, "");
            if (/^~\//.test(file)) return home ? home + file.slice(1) : null;
            if (/^\//.test(file)) return file;
            var rel = file.replace(/^\.\//, "");
            if (/(^|\/)\.\.(\/|$)/.test(rel)) return null;
            return currentFolder().replace(/\/$/, "") + "/" + rel;
        }

        // The path the editor opens a file by: in the workspace ("/src/a.js"),
        // in the home folder ("~/notes.md"), or through a link at the top of
        // the workspace to a folder elsewhere (e.g. zoot -> /:
        // "/zoot/var/www/html/index.php"). null: the editor can't open it.
        function workspacePath(file) {
            var abs = absolutePath(file);
            if (!abs) return null;
            var ws = c9.workspaceDir.replace(/\/$/, "");
            if (abs == ws) return "/";
            if (abs.indexOf(ws + "/") === 0)
                return abs.slice(ws.length);
            var home = (c9.home || "").replace(/\/$/, "");
            if (home && abs.indexOf(home + "/") === 0)
                return "~" + abs.slice(home.length);
            // the link with the longest target wins (www -> /var/www over zoot -> /)
            var best = null;
            workspaceLinks().forEach(function(link) {
                var target = String(link.target).replace(/\/$/, "");
                if ((abs == target || abs.indexOf(target + "/") === 0) && (!best || target.length > best.target.length))
                    best = { name: link.name, target: target };
            });
            return best ? "/" + best.name + abs.slice(best.target.length) : null;
        }

        function workspaceLinks() {
            return cliInfo && Array.isArray(cliInfo.links) ? cliInfo.links.filter(function(link) {
                return link && typeof link.name == "string" && typeof link.target == "string"
                    && link.name.indexOf("/") == -1 && /^\//.test(link.target);
            }) : [];
        }

        // relative to the chat's folder, else to the workspace; else "~/..." or absolute
        function displayPath(file) {
            var abs = absolutePath(file);
            if (!abs) return String(file || "");
            var bases = [currentFolder(), c9.workspaceDir];
            for (var i = 0; i < bases.length; i++) {
                var base = String(bases[i] || "").replace(/\/$/, "");
                if (base && abs.indexOf(base + "/") === 0) return abs.slice(base.length + 1);
            }
            return tildePath(abs);
        }

        function fileLink(file, line) {
            var wsPath = workspacePath(file);
            var label = displayPath(file);
            if (!wsPath)
                return el("span", { className: "claude-path", title: String(file), text: label });
            var link = el("a", { className: "claude-file-link claude-path", href: "#", title: "Open " + wsPath, text: label });
            link.setAttribute("data-wspath", wsPath);
            if (line) link.setAttribute("data-line", String(line));
            return link;
        }

        function openFile(wsPath, line) {
            if (!wsPath) return;
            var existing = tabManager.findTab(wsPath);
            var state = { path: wsPath, active: true, focus: true };
            if (line && !existing)
                state.document = { ace: { jump: { row: Math.max(0, line - 1), column: 0 } } };
            tabManager.open(state, function(err, tab) {
                if (err) return showError("Could not open " + wsPath + ": " + (err.message || err));
                if (line && existing && tab && tab.editor && tab.editor.ace) {
                    try {
                        tab.editor.ace.gotoLine(line, 0, false);
                        tab.editor.ace.centerSelection();
                    } catch (e) {}
                }
            });
        }

        function onLogClick(e) {
            var target = e.target;
            while (target && target != logEl) {
                if (target.classList && target.classList.contains("claude-file-link")) {
                    e.preventDefault();
                    var line = parseInt(target.getAttribute("data-line"), 10) || null;
                    // data-wspath: built by the panel; data-path: a link in model output
                    var wsPath = target.getAttribute("data-wspath") || workspacePath(target.getAttribute("data-path"));
                    if (wsPath) openFile(wsPath, line);
                    else flashHint("Only files in the workspace, the home folder or a folder linked at the top of the workspace can be opened");
                    return;
                }
                target = target.parentNode;
            }
        }

        /***** Status *****/

        function updateStatus() {
            if (!drawn) return;
            var text, state;
            var pending = Object.keys(permCards).filter(function(id) { return permCards[id].pending; }).length;
            if (!c9.connected) { text = "Offline"; state = "offline"; }
            else if (!api) { text = connecting ? "Connecting…" : "Not connected"; state = "offline"; }
            else if (cliInfo && !cliInfo.found) { text = "claude not found"; state = "error"; }
            else if (stopping) { text = "Stopping…"; state = "busy"; }
            else if (pending) { text = "Waiting for your approval"; state = "waiting"; }
            else if (busy) { text = taskSummary || "Working…"; state = "busy"; }
            else { text = "Ready"; state = "ready"; }
            statusText.textContent = text;
            statusText.title = text + (sessionId ? "\nSession " + sessionId : "");
            statusText.classList.toggle("claude-summary", busy && !!taskSummary && !pending && !stopping);
            statusDot.className = "claude-status-dot claude-dot-" + state;
            titleEl.textContent = sessionTitle || "New session";
            titleEl.title = (sessionTitle ? sessionTitle + "\n" : "") + "Account: " + accountName(chatAccount)
                + "\nFolder: " + tildePath(chatFolder || workspaceDir());
            titleEl.classList.toggle("claude-untitled", !sessionTitle);
            textarea.placeholder = busy || stopping ? "Queue another message…" : "Ask Claude…";

            btnHistory.disabled = !api;
            btnNew.disabled = !hasMessages && !sessionId;
            renderWhere();

            var showStop = busy || stopping;
            btnSend.innerHTML = "";
            btnSend.appendChild(icon(showStop ? "stop" : "send"));
            btnSend.title = showStop ? "Stop (Esc)" : "Send (Enter)";
            btnSend.classList.toggle("claude-stop", showStop);
            btnSend.disabled = !showStop && !textarea.value.trim() && !attachments.length;
            renderActivity();
        }

        /***** Activity row *****/

        // parts: a string, or an array of strings and { code: "..." }
        // kind: "thinking" shows the token estimate of the thinking block
        function setActivity(parts, kind) {
            activity = { parts: parts || "", kind: kind || "" };
            updateStatus();
        }

        var actShown = null;
        function renderActivity() {
            if (!actEl) return;
            var show = busy || stopping;
            actEl.classList.toggle("claude-show", show);
            if (!show) {
                clearInterval(actTimer);
                actTimer = null;
                actShown = null;
                return;
            }
            if (!actTimer) actTimer = setInterval(tick, 1000);
            var waiting = !stopping && pendingPermissions().length > 0;
            var parts = stopping ? "Stopping…" : waiting ? "Waiting for your approval" : activity.parts || "Working…";
            var key = JSON.stringify(parts);
            if (key != actShown) {
                actShown = key;
                actText.textContent = "";
                [].concat(parts).forEach(function(part) {
                    if (part && typeof part == "object") actText.appendChild(codeSpan(part.code));
                    else actText.appendChild(document.createTextNode(String(part)));
                });
            }
            actEl.title = activity.title || "";
            actEl.classList.toggle("claude-act-waiting", waiting);
            actEl.classList.toggle("claude-act-stopping", stopping);
            renderActivityMeta();
        }

        function renderActivityMeta() {
            if (!actMeta) return;
            var bits = [];
            var tokens = activity.kind == "thinking" && liveThinking ? liveThinking.tokens() : 0;
            if (tokens && !stopping) bits.push(formatTokens(tokens));
            if (turnStart) bits.push(formatElapsed(Date.now() - turnStart));
            actMeta.textContent = bits.join(" · ");
        }

        function tick() {
            if (!busy && !stopping) return renderActivity();
            renderActivityMeta();
        }

        function formatElapsed(ms) {
            var s = Math.max(0, Math.floor(ms / 1000));
            if (s < 60) return s + "s";
            var m = Math.floor(s / 60);
            s -= m * 60;
            return m + "m " + (s < 10 ? "0" : "") + s + "s";
        }

        function formatTokens(n) {
            n = Math.max(0, Math.round(n));
            return n < 1000 ? n + " tokens" : (n / 1000).toFixed(1) + "k tokens";
        }

        // what a tool call does, for the activity row
        function toolActivity(name, input) {
            input = input || {};
            var file = input.file_path || input.notebook_path || input.path || "";
            var base = file ? String(file).replace(/[\/\\]+$/, "").split(/[\/\\]/).pop() : "";
            switch (name) {
                case "Bash":
                    return input.command ? codeActivity("Running ", input.command, 48) : "Running a command…";
                case "Read":
                case "NotebookRead":
                    return base ? "Reading " + base + "…" : "Reading…";
                case "Edit":
                case "MultiEdit":
                case "NotebookEdit":
                    return base ? "Editing " + base + "…" : "Editing…";
                case "Write":
                    return base ? "Writing " + base + "…" : "Writing a file…";
                case "Grep":
                    return input.pattern ? codeActivity("Searching for ", input.pattern, 40) : "Searching…";
                case "Glob":
                    return input.pattern ? codeActivity("Finding ", input.pattern, 40) : "Finding files…";
                case "LS":
                    return "Listing " + (base || "files") + "…";
                case "WebFetch":
                    var host = /^[a-z]+:\/\/([^\/?#]+)/i.exec(input.url || "");
                    return host ? "Fetching " + host[1] + "…" : "Fetching…";
                case "WebSearch":
                    return "Searching the web…";
                case "Task":
                case "Agent":
                    return input.description ? "Agent: " + firstLine(input.description, 50) + "…" : "Starting an agent…";
                case "TodoWrite":
                    return "Updating the to-do list…";
                case "BashOutput":
                    return "Reading command output…";
                case "ExitPlanMode":
                    return "Presenting the plan…";
                case "AskUserQuestion":
                    return "Asking you a question…";
                default:
                    return "Using " + toolInfo(name).verb + "…";
            }
        }

        // "Running `npm test`…"; a long command ends in its own ellipsis
        function codeActivity(prefix, text, max) {
            var code = firstLine(text, max);
            return [prefix, { code: code }].concat(/…$/.test(code) ? [] : ["…"]);
        }

        // the tool cards of this turn that wait for their result
        function toolStarted(card) {
            if (liveTools.indexOf(card) == -1) liveTools.push(card);
        }

        function toolEnded(card) {
            var i = liveTools.indexOf(card);
            if (i != -1) liveTools.splice(i, 1);
            if (!busy) return;
            var last = liveTools[liveTools.length - 1];
            if (last) setActivity(toolActivity(last.name, last.input));
            // the result goes back to the model
            else setActivity("Thinking…", "thinking");
        }

        function debugOn() {
            try { return !!window.localStorage.getItem("claude-debug"); } catch (e) { return false; }
        }

        var debugLast = 0;
        function debugLog(events) {
            var now = Date.now();
            var from = turnStart || now;
            console.log("[claude] +" + (now - from) + "ms (" + (debugLast ? now - debugLast : 0) + "ms since the last) "
                + events.length + " event(s): " + events.map(function(event) {
                    var d = event && event.data || {};
                    if (!event || event.ev != "msg") return event && event.ev;
                    var what = d.type + (d.subtype ? "/" + d.subtype : "");
                    var e = d.type == "stream_event" && d.event;
                    if (e) what = e.type + (e.delta ? ":" + e.delta.type : e.content_block ? ":" + e.content_block.type : "");
                    return what;
                }).join(", "));
            debugLast = now;
        }

        /***** Welcome screen *****/

        function renderWelcome() {
            if (!drawn) return;
            welcomeEl.textContent = "";
            welcomeEl.style.display = hasMessages ? "none" : "";
            if (hasMessages) return;

            welcomeEl.appendChild(icon("spark", "claude-welcome-icon"));
            welcomeEl.appendChild(el("div", { className: "claude-welcome-title", text: "Claude Code" }));
            welcomeEl.appendChild(el("div", { className: "claude-welcome-text",
                text: "Ask Claude to explain, find or change code in this workspace. "
                    + "It runs your claude CLI on the server, with your login, settings, CLAUDE.md and MCP servers." }));

            if (cliInfo && !cliInfo.found) {
                welcomeEl.appendChild(notFoundBox());
            }
            else {
                var saved = settings.get("state/claude/@session");
                if (UUID_RE.test(saved || "") && saved != sessionId) {
                    var title = settings.get("state/claude/@title");
                    var resume = textButton("Resume last session", "claude-btn-secondary claude-resume-btn", function() {
                        resumeSession(saved, { account: settings.get("state/claude/@sessionAccount") || "" });
                    }, saved);
                    welcomeEl.appendChild(el("div", { className: "claude-welcome-resume" }, [
                        resume,
                        title ? el("div", { className: "claude-welcome-last", text: "“" + title + "”" }) : null
                    ]));
                }
                welcomeEl.appendChild(el("ul", { className: "claude-welcome-tips" }, [
                    el("li", { text: "Paste, drop or attach images" }),
                    el("li", { text: "Click a file name to open it in the editor" }),
                    el("li", { text: "Enter sends, Shift+Enter adds a new line, Esc stops" })
                ]));
            }
            if (cliInfo && cliInfo.found) {
                welcomeEl.appendChild(el("div", { className: "claude-welcome-version",
                    text: (cliInfo.version || "claude") + " · " + cliInfo.path }));
            }
        }

        function notFoundBox() {
            var custom = settings.get("user/claude/@path");
            var lines = [
                el("div", { className: "claude-error-title", text: custom
                    ? "claude was not found at " + custom
                    : "The claude CLI was not found on this server" }),
                el("div", { text: INSTALL_HELP }),
                el("div", { text: "If it is installed in another place, set its full path in Preferences › User Settings › Claude." })
            ];
            if (cliInfo && cliInfo.error)
                lines.push(el("div", { text: cliInfo.error }));
            if (cliInfo && cliInfo.tried && cliInfo.tried.length) {
                lines.push(el("details", { className: "claude-tried" }, [
                    el("summary", { text: "Places searched" }),
                    el("pre", { text: cliInfo.tried.join("\n") })
                ]));
            }
            var retry = textButton("Check again", "claude-btn-secondary", function() {
                refreshStatus();
            });
            lines.push(el("div", { className: "claude-actions" }, [retry]));
            return el("div", { className: "claude-error claude-notfound" }, lines);
        }

        /***** Scrolling *****/

        var scrollPending = false;
        function scrollToEnd(force) {
            if (!autoScroll && !force) {
                jumpBtn.classList.add("claude-show");
                return;
            }
            if (scrollPending) return;
            scrollPending = true;
            requestAnimationFrame(function() {
                scrollPending = false;
                logEl.scrollTop = logEl.scrollHeight;
                jumpBtn.classList.remove("claude-show");
            });
        }

        function appendToLog(node) {
            if (!hasMessages) {
                hasMessages = true;
                renderWelcome();
            }
            logEl.appendChild(node);
            scrollToEnd();
            return node;
        }

        /***** Messages *****/

        function showError(message, details) {
            if (!drawn) return console.error("[claude]", message);
            var box = el("div", { className: "claude-error" }, [
                icon("error", "claude-error-icon"),
                el("div", { className: "claude-error-body" }, [
                    el("div", { text: message }),
                    details ? el("pre", { className: "claude-error-details", text: details }) : null
                ])
            ]);
            appendTo(box);
            return box;
        }

        function showLoginHelp() {
            var box = el("div", { className: "claude-error" }, [
                icon("error", "claude-error-icon"),
                el("div", { className: "claude-error-body" }, [
                    el("div", { className: "claude-error-title", text: "Claude Code is not logged in" }),
                    el("div", { text: "Open a terminal (Window › New Terminal), run claude once and log in, then send your message again." })
                ])
            ]);
            appendTo(box);
        }

        function showBillingHelp(text) {
            var box = el("div", { className: "claude-error" }, [
                icon("error", "claude-error-icon"),
                el("div", { className: "claude-error-body" }, [
                    el("div", { className: "claude-error-title", text: "Claude Code reports a billing problem" }),
                    el("div", { text: firstLine(text, 300) }),
                    el("div", { text: "Check your Claude plan or your API credits, then send your message again." })
                ])
            ]);
            appendTo(box);
        }

        function showNotice(text, className) {
            return appendTo(el("div", { className: "claude-notice " + (className || ""), text: text }));
        }

        function appendTo(node) {
            if (turn && turn.el.parentNode) {
                turn.el.appendChild(node);
                scrollToEnd();
                return node;
            }
            return appendToLog(node);
        }

        function renderUserMessage(text, imgs, queued, inTurn) {
            var thumbs = (imgs || []).map(function(image) {
                if (image.omitted)
                    return el("span", { className: "claude-user-image claude-image-omitted" }, [icon("image")]);
                var img = el("img", { alt: image.name || "image", title: (image.name || "image")
                    + (image.width ? " · " + image.width + "×" + image.height : "") });
                img.src = "data:" + image.mediaType + ";base64," + image.data;
                return el("span", { className: "claude-user-image" }, [img]);
            });
            var node = el("div", { className: "claude-user" + (queued ? " claude-queued" : "") }, [
                thumbs.length ? el("div", { className: "claude-user-images" }, thumbs) : null,
                text ? el("div", { className: "claude-user-text", text: text }) : null
            ]);
            // inTurn: said during a turn (answer to a prompt): Claude's reply follows it
            if (inTurn) appendTo(node);
            else appendToLog(node);
            return node;
        }

        function startTurn() {
            finishTurn();
            turn = {
                el: el("div", { className: "claude-turn" }),
                start: Date.now(),
                msgs: {},
                current: null
            };
            appendToLog(turn.el);
            return turn;
        }

        // fromHistory: tool calls without a result are not marked stopped
        function finishTurn(fromHistory) {
            liveTools = [];
            if (!turn) return;
            Object.keys(turn.msgs).forEach(function(id) {
                var msg = turn.msgs[id];
                msg.textBlocks.concat(msg.thinkingBlocks).forEach(function(block) { block.finish(); });
            });
            Object.keys(toolCards).forEach(function(id) {
                var card = toolCards[id];
                if (card.status == "running" || card.status == "waiting")
                    card.setStatus(fromHistory ? "none" : "stopped");
            });
            Object.keys(permCards).forEach(function(id) {
                if (permCards[id].pending) permCards[id].resolve("cancelled");
            });
            turn = null;
        }

        function ensureTurn() {
            return turn || startTurn();
        }

        function getMsg(id) {
            var t = ensureTurn();
            id = id || "_";
            if (!t.msgs[id])
                t.msgs[id] = { id: id, streamed: false, textBlocks: [], thinkingBlocks: [], textDone: 0, thinkingDone: 0, byIndex: {} };
            return t.msgs[id];
        }

        /***** Text and thinking blocks *****/

        function createTextBlock() {
            var t = ensureTurn();
            var node = el("div", { className: "claude-md claude-assistant" });
            t.el.appendChild(node);
            var block = { el: node, text: "", done: false, timer: null };
            block.append = function(text) {
                block.text += text;
                schedule();
            };
            block.setText = function(text) {
                if (text === block.text) return;
                block.text = text;
                schedule();
            };
            block.finish = function() {
                if (block.done) return;
                block.done = true;
                clearTimeout(block.timer);
                block.timer = null;
                renderNow(true);
            };
            function schedule() {
                if (block.timer) return;
                block.timer = setTimeout(function() {
                    block.timer = null;
                    renderNow(block.done);
                }, RENDER_DELAY);
            }
            function renderNow(final) {
                var codes = markdown.render(block.text, node, true);
                decorateCode(codes, final);
                node.classList.toggle("claude-streaming", !final);
                scrollToEnd();
            }
            return block;
        }

        // live: streamed now. Hidden while it runs (the activity row says
        // "Thinking… 1.2k tokens"); then "Thought for 6s" (timed here, from
        // its start to its end; not shown after a pause of more than 30 s,
        // e.g. a sleeping laptop). From the history: "Thinking". Its text,
        // when the CLI passes it on (often it is empty or redacted), can be
        // expanded.
        function createThinkingBlock(live) {
            var t = ensureTurn();
            var body = el("div", { className: "claude-thinking-body" });
            var label = el("span", { className: "claude-thinking-label", text: live ? "Thinking…" : "Thinking" });
            var card = el("div", { className: "claude-thinking" + (live ? " claude-live" : "") });
            var head = el("div", { className: "claude-thinking-head" }, [
                icon("thinking", "claude-thinking-icon"), label, icon("chevron", "claude-chevron")
            ]);
            head.addEventListener("click", function() {
                if (block.text.trim()) card.classList.toggle("claude-expanded");
            });
            card.appendChild(head);
            card.appendChild(body);
            t.el.appendChild(card);
            var now = Date.now();
            var block = { el: card, text: "", done: false, start: now, last: now, maxGap: 0,
                deltaTokens: 0, absTokens: null };
            function touch() {
                var at = Date.now();
                block.maxGap = Math.max(block.maxGap, at - block.last);
                block.last = at;
            }
            block.append = function(text) {
                touch();
                if (!text) return;
                block.text += text;
                update();
            };
            block.setText = function(text) {
                block.text = text || block.text;
                update();
            };
            // the estimate of a thinking_delta is an increment
            block.addTokens = function(n) {
                if (typeof n == "number" && n > 0) block.deltaTokens += n;
                showTokens();
            };
            // thinking_tokens: the total so far; it wins once seen
            block.setTokens = function(n) {
                touch();
                if (typeof n == "number" && n >= 0) block.absTokens = n;
                showTokens();
            };
            block.tokens = function() {
                return block.absTokens != null ? block.absTokens : block.deltaTokens;
            };
            block.finish = function() {
                if (block.done) return;
                block.done = true;
                if (liveThinking === block) liveThinking = null;
                if (!live) return;
                touch();
                card.classList.remove("claude-live");
                scrollToEnd();
                var secs = Math.max(1, Math.round((Date.now() - block.start) / 1000));
                label.textContent = block.maxGap > THINKING_GAP ? "Thinking"
                    : "Thought for " + (secs < 60 ? secs + "s" : formatElapsed(secs * 1000));
                if (block.tokens()) head.title = "About " + formatTokens(block.tokens());
            };
            function showTokens() {
                if (!block.done && liveThinking === block) renderActivityMeta();
            }
            function update() {
                if (!block.text.trim()) return;
                card.classList.add("claude-has-text");
                body.textContent = block.text;
            }
            if (live) {
                if (liveThinking) liveThinking.finish();
                liveThinking = block;
                setActivity("Thinking…", "thinking");
            }
            return block;
        }

        function decorateCode(codes, final) {
            codes.forEach(function(code) {
                var pre = code.parentNode;
                if (!pre || pre.parentNode && pre.parentNode.classList.contains("claude-code")) return;
                var lang = markdown.languageOf(code);
                var wrap = el("div", { className: "claude-code" });
                pre.parentNode.insertBefore(wrap, pre);
                var copy = iconButton("copy", "Copy", function() {
                    copyText(code.textContent, copy);
                });
                wrap.appendChild(el("div", { className: "claude-code-head" }, [
                    el("span", { className: "claude-code-lang", text: lang || "" }),
                    copy
                ]));
                wrap.appendChild(pre);
                pre.className = codeThemeClass();
                if (final) markdown.highlight(code, lang);
            });
        }

        function codeThemeClass() {
            var theme = aceHandle.theme;
            return "claude-pre " + (theme && theme.cssClass || "");
        }

        function updateCodeTheme() {
            if (!drawn) return;
            [].forEach.call(logEl.querySelectorAll("pre.claude-pre"), function(pre) {
                pre.className = codeThemeClass();
            });
        }

        // code in the panel uses the editor's font
        function updateCodeFont() {
            if (!root) return;
            var font = settings.get("user/ace/@fontFamily");
            if (font && /^[\w\s,"'\-.]+$/.test(font))
                root.style.setProperty("--claude-mono", font + ", monospace");
        }

        function copyText(text, button) {
            function done() {
                if (!button) return;
                button.classList.add("claude-copied");
                button.innerHTML = "";
                button.appendChild(icon("check"));
                setTimeout(function() {
                    button.classList.remove("claude-copied");
                    button.innerHTML = "";
                    button.appendChild(icon("copy"));
                }, 1200);
            }
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(done, fallback);
            }
            else fallback();
            function fallback() {
                var area = el("textarea", { className: "claude-copy-area" });
                area.value = text;
                document.body.appendChild(area);
                area.select();
                try { document.execCommand("copy"); done(); } catch (e) {}
                document.body.removeChild(area);
            }
        }

        /***** Tool cards *****/

        var TOOL_INFO = {
            Read: { icon: "file", verb: "Read", done: "Read" },
            Write: { icon: "edit", verb: "Write", done: "Wrote" },
            Edit: { icon: "edit", verb: "Edit", done: "Edited" },
            MultiEdit: { icon: "edit", verb: "Edit", done: "Edited" },
            NotebookEdit: { icon: "edit", verb: "Edit notebook", done: "Edited notebook" },
            NotebookRead: { icon: "file", verb: "Read notebook", done: "Read notebook" },
            Bash: { icon: "terminal", verb: "Run", done: "Ran" },
            BashOutput: { icon: "terminal", verb: "Read output", done: "Read output" },
            KillShell: { icon: "terminal", verb: "Stop shell", done: "Stopped shell" },
            Grep: { icon: "search", verb: "Search", done: "Searched" },
            Glob: { icon: "search", verb: "Find files", done: "Found files" },
            LS: { icon: "file", verb: "List", done: "Listed" },
            WebFetch: { icon: "globe", verb: "Fetch", done: "Fetched" },
            WebSearch: { icon: "globe", verb: "Search the web", done: "Searched the web" },
            Task: { icon: "agent", verb: "Agent", done: "Agent" },
            Agent: { icon: "agent", verb: "Agent", done: "Agent" },
            TodoWrite: { icon: "list", verb: "Update todos", done: "Updated todos" },
            ExitPlanMode: { icon: "plan", verb: "Plan", done: "Plan" },
            AskUserQuestion: { icon: "question", verb: "Question", done: "Asked" },
            Skill: { icon: "tool", verb: "Skill", done: "Used skill" }
        };

        function toolInfo(name) {
            if (TOOL_INFO[name]) return TOOL_INFO[name];
            var m = /^mcp__(.+?)__(.+)$/.exec(name || "");
            var label = m ? m[1] + " · " + m[2] : String(name || "Tool");
            return { icon: "tool", verb: label, done: label };
        }

        function firstLine(text, max) {
            text = String(text == null ? "" : text).trim().split("\n")[0];
            max = max || 80;
            return text.length > max ? text.slice(0, max - 1) + "…" : text;
        }

        // the target shown after the verb
        function toolTarget(name, input) {
            input = input || {};
            switch (name) {
                case "Read":
                case "Write":
                case "Edit":
                case "MultiEdit":
                case "NotebookRead":
                    if (!input.file_path) return null;
                    return fileLink(input.file_path, name == "Read" && input.offset ? input.offset : null);
                case "NotebookEdit":
                    return input.notebook_path ? fileLink(input.notebook_path) : null;
                case "LS":
                    return input.path ? fileLink(input.path) : null;
                case "Bash":
                    return input.command ? codeSpan(firstLine(input.command, 120)) : null;
                case "Grep":
                case "Glob":
                    return input.pattern ? codeSpan(firstLine(input.pattern, 80)) : null;
                case "WebFetch":
                    return input.url ? el("span", { className: "claude-path", text: firstLine(input.url, 100) }) : null;
                case "WebSearch":
                    return input.query ? codeSpan(firstLine(input.query, 80)) : null;
                case "Task":
                case "Agent":
                    return input.description ? el("span", { text: firstLine(input.description, 80) }) : null;
                case "Skill":
                    return input.skill || input.command ? codeSpan(firstLine(input.skill || input.command, 60)) : null;
                case "AskUserQuestion":
                    var q = input.questions && input.questions[0];
                    return q ? el("span", { text: firstLine(q.question, 80) }) : null;
                default:
                    return null;
            }
        }

        function toolMeta(name, input) {
            input = input || {};
            if (name == "Edit") {
                var s = diff.stats(diff.lines(input.old_string, input.new_string));
                return diffStatsEl(s);
            }
            if (name == "MultiEdit" && Array.isArray(input.edits)) {
                var total = { added: 0, removed: 0 };
                input.edits.forEach(function(edit) {
                    var st = diff.stats(diff.lines(edit.old_string, edit.new_string));
                    total.added += st.added;
                    total.removed += st.removed;
                });
                return diffStatsEl(total);
            }
            if (name == "Write" && typeof input.content == "string") {
                var n = input.content ? input.content.replace(/\n$/, "").split("\n").length : 0;
                return el("span", { className: "claude-tool-meta", text: n + (n == 1 ? " line" : " lines") });
            }
            if (name == "Read" && (input.offset || input.limit)) {
                var from = input.offset || 1;
                return el("span", { className: "claude-tool-meta", text: input.limit
                    ? "lines " + from + "–" + (from + input.limit - 1) : "from line " + from });
            }
            if (name == "Grep" && (input.path || input.glob)) {
                return el("span", { className: "claude-tool-meta", text: "in " + displayPath(input.path || input.glob) });
            }
            if ((name == "Task" || name == "Agent") && input.subagent_type) {
                return el("span", { className: "claude-tool-meta", text: input.subagent_type });
            }
            return null;
        }

        function diffStatsEl(s) {
            return el("span", { className: "claude-tool-meta claude-diffstat" }, [
                el("span", { className: "claude-added", text: "+" + s.added }),
                " ",
                el("span", { className: "claude-removed", text: "−" + s.removed })
            ]);
        }

        function diffView(oldText, newText, path) {
            var lines = diff.collapse(diff.lines(oldText, newText), 3);
            var box = el("div", { className: "claude-diff" });
            lines.forEach(function(line) {
                if (line.type == "...") {
                    box.appendChild(el("div", { className: "claude-diff-skip",
                        text: "⋯ " + line.count + (line.count == 1 ? " unchanged line" : " unchanged lines") }));
                    return;
                }
                var cls = line.type == "+" ? "claude-diff-add" : line.type == "-" ? "claude-diff-del" : "claude-diff-ctx";
                box.appendChild(el("div", { className: "claude-diff-line " + cls }, [
                    el("span", { className: "claude-diff-sign", text: line.type == " " ? " " : line.type == "-" ? "−" : "+" }),
                    el("span", { className: "claude-diff-text", text: line.text || " " })
                ]));
            });
            return box;
        }

        // wrap: long lines wrap (commands) instead of scrolling
        function codePreview(text, path, maxLines, wrap) {
            text = String(text == null ? "" : text);
            var lines = text.split("\n");
            var more = 0;
            if (maxLines && lines.length > maxLines) {
                more = lines.length - maxLines;
                text = lines.slice(0, maxLines).join("\n");
            }
            var code = el("code", { text: text });
            var pre = el("pre", { className: codeThemeClass() }, [code]);
            var box = el("div", { className: "claude-code claude-code-plain" + (wrap ? " claude-code-wrap" : "") }, [pre]);
            if (more)
                box.appendChild(el("div", { className: "claude-code-more", text: "… " + more + " more lines" }));
            var lang = path ? String(path).split(/[\/\\]/).pop().split(".").pop() : "";
            if (path && /\./.test(String(path).split(/[\/\\]/).pop()))
                markdown.highlight(code, lang);
            return box;
        }

        function outputBlock(text, isError) {
            var pre = el("pre", { className: "claude-output" + (isError ? " claude-output-error" : ""), text: text });
            return pre;
        }

        function resultText(content) {
            if (typeof content == "string") return content;
            if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content, null, 2);
            return content.map(function(part) {
                if (!part) return "";
                if (part.type == "text") return part.text;
                if (part.type == "image") return "[image]";
                return JSON.stringify(part);
            }).join("\n");
        }

        function jsonPreview(value) {
            var text;
            try { text = JSON.stringify(value, null, 2); } catch (e) { text = String(value); }
            if (text && text.length > 6000) text = text.slice(0, 6000) + "\n…";
            return el("pre", { className: "claude-output", text: text || "" });
        }

        // the body of a tool card or a permission prompt for a tool input
        function inputPreview(name, input, forPermission) {
            input = input || {};
            switch (name) {
                case "Edit":
                    return diffView(input.old_string, input.new_string, input.file_path);
                case "MultiEdit":
                    var box = el("div");
                    (input.edits || []).forEach(function(edit) {
                        box.appendChild(diffView(edit.old_string, edit.new_string, input.file_path));
                    });
                    return box;
                case "Write":
                    return codePreview(input.content, input.file_path, PREVIEW_LINES);
                case "Bash":
                    var parts = [];
                    if (input.description)
                        parts.push(el("div", { className: "claude-tool-desc", text: input.description }));
                    parts.push(codePreview(input.command, "command.sh", 40, true));
                    return el("div", null, parts);
                case "NotebookEdit":
                    return codePreview(input.new_source, input.cell_type == "markdown" ? "cell.md" : "cell.py", PREVIEW_LINES);
                case "ExitPlanMode":
                    var plan = el("div", { className: "claude-md claude-plan" });
                    decorateCode(markdown.render(input.plan || "", plan, true), true);
                    return plan;
                case "TodoWrite":
                    return todoList(input.todos);
                case "Task":
                case "Agent":
                    return forPermission && input.prompt ? el("div", { className: "claude-tool-desc", text: firstLine(input.prompt, 400) }) : null;
                case "Read":
                case "Glob":
                case "Grep":
                case "LS":
                case "WebSearch":
                    return forPermission ? jsonPreview(input) : null;
                case "WebFetch":
                    return input.prompt ? el("div", { className: "claude-tool-desc", text: input.prompt }) : null;
                default:
                    return jsonPreview(input);
            }
        }

        function todoList(todos) {
            var list = el("ul", { className: "claude-todos" });
            (todos || []).forEach(function(todo) {
                var status = todo && todo.status || "pending";
                list.appendChild(el("li", { className: "claude-todo claude-todo-" + status }, [
                    el("span", { className: "claude-todo-box" }),
                    el("span", { text: todo && (status == "in_progress" && todo.activeForm || todo.content) || "" })
                ]));
            });
            return list;
        }

        var EXPANDED_BY_DEFAULT = { Edit: 1, MultiEdit: 1, Write: 1, TodoWrite: 1, ExitPlanMode: 1, NotebookEdit: 1 };

        function ensureToolCard(id, name, parent) {
            if (id && toolCards[id]) return toolCards[id];
            var card = createToolCard(id, name);
            if (id) toolCards[id] = card;
            (parent || ensureTurn().el).appendChild(card.el);
            scrollToEnd();
            return card;
        }

        function createToolCard(id, name) {
            var info = toolInfo(name);
            var node = el("div", { className: "claude-tool claude-st-running" });
            var statusEl = el("span", { className: "claude-tool-status" });
            var titleEl = el("span", { className: "claude-tool-title" });
            var head = el("div", { className: "claude-tool-head", title: name }, [
                icon(info.icon, "claude-tool-icon"),
                titleEl,
                statusEl,
                icon("chevron", "claude-chevron")
            ]);
            var body = el("div", { className: "claude-tool-body" });
            var inputEl = el("div", { className: "claude-tool-input" });
            var resultEl = el("div", { className: "claude-tool-result" });
            var subEl = el("div", { className: "claude-subagent" });
            body.appendChild(inputEl);
            body.appendChild(subEl);
            body.appendChild(resultEl);
            node.appendChild(head);
            node.appendChild(body);

            var card = {
                id: id,
                name: name,
                el: node,
                input: null,
                status: "running",
                subCount: 0
            };
            head.addEventListener("click", function(e) {
                if (e.target.closest && e.target.closest("a")) return;
                card.toggle();
            });
            card.toggle = function(open) {
                if (open == null) open = !node.classList.contains("claude-expanded");
                node.classList.toggle("claude-expanded", !!open);
            };
            card.updateTitle = function() {
                titleEl.textContent = "";
                var done = card.status == "ok";
                titleEl.appendChild(el("span", { className: "claude-tool-verb", text: done ? info.done : info.verb }));
                var target = toolTarget(name, card.input);
                if (target) {
                    titleEl.appendChild(document.createTextNode(" "));
                    titleEl.appendChild(target);
                }
                var meta = toolMeta(name, card.input);
                if (meta) {
                    titleEl.appendChild(document.createTextNode(" "));
                    titleEl.appendChild(meta);
                }
            };
            card.setInput = function(input) {
                card.input = input || {};
                card.updateTitle();
                inputEl.textContent = "";
                var preview = inputPreview(name, card.input, false);
                if (preview) inputEl.appendChild(preview);
                node.classList.toggle("claude-has-body", !!preview || !!resultEl.firstChild || !!subEl.firstChild);
                if (EXPANDED_BY_DEFAULT[name] && preview && !card.userToggled)
                    card.toggle(true);
            };
            // running, waiting (for a permission), ok, error, denied,
            // stopped, none (no result in a resumed session)
            card.setStatus = function(status) {
                card.status = status;
                node.className = node.className.replace(/\s*\bclaude-st-\w+/g, "") + " claude-st-" + status;
                statusEl.textContent = "";
                if (status == "running") statusEl.appendChild(el("span", { className: "claude-spinner", title: "Running" }));
                else if (status == "error") statusEl.appendChild(icon("error"));
                else if (status == "denied") statusEl.textContent = "Denied";
                else if (status == "stopped") statusEl.textContent = "Stopped";
                else if (status == "waiting") statusEl.textContent = name == "AskUserQuestion" ? "Needs an answer" : "Needs approval";
                card.updateTitle();
            };
            card.setResult = function(content, isError) {
                var text = resultText(content);
                if (isError) text = text.replace(/^\s*<tool_use_error>([\s\S]*)<\/tool_use_error>\s*$/, "$1");
                var status = !isError ? "ok"
                    : card.status == "denied" || /^(The user (denied|stopped|doesn't want)|The session was stopped)/i.test(text) ? "denied"
                    : "error";
                card.setStatus(status);
                resultEl.textContent = "";
                var show = status == "error" || status == "ok" && !/^(Edit|MultiEdit|Write|NotebookEdit|TodoWrite|ExitPlanMode)$/.test(name);
                if (show && text) {
                    if (name == "AskUserQuestion" && !isError)
                        resultEl.appendChild(el("div", { className: "claude-tool-desc", text: text }));
                    else
                        resultEl.appendChild(outputBlock(text, isError));
                }
                node.classList.toggle("claude-has-body", !!inputEl.firstChild || !!resultEl.firstChild || !!subEl.firstChild);
                if (isError && card.status == "error") card.toggle(true);
            };
            card.addSubagentStep = function(block) {
                card.subCount++;
                var sub = toolInfo(block.name);
                var line = el("div", { className: "claude-subagent-step" }, [
                    icon(sub.icon, "claude-tool-icon"),
                    el("span", { className: "claude-tool-verb", text: sub.verb }),
                    " "
                ]);
                var target = toolTarget(block.name, block.input);
                if (target) line.appendChild(target);
                subEl.appendChild(line);
                while (subEl.childNodes.length > 50) subEl.removeChild(subEl.firstChild);
                node.classList.add("claude-has-body");
                if (busy && card.status == "running")
                    setActivity(["Agent: "].concat(toolActivity(block.name, block.input)));
            };
            card.setStatus("running");
            return card;
        }

        /***** Permission prompts *****/

        function suggestionLabel(suggestions) {
            if (!Array.isArray(suggestions) || !suggestions.length) return null;
            var s = suggestions[0] || {};
            if (s.type == "setMode") {
                if (s.mode == "acceptEdits") return "Allow all edits this session";
                if (s.mode == "bypassPermissions") return "Allow everything this session";
                return "Switch to " + s.mode + " mode";
            }
            if ((s.type == "addRules" || s.type == "replaceRules") && Array.isArray(s.rules) && s.rules.length) {
                var rule = s.rules[0];
                var text = rule.toolName + (rule.ruleContent ? "(" + rule.ruleContent + ")" : "");
                var where = s.destination == "session" ? " this session"
                    : s.destination == "localSettings" || s.destination == "projectSettings" ? " in this project"
                    : s.destination == "userSettings" ? " everywhere" : "";
                return "Always allow " + firstLine(text, 50) + where;
            }
            if (s.type == "addDirectories" && Array.isArray(s.directories))
                return "Allow access to " + firstLine(s.directories.join(", "), 40);
            return "Allow and remember";
        }

        function rememberedText(suggestions, label) {
            var s = suggestions && suggestions[0] || {};
            if (s.type == "setMode" && s.mode == "acceptEdits")
                return "Edits are accepted without asking for the rest of this session";
            return (label || "Allowed") + " (remembered)";
        }

        function permissionTitle(name, input, displayName) {
            input = input || {};
            var target = toolTarget(name, input);
            var verb;
            switch (name) {
                case "Bash": return [el("span", { text: "Allow Claude to run this command?" })];
                case "Write": verb = "write"; break;
                case "Edit":
                case "MultiEdit":
                case "NotebookEdit": verb = "edit"; break;
                case "Read":
                case "NotebookRead": verb = "read"; break;
                case "WebFetch": verb = "fetch"; break;
                case "WebSearch": verb = "search the web for"; break;
                case "ExitPlanMode": return [el("span", { text: "Claude has a plan. Start working on it?" })];
                case "AskUserQuestion": return [el("span", { text: "Claude has a question" })];
                default:
                    return [el("span", { text: "Allow Claude to use " }), codeSpan(displayName || name), el("span", { text: "?" })];
            }
            var parts = [el("span", { text: "Allow Claude to " + verb + " " })];
            if (target) parts.push(target);
            parts.push(el("span", { text: "?" }));
            return parts;
        }

        // Permission requests wait in order; the first one takes the place of
        // the input box ("1 of 2" when more wait). The tool card in the
        // conversation says "Needs approval", then shows the outcome.
        var promptQueue = [];
        var promptShown = null;

        function showPermission(message) {
            var id = message.request_id;
            var req = message.request || {};
            if (!id || permCards[id]) return;
            var toolCard = req.tool_use_id && toolCards[req.tool_use_id];
            if (toolCard) {
                toolCard.setStatus("waiting");
                // the prompt shows the preview: not twice
                toolCard.toggle(false);
            }
            var card = { id: id, req: req, name: req.tool_name, input: req.input || {}, toolCard: toolCard, pending: true };
            card.resolve = function(how) {
                if (!card.pending) return;
                card.pending = false;
                var tc = card.toolCard;
                if (tc) {
                    if (how == "allow" || how == "allowAlways") {
                        tc.setStatus("running");
                        if (EXPANDED_BY_DEFAULT[card.name]) tc.toggle(true);
                    }
                    else if (how == "deny" || how == "stopped") tc.setStatus("denied");
                }
                // what is worth keeping in the conversation
                var text = null;
                if (how == "allowAlways")
                    text = rememberedText(req.permission_suggestions, suggestionLabel(req.permission_suggestions));
                else if (how == "expired")
                    text = "This request is no longer pending";
                else if (!tc && how != "cancelled")
                    text = ({ allow: card.name == "AskUserQuestion" ? "Answered" : "Allowed",
                        deny: card.name == "AskUserQuestion" ? "Skipped" : "Denied", stopped: "Denied (stopped)" }[how] || how)
                        + ": " + promptTitleText(card);
                if (text) {
                    var note = el("div", { className: "claude-notice claude-notice-quiet", text: text });
                    if (tc && tc.el.parentNode) tc.el.parentNode.insertBefore(note, tc.el.nextSibling);
                    else appendTo(note);
                }
                renderPrompt();
                updateStatus();
            };
            permCards[id] = card;
            promptQueue.push(card);
            renderPrompt();
            updateStatus();
            autoScroll = true;
            scrollToEnd(true);
        }

        function promptTitleText(card) {
            return el("span", null, permissionTitle(card.name, card.input, card.req.display_name)).textContent;
        }

        // shows the first waiting request, or the input box again
        function renderPrompt() {
            promptQueue = promptQueue.filter(function(card) { return card.pending; });
            var focusHere = !document.activeElement || document.activeElement == document.body
                || root.contains(document.activeElement);
            if (promptShown && promptShown.pending) {
                promptShown.count(promptQueue.length);
                return;
            }
            promptShown = promptQueue[0] || null;
            promptSlot.textContent = "";
            root.classList.toggle("claude-prompting", !!promptShown);
            if (!promptShown) {
                promptSlot.style.display = "none";
                composerBox.style.display = "";
                if (focusHere) textarea.focus();
                return;
            }
            closePops();
            promptSlot.style.display = "";
            composerBox.style.display = "none";
            promptSlot.appendChild(buildPrompt(promptShown));
            promptShown.count(promptQueue.length);
            if (focusHere) promptShown.focus();
        }

        // The prompt: the question, a preview that folds, numbered choices
        // (1 Yes, 2 Yes and remember, 3 No; keys 1-3, Up/Down and Enter), a
        // note for Claude (Enter: deny and go on with the note), Esc to deny.
        function buildPrompt(card) {
            var name = card.name, input = card.input, req = card.req;
            var shownAt = Date.now();
            var answers = {};
            var question = name == "AskUserQuestion";
            var plan = name == "ExitPlanMode";
            var countEl = el("span", { className: "claude-prompt-count" });
            var node = el("div", { className: "claude-prompt", role: "group" });
            var titleId = "claude-prompt-title-" + (++popIds);
            node.setAttribute("aria-labelledby", titleId);
            var head = el("div", { className: "claude-prompt-head" }, [
                icon(question ? "question" : plan ? "plan" : "shield", "claude-prompt-icon"),
                el("span", { className: "claude-prompt-title", id: titleId }, permissionTitle(name, input, req.display_name)),
                countEl
            ]);
            node.appendChild(head);

            var desc = req.description && !question && req.description != input.file_path
                && !(name == "Write" || name == "Edit" || name == "MultiEdit") ? req.description : null;
            if (name == "Bash" && input.description) desc = input.description;
            if (desc) node.appendChild(el("div", { className: "claude-prompt-desc", text: desc }));
            if (req.decision_reason && typeof req.decision_reason == "string")
                node.appendChild(el("div", { className: "claude-prompt-desc", text: req.decision_reason }));
            if (req.blocked_path)
                node.appendChild(el("div", { className: "claude-prompt-desc" }, ["Path: ", fileLink(req.blocked_path)]));

            if (question) {
                node.appendChild(el("div", { className: "claude-prompt-body" },
                    [questionForm(input.questions || [], answers, function() { decide("allow"); })]));
            }
            else {
                // all of a command: it is what gets run (the body scrolls)
                var preview = name == "Bash"
                    ? codePreview(input.command, "command.sh", 0, true)
                    : inputPreview(name, input, true);
                if (preview) {
                    var body = el("div", { className: "claude-prompt-body" }, [preview]);
                    var toggle = el("button", { type: "button", className: "claude-prompt-toggle", "aria-expanded": "true",
                        title: "Hide the details" }, [icon("chevron")]);
                    toggle.addEventListener("click", function(e) {
                        e.preventDefault();
                        var hidden = node.classList.toggle("claude-folded");
                        toggle.setAttribute("aria-expanded", hidden ? "false" : "true");
                        toggle.title = hidden ? "Show the details" : "Hide the details";
                    });
                    head.appendChild(toggle);
                    node.appendChild(body);
                }
            }

            // the choices
            var choices = [];
            if (question) {
                choices.push({ label: "Submit answers", behavior: "allow" });
                choices.push({ label: "Skip", behavior: "deny" });
            }
            else {
                choices.push({ label: plan ? "Yes, start" : "Yes", behavior: "allow" });
                var label = suggestionLabel(req.permission_suggestions);
                if (label) choices.push({ label: "Yes, " + label.charAt(0).toLowerCase() + label.slice(1), behavior: "allowAlways" });
                choices.push({ label: plan ? "No, keep planning" : "No", behavior: "deny" });
            }
            var active = 0;
            var list = el("div", { className: "claude-choices", role: "listbox", tabindex: "0", "aria-labelledby": titleId });
            var rows = choices.map(function(c, i) {
                var row = el("div", { className: "claude-choice", role: "option", id: titleId + "-" + i }, [
                    el("span", { className: "claude-choice-key", text: String(i + 1) }),
                    el("span", { className: "claude-choice-label", text: c.label })
                ]);
                row.addEventListener("mousemove", function() { highlight(i); });
                row.addEventListener("click", function(e) {
                    e.preventDefault();
                    pick(i);
                });
                list.appendChild(row);
                return row;
            });
            function highlight(i) {
                active = Math.max(0, Math.min(rows.length - 1, i));
                rows.forEach(function(row, k) {
                    row.classList.toggle("claude-active", k == active);
                    row.setAttribute("aria-selected", k == active ? "true" : "false");
                });
                list.setAttribute("aria-activedescendant", rows[active].id);
            }
            highlight(0);
            node.appendChild(list);

            var feedbackEl = null;
            if (!question) {
                feedbackEl = el("input", { type: "text", className: "claude-perm-feedback",
                    placeholder: "Tell Claude what to do instead", "aria-label": "Tell Claude what to do instead (Enter)" });
                feedbackEl.addEventListener("keydown", function(e) {
                    if (e.keyCode == 13 && !e.isComposing) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (feedbackEl.value.trim()) decide("deny", feedbackEl.value.trim());
                    }
                    else if (e.keyCode == 27 && feedbackEl.value) {
                        // Esc first clears the note, then denies
                        e.preventDefault();
                        e.stopPropagation();
                        feedbackEl.value = "";
                    }
                    else if (e.keyCode == 38 && !feedbackEl.value) {
                        e.preventDefault();
                        list.focus();
                        highlight(rows.length - 1);
                    }
                });
                node.appendChild(feedbackEl);
            }
            node.appendChild(el("div", { className: "claude-prompt-hint", text: question ? "Esc to skip" : "Esc to deny" }));

            list.addEventListener("keydown", function(e) {
                var n = e.keyCode >= 49 && e.keyCode <= 57 ? e.keyCode - 49 : e.keyCode >= 97 && e.keyCode <= 105 ? e.keyCode - 97 : -1;
                if (n >= 0 && n < rows.length && !e.ctrlKey && !e.metaKey && !e.altKey) pick(n);
                else if (e.keyCode == 40) {
                    if (active == rows.length - 1 && feedbackEl) feedbackEl.focus();
                    else highlight(active + 1);
                }
                else if (e.keyCode == 38) highlight(active - 1);
                else if (e.keyCode == 13 || e.keyCode == 32) pick(active);
                else return;
                e.preventDefault();
                e.stopPropagation();
            });

            function pick(i) {
                var c = choices[i];
                if (c) decide(c.behavior);
            }
            // note: the user's text (deny, and Claude goes on with it); without
            // one, a denial stops the turn and Claude waits
            function decide(behavior, note) {
                if (!card.pending || card.answering) return;
                // a click or key meant for what was there before the prompt
                if (Date.now() - shownAt < PROMPT_GUARD) return;
                if (!api) return showError("Not connected to the Claude service");
                card.answering = true;
                node.classList.add("claude-answering");
                var decision = { behavior: behavior };
                if (question && behavior == "allow") decision.answers = answers;
                if (behavior == "deny") {
                    if (question) decision.message = "The user skipped the question.";
                    else if (note) decision.message = "The user denied this tool call and said what to do instead: " + note;
                    else decision.interrupt = true;
                }
                api.respond(card.id, decision, function(err) {
                    card.answering = false;
                    if (err) return card.resolve("expired");
                    card.resolve(behavior);
                    if (note) renderUserMessage(note, [], false, true);
                });
            }
            card.escape = function() { decide("deny"); };
            card.count = function(total) {
                countEl.textContent = total > 1 ? "1 of " + total : "";
            };
            card.focus = function() {
                try { list.focus({ preventScroll: true }); } catch (e) {}
            };
            return node;
        }

        function questionForm(questions, answers, submit) {
            var form = el("div", { className: "claude-questions" });
            questions.forEach(function(q) {
                if (!q || !q.question) return;
                var multi = !!q.multiSelect;
                var chosen = [];
                var box = el("div", { className: "claude-question" }, [
                    q.header ? el("div", { className: "claude-question-header", text: q.header }) : null,
                    el("div", { className: "claude-question-text", text: q.question })
                ]);
                var opts = el("div", { className: "claude-options" });
                (q.options || []).forEach(function(option) {
                    var b = el("button", { type: "button", className: "claude-option", title: option.description || "" }, [
                        el("span", { className: "claude-option-label", text: option.label }),
                        option.description ? el("span", { className: "claude-option-desc", text: option.description }) : null
                    ]);
                    b.addEventListener("click", function() {
                        if (multi) {
                            var i = chosen.indexOf(option.label);
                            if (i == -1) chosen.push(option.label); else chosen.splice(i, 1);
                        }
                        else chosen = [option.label];
                        [].forEach.call(opts.childNodes, function(n) {
                            n.classList.toggle("claude-selected", chosen.indexOf(n.firstChild.textContent) != -1);
                        });
                        answers[q.question] = chosen.join(", ");
                        if (!multi && questions.length == 1) submit();
                    });
                    opts.appendChild(b);
                });
                box.appendChild(opts);
                form.appendChild(box);
            });
            return form;
        }

        function pendingPermissions() {
            return Object.keys(permCards).filter(function(id) { return permCards[id].pending; });
        }

        /***** Handling CLI events *****/

        function onEvent(event) {
            if (!event || typeof event != "object") return;
            // output of a process that was stopped (New session, Resume)
            // belongs to the old chat
            if ((event.ev == "msg" || event.ev == "control" || event.ev == "notice" || event.ev == "cli-settings")
              && event.pid && event.pid != cliPid)
                return;
            switch (event.ev) {
                case "state":
                    // after a reconnect: what the service is doing now
                    if (busy && !event.busy) {
                        busy = false;
                        stopDone();
                        finishTurn();
                        showNotice("The connection to the server was interrupted. Send your message again if the answer is incomplete.", "claude-notice-quiet");
                    }
                    running = !!event.running;
                    cliPid = event.pid || null;
                    if (event.running && event.sessionId && !sessionId) sessionId = event.sessionId;
                    if (event.busy && !busy) turnStart = Date.now();
                    busy = !!event.busy;
                    (event.pending || []).forEach(function(message) {
                        if (message && !permCards[message.request_id]) showPermission(message);
                    });
                    updateStatus();
                    break;
                case "spawn":
                    running = true;
                    cliPid = event.pid || null;
                    lastTotalCost = 0;
                    updateStatus();
                    break;
                case "exit":
                    onExit(event);
                    break;
                case "error":
                    busy = false;
                    stopDone();
                    showError(event.message || "Error");
                    finishTurn();
                    updateStatus();
                    break;
                case "notice":
                    if (event.kind == "resume-failed") sessionId = null;
                    showNotice(event.text || "");
                    break;
                case "control":
                    if (!event.ok && event.error)
                        showError("claude refused a request: " + event.error);
                    break;
                case "msg":
                    onMessage(event.data || {});
                    break;
                case "cli-settings":
                    onCliSettings(event);
                    break;
            }
        }

        function onExit(event) {
            // a process stopped earlier (New session, resume) may report its
            // exit after the next one started
            if (event.pid && cliPid && event.pid != cliPid) return;
            if (!event.pid && !running) return;
            cliPid = null;
            var wasBusy = busy;
            running = false;
            busy = false;
            stopDone();
            var stderr = event.stderr || "";
            if (event.reason == "idle") {
                var minutes = +event.idleMinutes || 20;
                showNotice("Claude was idle for " + minutes + (minutes == 1 ? " minute" : " minutes")
                    + " and has been stopped to free memory. Your next message resumes the session.", "claude-notice-quiet");
            }
            else if (!wasBusy && lastResultError) {
                // e.g. a login error: the result already explained it
            }
            else if (event.reason == "crashed" || (wasBusy && event.reason == "ended")) {
                if (LOGIN_RE.test(stderr)) showLoginHelp();
                else if (BILLING_RE.test(stderr)) showBillingHelp(stderr);
                else showError("claude exited unexpectedly" + (event.code != null ? " (code " + event.code + ")" : event.signal ? " (" + event.signal + ")" : ""), stderr || null);
            }
            if (event.sessionId && UUID_RE.test(event.sessionId) && (sessionId || event.reason != "stopped"))
                sessionId = sessionId || event.sessionId;
            finishTurn();
            setActivity("");
            updateStatus();
        }

        function onMessage(m) {
            switch (m.type) {
                case "system":
                    if (m.subtype == "init") {
                        if (typeof m.cwd == "string" && /^\//.test(m.cwd)) chatCwd = m.cwd;
                        if (m.session_id) setSession(m.session_id);
                        if (m.permissionMode) syncMode(m.permissionMode);
                        if (confirmModeNext && m.permissionMode) {
                            confirmModeNext = false;
                            insertNotice("Mode: " + modeCaption(m.permissionMode), true);
                        }
                    }
                    else if (m.subtype == "status") {
                        if (m.permissionMode) syncMode(m.permissionMode);
                        if (!busy) break;
                        if (m.status == "compacting") setActivity("Compacting…");
                        // a request to the model: it thinks until its answer streams
                        else if (m.status == "requesting") setActivity("Thinking…", "thinking");
                    }
                    else if (m.subtype == "thinking_tokens") {
                        if (liveThinking) liveThinking.setTokens(m.estimated_tokens);
                    }
                    else if (m.subtype == "api_retry") {
                        if (!busy) break;
                        var attempt = +m.attempt || 0;
                        setActivity("Retrying" + (attempt ? " (attempt " + attempt + ")" : "") + "…", "retry");
                        activity.title = "The request failed" + (m.error_status ? " (" + m.error_status + ")" : "")
                            + (m.error ? ": " + firstLine(m.error, 120) : "")
                            + (m.retry_delay_ms ? "; next try in " + Math.round(m.retry_delay_ms / 1000) + "s" : "")
                            + (m.max_retries ? " (at most " + m.max_retries + " tries)" : "");
                        renderActivity();
                    }
                    else if (m.subtype == "model_fallback") {
                        var from = modelName(m.original_model || m.originalModel);
                        var to = modelName(m.fallback_model || m.fallbackModel);
                        showNotice(to ? (from ? from + " is not available" : "The model is not available")
                            + (m.trigger ? " (" + String(m.trigger).replace(/_/g, " ") + ")" : "")
                            + "; Claude uses " + to + " for now." : "Claude switched to another model.", "claude-notice-warn");
                    }
                    else if (m.subtype == "compact_boundary") {
                        var cm = m.compact_metadata || {};
                        var freed = typeof cm.pre_tokens == "number" && typeof cm.post_tokens == "number"
                            ? cm.pre_tokens - cm.post_tokens : 0;
                        appendTo(el("div", { className: "claude-divider" }, [el("span", {
                            text: "Conversation compacted" + (freed > 0 ? " · " + formatTokens(freed) + " freed" : "") })]));
                        contextUsed = typeof cm.post_tokens == "number" ? cm.post_tokens : 0;
                        updateHint();
                    }
                    else if (m.subtype == "task_summary") {
                        taskSummary = busy && m.detail ? firstLine(m.detail, 80) : "";
                        updateStatus();
                    }
                    break;
                case "stream_event":
                    onStreamEvent(m.event || {});
                    break;
                case "assistant":
                    onAssistant(m, false);
                    break;
                case "user":
                    onUser(m, false);
                    break;
                case "control_request":
                    if (m.request && m.request.subtype == "can_use_tool") {
                        ensureTurn();
                        showPermission(m);
                    }
                    break;
                case "result":
                    onResult(m);
                    break;
                case "rate_limit_event":
                    onRateLimit(m.rate_limit_info || {});
                    break;
            }
        }

        var rateWarned = {};
        function onRateLimit(info) {
            if (!info.status || info.status == "allowed") return;
            var when = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
            var windowName = { five_hour: "5-hour", seven_day: "weekly", seven_day_opus: "weekly Opus" }[info.rateLimitType] || "";
            var key = info.status + ":" + (info.rateLimitType || "");
            if (rateWarned[key]) return;
            rateWarned[key] = true;
            if (info.status == "rejected") {
                showNotice("Usage limit reached" + (when ? "; it resets at " + when : ""), "claude-notice-warn");
            }
            else {
                var used = typeof info.utilization == "number" ? Math.round(info.utilization * 100) + "% of " : "most of ";
                showNotice("You have used " + used + "your " + (windowName ? windowName + " " : "") + "usage limit"
                    + (when ? "; it resets at " + when : ""), "claude-notice-quiet");
            }
        }

        function onStreamEvent(event) {
            var msg;
            switch (event.type) {
                case "message_start":
                    msg = getMsg(event.message && event.message.id);
                    msg.streamed = true;
                    msg.byIndex = {};
                    turn.current = msg;
                    break;
                case "content_block_start":
                    msg = turn && turn.current || getMsg(null);
                    var block = event.content_block || {};
                    if (block.type == "text") {
                        var tb = createTextBlock();
                        msg.textBlocks.push(tb);
                        msg.byIndex[event.index] = tb;
                        setActivity("Writing…", "writing");
                    }
                    else if (block.type == "thinking" || block.type == "redacted_thinking") {
                        var th = createThinkingBlock(true);
                        msg.thinkingBlocks.push(th);
                        msg.byIndex[event.index] = th;
                    }
                    else if (block.type == "tool_use" || block.type == "server_tool_use") {
                        var card = ensureToolCard(block.id, block.name);
                        msg.byIndex[event.index] = card;
                        toolStarted(card);
                        setActivity(toolActivity(block.name, card.input));
                    }
                    break;
                case "content_block_delta":
                    msg = turn && turn.current;
                    var target = msg && msg.byIndex[event.index];
                    var delta = event.delta || {};
                    if (!target || !target.append) break;
                    if (delta.type == "text_delta") target.append(delta.text || "");
                    else if (delta.type == "thinking_delta" && target.addTokens) {
                        target.append(delta.thinking || "");
                        target.addTokens(delta.estimated_tokens);
                    }
                    break;
                case "content_block_stop":
                    msg = turn && turn.current;
                    var done = msg && msg.byIndex[event.index];
                    if (done && done.finish) done.finish();
                    break;
            }
        }

        function onAssistant(m, fromHistory) {
            var message = m.message || {};
            var content = Array.isArray(message.content) ? message.content : [];
            if (m.parent_tool_use_id) {
                var parent = toolCards[m.parent_tool_use_id];
                if (parent) content.forEach(function(block) {
                    if (block.type == "tool_use") parent.addSubagentStep(block);
                });
                return;
            }
            if (!fromHistory && typeof m.context_tokens == "number") {
                contextUsed = m.context_tokens;
                updateHint();
            }
            var msg = getMsg(message.id);
            content.forEach(function(block) {
                if (block.type == "text") {
                    var tb = msg.streamed && msg.textBlocks[msg.textDone];
                    if (!tb) {
                        tb = createTextBlock();
                        msg.textBlocks.push(tb);
                    }
                    msg.textDone++;
                    tb.setText(block.text || "");
                    if (!msg.streamed || fromHistory) tb.finish();
                }
                else if (block.type == "thinking" || block.type == "redacted_thinking") {
                    var th = msg.streamed && !fromHistory && msg.thinkingBlocks[msg.thinkingDone];
                    if (!th) {
                        th = createThinkingBlock(false);
                        msg.thinkingBlocks.push(th);
                    }
                    msg.thinkingDone++;
                    th.setText(block.thinking || "");
                    // a streamed block ends with its content_block_stop
                    if (!msg.streamed || fromHistory) th.finish();
                }
                else if (block.type == "tool_use" || block.type == "server_tool_use") {
                    var card = ensureToolCard(block.id, block.name);
                    card.setInput(block.input);
                    if (!fromHistory && card.status == "running") {
                        toolStarted(card);
                        setActivity(toolActivity(block.name, block.input));
                    }
                }
                else if (/_tool_result$/.test(block.type || "") && block.tool_use_id && toolCards[block.tool_use_id]) {
                    var server = toolCards[block.tool_use_id];
                    server.setStatus(block.content && block.content.type && /error/.test(block.content.type) ? "error" : "ok");
                    toolEnded(server);
                }
            });
        }

        function onUser(m, fromHistory) {
            if (m.parent_tool_use_id) return;
            var content = m.message && m.message.content;
            if (typeof content == "string") content = [{ type: "text", text: content }];
            if (!Array.isArray(content)) return;
            var texts = [];
            var imgs = [];
            content.forEach(function(block) {
                if (!block) return;
                if (block.type == "tool_result") {
                    var card = toolCards[block.tool_use_id];
                    if (card) card.setResult(block.content, !!block.is_error);
                    if (card && !fromHistory) toolEnded(card);
                }
                else if (block.type == "text") {
                    // "[Request interrupted by user]": the turn footer says Stopped
                    if (!/^\[Request interrupted by user/.test(block.text || ""))
                        texts.push(block.text || "");
                }
                else if (block.type == "image") {
                    imgs.push(block.source && block.source.data
                        ? { mediaType: block.source.media_type, data: block.source.data }
                        : { omitted: true });
                }
            });
            if (fromHistory && (texts.length || imgs.length)) {
                finishTurn(true);
                renderUserMessage(texts.join("\n\n"), imgs);
                startTurn();
            }
        }

        function onResult(m) {
            if (m.session_id) setSession(m.session_id);
            var t = turn;
            var aborted = m.subtype == "error_during_execution" && /abort|interrupt/i.test(m.terminal_reason || "") || stopping;
            lastResultError = !!(m.is_error && !aborted);
            if (m.is_error && !aborted) {
                var text = m.result || (m.errors || []).join("\n") || m.subtype || "Error";
                if (LOGIN_RE.test(text)) showLoginHelp();
                else if (BILLING_RE.test(text)) showBillingHelp(text);
                else showError(firstLine(text, 300), text.length > 300 || /\n/.test(text) ? text : null);
            }
            var cost = typeof m.turn_cost_usd == "number" ? m.turn_cost_usd
                : typeof m.total_cost_usd == "number" ? Math.max(0, m.total_cost_usd - lastTotalCost) : null;
            if (typeof m.total_cost_usd == "number") lastTotalCost = m.total_cost_usd;
            var cw = m.context_window;
            if (cw && typeof cw.size == "number") {
                contextWindow = cw.size - Math.min(+cw.max_output || 0, 20000) - 13000;
                updateHint();
            }
            var bits = [];
            if (aborted) bits.push("Stopped");
            if (cost != null && (cost > 0 || !aborted && !m.is_error)) bits.push(formatCost(cost));
            if (m.duration_ms) bits.push(formatDuration(m.duration_ms));
            if (t && bits.length)
                t.el.appendChild(el("div", { className: "claude-turn-footer", text: bits.join(" · "),
                    title: m.num_turns ? m.num_turns + " model calls" + (typeof m.total_cost_usd == "number"
                        ? ", " + formatCost(m.total_cost_usd) + " since claude started" : "") : "" }));
            busy = false;
            taskSummary = "";
            stopDone();
            finishTurn();
            setActivity("");
            scrollToEnd();
            refreshApplied();
            sendQueued();
        }

        function formatCost(usd) {
            if (usd < 0.01) return "$" + usd.toFixed(4);
            if (usd < 1) return "$" + usd.toFixed(3);
            return "$" + usd.toFixed(2);
        }

        function formatDuration(ms) {
            var s = ms / 1000;
            if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + "s";
            var min = Math.floor(s / 60);
            return min + "m " + Math.round(s - min * 60) + "s";
        }

        function setSession(id) {
            if (!UUID_RE.test(id || "")) return;
            if (sessionId == id) return;
            sessionId = id;
            settings.set("state/claude/@session", id);
            settings.set("state/claude/@sessionAccount", chatAccount);
            if (pendingTitle) {
                settings.set("state/claude/@title", pendingTitle);
                pendingTitle = null;
            }
            updateStatus();
        }

        // the mode the CLI reports (init, status)
        function syncMode(mode) {
            if (!drawn || typeof mode != "string" || !/^\w{1,40}$/.test(mode)) return;
            setSelect(modeSelect, mode);
        }

        /***** Composer *****/

        function autosize() {
            textarea.style.height = "auto";
            var max = Math.max(80, Math.round(root.clientHeight * 0.4));
            textarea.style.height = Math.min(max, textarea.scrollHeight + 2) + "px";
            textarea.style.overflowY = textarea.scrollHeight + 2 > max ? "auto" : "hidden";
            updateStatus();
        }

        function onComposerKey(e) {
            if (e.keyCode == 13 && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.isComposing && e.keyCode != 229) {
                e.preventDefault();
                e.stopPropagation();
                submit();
            }
            else if (e.keyCode == 27 && (busy || stopping)) {
                e.preventDefault();
                e.stopPropagation();
                interrupt();
            }
            // Shift+Tab: the next permission mode
            else if (e.keyCode == 9 && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault();
                e.stopPropagation();
                cycleMode();
            }
        }

        function onPaste(e) {
            var files = images.filesFrom(e.clipboardData);
            if (!files.length) return;
            e.preventDefault();
            addFiles(files, true);
        }

        // A line above the input: a short message (quiet: not a warning),
        // otherwise, once half of the context is used, how much is left
        // before the CLI compacts the conversation.
        var hintTimer = null;
        function flashHint(text, quiet) {
            noteEl.textContent = text;
            noteEl.className = "claude-composer-note claude-show" + (quiet ? "" : " claude-hint-alert");
            noteEl.title = "";
            clearTimeout(hintTimer);
            hintTimer = setTimeout(function() {
                hintTimer = null;
                updateHint();
            }, 3500);
        }

        function updateHint() {
            if (!noteEl || hintTimer) return;
            var size = contextWindow > 0 ? contextWindow : 0;
            var used = size && contextUsed ? contextUsed / size : 0;
            var meter = used >= 0.5;
            noteEl.textContent = meter ? Math.max(0, Math.round((1 - used) * 100)) + "% of context left before auto-compact" : "";
            noteEl.title = meter ? "About " + formatTokens(contextUsed) + " of " + formatTokens(size) + " in use" : "";
            noteEl.className = "claude-composer-note" + (meter ? " claude-show claude-hint-context" : "")
                + (meter && used >= 0.85 ? " claude-hint-low" : "");
        }

        // Each image is a chip above the input: a thumbnail, its name (or
        // "pasted image") and its size; a larger preview on hover.
        function addFiles(files, pasted) {
            files.forEach(function(file) {
                if (attachments.length >= MAX_ATTACHMENTS)
                    return flashHint("At most " + MAX_ATTACHMENTS + " images per message");
                var item = { name: pasted ? "pasted image" : file.name || "image", loading: true };
                attachments.push(item);
                var thumb = el("span", { className: "claude-chip-thumb" });
                var sizeEl = el("span", { className: "claude-chip-size", text: "…" });
                var chip = el("div", { className: "claude-chip claude-loading", title: item.name }, [
                    thumb,
                    el("span", { className: "claude-chip-name", text: item.name }),
                    sizeEl
                ]);
                var remove = iconButton("close", "Remove " + item.name, function() {
                    var i = attachments.indexOf(item);
                    if (i != -1) attachments.splice(i, 1);
                    if (chip.parentNode) chip.parentNode.removeChild(chip);
                    hidePreview();
                    updateAttachments();
                    textarea.focus();
                });
                remove.classList.add("claude-chip-remove");
                chip.appendChild(remove);
                chip.addEventListener("mouseenter", function() { showPreview(chip, item); });
                chip.addEventListener("mouseleave", hidePreview);
                item.el = chip;
                attachRow.appendChild(chip);
                updateAttachments();
                images.prepare(file, function(err, image) {
                    if (attachments.indexOf(item) == -1) return;
                    if (err) {
                        attachments.splice(attachments.indexOf(item), 1);
                        if (chip.parentNode) chip.parentNode.removeChild(chip);
                        updateAttachments();
                        return flashHint(err.message);
                    }
                    item.loading = false;
                    item.mediaType = image.mediaType;
                    item.data = image.data;
                    item.width = image.width;
                    item.height = image.height;
                    chip.classList.remove("claude-loading");
                    var img = el("img", { alt: "" });
                    img.src = "data:" + image.mediaType + ";base64," + image.data;
                    thumb.appendChild(img);
                    sizeEl.textContent = image.width + "×" + image.height + " · " + formatSize(image.size);
                    chip.title = item.name + " · " + sizeEl.textContent + (image.resized ? " (resized)" : "");
                    updateAttachments();
                });
            });
            textarea.focus();
        }

        function formatSize(bytes) {
            return bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / 1024 / 1024).toFixed(1) + " MB";
        }

        // the larger preview of an attached image, above its chip, inside the panel
        function showPreview(chip, item) {
            if (!item.data) return;
            chipPreview.textContent = "";
            var img = el("img", { alt: item.name });
            img.src = "data:" + item.mediaType + ";base64," + item.data;
            chipPreview.appendChild(img);
            chipPreview.classList.add("claude-show");
            var r = root.getBoundingClientRect(), c = chip.getBoundingClientRect();
            var w = chipPreview.offsetWidth;
            chipPreview.style.left = Math.max(8, Math.min(c.left - r.left, r.width - w - 8)) + "px";
            chipPreview.style.bottom = (r.bottom - c.top + 6) + "px";
        }

        function hidePreview() {
            chipPreview.classList.remove("claude-show");
            chipPreview.textContent = "";
        }

        function updateAttachments() {
            attachRow.style.display = attachments.length ? "" : "none";
            updateStatus();
        }

        function clearAttachments() {
            attachments = [];
            attachRow.textContent = "";
            hidePreview();
            updateAttachments();
        }

        function onSendButton() {
            if (busy || stopping) interrupt();
            else submit();
        }

        var contextUsed = 0;        // tokens in the context of the main agent (last answer)
        var contextWindow = 0;      // ... and how many fit before auto-compact
        var queued = null;          // a message typed while Claude was working
        var pendingTitle = null;
        var elsewhereCard = null;   // the question how to open a session that is open elsewhere
        var forkNext = null;        // the session to open in a copy on the next send

        function submit() {
            var text = textarea.value;
            var trimmed = text.trim();
            if (!trimmed && !attachments.length) return;
            if (attachments.some(function(a) { return a.loading; }))
                return flashHint("Wait until the images are ready");
            if (!api) return flashHint(connecting ? "Still connecting…" : "Not connected to the server");
            if (cliInfo && !cliInfo.found) {
                renderWelcome();
                return flashHint("claude was not found on the server");
            }
            if (elsewhereCard)
                return flashHint("First choose how to open this conversation");

            // While a permission prompt is open, a message answers it:
            // the tool call is denied and Claude gets the text instead.
            var pending = pendingPermissions();
            if (pending.length && trimmed && !attachments.length) {
                pending.forEach(function(id) {
                    var card = permCards[id];
                    api.respond(id, { behavior: "deny", message: "The user denied this tool call and wrote: " + text },
                        function(err) { card.resolve(err ? "expired" : "deny"); });
                });
                renderUserMessage(text, [], false, true);
                textarea.value = "";
                autosize();
                return;
            }
            if (busy || stopping) {
                if (queued) return flashHint("A message is already waiting to be sent");
                queued = { text: text, images: attachments.slice(), node: renderUserMessage(text, attachments, true) };
                textarea.value = "";
                clearAttachments();
                autosize();
                flashHint("Sent when Claude has finished (or press Stop)");
                return;
            }
            sendNow(text, attachments.slice());
            textarea.value = "";
            clearAttachments();
            autosize();
        }

        function sendQueued() {
            if (!queued || busy) return;
            var q = queued;
            queued = null;
            q.node.classList.remove("claude-queued");
            sendNow(q.text, q.images, true);
        }

        function sendNow(text, imgs, alreadyShown) {
            var content = [];
            imgs.forEach(function(image) {
                content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
            });
            if (text.trim()) content.push({ type: "text", text: text });

            if (!alreadyShown) renderUserMessage(text.trim() ? text : "", imgs);
            if (!sessionId && !hasSentInSession)
                pendingTitle = firstLine(text || "(image)", 80);
            if (!sessionTitle) sessionTitle = firstLine(text || "(image)", 80);
            hasSentInSession = true;
            lastResultError = false;
            startTurn();
            busy = true;
            turnStart = Date.now();
            taskSummary = "";
            debug = debugOn();
            debugLast = 0;
            autoScroll = true;
            setActivity(running ? "Thinking…" : "Starting Claude…", running ? "thinking" : "");
            scrollToEnd(true);

            api.send({
                content: content,
                options: {
                    model: modelSelect.value,
                    effort: effortForModel(effortSelect.value, modelSelect.value),
                    ultracode: ultracodeWanted(),
                    // only a mode the user picked; the label may show the CLI's
                    mode: acctPref("mode"),
                    account: chatAccount,
                    cwd: chatFolder,
                    resume: sessionId,
                    fork: !!(sessionId && forkNext == sessionId),
                    path: settings.get("user/claude/@path")
                }
            }, function(err, result) {
                if (err) {
                    busy = false;
                    if (err.code == "ENOTFOUND" || /not found/i.test(err.message || "")) {
                        cliInfo = { found: false, tried: err.tried || (cliInfo && cliInfo.tried) };
                        appendTo(notFoundBox());
                    }
                    else showError(err.message || String(err));
                    finishTurn();
                    setActivity("");
                    return;
                }
                if (result && result.pid) {
                    running = true;
                    cliPid = result.pid;
                }
                if (result && result.spawned) forkNext = null;
                updateStatus();
            });
        }
        var hasSentInSession = false;

        // the end of a Stop (or of a turn): no more waiting for it
        function stopDone() {
            stopping = false;
            clearTimeout(stopTimer);
            stopTimer = null;
        }

        function interrupt() {
            if (queued) {
                if (queued.node.parentNode) queued.node.parentNode.removeChild(queued.node);
                textarea.value = queued.text;
                queued = null;
                autosize();
            }
            pendingPermissions().forEach(function(id) { permCards[id].resolve("stopped"); });
            if (!api) {
                busy = false;
                finishTurn();
                return updateStatus();
            }
            stopping = true;
            updateStatus();
            api.interrupt(function(err, result) {
                if (err || !result || !result.running) {
                    stopDone();
                    busy = false;
                    finishTurn();
                    updateStatus();
                }
            });
            // a turn that does not end after an interrupt: give up waiting
            clearTimeout(stopTimer);
            stopTimer = setTimeout(function() {
                stopTimer = null;
                if (stopping) {
                    stopDone();
                    busy = false;
                    finishTurn();
                    updateStatus();
                }
            }, 15000);
        }

        /***** Model, effort and mode *****/

        function models() {
            return modelList || FALLBACK_MODELS;
        }

        function modelEntry(value) {
            return models().filter(function(m) { return m.value == value; })[0] || null;
        }

        // the levels a model supports (none: no effort control); a model
        // the list does not know: the common ones
        function effortLevels(value) {
            var entry = modelEntry(value);
            if (!entry) return FALLBACK_LEVELS;
            if (!entry.supportsEffort) return [];
            return entry.supportedEffortLevels && entry.supportedEffortLevels.length ? entry.supportedEffortLevels : FALLBACK_LEVELS;
        }

        function effortForModel(level, model) {
            return level && effortLevels(model).indexOf(level) != -1 ? level : "";
        }

        function effortCaption(level) {
            return EFFORTS.hasOwnProperty(level) ? EFFORTS[level] : String(level);
        }

        // "claude-opus-5-5" -> "Opus 5.5"
        function modelName(id) {
            if (!id || typeof id != "string") return "";
            var list = models();
            var hit = list.filter(function(m) { return m.value != "default" && m.resolvedModel == id; })[0]
                || list.filter(function(m) { return m.value == id && m.value != "default"; })[0];
            if (hit) return hit.displayName;
            var m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id);
            if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1) + " " + m[2] + (m[3] ? "." + m[3] : "");
            return id;
        }

        function modeCaption(mode) {
            var item = MODES.filter(function(m) { return m.value == mode; })[0];
            return item ? item.caption : String(mode);
        }

        function modelItems() {
            return models().map(function(m) {
                return { value: m.value, caption: m.displayName, desc: m.description,
                    short: m.value == "default" ? "Default" : m.displayName };
            });
        }

        // "Auto": not set, Claude's settings decide
        function effortItems() {
            var items = [{ value: "", caption: "Auto", desc: "Claude's settings decide", short: "Effort" }];
            effortLevels(modelSelect.value).forEach(function(level) {
                items.push({ value: level, caption: effortCaption(level),
                    desc: level == "max" ? "May use many tokens and respond slowly" : "" });
            });
            return items;
        }

        function cleanModels(list) {
            return (Array.isArray(list) ? list : []).filter(function(m) {
                return m && typeof m.value == "string" && (m.value == "default" || MODEL_RE.test(m.value));
            }).slice(0, 60).map(function(m) {
                return {
                    value: m.value,
                    resolvedModel: typeof m.resolvedModel == "string" ? m.resolvedModel : null,
                    displayName: String(m.displayName || m.value).slice(0, 80),
                    description: String(m.description || "").slice(0, 160),
                    supportsEffort: !!m.supportsEffort,
                    supportedEffortLevels: (Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : [])
                        .filter(function(level) { return EFFORTS.hasOwnProperty(level); })
                };
            });
        }

        // the last list and settings the account's CLI reported (state settings)
        function restoreModelCache(key) {
            modelList = null;
            applied = appliedFor = null;
            ultraAvail = {};
            var list = cleanModels(cacheGet("models", key));
            if (list.length) modelList = list;
            var last = cacheGet("applied", key);
            if (last && last.applied && last.appliedFor) {
                applied = { model: str(last.applied.model), effort: str(last.applied.effort),
                    ultracode: last.applied.ultracode === true, ultracodeRequested: last.applied.ultracodeRequested === true,
                    ultracodeAvailable: last.applied.ultracodeAvailable === true };
                appliedFor = { model: String(last.appliedFor.model || ""), effort: String(last.appliedFor.effort || ""),
                    ultracode: last.appliedFor.ultracode === true };
            }
            if (last && last.ultraAvail && typeof last.ultraAvail == "object") {
                Object.keys(last.ultraAvail).slice(0, 80).forEach(function(key) {
                    if (typeof last.ultraAvail[key] == "boolean") ultraAvail[key] = last.ultraAvail[key];
                });
            }
            function str(v) { return typeof v == "string" ? v : null; }
        }

        // The pill's label: what the CLI applies, when it is known for the
        // current choice; otherwise the choice (applied when claude starts).
        function updateSettingLabels() {
            if (!drawn) return;
            modelSelect.refresh();
            effortSelect.refresh();
            var fresh = !!(applied && appliedFor && appliedFor.model == modelSelect.value
                && appliedFor.effort == effortSelect.value);
            var entry = modelEntry(modelSelect.value);
            var chosen = entry ? entry.displayName : modelSelect.value;
            var later = running ? "" : " (used when Claude starts)";
            var inUse = fresh && applied.model ? modelName(applied.model) : "";
            modelSelect.label = inUse || null;
            modelSelect.tip = "Model: " + chosen + (inUse && inUse != chosen ? " · in use: " + inUse : fresh ? "" : later);
            effortSelect.label = fresh && applied.effort ? effortCaption(applied.effort) : null;
            effortSelect.tip = "Effort: " + (effortSelect.value ? effortCaption(effortSelect.value) : "Auto (Claude's settings decide)")
                + (fresh && applied.effort && applied.effort != effortSelect.value ? " · in use: " + effortCaption(applied.effort)
                    : fresh ? "" : later);
            renderPills();
        }

        // the CLI's model list and applied settings, after it started
        function onCliSettings(event) {
            if (Array.isArray(event.models)) {
                var list = cleanModels(event.models);
                if (list.length) {
                    modelList = list;
                    cacheSet("models", list);
                }
            }
            var note = checkEffort();
            if (note) {
                insertNotice(note, true);
                if (api && running) {
                    return api.setEffort("", function(err, res) {
                        confirmSettings(!err && res && res.applied || event.applied, true);
                    });
                }
            }
            confirmSettings(event.applied, confirmNext, true);
        }

        // An effort level the model does not support: back to the effort
        // from Claude's settings. Returns what to tell the user.
        function checkEffort() {
            var level = effortSelect.value;
            if (!level || !modelList || effortForModel(level, modelSelect.value)) return null;
            memory().effort = "";
            setAcctPref("effort", "");
            setSelect(effortSelect, "");
            var entry = modelEntry(modelSelect.value);
            var name = entry && entry.value != "default" ? entry.displayName : "The default model";
            return name + " does not support " + effortCaption(level) + " effort; effort is back to Auto (Claude's settings decide).";
        }

        // what the CLI applies now; force: tell it even when it did not change
        function confirmSettings(a, force, atStart) {
            confirmNext = false;
            if (!drawn) return;
            if (!a) return updateSettingLabels();
            var before = applied;
            applied = {
                model: typeof a.model == "string" ? a.model : null,
                effort: typeof a.effort == "string" ? a.effort : null,
                ultracode: a.ultracode === true,
                ultracodeRequested: a.ultracodeRequested === true,
                ultracodeAvailable: a.ultracodeAvailable === true
            };
            appliedFor = { model: modelSelect.value, effort: effortSelect.value, ultracode: ultracodeWanted() };
            if (typeof a.ultracodeAvailable == "boolean") ultraAvail[modelSelect.value] = a.ultracodeAvailable;
            cacheSet("applied", { applied: applied, appliedFor: appliedFor, ultraAvail: ultraAvail });
            updateSettingLabels();
            var ultraChanged = !before ? applied.ultracodeRequested
                : before.ultracode != applied.ultracode || before.ultracodeRequested != applied.ultracodeRequested;
            var changed = !before || before.model != applied.model || before.effort != applied.effort || ultraChanged;
            var toggled = ultraToggled;
            ultraToggled = false;
            if (!force && !changed) return;
            var unavailable = applied.ultracodeRequested && !applied.ultracode;
            var text = "Model: " + (modelName(applied.model) || "default")
                + (applied.effort ? " · Effort: " + effortCaption(applied.effort) : "")
                + (unavailable ? " · Ultracode: requested, but " + (modelName(applied.model) || "this model") + " does not support it"
                    : applied.ultracode || ultraChanged || toggled ? " · Ultracode: " + (applied.ultracode ? "on" : "off") : "");
            insertNotice(text, atStart, unavailable);
        }

        // until the tab reloads (see memory())
        function ultracodeWanted() {
            return memory().ultracode === true;
        }

        // ultracode as the pill and the switch show it: "on", "off" or
        // "unavailable" (requested, but the model does not support it)
        function ultracodeState() {
            var fresh = !!(applied && appliedFor && appliedFor.model == modelSelect.value
                && appliedFor.effort == effortSelect.value && appliedFor.ultracode == ultracodeWanted());
            if (!fresh) return ultracodeWanted() ? ultraAvail[modelSelect.value] === false ? "unavailable" : "on" : "off";
            return applied.ultracode ? "on" : applied.ultracodeRequested ? "unavailable" : "off";
        }

        function onUltracodeChange(on) {
            memory().ultracode = on;
            ultraToggled = true;
            updateSettingLabels();
            queueSettings(function(done) {
                if (!api || !running) return notRunning() && done();
                api.setUltracode(on, function(err, res) {
                    if (err) showError("Could not change Ultracode: " + (err.message || err));
                    else if (!notRunning(res)) confirmSettings(res.applied, true);
                    done();
                });
            });
        }

        // atStart: about the claude that starts for this turn: before Claude's answer
        function insertNotice(text, atStart, warn) {
            var className = "claude-notice-settings " + (warn ? "claude-notice-warn" : "claude-notice-quiet");
            if (atStart && turn && turn.el.parentNode == logEl) {
                var node = el("div", { className: "claude-notice " + className, text: text });
                logEl.insertBefore(node, turn.el);
                scrollToEnd();
                return node;
            }
            return showNotice(text, className);
        }

        // Changes of the model, effort and mode go to the CLI one at a time,
        // in the order they were made; task(done) calls done when finished.
        var settingsQueue = [];
        var settingsBusy = false;
        function queueSettings(task) {
            settingsQueue.push(task);
            if (!settingsBusy) nextSettings();
        }
        function nextSettings() {
            var task = settingsQueue.shift();
            settingsBusy = !!task;
            if (!task) return;
            var finished = false;
            // a call that never answers (lost connection) does not block the rest
            var guard = setTimeout(done, 20000);
            function done() {
                if (finished) return;
                finished = true;
                clearTimeout(guard);
                nextSettings();
            }
            try {
                task(done);
            } catch (e) {
                console.error("[claude]", e);
                done();
            }
        }

        // not running: the choice applies (and is confirmed) when claude starts
        function notRunning(res) {
            if (res && res.running) return false;
            confirmNext = true;
            updateSettingLabels();
            return true;
        }

        function onModelChange(value) {
            setAcctPref("model", value);
            var note = checkEffort();
            if (note) insertNotice(note);
            updateSettingLabels();
            queueSettings(function(done) {
                if (!api || !running) return notRunning() && done();
                api.setModel(value, function(err, res) {
                    if (err) {
                        showError("Could not change the model: " + (err.message || err));
                        return done();
                    }
                    if (notRunning(res)) return done();
                    if (!note) {
                        confirmSettings(res.applied, true);
                        return done();
                    }
                    // the model does not support the effort that was set
                    api.setEffort("", function(err2, res2) {
                        confirmSettings(!err2 && res2 && res2.applied || res.applied, true);
                        done();
                    });
                });
            });
        }

        function onEffortChange(value) {
            memory().effort = value;
            setAcctPref("effort", value);
            updateSettingLabels();
            queueSettings(function(done) {
                if (!api || !running) return notRunning() && done();
                api.setEffort(value, function(err, res) {
                    if (err) showError("Could not change the effort: " + (err.message || err));
                    else if (!notRunning(res)) confirmSettings(res.applied, true);
                    done();
                });
            });
        }

        function onModeChange(value) {
            setAcctPref("mode", value);
            queueSettings(function(done) {
                if (!api || !running) {
                    confirmModeNext = true;
                    return done();
                }
                // the CLI cannot go back to "no mode": the next claude starts without one
                if (!value) {
                    insertNotice("The mode from Claude's settings applies when Claude starts again (New session).");
                    return done();
                }
                api.setMode(value, function(err, res) {
                    if (err) showError("Could not change the permission mode: " + (err.message || err));
                    else if (res && res.running) insertNotice("Mode: " + modeCaption(value));
                    else confirmModeNext = true;
                    done();
                });
            });
        }

        // after each turn: what the CLI applies now (e.g. after a fallback)
        function refreshApplied() {
            queueSettings(function(done) {
                if (!api || !running) return done();
                api.getSettings({ models: false }, function(err, res) {
                    if (!err && res && res.running && res.applied) confirmSettings(res.applied, false);
                    done();
                });
            });
        }

        /***** Sessions *****/

        function clearChat() {
            finishTurn();
            sessionTitle = "";
            toolCards = Object.create(null);
            permCards = Object.create(null);
            [].slice.call(logEl.childNodes).forEach(function(node) {
                if (node != welcomeEl) logEl.removeChild(node);
            });
            hasMessages = false;
            hasSentInSession = false;
            chatCwd = "";
            queued = null;
            elsewhereCard = null;
            forkNext = null;
            taskSummary = "";
            contextUsed = 0;
            updateHint();
            busy = false;
            stopDone();
            lastTotalCost = 0;
            rateWarned = {};
            autoScroll = true;
            jumpBtn.classList.remove("claude-show");
            renderWelcome();
        }

        function stopProcess() {
            // the service stops whatever process it runs for this client
            if (api) api.stop(function() {});
            running = false;
            cliPid = null;
        }

        // a new chat: the account picked last, in the workspace
        function newSession() {
            stopProcess();
            clearChat();
            sessionId = null;
            pendingTitle = null;
            chatFolder = "";
            useAccount(defaultAccount());
            renderWelcome();
            updateStatus();
            textarea.focus();
        }

        // info: the entry of the session list, when picked there ({ account, cwd, title })
        function resumeSession(id, info) {
            if (!UUID_RE.test(id || "")) return;
            info = info || {};
            stopProcess();
            clearChat();
            chatFolder = typeof info.cwd == "string" ? info.cwd : "";
            useAccount(info.account || "");
            sessionId = id;
            hasSentInSession = true;
            var title = info.title ? String(info.title)
                : id == settings.get("state/claude/@session") ? settings.get("state/claude/@title") || "" : "";
            var name = title ? "\u201c" + (title.length > 60 ? title.slice(0, 59) + "\u2026" : title) + "\u201d"
                : "session " + id.slice(0, 8);
            sessionTitle = title ? firstLine(title, 80) : "";
            // the chat open now is the one "Resume last session" offers
            settings.set("state/claude/@session", id);
            settings.set("state/claude/@sessionAccount", chatAccount);
            settings.set("state/claude/@title", sessionTitle);
            var notice = showNotice("Resuming " + name + "\u2026", "claude-notice-quiet");
            updateStatus();
            if (!api) return;
            api.history(id, chatAccount, function(err, res) {
                if (sessionId != id) return;
                if (err || !res || !res.found) {
                    sessionTitle = sessionTitle || "Session " + id.slice(0, 8);
                    updateStatus();
                    notice.textContent = "Resumed " + name
                        + ". Its earlier messages are not available here; Claude still remembers them.";
                    return;
                }
                // the folder it ran in (null: gone; it continues in the workspace)
                chatFolder = typeof res.cwd == "string" ? res.cwd : "";
                renderWhere();
                notice.textContent = "Resumed " + name + (several() ? " as " + accountName(chatAccount) : "")
                    + " in " + tildePath(chatFolder || workspaceDir())
                    + (res.folder && !res.cwd ? " (its folder " + tildePath(res.folder) + " is gone)" : "")
                    + (res.truncated ? "; older messages are not shown" : "");
                renderHistory(res.messages || []);
                // no title from the list: the first prompt
                if (!sessionTitle) {
                    sessionTitle = firstPrompt(res.messages || []) || "Session " + id.slice(0, 8);
                    settings.set("state/claude/@title", sessionTitle);
                }
                updateStatus();
                if (res.elsewhere) askElsewhere(id, res.elsewhere);
            });
            textarea.focus();
        }

        // The session is open in another process (a terminal): open a copy
        // (--fork-session), open it here anyway, or cancel.
        function askElsewhere(id, info) {
            var shownAt = Date.now();
            var detail = info.how == "recent" ? "It changed in the last two minutes."
                : info.status == "busy" ? "Claude is working in it right now." : "";
            var actions = el("div", { className: "claude-actions" });
            var node = el("div", { className: "claude-perm claude-elsewhere" }, [
                el("div", { className: "claude-perm-title" }, [
                    icon("terminal", "claude-perm-icon"),
                    el("span", { className: "claude-perm-text", text: "This conversation is still open somewhere else (e.g. a terminal)." })
                ]),
                detail ? el("div", { className: "claude-perm-desc", text: detail }) : null,
                actions
            ]);
            function choose(how) {
                if (Date.now() - shownAt < PROMPT_GUARD || elsewhereCard !== node) return;
                elsewhereCard = null;
                if (how == "cancel") return newSession();
                forkNext = how == "copy" ? id : null;
                var note = el("div", { className: "claude-notice claude-notice-quiet", text: how == "copy"
                    ? "It continues here in a copy, so the two do not mix."
                    : "Opened here as well: both places add to the same conversation." });
                if (node.parentNode) node.parentNode.replaceChild(note, node);
                updateStatus();
                textarea.focus();
            }
            actions.appendChild(textButton("Open a copy", "claude-btn-primary", function() { choose("copy"); },
                "Continue in a new copy of the conversation"));
            actions.appendChild(textButton("Open here anyway", "claude-btn-secondary", function() { choose("here"); }));
            actions.appendChild(textButton("Cancel", "claude-btn-secondary", function() { choose("cancel"); }));
            elsewhereCard = node;
            appendToLog(node);
            autoScroll = true;
            scrollToEnd(true);
            updateStatus();
        }

        function firstPrompt(messages) {
            for (var i = 0; i < messages.length; i++) {
                var m = messages[i];
                if (!m || m.type != "user" || m.parent_tool_use_id) continue;
                var content = m.message && m.message.content;
                var text = typeof content == "string" ? content : Array.isArray(content)
                    ? content.filter(function(b) { return b && b.type == "text"; }).map(function(b) { return b.text; }).join(" ") : "";
                if (text && text.trim() && !/^\[Request interrupted/.test(text)) return firstLine(text, 80);
            }
            return "";
        }

        function renderHistory(messages) {
            messages.forEach(function(m) {
                try {
                    if (m.type == "assistant") {
                        ensureTurn();
                        onAssistant(m, true);
                    }
                    else if (m.type == "user") {
                        onUser(m, true);
                    }
                } catch (e) {
                    console.error("[claude] could not render a message", e);
                }
            });
            finishTurn(true);
            autoScroll = true;
            scrollToEnd(true);
        }

        /***** Lifecycle *****/

        plugin.on("load", function() {
            load();
        });
        plugin.on("draw", function(e) {
            draw(e);
        });
        plugin.on("show", function() {
            if (!drawn) return;
            if (!api && c9.connected) loadRemote();
            else if (api && !binChecked) refreshStatus();
            setTimeout(function() { textarea.focus(); }, 0);
        });
        plugin.on("unload", function() {
            onUnload();
            loaded = false;
            drawn = false;
            api = null;
            stream = null;
        });

        /***** Register and define API *****/

        /**
         * Chat panel for Claude Code.
         * @singleton
         */
        plugin.freezePublicAPI({
            /**
             * The CLI session id of the current chat (null for a new chat).
             * @property {String} sessionId
             * @readonly
             */
            get sessionId() { return sessionId; },
            /**
             * Whether Claude is working on a message.
             * @property {Boolean} busy
             * @readonly
             */
            get busy() { return busy; },
            /**
             * Whether a claude process is running for this chat.
             * @property {Boolean} running
             * @readonly
             */
            get running() { return running; },
            /**
             * The result of the last check for the claude CLI.
             * @property {Object} cli
             * @readonly
             */
            get cli() { return cliInfo; },

            /**
             * Sends a message as if typed in the panel.
             * @param {String} text
             */
            send: function(text) {
                if (!drawn) return false;
                textarea.value = text;
                submit();
                return true;
            },
            /**
             * Stops the current turn.
             */
            stop: interrupt,
            /**
             * Starts a new chat.
             */
            newSession: newSession,
            /**
             * Resumes a session by id (default: the last one).
             * @param {String} [id]
             */
            resume: function(id, account) {
                var saved = settings.get("state/claude/@session");
                resumeSession(id || saved, { account: account != null ? account
                    : !id || id == saved ? settings.get("state/claude/@sessionAccount") || "" : "" });
            },
            /**
             * The account of the current chat: "" (the default account) or
             * the folder name of an added account.
             * @property {String} account
             * @readonly
             */
            get account() { return chatAccount; },
            /**
             * The folder of the current chat ("" for the workspace).
             * @property {String} folder
             * @readonly
             */
            get folder() { return chatFolder; },
            /**
             * Starts a new chat in a folder (a path of the editor, e.g. "/src").
             * @param {String} path
             */
            newChatIn: newChatIn,
            /**
             * Checks again where claude is installed.
             */
            refresh: refreshStatus
        });

        register(null, {
            claude: plugin
        });
    }
});

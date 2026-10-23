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
        "layout", "ace"
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

        var markdown = require("./markdown");
        var images = require("./images");
        var diff = require("./diff");

        /***** Constants *****/

        var MODELS = [
            { value: "default", caption: "Default" },
            { value: "opus", caption: "Opus" },
            { value: "sonnet", caption: "Sonnet" },
            { value: "haiku", caption: "Haiku" }
        ];
        // "": no --permission-mode flag, the CLI uses the user's own default
        // (defaultMode in ~/.claude/settings.json); the label then shows the
        // mode the CLI reports
        var MODES = [
            { value: "", caption: "Mode from Claude's settings", short: "Mode" },
            { value: "default", caption: "Ask before edits", short: "Ask" },
            { value: "acceptEdits", caption: "Accept edits", short: "Accept edits" },
            { value: "plan", caption: "Plan mode", short: "Plan" }
        ];
        var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        var LOGIN_RE = /\/login\b|not logged in|invalid api key|authentication_error|oauth token|please run .{0,20}login/i;
        var BILLING_RE = /credit balance|billing|payment required|insufficient credit/i;
        var MAX_ATTACHMENTS = 10;
        var RENDER_DELAY = 60;          // markdown re-render throttle while streaming (ms)
        var PREVIEW_LINES = 60;         // Write previews
        var INSTALL_HELP = "Install Claude Code with `curl -fsSL https://claude.ai/install.sh | bash` "
            + "or `npm install -g @anthropic-ai/claude-code`, then log in once by running `claude` in a terminal.";

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
            thinking: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M5.5 12.5h5M6.3 14.3h3.4M8 1.8a4.4 4.4 0 0 0-2.6 8c.4.3.6.7.6 1.2v.3h4v-.3c0-.5.2-.9.6-1.2A4.4 4.4 0 0 0 8 1.8z"/></svg>'
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
        var root, header, statusDot, statusText, modelSelect, modeSelect, btnNew, btnHistory, historyMenu;
        var logEl, welcomeEl, jumpBtn, composer, attachRow, textarea, btnAttach, btnSend, fileInput, dropOverlay;

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
        var activity = "";              // status detail while busy
        var hasMessages = false;
        var lastTotalCost = 0;
        var lastResultError = false;    // the last turn ended with an error that is shown

        var loaded = false;
        function load() {
            if (loaded) return false;
            loaded = true;

            plugin.setCommand({
                name: "toggleclaude",
                hint: "show the Claude panel"
            });

            settings.on("read", function() {
                settings.setDefaults("user/claude", [
                    ["path", ""],
                    ["model", "default"],
                    ["mode", ""]
                ]);
                settings.setDefaults("state/claude", [
                    ["session", ""],
                    ["title", ""]
                ]);
                updateButton();
            }, plugin);

            settings.on("user/claude/@path", function() {
                binChecked = false;
                refreshStatus();
            }, plugin);

            prefs.add({
                "General": {
                    "Claude": {
                        position: 950,
                        "Path to the claude CLI (empty: find it automatically)": {
                            type: "textbox",
                            path: "user/claude/@path",
                            position: 100
                        }
                    }
                }
            }, plugin);

            layout.on("themeChange", function() {
                updateButton();
            }, plugin);
            aceHandle.on("themeChange", function() {
                updateCodeTheme();
            }, plugin);
            settings.on("user/ace", updateCodeFont, plugin);

            c9.on("connect", function() {
                if (drawn) loadRemote();
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
                    stream.on("data", function(chunk) {
                        var events;
                        try {
                            events = JSON.parse(chunk);
                        } catch (e) {
                            return console.error("[claude] bad event from the service", e);
                        }
                        if (!Array.isArray(events)) events = [events];
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

            ui.insertCss(require("text!./claude.less"), options.staticPrefix, plugin);

            root = el("div", { className: "claude-root" });
            e.html.appendChild(root);
            updateCodeFont();

            // header
            statusDot = el("span", { className: "claude-status-dot" });
            statusText = el("span", { className: "claude-status-text", text: "Claude" });
            modelSelect = select("claude-model", MODELS, "Model", onModelChange);
            modeSelect = select("claude-mode", MODES, "Permission mode", onModeChange);
            btnNew = iconButton("plus", "New session", newSession);
            btnHistory = iconButton("history", "Session history", function() {});
            btnHistory.setAttribute("aria-haspopup", "true");
            attachMenu(btnHistory, buildHistoryMenu);
            header = el("div", { className: "claude-header" }, [
                el("div", { className: "claude-status" }, [statusDot, statusText]),
                el("div", { className: "claude-header-tools" }, [modelSelect.wrapper, modeSelect.wrapper, btnNew, btnHistory])
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

            // composer
            attachRow = el("div", { className: "claude-attachments" });
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
            composer = el("div", { className: "claude-composer" }, [
                el("div", { className: "claude-composer-box" }, [
                    attachRow,
                    textarea,
                    el("div", { className: "claude-composer-bar" }, [
                        btnAttach,
                        el("span", { className: "claude-composer-hint", text: "Enter to send, Shift+Enter for a new line" }),
                        btnSend
                    ])
                ]),
                fileInput
            ]);
            root.appendChild(composer);
            composer.addEventListener("click", function(e) {
                if (e.target == composer || e.target.classList.contains("claude-composer-box"))
                    textarea.focus();
            });

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

            setSelect(modelSelect, settings.get("user/claude/@model") || "default");
            setSelect(modeSelect, settings.get("user/claude/@mode") || "");

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

        /***** Menus: Cloud9's own, so that every skin styles them *****/

        function newMenu(className) {
            var menu = new ui.menu({ "class": "claude-menu " + className });
            plugin.addElement(menu);
            return menu;
        }

        function clearMenu(menu) {
            menu.childNodes.slice().forEach(function(node) {
                node.destroy(true, true);
            });
        }

        function infoItem(menu, caption) {
            return menu.appendChild(new ui.item({ caption: caption, disabled: true }));
        }

        // Opens the menu that build() returns under the button. Keyboard: the
        // button opens it with Enter or Space, the arrows move, Enter picks,
        // Escape closes and gives the focus back to the button.
        function attachMenu(button, build) {
            var lastHide = 0;
            var byKeyboard = false;
            var menu = null;
            var closedByThisClick = false;
            button.addEventListener("mousedown", function() {
                // a mousedown outside an open menu closes it (before or after
                // this handler, depending on the phase): no reopening on click
                closedByThisClick = !!(menu && menu.visible) || Date.now() - lastHide < 100;
            });
            button.addEventListener("click", function(e) {
                e.preventDefault();
                if (button.disabled) return;
                if (closedByThisClick && e.detail !== 0) {
                    closedByThisClick = false;
                    return;
                }
                byKeyboard = e.detail === 0;
                menu = build();
                if (!menu.claudeButton) {
                    menu.claudeButton = button;
                    menu.on("prop.visible", function(ev) {
                        button.classList.toggle("claude-open", !!ev.value);
                        button.setAttribute("aria-expanded", ev.value ? "true" : "false");
                        if (!ev.value) {
                            lastHide = Date.now();
                            if (byKeyboard) setTimeout(function() { button.focus(); }, 0);
                        }
                    });
                }
                var r = button.getBoundingClientRect();
                menu.display(r.left, r.bottom + 2);
                placeMenu(menu);
                if (byKeyboard) highlightCurrent(menu);
            });
        }

        // keyboard opening: the current choice is highlighted, as in a list
        function highlightCurrent(menu) {
            var items = menu.childNodes.filter(function(n) {
                return n.localName == "item" && !n.disabled;
            });
            var current = items.filter(function(n) { return n.checked; })[0] || items[0];
            if (current && current.$ext) {
                menu.$selected = current;
                ui.setStyleClass(current.$ext, "hover");
            }
        }

        // under its button, kept inside the window
        function placeMenu(menu) {
            var ext = menu.$ext;
            var button = menu.claudeButton;
            if (!ext || !button) return;
            var r = button.getBoundingClientRect();
            // natural width: at its old place near the window edge the
            // (shrink-to-fit) menu would be squeezed
            ext.style.left = "0px";
            var w = ext.offsetWidth;
            var left = r.left;
            if (left + w > window.innerWidth - 6)
                left = Math.max(6, Math.min(r.right, window.innerWidth - 6) - w);
            ext.style.left = left + "px";
        }

        // a header button with a menu of choices (model, permission mode)
        function select(className, items, title, onchange) {
            var label = el("span", { className: "claude-select-label" });
            var button = el("button", { type: "button", className: "claude-select " + className,
                title: title, "aria-haspopup": "true" }, [label]);
            var node = { value: "", items: items.slice(), wrapper: button, menu: null };
            node.find = function(value) {
                return node.items.filter(function(i) { return i.value == value; })[0];
            };
            node.syncLabel = function() {
                var item = node.find(node.value);
                label.textContent = item ? item.short || item.caption : node.value;
                button.title = title + (item ? ": " + item.caption : node.value ? ": " + node.value : "");
            };
            attachMenu(button, function() {
                if (!node.menu) node.menu = newMenu("claude-choice-menu");
                // rebuilt each time: modes the CLI reports join the list
                clearMenu(node.menu);
                node.items.forEach(function(item) {
                    node.menu.appendChild(new ui.item({
                        type: "check",
                        caption: item.caption,
                        checked: item.value == node.value,
                        onclick: function() {
                            node.value = item.value;
                            node.syncLabel();
                            onchange(item.value);
                        }
                    }));
                });
                return node.menu;
            });
            return node;
        }

        function setSelect(node, value) {
            value = value == null ? "" : String(value);
            // a mode the panel does not offer (e.g. bypassPermissions from the
            // user's settings): show it as it is
            if (value && !node.find(value))
                node.items.push({ value: value, caption: value });
            node.value = node.find(value) ? value : node.items[0].value;
            node.syncLabel();
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
        function buildHistoryMenu() {
            if (!historyMenu) {
                historyMenu = newMenu("claude-history-menu");
                historyMenu.on("display", applyHistoryMeta);
            }
            clearMenu(historyMenu);
            historyMenu.claudeMeta = [];
            if (!api) {
                infoItem(historyMenu, "Not connected to the server");
                return historyMenu;
            }
            infoItem(historyMenu, "Loading sessions…");
            api.sessions(function(err, res) {
                clearMenu(historyMenu);
                historyMenu.claudeMeta = [];
                var list = !err && res && Array.isArray(res.sessions) ? res.sessions : [];
                if (err)
                    infoItem(historyMenu, "Could not read the sessions: " + (err.message || err));
                else if (!list.length)
                    infoItem(historyMenu, "No Claude Code sessions in this workspace yet.");
                list.forEach(function(item) {
                    if (!item || !UUID_RE.test(item.id || "")) return;
                    var title = String(item.title || "Untitled");
                    var when = relativeTime(item.mtime, res.now || Date.now());
                    var meta = [item.folder, when].filter(Boolean).join(" · ");
                    var mi = historyMenu.appendChild(new ui.item({
                        type: "check",
                        caption: title.length > 64 ? title.slice(0, 63) + "…" : title,
                        checked: item.id == sessionId,
                        onclick: function() {
                            if (item.id != sessionId) resumeSession(item.id, item);
                        }
                    }));
                    historyMenu.claudeMeta.push({ item: mi, text: meta, tip: title
                        + "\n" + (item.folder ? "Folder: " + item.folder + "\n" : "")
                        + "Last activity: " + new Date(item.mtime).toLocaleString()
                        + (item.recent ? " (it may still be open)" : "") });
                });
                applyHistoryMeta();
                if (historyMenu.visible) placeMenu(historyMenu);
            });
            return historyMenu;
        }

        // the folder and the time go in the item's right-hand (shortcut) column
        function applyHistoryMeta() {
            (historyMenu.claudeMeta || []).forEach(function(m) {
                if (m.item.$hotkey) m.item.$hotkey.textContent = m.text;
                if (m.item.$ext) m.item.$ext.title = m.tip;
            });
        }

        function codeSpan(text) {
            return el("code", { className: "claude-inline-code", text: text });
        }

        /***** Paths *****/

        function workspacePath(file) {
            if (!file) return null;
            file = String(file);
            var ws = c9.workspaceDir.replace(/\/$/, "");
            if (file == ws) return "/";
            if (file.indexOf(ws + "/") === 0)
                return file.slice(ws.length);
            var home = (c9.home || "").replace(/\/$/, "");
            if (home && file.indexOf(home + "/") === 0)
                return "~" + file.slice(home.length);
            if (/^~\//.test(file))
                return file;
            if (!/^\//.test(file)) {
                // relative to the workspace (the CLI's cwd)
                var rel = file.replace(/^\.\//, "");
                if (/(^|\/)\.\.(\/|$)/.test(rel)) return null;
                return "/" + rel;
            }
            return null;
        }

        function displayPath(file) {
            var wsPath = workspacePath(file);
            if (wsPath && wsPath.charAt(0) == "/" && wsPath != "/")
                return wsPath.slice(1);
            return wsPath || String(file || "");
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
                    else flashHint("Only files in the workspace or the home folder can be opened");
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
            else if (busy) { text = activity || "Working…"; state = "busy"; }
            else if (sessionId) { text = "Ready"; state = "ready"; }
            else { text = "New session"; state = "ready"; }
            statusText.textContent = text;
            statusText.title = sessionId ? "Session " + sessionId : "";
            statusDot.className = "claude-status-dot claude-" + state;

            btnHistory.disabled = !api;
            btnNew.disabled = !hasMessages && !sessionId;

            var showStop = busy || stopping;
            btnSend.innerHTML = "";
            btnSend.appendChild(icon(showStop ? "stop" : "send"));
            btnSend.title = showStop ? "Stop (Esc)" : "Send (Enter)";
            btnSend.classList.toggle("claude-stop", showStop);
            btnSend.disabled = !showStop && !textarea.value.trim() && !attachments.length;
        }

        function setActivity(text) {
            activity = text;
            updateStatus();
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
                        resumeSession(saved);
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

        function finishTurn() {
            if (!turn) return;
            Object.keys(turn.msgs).forEach(function(id) {
                var msg = turn.msgs[id];
                msg.textBlocks.concat(msg.thinkingBlocks).forEach(function(block) { block.finish(); });
            });
            Object.keys(toolCards).forEach(function(id) {
                var card = toolCards[id];
                if (card.status == "running" || card.status == "waiting")
                    card.setStatus("stopped");
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

        function createThinkingBlock() {
            var t = ensureTurn();
            var body = el("div", { className: "claude-thinking-body" });
            var card = el("div", { className: "claude-thinking" });
            var head = el("div", { className: "claude-thinking-head" }, [
                icon("thinking"), el("span", { text: "Thinking" }), icon("chevron", "claude-chevron")
            ]);
            head.addEventListener("click", function() { card.classList.toggle("claude-expanded"); });
            card.appendChild(head);
            card.appendChild(body);
            card.style.display = "none"; // shown once it has text (thinking can be redacted)
            t.el.appendChild(card);
            var block = { el: card, text: "", done: false };
            block.append = function(text) {
                block.text += text;
                update();
            };
            block.setText = function(text) {
                block.text = text || block.text;
                update();
            };
            block.finish = function() {
                block.done = true;
                if (!block.text.trim() && card.parentNode) card.parentNode.removeChild(card);
            };
            function update() {
                if (!block.text.trim()) return;
                card.style.display = "";
                body.textContent = block.text;
            }
            setActivity("Thinking…");
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

        function codePreview(text, path, maxLines) {
            text = String(text == null ? "" : text);
            var lines = text.split("\n");
            var more = 0;
            if (maxLines && lines.length > maxLines) {
                more = lines.length - maxLines;
                text = lines.slice(0, maxLines).join("\n");
            }
            var code = el("code", { text: text });
            var pre = el("pre", { className: codeThemeClass() }, [code]);
            var wrap = el("div", { className: "claude-code claude-code-plain" }, [pre]);
            if (more)
                wrap.appendChild(el("div", { className: "claude-code-more", text: "… " + more + " more lines" }));
            var lang = path ? String(path).split(/[\/\\]/).pop().split(".").pop() : "";
            if (path && /\./.test(String(path).split(/[\/\\]/).pop()))
                markdown.highlight(code, lang);
            return wrap;
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
                    parts.push(codePreview(input.command, "command.sh", 40));
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
            var node = el("div", { className: "claude-tool claude-running" });
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
                if (name == "Bash" || name == "Task" || name == "Agent")
                    setActivity((name == "Bash" ? "Running " : "Agent: ") + firstLine(name == "Bash"
                        ? card.input.description || card.input.command : card.input.description, 40) + "…");
                else if (card.status == "running")
                    setActivity(info.verb + "…");
            };
            card.setStatus = function(status) {
                card.status = status;
                node.className = node.className.replace(/\bclaude-(running|waiting|ok|error|denied|stopped)\b/g, "").trim()
                    + " claude-" + status;
                statusEl.textContent = "";
                if (status == "error") statusEl.appendChild(icon("error"));
                else if (status == "denied") statusEl.textContent = "Denied";
                else if (status == "stopped") statusEl.textContent = "Stopped";
                else if (status == "waiting") statusEl.textContent = name == "AskUserQuestion" ? "Needs an answer" : "Needs approval";
                card.updateTitle();
            };
            card.setResult = function(content, isError) {
                var text = resultText(content);
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
                setActivity("Agent: " + sub.verb + "…");
            };
            card.updateTitle();
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

        function showPermission(message) {
            var id = message.request_id;
            var req = message.request || {};
            if (!id || permCards[id]) return;
            var name = req.tool_name;
            var input = req.input || {};
            var toolCard = req.tool_use_id && toolCards[req.tool_use_id];
            if (toolCard) {
                toolCard.setStatus("waiting");
                // the prompt shows the preview: do not show it twice
                toolCard.toggle(false);
            }

            var actions = el("div", { className: "claude-actions" });
            var stateEl = el("div", { className: "claude-perm-state" });
            var node = el("div", { className: "claude-perm" }, [
                el("div", { className: "claude-perm-title" }, [
                    icon(name == "AskUserQuestion" ? "question" : "shield", "claude-perm-icon"),
                    el("span", { className: "claude-perm-text" }, permissionTitle(name, input, req.display_name))
                ])
            ]);
            var desc = req.description && name != "AskUserQuestion" && req.description != input.file_path
                && !(name == "Write" || name == "Edit" || name == "MultiEdit") ? req.description : null;
            if (name == "Bash" && input.description) desc = input.description;
            if (desc)
                node.appendChild(el("div", { className: "claude-perm-desc", text: desc }));
            if (req.decision_reason && typeof req.decision_reason == "string")
                node.appendChild(el("div", { className: "claude-perm-desc", text: req.decision_reason }));
            if (req.blocked_path)
                node.appendChild(el("div", { className: "claude-perm-desc" }, ["Path: ", fileLink(req.blocked_path)]));

            var card = { id: id, el: node, pending: true, toolCard: toolCard };
            permCards[id] = card;

            var answers = {};
            if (name == "AskUserQuestion") {
                node.appendChild(questionForm(input.questions || [], answers, function() { decide("allow"); }));
            }
            else {
                var preview = name == "Bash"
                    ? codePreview(input.command, "command.sh", 40)
                    : inputPreview(name, input, true);
                if (preview) node.appendChild(el("div", { className: "claude-perm-preview" }, [preview]));
            }

            var buttons = [];
            function decide(behavior) {
                if (!card.pending) return;
                if (!api) return showError("Not connected to the Claude service");
                buttons.forEach(function(b) { b.disabled = true; });
                var decision = { behavior: behavior };
                if (name == "AskUserQuestion" && behavior == "allow") decision.answers = answers;
                api.respond(id, decision, function(err) {
                    if (err) {
                        card.resolve("expired");
                        return;
                    }
                    card.resolve(behavior);
                });
            }
            if (name == "AskUserQuestion") {
                buttons.push(textButton("Submit answers", "claude-btn-primary", function() { decide("allow"); }));
                buttons.push(textButton("Skip", "claude-btn-secondary", function() { decide("deny"); }));
            }
            else {
                buttons.push(textButton(name == "ExitPlanMode" ? "Yes, start" : "Allow", "claude-btn-primary", function() { decide("allow"); }, "Allow this once"));
                var label = suggestionLabel(req.permission_suggestions);
                if (label)
                    buttons.push(textButton(label, "claude-btn-secondary", function() { decide("allowAlways"); }));
                buttons.push(textButton(name == "ExitPlanMode" ? "No, keep planning" : "Deny", "claude-btn-secondary claude-btn-deny", function() { decide("deny"); }));
            }
            buttons.forEach(function(b) { actions.appendChild(b); });
            node.appendChild(actions);
            node.appendChild(stateEl);

            card.resolve = function(how) {
                if (!card.pending) return;
                card.pending = false;
                node.classList.add("claude-resolved");
                actions.style.display = "none";
                var text = {
                    allow: name == "AskUserQuestion" ? "Answered" : "Allowed",
                    allowAlways: "Allowed · " + (label || "remembered"),
                    deny: name == "AskUserQuestion" ? "Skipped" : "Denied",
                    stopped: "Denied (stopped)",
                    cancelled: "No longer needed",
                    expired: "This request is no longer pending"
                }[how] || how;
                stateEl.textContent = text;
                node.classList.add("claude-perm-" + (how == "allowAlways" ? "allow" : how));
                if (card.toolCard) {
                    if (how == "allow" || how == "allowAlways") {
                        card.toolCard.setStatus("running");
                        if (EXPANDED_BY_DEFAULT[name]) card.toolCard.toggle(true);
                    }
                    else if (how == "deny" || how == "stopped") card.toolCard.setStatus("denied");
                    // the tool card shows the outcome; keep only what is worth knowing
                    if (how != "expired" && node.parentNode) {
                        if (how == "allowAlways")
                            node.parentNode.insertBefore(el("div", { className: "claude-notice claude-notice-quiet",
                                text: rememberedText(req.permission_suggestions, label) }), node);
                        node.parentNode.removeChild(node);
                    }
                }
                updateStatus();
            };

            if (toolCard && toolCard.el.parentNode) {
                toolCard.el.parentNode.insertBefore(node, toolCard.el.nextSibling);
            }
            else {
                appendTo(node);
            }
            hasMessages = true;
            updateStatus();
            autoScroll = true;
            scrollToEnd(true);
            // focus the first button only when the panel already has the focus
            var first = buttons[0];
            if (first && root.contains(document.activeElement) && document.activeElement != textarea) {
                try { first.focus({ preventScroll: true }); } catch (e) {}
            }
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
            if ((event.ev == "msg" || event.ev == "control" || event.ev == "notice")
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
                        if (m.session_id) setSession(m.session_id);
                        if (m.permissionMode) syncMode(m.permissionMode);
                    }
                    else if (m.subtype == "status") {
                        if (m.permissionMode) syncMode(m.permissionMode);
                        if (m.status == "compacting") setActivity("Compacting the conversation…");
                    }
                    else if (m.subtype == "compact_boundary") {
                        showNotice("The conversation was compacted", "claude-notice-quiet");
                    }
                    else if (m.subtype == "task_summary" && m.detail && busy) {
                        setActivity(firstLine(m.detail, 60));
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
                        setActivity("Writing…");
                    }
                    else if (block.type == "thinking") {
                        var th = createThinkingBlock();
                        msg.thinkingBlocks.push(th);
                        msg.byIndex[event.index] = th;
                    }
                    else if (block.type == "tool_use" || block.type == "server_tool_use") {
                        var card = ensureToolCard(block.id, block.name);
                        msg.byIndex[event.index] = card;
                        setActivity(toolInfo(block.name).verb + "…");
                    }
                    break;
                case "content_block_delta":
                    msg = turn && turn.current;
                    var target = msg && msg.byIndex[event.index];
                    var delta = event.delta || {};
                    if (!target || !target.append) break;
                    if (delta.type == "text_delta") target.append(delta.text || "");
                    else if (delta.type == "thinking_delta") target.append(delta.thinking || "");
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
                else if (block.type == "thinking") {
                    var th = msg.streamed && msg.thinkingBlocks[msg.thinkingDone];
                    if (!th) {
                        if (!block.thinking) return;
                        th = createThinkingBlock();
                        msg.thinkingBlocks.push(th);
                    }
                    msg.thinkingDone++;
                    th.setText(block.thinking || "");
                    th.finish();
                }
                else if (block.type == "tool_use" || block.type == "server_tool_use") {
                    var card = ensureToolCard(block.id, block.name);
                    card.setInput(block.input);
                }
                else if (/_tool_result$/.test(block.type || "") && block.tool_use_id && toolCards[block.tool_use_id]) {
                    var server = toolCards[block.tool_use_id];
                    server.setStatus(block.content && block.content.type && /error/.test(block.content.type) ? "error" : "ok");
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
                    if (!fromHistory) setActivity("Working…");
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
                finishTurn();
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
            var bits = [];
            if (aborted) bits.push("Stopped");
            if (cost != null && (cost > 0 || !aborted && !m.is_error)) bits.push(formatCost(cost));
            if (m.duration_ms) bits.push(formatDuration(m.duration_ms));
            if (t && bits.length)
                t.el.appendChild(el("div", { className: "claude-turn-footer", text: bits.join(" · "),
                    title: m.num_turns ? m.num_turns + " model calls" + (typeof m.total_cost_usd == "number"
                        ? ", " + formatCost(m.total_cost_usd) + " since claude started" : "") : "" }));
            busy = false;
            stopDone();
            finishTurn();
            setActivity("");
            scrollToEnd();
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
        }

        function onPaste(e) {
            var files = images.filesFrom(e.clipboardData);
            if (!files.length) return;
            e.preventDefault();
            addFiles(files);
        }

        var hintTimer;
        function flashHint(text) {
            var hint = composer.querySelector(".claude-composer-hint");
            hint.textContent = text;
            hint.classList.add("claude-hint-alert");
            clearTimeout(hintTimer);
            hintTimer = setTimeout(function() {
                hint.textContent = "Enter to send, Shift+Enter for a new line";
                hint.classList.remove("claude-hint-alert");
            }, 3500);
        }

        function addFiles(files) {
            files.forEach(function(file) {
                if (attachments.length >= MAX_ATTACHMENTS)
                    return flashHint("At most " + MAX_ATTACHMENTS + " images per message");
                var item = { name: file.name || "image", loading: true };
                attachments.push(item);
                var thumb = el("div", { className: "claude-thumb claude-loading", title: item.name });
                var remove = iconButton("close", "Remove", function() {
                    var i = attachments.indexOf(item);
                    if (i != -1) attachments.splice(i, 1);
                    if (thumb.parentNode) thumb.parentNode.removeChild(thumb);
                    updateAttachments();
                });
                remove.classList.add("claude-thumb-remove");
                thumb.appendChild(remove);
                item.el = thumb;
                attachRow.appendChild(thumb);
                updateAttachments();
                images.prepare(file, function(err, image) {
                    if (attachments.indexOf(item) == -1) return;
                    if (err) {
                        attachments.splice(attachments.indexOf(item), 1);
                        if (thumb.parentNode) thumb.parentNode.removeChild(thumb);
                        updateAttachments();
                        return flashHint(err.message);
                    }
                    item.loading = false;
                    item.mediaType = image.mediaType;
                    item.data = image.data;
                    item.width = image.width;
                    item.height = image.height;
                    thumb.classList.remove("claude-loading");
                    var img = el("img", { alt: item.name });
                    img.src = "data:" + image.mediaType + ";base64," + image.data;
                    thumb.insertBefore(img, remove);
                    thumb.title = item.name + " · " + image.width + "×" + image.height
                        + " · " + Math.round(image.size / 1024) + " KB" + (image.resized ? " (resized)" : "");
                    updateAttachments();
                });
            });
            textarea.focus();
        }

        function updateAttachments() {
            attachRow.style.display = attachments.length ? "" : "none";
            updateStatus();
        }

        function clearAttachments() {
            attachments = [];
            attachRow.textContent = "";
            updateAttachments();
        }

        function onSendButton() {
            if (busy || stopping) interrupt();
            else submit();
        }

        var queued = null;          // a message typed while Claude was working
        var pendingTitle = null;

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
            hasSentInSession = true;
            lastResultError = false;
            startTurn();
            busy = true;
            autoScroll = true;
            setActivity(running ? "Thinking…" : "Starting claude…");
            scrollToEnd(true);

            api.send({
                content: content,
                options: {
                    model: modelSelect.value,
                    // only a mode the user picked; the label may show the CLI's
                    mode: settings.get("user/claude/@mode") || "",
                    resume: sessionId,
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

        /***** Model and mode *****/

        function onModelChange(value) {
            settings.set("user/claude/@model", value);
            if (api && running) {
                api.setModel(value, function(err) {
                    if (err) showError("Could not change the model: " + err.message);
                });
            }
        }

        function onModeChange(value) {
            settings.set("user/claude/@mode", value);
            if (api && running && value) {
                api.setMode(value, function(err) {
                    if (err) showError("Could not change the permission mode: " + err.message);
                });
            }
        }

        /***** Sessions *****/

        function clearChat() {
            finishTurn();
            toolCards = Object.create(null);
            permCards = Object.create(null);
            [].slice.call(logEl.childNodes).forEach(function(node) {
                if (node != welcomeEl) logEl.removeChild(node);
            });
            hasMessages = false;
            hasSentInSession = false;
            queued = null;
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

        function newSession() {
            stopProcess();
            clearChat();
            sessionId = null;
            pendingTitle = null;
            setSelect(modeSelect, settings.get("user/claude/@mode") || "");
            renderWelcome();
            updateStatus();
            textarea.focus();
        }

        // info: the entry of the session list, when picked there
        function resumeSession(id, info) {
            if (!UUID_RE.test(id || "")) return;
            stopProcess();
            clearChat();
            sessionId = id;
            hasSentInSession = true;
            setSelect(modeSelect, settings.get("user/claude/@mode") || "");
            var title = info && info.title ? String(info.title) : "";
            var name = title ? "\u201c" + (title.length > 60 ? title.slice(0, 59) + "\u2026" : title) + "\u201d"
                : "session " + id.slice(0, 8);
            var notice = showNotice("Resuming " + name + "\u2026", "claude-notice-quiet");
            updateStatus();
            if (!api) return;
            api.history(id, function(err, res) {
                if (sessionId != id) return;
                if (err || !res || !res.found) {
                    notice.textContent = "Resumed " + name
                        + ". Its earlier messages are not available here; Claude still remembers them.";
                    return;
                }
                notice.textContent = "Resumed " + name + (res.folder ? " (in " + res.folder + ")" : "")
                    + (res.truncated ? "; older messages are not shown" : "");
                renderHistory(res.messages || []);
                if (res.fork)
                    showNotice("This session was active in the last 2 minutes, probably in a terminal. "
                        + "It continues here in a copy, so the two do not mix.", "claude-notice-warn");
            });
            textarea.focus();
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
            finishTurn();
            [].forEach.call(logEl.querySelectorAll(".claude-tool.claude-stopped"), function(n) {
                n.classList.remove("claude-stopped");
            });
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
            resume: function(id) {
                resumeSession(id || settings.get("state/claude/@session"));
            },
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

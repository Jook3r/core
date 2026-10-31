/**
 * Inline completions: DeepSeek's suggestion for the code at the cursor,
 * shown greyed out in the editor ("ghost text", Editor.setGhostText).
 * Tab accepts it, Ctrl-Right (Cmd-Right on a Mac) its next word, Esc
 * dismisses it, and typing what it shows goes on with the rest.
 *
 * The suggestions come from DeepSeek's fill-in-the-middle API, through the
 * DeepSeek panel's service with the key of the panel's account (see
 * deepseek.complete()): the code before the cursor and after it go to
 * DeepSeek, never the key to the browser. As you type, a request waits for a
 * pause, a newer one cancels it, and the code sent starts at a row that stays
 * the same for a while, so that DeepSeek's cache serves most of it at a
 * fraction of the price.
 *
 * Preferences > General > DeepSeek Inline Completions: off (the default), as
 * you type, or only when asked (Alt-\ / Option-\), the model, off-peak
 * hours only, the files never sent.
 */
define(function(require, exports, module) {
    "use strict";

    main.consumes = [
        "Plugin", "settings", "preferences", "tabManager", "commands", "ui",
        "deepseek", "language.complete", "dialog.error"
    ];
    main.provides = ["deepseek.inline"];
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var settings = imports.settings;
        var prefs = imports.preferences;
        var tabs = imports.tabManager;
        var commands = imports.commands;
        var ui = imports.ui;
        var deepseek = imports.deepseek;
        var complete = imports["language.complete"];
        var showError = imports["dialog.error"].show;

        var HashHandler = require("ace/keyboard/hash_handler").HashHandler;
        var isMac = require("ace/lib/useragent").isMac;

        /***** Initialization *****/

        var plugin = new Plugin("Ajax.org", main.consumes);
        var emit = plugin.getEmitter();

        var SETTINGS = "user/deepseek/inline";
        var PREFIX_MAX = 8000;      // characters of code before the cursor sent
        var SUFFIX_MAX = 2000;      // and after it
        var BAND = 32;              // the code sent starts at a row that is a multiple of this
        var TIMEOUT = 30000;        // a request without an answer by then is forgotten
        var ERROR_PAUSE = 60000;    // after an error, suggestions as you type wait this long
        var ERROR_REPEAT = 10 * 60000; // and the same error is shown again after this long
        var DEFAULT_EXCLUDE = ".env, .env.*, *.pem, *.key, *.p12, *.pfx, id_rsa*, id_ecdsa*, id_ed25519*, *.gpg, *.kdbx";
        // as you type, only where the rest of the line is closing brackets,
        // quotes and the like (not in the middle of a word or a line)
        var LINE_END_RE = /^[\s)\]}>'"`;,]*$/;

        var tab = null;             // the focused tab, if it is a file in the code editor
        var ace = null;             // and its Ace editor
        var ghost = null;           // the suggestion shown: { ace, session, row, column, text, line }
        var timer = null;
        var changes = 0;            // document changes in the editor, to tell a stale answer
        var requestId = 0;
        var waiting = null;         // the request in flight: { id, at }
        var pausedUntil = 0;
        var shownErrors = {};
        var stats = { count: 0, usd: 0, unpriced: false, hit: 0, miss: 0 };
        var statsBar = null;

        // the keys while a suggestion is shown, before the editor's own
        var keys = new HashHandler();
        keys.addCommand({
            name: "inlineCompletionAccept",
            bindKey: "Tab",
            exec: function() { return accept(false); }
        });
        keys.addCommand({
            name: "inlineCompletionAcceptWord",
            bindKey: { win: "Ctrl-Right", mac: "Command-Right" },
            exec: function() { return accept(true); }
        });
        keys.addCommand({
            name: "inlineCompletionDismiss",
            bindKey: "Esc",
            exec: function() {
                // the editor's completion list closes first
                if (complete.isPopupVisible()) return false;
                cancel();
                hide();
            }
        });

        var loaded = false;
        function load() {
            if (loaded) return false;
            loaded = true;

            settings.on("read", function() {
                settings.setDefaults(SETTINGS, [
                    ["mode", "off"],
                    ["model", "deepseek-flash"],
                    ["offPeakOnly", false],
                    ["delay", 400],
                    ["maxTokens", 128],
                    ["exclude", DEFAULT_EXCLUDE]
                ]);
            }, plugin);
            settings.on(SETTINGS, function() {
                if (mode() == "off") {
                    cancel();
                    hide();
                }
                pausedUntil = 0;
                shownErrors = {};
            }, plugin);

            prefs.add({
                "General": {
                    "DeepSeek Inline Completions": {
                        position: 965,
                        "Suggest code in the editor": {
                            type: "dropdown",
                            path: SETTINGS + "/@mode",
                            width: 230,
                            position: 100,
                            items: [
                                { caption: "Off", value: "off" },
                                { caption: "As you type", value: "auto" },
                                { caption: "When asked (" + (isMac ? "Option" : "Alt") + "-\\)", value: "manual" }
                            ]
                        },
                        "Model": {
                            type: "textbox",
                            path: SETTINGS + "/@model",
                            position: 200
                        },
                        "As you type only off-peak": {
                            type: "checkbox",
                            path: SETTINGS + "/@offPeakOnly",
                            position: 300
                        },
                        "Wait after typing (ms)": {
                            type: "spinner",
                            path: SETTINGS + "/@delay",
                            min: 100,
                            max: 5000,
                            position: 400
                        },
                        "Longest suggestion (tokens)": {
                            type: "spinner",
                            path: SETTINGS + "/@maxTokens",
                            min: 16,
                            max: 1024,
                            position: 500
                        },
                        "Never send these files": {
                            type: "textbox",
                            path: SETTINGS + "/@exclude",
                            position: 600
                        },
                        "This session": {
                            type: "custom",
                            position: 700,
                            node: statsBar = new ui.bar({ "class": "ds-inline-stats" })
                        }
                    }
                }
            }, plugin);
            statsBar.on("DOMNodeInsertedIntoDocument", renderStats);

            commands.addCommand({
                name: "inlinesuggest",
                group: "DeepSeek",
                bindKey: { mac: "Option-\\", win: "Alt-\\" },
                hint: "suggest code at the cursor (DeepSeek inline completion)",
                isAvailable: function(editor) {
                    return !!(editor && editor.ace);
                },
                exec: function() {
                    if (mode() == "off") {
                        return showError("Inline completions are off: turn them on in "
                            + "Preferences > General > DeepSeek Inline Completions");
                    }
                    attach(tabs.focussedTab);
                    if (ace) request(snapshot(), true);
                }
            }, plugin);

            tabs.on("focusSync", function(e) { attach(e.tab); }, plugin);
            tabs.on("tabDestroy", function(e) { if (e.tab == tab) detach(); }, plugin);
            if (tabs.focussedTab) attach(tabs.focussedTab);
        }

        /***** Settings *****/

        function mode() {
            var value = settings.get(SETTINGS + "/@mode");
            return value == "auto" || value == "manual" ? value : "off";
        }

        function model() {
            var value = String(settings.get(SETTINGS + "/@model") || "").trim();
            return /^[A-Za-z0-9._:-]{1,64}$/.test(value) ? value : "deepseek-flash";
        }

        function number(name, min, max, fallback) {
            var value = Math.round(Number(settings.get(SETTINGS + "/@" + name)));
            return isFinite(value) && value >= min && value <= max ? value : fallback;
        }

        // "*.pem, .env": names (or paths, with a /) never sent to DeepSeek
        function excluded(path) {
            var list = String(settings.get(SETTINGS + "/@exclude") || "").split(",");
            var name = path.replace(/^.*\//, "");
            return list.some(function(pattern) {
                pattern = pattern.trim();
                if (!pattern) return false;
                var re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
                    .replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$");
                return pattern.indexOf("/") == -1 ? re.test(name) : re.test(path.replace(/^\//, ""));
            });
        }

        /***** The editor *****/

        function attach(newTab) {
            var editor = newTab && newTab.path && newTab.editorType == "ace" && newTab.editor;
            var newAce = editor && editor.ace || null;
            if (newAce == ace && (newAce ? newTab : null) == tab) return;
            detach();
            if (!newAce) return;
            tab = newTab;
            ace = newAce;
            ace.commands.on("afterExec", onAfterExec);
            ace.on("change", onChange);
            ace.on("changeSelection", onCursor);
            ace.on("changeSession", onLeave);
            ace.on("blur", onLeave);
            ace.on("mousedown", onLeave);
        }

        function detach() {
            cancel();
            hide();
            if (!ace) return;
            ace.commands.off("afterExec", onAfterExec);
            ace.off("change", onChange);
            ace.off("changeSelection", onCursor);
            ace.off("changeSession", onLeave);
            ace.off("blur", onLeave);
            ace.off("mousedown", onLeave);
            ace = null;
            tab = null;
        }

        // a command of the editor's user ran
        function onAfterExec(e) {
            var name = e.command && e.command.name || "";
            if (/^inlineCompletion/.test(name)) return;
            if (ghost && name == "insertstring" && typeThrough(e.args)) return;
            cancel();
            hide();
            if (mode() == "auto" && (name == "insertstring" || name == "backspace"))
                schedule();
        }

        // a change that was not a command: a reload, a collaborator, a formatter
        function onChange() {
            changes++;
            if (!running()) {
                cancel();
                hide();
            }
        }

        function onCursor() {
            if (running()) return;
            var c = ace.getCursorPosition();
            if (ghost && (c.row != ghost.row || c.column != ghost.column)) hide();
            if (waiting && (c.row != waiting.at.row || c.column != waiting.at.column)) cancel();
        }

        function onLeave() {
            cancel();
            hide();
        }

        // whether one of the editor's commands is running
        function running() {
            return !!(ace && ace.curOp && ace.curOp.command && ace.curOp.command.name);
        }

        /***** Suggestions *****/

        function schedule() {
            clearTimeout(timer);
            var at = snapshot();
            timer = setTimeout(function() {
                timer = null;
                if (current(at)) request(at, false);
            }, number("delay", 100, 5000, 400));
        }

        function cancel() {
            clearTimeout(timer);
            timer = null;
            waiting = null;
        }

        // where the cursor is, to tell later whether it moved or the code changed
        function snapshot() {
            var c = ace.getCursorPosition();
            return { ace: ace, session: ace.session, row: c.row, column: c.column, changes: changes };
        }

        function current(at) {
            if (!ace || at.ace != ace || at.session != ace.session || at.changes != changes) return false;
            var c = ace.getCursorPosition();
            return c.row == at.row && c.column == at.column;
        }

        // why no suggestion is asked for now, or ""
        function refusal(at, manual) {
            var m = mode();
            if (m == "off") return "off";
            if (!manual) {
                if (m != "auto") return "only when asked";
                if (Date.now() < pausedUntil) return "paused after an error";
                if (settings.getBool(SETTINGS + "/@offPeakOnly") && deepseek.peak().peak) return "peak hours";
                if (!ace.isFocused()) return "not focused";
                if (!LINE_END_RE.test(at.session.getLine(at.row).slice(at.column))) return "in a line";
            }
            if (!tab || !tab.path) return "not a file";
            if (excluded(tab.path)) return "a file never sent";
            if (!ace.selection.isEmpty() || ace.inMultiSelectMode) return "a selection";
            if (ace.getReadOnly()) return "read only";
            if (ace.tabstopManager) return "a snippet";
            return "";
        }

        function request(at, manual) {
            var why = refusal(at, manual);
            if (why) {
                if (manual) showError("No inline suggestion here: " + why);
                return;
            }
            var ctx = context(at);
            var id = ++requestId;
            waiting = { id: id, at: at };
            emit("request", { prompt: ctx.prompt, suffix: ctx.suffix, manual: manual });
            var timeout = setTimeout(function() {
                if (waiting && waiting.id == id) waiting = null;
            }, TIMEOUT);
            deepseek.complete({
                prompt: ctx.prompt,
                suffix: ctx.suffix,
                model: model(),
                maxTokens: number("maxTokens", 16, 1024, 128)
            }, function(err, res) {
                clearTimeout(timeout);
                if (res) count(res);
                if (!waiting || waiting.id != id) return;
                waiting = null;
                if (err) return failed(err, manual);
                var text = clean(res.text, ctx);
                if (!current(at)) return;
                if (text) show(text);
                else if (manual) showError("DeepSeek has no suggestion here");
            });
        }

        // The code around the cursor: before it whole lines from a row that
        // is a multiple of BAND (the same start for many requests, which
        // DeepSeek's cache serves cheaply), as many as fit in PREFIX_MAX;
        // after it the rest of the line and whole lines up to SUFFIX_MAX.
        function context(at) {
            var session = at.session;
            var line = session.getLine(at.row);
            var start = at.row;
            var size = at.column;
            while (start > 0 && size + session.getLine(start - 1).length + 1 <= PREFIX_MAX) {
                start--;
                size += session.getLine(start).length + 1;
            }
            if (start > 0) start = Math.min(at.row, Math.ceil(start / BAND) * BAND);
            var before = session.getLines(start, at.row - 1);
            before.push(line.slice(0, at.column));

            var after = [line.slice(at.column)];
            size = after[0].length;
            var end = at.row;
            var last = session.getLength() - 1;
            while (end < last && size + session.getLine(end + 1).length + 1 <= SUFFIX_MAX) {
                end++;
                after.push(session.getLine(end));
                size += session.getLine(end).length + 1;
            }
            return {
                prompt: before.join("\n").slice(-PREFIX_MAX),
                suffix: after.join("\n").slice(0, SUFFIX_MAX),
                lineEnd: after[0]
            };
        }

        // no whitespace at the end, nor the end of the line that is already there
        function clean(text, ctx) {
            text = String(text || "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
            var rest = ctx.lineEnd.trim();
            if (rest && text.indexOf("\n") == -1 && text.slice(-rest.length) == rest)
                text = text.slice(0, -rest.length).replace(/\s+$/, "");
            return text.trim() ? text : "";
        }

        function show(text) {
            hide();
            var c = ace.getCursorPosition();
            ghost = { ace: ace, session: ace.session, row: c.row, column: c.column, text: text,
                line: ace.session.getLine(c.row) };
            ace.setGhostText(text, c);
            ace.keyBinding.addKeyboardHandler(keys);
            emit("show", { text: text });
        }

        function hide() {
            if (!ghost) return;
            var g = ghost;
            ghost = null;
            g.ace.removeGhostText();
            g.ace.keyBinding.removeKeyboardHandler(keys);
            emit("hide");
        }

        // Tab: all of it; Ctrl-Right: up to the end of the next word. While
        // the editor's completion list is open, the keys are its.
        function accept(word) {
            if (!ghost || ghost.ace != ace || ghost.session != ace.session || complete.isPopupVisible())
                return false;
            var g = ghost;
            var part = word ? nextWord(g.text) : g.text;
            cancel();
            hide();
            ace.session.insert({ row: g.row, column: g.column }, part);
            var rest = g.text.slice(part.length);
            if (rest) show(rest);
            else if (mode() == "auto") schedule();
            emit("accept", { text: part });
            return true;
        }

        function nextWord(text) {
            var m = /^\s*[\w$]+|^\s*[^\w\s]+|^\s+/.exec(text);
            return m ? m[0] : text;
        }

        // Typing what the suggestion shows keeps the rest of it: when the
        // line got just the typed text there (not also a closing bracket)
        function typeThrough(typed) {
            var g = ghost;
            if (typeof typed != "string" || !typed || /\n/.test(typed) || g.ace != ace || g.session != ace.session)
                return false;
            var c = ace.getCursorPosition();
            var line = ace.session.getLine(g.row);
            if (g.text.indexOf(typed) !== 0 || c.row != g.row || c.column != g.column + typed.length
                || line != g.line.slice(0, g.column) + typed + g.line.slice(g.column))
                return false;
            var rest = g.text.slice(typed.length);
            if (rest) show(rest);
            else hide();
            return true;
        }

        function failed(err, manual) {
            if (err.code == "ECANCELED") return;
            pausedUntil = Date.now() + ERROR_PAUSE;
            var key = err.code || err.message;
            if (!manual && shownErrors[key] && Date.now() - shownErrors[key] < ERROR_REPEAT) return;
            shownErrors[key] = Date.now();
            showError("DeepSeek inline completions: " + String(err.message || err).replace(/^DeepSeek: /, "")
                + (err.code == "ENOKEY" ? ". Set one in Preferences > General > DeepSeek > Accounts" : ""));
        }

        /***** What they cost *****/

        function count(res) {
            stats.count++;
            if (res.cost) {
                stats.usd += res.cost.usd;
                if (!res.cost.priced) stats.unpriced = true;
            }
            if (res.usage) {
                stats.hit += res.usage.hit;
                stats.miss += res.usage.miss;
            }
            renderStats();
        }

        function renderStats() {
            var host = statsBar && statsBar.$int;
            if (!host) return;
            var sent = stats.hit + stats.miss;
            host.textContent = stats.count
                ? stats.count + (stats.count == 1 ? " suggestion" : " suggestions") + " since the IDE was opened, ≈$"
                    + (stats.usd >= 0.01 ? stats.usd.toFixed(2) : String(+stats.usd.toFixed(5))) + (stats.unpriced ? "+" : "")
                    + (sent ? " (DeepSeek's cache served " + Math.round(100 * stats.hit / sent) + "% of the code sent)" : "")
                : "No suggestions yet since the IDE was opened.";
        }

        /***** Lifecycle *****/

        plugin.on("load", function() {
            load();
        });
        plugin.on("unload", function() {
            detach();
            loaded = false;
            statsBar = null;
        });

        /***** Register and define API *****/

        /**
         * Inline completions from DeepSeek in the code editor.
         * @singleton
         */
        plugin.freezePublicAPI({
            /**
             * The suggestion shown, or null.
             * @property {String} text
             * @readonly
             */
            get text() { return ghost ? ghost.text : null; },
            /**
             * Suggestions and their estimated cost since the IDE was opened:
             * { count, usd, unpriced, hit, miss } (tokens of code sent from
             * DeepSeek's cache and not).
             * @property {Object} stats
             * @readonly
             */
            get stats() { return JSON.parse(JSON.stringify(stats)); },
            /**
             * Asks for a suggestion at the cursor now (Alt-\).
             */
            suggest: function() {
                attach(tabs.focussedTab);
                if (ace) request(snapshot(), true);
            },
            /**
             * Accepts the suggestion shown (Tab).
             * @return {Boolean} whether there was one
             */
            accept: function() { return accept(false); },
            /**
             * Dismisses the suggestion shown (Esc).
             */
            dismiss: function() {
                cancel();
                hide();
            },

            _events: [
                /**
                 * Fires when a suggestion is asked for.
                 * @event request
                 * @param {Object} e { prompt, suffix, manual }
                 */
                "request",
                /**
                 * Fires when a suggestion is shown.
                 * @event show
                 * @param {Object} e { text }
                 */
                "show",
                /**
                 * @event hide
                 */
                "hide",
                /**
                 * Fires when (part of) a suggestion is accepted.
                 * @event accept
                 * @param {Object} e { text }
                 */
                "accept"
            ]
        });

        register(null, {
            "deepseek.inline": plugin
        });
    }
});

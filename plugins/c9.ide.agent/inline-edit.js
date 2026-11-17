/**
 * Inline edit: change the selected code by saying what should change.
 *
 * Ctrl-Alt-I (or "Edit with AI…" in the editor's menu) opens a box under
 * the selection (without one: at the cursor, to add code there). The
 * instruction goes, with the selection and some of the code around it, to
 * Claude or DeepSeek, through the panel's service and with its account
 * (see edit() in ./service.js: one answer, no tools). The answer replaces
 * the selection in the editor and is shown as a change to review: the new
 * lines are marked, the lines they replace are shown above them, and each
 * change can be kept or undone by itself. Accept keeps what is left,
 * Reject puts the old lines back; another instruction in the box asks for
 * a different answer.
 *
 * Nothing is saved by any of this: the file is as changed in the editor as
 * after typing.
 */
define(function(require, exports, module) {
    "use strict";

    main.consumes = [
        "Plugin", "tabManager", "commands", "menus", "ui", "ace", "settings",
        "preferences", "claude", "deepseek"
    ];
    main.provides = ["agent.inlineedit"];
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var tabManager = imports.tabManager;
        var commands = imports.commands;
        var menus = imports.menus;
        var ui = imports.ui;
        var aceHandle = imports.ace;
        var settings = imports.settings;
        var prefs = imports.preferences;
        var PROVIDERS = [imports.claude, imports.deepseek];

        var Range = require("ace/range").Range;
        var LineWidgets = require("ace/line_widgets").LineWidgets;
        var isMac = require("ace/lib/useragent").isMac;
        var util = require("./inline-edit-util");

        /***** Initialization *****/

        var plugin = new Plugin("Ajax.org", main.consumes);
        var emit = plugin.getEmitter();

        var SETTINGS = "user/inlineedit";
        var BEFORE_MAX = 12000;     // characters of the code before the selection sent along
        var AFTER_MAX = 4000;       // and after it
        var BEFORE_ROWS = 400;
        var AFTER_ROWS = 120;
        var PREVIEW_ROWS = 10;      // lines of an answer shown while it is written
        var KEYS = {
            accept: isMac ? "⌘↵" : "Ctrl-Enter",
            reject: isMac ? "⇧⌘⌫" : "Ctrl-Shift-Backspace"
        };

        var states = [];            // the edits that are open, one for a document at most

        var loaded = false;
        function load() {
            if (loaded) return false;
            loaded = true;

            settings.on("read", function() {
                settings.setDefaults(SETTINGS, [
                    ["provider", "claude"],
                    ["model", ""],
                    ["effort", ""]
                ]);
            }, plugin);

            commands.addCommand({
                name: "inlineedit",
                group: "Code Editor",
                hint: "change the selected code, or add code at the cursor, by describing it",
                bindKey: { mac: "Ctrl-Alt-I", win: "Ctrl-Alt-I" },
                isAvailable: function(editor) { return !!editableAce(editor); },
                exec: function(editor) { start(editor); }
            }, plugin);
            commands.addCommand({
                name: "inlineeditaccept",
                group: "Code Editor",
                hint: "keep the changes of an inline edit",
                bindKey: { mac: "Command-Enter", win: "Ctrl-Enter" },
                isAvailable: function(editor) { return !!reviewOf(editor); },
                exec: function(editor) { accept(reviewOf(editor)); }
            }, plugin);
            commands.addCommand({
                name: "inlineeditreject",
                group: "Code Editor",
                hint: "undo the changes of an inline edit",
                bindKey: { mac: "Command-Shift-Backspace", win: "Ctrl-Shift-Backspace" },
                isAvailable: function(editor) { return !!reviewOf(editor); },
                exec: function(editor) { reject(reviewOf(editor)); }
            }, plugin);

            // before Ask Claude… and its neighbours
            aceHandle.getElement("menu", function(menu) {
                menus.addItemToMenu(menu, new ui.item({ caption: "Edit with AI…", command: "inlineedit" }), 905, plugin);
            });

            prefs.add({
                "General": {
                    "Inline Edit": {
                        position: 970,
                        "Edit with": {
                            type: "dropdown",
                            path: SETTINGS + "/@provider",
                            width: 160,
                            position: 100,
                            items: PROVIDERS.map(function(p) {
                                return { caption: p.displayName, value: providerId(p) };
                            })
                        },
                        "Model (empty: a quick one)": {
                            type: "textbox",
                            path: SETTINGS + "/@model",
                            position: 200
                        },
                        "Effort": {
                            type: "dropdown",
                            path: SETTINGS + "/@effort",
                            width: 160,
                            position: 300,
                            items: [
                                { caption: "The model's default", value: "" },
                                { caption: "Low", value: "low" },
                                { caption: "Medium", value: "medium" },
                                { caption: "High", value: "high" }
                            ]
                        }
                    }
                }
            }, plugin);

            ui.insertCss(require("text!./inline-edit.css"), plugin);

            tabManager.on("tabDestroy", function(e) {
                states.slice().forEach(function(state) {
                    if (state.tab === e.tab) dismiss(state, true);
                });
            }, plugin);
        }

        /***** Helpers *****/

        function providerId(p) {
            return p === imports.deepseek ? "deepseek" : "claude";
        }

        function provider() {
            return settings.get(SETTINGS + "/@provider") == "deepseek" ? imports.deepseek : imports.claude;
        }

        // the Ace editor of a c9 editor, when its document can be changed
        function editableAce(editor) {
            var ace = editor && editor.ace;
            if (!ace || !ace.session || ace.getReadOnly()) return null;
            var tab = tabManager.focussedTab;
            if (!tab || tab.editor !== editor || tab.editorType != "ace") return null;
            return ace;
        }

        function stateOf(session) {
            for (var i = 0; i < states.length; i++)
                if (states[i].session === session) return states[i];
            return null;
        }

        function reviewOf(editor) {
            var ace = editor && editor.ace;
            var state = ace && stateOf(ace.session);
            return state && state.phase == "review" ? state : null;
        }

        function element(tag, className, text) {
            var el = document.createElement(tag);
            if (className) el.className = className;
            if (text != null) el.textContent = text;
            return el;
        }

        function button(className, label, key, onclick) {
            var el = element("button", "inline-edit-button " + className, label);
            el.type = "button";
            if (key) el.appendChild(element("kbd", "", key));
            // (the editor would take the focus on mousedown)
            el.addEventListener("mousedown", function(e) { e.preventDefault(); e.stopPropagation(); });
            el.addEventListener("click", function(e) { e.stopPropagation(); onclick(); });
            return el;
        }

        function widgetsOf(state) {
            var session = state.session;
            if (!session.widgetManager) {
                session.widgetManager = new LineWidgets(session);
                session.widgetManager.attach(state.ace);
            }
            return session.widgetManager;
        }

        function addWidget(state, row, el) {
            var widget = { row: Math.max(0, row), fixedWidth: true, coverGutter: false, el: el };
            widgetsOf(state).addLineWidget(widget);
            return widget;
        }

        function removeWidget(state, widget) {
            if (!widget) return;
            try { widgetsOf(state).removeLineWidget(widget); } catch (e) {}
            if (widget.el && widget.el.parentNode) widget.el.parentNode.removeChild(widget.el);
        }

        function anchor(state, row, column, stay) {
            var a = state.doc.createAnchor(row, column);
            // (stay: text put right at it comes after it)
            if (stay) a.$insertRight = true;
            return a;
        }

        function lineEnd(state, row) {
            return state.session.getLine(row).length;
        }

        // the rows of the edit as they are now: { start, end } (inclusive)
        function rangeOf(state) {
            var start = state.start.row, end = state.end.row;
            // (a start that was pushed to the end of the line before it)
            if (state.start.column > 0 && start < state.doc.getLength() - 1) start++;
            return { start: start, end: Math.max(start, end) };
        }

        function rangeLines(state) {
            var r = rangeOf(state);
            return state.doc.getLines(r.start, r.end);
        }

        /***** Opening the box *****/

        function start(editor) {
            var ace = editableAce(editor);
            if (!ace) return;
            var session = ace.session;
            var open = stateOf(session);
            if (open) return open.input.focus();

            var state = {
                ace: ace,
                session: session,
                doc: session.doc,
                tab: tabManager.focussedTab,
                phase: "prompt",    // prompt, generating, review
                hunks: [],
                markers: [],
                inserted: false,    // an empty line was added for code to come
                request: null,
                draft: null,        // the answer under review, for an instruction about it
                answer: ""
            };
            var rows = util.rows(ace.getSelectionRange(), function(row) { return session.getLine(row); });
            if (rows.end < rows.start) {
                // no selection, the cursor on a line with text: room for
                // new code after that line
                var at = rows.start - 1;
                session.insert({ row: at, column: lineEnd(state, at) }, "\n");
                state.inserted = true;
                rows.end = rows.start;
            }
            else if (rows.start == rows.end && !/\S/.test(session.getLine(rows.start))) {
                state.blank = true;
            }
            state.start = anchor(state, rows.start, 0, true);
            state.end = anchor(state, rows.end, lineEnd(state, rows.end));
            states.push(state);

            build(state);
            state.onChange = function() { scheduleMarkers(state); };
            session.on("change", state.onChange);
            state.onExec = function(e) {
                // undo and redo move text under the marks: let go of them
                if (e.command && /^(undo|redo)$/.test(e.command.name) && ace.session === session && state.phase != "prompt")
                    dismiss(state, true);
            };
            ace.commands.on("afterExec", state.onExec);

            ace.selection.clearSelection();
            ace.moveCursorTo(rows.start, lineEnd(state, rows.start));
            placeBar(state);
            setPhase(state, "prompt");
            state.input.focus();
            emit("open", { state: state });
        }

        // the box: the instruction, and what goes with each phase
        function build(state) {
            var dark = state.ace.renderer.theme && state.ace.renderer.theme.isDark;
            var bar = state.bar = element("div", "inline-edit-bar" + (dark ? " dark" : ""));
            ["mousedown", "mouseup", "click", "dblclick", "mousewheel", "wheel", "contextmenu"].forEach(function(type) {
                bar.addEventListener(type, function(e) { e.stopPropagation(); });
            });

            var row = element("div", "inline-edit-row");
            var input = state.input = element("textarea", "inline-edit-input");
            input.rows = 1;
            input.spellcheck = false;
            input.setAttribute("aria-label", "What to change");
            input.addEventListener("input", function() { grow(state); });
            input.addEventListener("keydown", function(e) { onKey(state, e); });
            ["keypress", "keyup", "paste", "cut", "copy"].forEach(function(type) {
                input.addEventListener(type, function(e) { e.stopPropagation(); });
            });
            row.appendChild(input);
            state.sendButton = button("inline-edit-send", "Edit", "↵", function() { submit(state); });
            state.stopButton = button("inline-edit-stop", "Stop", "Esc", function() { stop(state); });
            row.appendChild(state.sendButton);
            row.appendChild(state.stopButton);
            bar.appendChild(row);

            state.preview = element("pre", "inline-edit-preview");
            bar.appendChild(state.preview);
            state.note = element("div", "inline-edit-note");
            bar.appendChild(state.note);

            var foot = element("div", "inline-edit-foot");
            state.acceptButton = button("inline-edit-accept", "Accept", KEYS.accept, function() { accept(state); });
            state.rejectButton = button("inline-edit-reject", "Reject", KEYS.reject, function() { reject(state); });
            foot.appendChild(state.acceptButton);
            foot.appendChild(state.rejectButton);
            state.summary = element("span", "inline-edit-summary");
            foot.appendChild(state.summary);

            var select = state.select = element("select", "inline-edit-provider");
            select.setAttribute("aria-label", "Edit with");
            PROVIDERS.forEach(function(p) {
                var option = element("option", "", p.displayName);
                option.value = providerId(p);
                select.appendChild(option);
            });
            select.value = providerId(provider());
            select.addEventListener("change", function() {
                settings.set(SETTINGS + "/@provider", select.value);
            });
            foot.appendChild(select);
            state.closeButton = button("inline-edit-close", "×", null, function() { close(state); });
            state.closeButton.title = "Close (Esc)";
            foot.appendChild(state.closeButton);
            bar.appendChild(foot);
        }

        function grow(state) {
            var input = state.input;
            input.style.height = "auto";
            input.style.height = Math.min(160, input.scrollHeight + 2) + "px";
            relayout(state);
        }

        // The box is as high as what it shows: the editor measures it
        // when it draws, so it is asked to after the box changed
        function relayout(state) {
            if (state.closed || state.ace.session !== state.session) return;
            state.ace.renderer.updateFull();
        }

        // under the last row of the edit
        function placeBar(state) {
            removeWidget(state, state.barWidget);
            state.barWidget = addWidget(state, rangeOf(state).end, state.bar);
            state.ace.renderer.scrollCursorIntoView({ row: rangeOf(state).end, column: 0 }, 0.5);
        }

        function setPhase(state, phase) {
            state.phase = phase;
            state.bar.setAttribute("data-phase", phase);
            state.input.readOnly = phase == "generating";
            state.input.placeholder = phase == "review"
                ? "Ask for something else (Enter), or accept or reject the changes"
                : state.inserted || state.blank ? "What to add here (Enter to send, Esc to close)"
                : "What to change in the selected lines (Enter to send, Esc to close)";
            state.sendButton.firstChild.nodeValue = phase == "review" ? "Again" : "Edit";
            if (phase != "generating") state.preview.textContent = "";
            scheduleMarkers(state);
            relayout(state);
        }

        function showNote(state, text, isError) {
            state.note.textContent = text || "";
            state.note.className = "inline-edit-note" + (text ? " shown" : "") + (isError ? " error" : "");
            relayout(state);
        }

        function onKey(state, e) {
            e.stopPropagation();
            var mod = e.ctrlKey || e.metaKey;
            if (e.keyCode == 13 && mod) {           // Ctrl-Enter
                e.preventDefault();
                if (state.phase == "review") accept(state);
                else submit(state);
            }
            else if (e.keyCode == 13 && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                submit(state);
            }
            else if (e.keyCode == 8 && mod && e.shiftKey && state.phase == "review") {
                e.preventDefault();
                reject(state);
            }
            else if (e.keyCode == 27) {             // Esc
                e.preventDefault();
                if (state.phase == "generating") stop(state);
                else if (state.phase == "review") state.ace.focus();
                else close(state);
            }
        }

        /***** Asking *****/

        function submit(state) {
            var instruction = state.input.value.trim();
            if (!instruction || state.phase == "generating") return;
            // an instruction during a review is about the answer shown:
            // the old lines come back, and the answer goes along as a draft
            var draft = null;
            if (state.phase == "review") {
                draft = state.draft;
                undoAll(state, true);
            }
            showNote(state, "");

            var r = rangeOf(state);
            var doc = state.doc;
            var lines = rangeLines(state);
            var placeholder = (state.inserted || state.blank) && lines.length == 1 && !/\S/.test(lines[0]);
            state.original = placeholder && state.inserted ? [] : lines;
            state.originalText = lines.join("\n");
            var before = doc.getLines(Math.max(0, r.start - BEFORE_ROWS), r.start - 1).join("\n");
            var after = doc.getLines(r.end + 1, r.end + AFTER_ROWS).join("\n");
            var p = provider();
            state.providerName = p.displayName;
            state.model = settings.get(SETTINGS + "/@model") || p.editModel || "";
            state.answer = "";
            state.previewRows = 0;
            setPhase(state, "generating");
            state.preview.textContent = "Asking " + p.displayName + "…";

            var request = state.request = p.edit({
                instruction: instruction,
                selection: placeholder ? "" : lines.join("\n") + "\n",
                before: r.start > 0 ? before.slice(-BEFORE_MAX) + "\n" : "",
                after: after ? after.slice(0, AFTER_MAX) + "\n" : "",
                path: state.tab && state.tab.path || "",
                language: (state.session.syntax || String(state.session.$modeId || "").split("/").pop() || ""),
                draft: draft || undefined,
                model: state.model || undefined,
                effort: settings.get(SETTINGS + "/@effort") || undefined
            }, function(event) {
                if (state.request !== request || state.closed) return;
                if (event.ev == "delta") {
                    state.answer += event.text;
                    // (without the fence some models open their answer with)
                    var shown = state.answer.replace(/^\s*```[^\n]*\n?/, "").replace(/\s+$/, "").split("\n");
                    var rows = Math.min(shown.length, PREVIEW_ROWS);
                    state.preview.textContent = (shown.length > PREVIEW_ROWS ? "…\n" : "")
                        + shown.slice(-PREVIEW_ROWS).join("\n");
                    if (rows != state.previewRows) {
                        state.previewRows = rows;
                        relayout(state);
                    }
                    return;
                }
                state.request = null;
                if (event.ev == "done") return answered(state, event);
                setPhase(state, "prompt");
                if (event.code != "ECANCELED")
                    showNote(state, event.message || "The edit failed", true);
                state.input.focus();
            });
        }

        function stop(state) {
            if (state.request) state.request.cancel();
        }

        function answered(state, event) {
            var result = util.clean(event.text);
            if (result.note != null) {
                setPhase(state, "prompt");
                showNote(state, result.note);
                return state.input.focus();
            }
            if (rangeLines(state).join("\n") !== state.originalText) {
                setPhase(state, "prompt");
                showNote(state, "The lines changed while " + state.providerName + " was answering: nothing was replaced. Send it again.", true);
                return state.input.focus();
            }
            var r = rangeOf(state);
            var indent = /^[ \t]*/.exec(r.start > 0 ? state.session.getLine(r.start - 1) : "")[0];
            var lines = util.reindent(state.original, util.toLines(result.text), indent);
            var hunks = util.hunks(state.original, lines);
            if (!hunks.length) {
                setPhase(state, "prompt");
                showNote(state, state.providerName + " proposed no change");
                return state.input.focus();
            }
            // (no lines at all: an empty line stays in their place)
            var text = lines.length ? lines.join("\n") : "";

            removeWidget(state, state.barWidget);
            state.barWidget = null;
            state.applying = true;
            state.session.replace(new Range(r.start, 0, r.end, lineEnd(state, r.end)), text);
            state.applying = false;
            var last = r.start + Math.max(lines.length, 1) - 1;
            resetRange(state, r.start, last);

            state.draft = lines.join("\n") + "\n";
            state.hunks = hunks.map(function(h) { return makeHunk(state, h, r.start, lines.length); });
            var added = 0, removed = 0;
            hunks.forEach(function(h) { added += h.added; removed += h.removed.length; });
            state.summary.textContent = "+" + added + " −" + removed + "  ·  " + state.providerName
                + (state.model ? " " + state.model.replace(/\[.*\]$/, "") : "")
                + (event.cost && event.cost.priced && event.cost.usd > 0 ? "  ·  $" + price(event.cost.usd) : "");
            state.input.value = "";
            grow(state);
            placeBar(state);
            setPhase(state, "review");
            state.ace.moveCursorTo(r.start, lineEnd(state, r.start));
            state.ace.focus();
            emit("review", { state: state });
        }

        function price(usd) {
            return usd >= 0.01 ? usd.toFixed(2) : usd >= 0.0001 ? usd.toFixed(4) : "<0.0001";
        }

        function resetRange(state, startRow, endRow) {
            state.start.detach();
            state.end.detach();
            state.start = anchor(state, startRow, 0, true);
            state.end = anchor(state, endRow, lineEnd(state, endRow));
        }

        /***** The changes under review *****/

        // h: { start, added, removed } (see util.hunks), at the rows from `first`
        function makeHunk(state, h, first, count) {
            var hunk = { removed: h.removed, added: h.added };
            var row = first + h.start;
            var widgetRow;
            if (h.added) {
                hunk.from = anchor(state, row, 0, true);
                hunk.to = anchor(state, row + h.added - 1, lineEnd(state, row + h.added - 1));
                // above its first line; at the top of the file under its last
                widgetRow = row > 0 ? row - 1 : row + h.added - 1;
            }
            else if (count === 0) {
                // every line went: the empty line that is left stands for them
                hunk.from = anchor(state, first, 0, true);
                hunk.to = anchor(state, first, 0);
                hunk.placeholder = true;
                widgetRow = first > 0 ? first - 1 : first;
            }
            else if (h.start > 0) {
                // lines that went after the line before them
                hunk.after = anchor(state, row - 1, lineEnd(state, row - 1));
                widgetRow = row - 1;
            }
            else {
                // or, at the top of the edit, before the line that follows
                hunk.before = anchor(state, row, 0, true);
                widgetRow = row > 0 ? row - 1 : row;
            }

            var el = element("div", "inline-edit-hunk" + (state.bar.classList.contains("dark") ? " dark" : ""));
            ["mousedown", "mouseup", "click", "dblclick", "contextmenu"].forEach(function(type) {
                el.addEventListener(type, function(e) { e.stopPropagation(); });
            });
            var tools = element("div", "inline-edit-hunk-tools");
            tools.appendChild(button("inline-edit-keep", "Keep", null, function() { keepHunk(state, hunk); settle(state); }));
            tools.appendChild(button("inline-edit-undo", "Undo", null, function() { undoHunk(state, hunk); settle(state); }));
            el.appendChild(tools);
            if (h.removed.length) {
                var old = element("div", "inline-edit-removed");
                h.removed.forEach(function(line) {
                    old.appendChild(element("div", "inline-edit-removed-line", line || "​"));
                });
                el.appendChild(old);
            }
            else {
                el.classList.add("inline-edit-hunk-added");
            }
            hunk.widget = addWidget(state, widgetRow, el);
            return hunk;
        }

        function dropHunk(state, hunk) {
            removeWidget(state, hunk.widget);
            ["from", "to", "after", "before"].forEach(function(name) {
                if (hunk[name]) hunk[name].detach();
            });
            var i = state.hunks.indexOf(hunk);
            if (i != -1) state.hunks.splice(i, 1);
        }

        function keepHunk(state, hunk) {
            // (all the lines went: so does the empty line that stood for them)
            if (hunk.placeholder && state.doc.getLength() > 1) {
                state.applying = true;
                state.doc.removeFullLines(hunk.from.row, hunk.from.row);
                state.applying = false;
            }
            dropHunk(state, hunk);
        }

        // puts the old lines of a change back (keepLine: an empty line
        // stays where lines that were only added go)
        function undoHunk(state, hunk, keepLine) {
            var session = state.session, doc = state.doc;
            state.applying = true;
            if (hunk.from) {
                var from = hunk.from.row, to = Math.max(from, hunk.to.row);
                if (hunk.removed.length)
                    session.replace(new Range(from, 0, to, lineEnd(state, to)), hunk.removed.join("\n"));
                else if (keepLine && state.hunks.length == 1 && rangeOf(state).start == from && rangeOf(state).end == to)
                    session.replace(new Range(from, 0, to, lineEnd(state, to)), "");
                else
                    doc.removeFullLines(from, to);
            }
            else if (hunk.after) {
                session.insert({ row: hunk.after.row, column: lineEnd(state, hunk.after.row) }, "\n" + hunk.removed.join("\n"));
            }
            else {
                session.insert({ row: hunk.before.row, column: 0 }, hunk.removed.join("\n") + "\n");
            }
            state.applying = false;
            dropHunk(state, hunk);
        }

        // all of them, from the last (rows above stay where they are)
        function undoAll(state, keepLine) {
            var r = rangeOf(state);
            var hunks = state.hunks.slice().sort(function(a, b) { return hunkRow(b) - hunkRow(a); });
            var first = r.start, removedRows = 0, addedRows = 0;
            hunks.forEach(function(hunk) {
                addedRows += hunk.placeholder ? 1 : hunk.added;
                removedRows += hunk.removed.length;
                undoHunk(state, hunk, keepLine);
            });
            // the rows of the edit again, by count (the anchors at its ends
            // can be moved by lines that are put back there)
            var rows = r.end - r.start + 1 - addedRows + removedRows;
            if (rows < 1) rows = keepLine ? 1 : 0;
            if (rows > 0 && first + rows - 1 < state.doc.getLength())
                resetRange(state, first, first + rows - 1);
            return rows;
        }

        function hunkRow(hunk) {
            return (hunk.from || hunk.after || hunk.before).row;
        }

        // after a change was kept or undone by itself
        function settle(state) {
            if (!state.hunks.length)
                return dismiss(state);
            scheduleMarkers(state);
        }

        function accept(state) {
            if (!state || state.phase != "review") return;
            state.hunks.slice().forEach(function(hunk) { keepHunk(state, hunk); });
            dismiss(state);
            emit("accept", { state: state });
        }

        function reject(state) {
            if (!state || state.phase != "review") return;
            var rows = undoAll(state, false);
            // (the empty line that was added for code that did not come:
            // gone with the lines that were only added, unless it is back)
            dismiss(state, false, rows);
            emit("reject", { state: state });
        }

        // Esc or the cross
        function close(state) {
            if (state.phase == "review") return reject(state);
            if (state.request) state.request.cancel();
            dismiss(state);
        }

        // takes the box and the marks away; the text stays as it is
        function dismiss(state, quiet) {
            if (state.closed) return;
            state.closed = true;
            if (state.request) state.request.cancel();
            state.request = null;
            var r = rangeOf(state);
            // the line that was added for an answer that was never asked
            // for, or not kept
            var placeholderLeft = state.inserted && state.phase != "review" && r.start == r.end
                && !/\S/.test(state.session.getLine(r.start)) && state.doc.getLength() > 1;
            state.hunks.slice().forEach(function(hunk) { dropHunk(state, hunk); });
            removeWidget(state, state.barWidget);
            clearMarkers(state);
            clearTimeout(state.markerTimer);
            state.session.off("change", state.onChange);
            state.ace.commands.off("afterExec", state.onExec);
            if (placeholderLeft && !quiet)
                state.doc.removeFullLines(r.start, r.start);
            state.start.detach();
            state.end.detach();
            var i = states.indexOf(state);
            if (i != -1) states.splice(i, 1);
            if (!quiet && state.ace.session === state.session) state.ace.focus();
            emit("close", { state: state });
        }

        /***** Marks *****/

        function clearMarkers(state) {
            state.markers.splice(0).forEach(function(id) { state.session.removeMarker(id); });
        }

        function scheduleMarkers(state) {
            if (state.closed) return;
            clearTimeout(state.markerTimer);
            state.markerTimer = setTimeout(function() { drawMarkers(state); }, 0);
        }

        // the new lines of each change; while there is none, the lines the
        // edit is about
        function drawMarkers(state) {
            if (state.closed) return;
            clearMarkers(state);
            var session = state.session;
            if (state.phase == "review") {
                state.hunks.forEach(function(hunk) {
                    if (!hunk.from || hunk.placeholder) return;
                    state.markers.push(session.addMarker(new Range(hunk.from.row, 0, Math.max(hunk.from.row, hunk.to.row), 1),
                        "inline-edit-added", "fullLine"));
                });
            }
            else {
                var r = rangeOf(state);
                state.markers.push(session.addMarker(new Range(r.start, 0, r.end, 1),
                    "inline-edit-target" + (state.phase == "generating" ? " inline-edit-busy" : ""), "fullLine"));
            }
        }

        /***** Lifecycle *****/

        plugin.on("load", function() {
            load();
        });
        plugin.on("unload", function() {
            states.slice().forEach(function(state) { dismiss(state, true); });
            loaded = false;
        });

        /***** Register and define API *****/

        /**
         * Inline edit: an instruction changes the selected lines, and the
         * change is reviewed in the editor.
         * @singleton
         */
        plugin.freezePublicAPI({
            /**
             * Opens the box for the focused editor's selection.
             */
            start: function() {
                var tab = tabManager.focussedTab;
                if (tab && tab.editor) start(tab.editor);
            },
            /**
             * The edit that is open for a tab's document: { phase:
             * "prompt" | "generating" | "review", changes (the number left
             * to review), note } or null.
             * @param {Tab} [tab] the focused one by default
             */
            state: function(tab) {
                tab = tab || tabManager.focussedTab;
                var ace = tab && tab.editor && tab.editor.ace;
                var state = ace && stateOf(ace.session);
                return state ? { phase: state.phase, changes: state.hunks.length, note: state.note.textContent } : null;
            },
            _events: [
                /** @event open  a box was opened */
                "open",
                /** @event review  an answer was put in the editor */
                "review",
                /** @event accept */
                "accept",
                /** @event reject */
                "reject",
                /** @event close */
                "close"
            ]
        });

        register(null, {
            "agent.inlineedit": plugin
        });
    }
});

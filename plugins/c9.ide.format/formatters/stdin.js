define(function(require, exports, module) {
    main.consumes = [
        "Plugin", "settings", "save", "format", "proc", "fs", "c9", "dialog.error",
        "preferences"
    ];
    main.provides = ["format.stdin"];
    return main;

    function main(options, imports, register) {
        var settings = imports.settings;
        var save = imports.save;
        var format = imports.format;
        var proc = imports.proc;
        var fs = imports.fs;
        var c9 = imports.c9;
        var showError = imports["dialog.error"].show;
        var prefs = imports.preferences;
        var Plugin = imports.Plugin;
        var Range = require("ace/range").Range;
        var plugin = new Plugin("Ajax.org", main.consumes);

        // A language's "Custom Code Formatter" (project/<mode>/@formatter) is
        // a filter: it reads the code on stdin and writes the formatted code
        // to stdout, with the file's path in $file (e.g. ruff format
        // --stdin-filename "$file" -). Formatting the saved file in place
        // (gofmt -w "$file") only works through collab (custom.js), which
        // standalone Cloud9 doesn't load.
        var ERROR_NOT_FOUND = 127;
        var TIMEOUT = 15000;
        var PRETTIER = 'prettier --stdin-filepath "$file"';

        // Languages without preferences of their own (Python, JavaScript and
        // Go have them; JSBeautify does HTML, CSS, JSON, ...): mode, caption,
        // default formatter
        var LANGUAGES = [
            ["typescript", "TypeScript", PRETTIER],
            ["tsx", "TSX", PRETTIER],
            ["markdown", "Markdown", PRETTIER],
            ["yaml", "YAML", PRETTIER],
            ["sh", "Shell", "shfmt"],
            ["rust", "Rust", "rustfmt --edition 2021"],
            ["c_cpp", "C and C++", 'clang-format --assume-filename="$file"']
        ];

        function load() {
            settings.on("read", function() {
                LANGUAGES.forEach(function(language) {
                    settings.setDefaults("project/" + language[0], [
                        ["formatOnSave", false],
                        ["formatter", language[2]]
                    ]);
                });
            }, plugin);

            var section = {
                position: 1000,
                "Other Languages": {
                    type: "label",
                    caption: "Other languages (the command reads the code and writes the formatted code; $file is the file's path):",
                    position: 1000
                }
            };
            LANGUAGES.forEach(function(language, i) {
                section[language[1] + ": Format Code on Save"] = {
                    type: "checkbox",
                    path: "project/" + language[0] + "/@formatOnSave",
                    position: 1010 + i * 10
                };
                section[language[1] + " Formatter"] = {
                    type: "textbox",
                    width: 300,
                    path: "project/" + language[0] + "/@formatter",
                    position: 1015 + i * 10
                };
            });
            prefs.add({ "Project": { "Code Formatters": section } }, plugin);

            save.on("beforeSave", function(e) {
                var session = getSession(e.document);
                var mode = session && session.syntax;
                if (!handles(mode) || e.options.value != null)
                    return;
                if (!settings.getBool("project/" + mode + "/@formatOnSave"))
                    return;

                // Format before writing; if that fails, write the code as is
                var doc = e.document;
                return function(path, value, callback, progress) {
                    // other beforeSave handlers (stripws) may have changed it
                    value = doc.value;
                    formatCode(mode, path, value, function(err, formatted) {
                        if (err || formatted === value || doc.value !== value)
                            return fs.writeFile(path, value, callback, progress);

                        applyCode(session, formatted);
                        doc.meta.$formattedValue = formatted;
                        fs.writeFile(path, formatted, callback, progress);
                    });
                };
            }, plugin);

            // save marked the document as saved before it was formatted
            save.on("afterSave", function(e) {
                var formatted = e.document.meta.$formattedValue;
                if (formatted == null)
                    return;
                delete e.document.meta.$formattedValue;
                if (!e.err && e.document.value === formatted)
                    e.document.undoManager.bookmark();
            }, plugin);

            // Edit > Code Formatting > Apply Code Formatting
            format.on("format", function(e) {
                var session = e.editor.ace.session;
                if (!handles(e.mode))
                    return;
                var path = e.editor.activeDocument.tab.path;
                var value = session.getValue();
                formatCode(e.mode, path, value, function(err, formatted) {
                    if (err)
                        return showError(err.message);
                    if (session.getValue() === value)
                        applyCode(session, formatted);
                });
                return true;
            }, plugin);
        }

        /***** Methods *****/

        // a language with a formatter command, unless JSBeautify does it
        function handles(mode) {
            if (!mode || !settings.get("project/" + mode + "/@formatter"))
                return false;
            return !(mode === "javascript" && settings.getBool("project/javascript/@use_jsbeautify"));
        }

        function getSession(doc) {
            var c9Session = doc.getSession();
            return c9Session && c9Session.session;
        }

        function applyCode(session, value) {
            // only change what's different, so the cursor stays put
            session.diffAndReplace(new Range(0, 0, session.getLength(), 0), value);
        }

        function getAbsolutePath(path) {
            if (path.charAt(0) === "~")
                return c9.home + path.substr(1);
            return c9.workspaceDir.replace(/\/$/, "") + path;
        }

        function formatCode(mode, path, value, callback) {
            var formatter = settings.get("project/" + mode + "/@formatter");
            if (!formatter)
                return callback(new Error("No code formatter set for " + mode + ": please check your project settings"));

            var file = getAbsolutePath(path);
            proc.spawn("bash", {
                args: ["-c", formatter],
                cwd: file.replace(/\/[^\/]*$/, "") || "/",
                env: { file: file }
            }, function(err, child) {
                if (err)
                    return done(err);

                var stdout = "";
                var stderr = "";
                var timer = setTimeout(function() {
                    child.kill();
                    done(new Error("Code formatter for " + mode + " did not finish in time"));
                }, TIMEOUT);

                child.stdout.on("data", function(chunk) { stdout += chunk; });
                child.stderr.on("data", function(chunk) { stderr += chunk; });
                child.on("close", function(code) {
                    clearTimeout(timer);
                    if (code === ERROR_NOT_FOUND) {
                        var name = formatter.replace(/(.*?) .*/, "$1");
                        showError("Error running code formatter for " + mode + ": "
                            + name + " not found, please check your project settings");
                    }
                    if (code !== 0) {
                        err = new Error("Code formatter for " + mode + " failed: " + (stderr || "exit code " + code));
                        console.warn("[format.stdin] " + err.message);
                        return done(err);
                    }
                    // an in-place formatter outputs nothing; don't wipe the code
                    if (!stdout && value.trim())
                        return done(new Error("Code formatter for " + mode + " didn't output any code"));
                    done(null, stdout);
                });

                child.stdin.write(value);
                child.stdin.end();
            });

            function done(err, formatted) {
                callback && callback(err, formatted);
                callback = null;
            }
        }

        /***** Lifecycle *****/

        plugin.on("load", function() {
            load();
        });

        /***** Register and define API *****/

        /**
         * Formats code with a command that reads it on stdin and writes the
         * formatted code to stdout, like "ruff format -", for every language's
         * "Format Code on Save" and "Custom Code Formatter" preferences.
         */
        plugin.freezePublicAPI({});

        register(null, {
            "format.stdin": plugin
        });
    }
});

define(function(require, exports, module) {
    main.consumes = [
        "Plugin", "settings", "save", "format", "proc", "fs", "c9", "dialog.error"
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
        var Plugin = imports.Plugin;
        var Range = require("ace/range").Range;
        var plugin = new Plugin("Ajax.org", main.consumes);

        // Languages whose "Custom Code Formatter" is a filter: it reads the
        // code on stdin and writes the formatted code to stdout, with the
        // file's path in $file (e.g. ruff format --stdin-filename "$file" -).
        // The others (gofmt -w "$file") format the saved file in place, which
        // only works through collab (see custom.js).
        var MODES = { python: true };
        var ERROR_NOT_FOUND = 127;
        var TIMEOUT = 15000;

        function load() {
            save.on("beforeSave", function(e) {
                var session = getSession(e.document);
                var mode = session && session.syntax;
                if (!MODES[mode] || e.options.value != null)
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
                if (!MODES[e.mode] || !settings.get("project/" + e.mode + "/@formatter"))
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
         * formatted code to stdout, like "ruff format -". Used for Python's
         * "Format Code on Save" and "Custom Code Formatter" preferences.
         */
        plugin.freezePublicAPI({});

        register(null, {
            "format.stdin": plugin
        });
    }
});

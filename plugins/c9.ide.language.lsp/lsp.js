/**
 * Language servers (LSP): completion, markers, jump to definition, parameter
 * hints and outline from a language server, for now TypeScript 7 (tsc --lsp)
 * for JavaScript and TypeScript. The client runs in the language
 * worker (worker/lsp_worker.js); this tells it which servers to run.
 */
define(function(require, exports, module) {
    main.consumes = ["Plugin", "language", "settings", "preferences", "c9"];
    main.provides = ["language.lsp"];
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var language = imports.language;
        var settings = imports.settings;
        var prefs = imports.preferences;
        var c9 = imports.c9;

        var plugin = new Plugin("Ajax.org", main.consumes);
        var HANDLER = "plugins/c9.ide.language.lsp/worker/lsp_worker";
        var handler;

        plugin.on("load", function() {
            settings.on("read", function() {
                settings.setDefaults("project/lsp", [["typescript", "true"]]);
                send();
            }, plugin);
            settings.on("project/lsp", send, plugin);

            prefs.add({
                "Project": {
                    "Language Servers": {
                        position: 1250,
                        "TypeScript and JavaScript (TypeScript 7)": {
                            type: "checkbox",
                            path: "project/lsp/@typescript",
                            position: 100
                        }
                    }
                }
            }, plugin);

            language.registerLanguageHandler(HANDLER, function(err, _handler) {
                if (err) return console.error(err);
                handler = _handler;
                send();
            });
        });

        function send() {
            if (handler)
                handler.emit("lsp_config", config());
        }

        function config() {
            var servers = [];
            // TypeScript 7 is a native program; npm installs the one for
            // this platform next to the typescript-native package
            if (settings.getBool("project/lsp/@typescript") && c9.sourceDir) {
                servers.push({
                    name: "typescript",
                    caption: "The TypeScript language server",
                    help: "run scripts/install-sdk.sh in the Cloud9 folder.",
                    command: c9.sourceDir + "/node_modules/@typescript/typescript-"
                        + c9.platform + "-" + c9.arch + "/lib/tsc",
                    args: ["--lsp", "--stdio"],
                    languages: ["javascript", "jsx", "typescript", "tsx"],
                    extensions: ["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"],
                    // JavaScript has its own outline
                    outline: ["ts", "mts", "cts", "tsx"]
                });
            }
            return { servers: servers, workspaceDir: c9.workspaceDir, home: c9.home };
        }

        plugin.on("unload", function() {
            language.unregisterLanguageHandler(HANDLER);
            handler = null;
        });

        register(null, {
            "language.lsp": plugin
        });
    }
});

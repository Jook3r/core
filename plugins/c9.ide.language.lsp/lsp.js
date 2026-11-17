/**
 * Language servers (LSP): completion, markers, jump to definition, parameter
 * hints, outline and more from a language server: TypeScript 7 (tsc --lsp)
 * for JavaScript and TypeScript, which Cloud9 installs, and the servers of
 * other languages (SERVERS below) when they are installed on the server.
 * The client runs in the language worker (worker/lsp_worker.js); this tells
 * it which servers to run. ./features.js has what the IDE shows of them.
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
        var emit = plugin.getEmitter();
        var HANDLER = "plugins/c9.ide.language.lsp/worker/lsp_worker";
        var handler;
        var states = {};        // server -> { state, detail }, as the worker reports them

        // The servers of other languages: used when one of their commands
        // is installed (on the PATH of the server, or in ~/.local/bin,
        // ~/go/bin, ~/.cargo/bin, ~/.npm-global/bin), and nothing is said
        // when none is. languages: Cloud9's names (the editor's modes).
        // outline: the language has no outline of Cloud9's own. runsCode:
        // the server runs code of the project to understand it (build
        // scripts, a Gemfile), so it is not started for a folder that is
        // not trusted (see "Other folders" in the README).
        var SERVERS = [
            { name: "python", caption: "Python", languages: ["python"], extensions: ["py", "pyi"],
                commands: [["basedpyright-langserver", "--stdio"], ["pyright-langserver", "--stdio"], ["pylsp"], ["ruff", "server"]],
                install: "npm install -g pyright (or pip install basedpyright, python-lsp-server)" },
            { name: "go", runsCode: true, outline: true, caption: "Go", languages: ["golang"], extensions: ["go"],
                commands: [["gopls"]], install: "go install golang.org/x/tools/gopls@latest" },
            { name: "rust", runsCode: true, outline: true, caption: "Rust", languages: ["rust"], extensions: ["rs"],
                commands: [["rust-analyzer"]], install: "rustup component add rust-analyzer" },
            { name: "cpp", outline: true, caption: "C and C++", languages: ["c_cpp"],
                extensions: ["c", "h", "cc", "cpp", "cxx", "hh", "hpp", "hxx"],
                languageIds: { c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp" },
                commands: [["clangd"]], install: "apt install clangd" },
            { name: "php", caption: "PHP", languages: ["php"], extensions: ["php"],
                commands: [["intelephense", "--stdio"], ["phpactor", "language-server"]],
                install: "npm install -g intelephense" },
            { name: "ruby", runsCode: true, caption: "Ruby", languages: ["ruby"], extensions: ["rb", "rake", "gemspec"],
                languageIds: { rb: "ruby", rake: "ruby", gemspec: "ruby" },
                commands: [["ruby-lsp"], ["solargraph", "stdio"]], install: "gem install ruby-lsp" },
            { name: "bash", caption: "Shell scripts", languages: ["sh"], extensions: ["sh", "bash"],
                languageIds: { sh: "shellscript", bash: "shellscript" },
                commands: [["bash-language-server", "start"]], install: "npm install -g bash-language-server" },
            { name: "lua", outline: true, caption: "Lua", languages: ["lua"], extensions: ["lua"],
                commands: [["lua-language-server"]], install: "see luals.github.io" },
            { name: "yaml", outline: true, caption: "YAML", languages: ["yaml"], extensions: ["yaml", "yml"],
                languageIds: { yml: "yaml" },
                commands: [["yaml-language-server", "--stdio"]], install: "npm install -g yaml-language-server" },
            { name: "json", caption: "JSON", languages: ["json"], extensions: ["json", "jsonc"],
                commands: [["vscode-json-language-server", "--stdio"]], install: "npm install -g vscode-langservers-extracted" },
            { name: "css", caption: "CSS, SCSS and Less", languages: ["css", "scss", "less"], extensions: ["css", "scss", "less"],
                commands: [["vscode-css-language-server", "--stdio"]], install: "npm install -g vscode-langservers-extracted" },
            { name: "html", caption: "HTML", languages: ["html"], extensions: ["html", "htm"],
                languageIds: { htm: "html" },
                commands: [["vscode-html-language-server", "--stdio"]], install: "npm install -g vscode-langservers-extracted" }
        ];

        plugin.on("load", function() {
            settings.on("read", function() {
                settings.setDefaults("project/lsp", [["typescript", "true"]].concat(SERVERS.map(function(server) {
                    return [server.name, "true"];
                })));
                send();
            }, plugin);
            settings.on("project/lsp", send, plugin);

            var items = {
                position: 1250,
                "TypeScript and JavaScript (TypeScript 7)": {
                    type: "checkbox",
                    path: "project/lsp/@typescript",
                    position: 100
                }
            };
            // (the name of its program in the label: what to install)
            SERVERS.forEach(function(server, i) {
                items[server.caption + " (" + server.commands.map(function(c) { return c[0]; }).join(", ") + ", if installed)"] = {
                    type: "checkbox",
                    path: "project/lsp/@" + server.name,
                    position: 200 + i * 10
                };
            });
            items["Show the Type and Documentation of What the Mouse Rests On"] = {
                type: "checkbox",
                path: "user/lsp/@hover",
                position: 50
            };
            items["Other servers, as JSON: [{ \"name\": \"zig\", \"command\": [\"zls\"], \"extensions\": [\"zig\"] }]"] = {
                type: "textbox",
                path: "user/lsp/@servers",
                position: 900
            };
            prefs.add({ "Project": { "Language Servers": items }}, plugin);
            settings.on("user/lsp/@servers", send, plugin);

            registerHandler(3);
        });

        function registerHandler(retries) {
            language.registerLanguageHandler(HANDLER, function(err, _handler) {
                if (err) {
                    console.error("Language servers: " + (err.message || err));
                    // e.g. the worker could not load it: once more, later
                    if (retries) setTimeout(registerHandler.bind(null, retries - 1), 3000);
                    return;
                }
                handler = _handler;
                handler.on("lsp_ready", function() {
                    language.refreshAllMarkers();
                });
                handler.on("lsp_status", function(e) {
                    states[e.server] = { state: e.state, detail: e.detail };
                    emit("status", e);
                });
                emit("handler", { handler: handler });
                sent = null;
                send();
            });
        }

        // whether a server is set up for a file (by its extension)
        function handles(path) {
            var ext = (/\.([^.\/]+)$/.exec(path || "") || [])[1];
            return !!ext && config().servers.some(function(server) {
                return server.extensions.indexOf(ext) != -1
                    && (states[server.name] || {}).state != "missing";
            });
        }

        // the files that are open are checked again when that changes
        var sent;
        function send() {
            if (!handler) return;
            var value = config();
            if (JSON.stringify(value) == sent) return;
            sent = JSON.stringify(value);
            handler.emit("lsp_config", value);
            language.refreshAllMarkers();
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
                    outline: ["ts", "mts", "cts", "tsx"],
                    // Rename Symbol on a name that is imported renames it
                    // where it is declared and in every file, not only
                    // here ("import { old as new }")
                    settings: {
                        "js/ts": { preferences: { useAliasesForRenames: false }},
                        typescript: { preferences: { useAliasesForRenames: false }},
                        javascript: { preferences: { useAliasesForRenames: false }}
                    }
                });
            }
            SERVERS.forEach(function(server) {
                if (!settings.getBool("project/lsp/@" + server.name)) return;
                if (server.runsCode && settings.trusted === false) return;
                servers.push({
                    name: server.name,
                    caption: "The " + server.caption + " language server",
                    // nothing is said when it is not installed
                    optional: true,
                    commands: server.commands.map(function(c) { return { command: c[0], args: c.slice(1) }; }),
                    languages: server.languages,
                    extensions: server.extensions,
                    languageIds: server.languageIds,
                    outline: server.outline ? server.extensions : []
                });
            });
            customServers().forEach(function(server) { servers.push(server); });
            return { servers: servers, workspaceDir: c9.workspaceDir, home: c9.home };
        }

        // Servers of the user's own (Preferences > Language Servers > Other
        // servers), as JSON:
        //   [{ "name": "zig", "command": ["zls"], "extensions": ["zig"], "languages": ["zig"] }]
        // A user setting, not the project's: a folder can't name a program to run.
        function customServers() {
            var list;
            try {
                list = JSON.parse(settings.get("user/lsp/@servers") || "[]");
            } catch (e) {
                return [];
            }
            var taken = { typescript: true };
            SERVERS.forEach(function(server) { taken[server.name] = true; });
            return (Array.isArray(list) ? list : []).filter(function(server) {
                var ok = server && /^[\w-]{1,40}$/.test(server.name) && !taken[server.name]
                    && Array.isArray(server.command) && server.command.length
                    && server.command.every(function(part) { return typeof part == "string" && part.length < 1000; })
                    && Array.isArray(server.extensions) && server.extensions.length
                    && server.extensions.every(function(ext) { return /^[\w+-]{1,20}$/.test(ext); });
                if (ok) taken[server.name] = true;
                return ok;
            }).slice(0, 20).map(function(server) {
                var languages = Array.isArray(server.languages) ? server.languages.filter(function(l) { return /^[\w+-]{1,40}$/.test(l); }) : [];
                return {
                    name: server.name,
                    caption: "The " + server.name + " language server",
                    help: "check its command in Preferences > Language Servers.",
                    commands: [{ command: server.command[0], args: server.command.slice(1) }],
                    // the editor's mode is usually the extension or the name
                    languages: languages.length ? languages : server.extensions.concat(server.name),
                    extensions: server.extensions,
                    languageIds: server.languageIds && typeof server.languageIds == "object" ? server.languageIds : undefined,
                    outline: server.outline === false ? [] : server.extensions
                };
            });
        }

        plugin.on("unload", function() {
            language.unregisterLanguageHandler(HANDLER);
            handler = null;
        });

        plugin.freezePublicAPI({
            /**
             * The language worker's handler, once it is there (the "handler"
             * event says when): on() and emit() of the client in the worker.
             */
            get handler() { return handler; },
            /**
             * The servers that were started: name -> { state: "starting",
             * "running", "missing" (not installed) or "failed", detail }
             */
            get states() { return states; },
            /**
             * The other languages' servers: [{ name, caption, commands,
             * extensions, install }]
             */
            get servers() { return SERVERS; },
            /**
             * Whether a language server is set up for a file, and not
             * known to be missing
             * @param {String} path
             */
            handles: handles,
            _events: [
                /** @event handler  the worker's handler is there */
                "handler",
                /** @event status   a server started, or could not: { server, state, detail } */
                "status"
            ]
        });

        register(null, {
            "language.lsp": plugin
        });
    }
});

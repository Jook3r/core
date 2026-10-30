define(function(require, exports, module) {
    main.consumes = [
        "Plugin", "settings", "preferences", "pluginManager", "ui",
        "dialog.error"
    ];
    main.provides = ["pluginManager.startup"];
    return main;

    /*
     * Loads the plugins ticked in Preferences > User Settings > Plugins
     * (folders in ~/.c9/plugins) every time Cloud9 starts. The Plugin
     * Explorer of the debug mode loads them for the browser session only.
     */
    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var settings = imports.settings;
        var prefs = imports.preferences;
        var pluginManager = imports.pluginManager;
        var ui = imports.ui;
        var showError = imports["dialog.error"].show;

        /***** Initialization *****/

        var plugin = new Plugin("Ajax.org", main.consumes);

        var DIR = "~/.c9/plugins/";
        var SETTING = "user/plugins/startup";

        var listBar;
        var available = null; // the folders in ~/.c9/plugins, once read
        var scriptErrors = Object.create(null); // name: the error in its code
        var started = false;

        var loaded = false;
        function load() {
            if (loaded) return false;
            loaded = true;

            ui.insertCss(require("text!./startup.less"), plugin);

            settings.on("read", function() {
                if (started) return;
                started = true;
                var names = chosen();
                if (!names.length) return;
                // a plugin that is gone is shown as such in the preferences
                pluginManager.readAvailablePlugins(function(err, list) {
                    if (err) return;
                    names.forEach(function(name) {
                        // also loaded by the Plugin Explorer of the debug mode
                        var pkg = pluginManager.packages[name];
                        if (pkg && (pkg.enabled || pkg.loading)) return;
                        if (list.indexOf(name) > -1) loadOne(name);
                    });
                });
            }, plugin);

            prefs.add({
                "General": {
                    "Plugins": {
                        position: 1000,
                        "Load at Startup": {
                            type: "custom",
                            position: 100,
                            node: listBar = new ui.bar({ "class": "c9-startup-plugins-bar" })
                        }
                    }
                }
            }, plugin);
            listBar.on("DOMNodeInsertedIntoDocument", refreshList);

            pluginManager.on("change", render, plugin);
        }

        /***** Methods *****/

        // the folder names, as saved
        function chosen() {
            var list = settings.getJson(SETTING);
            return Array.isArray(list) ? list.filter(isName) : [];
        }

        function isName(name) {
            return typeof name == "string" && /^[^._\/][^\/]*$/.test(name);
        }

        function setChosen(name, on) {
            var list = chosen().filter(function(x) { return x != name; });
            if (on) list.push(name);
            settings.setJson(SETTING, list);
        }

        function loadOne(name, callback) {
            // a syntax error in the plugin's code: the manager only knows
            // that the plugin is missing then
            var marker = "/.c9/plugins/" + name + "/";
            delete scriptErrors[name];
            function onError(e) {
                var file = String(e.filename || "");
                var at = file.indexOf(marker);
                if (at == -1 || scriptErrors[name]) return;
                scriptErrors[name] = String(e.message || "Error").replace(/^Uncaught /, "")
                    + " (" + file.slice(at + marker.length) + ", line " + e.lineno + ")";
            }
            window.addEventListener("error", onError);
            pluginManager.loadPackage(DIR + name + "/package.json", function(err) {
                window.removeEventListener("error", onError);
                if (err) {
                    showError("Could not load the plugin " + name + " from ~/.c9/plugins: "
                        + (scriptErrors[name] || firstLine(err.message || err)));
                }
                render();
                callback && callback(err);
            });
        }

        function firstLine(text) {
            return String(text).trim().split("\n")[0];
        }

        function refreshList() {
            render();
            pluginManager.readAvailablePlugins(function(err, list) {
                // no ~/.c9/plugins yet
                available = err ? [] : list.slice().sort();
                render();
            });
        }

        function status(name) {
            if (available && available.indexOf(name) == -1)
                return { text: "Not found in ~/.c9/plugins", error: true };
            var pkg = pluginManager.packages[name];
            if (!pkg) return { text: "" };
            if (pkg.loading) return { text: "Loading…" };
            if (pkg.__error) {
                return {
                    text: scriptErrors[name] || pkg.__error.message.replace(/\s+/g, " ").trim(),
                    error: true
                };
            }
            if (pkg.enabled) return { text: "Loaded" };
            return { text: "" };
        }

        function render() {
            var host = listBar && listBar.$int;
            if (!host) return;

            var box = el("div", "c9-startup-plugins");
            box.appendChild(el("div", "c9-startup-intro",
                "Plugins in ~/.c9/plugins that load every time Cloud9 starts. Ticking one "
                + "loads it now, unticking unloads it. File › New Plugin makes one."));

            var names = chosen();
            var all = (available || []).slice();
            names.forEach(function(name) {
                if (all.indexOf(name) == -1) all.push(name);
            });
            if (available == null)
                box.appendChild(el("div", "c9-startup-note", "Reading ~/.c9/plugins…"));
            else if (!all.length)
                box.appendChild(el("div", "c9-startup-note", "There are no plugins in ~/.c9/plugins yet."));

            all.forEach(function(name) {
                var row = el("div", "c9-startup-row");
                var label = row.appendChild(el("label", "c9-startup-name"));
                var check = label.appendChild(document.createElement("input"));
                check.type = "checkbox";
                check.checked = names.indexOf(name) > -1;
                label.appendChild(document.createTextNode(name));
                check.addEventListener("change", function() {
                    setChosen(name, check.checked);
                    if (available.indexOf(name) == -1)
                        return render();
                    if (check.checked)
                        return loadOne(name);
                    pluginManager.unloadPackage(name);
                    render();
                });
                var info = status(name);
                if (info.text) {
                    row.appendChild(el("span", "c9-startup-status" + (info.error ? " c9-startup-error" : ""), info.text));
                }
                box.appendChild(row);
            });

            var refresh = box.appendChild(el("button", "c9-startup-refresh", "Refresh"));
            refresh.addEventListener("click", refreshList);

            host.textContent = "";
            host.appendChild(box);
        }

        function el(tag, className, text) {
            var node = document.createElement(tag);
            node.className = className;
            if (text) node.textContent = text;
            return node;
        }

        /***** Lifecycle *****/

        plugin.on("load", function() {
            load();
        });
        plugin.on("unload", function() {
            loaded = false;
            started = false;
            available = null;
            listBar = null;
        });

        /***** Register and define API *****/

        /**
         * Loads plugins of ~/.c9/plugins every time Cloud9 starts.
         */
        plugin.freezePublicAPI({
            /**
             * The folders in ~/.c9/plugins that load at startup
             * @return {String[]}
             */
            get chosen() { return chosen(); },

            /**
             * Loads a folder of ~/.c9/plugins at startup from now on (and
             * now), or not
             * @param {String} name
             * @param {Boolean} on
             */
            setStartup: function(name, on) {
                if (!isName(name)) return;
                setChosen(name, on);
                if (on) loadOne(name);
                else pluginManager.unloadPackage(name);
            }
        });

        register(null, {
            "pluginManager.startup": plugin
        });
    }
});

define(function(require, exports, module) {

    main.consumes = [
        "Plugin", "layout", "app",
        "util", "tabManager", "ace", "settings"
    ];
    main.provides = ["theme.jett"];
    return main;

    /**
     * Client-side plugin for jett theme
     * @method main
     * @param {} options
     * @param {} imports
     * @param {} register
     * @return
     */
    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var layout = imports.layout;
        var tabs = imports.tabManager;
        var ace = imports.ace;
        var settings = imports.settings;
        var services = imports.app.services;
        
        var escapeHTML = require("ace/lib/lang").escapeHTML;

        /***** Initialization *****/

        var plugin = new Plugin("Ajax.org", main.consumes);
        var emit = plugin.getEmitter();

        var themeEnabled = false;
        // "jett" for jett-dark, "code-server" for the code-server skins,
        // which reuse the file icons and the active tab colouring
        var mode = null;
        
        function getMode(theme) {
            if (theme == "jett-dark") return "jett";
            if (/^code-server-/.test(theme || "")) return "code-server";
            return null;
        }

        /**
         * Called when plugin is loaded
         * @method load
         * @return
         */
        function load() {
            ace.addTheme({
                caption: "Jett",
                id: "plugins/c9.ide.theme.jett/ace.themes/jett"
            }, plugin);
            layout.addTheme({
                group: "flat",
                color: "rgb(41, 58, 86)",
                name: "jett-dark",
                caption: "Jett Dark",
                defaults: {
                    output: {
                        backgroundColor: "#2b303b",
                        foregroundColor: "#767B85",
                        selectionColor: "#343d46",
                    },
                    
                }
            });

            layout.on("themeChange", function(e) {
                var newMode = getMode(e.theme);
                if (newMode)
                    enableJett(true, newMode);
                else if (themeEnabled)
                    enableJett(false);
            });

            layout.on("themeDefaults", function(e) {
            });
        }

        /**
         * Toggle the jett theme on/off
         * @str an identifiable attribute
         * @method enableJett
         * @param {} enabled If true then jett theme is on
         * @return
         */
        function enableJett(enabled, newMode) {
            var wasEnabled = themeEnabled;
            var oldMode = mode;
            // Update settings
            themeEnabled = enabled;
            mode = enabled ? newMode || "jett" : null;
            
            // If the jett theme is enabled set some defaults and theme specific prefs
            if (enabled && !wasEnabled) {
                // Anytime the user switches tabs or themes make sure we have the correct tab colors
                ace.on("themeChange", styleTabs, plugin);
                tabs.on("focusSync", styleTabs, plugin);
                // Set file icon when the tabs are drawn
                tabs.on("tabCreate", onTabCreate, plugin);
                enableFileIcons();
            }
            else if (!enabled) {
                ace.off("themeChange", styleTabs, plugin);
                tabs.off("focusSync", styleTabs, plugin);
                tabs.off("tabCreate", onTabCreate, plugin);
            }
            
            // The code-server skins also follow the terminal and output
            // colours and tabs activated without a focus change
            if (mode == "code-server" && oldMode != "code-server") {
                tabs.on("tabAfterActivate", styleTabs, plugin);
                settings.on("user/terminal", styleTabs, plugin);
                settings.on("user/output", styleTabs, plugin);
                // once more after the event: a new tab's editor (e.g. the
                // output tab opened by Run) and an editor's theme class may
                // only be in place after the other listeners ran
                tabs.on("tabAfterActivate", styleTabsSoon, plugin);
                tabs.on("tabCreate", styleTabsSoon, plugin);
                ace.on("themeChange", styleTabsSoon, plugin);
            }
            else if (mode != "code-server" && oldMode == "code-server") {
                tabs.off("tabAfterActivate", styleTabs, plugin);
                settings.off("user/terminal", styleTabs, plugin);
                settings.off("user/output", styleTabs, plugin);
                tabs.off("tabAfterActivate", styleTabsSoon, plugin);
                tabs.off("tabCreate", styleTabsSoon, plugin);
                ace.off("themeChange", styleTabsSoon, plugin);
            }
            styleTabs();
            // Refresh file icons
            var tree = services.tree && services.tree.tree;
            tree && tree.resize(true);
        }

        function onTabCreate(e) {
            if (themeEnabled && e.tab.title && e.tab.path) {
                setTabIcon(e.tab);
            }
        }
        
        function enableFileIcons() {
            if (enableFileIcons.called)
                return;
            enableFileIcons.called = true;

            /**
             * Add file icons to the file search results
             */
            var navigate = services.navigate;
            navigate && navigate.once("draw", function() {
                var dp = navigate.tree.provider;

                override(dp, 'renderRow', function(original) {
                    return function(row, html, config) {

                        // If jett is not enabled then return
                        if (!themeEnabled) {
                            return original.apply(this, arguments);
                        }

                        var path = dp.visibleItems[row];
                        var isSelected = dp.isSelected(row);
                        var filename = path.substr(path.lastIndexOf("/") + 1);
                        var icon = getIconClass(filename);

                        html.push("<div class='item " + (isSelected ? "selected " : "")
                            + dp.getClassName(row) + "' style='height:" + dp.innerRowHeight + "px'><span class='filetree-icon " + icon + "'>"
                            + dp.replaceStrong(filename) + "</span><small class='path'>" + dp.replaceStrong(path) + "</small></div>");
                    };
                });
            });

            /*
             * Customize file icons on the file tree
             */
            var tree = services.tree;
            tree.once("draw", function(e) {
                override(tree.tree.model, 'getIconHTML', function(original) {
                    return function(node) {
                        // If jett is not enabled then return
                        if (!themeEnabled) {
                            return original.apply(this, arguments);
                        }

                        var icon = node.isFolder ? "folder" : getIconClass(node.label);

                        if (node.status === "loading") icon = "loading";
                        return "<span class='filetree-icon " + icon + "'></span>";
                    };
                });
            });
        }

        /**
         * Helper function to help us extend current cloud9 events
         * @method override
         * @param {} object
         * @param {} methodName
         * @param {} callback
         * @return
         */
        function override(object, methodName, callback) {
            object[methodName] = callback(object[methodName]);
        }

        /**
         * Reusable function to get the CSS class of a file type
         * @method getIconClass
         * @param {} filename
         * @return icon
         */
        function getIconClass(filename) {
            if (!filename) return '';

            // Remove the path if it's a directory string
            filename = filename.split("/").pop();
            // Get the file.extention
            var icon = filename.split(".").pop().toLowerCase();

            filename = filename.toLowerCase();
            if (filename == "package.json") icon = "npm";
            if (filename == "composer.json") icon = "composer";
            if (filename == "bower.json") icon = "bower";
            if (filename == "gulpfile.js") icon = "gulp";
            if (filename == "gruntfile.js") icon = "grunt";

            return icon;
        }


        /***** Methods *****/
        
        /**
         * Active tabs with ACE editor get the same color as the current ACE theme
         * @method styleTab
         * @param {} e
         * @return
         */
        function styleTabs(e) {
            var panes = tabs.getPanes();

            panes.forEach(function(pane) {
                // Add a file icon to the tab if jett is enabled
                pane.getTabs().forEach(function(tab) {
                    // a tab that is closing has no button any more
                    if (!tab.aml.$button) return;
                    setTabIcon(tab);
                    if (mode == "code-server" || tab.aml.$button.style.getPropertyValue("--cs-tab-bg"))
                        styleCodeServerTab(tab);
                    if (mode == "code-server") {
                        // colours come from CSS, through --cs-tab-bg/--cs-tab-fg
                    }
                    else if (themeEnabled && tab.isActive()) {
                        if (ace.theme && ace.theme.bg && ace.theme.fg) {
                            // Color tabs based on their tab.aml.type
                            var colorHash = {
                                "editor::ace": ace.theme.bg,
                                "editor::terminal": "#000",
                                "editor::output": "#000",
                                "editor::preferences": "#25272C",
                                "editor::immediate": "#1C1D21"
                            };
    
                            tab.aml.$button.style.backgroundColor = (colorHash[tab.aml.type] || "iherit");
                            tab.aml.$button.style.color = ace.theme.fg;
                        }
                    }
                    else {
                        tab.aml.$button.style.backgroundColor = '';
                        tab.aml.$button.style.color = '';
                    }
                    
                });
            });
        }

        var styleTimer;
        function styleTabsSoon() {
            clearTimeout(styleTimer);
            styleTimer = setTimeout(function() {
                if (mode == "code-server")
                    styleTabs();
            }, 50);
        }

        /**
         * code-server skins: the active tab is filled with the colour of its
         * body. Instead of inline colours (which CSS could not override) the
         * tab button gets the custom properties --cs-tab-bg and --cs-tab-fg,
         * used by the skin's tab rules (fill and concave shoulders).
         * @method styleCodeServerTab
         * @param {Tab} tab
         */
        function styleCodeServerTab(tab) {
            var style = tab.aml.$button.style;
            var colors = mode == "code-server" && tab.isActive() && getBodyColors(tab);
            if (mode == "code-server") {
                // drop the inline colours jett-dark may have left behind
                style.backgroundColor = "";
                style.color = "";
            }
            if (colors && colors.bg) {
                style.setProperty("--cs-tab-bg", colors.bg);
                if (colors.fg)
                    style.setProperty("--cs-tab-fg", colors.fg);
                else
                    style.removeProperty("--cs-tab-fg");
            }
            else {
                style.removeProperty("--cs-tab-bg");
                style.removeProperty("--cs-tab-fg");
            }
        }
        
        var aceTextColors = {};
        function getBodyColors(tab) {
            var type = tab.aml.type;
            if (type == "editor::ace" || type == "editor::immediate") {
                var theme = ace.theme;
                if (!theme || !theme.bg) return null;
                if (!aceTextColors[theme.cssClass]) {
                    // ace.theme.fg is the gutter colour; read the text colour
                    var div = document.createElement("div");
                    div.className = theme.cssClass;
                    div.style.display = "none";
                    document.body.appendChild(div);
                    aceTextColors[theme.cssClass] = getComputedStyle(div).color;
                    document.body.removeChild(div);
                }
                // ace.theme.bg is the gutter colour too: use the text area's
                var bg = theme.editorBg || theme.bg;
                // the Immediate window may sit on another colour (the
                // code-server editor themes put it on the panel colour):
                // take what its editor shows
                var el = type == "editor::immediate" && tab.editor
                    && tab.editor.ace && tab.editor.ace.container;
                var shown = el && getComputedStyle(el).backgroundColor;
                if (shown && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(shown))
                    bg = shown;
                return { bg: bg, fg: aceTextColors[theme.cssClass] };
            }
            if (type == "editor::terminal")
                return {
                    bg: settings.get("user/terminal/@backgroundColor"),
                    fg: settings.get("user/terminal/@foregroundColor")
                };
            if (type == "editor::output")
                return {
                    bg: settings.get("user/output/@backgroundColor"),
                    fg: settings.get("user/output/@foregroundColor")
                };
            // other editors (preview, welcome, image viewer, ...) set their own
            return { bg: tab.backgroundColor };
        }

        /**
         * Tabs get file icons!
         * @method setTabIcon
         * @param {} tab
         * @return
         */
        function setTabIcon(tab) {
            if (!tab.path) return;

            var iconHTML = (themeEnabled ? '<span class="filetree-icon '
                + getIconClass(tab.path)
                + '"></span>' : "")
                + escapeHTML(tab.title);
            tab.aml.$button.querySelector(".sessiontab_title").innerHTML = iconHTML;

        }

        /***** Lifecycle *****/

        plugin.on("load", function() {
            load();
        });
        plugin.on("unload", function() {
            enableJett(false);
            themeEnabled = false;
            mode = null;
        });

        /***** Register and define API *****/

        /**
         *
         **/
        plugin.freezePublicAPI({

        });

        register(null, {
            "theme.jett": plugin
        });

    }
});

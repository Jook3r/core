define(function(require, exports, module) {
    main.consumes = [
        "Plugin", "layout", "ace", "menus", "tabinteraction", "settings",
        "preferences",
        // consumed only so that this plugin loads after the flat theme
        // plugins: they reset the menubar height when leaving a flat skin,
        // and our themeChange listener has to run after theirs
        "theme.flat-light", "theme.flat-dark"
    ];
    main.provides = ["theme.slate"];
    return main;

    /**
     * Slate Dark / Slate Light skins.
     *
     * The look lives in less/ (built into the skin CSS by c9.static/build.js);
     * this plugin registers the skins and their editor themes, applies the
     * geometry that Cloud9 sets from JS, and has what a stylesheet can't do
     * on its own:
     *  - the accent colour, a preference: two custom properties on <html>
     *    that the skin's CSS reads (see less/palette-dark.less);
     *  - following the system's light or dark setting, a preference: the
     *    skin changes to its other variant with the system;
     *  - the size of the interface's text, a preference.
     */
    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var layout = imports.layout;
        var ace = imports.ace;
        var menus = imports.menus;
        var tabinteraction = imports.tabinteraction;
        var settings = imports.settings;
        var prefs = imports.preferences;

        /***** Initialization *****/

        var plugin = new Plugin("Ajax.org", main.consumes);

        var SKINS = [{
            name: "slate-dark",
            caption: "Slate Dark",
            color: "#1A1D23",
            aceTheme: "plugins/c9.ide.theme.slate/ace.themes/slate-dark",
            aceCaption: "Slate Dark"
        }, {
            name: "slate-light",
            caption: "Slate Light",
            color: "#ECEEF2",
            aceTheme: "plugins/c9.ide.theme.slate/ace.themes/slate-light",
            aceCaption: "Slate Light"
        }];

        /**
         * The accent colours: for each variant the colour of fills (primary
         * button, badge, switch; white text has to read on it) and the colour
         * of text and lines (links, matches, the focus ring; it has to read
         * on the cards). "blue" is the default, also written in the palettes
         * as the fallback of the custom properties.
         */
        var ACCENTS = {
            blue: { caption: "Blue", dark: ["#3F78E8", "#7FAEFF"], light: ["#2F6FDE", "#2460C8"] },
            violet: { caption: "Violet", dark: ["#7C5CE0", "#B49CFF"], light: ["#6B4BD6", "#5B3CC4"] },
            teal: { caption: "Teal", dark: ["#1E8E96", "#5CC8D0"], light: ["#107C84", "#0C6A72"] },
            green: { caption: "Green", dark: ["#2F9150", "#7FCF96"], light: ["#23803F", "#1C6E35"] },
            amber: { caption: "Amber", dark: ["#B26F08", "#E8B45A"], light: ["#9C6200", "#875400"] },
            rose: { caption: "Rose", dark: ["#CC4873", "#F291B2"], light: ["#C13C68", "#A93058"] }
        };

        /**
         * Geometry that Cloud9 sets from JS rather than CSS. Keep these in
         * sync with the LESS (e.g. @menu-bar-height in the palettes).
         *   menuHeight       height of the menu bar (menus.js default 31)
         *   minimizedHeight  menu bar height when minimized (default 12)
         *   plusMargin       offset of the "+" button used by the tab drag
         *                    animation (behaviors/page.js, default 11)
         *   tabRightDelta    tab strip padding correction when a tab closes
         *                    (ui/lib/page.js, default 15)
         */
        var GEOMETRY = {
            menuHeight: 40,
            minimizedHeight: 8,
            // the "+" margin-left (4px), which the drag code zeroes inline
            plusMargin: 4,
            // our tabs do not overlap (flat's do, by 25px) and collapse to
            // 0px: the padding must grow by the full tab width. page.js reads
            // "apf.tabRightDelta || 15", so 0 is written as a hair above it.
            tabRightDelta: 0.01
        };

        var active = false;
        var saved = null;
        var systemDark = null;

        function isSlate(name) {
            return /^slate-/.test(name || "");
        }

        var loaded = false;
        function load() {
            if (loaded) return false;
            loaded = true;

            SKINS.forEach(function(skin) {
                ace.addTheme({
                    caption: skin.aceCaption,
                    id: skin.aceTheme
                }, plugin);
                layout.addTheme({
                    group: "slate",
                    color: skin.color,
                    name: skin.name,
                    caption: skin.caption
                });
            });

            settings.on("read", function() {
                settings.setDefaults("user/slate", [
                    ["accent", "blue"],
                    ["followSystem", false],
                    ["fontSize", 13]
                ]);
            }, plugin);

            prefs.add({
                "General": {
                    "User Interface": {
                        "Slate Theme: Accent Colour": {
                            type: "dropdown",
                            path: "user/slate/@accent",
                            width: 130,
                            items: Object.keys(ACCENTS).map(function(name) {
                                return { caption: ACCENTS[name].caption, value: name };
                            }),
                            position: 3000
                        },
                        "Slate Theme: Follow the System's Dark Mode": {
                            type: "checkbox",
                            path: "user/slate/@followSystem",
                            position: 3100
                        },
                        "Slate Theme: Interface Text Size": {
                            type: "spinner",
                            path: "user/slate/@fontSize",
                            min: 11,
                            max: 16,
                            position: 3200
                        }
                    }
                }
            }, plugin);

            settings.on("user/slate", function() {
                applyStyle();
                followSystem();
            }, plugin);

            // The system's setting, now and when it changes
            if (window.matchMedia) {
                systemDark = window.matchMedia("(prefers-color-scheme: dark)");
                if (systemDark.addEventListener)
                    systemDark.addEventListener("change", followSystem);
            }

            // Leaving: restore the geometry before any themeChange listener
            // (e.g. the flat plugins) records it as "the old values".
            layout.on("eachTheme", function(e) {
                if (e.changed && active && !isSlate(layout.theme))
                    leave();
            }, plugin);

            // Entering: apply after the flat plugins reset their values.
            layout.on("themeChange", function(e) {
                if (isSlate(e.theme))
                    enter();
            }, plugin);

            if (isSlate(layout.theme))
                enter();
        }

        /***** Methods *****/

        function setMenuHeight(height, minimizedHeight) {
            menus.height = height;
            menus.minimizedHeight = minimizedHeight;
            var logobar = layout.getElement("logobar");
            if (logobar && !menus.minimized)
                logobar.setHeight(height);
        }

        function enter() {
            if (!active) {
                saved = {
                    menuHeight: menus.height,
                    minimizedHeight: menus.minimizedHeight,
                    plusMargin: tabinteraction.plusMargin,
                    tabRightDelta: apf.tabRightDelta
                };
                active = true;
            }
            setMenuHeight(GEOMETRY.menuHeight, GEOMETRY.minimizedHeight);
            tabinteraction.plusMargin = GEOMETRY.plusMargin;
            apf.tabRightDelta = GEOMETRY.tabRightDelta;
            applyStyle();
            followSystem();
        }

        function leave() {
            if (!active) return;
            active = false;
            setMenuHeight(saved.menuHeight, saved.minimizedHeight);
            tabinteraction.plusMargin = saved.plusMargin;
            apf.tabRightDelta = saved.tabRightDelta;
            saved = null;
            applyStyle();
        }

        /**
         * Writes the accent and the text size of the preferences to <html>,
         * as the custom properties the skin's CSS reads; removes them when
         * no Slate skin is active.
         */
        function applyStyle() {
            var style = document.documentElement.style;
            var variant = layout.theme == "slate-light" ? "light" : "dark";
            var accent = ACCENTS[settings.get("user/slate/@accent")] || ACCENTS.blue;
            var size = Math.max(11, Math.min(16, settings.getNumber("user/slate/@fontSize") || 13));
            if (active) {
                style.setProperty("--sl-accent", accent[variant][0]);
                style.setProperty("--sl-accent-text", accent[variant][1]);
                style.setProperty("--sl-font-size", size + "px");
                style.colorScheme = variant;
            }
            else {
                style.removeProperty("--sl-accent");
                style.removeProperty("--sl-accent-text");
                style.removeProperty("--sl-font-size");
                style.colorScheme = "";
            }
        }

        /**
         * With the preference on and a Slate skin active: changes to the
         * variant of the system's light or dark setting, with the editor,
         * terminal and output colours of that variant.
         */
        function followSystem() {
            if (!active || !systemDark || !settings.getBool("user/slate/@followSystem"))
                return;
            var wanted = systemDark.matches ? "slate-dark" : "slate-light";
            if (layout.theme != wanted && isSlate(layout.theme))
                layout.resetTheme(wanted);
        }

        /***** Lifecycle *****/

        plugin.on("load", function() {
            load();
        });
        plugin.on("unload", function() {
            leave();
            if (systemDark && systemDark.removeEventListener)
                systemDark.removeEventListener("change", followSystem);
            systemDark = null;
            loaded = false;
        });

        /***** Register and define API *****/

        /**
         * @singleton
         **/
        plugin.freezePublicAPI({
            /**
             * Whether a Slate skin is active.
             * @property {Boolean} active
             * @readonly
             */
            get active() { return active; },
            /**
             * The JS-side geometry applied while a Slate skin is active.
             * @property {Object} geometry
             * @readonly
             */
            get geometry() { return GEOMETRY; },
            /**
             * The accent colours to choose from, by name.
             * @property {Object} accents
             * @readonly
             */
            get accents() { return ACCENTS; }
        });

        register(null, {
            "theme.slate": plugin
        });
    }
});

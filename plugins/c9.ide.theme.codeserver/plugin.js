define(function(require, exports, module) {
    main.consumes = [
        "Plugin", "layout", "ace", "menus", "tabinteraction",
        // consumed only so that this plugin loads after the flat theme
        // plugins: they reset the menubar height when leaving a flat skin,
        // and our themeChange listener has to run after theirs
        "theme.flat-light", "theme.flat-dark"
    ];
    main.provides = ["theme.codeserver"];
    return main;

    /**
     * code-server Dark / code-server Light skins.
     * 
     * The look lives in less/ (built into the skin CSS by c9.static/build.js)
     * and in the shared Jett icon font; this plugin only registers the skins
     * and editor themes and applies the geometry that is set from JS.
     */
    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var layout = imports.layout;
        var ace = imports.ace;
        var menus = imports.menus;
        var tabinteraction = imports.tabinteraction;
        
        /***** Initialization *****/
        
        var plugin = new Plugin("Ajax.org", main.consumes);
        
        var SKINS = [{
            name: "code-server-dark",
            caption: "code-server Dark",
            color: "#191A1B",
            aceTheme: "plugins/c9.ide.theme.codeserver/ace.themes/code-server-dark",
            aceCaption: "code-server Dark"
        }, {
            name: "code-server-light",
            caption: "code-server Light",
            color: "#FAFAFD",
            aceTheme: "plugins/c9.ide.theme.codeserver/ace.themes/code-server-light",
            aceCaption: "code-server Light"
        }];
        
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
            plusMargin: 14,
            tabRightDelta: 25
        };
        
        var active = false;
        var saved = null;
        
        function isCodeServer(name) {
            return /^code-server-/.test(name || "");
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
                    group: "code-server",
                    color: skin.color,
                    name: skin.name,
                    caption: skin.caption
                });
            });
            
            // Leaving: restore the geometry before any themeChange listener
            // (e.g. the flat plugins) records it as "the old values".
            layout.on("eachTheme", function(e) {
                if (e.changed && active && !isCodeServer(layout.theme))
                    leave();
            }, plugin);
            
            // Entering: apply after the flat plugins reset their values.
            layout.on("themeChange", function(e) {
                if (isCodeServer(e.theme))
                    enter();
            }, plugin);
            
            if (isCodeServer(layout.theme))
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
        }
        
        function leave() {
            if (!active) return;
            active = false;
            setMenuHeight(saved.menuHeight, saved.minimizedHeight);
            tabinteraction.plusMargin = saved.plusMargin;
            apf.tabRightDelta = saved.tabRightDelta;
            saved = null;
        }
        
        /***** Lifecycle *****/
        
        plugin.on("load", function() {
            load();
        });
        plugin.on("unload", function() {
            leave();
            loaded = false;
        });
        
        /***** Register and define API *****/
        
        /**
         * @singleton
         **/
        plugin.freezePublicAPI({
            /**
             * Whether a code-server skin is active.
             * @property {Boolean} active
             * @readonly
             */
            get active() { return active; },
            /**
             * The JS-side geometry applied while a code-server skin is active.
             * @property {Object} geometry
             * @readonly
             */
            get geometry() { return GEOMETRY; }
        });
        
        register(null, {
            "theme.codeserver": plugin
        });
    }
});

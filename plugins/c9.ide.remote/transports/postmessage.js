define(function(require, exports, module) {
    main.consumes = [
        "Plugin", "commands", "c9"
    ];
    main.provides = ["remote.PostMessage"];
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var commands = imports.commands;
        var c9 = imports.c9;
        
        var previewBaseUrl = options.previewBaseUrl;
        
        var counter = 0;
        
        function PostMessage(iframe, sessionId) {
            /***** Initialization *****/
            
            var plugin = new Plugin("Ajax.org", main.consumes);
            var emit = plugin.getEmitter();
            
            var windows = [];
            // the windows the IDE opened for this preview ("pop out")
            var popouts = [];
            var styleSheets, scripts, html, pagePath;
            // the style sheets whose text the page has from the IDE
            var replaced = {};
            var enableHighlighting = true;
            
            var loaded = false;
            function load() {
                if (loaded) return false;
                loaded = true;
                
                var onMessage = function(e) {
                    if (c9.hosted && e.origin !== previewBaseUrl)
                        return;
                    
                    // Only the preview's own frame, or a window the IDE
                    // opened for it: any window that has the IDE's can send
                    // it a message. The page in the preview isn't trusted
                    // either (its origin is the sandbox's, "null"): what it
                    // sends is checked below.
                    var inFrame = e.source && e.source === iframe.contentWindow;
                    if (!inFrame && popouts.indexOf(e.source) == -1)
                        return;
                    
                    var data = e.data;
                    if (!data || sessionId != data.id)
                        return;
                    
                    if (data.message == "exec") {
                        // a key of the IDE was pressed in the page
                        if (inFrame && document.activeElement === iframe) {
                            emit("focus");
                            commands.execFromFrame(data.command, iframe);
                        }
                    }
                    else if (data.message == "callback") {
                        var cb = typeof data.cb == "number" && callbacks[data.cb];
                        if (cb) {
                            cb(data.data);
                            delete callbacks[data.cb];
                        }
                    }
                    else if (data.message == "focus") {
                        // the page has the keyboard
                        if (inFrame && document.activeElement === iframe)
                            emit("focus");
                    }
                    else if (data.message == "html.ready") {
                        // A page reports what it is made of, also when a
                        // link in the preview led to it. The IDE sends the
                        // page the text of these files while they are
                        // edited: only style sheets and scripts, and as the
                        // page's HTML only the file the IDE opened.
                        var ready = data.data || {};
                        styleSheets = toPaths(ready.styles, /\.css$/i);
                        scripts = toPaths(ready.scripts, /\.js$/i);
                        var href = toPaths([ready.href], /^/)[0];
                        html = href && (c9.hosted || href == framePath())
                            ? href : null;
                        // (where the page in the frame is, for its tab)
                        if (inFrame)
                            pagePath = href;
                        replaced = {};
                        
                        if (windows.indexOf(e.source) == -1)
                            windows.push(e.source);
                        
                        // Send available keys
                        e.source.postMessage({
                            id: sessionId,
                            type: "keys",
                            keys: commands.getFrameBindings()
                        }, "*");
                        
                        // todo: should this emit e, so that init messages are 
                        // sent only to newly added page?
                        emit("ready");
                    }
                };
                
                window.addEventListener("message", onMessage, false);
                plugin.addOther(function() {
                    window.removeEventListener("message", onMessage, false);
                });
                
                setInterval(function gc() {
                    if (getWindows().length)
                        return;
                    clearInterval(gc);
                    emit("empty");
                }, 5000);
            }
            
            /***** Methods *****/
            
            function toPath(href) {
                href = unescape(href);
                return c9.hosted
                    ? href.replace(new RegExp("^/" + c9.workspaceId), "")
                    : href;
            }
            
            // The paths of files in the workspace among what a page sent
            function toPaths(list, filter) {
                return (Array.isArray(list) ? list : []).filter(function(href) {
                    return typeof href == "string" && /^\/[^?#]*$/.test(href)
                        && filter.test(href);
                }).slice(0, 200).map(toPath);
            }
            
            // The path of the page the IDE opened in the frame
            function framePath() {
                var match = /^\w+:\/\/[^\/]*\/preview(\/[^?#]*)/.exec(iframe.src);
                return match && toPath(match[1]);
            }
            
            function addWindow(win) {
                if (win && popouts.indexOf(win) == -1)
                    popouts.push(win);
            }
            
            var callbacks = [];
            function wrapCallback(callback) {
                return callbacks.push(callback) - 1;
            }
            
            function getSources(callback) {
                return callback(null, {
                    styleSheets: styleSheets,
                    scripts: scripts,
                    html: html,
                    location: pagePath
                });
            }
            
            function getWindows() {
                windows = windows.filter(function(w) {
                    return w && !w.closed;
                });
                popouts = popouts.filter(function(w) {
                    return !w.closed;
                });
                return windows;
            }
            
            function send(message) {
                getWindows().forEach(function(w) {
                    w.postMessage(message, "*");
                });
            }
            
            function getStyleSheet() {
                
            }
            
            function getHTMLDocument(callback) {
                var message = {
                    id: sessionId,
                    type: "simpledom",
                    cb: wrapCallback(callback)
                };
                send(message);
            }
            
            function initHTMLDocument(dom) {
                var message = {
                    id: sessionId,
                    type: "initdom",
                    dom: dom
                };
                send(message);
            }
            
            function getScript() {
                
            }
            
            function updateStyleSheet(path, value) {
                var message = {
                    id: sessionId,
                    type: "updatecss",
                    path: path,
                    data: value
                };
                replaced[path] = true;
                send(message);
            }
            
            // Returns false when the page needs the whole style sheet: in
            // its sandbox it can't change a rule of one it loaded itself
            // (that sheet is another origin's), only of one whose text it
            // got from the IDE.
            function updateStyleRule(url, rule) {
                if (!replaced[url])
                    return false;
                
                var message = {
                    id: sessionId,
                    type: "stylerule",
                    url: url,
                    rule: rule
                };
                send(message);
            }
            
            function processDOMChanges(edits) {
                var message = {
                    id: sessionId,
                    type: "domedits",
                    edits: edits
                };
                send(message);
            }
            
            function updateScript() {
                
            }
            
            function deleteStyleSheet(url) {
                var message = {
                    id: sessionId,
                    type: "update",
                    url: url,
                    del: true
                };
                send(message);
            }
            
            function deleteScript() {
                
            }
            
            function reload() {
                var message = {
                    id: sessionId,
                    type: "reload"
                };
                send(message);
            }
            
            var lastQuery;
            function highlightCSSQuery(query, force) {
                if (!force && lastQuery == query || !enableHighlighting) 
                    return;
                    
                lastQuery = query;
                
                var message = {
                    id: sessionId,
                    type: "highlight",
                    query: query
                };
                send(message);
            }
            
            function reveal(query) {
                var message = {
                    id: sessionId,
                    type: "reveal",
                    query: query || lastQuery
                };
                send(message);
            }
            
            /***** Lifecycle *****/
            
            plugin.on("load", function() {
                load();
            });
            plugin.on("enable", function() {
                
            });
            plugin.on("disable", function() {
                
            });
            plugin.on("unload", function() {
                loaded = false;
            });
            
            /***** Register and define API *****/
            
            /**
             * 
             **/
            plugin.freezePublicAPI({
                /**
                 * 
                 */
                get enableHighlighting() { return enableHighlighting; },
                set enableHighlighting(v) { 
                    if (!v) highlightCSSQuery();
                    enableHighlighting = v;
                },
                
                _events: [
                    /**
                     * @event draw
                     */
                    "draw",
                    "empty"
                ],
                
                getWindows: getWindows,
                
                /**
                 * Adds a window that the IDE opened with the preview's page
                 * (a window of its own): the page in it is connected to the
                 * IDE as the one in the frame is.
                 * @param {Window} win
                 */
                addWindow: addWindow,
                
                /**
                 * 
                 */
                reload: reload,
                
                /**
                 * 
                 */
                getSources: getSources,
                
                /**
                 * 
                 */
                getStyleSheet: getStyleSheet,
                
                /**
                 * 
                 */
                getHTMLDocument: getHTMLDocument,
                
                /**
                 * 
                 */
                initHTMLDocument: initHTMLDocument,
                
                /**
                 * 
                 */
                getScript: getScript,
                
                /**
                 * 
                 */
                updateStyleSheet: updateStyleSheet,
                
                /**
                 * 
                 */
                updateStyleRule: updateStyleRule,
                
                /**
                 * 
                 */
                processDOMChanges: processDOMChanges,
                
                /**
                 * 
                 */
                updateScript: updateScript,
                
                /**
                 * 
                 */
                deleteStyleSheet: deleteStyleSheet,
                
                /**
                 * 
                 */
                deleteScript: deleteScript,
                
                /**
                 * 
                 */
                highlightCSSQuery: highlightCSSQuery,
                
                /**
                 * 
                 */
                reveal: reveal
            });
            
            plugin.load(null, "postmessage");
            
            return plugin;
        }
        
        register(null, {
            "remote.PostMessage": PostMessage
        });
    }
});
/**
 * A debugger for Cloud9's debug panel that speaks the Debug Adapter
 * Protocol (DAP), the protocol of the debuggers of VS Code: one client for
 * debugpy (Python), Delve (Go) and whatever else has an adapter.
 *
 * A runner that names this debugger starts the program with its adapter
 * listening on a port, and says how to attach:
 *
 *   "debugger": "dap",
 *   "debugport": 15471,
 *   "dap": { "adapter": "debugpy", "arguments": { "justMyCode": true } }
 *
 * (arguments: those of the adapter's "attach" request.) The IDE connects
 * through ./netproxy.js, which runs on the server, and then: initialize,
 * attach, the breakpoints of every file, configurationDone; the program
 * runs until a breakpoint or an exception stops it.
 */
define(function(require, exports, module) {
    "use strict";

    main.consumes = ["Plugin", "c9", "debugger", "dialog.error"];
    main.provides = ["dapdebugger"];
    return main;

    function main(options, imports, register) {
        var Plugin = imports.Plugin;
        var c9 = imports.c9;
        var debug = imports["debugger"];
        var showError = imports["dialog.error"].show;

        var Frame = debug.Frame;
        var Source = debug.Source;
        var Variable = debug.Variable;
        var Scope = debug.Scope;

        var TYPE = "dap";
        var PROXY = require("text!./netproxy.js");
        var REQUEST_TIMEOUT = 20000;
        var MAX_FRAMES = 50;
        var MAX_VARIABLES = 500;

        var plugin = new Plugin("Ajax.org", main.consumes);
        var emit = plugin.getEmitter();

        /***** State *****/

        var socket = null;
        var attached = false;
        var state = null;               // null, "running" or "stopped"
        var capabilities = {};
        var config = {};                // the runner's "dap"
        var seq = 1;
        var pending = {};               // request seq -> callback
        var buffer = "";
        var threadId = null;            // the thread that stopped last
        var stack = [];
        var breakBehavior = { uncaught: true, all: false };
        var onProxy = null;             // called with the proxy's first line

        /***** Paths *****/

        function trimSlash(dir) {
            return String(dir || "").replace(/\/+$/, "");
        }

        // "/src/a.py" in the workspace, "~/x.py" in the home folder -> the file's path
        function toFsPath(path) {
            path = String(path || "");
            if (/^~(\/|$)/.test(path)) return trimSlash(c9.home) + path.slice(1);
            return trimSlash(c9.workspaceDir) + (path.charAt(0) == "/" ? path : "/" + path);
        }

        // ... and back; a file elsewhere keeps its path (the IDE can't open it)
        function toIdePath(fsPath) {
            fsPath = String(fsPath || "");
            var ws = trimSlash(c9.workspaceDir);
            if (fsPath.indexOf(ws + "/") === 0) return fsPath.slice(ws.length);
            var home = trimSlash(c9.home);
            if (home && fsPath.indexOf(home + "/") === 0) return "~" + fsPath.slice(home.length);
            return fsPath;
        }

        /***** The protocol *****/

        function send(message) {
            if (socket) socket.send(JSON.stringify(message) + "\n");
        }

        // callback(err, body)
        function request(command, args, callback) {
            if (!socket) return callback && callback(new Error("The debugger is not connected"));
            var id = seq++;
            var timer = setTimeout(function() {
                if (!pending[id]) return;
                delete pending[id];
                callback && callback(new Error("The debugger did not answer (" + command + ")"));
            }, REQUEST_TIMEOUT);
            pending[id] = function(err, body) {
                clearTimeout(timer);
                callback && callback(err, body);
            };
            send({ seq: id, type: "request", command: command, arguments: args || {} });
        }

        function onData(data) {
            buffer += data;
            var lines = buffer.split("\n");
            buffer = lines.pop();
            lines.forEach(function(line) {
                // (the socket's own "Content-Length:0" when it reconnects is no message)
                if (line.charAt(0) != "{") return;
                var message;
                try {
                    message = JSON.parse(line);
                } catch (e) {
                    return;
                }
                try {
                    onMessage(message);
                } catch (e) {
                    console.error("[dap]", e);
                }
            });
        }

        function onMessage(message) {
            if (message.type == "proxy") {
                var fn = onProxy;
                onProxy = null;
                return fn && fn(message);
            }
            if (message.type == "response") {
                var callback = pending[message.request_seq];
                delete pending[message.request_seq];
                if (!callback) return;
                if (message.success) return callback(null, message.body || {});
                var text = message.body && message.body.error && message.body.error.format || message.message || "The request failed";
                return callback(new Error(text));
            }
            if (message.type == "request") {
                // the adapter asks the client (runInTerminal, ...): not here
                return send({ seq: seq++, type: "response", request_seq: message.seq, command: message.command,
                    success: false, message: "Not supported by Cloud9" });
            }
            if (message.type != "event") return;
            var body = message.body || {};
            switch (message.event) {
                case "initialized":
                    return configure();
                case "stopped":
                    return onStopped(body);
                case "continued":
                    if (body.allThreadsContinued !== false || body.threadId == threadId) setRunning();
                    return;
                case "terminated":
                case "exited":
                    // the program is over: the adapter may go as well
                    // (a headless Delve would wait for another client)
                    return detach(true);
            }
        }

        function setState(value) {
            if (state === value) return;
            state = value;
            emit("stateChange", { state: state });
        }

        function setRunning() {
            stack = [];
            emit("frameActivate", { frame: null });
            setState("running");
        }

        /***** Starting *****/

        // After "initialized": the breakpoints, then the program may run
        var configured = null;
        function configure() {
            var breakpoints = emit("getBreakpoints") || [];
            sendBreakpoints(breakpoints, null, function() {
                sendExceptionBreakpoints(function() {
                    var done = function() {
                        attached = true;
                        emit("attach", { breakpoints: breakpoints });
                        if (state != "stopped") setState("running");
                        var fn = configured;
                        configured = null;
                        fn && fn();
                    };
                    if (capabilities.supportsConfigurationDoneRequest) request("configurationDone", {}, done);
                    else done();
                });
            });
        }

        function start(callback) {
            configured = callback;
            request("initialize", {
                clientID: "cloud9",
                clientName: "Cloud9",
                adapterID: String(config.adapter || "dap"),
                locale: "en",
                linesStartAt1: true,
                columnsStartAt1: true,
                pathFormat: "path",
                supportsVariableType: true
            }, function(err, body) {
                if (err) return fail(err);
                capabilities = body || {};
                // (some adapters answer "attach" only after configurationDone)
                request(config.request == "launch" ? "launch" : "attach", config.arguments || {}, function(err) {
                    if (err) fail(err);
                });
            });
            function fail(err) {
                configured = null;
                showError("The debugger could not start: " + err.message);
                callback && callback(err);
                detach();
            }
        }

        // The page was loaded again while the program was being debugged:
        // the session goes on. Is the program stopped?
        function resume_(callback) {
            attached = true;
            emit("attach", { breakpoints: emit("getBreakpoints") || [] });
            request("threads", {}, function(err, body) {
                var threads = !err && body.threads || [];
                var i = 0;
                (function next() {
                    var thread = threads[i++];
                    if (!thread) {
                        setState("running");
                        return callback && callback();
                    }
                    request("stackTrace", { threadId: thread.id, startFrame: 0, levels: 1 }, function(err, body) {
                        if (err || !body.stackFrames || !body.stackFrames.length) return next();
                        onStopped({ threadId: thread.id, reason: "pause" });
                        callback && callback();
                    });
                })();
            });
        }

        /***** Breakpoints *****/

        // DAP sets the breakpoints of a file all at once. only: a path, or
        // null for every file that has breakpoints
        function sendBreakpoints(breakpoints, only, callback) {
            var files = {};
            if (only) files[only] = [];
            breakpoints.forEach(function(bp) {
                if (only && bp.path != only) return;
                (files[bp.path] = files[bp.path] || []).push(bp);
            });
            var paths = Object.keys(files);
            var waiting = paths.length + 1;
            paths.forEach(function(path) {
                var list = files[path].filter(function(bp) { return bp.enabled !== false; });
                request("setBreakpoints", {
                    source: { path: toFsPath(path), name: path.split("/").pop() },
                    breakpoints: list.map(function(bp) {
                        var b = { line: bp.line + 1 };
                        if (bp.condition) b.condition = bp.condition;
                        return b;
                    }),
                    sourceModified: false
                }, function(err, body) {
                    // where the adapter really put them
                    (!err && body.breakpoints || []).forEach(function(result, i) {
                        var bp = list[i];
                        if (!bp) return;
                        bp.id = result.id != null ? result.id : bp.id;
                        if (result.verified !== false && typeof result.line == "number" && result.line - 1 != bp.line) {
                            bp.actual = { line: result.line - 1, column: 0 };
                            emit("breakpointUpdate", { breakpoint: bp });
                        }
                    });
                    done();
                });
            });
            done();
            function done() {
                if (!--waiting) callback && callback();
            }
        }

        function updateBreakpoint(bp, callback) {
            if (!attached) return callback && callback(null, bp, {});
            sendBreakpoints(emit("getBreakpoints") || [], bp.path, function() {
                callback && callback(null, bp, {});
            });
        }

        // Which exceptions stop the program: "uncaught", "all", or none
        function sendExceptionBreakpoints(callback) {
            var filters = (capabilities.exceptionBreakpointFilters || []).map(function(f) { return f.filter; });
            if (!filters.length) return callback && callback();
            var chosen = !breakBehavior.all && !breakBehavior.uncaught ? []
                : breakBehavior.all ? filters.filter(function(f) { return !/user/i.test(f); })
                : filters.filter(function(f) { return /uncaught|unhandled|panic/i.test(f) && !/user/i.test(f); });
            request("setExceptionBreakpoints", { filters: chosen }, function() {
                callback && callback();
            });
        }

        function setBreakBehavior(type, enabled, callback) {
            breakBehavior = { uncaught: !!enabled && type == "uncaught", all: !!enabled && type == "all" };
            if (!attached) return callback && callback();
            sendExceptionBreakpoints(callback);
        }

        /***** A stop *****/

        function onStopped(body) {
            threadId = body.threadId != null ? body.threadId : threadId;
            var stopId = threadId;
            request("stackTrace", { threadId: stopId, startFrame: 0, levels: MAX_FRAMES }, function(err, result) {
                if (err || threadId !== stopId) return;
                var frames = (result.stackFrames || []).map(function(frame, i) {
                    var source = frame.source || {};
                    return new Frame({
                        index: i,
                        name: frame.name || "(anonymous)",
                        column: Math.max(0, (frame.column || 1) - 1),
                        id: frame.id,
                        line: Math.max(0, (frame.line || 1) - 1),
                        path: source.path ? toIdePath(source.path) : source.name || "",
                        sourceId: source.path || source.name || "",
                        thread: stopId,
                        istop: i === 0,
                        variables: []
                    });
                });
                if (!frames.length) return;
                withScopes(frames, function() {
                    if (threadId !== stopId) return;
                    stack = frames;
                    setState("stopped");
                    // Show the first frame that is a file of the workspace:
                    // a Go panic, for one, stops deep inside the runtime
                    var active = frames[0];
                    if (!inWorkspace(active)) {
                        active = frames.filter(inWorkspace)[0] || active;
                        // the call stack panel selects the frame marked as top
                        frames[0].istop = false;
                        active.istop = true;
                    }
                    emit("frameActivate", { frame: active });
                    if (body.reason == "exception") {
                        exceptionInfo(stopId, body, function(exception) {
                            emit("exception", { frame: active, frames: frames, exception: exception });
                        });
                    }
                    else {
                        emit("break", { frame: active, frames: frames });
                    }
                });
            });
        }

        function inWorkspace(frame) {
            return String(frame.sourceId).indexOf(trimSlash(c9.workspaceDir) + "/") === 0;
        }

        // The scopes of each frame (Locals, Globals, ...): their variables
        // are asked for when the panel shows them (getScope)
        function withScopes(frames, callback) {
            var waiting = frames.length + 1;
            frames.forEach(function(frame, i) {
                request("scopes", { frameId: frame.id }, function(err, body) {
                    frame.scopes = (!err && body.scopes || []).map(function(scope, j) {
                        return new Scope({
                            index: j,
                            type: scope.name,
                            id: scope.variablesReference,
                            frameIndex: i,
                            frame: frame
                        });
                    });
                    if (frame.scopes[0]) frame.scopes[0].isOpen = true;
                    if (!--waiting) callback();
                });
            });
            if (!--waiting) callback();
        }

        function exceptionInfo(thread, body, callback) {
            var fallback = function(name, text) {
                callback(new Variable({ ref: null, name: name || "Exception",
                    value: text || body.text || body.description || "", type: "Exception", children: false }));
            };
            if (!capabilities.supportsExceptionInfoRequest) return fallback();
            request("exceptionInfo", { threadId: thread }, function(err, info) {
                if (err) return fallback();
                fallback(info.exceptionId, info.description || info.details && info.details.message);
            });
        }

        /***** Variables *****/

        function buildVariable(v, scope, parentRef) {
            var variable = new Variable({
                ref: v.variablesReference || null,
                name: v.name != null ? v.name : v.result,
                value: v.value != null ? v.value : v.result,
                type: v.type || "",
                children: !!v.variablesReference,
                properties: null,
                scope: scope
            });
            // where it can be set: in its container
            variable.dapParent = parentRef;
            variable.dapName = v.evaluateName;
            return variable;
        }

        function variables(ref, scope, callback) {
            request("variables", { variablesReference: ref }, function(err, body) {
                if (err) return callback(err);
                callback(null, (body.variables || []).slice(0, MAX_VARIABLES).map(function(v) {
                    return buildVariable(v, scope, ref);
                }));
            });
        }

        function getScope(frame, scope, callback) {
            if (!scope.id) return callback(null, [], scope, frame);
            variables(scope.id, scope, function(err, list) {
                if (err) return callback(err);
                scope.variables = list;
                callback(null, list, scope, frame);
            });
        }

        function getProperties(variable, callback) {
            if (!variable.ref) return callback(new Error("No children"));
            variables(variable.ref, variable.scope, function(err, list) {
                if (err) return callback(err);
                variable.properties = list;
                callback(null, list, variable);
            });
        }

        function evaluate(expression, frame, global, disableBreak, callback) {
            var args = { expression: String(expression), context: "repl" };
            var top = frame || stack[0];
            if (top && !global) args.frameId = top.id;
            request("evaluate", args, function(err, body) {
                if (err) return callback(err);
                var variable = buildVariable({ name: expression, value: body.result, type: body.type,
                    variablesReference: body.variablesReference }, null, null);
                callback(null, variable);
            });
        }

        function setVariable(variable, value, frame, callback) {
            var done = function(err, body) {
                if (err) return callback(err);
                variable.value = body.value != null ? body.value : body.result != null ? body.result : value;
                if (body.type) variable.type = body.type;
                callback(null, variable);
            };
            if (variable.dapParent && capabilities.supportsSetVariable)
                return request("setVariable", { variablesReference: variable.dapParent, name: variable.name, value: String(value) }, done);
            if (variable.dapName && capabilities.supportsSetExpression)
                return request("setExpression", { expression: variable.dapName, value: String(value), frameId: frame && frame.id }, done);
            callback(new Error("This debugger can't change the variable"));
        }

        /***** Running *****/

        function step(command) {
            return function(callback) {
                if (threadId == null) return callback && callback(new Error("The program is not stopped"));
                request(command, { threadId: threadId }, function(err) {
                    if (!err) setRunning();
                    callback && callback(err);
                });
            };
        }

        function suspend(callback) {
            request("threads", {}, function(err, body) {
                var id = threadId != null ? threadId : !err && body.threads && body.threads[0] && body.threads[0].id;
                if (id == null) return callback && callback(err || new Error("No thread to pause"));
                request("pause", { threadId: id }, function(err) {
                    callback && callback(err);
                });
            });
        }

        function getFrames(callback) {
            emit("getFrames", { frames: stack });
            callback(null, stack);
        }

        function getSources(callback) {
            var sources = [];
            callback(null, sources);
            emit("sources", { sources: sources });
        }

        function getSource(source, callback) {
            callback(null, new Source());
        }

        /***** Attach and detach *****/

        function attach(_socket, reconnect, callback) {
            socket = _socket;
            buffer = "";
            pending = {};
            seq = 1;
            stack = [];
            threadId = null;
            capabilities = {};
            var process = debug.getRunningProcess && debug.getRunningProcess() || null;
            config = currentRunner && currentRunner.dap || process && process.runner && process.runner.dap || {};

            socket.on("data", onData, plugin);
            socket.on("error", function(err) {
                // after the session's end the proxy just exits: the debugger
                // would connect again, to a program that is gone
                if (socket) emit("error", err);
            }, plugin);
            socket.on("end", function() {
                if (socket) detach();
            }, plugin);
            // the proxy says whether a session is going on already
            onProxy = function(message) {
                emit("connect");
                if (message.started) resume_(callback);
                else start(callback);
            };
            socket.connect();
            emit("frameActivate", { frame: null });
        }

        function detach(ended) {
            var s = socket;
            if (!s && !attached) return;
            socket = null;
            if (s) {
                // the program goes on by itself (or was stopped by the IDE)
                try {
                    s.send(JSON.stringify({ seq: seq++, type: "request", command: "disconnect",
                        arguments: { terminateDebuggee: ended === true } }) + "\n");
                } catch (e) {}
                s.close();
            }
            Object.keys(pending).forEach(function(id) {
                var fn = pending[id];
                delete pending[id];
                fn(new Error("The debug session ended"));
            });
            stack = [];
            threadId = null;
            attached = false;
            onProxy = null;
            emit("frameActivate", { frame: null });
            setState(null);
            emit("detach");
        }

        // the runner of the process that is being attached to: its "dap"
        var currentRunner = null;
        function getProxySource(process) {
            currentRunner = process.runner;
            return PROXY.replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/\/\/.*/g, "")
                .replace(/[\n\r]/g, "")
                .replace(/\{DEBUGGED_PROCESS_PORT\}/, parseInt(process.runner.debugport, 10))
                .replace(/\{DEBUGGED_PROCESS_HOST\}/, /^[\w.-]+$/.test(process.runner.debughost || "") ? process.runner.debughost : "127.0.0.1");
        }

        /***** Lifecycle *****/

        plugin.on("load", function() {
            debug.registerDebugger(TYPE, plugin);
        });
        plugin.on("unload", function() {
            debug.unregisterDebugger(TYPE, plugin);
            socket = null;
            attached = false;
            state = null;
            stack = [];
        });

        /***** Register and define API *****/

        plugin.freezePublicAPI({
            /** What this debugger can do */
            features: {
                scripts: false,
                conditionalBreakpoints: true,
                liveUpdate: false,
                updateWatchedVariables: true,
                updateScopeVariables: true,
                setBreakBehavior: true,
                executeCode: true
            },
            type: TYPE,
            get state() { return state; },
            get attached() { return attached; },
            get breakOnExceptions() { return breakBehavior.all; },
            get breakOnUncaughtExceptions() { return breakBehavior.uncaught; },

            _events: ["attach", "detach", "suspend", "setScriptSource", "error", "getBreakpoints",
                "breakpointUpdate", "break", "stateChange", "exception", "frameActivate", "getFrames",
                "sources", "sourcesCompile", "connect"],

            attach: attach,
            detach: detach,
            getSources: getSources,
            getSource: getSource,
            getFrames: getFrames,
            getScope: getScope,
            getProperties: getProperties,
            stepInto: step("stepIn"),
            stepOver: step("next"),
            stepOut: step("stepOut"),
            resume: step("continue"),
            suspend: suspend,
            evaluate: evaluate,
            setVariable: setVariable,
            setBreakpoint: updateBreakpoint,
            changeBreakpoint: updateBreakpoint,
            clearBreakpoint: updateBreakpoint,
            listBreakpoints: function(callback) { callback(null, emit("getBreakpoints") || []); },
            setBreakBehavior: setBreakBehavior,
            serializeVariable: function(variable, callback) { callback(variable.value); },
            getProxySource: getProxySource
        });

        register(null, { dapdebugger: plugin });
    }
});

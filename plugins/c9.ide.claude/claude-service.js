/**
 * Server half of the Claude chat panel (c9.ide.claude).
 *
 * Loaded into the vfs process with ext.loadRemotePlugin("claude", ...). It
 * runs the user's own `claude` CLI (Claude Code) in headless streaming mode:
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *          --include-partial-messages --permission-prompt-tool stdio
 *          [--permission-mode <mode>] [--model <alias>] [--resume <uuid>]
 *
 * and relays its stdout (one JSON message per line) to the IDE client over a
 * vfs stream. One CLI process per chat, started lazily by the first message,
 * killed after IDLE_TIMEOUT without activity (never in the middle of a turn),
 * on "New session", and when the vfs process (one per IDE connection) goes
 * away. The next message after a kill resumes the conversation with
 * --resume <session id>.
 *
 * Nothing from the client reaches the command line except values picked from
 * whitelists (model alias, permission mode) or validated (session UUID, the
 * path of the claude binary from the user's settings). The CLI is spawned
 * with an argument array, never through a shell.
 */
"use strict";

module.exports = function(vfs, options, register) {
    var childProcess = require("child_process");
    var fs = require("fs");
    var path = require("path");
    var os = require("os");
    var Stream = require("stream");

    /***** Constants *****/

    var IDLE_TIMEOUT = 20 * 60 * 1000;      // kill an idle CLI after 20 minutes
    var DISCONNECT_GRACE = 60 * 1000;       // kill it this long after its client went away
    var KILL_GRACE = 3000;                  // SIGTERM -> SIGKILL
    var VERSION_TIMEOUT = 20000;
    var FLUSH_DELAY = 15;                   // batch events sent to the client (ms)
    var STDERR_TAIL = 4000;
    var MAX_LINE = 16 * 1024 * 1024;        // longer stdout lines are skipped
    var MAX_TEXT = 200000;
    var MAX_IMAGES = 10;
    var MAX_IMAGE_B64 = 8 * 1024 * 1024;
    var MAX_RESULT_TEXT = 20000;            // tool results relayed to the panel are cut here
    var MAX_INPUT_STRING = 50000;           // long strings in tool inputs (Write content, ...)
    var HISTORY_TAIL = 16 * 1024 * 1024;    // read at most the last 16 MB of a transcript
    var HISTORY_MESSAGES = 400;             // and send at most this many messages
    var HISTORY_BYTES = 3 * 1024 * 1024;
    var HISTORY_RESULT_TEXT = 4000;
    var SESSION_SCAN = 50;                  // session list: the most recent transcripts read
    var SESSION_STAT_LIMIT = 5000;          // ... out of at most this many files looked at
    var SESSION_PEEK = 64 * 1024;           // bytes read at the head and the tail of each
    var RECENT_MS = 2 * 60 * 1000;          // written this recently: probably open elsewhere
    var RECORD_LIMIT = 200;                 // live-process records read (<config>/sessions)
    var RECORD_MAX_SIZE = 64 * 1024;
    var ARCHIVE_LIMIT = 500;                // archived ids the panel can send

    // model aliases and ids (list_models gives e.g. "sonnet", "claude-opus-4-8");
    // a letter first, so that a value can never pass as an option
    var MODEL_RE = /^[a-z][a-z0-9.\-]{0,63}(\[1m\])?$/i;
    var EFFORTS = { low: true, medium: true, high: true, xhigh: true, max: true };
    var CONTROL_TIMEOUT = 10000;
    // no mode: the CLI uses the user's own defaultMode (~/.claude/settings.json)
    var MODES = { "default": true, acceptEdits: true, plan: true };
    var IMAGE_TYPES = { "image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true };
    var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    var LOGIN_HINT_RE = /\/login|not logged in|api key|authentication|oauth/i;
    var BASE64_RE = /^[A-Za-z0-9+\/]*={0,2}$/;

    // Variables that tie a process to the Claude Code session that started
    // it (e.g. when Cloud9 itself runs under Claude Code). Left in place, the
    // child reuses that session's id and its remote transport.
    var LEAKED_ENV = [
        "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_REMOTE_SESSION_ID",
        "CLAUDE_CODE_REMOTE_SDK_URL", "CLAUDE_CODE_CCR_EVENT_FLUSH_POLICY",
        "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "CLAUDE_AFTER_LAST_COMPACT",
        "CLAUDE_CODE_DEBUG", "AI_AGENT", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_TEE_SDK_STDOUT", "CLAUDE_CODE_DIAGNOSTICS_FILE",
        // the server's own node options and trace context are not claude's
        "NODE_OPTIONS", "TRACEPARENT", "TRACESTATE"
    ];
    var LEAKED_ENV_RE = /^CLAUDE_CODE_RESUME_/;

    var home = process.env.HOME || os.homedir();
    var cwd = vfs.workspaceDir || options.workspaceDir || home;

    /***** State *****/

    var client = null;          // event stream to the IDE client
    var queue = [];             // events waiting to be flushed to the client
    var flushTimer = null;
    var disconnectTimer = null;
    var cli = null;             // the running CLI (see spawnCli)
    var binCache = Object.create(null);     // "" -> the binary found by searching
    var versionCache = Object.create(null); // binary -> version string
    var nextRequestId = 1;
    var resumePlans = Object.create(null);  // session id -> { cwd, ... } for its next spawn
    var ownPids = Object.create(null);      // this panel's CLI processes that have not exited

    /***** Client stream *****/

    function connect(callback) {
        var stream = new Stream();
        stream.readable = true;

        if (client && client !== stream)
            client.emit("end");
        client = stream;
        clearTimeout(disconnectTimer);

        stream.on("close", function() {
            if (client !== stream) return;
            client = null;
            // the vfs process normally goes away with its connection; when it
            // does not (in-process vfs), do not keep the CLI running forever
            clearTimeout(disconnectTimer);
            disconnectTimer = setTimeout(function() {
                if (!client) stopCli("disconnect");
            }, DISCONNECT_GRACE);
        });

        callback(null, { stream: stream });

        // tell a (re)connecting client what is going on
        send({
            ev: "state",
            running: !!cli,
            pid: cli && cli.pid || null,
            busy: !!(cli && cli.busy),
            sessionId: cli && cli.sessionId || null,
            mode: cli && cli.mode || null,
            pending: cli ? Object.keys(cli.pending).map(function(id) {
                return cli.pending[id].message;
            }) : []
        });
    }

    function has(obj, key) {
        return typeof key == "string" && Object.prototype.hasOwnProperty.call(obj, key);
    }

    function send(event) {
        queue.push(event);
        if (!flushTimer)
            flushTimer = setTimeout(flush, FLUSH_DELAY);
    }
    var sendEvent = send;

    function flush() {
        flushTimer = null;
        if (!queue.length) return;
        var events = queue;
        queue = [];
        if (!client) return;
        try {
            client.emit("data", JSON.stringify(events));
        } catch (e) {
            console.error("[claude] could not send events", e);
        }
    }

    /***** Finding the CLI *****/

    function isExecutable(file) {
        try {
            var stat = fs.statSync(file);
            if (!stat.isFile()) return false;
            fs.accessSync(file, fs.constants.X_OK);
            return true;
        } catch (e) {
            return false;
        }
    }

    function checkUserPath(userPath) {
        if (typeof userPath != "string" || !userPath.trim())
            return null;
        userPath = userPath.trim();
        if (userPath.length > 4096 || userPath.indexOf("\0") != -1)
            throw new Error("Invalid path to claude");
        if (/^~(\/|$)/.test(userPath))
            userPath = path.join(home, userPath.slice(1));
        if (!path.isAbsolute(userPath))
            throw new Error("The path to claude must be absolute: " + userPath);
        return path.normalize(userPath);
    }

    function findClaude(userPath, callback) {
        var tried = [];
        var custom;
        try {
            custom = checkUserPath(userPath);
        } catch (e) {
            return callback(e, null, tried);
        }
        if (custom) {
            tried.push(custom);
            return callback(null, isExecutable(custom) ? custom : null, tried);
        }
        if (binCache[""] && isExecutable(binCache[""]))
            return callback(null, binCache[""], [binCache[""]]);

        var candidates = [];
        (process.env.PATH || "").split(path.delimiter).forEach(function(dir) {
            if (dir && path.isAbsolute(dir))
                candidates.push(path.join(dir, "claude"));
        });
        candidates.push(
            path.join(home, ".local/bin/claude"),
            path.join(home, ".claude/local/claude"),
            "/usr/local/bin/claude",
            "/usr/bin/claude",
            // npm's global bin is usually next to node itself
            path.join(path.dirname(process.execPath), "claude")
        );
        for (var i = 0; i < candidates.length; i++) {
            if (tried.indexOf(candidates[i]) != -1) continue;
            tried.push(candidates[i]);
            if (isExecutable(candidates[i]))
                return callback(null, binCache[""] = candidates[i], tried);
        }

        // last resort: ask npm where its global prefix is
        var npm = path.join(path.dirname(process.execPath), "npm");
        childProcess.execFile(isExecutable(npm) ? npm : "npm", ["prefix", "-g"], {
            env: cleanEnv(null),
            timeout: 10000
        }, function(err, stdout) {
            var prefix = !err && String(stdout || "").trim();
            if (prefix && path.isAbsolute(prefix)) {
                var bin = path.join(prefix, "bin", "claude");
                if (tried.indexOf(bin) == -1) {
                    tried.push(bin);
                    if (isExecutable(bin))
                        return callback(null, binCache[""] = bin, tried);
                }
            }
            callback(null, null, tried);
        });
    }

    function cleanEnv(bin) {
        var env = {};
        Object.keys(process.env).forEach(function(key) {
            if (LEAKED_ENV.indexOf(key) == -1 && !LEAKED_ENV_RE.test(key))
                env[key] = process.env[key];
        });
        // MCP servers connect in the background: the first answer does not
        // wait for a slow one
        env.MCP_CONNECTION_NONBLOCKING = "true";
        // systemd services get a minimal PATH; an npm-installed claude is a
        // script that starts with "#!/usr/bin/env node"
        var dirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
        [path.dirname(process.execPath), bin && path.dirname(bin)].forEach(function(dir) {
            if (dir && dirs.indexOf(dir) == -1)
                dirs.push(dir);
        });
        env.PATH = dirs.join(path.delimiter);
        return env;
    }

    function getVersion(bin, callback) {
        if (versionCache[bin])
            return callback(null, versionCache[bin]);
        childProcess.execFile(bin, ["--version"], {
            cwd: cwd,
            env: cleanEnv(bin),
            timeout: VERSION_TIMEOUT
        }, function(err, stdout, stderr) {
            if (err)
                return callback(new Error("`" + bin + " --version` failed: "
                    + (String(stderr || "").trim() || err.message)));
            versionCache[bin] = String(stdout || "").trim().split("\n")[0].slice(0, 200);
            callback(null, versionCache[bin]);
        });
    }

    function status(opts, callback) {
        opts = opts || {};
        findClaude(opts.path, function(err, bin, tried) {
            if (err)
                return callback(null, { found: false, error: err.message, tried: tried });
            if (!bin)
                return callback(null, { found: false, tried: tried, custom: !!checkUserPathSafe(opts.path) });
            getVersion(bin, function(err, version) {
                callback(null, {
                    found: true,
                    path: bin,
                    version: version || null,
                    error: err ? err.message : null,
                    running: !!cli,
                    busy: !!(cli && cli.busy),
                    sessionId: cli && cli.sessionId || null,
                    cwd: cwd
                });
            });
        });
    }

    function checkUserPathSafe(userPath) {
        try { return checkUserPath(userPath); } catch (e) { return null; }
    }

    /***** The CLI process *****/

    // plan: { cwd } decided by the service for a resumed session
    function spawnCli(bin, opts, callback, plan) {
        plan = plan || {};
        var runCwd = plan.cwd || cwd;
        var args = [
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--permission-prompt-tool", "stdio"
        ];
        // only a mode the user picked in the panel; otherwise the CLI's own
        // default (which may be set in ~/.claude/settings.json)
        var mode = has(MODES, opts.mode) ? opts.mode : null;
        if (mode)
            args.push("--permission-mode", mode);
        var model = validModel(opts.model) ? opts.model : null;
        if (model)
            args.push("--model", model);
        if (has(EFFORTS, opts.effort))
            args.push("--effort", opts.effort);
        // ultracode is a settings key; --settings adds it for this session
        if (opts.ultracode === true)
            args.push("--settings", JSON.stringify({ ultracode: true }));
        var resume = typeof opts.resume == "string" && UUID_RE.test(opts.resume) ? opts.resume : null;
        if (resume)
            args.push("--resume", resume);
        // open elsewhere (e.g. a terminal) and the user asked for a copy
        var fork = !!(resume && opts.fork === true);
        if (fork)
            args.push("--fork-session");

        var child;
        try {
            child = childProcess.spawn(bin, args, {
                cwd: runCwd,
                env: cleanEnv(bin),
                stdio: ["pipe", "pipe", "pipe"],
                // own process group, so that a kill also reaches the commands
                // the CLI runs (Bash tool)
                detached: process.platform != "win32"
            });
        } catch (e) {
            return callback(e);
        }
        if (!child.pid) {
            // ENOENT, EACCES, ...: reported asynchronously
            child.on("error", function(err) {
                callback(new Error("Could not start " + bin + ": " + err.message));
            });
            return;
        }

        var state = {
            child: child,
            pid: child.pid,
            bin: bin,
            cwd: runCwd,
            fork: fork,
            mode: mode,
            model: model || "default",
            effort: has(EFFORTS, opts.effort) ? opts.effort : null,
            controls: Object.create(null),  // our control requests waiting for an answer
            resume: resume,
            sessionId: resume,
            busy: false,
            initSeen: false,
            pending: Object.create(null),   // request_id -> permission request
            sent: [],           // user messages written before init (replayed after a failed resume)
            partial: [],        // pieces of the stdout line being read
            partialLength: 0,
            skipping: false,    // inside an oversized line: drop it up to its newline
            stdoutEnded: false,
            stderr: "",
            exited: false,
            stopped: false,     // stopped by us: its output no longer goes to the panel
            reason: null,
            idleTimer: null
        };
        cli = state;
        recordProcess(state);

        child.on("error", function(err) {
            if (state.exited) return;
            state.exited = true;
            if (cli === state) cli = null;
            clearTimeout(state.idleTimer);
            send({ ev: "error", code: err.code || null, message: "Could not start claude: " + err.message });
        });

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", function(chunk) {
            touch(state);
            readChunk(state, chunk);
        });
        child.stdout.on("end", function() {
            // a last line without a newline
            if (state.partial.length && !state.skipping)
                lineDone(state, "");
            state.stdoutEnded = true;
            if (state.onStdoutEnd) state.onStdoutEnd();
        });

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", function(chunk) {
            state.stderr = (state.stderr + chunk).slice(-STDERR_TAIL);
        });

        child.stdin.on("error", function(err) {
            // EPIPE after the CLI died: the exit handler reports it
        });

        child.on("exit", function(code, signal) {
            if (state.exited) return;
            state.exited = true;
            clearTimeout(state.idleTimer);
            clearTimeout(state.killTimer);
            if (cli === state) cli = null;
            forgetProcess(state);
            delete ownPids[String(state.pid)];
            failControls(state);
            // 'exit' can come before the last stdout data: let it drain
            // (bounded, a tool child may hold the pipe open)
            if (state.stdoutEnded) return exited(code, signal);
            var done = false;
            var finish = function() {
                if (done) return;
                done = true;
                clearTimeout(timer);
                exited(code, signal);
            };
            var timer = setTimeout(finish, 1000);
            state.onStdoutEnd = finish;
        });

        function exited(code, signal) {
            markStopped(state);
            var stderr = state.stderr.trim();
            // --resume with an id the CLI does not know (deleted, other
            // machine): start a new conversation and replay the message. The
            // CLI says so on stderr ("No conversation found ..."); without
            // relying on that text: a --resume process that ends before its
            // init with an error result (and not for want of a login).
            var held = state.heldResult;
            var heldText = held && (held.result || (held.errors || []).join(" ")) || "";
            var resumeFailed = /no conversation found/i.test(stderr)
                || held && held.is_error && !LOGIN_HINT_RE.test(heldText + " " + stderr);
            if (state.resume && !state.initSeen && state.sent.length && !state.reason && resumeFailed) {
                send({ ev: "notice", kind: "resume-failed", sessionId: state.resume,
                    text: "Could not resume the previous session; started a new one." });
                var sent = state.sent;
                return spawnCli(bin, { mode: state.mode, model: state.model }, function(err, fresh) {
                    if (err)
                        return send({ ev: "error", message: err.message });
                    sent.forEach(function(line) { writeLine(fresh, line, true); });
                    fresh.busy = true;
                    reportSettings(fresh);
                }, { cwd: state.cwd });
            }

            if (state.heldResult && !state.stopped)
                send({ ev: "msg", pid: state.pid, data: state.heldResult });
            send({
                ev: "exit",
                pid: state.pid,
                code: code,
                signal: signal,
                reason: state.reason || (code === 0 ? "ended" : "crashed"),
                sessionId: state.sessionId,
                idleMinutes: IDLE_TIMEOUT / 60000,
                stderr: stderr.slice(-2000)
            });
        }

        ownPids[String(child.pid)] = true;
        touch(state);
        send({ ev: "spawn", pid: child.pid, mode: mode, model: state.model, resume: resume,
            fork: state.fork, cwd: path.relative(cwd, runCwd) });
        callback(null, state);
    }

    function touch(state) {
        clearTimeout(state.idleTimer);
        state.idleTimer = setTimeout(function() {
            if (cli !== state) return;
            // a quiet turn (a long build, an open permission prompt) is not idle
            if (state.busy) return touch(state);
            stopCli("idle");
        }, IDLE_TIMEOUT);
    }

    /***** Reading stdout: one JSON message per line *****/

    // Only the new chunk is searched for newlines, and a long line is
    // collected in pieces that are joined once: linear in the line length.
    function readChunk(state, chunk) {
        var start = 0;
        var i;
        while ((i = chunk.indexOf("\n", start)) != -1) {
            var piece = chunk.slice(start, i);
            start = i + 1;
            if (state.skipping) {
                // the end of an oversized line
                state.skipping = false;
                continue;
            }
            lineDone(state, piece);
        }
        if (start < chunk.length && !state.skipping) {
            var rest = start ? chunk.slice(start) : chunk;
            state.partialLength += rest.length;
            if (state.partialLength > MAX_LINE) {
                state.partial = [];
                state.partialLength = 0;
                state.skipping = true;
                if (!state.stopped)
                    send({ ev: "notice", pid: state.pid, kind: "too-large",
                        text: "A message from claude was larger than " + MAX_LINE / 1048576
                            + " MB and is not shown here (Claude received it)." });
            }
            else {
                state.partial.push(rest);
            }
        }
    }

    function lineDone(state, lastPiece) {
        var line = lastPiece;
        if (state.partial.length) {
            state.partial.push(lastPiece);
            line = state.partial.join("");
            state.partial = [];
            state.partialLength = 0;
        }
        if (line.trim())
            onLine(state, line);
    }

    function writeLine(state, line, replay) {
        if (!state || state.exited || !state.child.stdin.writable)
            return false;
        state.child.stdin.write(line + "\n");
        if (!state.initSeen && !replay && /^\{"type":"user"/.test(line))
            state.sent.push(line);
        touch(state);
        return true;
    }

    function writeJson(state, obj) {
        return writeLine(state, JSON.stringify(obj));
    }

    function killGroup(state, signal) {
        try {
            if (process.platform != "win32")
                process.kill(-state.pid, signal);
            else
                state.child.kill(signal);
        } catch (e) {
            try { state.child.kill(signal); } catch (e2) {}
        }
    }

    function stopCli(reason) {
        var state = cli;
        if (!state) return false;
        cli = null;
        state.reason = reason || "stopped";
        state.stopped = true;
        clearTimeout(state.idleTimer);
        // deny what is still waiting, so the CLI does not run anything more
        Object.keys(state.pending).forEach(function(id) {
            answer(state, id, { behavior: "deny", message: "The session was stopped." });
        });
        try { state.child.stdin.end(); } catch (e) {}
        killGroup(state, "SIGTERM");
        state.killTimer = setTimeout(function() {
            if (!state.exited) killGroup(state, "SIGKILL");
        }, KILL_GRACE);
        return true;
    }

    /***** CLI output *****/

    function onLine(state, line) {
        var msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            // not JSON: the CLI printed a plain error (e.g. bad option)
            state.stderr = (state.stderr + line + "\n").slice(-STDERR_TAIL);
            return;
        }
        if (!msg || typeof msg != "object") return;
        // a CLI stopped by New session / Resume may still print the end of
        // its turn: it belongs to the old chat
        if (state.stopped) return;

        if (msg.session_id && typeof msg.session_id == "string")
            state.sessionId = msg.session_id;

        var send = function(event) {
            event.pid = state.pid;
            sendEvent(event);
        };

        switch (msg.type) {
            case "system":
                if (msg.subtype == "init") {
                    state.initSeen = true;
                    state.sent = [];
                    if (msg.permissionMode) state.mode = msg.permissionMode;
                    return send({ ev: "msg", data: {
                        type: "system", subtype: "init",
                        session_id: msg.session_id, model: msg.model, cwd: msg.cwd,
                        permissionMode: msg.permissionMode,
                        claude_code_version: msg.claude_code_version,
                        apiKeySource: msg.apiKeySource
                    } });
                }
                if (msg.subtype == "status" && msg.permissionMode)
                    state.mode = msg.permissionMode;
                // live activity: the estimated size of a (redacted) thinking block
                if (msg.subtype == "thinking_tokens")
                    return send({ ev: "msg", data: { type: "system", subtype: "thinking_tokens",
                        estimated_tokens: msg.estimated_tokens, estimated_tokens_delta: msg.estimated_tokens_delta } });
                if (msg.subtype == "post_turn_summary")
                    return send({ ev: "msg", data: { type: "system", subtype: "post_turn_summary",
                        status_category: msg.status_category, status_detail: msg.status_detail } });
                return send({ ev: "msg", data: msg });

            case "stream_event":
                var event = msg.event || {};
                // sub-agent (Task) deltas: the panel shows the sub-agent's
                // tool calls from its complete messages
                if (msg.parent_tool_use_id) return;
                if (event.type == "content_block_delta" && event.delta
                  && event.delta.type != "text_delta" && event.delta.type != "thinking_delta")
                    return;
                if (event.type == "message_start" && event.message)
                    event = { type: "message_start", message: { id: event.message.id, model: event.message.model } };
                if (event.type == "content_block_start" && event.content_block) {
                    var block = event.content_block;
                    event = { type: event.type, index: event.index, content_block: {
                        type: block.type, id: block.id, name: block.name
                    } };
                }
                if (event.type == "message_delta")
                    return;
                return send({ ev: "msg", data: { type: "stream_event", event: event } });

            case "assistant":
                if (msg.message && Array.isArray(msg.message.content)) {
                    msg.message.content.forEach(function(block) {
                        if (block.type == "thinking") delete block.signature;
                        if (block.type == "tool_use") block.input = trimInput(block.input);
                    });
                }
                delete msg.wire_tool_inputs;
                // the context the main agent uses now (the panel's context meter)
                var usage = msg.message && msg.message.usage;
                if (usage && typeof usage == "object" && !msg.parent_tool_use_id) {
                    msg.context_tokens = (+usage.input_tokens || 0) + (+usage.cache_creation_input_tokens || 0)
                        + (+usage.cache_read_input_tokens || 0) + (+usage.output_tokens || 0);
                    if (typeof msg.message.model == "string") state.lastModel = msg.message.model;
                }
                if (msg.message) {
                    delete msg.message.usage;
                    delete msg.message.container;
                }
                return send({ ev: "msg", data: msg });

            case "user":
                if (msg.isReplay) return;
                delete msg.tool_use_result;
                delete msg.tool_result_meta;
                if (msg.message && Array.isArray(msg.message.content)) {
                    msg.message.content = msg.message.content.map(trimToolResult);
                }
                return send({ ev: "msg", data: msg });

            case "control_request":
                var req = msg.request || {};
                if (req.subtype == "can_use_tool" && typeof msg.request_id == "string" && msg.request_id) {
                    var message = {
                        type: "control_request",
                        request_id: msg.request_id,
                        request: {
                            subtype: "can_use_tool",
                            tool_name: req.tool_name,
                            display_name: req.display_name,
                            description: req.description,
                            input: trimInput(req.input),
                            permission_suggestions: req.permission_suggestions,
                            tool_use_id: req.tool_use_id,
                            blocked_path: req.blocked_path,
                            decision_reason: req.decision_reason
                        }
                    };
                    state.pending[msg.request_id] = {
                        input: req.input,
                        toolName: req.tool_name,
                        suggestions: Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [],
                        message: message
                    };
                    return send({ ev: "msg", data: message });
                }
                // a request we do not support: refuse it so the CLI does not hang
                if (typeof msg.request_id == "string") {
                    writeJson(state, { type: "control_response", response: {
                        subtype: "error", request_id: msg.request_id,
                        error: "Not supported by the Cloud9 Claude panel"
                    } });
                }
                return;

            case "control_response":
                var response = msg.response || {};
                // ours, with a callback (get_settings, list_models, ...)
                if (has(state.controls, response.request_id)) {
                    var waiting = state.controls[response.request_id];
                    delete state.controls[response.request_id];
                    clearTimeout(waiting.timer);
                    return waiting.callback(response.subtype == "success" ? null
                        : new Error(response.error || "claude refused the request"), response.response || {});
                }
                return send({ ev: "control", id: response.request_id, ok: response.subtype == "success",
                    error: response.error || null, response: response.response || null });

            case "result":
                state.busy = false;
                state.pending = Object.create(null);
                var result = {
                    type: "result",
                    subtype: msg.subtype,
                    is_error: msg.is_error,
                    result: typeof msg.result == "string" ? msg.result.slice(0, MAX_RESULT_TEXT) : msg.result,
                    errors: msg.errors,
                    session_id: msg.session_id,
                    total_cost_usd: msg.total_cost_usd,
                    turn_cost_usd: turnCost(msg),
                    duration_ms: msg.duration_ms,
                    duration_api_ms: msg.duration_api_ms,
                    num_turns: msg.num_turns,
                    stop_reason: msg.stop_reason,
                    terminal_reason: msg.terminal_reason,
                    permission_denials: msg.permission_denials,
                    api_error_status: msg.api_error_status,
                    context_window: contextWindow(state, msg.modelUsage)
                };
                // a failed --resume ends with a result before any init; the
                // exit handler decides whether it is shown or replaced
                if (!state.initSeen && state.resume) {
                    state.heldResult = result;
                    return;
                }
                return send({ ev: "msg", data: result });

            case "rate_limit_event":
                if (msg.rate_limit_info && msg.rate_limit_info.status == "allowed")
                    return;
                return send({ ev: "msg", data: msg });

            case "active_goal":
            case "autocompact_state":
                return;

            default:
                // unknown or new message types: the client ignores what it
                // does not know
                return send({ ev: "msg", data: msg });
        }
    }

    // the context window of the main agent's model: { size, max_output }
    function contextWindow(state, modelUsage) {
        if (!modelUsage || typeof modelUsage != "object") return null;
        var keys = Object.keys(modelUsage);
        var key = state.lastModel && has(modelUsage, state.lastModel) ? state.lastModel : keys.length == 1 ? keys[0] : null;
        var usage = key && modelUsage[key];
        if (!usage || typeof usage.contextWindow != "number" || usage.contextWindow <= 0) return null;
        return { size: usage.contextWindow, max_output: +usage.maxOutputTokens || 0 };
    }

    function turnCost(msg) {
        var usage = msg.model_usage_since_last_result;
        if (!usage || typeof usage != "object") return null;
        var total = 0;
        Object.keys(usage).forEach(function(model) {
            total += +(usage[model] && usage[model].costUSD) || 0;
        });
        return total;
    }

    function trimString(value, max) {
        if (typeof value == "string" && value.length > max)
            return value.slice(0, max) + "\n… (" + (value.length - max) + " more characters)";
        return value;
    }

    function trimInput(input) {
        if (!input || typeof input != "object") return input;
        var out = Array.isArray(input) ? [] : {};
        Object.keys(input).forEach(function(key) {
            var value = input[key];
            out[key] = typeof value == "string" ? trimString(value, MAX_INPUT_STRING) : value;
        });
        return out;
    }

    function trimToolResult(block) {
        if (!block || block.type != "tool_result") return block;
        var content = block.content;
        if (typeof content == "string") {
            block.content = trimString(content, MAX_RESULT_TEXT);
        }
        else if (Array.isArray(content)) {
            var budget = MAX_RESULT_TEXT;
            block.content = content.map(function(part) {
                if (part && part.type == "text") {
                    var text = trimString(part.text, Math.max(budget, 200));
                    budget -= typeof text == "string" ? text.length : 0;
                    return { type: "text", text: text };
                }
                if (part && part.type == "image")
                    return { type: "text", text: "[image]" };
                return part;
            });
        }
        return block;
    }

    /***** Client requests *****/

    function validateContent(content) {
        if (!Array.isArray(content) || !content.length)
            throw new Error("Empty message");
        var images = 0;
        var out = [];
        content.forEach(function(block) {
            if (!block || typeof block != "object")
                throw new Error("Invalid message");
            if (block.type == "text") {
                if (typeof block.text != "string" || block.text.length > MAX_TEXT)
                    throw new Error("Invalid or too long text");
                if (block.text)
                    out.push({ type: "text", text: block.text });
            }
            else if (block.type == "image") {
                var source = block.source || {};
                if (++images > MAX_IMAGES)
                    throw new Error("Too many images (at most " + MAX_IMAGES + ")");
                if (source.type != "base64" || !has(IMAGE_TYPES, source.media_type)
                  || typeof source.data != "string" || !source.data
                  || source.data.length > MAX_IMAGE_B64 || !BASE64_RE.test(source.data))
                    throw new Error("Invalid or too large image");
                out.push({ type: "image", source: {
                    type: "base64", media_type: source.media_type, data: source.data
                } });
            }
            else {
                throw new Error("Unsupported content: " + String(block.type).slice(0, 20));
            }
        });
        if (!out.length)
            throw new Error("Empty message");
        return out;
    }

    function sendMessage(message, callback) {
        callback = callback || function() {};
        message = message || {};
        var content;
        try {
            content = validateContent(message.content);
        } catch (e) {
            return callback(e);
        }
        var opts = message.options || {};
        var line = JSON.stringify({
            type: "user",
            message: { role: "user", content: content },
            parent_tool_use_id: null
        });

        function write(state, spawned) {
            if (!writeLine(state, line))
                return callback(new Error("claude is not running"));
            state.busy = true;
            callback(null, { spawned: spawned, pid: state.pid, sessionId: state.sessionId });
            if (spawned) reportSettings(state);
        }

        if (cli && !cli.exited)
            return write(cli, false);

        findClaude(opts.path, function(err, bin, tried) {
            if (err) return callback(err);
            if (!bin) {
                var e = new Error("claude was not found");
                e.code = "ENOTFOUND";
                e.tried = tried;
                return callback(e);
            }
            var resume = typeof opts.resume == "string" && UUID_RE.test(opts.resume) ? opts.resume.toLowerCase() : null;
            var go = function(plan) {
                spawnCli(bin, opts, function(err, state) {
                    if (err) return callback(err);
                    write(state, true);
                }, plan);
            };
            if (!resume) return go(null);
            // decided when the session was picked, or now (e.g. after an idle stop)
            var plan = resumePlans[resume];
            delete resumePlans[resume];
            if (plan) return go(plan);
            resumePlan(resume, function(err, fresh) { go(fresh); });
        });
    }

    function answer(state, requestId, response) {
        delete state.pending[requestId];
        return writeJson(state, {
            type: "control_response",
            response: { subtype: "success", request_id: requestId, response: response }
        });
    }

    function respond(requestId, decision, callback) {
        callback = callback || function() {};
        decision = decision || {};
        var state = cli;
        var request = state && has(state.pending, requestId) ? state.pending[requestId] : null;
        if (!request)
            return callback(new Error("This request is no longer pending"));

        var response;
        if (decision.behavior == "allow" || decision.behavior == "allowAlways") {
            var input = request.input;
            if (decision.answers && typeof decision.answers == "object" && request.toolName == "AskUserQuestion") {
                var answers = Object.create(null);
                Object.keys(decision.answers).slice(0, 20).forEach(function(question) {
                    var value = decision.answers[question];
                    if (typeof value == "string" && question.length < 2000 && value.length < 2000)
                        answers[question] = value;
                });
                input = Object.assign({}, input, { answers: answers });
            }
            response = { behavior: "allow", updatedInput: input };
            // only the suggestions the CLI offered for this very request
            if (decision.behavior == "allowAlways" && Array.isArray(request.suggestions) && request.suggestions.length)
                response.updatedPermissions = request.suggestions;
        }
        else {
            // no reason: the turn stops (interrupt), the user says what next;
            // with a reason (feedback), Claude goes on with it
            var feedback = typeof decision.message == "string" && decision.message.trim()
                ? decision.message.trim().slice(0, MAX_TEXT) : "";
            response = {
                behavior: "deny",
                message: feedback || "The user declined this tool call and stopped. Wait for their next message.",
                interrupt: decision.interrupt === true
            };
        }
        answer(state, requestId, response);
        callback(null, { ok: true });
    }

    function controlRequest(state, request, callback) {
        var id = "c9-" + (nextRequestId++);
        if (callback) {
            state.controls[id] = {
                callback: callback,
                timer: setTimeout(function() {
                    if (!has(state.controls, id)) return;
                    delete state.controls[id];
                    callback(new Error("claude did not answer"));
                }, CONTROL_TIMEOUT)
            };
        }
        if (!writeJson(state, { type: "control_request", request_id: id, request: request }) && callback) {
            clearTimeout(state.controls[id].timer);
            delete state.controls[id];
            callback(new Error("claude is not running"));
        }
        return id;
    }

    function failControls(state) {
        Object.keys(state.controls).forEach(function(id) {
            var waiting = state.controls[id];
            delete state.controls[id];
            clearTimeout(waiting.timer);
            waiting.callback(new Error("claude exited"));
        });
    }

    function validModel(model) {
        return typeof model == "string" && model != "default" && MODEL_RE.test(model);
    }

    // what the CLI really applies (model id, effort), from get_settings
    function applied(state, callback) {
        controlRequest(state, { subtype: "get_settings" }, function(err, res) {
            if (err) return callback(err);
            var a = res && res.applied || {};
            callback(null, {
                model: typeof a.model == "string" ? a.model : null,
                effort: typeof a.effort == "string" ? a.effort : null,
                // requested (the settings key) and applied (the model supports it)
                ultracode: a.ultracode === true,
                ultracodeRequested: a.ultracodeRequested === true,
                ultracodeAvailable: a.ultracodeAvailable === true
            });
        });
    }

    // the CLI's model list, trimmed to what the panel shows
    function models(state, callback) {
        controlRequest(state, { subtype: "list_models" }, function(err, res) {
            if (err) return callback(err);
            var list = (res && Array.isArray(res.models) ? res.models : []).slice(0, 60).filter(function(m) {
                return m && typeof m.value == "string" && (m.value == "default" || MODEL_RE.test(m.value));
            }).map(function(m) {
                return {
                    value: m.value,
                    resolvedModel: typeof m.resolvedModel == "string" ? m.resolvedModel : null,
                    displayName: String(m.displayName || m.value).slice(0, 80),
                    description: String(m.description || "").slice(0, 160),
                    supportsEffort: !!m.supportsEffort,
                    supportedEffortLevels: (Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : [])
                        .filter(function(l) { return has(EFFORTS, l); })
                };
            });
            callback(null, list);
        });
    }

    // after a spawn: the model list and the applied settings, for the header
    function reportSettings(state) {
        models(state, function(err, list) {
            applied(state, function(err2, a) {
                if (state.stopped || err && err2) return;
                send({ ev: "cli-settings", pid: state.pid, models: err ? null : list, applied: err2 ? null : a });
            });
        });
    }

    // answer of a change: what is applied now
    function changed(state, callback) {
        return function(err) {
            if (err) return callback(err);
            applied(state, function(err, a) {
                callback(null, { running: true, applied: err ? null : a });
            });
        };
    }

    function interrupt(callback) {
        callback = callback || function() {};
        var state = cli;
        if (!state)
            return callback(null, { running: false });
        Object.keys(state.pending).forEach(function(id) {
            answer(state, id, { behavior: "deny", message: "The user stopped this." });
        });
        var id = controlRequest(state, { subtype: "interrupt" });
        callback(null, { running: true, id: id });
    }

    function setMode(mode, callback) {
        callback = callback || function() {};
        if (!has(MODES, mode))
            return callback(new Error("Unknown permission mode"));
        if (!cli)
            return callback(null, { running: false });
        cli.mode = mode;
        controlRequest(cli, { subtype: "set_permission_mode", mode: mode }, changed(cli, callback));
    }

    // effort: one of the levels the model supports, or "" for the user's own default
    function setEffort(level, callback) {
        callback = callback || function() {};
        if (level !== "" && level != null && !has(EFFORTS, level))
            return callback(new Error("Unknown effort level"));
        if (!cli)
            return callback(null, { running: false });
        cli.effort = level || null;
        controlRequest(cli, { subtype: "apply_flag_settings", settings: { effortLevel: level || null } },
            changed(cli, callback));
    }

    // opts.models: false to skip the model list (after each turn)
    // ultracode (multi-agent workflows): on or off for this session
    function setUltracode(on, callback) {
        callback = callback || function() {};
        if (typeof on != "boolean")
            return callback(new Error("ultracode must be true or false"));
        if (!cli)
            return callback(null, { running: false });
        controlRequest(cli, { subtype: "apply_flag_settings", settings: { ultracode: on } }, changed(cli, callback));
    }

    function getSettings(opts, callback) {
        if (typeof opts == "function") { callback = opts; opts = {}; }
        callback = callback || function() {};
        opts = opts || {};
        var state = cli;
        if (!state)
            return callback(null, { running: false });
        if (opts.models === false) {
            return applied(state, function(err, a) {
                callback(null, { running: true, applied: err ? null : a });
            });
        }
        models(state, function(err, list) {
            applied(state, function(err2, a) {
                callback(null, { running: true, models: err ? null : list, applied: err2 ? null : a });
            });
        });
    }

    function setModel(model, callback) {
        callback = callback || function() {};
        if (model != "default" && !validModel(model))
            return callback(new Error("Unknown model"));
        if (!cli)
            return callback(null, { running: false });
        cli.model = model;
        // without a model the CLI goes back to its default model
        controlRequest(cli, model == "default"
            ? { subtype: "set_model" }
            : { subtype: "set_model", model: model }, changed(cli, callback));
    }

    /***** Sessions: the CLI's transcripts *****/

    // Only files under <config>/projects are read, found by the service
    // itself: the client passes a session id (UUID), never a path.
    function configDir() {
        return process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
    }

    function projectsDir() {
        return path.join(configDir(), "projects");
    }

    // The CLI keeps a record of each running process in
    // <config>/sessions/<pid>.json: { pid, sessionId, cwd, status, kind,
    // entrypoint, procStart }. Returns sessionId -> { pid, status } for the
    // processes that still run and are not this panel's, or null when there
    // are no records at all (an older CLI): then only the transcript's
    // mtime can tell.
    function liveSessions() {
        var dir = path.join(configDir(), "sessions");
        var names;
        try { names = fs.readdirSync(dir); } catch (e) { return null; }
        names = names.filter(function(n) { return /^[1-9]\d{0,9}\.json$/.test(n); }).slice(0, RECORD_LIMIT);
        if (!names.length) return null;
        var live = Object.create(null);
        names.forEach(function(name) {
            var pid = parseInt(name, 10);
            var rec;
            try {
                var file = path.join(dir, name);
                var st = fs.lstatSync(file);
                if (!st.isFile() || st.size > RECORD_MAX_SIZE) return;
                rec = JSON.parse(fs.readFileSync(file, "utf8"));
            } catch (e) { return; }
            if (!rec || typeof rec != "object" || +rec.pid !== pid) return;
            if (typeof rec.sessionId != "string" || !UUID_RE.test(rec.sessionId)) return;
            if (has(ownPids, String(pid)) || !processAlive(pid, rec.procStart)) return;
            live[rec.sessionId.toLowerCase()] = {
                pid: pid,
                status: typeof rec.status == "string" ? rec.status.slice(0, 20) : ""
            };
        });
        return live;
    }

    // alive, and the same process as the record's (not a reused pid)
    function processAlive(pid, procStart) {
        try {
            process.kill(pid, 0);
        } catch (e) {
            if (e.code != "EPERM") return false;
        }
        if (procStart == null || process.platform != "linux") return true;
        var stat;
        try { stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8"); } catch (e) { return true; }
        // the fields after "(comm)": state is field 3, starttime field 22
        var fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return fields[19] === String(procStart);
    }

    function realDir(dir) {
        try { return fs.realpathSync(dir); } catch (e) { return null; }
    }

    // is dir the workspace or inside it?
    function inWorkspace(dir) {
        if (typeof dir != "string" || !path.isAbsolute(dir)) return false;
        var inside = function(p, root) {
            return p == root || p.indexOf(root.replace(/\/$/, "") + path.sep) === 0;
        };
        var ws = path.normalize(cwd), wsReal = realDir(cwd) || ws;
        var p = path.normalize(dir), pReal = realDir(dir);
        return inside(p, ws) || inside(p, wsReal) || !!pReal && (inside(pReal, ws) || inside(pReal, wsReal));
    }

    function folderOf(dir) {
        var ws = path.normalize(cwd), wsReal = realDir(cwd) || ws;
        var p = path.normalize(dir), pReal = realDir(dir) || p;
        var rel = p == ws || p.indexOf(ws + path.sep) === 0 ? path.relative(ws, p) : path.relative(wsReal, pReal);
        return rel && rel.indexOf("..") !== 0 ? rel : "";
    }

    // project folders, regular files only (no symlinks)
    function listDirs(projects) {
        var dirs;
        try { dirs = fs.readdirSync(projects); } catch (e) { return []; }
        return dirs.filter(function(name) {
            try { return fs.lstatSync(path.join(projects, name)).isDirectory(); }
            catch (e) { return false; }
        });
    }

    function findTranscript(sessionId, callback) {
        var projects = projectsDir();
        var name = sessionId.toLowerCase() + ".jsonl";
        // the CLI names a project folder after its directory; if that naming
        // changes, look in every project folder
        // the newest copy, as in the session list
        var found = null;
        listDirs(projects).forEach(function(dir) {
            var file = path.join(projects, dir, name);
            try {
                var st = fs.lstatSync(file);
                if (st.isFile() && (!found || st.mtimeMs > found.st.mtimeMs))
                    found = { file: file, st: st };
            } catch (e) {}
        });
        if (!found) return callback(null, null, null);
        callback(null, found.file, found.st);
    }

    // the first and last bytes of a transcript, as whole lines
    function peek(file, size) {
        var fd;
        try {
            fd = fs.openSync(file, "r");
            var read = function(pos, len) {
                var buf = Buffer.alloc(len);
                var n = fs.readSync(fd, buf, 0, len, pos);
                return buf.toString("utf8", 0, n);
            };
            var headText = read(0, Math.min(size, SESSION_PEEK));
            var head = headText.split("\n");
            if (size > SESSION_PEEK) head.pop(); // partial last line
            var tail = [];
            if (size > SESSION_PEEK) {
                var len = Math.min(SESSION_PEEK, size - SESSION_PEEK);
                tail = read(size - len, len).split("\n");
                tail.shift(); // partial first line
            }
            return { head: parseLines(head), tail: parseLines(tail) };
        } catch (e) {
            return { head: [], tail: [] };
        } finally {
            if (fd != null) try { fs.closeSync(fd); } catch (e) {}
        }
    }

    function parseLines(lines) {
        var out = [];
        lines.forEach(function(line) {
            if (!line || line.charAt(0) != "{") return;
            try { out.push(JSON.parse(line)); } catch (e) {}
        });
        return out;
    }

    function recordedCwd(entries) {
        for (var i = 0; i < entries.length; i++) {
            if (entries[i] && typeof entries[i].cwd == "string" && path.isAbsolute(entries[i].cwd))
                return entries[i].cwd;
        }
        return null;
    }

    // a custom title (/rename) or a summary, else the first real prompt
    function sessionTitle(parts) {
        var all = parts.head.concat(parts.tail);
        var custom = null, summary = null;
        all.forEach(function(e) {
            if (!e) return;
            if (typeof e.customTitle == "string" && e.customTitle.trim()) custom = e.customTitle;
            else if (e.type == "summary" && typeof e.summary == "string" && e.summary.trim()) summary = e.summary;
        });
        if (custom || summary) return oneLine(custom || summary);
        for (var i = 0; i < parts.head.length; i++) {
            var text = promptText(parts.head[i]);
            if (text) return oneLine(text);
        }
        return null;
    }

    function promptText(e) {
        if (!e || e.type != "user" || e.isMeta || e.isSidechain || e.isCompactSummary || !e.message)
            return null;
        var content = e.message.content;
        var texts = [];
        if (typeof content == "string") texts.push(content);
        else if (Array.isArray(content)) {
            for (var i = 0; i < content.length; i++) {
                if (!content[i]) continue;
                if (content[i].type == "tool_result") return null;
                if (content[i].type == "text" && typeof content[i].text == "string") texts.push(content[i].text);
            }
        }
        var text = texts.join(" ").trim();
        // slash commands, their output, reminders, interruptions
        if (!text || /^</.test(text) || /^\[Request interrupted/.test(text) || /^Caveat: /.test(text))
            return null;
        return text;
    }

    function oneLine(text) {
        text = String(text).replace(/\s+/g, " ").trim();
        return text.length > 120 ? text.slice(0, 119) + "\u2026" : text;
    }

    function markerFile(sessionId) {
        return path.join(RECORD_DIR, "stopped-" + sessionId.toLowerCase());
    }

    // this service stopped a CLI of that session (its last writes are ours)
    function markStopped(state) {
        var id = state.sessionId;
        if (!id || !UUID_RE.test(id) || state.marked) return;
        state.marked = true;
        try {
            fs.mkdirSync(RECORD_DIR, { recursive: true, mode: 448 });
            fs.writeFileSync(markerFile(id), String(Date.now()));
        } catch (e) {}
    }

    // Open in another process (a terminal, another editor)? From the live
    // records; without any, a transcript written in the last minutes.
    // Returns null or { how: "process" | "recent", status }.
    function openElsewhere(sessionId, mtimeMs, live) {
        if (cli && cli.sessionId == sessionId && !cli.exited) return null;
        if (live) return live[sessionId] ? { how: "process", status: live[sessionId].status } : null;
        return inUseElsewhere(sessionId, mtimeMs) ? { how: "recent" } : null;
    }

    // written in the last minutes, and not by a CLI of this panel that has
    // stopped since: probably still open (e.g. in a terminal)
    function inUseElsewhere(sessionId, mtimeMs) {
        if (Date.now() - mtimeMs > RECENT_MS) return false;
        if (cli && cli.sessionId == sessionId && !cli.exited) return false;
        var stopped = 0;
        try { stopped = +fs.readFileSync(markerFile(sessionId), "utf8") || 0; } catch (e) {}
        // a stopped CLI may still flush its last lines
        return !(stopped && mtimeMs <= stopped + 5000);
    }

    // where a resumed session runs, and whether it continues in a copy
    function resumePlan(sessionId, callback) {
        findTranscript(sessionId, function(err, file, stat) {
            if (!file) return callback(null, { found: false, cwd: null, elsewhere: null, folder: "" });
            var recorded = recordedCwd(peek(file, stat.size).head);
            var dir = recorded && inWorkspace(recorded) ? realDir(recorded) : null;
            var plan = {
                found: true,
                file: file,
                size: stat.size,
                cwd: dir && fs.statSync(dir).isDirectory() ? dir : null,
                elsewhere: openElsewhere(sessionId, stat.mtimeMs, liveSessions()),
                folder: recorded ? folderOf(recorded) : ""
            };
            callback(null, plan);
        });
    }

    // opts.archived: ids the panel hides; they are listed apart
    function sessions(opts, callback) {
        if (typeof opts == "function") { callback = opts; opts = {}; }
        callback = callback || function() {};
        opts = opts || {};
        var archived = Object.create(null);
        (Array.isArray(opts.archived) ? opts.archived : []).slice(0, ARCHIVE_LIMIT).forEach(function(id) {
            if (typeof id == "string" && UUID_RE.test(id)) archived[id.toLowerCase()] = true;
        });
        var projects = projectsDir();
        var dirs = listDirs(projects);
        // folders named after the workspace or a folder in it come first;
        // the cwd recorded in each transcript decides
        var prefixes = [cwd, realDir(cwd) || cwd].map(function(p) { return p.replace(/[^a-zA-Z0-9]/g, "-"); });
        var matching = dirs.filter(function(name) {
            return prefixes.some(function(pre) { return name == pre || name.indexOf(pre + "-") === 0; });
        });
        var files = [];
        var looked = 0;
        (matching.length ? matching : dirs).some(function(dir) {
            var names;
            try { names = fs.readdirSync(path.join(projects, dir)); } catch (e) { return false; }
            names.some(function(name) {
                if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(name)) return false;
                if (++looked > SESSION_STAT_LIMIT) return true;
                var file = path.join(projects, dir, name);
                try {
                    var st = fs.lstatSync(file);
                    if (st.isFile() && st.size > 0)
                        files.push({ id: name.slice(0, 36).toLowerCase(), file: file, size: st.size, mtime: st.mtimeMs });
                } catch (e) {}
                return false;
            });
            return looked > SESSION_STAT_LIMIT;
        });
        files.sort(function(a, b) { return b.mtime - a.mtime; });

        var seen = Object.create(null);
        var list = [], hidden = [];
        var scanned = 0, scannedHidden = 0;
        var live = liveSessions();
        files.forEach(function(f) {
            if (seen[f.id]) return;
            seen[f.id] = true;
            var isArchived = archived[f.id];
            // at most SESSION_SCAN transcripts are read, and as many archived ones
            if (isArchived ? ++scannedHidden > SESSION_SCAN : ++scanned > SESSION_SCAN) return;
            var parts = peek(f.file, f.size);
            var recorded = recordedCwd(parts.head) || recordedCwd(parts.tail);
            if (!recorded || !inWorkspace(recorded)) return;
            var title = sessionTitle(parts);
            if (!title) return; // nothing was ever asked in it
            (isArchived ? hidden : list).push({
                id: f.id,
                title: title,
                folder: folderOf(recorded),
                mtime: Math.round(f.mtime),
                elsewhere: openElsewhere(f.id, f.mtime, live)
            });
        });
        callback(null, { sessions: list, archived: hidden, now: Date.now() });
    }

    // Deletes a conversation: <projects>/<dir>/<id>.jsonl and its <id>/
    // folder (sub-agents, tool results). The client sends only the id;
    // nothing is followed through a symbolic link and nothing outside the
    // projects folder is touched. Refused for the panel's running session
    // and for one open in another process.
    function deleteSession(sessionId, callback) {
        callback = callback || function() {};
        if (typeof sessionId != "string" || !UUID_RE.test(sessionId))
            return callback(new Error("Invalid session id"));
        var id = sessionId.toLowerCase();
        if (cli && !cli.exited && cli.sessionId && cli.sessionId.toLowerCase() == id)
            return callback(refusal("This conversation is open in the panel. Start a new session first.", "ECURRENT"));
        var projects = projectsDir();
        var found = [];
        listDirs(projects).forEach(function(dir) {
            var file = path.join(projects, dir, id + ".jsonl");
            try {
                var st = fs.lstatSync(file);
                if (st.isFile()) found.push({ dir: path.join(projects, dir), file: file, mtime: st.mtimeMs });
            } catch (e) {}
        });
        if (!found.length)
            return callback(refusal("This conversation was not found.", "ENOENT"));
        var live = liveSessions();
        if (live && live[id])
            return callback(refusal("This conversation is open in another process (pid " + live[id].pid + "), e.g. a terminal. Close it there first.", "EBUSY"));
        if (!live && found.some(function(f) { return inUseElsewhere(id, f.mtime); }))
            return callback(refusal("This conversation changed in the last two minutes and may be open elsewhere. Try again later.", "EBUSY"));
        var removed = { files: 0, dirs: 0 };
        try {
            found.forEach(function(f) {
                fs.unlinkSync(f.file);
                removed.files++;
                // the sibling folder, if it is a real folder in that project folder
                var sub = path.join(f.dir, id);
                var st;
                try { st = fs.lstatSync(sub); } catch (e) { return; }
                if (st.isDirectory() && path.dirname(sub) == f.dir) {
                    removeTree(sub, removed);
                }
            });
        } catch (e) {
            return callback(new Error("Could not delete the conversation: " + e.message));
        }
        delete resumePlans[id];
        try { fs.unlinkSync(markerFile(id)); } catch (e) {}
        callback(null, { deleted: true, files: removed.files, dirs: removed.dirs });
    }

    function refusal(message, code) {
        var err = new Error(message);
        err.code = code;
        return err;
    }

    // a folder and what is in it; links are removed, never followed
    function removeTree(dir, removed) {
        fs.readdirSync(dir).forEach(function(name) {
            var p = path.join(dir, name);
            var st = fs.lstatSync(p);
            if (st.isDirectory()) removeTree(p, removed);
            else {
                fs.unlinkSync(p);
                removed.files++;
            }
        });
        fs.rmdirSync(dir);
        removed.dirs++;
    }

    // the earlier messages of a session, and how it will be resumed
    function history(sessionId, callback) {
        callback = callback || function() {};
        if (typeof sessionId != "string" || !UUID_RE.test(sessionId))
            return callback(new Error("Invalid session id"));
        sessionId = sessionId.toLowerCase();
        resumePlan(sessionId, function(err, plan) {
            if (!plan.found) return callback(null, { found: false });
            resumePlans[sessionId] = plan;
            readTranscript(plan.file, plan.size, function(err, res) {
                if (err) return callback(err);
                res.elsewhere = plan.elsewhere;
                res.folder = plan.folder;
                callback(null, res);
            });
        });
    }

    function readTranscript(file, size, callback) {
        var start = Math.max(0, size - HISTORY_TAIL);
        var chunks = [];
        fs.createReadStream(file, { start: start, encoding: "utf8" })
            .on("data", function(chunk) { chunks.push(chunk); })
            .on("error", function(err) { callback(err); })
            .on("end", function() {
                var lines = chunks.join("").split("\n");
                if (start > 0) lines.shift(); // partial first line
                var messages = [];
                lines.forEach(function(line) {
                    if (!line) return;
                    var entry;
                    try { entry = JSON.parse(line); } catch (e) { return; }
                    var message = historyMessage(entry);
                    if (message) messages.push(message);
                });
                var truncated = start > 0;
                if (messages.length > HISTORY_MESSAGES) {
                    messages = messages.slice(-HISTORY_MESSAGES);
                    truncated = true;
                }
                var bytes = 0;
                for (var i = messages.length - 1; i >= 0; i--) {
                    bytes += JSON.stringify(messages[i]).length;
                    if (bytes > HISTORY_BYTES) {
                        messages = messages.slice(i + 1);
                        truncated = true;
                        break;
                    }
                }
                callback(null, { found: true, messages: messages, truncated: truncated });
            });
    }

    function historyMessage(entry) {
        if (!entry || (entry.type != "user" && entry.type != "assistant"))
            return null;
        if (entry.isSidechain || entry.isMeta || entry.isCompactSummary || !entry.message)
            return null;
        var content = entry.message.content;
        if (typeof content == "string") {
            // slash commands and their output, injected reminders
            if (/^\s*</.test(content) || !content.trim()) return null;
            content = [{ type: "text", text: content }];
        }
        if (!Array.isArray(content)) return null;
        content = content.map(function(block) {
            if (!block || typeof block != "object") return null;
            if (block.type == "image")
                return { type: "image", omitted: true };
            if (block.type == "thinking")
                return { type: "thinking", thinking: trimString(block.thinking || "", HISTORY_RESULT_TEXT) };
            if (block.type == "tool_use")
                return { type: "tool_use", id: block.id, name: block.name, input: trimInput(block.input) };
            if (block.type == "tool_result") {
                var result = trimToolResult({ type: "tool_result", tool_use_id: block.tool_use_id,
                    is_error: block.is_error, content: block.content });
                if (typeof result.content == "string")
                    result.content = trimString(result.content, HISTORY_RESULT_TEXT);
                return result;
            }
            if (block.type == "text") {
                if (entry.type == "user" && /^\s*<(command-|local-command|system-reminder)/.test(block.text || ""))
                    return null;
                return { type: "text", text: block.text };
            }
            return null;
        }).filter(Boolean);
        if (!content.length) return null;
        return {
            type: entry.type,
            message: { role: entry.type, id: entry.message.id, content: content },
            parent_tool_use_id: null,
            timestamp: entry.timestamp
        };
    }

    function stop(callback) {
        callback = callback || function() {};
        callback(null, { stopped: stopCli("stopped") });
    }

    /***** CLIs left behind by a vfs process that was killed *****/

    // A vfs process killed with SIGKILL (e.g. by the OOM killer) cannot stop
    // its CLI, which runs in its own process group. Each CLI is recorded in
    // a file; a later load of this service stops a recorded CLI's group only
    // when the record's owner is gone and the process is provably the same
    // one: same boot, same start time, its own group leader, our user, and
    // the exact flags this service starts claude with. Groups whose leader
    // has already exited are left alone: their pid could have been reused.
    var RECORD_DIR = path.join(home, ".c9", "claude-panel");
    var CLI_FLAGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json",
        "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio"].join("\0");

    function procStat(pid) {
        try {
            var stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
            // fields after "(comm)": state ppid pgrp ... starttime (field 22)
            var f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            return { state: f[0], pgid: +f[2], start: f[19], uid: fs.statSync("/proc/" + pid).uid };
        } catch (e) {
            return null;
        }
    }

    function bootId() {
        try { return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
        catch (e) { return null; }
    }

    function recordFile(state) {
        return path.join(RECORD_DIR, process.pid + "-" + state.pid + ".json");
    }

    function recordProcess(state) {
        if (process.platform != "linux") return;
        var boot = bootId();
        var self = procStat(process.pid);
        var child = procStat(state.pid);
        if (!boot || !self || !child) return;
        var file = recordFile(state);
        try {
            fs.mkdirSync(RECORD_DIR, { recursive: true, mode: 448 /* 0700 */ });
            fs.writeFileSync(file + ".tmp", JSON.stringify({
                boot: boot, owner: process.pid, ownerStart: self.start,
                pid: state.pid, start: child.start
            }));
            fs.renameSync(file + ".tmp", file);
            state.recorded = file;
        } catch (e) {}
    }

    function forgetProcess(state) {
        if (!state.recorded) return;
        try { fs.unlinkSync(state.recorded); } catch (e) {}
        state.recorded = null;
    }

    function isOurCli(rec) {
        var p = procStat(rec.pid);
        if (!p || p.start !== rec.start || p.pgid !== rec.pid)
            return false;
        if (typeof process.getuid == "function" && p.uid !== process.getuid())
            return false;
        // exited but not reaped yet (its parent was killed): its pid cannot
        // be reused meanwhile, and its tool processes may still run
        if (p.state == "Z")
            return true;
        var args;
        try { args = fs.readFileSync("/proc/" + rec.pid + "/cmdline", "utf8"); }
        catch (e) { return false; }
        return args.indexOf("\0" + CLI_FLAGS + "\0") != -1;
    }

    function cleanupOrphans() {
        if (process.platform != "linux") return;
        var boot = bootId();
        var files;
        try { files = fs.readdirSync(RECORD_DIR); } catch (e) { return; }
        files.forEach(function(name) {
            if (/^stopped-/.test(name)) {
                // markers of stopped sessions only matter for minutes
                try {
                    var marker = path.join(RECORD_DIR, name);
                    if (Date.now() - fs.statSync(marker).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(marker);
                } catch (e) {}
                return;
            }
            if (!/^\d+-\d+\.json$/.test(name)) return;
            var file = path.join(RECORD_DIR, name);
            var rec;
            try { rec = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { rec = null; }
            if (!rec || typeof rec.pid != "number" || rec.pid < 2 || typeof rec.owner != "number") {
                try { fs.unlinkSync(file); } catch (e) {}
                return;
            }
            if (rec.boot === boot) {
                var owner = procStat(rec.owner);
                if (owner && owner.start === rec.ownerStart)
                    return; // its vfs process is alive: not an orphan
                if (isOurCli(rec)) {
                    console.error("[claude] stopping claude " + rec.pid + " left by vfs process " + rec.owner);
                    try { process.kill(-rec.pid, "SIGTERM"); } catch (e) {}
                    setTimeout(function() {
                        if (isOurCli(rec)) {
                            try { process.kill(-rec.pid, "SIGKILL"); } catch (e) {}
                        }
                    }, KILL_GRACE).unref();
                }
            }
            try { fs.unlinkSync(file); } catch (e) {}
        });
    }
    setImmediate(cleanupOrphans);

    /***** Cleanup when the vfs process goes away *****/

    function killNow() {
        if (cli) {
            var state = cli;
            cli = null;
            state.reason = "shutdown";
            state.stopped = true;
            markStopped(state);
            try { state.child.stdin.end(); } catch (e) {}
            killGroup(state, "SIGTERM");
        }
    }

    // One set of process handlers per vfs process, whatever the number of
    // times this extension is (re)defined in it.
    var KEY = "__c9ClaudeServiceCleanup";
    if (!process[KEY]) {
        var cleanups = process[KEY] = [];
        var runAll = function() {
            cleanups.slice().forEach(function(fn) {
                try { fn(); } catch (e) {}
            });
        };
        process.on("exit", runAll);
        ["SIGTERM", "SIGINT", "SIGHUP"].forEach(function(signal) {
            process.on(signal, function onSignal() {
                runAll();
                // keep the default behaviour (exit) unless someone else handles it
                if (process.listeners(signal).length <= 1)
                    process.exit(128 + (os.constants.signals[signal] || 15));
            });
        });
    }
    process[KEY].push(killNow);

    function destroy() {
        var list = process[KEY];
        if (list && list.indexOf(killNow) != -1)
            list.splice(list.indexOf(killNow), 1);
        killNow();
        clearTimeout(flushTimer);
        clearTimeout(disconnectTimer);
        if (client) client.emit("end");
        client = null;
    }

    register(null, {
        status: status,
        connect: connect,
        send: sendMessage,
        respond: respond,
        interrupt: interrupt,
        setMode: setMode,
        setModel: setModel,
        setEffort: setEffort,
        getSettings: getSettings,
        setUltracode: setUltracode,
        deleteSession: deleteSession,
        stop: stop,
        history: history,
        sessions: sessions,
        destroy: destroy
    });
};

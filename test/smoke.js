#!/usr/bin/env node
// Smoke test: starts Cloud9 as the service does (packed, with a login) in a
// temporary home folder, workspace and tmux server, and checks the main
// parts in a real browser. The Claude and DeepSeek panels talk to a mock
// API, so no account or key is needed; without the claude CLI their chat
// checks are skipped.
//
// Needs scripts/install-sdk.sh to have run, Node.js 18+ and Playwright with
// Chromium (scripts/run-tests.sh installs Playwright in test/node_modules;
// the browser: npx --prefix test playwright install chromium).
//
//   node test/smoke.js [--keep]      --keep: leave the temporary folder
"use strict";

var assert = require("assert");
var childProcess = require("child_process");
var crypto = require("crypto");
var fs = require("fs");
var http = require("http");
var os = require("os");
var path = require("path");

var ROOT = path.resolve(__dirname, "..");
var KEEP = process.argv.indexOf("--keep") != -1;
var USER = "smoke";
var PASSWORD = crypto.randomBytes(12).toString("hex");

var results = [];
var tmp, server, mock, browser;
var consoleErrors = []; // the page's recent console errors, shown when a check fails

async function check(name, fn) {
    try {
        var note = await fn();
        results.push({ name: name, ok: true });
        console.log("ok " + results.length + " - " + name + (note ? " # " + note : ""));
    } catch (e) {
        results.push({ name: name, ok: false });
        console.log("not ok " + results.length + " - " + name);
        console.log("  # " + String(e && e.message || e).split("\n").join("\n  # "));
        consoleErrors.splice(0).forEach(function(text) {
            console.log("  # console: " + text);
        });
    }
}

function wait(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function until(what, fn, timeout) {
    var end = Date.now() + (timeout || 30000);
    var last;
    while (Date.now() < end) {
        try {
            var value = await fn();
            if (value) return value;
        } catch (e) { last = e; }
        await wait(250);
    }
    throw new Error("timed out waiting for " + what + (last ? ": " + last.message : ""));
}

function freePort() {
    return new Promise(function(resolve, reject) {
        var s = http.createServer().listen(0, "127.0.0.1", function() {
            var port = s.address().port;
            s.close(function() { resolve(port); });
        }).on("error", reject);
    });
}

// GET with optional Basic auth and X-Forwarded-For; resolves the status code
function get(port, urlPath, user, password, forwardedFor) {
    return new Promise(function(resolve, reject) {
        var headers = {};
        if (user)
            headers.Authorization = "Basic " + Buffer.from(user + ":" + password).toString("base64");
        if (forwardedFor)
            headers["X-Forwarded-For"] = forwardedFor;
        http.get({ host: "127.0.0.1", port: port, path: urlPath, headers: headers }, function(res) {
            res.resume();
            res.on("end", function() { resolve({ status: res.statusCode, headers: res.headers }); });
        }).on("error", reject);
    });
}

// The Anthropic Messages API (what Claude Code calls), answering "pong",
// and DeepSeek's balance
function startMock() {
    return new Promise(function(resolve) {
        var s = http.createServer(function(req, res) {
            var body = "";
            req.on("data", function(c) { body += c; });
            req.on("end", function() {
                var json = {};
                try { json = JSON.parse(body); } catch (e) {}
                if (req.url == "/user/balance") {
                    res.writeHead(200, { "content-type": "application/json" });
                    return res.end(JSON.stringify({ is_available: true, balance_infos: [
                        { currency: "USD", total_balance: "12.34", granted_balance: "0.00", topped_up_balance: "12.34" }] }));
                }
                if (req.url.indexOf("/v1/messages/count_tokens") === 0) {
                    res.writeHead(200, { "content-type": "application/json" });
                    return res.end(JSON.stringify({ input_tokens: 100 }));
                }
                if (req.url.indexOf("/v1/messages") !== 0) {
                    res.writeHead(404, { "content-type": "application/json" });
                    return res.end("{}");
                }
                var message = { id: "msg_smoke", type: "message", role: "assistant", model: json.model,
                    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } };
                if (!json.stream) {
                    message.content = [{ type: "text", text: "pong" }];
                    message.stop_reason = "end_turn";
                    message.usage.output_tokens = 1;
                    res.writeHead(200, { "content-type": "application/json" });
                    return res.end(JSON.stringify(message));
                }
                res.writeHead(200, { "content-type": "text/event-stream" });
                var event = function(type, data) {
                    data.type = type;
                    res.write("event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n");
                };
                event("message_start", { message: message });
                event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
                event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "pong" } });
                event("content_block_stop", { index: 0 });
                event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
                event("message_stop", {});
                res.end();
            });
        });
        s.listen(0, "127.0.0.1", function() { resolve(s); });
    });
}

async function startServer(port, home, workspace, tmuxDir, mockUrl) {
    var env = {};
    Object.keys(process.env).forEach(function(key) {
        // the machine's own Claude Code or Anthropic settings stay out
        if (!/^(ANTHROPIC_|CLAUDE|DEEPSEEK_)/.test(key))
            env[key] = process.env[key];
    });
    Object.assign(env, {
        HOME: home,
        C9_AUTH: USER + ":" + PASSWORD,
        TMUX_TMPDIR: tmuxDir,
        DEEPSEEK_API_KEY: "sk-smoke-deepseek",
        DEEPSEEK_ANTHROPIC_BASE_URL: mockUrl,
        ANTHROPIC_BASE_URL: mockUrl,
        ANTHROPIC_API_KEY: "sk-smoke-anthropic",
        DISABLE_AUTOUPDATER: "1",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost"
    });
    var log = fs.openSync(path.join(tmp, "server.log"), "a");
    server = childProcess.spawn(process.execPath, [
        path.join(ROOT, "server.js"), "-p", String(port), "-l", "127.0.0.1", "-w", workspace, "--packed"
    ], { cwd: ROOT, env: env, stdio: ["ignore", log, log], detached: true });
    await until("the server", async function() {
        if (server.exitCode !== null)
            throw new Error("the server exited (" + server.exitCode + "), see " + path.join(tmp, "server.log"));
        return (await get(port, "/ide.html", USER, PASSWORD, "192.0.2.1")).status == 200;
    }, 60000);
}

async function main() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c9-smoke-"));
    var home = path.join(tmp, "home");
    var workspace = path.join(tmp, "workspace");
    var tmuxDir = path.join(tmp, "tmux");
    [home, workspace, tmuxDir].forEach(function(dir) { fs.mkdirSync(dir); });
    fs.writeFileSync(path.join(workspace, "hello.js"), "// smoke-needle\nconsole.log('hello');\n");

    if (!fs.existsSync(path.join(ROOT, "build/standalone")))
        throw new Error("No packed client: run scripts/install-sdk.sh first");
    var playwright;
    try {
        playwright = require("playwright");
    } catch (e) {
        throw new Error("Playwright is not installed: run scripts/run-tests.sh, or "
            + "npm install --prefix test, then npx --prefix test playwright install chromium");
    }

    mock = await startMock();
    var mockUrl = "http://127.0.0.1:" + mock.address().port;
    var port = await freePort();
    await startServer(port, home, workspace, tmuxDir, mockUrl);
    console.log("# Cloud9 on port " + port + ", files in " + tmp);

    await check("login: refused without a password", async function() {
        var res = await get(port, "/ide.html");
        assert.equal(res.status, 401);
        assert(/^Basic /.test(res.headers["www-authenticate"]), "WWW-Authenticate: " + res.headers["www-authenticate"]);
    });

    await check("login: an address is blocked after 10 wrong passwords", async function() {
        // behind a proxy on this machine the address comes from X-Forwarded-For
        var guesser = "198.51.100.23";
        for (var i = 1; i <= 10; i++) {
            var res = await get(port, "/ide.html", USER, "wrong-" + i, guesser);
            assert.equal(res.status, i < 10 ? 401 : 429, "wrong password " + i);
        }
        assert.equal((await get(port, "/ide.html", USER, PASSWORD, guesser)).status, 429, "right password from the blocked address");
        assert.equal((await get(port, "/ide.html", USER, PASSWORD, "198.51.100.24")).status, 200, "right password from another address");
    });

    browser = await playwright.chromium.launch();
    var context = await browser.newContext({
        viewport: { width: 1400, height: 850 },
        httpCredentials: { username: USER, password: PASSWORD }
    });
    var page = await context.newPage();
    var pageErrors = [];
    page.on("pageerror", function(e) { pageErrors.push(e.message.split("\n")[0]); });
    page.on("console", function(message) {
        if (message.type() != "error" && message.type() != "warning") return;
        consoleErrors.push(message.text().slice(0, 300));
        consoleErrors.splice(0, consoleErrors.length - 20);
    });

    await check("the IDE loads and connects", async function() {
        await page.goto("http://127.0.0.1:" + port + "/ide.html", { waitUntil: "load", timeout: 120000 });
        await page.waitForFunction(function() {
            return window.app && window.app.vfs && window.app.vfs.connected && window.app.tabManager
                && window.app.find && window.app.claude && window.app.deepseek;
        }, null, { timeout: 120000 });
    });

    await check("files: write and read back", async function() {
        var text = await page.evaluate(function() {
            return new Promise(function(resolve) {
                window.app.fs.writeFile("/written.txt", "written by the smoke test\n", function(err) {
                    if (err) return resolve("ERROR " + err.message);
                    window.app.fs.readFile("/written.txt", "utf8", function(err, data) {
                        resolve(err ? "ERROR " + err.message : data);
                    });
                });
            });
        });
        assert.equal(text, "written by the smoke test\n");
        assert.equal(fs.readFileSync(path.join(workspace, "written.txt"), "utf8"), text);
    });

    await check("Go to File lists the workspace", async function() {
        var list = await page.evaluate(function() {
            return new Promise(function(resolve) {
                window.app.find.getFileList({ path: "/", nocache: true, hidden: false, buffer: true }, function(err, data) {
                    resolve(err ? "ERROR " + (err.message || err) : String(data));
                });
            });
        });
        assert(/^\/?hello\.js$/m.test(list), "hello.js not in: " + list.slice(0, 200));
    });

    await check("Find in Files finds text", async function() {
        var found = await page.evaluate(function() {
            return new Promise(function(resolve) {
                window.app.find.findFiles({ path: "/", query: "smoke-needle", pattern: "*.js", casesensitive: true, buffer: true },
                    function(err, data) { resolve(err ? "ERROR " + (err.message || err) : String(data)); });
            });
        });
        assert(/hello\.js/.test(found) && /smoke-needle/.test(found), found.slice(0, 200));
    });

    await check("terminal: a shell with $PORT and the c9 command", async function() {
        var out = path.join(tmp, "terminal.txt");
        var name = await page.evaluate(function() {
            return new Promise(function(resolve) {
                window.app.tabManager.open({ editorType: "terminal", active: true, focus: true }, function(err, tab) {
                    resolve(err ? "" : tab.name);
                });
            });
        });
        assert(name, "no terminal tab");
        await until("the terminal", function() {
            return page.evaluate(function(name) {
                var tab = window.app.tabManager.findTab(name);
                var session = tab && tab.document.getSession();
                return !!(session && session.send && session.connected !== false && session.pty);
            }, name);
        }, 30000).catch(function() {});
        await wait(1500);
        await page.evaluate(function(args) {
            window.app.tabManager.findTab(args[0]).document.getSession().send(
                "echo \"$PORT $(command -v c9)\" > '" + args[1] + "'\r");
        }, [name, out]);
        var text = await until("the command's output", function() {
            return fs.existsSync(out) && fs.readFileSync(out, "utf8").trim();
        }, 30000);
        assert.equal(text, "8080 " + path.join(ROOT, "bin/c9"));
    });

    await check("c9 open opens a file in a tab", async function() {
        // not spawnSync: Playwright talks to the browser from this process,
        // and the page would stall while it waits
        await new Promise(function(resolve, reject) {
            childProcess.execFile(process.execPath, [path.join(ROOT, "bin/c9"), "open", path.join(workspace, "hello.js")], {
                env: Object.assign({}, process.env, { HOME: home }), timeout: 30000
            }, function(err, stdout, stderr) {
                if (err) return reject(new Error("c9 open: " + err.message + " " + (stdout + stderr).trim()));
                resolve();
            });
        });
        await until("the tab", function() {
            return page.evaluate(function() { return !!window.app.tabManager.findTab("/hello.js"); });
        }, 15000);
    });

    await check("Welcome page: guides, no c9.io links", async function() {
        await page.evaluate(function() { window.app.tabManager.openEditor("welcome", true, function() {}); });
        await page.waitForSelector(".sidepanel [data-doc]", { timeout: 30000 });
        var info = await page.evaluate(function() {
            return {
                guides: document.querySelectorAll(".sidepanel [data-doc]").length,
                c9io: [].slice.call(document.querySelectorAll("a[href]")).filter(function(a) {
                    return /c9\.io/.test(a.getAttribute("href"));
                }).length
            };
        });
        assert.equal(info.guides, 4);
        assert.equal(info.c9io, 0);
    });

    await check("TypeScript language server: a type error gets a marker", async function() {
        fs.writeFileSync(path.join(workspace, "typed.ts"), "const count: number = \"three\";\n");
        await page.evaluate(function() {
            return new Promise(function(resolve) { window.app.tabManager.openFile("/typed.ts", true, resolve); });
        });
        var markers = await until("the marker", function() {
            return page.evaluate(function() {
                var tab = window.app.tabManager.findTab("/typed.ts");
                var annotations = tab && tab.editor.ace && tab.editor.ace.session.getAnnotations();
                return annotations && annotations.length && annotations.map(function(a) { return a.type + ": " + a.text; });
            });
        }, 60000);
        assert(markers.some(function(m) { return /^error: .*not assignable/.test(m); }), JSON.stringify(markers));
    });

    await check("Fix with Claude and Ask Claude put the code in the input box", async function() {
        var text = await page.evaluate(function() {
            var ace = window.app.tabManager.findTab("/typed.ts").editor.ace;
            ace.focus();
            ace.moveCursorTo(0, 3);
            window.app.commands.exec("fixwithclaude");
            ace.focus();
            ace.selection.selectLine();
            window.app.commands.exec("askclaude");
            return document.querySelector("textarea.claude-input").value;
        });
        assert(/^Fix this error in typed\.ts, line 1:\n\nerror: .*not assignable/.test(text), text);
        assert(/In typed\.ts, line 1:\n\n```ts\nconst count: number = "three";\n```/.test(text), text);
    });

    await check("Git: a changed line is marked, blame shows the author", async function() {
        var repo = path.join(workspace, "repo");
        fs.mkdirSync(repo);
        fs.writeFileSync(path.join(repo, "notes.txt"), "one\ntwo\nthree\n");
        var env = Object.assign({}, process.env, {
            HOME: home,
            GIT_AUTHOR_NAME: "Smoke Author",
            GIT_AUTHOR_EMAIL: "smoke@example.com",
            GIT_COMMITTER_NAME: "Smoke Author",
            GIT_COMMITTER_EMAIL: "smoke@example.com"
        });
        [["init", "-q"], ["add", "notes.txt"], ["commit", "-q", "-m", "First version"]].forEach(function(args) {
            childProcess.execFileSync("git", args, { cwd: repo, env: env });
        });

        await page.evaluate(function() {
            return new Promise(function(resolve) { window.app.tabManager.openFile("/repo/notes.txt", true, resolve); });
        });
        await until("the file", function() {
            return page.evaluate(function() {
                var tab = window.app.tabManager.findTab("/repo/notes.txt");
                return tab && tab.editor.ace && tab.editor.ace.getValue() == "one\ntwo\nthree\n";
            });
        });
        await page.evaluate(function() {
            window.app.tabManager.findTab("/repo/notes.txt").editor.ace.session.doc.insertFullLines(1, ["inserted"]);
        });
        var marks = await until("the marker", function() {
            return page.evaluate(function() {
                var session = window.app.tabManager.findTab("/repo/notes.txt").editor.ace.session;
                return session.$decorations.map(function(classes, row) {
                    return classes && classes.trim() ? row + ":" + classes.trim() : "";
                }).filter(Boolean).join(" ");
            });
        });
        assert.equal(marks, "1:c9-git-added");

        await page.evaluate(function() {
            var tab = window.app.tabManager.findTab("/repo/notes.txt");
            tab.editor.ace.focus();
            window.app.commands.exec("blame", tab.editor);
        });
        var cells = await until("the blame column", function() {
            return page.evaluate(function() {
                var cells = [].slice.call(document.querySelectorAll(".ace_blame-cell"));
                return cells.length && cells.map(function(cell) { return cell.textContent; });
            });
        });
        assert(/^Smoke Author \xB7 .* \xB7 First version$/.test(cells[0]), JSON.stringify(cells));
        assert.equal(cells[1], "Not committed yet");
    });

    await check("Plugins: one ticked in Preferences loads at startup", async function() {
        var dir = path.join(home, ".c9/plugins/smoke-startup");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
            name: "smoke-startup",
            plugins: { plugin: {} }
        }));
        fs.writeFileSync(path.join(dir, "plugin.js"), [
            "define(function(require, exports, module) {",
            "    main.consumes = [\"Plugin\"];",
            "    main.provides = [\"smokeStartup\"];",
            "    return main;",
            "    function main(options, imports, register) {",
            "        var plugin = new imports.Plugin(\"Smoke\", main.consumes);",
            "        register(null, { smokeStartup: plugin });",
            "    }",
            "});"
        ].join("\n"));

        await page.evaluate(function() {
            window.app["pluginManager.startup"].setStartup("smoke-startup", true);
            window.app.settings.save(true);
        });
        await until("the setting to be saved", function() {
            var file = path.join(home, ".c9/user.settings");
            return fs.existsSync(file) && /smoke-startup/.test(fs.readFileSync(file, "utf8"));
        });

        await page.reload({ waitUntil: "load", timeout: 120000 });
        await page.waitForFunction(function() {
            return window.app && window.app.vfs && window.app.vfs.connected && window.app.tabManager
                && window.app.claude && window.app.deepseek;
        }, null, { timeout: 120000 });
        await until("the plugin", function() {
            return page.evaluate(function() {
                return !!(window.app.smokeStartup && window.app.smokeStartup.loaded);
            });
        });
    });

    // the panels: a chat through Claude Code to the mock API
    var panels = [["deepseek", "ds"], ["claude", "claude"]];
    for (var i = 0; i < panels.length; i++) {
        await (function(name, prefix) {
            return check(name + " panel: a chat answer", async function() {
                await page.evaluate(function(name) { window.app[name].show(); }, name);
                var input = page.locator("textarea." + prefix + "-input");
                await input.waitFor({ timeout: 30000 });
                var state = await until("the panel to find claude", function() {
                    return page.evaluate(function(prefix) {
                        var root = document.querySelector("." + prefix + "-root");
                        var text = root ? root.innerText : "";
                        if (/claude CLI was not found/.test(text)) return "missing";
                        if (/\(Claude Code\)/.test(text)) return "found";
                    }, prefix);
                }, 30000);
                if (state == "missing")
                    return "skipped: the claude CLI is not installed";
                await input.fill("ping");
                await input.press("Enter");
                await page.waitForFunction(function(prefix) {
                    var root = document.querySelector("." + prefix + "-root");
                    return root && /\bpong\b/.test(root.innerText);
                }, prefix, { timeout: 90000 });
            });
        })(panels[i][0], panels[i][1]);
    }

    await check("no errors in the page", async function() {
        assert.deepEqual(pageErrors, []);
    });

    await page.screenshot({ path: path.join(tmp, "smoke.png") });
}

async function cleanup() {
    if (browser) await browser.close().catch(function() {});
    if (server && server.exitCode === null) {
        try { process.kill(-server.pid, "SIGTERM"); } catch (e) {}
    }
    if (mock) mock.close();
    // the test's own tmux server (TMUX_TMPDIR)
    var sockets = path.join(tmp || "", "tmux", "tmux-" + process.getuid());
    if (tmp && fs.existsSync(sockets)) {
        fs.readdirSync(sockets).forEach(function(name) {
            childProcess.spawnSync("tmux", ["-S", path.join(sockets, name), "kill-server"]);
        });
    }
    var failed = results.filter(function(r) { return !r.ok; }).length;
    if (tmp && (KEEP || failed)) {
        console.log("# kept " + tmp + " (server.log, smoke.png)");
        if (failed && fs.existsSync(path.join(tmp, "server.log"))) {
            var log = fs.readFileSync(path.join(tmp, "server.log"), "utf8").trim().split("\n").slice(-20);
            console.log("# last lines of server.log:\n#   " + log.join("\n#   "));
        }
    } else if (tmp) {
        await wait(500);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

main().catch(function(e) {
    results.push({ ok: false });
    console.log("not ok - " + (e && e.message || e));
}).then(cleanup).then(function() {
    var failed = results.filter(function(r) { return !r.ok; }).length;
    console.log("# " + (results.length - failed) + " passed, " + failed + " failed");
    process.exit(failed ? 1 : 0);
});

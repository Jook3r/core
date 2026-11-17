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

var wsClient = require("./ws-client");

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
// what the mock's fill-in-the-middle API was asked: { auth, body }
var fimRequests = [];

function startMock() {
    return new Promise(function(resolve) {
        var s = http.createServer(function(req, res) {
            var body = "";
            req.on("data", function(c) { body += c; });
            req.on("end", function() {
                var json = {};
                try { json = JSON.parse(body); } catch (e) {}
                if (req.url == "/beta/completions") {
                    fimRequests.push({ auth: req.headers.authorization, body: json });
                    res.writeHead(200, { "content-type": "application/json" });
                    return res.end(JSON.stringify({ object: "text_completion", choices: [{ index: 0,
                        text: /return $/.test(json.prompt) ? "a + b;\n" : "", finish_reason: "stop" }],
                        usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20, completion_tokens: 4 } }));
                }
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
    // for the previews: pages that try to use the IDE around them to run a
    // command (in the preview's sandbox they can't), and say how that went
    // in their title
    var escaped = path.join(tmp, "escaped.txt");
    var escape = "try { parent.app.proc.execFile('sh', { args: ['-c', 'echo ran > " + escaped + "'] }, function() {});"
        + " document.title = 'reached the IDE'; } catch (e) { document.title = 'blocked ' + self.origin; }";
    fs.writeFileSync(path.join(workspace, "page.html"), "<!doctype html>\n<link rel=\"stylesheet\" href=\"page.css\">\n"
        + "<h1 id=\"title\">Page</h1>\n<a id=\"next\" href=\"next.html\">next</a>\n<script>" + escape + "</script>\n");
    fs.writeFileSync(path.join(workspace, "next.html"), "<!doctype html>\n<link rel=\"stylesheet\" href=\"page.css\">\n"
        + "<h1 id=\"title\">Next</h1>\n");
    fs.writeFileSync(path.join(workspace, "page.css"), "h1 { color: rgb(1, 2, 3); }\n");
    fs.writeFileSync(path.join(workspace, "notes.md"), "# Notes\n\n<img src=\"x\" onerror=\"" + escape + "\">\n");
    // a saved Run tab, as the IDE keeps one in the workspace, that asks to
    // be started when it is shown again
    var restored = path.join(tmp, "restored.txt");
    fs.mkdirSync(path.join(workspace, ".c9"));
    fs.writeFileSync(path.join(workspace, ".c9/state.settings"), JSON.stringify({ console: { "@expanded": true, "json()": {
        type: "pane", skin: "editor_tab", skinset: "default", name: "pane1",
        nodes: [{ type: "tab", name: "tab1", path: "", editorType: "output", active: true, document: {
            title: "Run", changed: false, filter: true,
            output: { id: "output_smoke", config: { name: "saved", command: "touch " + restored, runner: "Shell command" }, run: true }
        }}]
    }}}));
    // another folder to open as the workspace (?w=), with settings of its own
    var other = path.join(workspace, "other");
    fs.mkdirSync(path.join(other, ".c9"), { recursive: true });
    fs.writeFileSync(path.join(other, "only-here.txt"), "in the other folder\n");
    var otherSettings = JSON.stringify({ ace: { "@tabSize": 3 } }, null, 4);
    fs.writeFileSync(path.join(other, ".c9/project.settings"), otherSettings);

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

    await check("only the IDE's page is sent without a sandbox", async function() {
        var sandboxed = /^sandbox allow-scripts(?!.*allow-same-origin)(?!.*allow-top-navigation)/;
        var res = await get(port, "/ide.html", USER, PASSWORD);
        assert.equal(res.headers["content-security-policy"], "frame-ancestors 'none'");
        assert.equal(res.headers["x-frame-options"], "DENY");
        // a file of the workspace, by the addresses it has; a page of the
        // IDE's files; an error that repeats the request
        var documents = ["/preview/page.html", "/vfs/1/preview/page.html", "/preview/",
            "/static/plugins/c9.ide.preview.markdown/markdown.html",
            "/preview/<script>alert(1)</script>"];
        for (var i = 0; i < documents.length; i++) {
            res = await get(port, encodeURI(documents[i]), USER, PASSWORD);
            assert(sandboxed.test(res.headers["content-security-policy"]),
                documents[i] + ": " + res.headers["content-security-policy"]);
        }
        res = await get(port, "/static/mini_require.js", USER, PASSWORD);
        assert.equal(res.headers["content-security-policy"], undefined, "a script");
    });

    await check("ide.html loads a config by its name only", async function() {
        // (the name is part of the path of a file that the server loads)
        var loaded = path.join(tmp, "config-loaded.txt");
        fs.writeFileSync(path.join(workspace, "config.js"),
            "require('fs').writeFileSync(" + JSON.stringify(loaded) + ", 'loaded'); module.exports = function() { return []; };\n");
        var name = "x/../" + path.relative(path.join(ROOT, "configs"), path.join(workspace, "config"));
        var res = await get(port, "/ide.html?workspacetype=" + encodeURIComponent(name), USER, PASSWORD);
        assert.equal(res.status, 422);
        assert(/^sandbox /.test(res.headers["content-security-policy"]), "the error page: " + res.headers["content-security-policy"]);
        assert(!fs.existsSync(loaded), "the server loaded a file of the workspace");
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

    await check("a saved Run tab is shown again, not started again", async function() {
        await until("the saved tab", function() {
            return page.evaluate(function() {
                return window.app.tabManager.getTabs().some(function(tab) { return tab.editorType == "output"; });
            });
        });
        await wait(3000);
        assert(!fs.existsSync(restored), "the command of the saved tab ran");
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
            return document.querySelector(".agent-claude textarea.agent-input").value;
        });
        assert(/^Fix this error in typed\.ts, line 1:\n\nerror: .*not assignable/.test(text), text);
        assert(/In typed\.ts, line 1:\n\n```ts\nconst count: number = "three";\n```/.test(text), text);
    });

    await check("language server: hover, references, a fix, formatting, a rename in every file", async function() {
        var dir = path.join(workspace, "lsp");
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "esnext" }, include: ["*.ts"] }));
        fs.writeFileSync(path.join(dir, "shapes.ts"), "/** The area of a circle. */\nexport function circleArea(radius: number): number {\n"
            + "    return Math.PI * radius * radius;\n}\n\nexport interface Shape {\n    name: string;\n}\n");
        fs.writeFileSync(path.join(dir, "other.ts"), "import { circleArea } from \"./shapes\";\nexport const big = circleArea(100);\n");
        fs.writeFileSync(path.join(dir, "main.ts"), "import { circleArea } from \"./shapes\";\n\nconst area = circleArea(2);\n"
            + "console.log(area,   circleArea(3));\nconst s: Shape = { name: \"x\" };\n");
        await page.evaluate(function() {
            return new Promise(function(resolve) { window.app.tabManager.openFile("/lsp/main.ts", true, resolve); });
        });
        var annotations = function() {
            return page.evaluate(function() {
                var tab = window.app.tabManager.findTab("/lsp/main.ts");
                return tab.editor.ace.session.getAnnotations().map(function(a) { return a.text; });
            });
        };
        await until("the server to check the file", async function() {
            return (await annotations()).some(function(text) { return /Cannot find name 'Shape'/.test(text); });
        }, 60000);
        var cursor = function(row, column) {
            return page.evaluate(function(pos) {
                var ace = window.app.tabManager.focussedTab.editor.ace;
                ace.focus();
                ace.moveCursorTo(pos[0], pos[1]);
            }, [row, column]);
        };
        var value = function() {
            return page.evaluate(function() { return window.app.tabManager.focussedTab.editor.ace.getValue(); });
        };
        var rows = function() {
            return page.evaluate(function() {
                return Array.from(document.querySelectorAll(".lsp-list-row")).map(function(row) {
                    return row.textContent.replace(/\s+/g, " ");
                });
            });
        };

        // the mouse rests on a name: its type and documentation
        var at = await page.evaluate(function() {
            var c = window.app.tabManager.focussedTab.editor.ace.renderer.textToScreenCoordinates(2, 16);
            return { x: c.pageX, y: c.pageY + 6 };
        });
        await page.mouse.move(at.x - 60, at.y + 80);
        await page.mouse.move(at.x, at.y, { steps: 5 });
        var tip = await until("the hover", function() {
            return page.evaluate(function() {
                var el = document.querySelector(".lsp-hover");
                return el && el.textContent;
            });
        });
        assert(/circleArea\(radius: number\): number/.test(tip) && /The area of a circle/.test(tip), tip);
        await page.mouse.move(at.x + 400, at.y + 250);

        // Find References: in this file, where it is declared, and in a file that is not open
        await cursor(2, 15);
        await page.evaluate(function() { window.app.commands.exec("lspreferences"); });
        var list = await until("the references", async function() {
            var found = await rows();
            return found.length && found;
        });
        assert.equal(list.length, 6, JSON.stringify(list));
        assert(list.some(function(row) { return /^lsp\/other\.ts:2 ?export const big = circleArea\(100\);/.test(row); }), JSON.stringify(list));
        // Enter goes to the place that is selected, Down selects the next one
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await until("the tab of the declaration", function() {
            return page.evaluate(function() {
                var tab = window.app.tabManager.focussedTab;
                return tab.path == "/lsp/shapes.ts" && tab.editor.ace.getSelectedText() == "circleArea";
            });
        });
        await page.evaluate(function() {
            return new Promise(function(resolve) {
                window.app.tabManager.focussedTab.close();
                window.app.tabManager.openFile("/lsp/main.ts", true, resolve);
            });
        });

        await until("the first file's tab", function() {
            return page.evaluate(function() {
                var tab = window.app.tabManager.focussedTab;
                return tab && tab.path == "/lsp/main.ts" && !!tab.editor.ace;
            });
        });

        // Quick Fix: the missing import
        await cursor(4, 10);
        await page.evaluate(function() { window.app.commands.exec("lspcodeaction"); });
        list = await until("the fixes", async function() {
            var found = await rows();
            return found.length && found;
        });
        assert(/import/.test(list[0]), JSON.stringify(list));
        await page.keyboard.press("Enter");
        await until("the import", async function() {
            return /^import \{ circleArea, Shape \} from "\.\/shapes";/.test(await value());
        });

        // Format Document
        await page.evaluate(function() { window.app.commands.exec("lspformat"); });
        await until("the formatted line", async function() {
            return (await value()).split("\n")[3] == "console.log(area, circleArea(3));";
        });

        // Rename Symbol, from a use of the imported name: where it is
        // declared and in the file that is not open, too
        await cursor(2, 15);
        await page.evaluate(function() { window.app.commands.exec("lsprename"); });
        var input = page.locator(".lsp-rename-input");
        await input.waitFor({ timeout: 30000 });
        assert.equal(await input.inputValue(), "circleArea");
        await input.fill("diskArea");
        await input.press("Enter");
        await until("the rename here", async function() {
            return /^import \{ diskArea, Shape \} from "\.\/shapes";\n\nconst area = diskArea\(2\);\nconsole\.log\(area, diskArea\(3\)\);/.test(await value());
        });
        await until("the rename in the other files", function() {
            return /export function diskArea\(radius/.test(fs.readFileSync(path.join(dir, "shapes.ts"), "utf8"))
                && fs.readFileSync(path.join(dir, "other.ts"), "utf8") == "import { diskArea } from \"./shapes\";\nexport const big = diskArea(100);\n";
        });
        // one step to undo in the editor
        await page.evaluate(function() { window.app.tabManager.focussedTab.editor.ace.undo(); });
        assert(/const area = circleArea\(2\)/.test(await value()), await value());
        await page.evaluate(function() { window.app.tabManager.focussedTab.editor.ace.redo(); });
        await until("the server to agree with the files", async function() {
            return (await annotations()).length === 0;
        }, 60000);

        // a language whose server is not installed: nothing runs, nothing is said
        fs.writeFileSync(path.join(dir, "quiet.zzlang"), "x = 1\n");
        var custom = await page.evaluate(function() {
            window.app.settings.set("user/lsp/@servers", JSON.stringify([
                { name: "zzlang", command: ["c9-no-such-language-server", "--stdio"], extensions: ["zzlang"], languages: ["text"] }
            ]));
            return new Promise(function(resolve) {
                window.app.tabManager.openFile("/lsp/quiet.zzlang", true, function() {
                    var tab = window.app.tabManager.focussedTab;
                    window.app["language.lsp.features"].request("hover", tab, {}, function(err) {
                        resolve({ err: err && err.message, states: window.app["language.lsp"].states,
                            handles: window.app["language.lsp"].handles("/lsp/quiet.zzlang") });
                    });
                });
            });
        });
        assert.equal(custom.states.zzlang && custom.states.zzlang.state, "missing", JSON.stringify(custom));
        assert.equal(custom.handles, false);
        await page.evaluate(function() {
            window.app.settings.set("user/lsp/@servers", "");
            window.app.tabManager.focussedTab.close();
        });
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

    // the frame of a preview, by its address
    function frameOf(pattern) {
        return until("the preview's frame", function() {
            return page.frames().filter(function(frame) { return pattern.test(frame.url()); })[0];
        });
    }
    function openPreview(file) {
        return page.evaluate(function(file) {
            return new Promise(function(resolve) { window.app.preview.openPreview(file, null, true, resolve); });
        }, file);
    }

    await check("preview: a page of the workspace can't reach the IDE or run a command", async function() {
        await openPreview("/page.html");
        var frame = await frameOf(/\/preview\/page\.html/);
        // in the pane, with its style sheet
        assert.equal(await until("the page", function() { return frame.title(); }), "blocked null");
        assert.equal(await frame.evaluate(function() {
            return getComputedStyle(document.getElementById("title")).color;
        }), "rgb(1, 2, 3)");
        // and in a tab of its own, where it tries the IDE in a frame too
        var tab = await context.newPage();
        await tab.goto("http://127.0.0.1:" + port + "/preview/page.html");
        assert.equal(await tab.title(), "blocked null");
        var framed = await tab.evaluate(function() {
            return new Promise(function(resolve) {
                var frame = document.createElement("iframe");
                frame.src = "/ide.html";
                frame.onload = function() {
                    try { resolve(typeof frame.contentWindow.app); } catch (e) { resolve("blocked"); }
                };
                document.body.appendChild(frame);
            });
        });
        assert.equal(framed, "blocked");
        await tab.close();
        await wait(500);
        assert(!fs.existsSync(escaped), "the page ran a command");
    });

    await check("preview: live CSS, and the IDE follows a link in the page", async function() {
        var frame = await frameOf(/\/preview\/page\.html/);
        await until("the page to connect to the IDE", function() {
            return page.evaluate(function() {
                var session = window.app.tabManager.findTab("preview-/page.html").document.getSession();
                return session.styleSheets && session.styleSheets.length == 1 && session.html;
            });
        });
        await page.evaluate(function() {
            return new Promise(function(resolve) { window.app.tabManager.openFile("/page.css", true, resolve); });
        });
        await until("the style sheet", function() {
            return page.evaluate(function() {
                var tab = window.app.tabManager.findTab("/page.css");
                return tab && tab.editor.ace && tab.editor.ace.getValue().length > 0;
            });
        });
        // two edits of a value, not saved: the page gets the style sheet,
        // then a rule
        var colors = ["rgb(1, 2, 3)", "rgb(4, 5, 6)", "rgb(7, 8, 9)"];
        for (var i = 1; i < colors.length; i++) {
            await page.evaluate(function(colors) {
                var ace = window.app.tabManager.findTab("/page.css").editor.ace;
                ace.find(colors[0]);
                ace.insert(colors[1]);
            }, [colors[i - 1], colors[i]]);
            await until("the color " + colors[i] + " in the preview", function() {
                return frame.evaluate(function(color) {
                    return getComputedStyle(document.getElementById("title")).color == color;
                }, colors[i]);
            });
        }
        await page.evaluate(function() {
            return new Promise(function(resolve) {
                var tab = window.app.tabManager.findTab("/page.css");
                window.app.save.save(tab, {}, function() {
                    tab.close();
                    window.app.tabManager.focusTab(window.app.tabManager.findTab("preview-/page.html"));
                    resolve();
                });
            });
        });
        await frame.click("#next");
        await until("the tab to show the next page", function() {
            return page.evaluate(function() {
                return window.app.tabManager.findTab("preview-/page.html").title == "[B] /next.html";
            });
        });
    });

    await check("preview: a page can't run what it likes in the IDE, or get other files", async function() {
        await openPreview("/page.html");
        var frame = await frameOf(/\/preview\/page\.html/);
        await page.evaluate(function() {
            window.smokeCommands = [];
            window.app.commands.on("afterExec", function(e) { window.smokeCommands.push(e.command.name); });
        });
        // the page asks, with the keyboard focus (as if keys were pressed
        // in it), for commands and for the text of files as its own
        await frame.click("#title");
        await frame.evaluate(function() {
            var id = /_c9_id=(\w+)/.exec(location.search)[1];
            ["run", "build", "closealltabs", "openterminal", "toggleconsole"].forEach(function(command) {
                parent.postMessage({ id: id, message: "exec", command: command }, "*");
            });
            parent.postMessage({ id: id, message: "html.ready", data: {
                styles: ["/page.css", "/hello.js", "~/.c9/user.settings"], scripts: ["/typed.ts"], href: "/hello.js"
            }}, "*");
        });
        // another window than the preview's asks too
        await page.evaluate(function() {
            var other = window.open("about:blank");
            other.eval("opener.postMessage({ id: 'livepreview0', message: 'exec', command: 'nexttab' }, '*')");
            other.close();
        });
        await until("the one command a page may run", function() {
            return page.evaluate(function() { return window.smokeCommands.length; });
        });
        await wait(500);
        var state = await page.evaluate(function() {
            return { commands: window.smokeCommands, documents: Object.keys(window.app.remote.documents).sort() };
        });
        assert.deepEqual(state.commands, ["toggleconsole"]);
        assert.deepEqual(state.documents, ["/page.css", "/page.html"]);
        await page.evaluate(function() { window.app.commands.exec("toggleconsole"); });
    });

    await check("preview: HTML in a Markdown file can't reach the IDE", async function() {
        await openPreview("/notes.md");
        var frame = await frameOf(/markdown\.html/);
        await until("the Markdown", function() {
            return frame.evaluate(function() {
                var heading = document.querySelector("#preview h1");
                return heading && heading.textContent == "Notes" && /^blocked/.test(document.title);
            });
        });
        assert.equal(await frame.title(), "blocked null");
        await wait(500);
        assert(!fs.existsSync(escaped), "the Markdown file ran a command");
        await page.evaluate(function() {
            window.app.tabManager.getTabs().forEach(function(tab) {
                if (tab.editorType == "preview") tab.close();
            });
        });
    });

    // the IDE with another folder as its workspace, in a tab of its own
    var otherPage;
    async function openWorkspace(folder) {
        if (!otherPage)
            otherPage = await context.newPage();
        await otherPage.goto("http://127.0.0.1:" + port + "/ide.html?w=" + encodeURIComponent(folder),
            { waitUntil: "load", timeout: 120000 });
        await otherPage.waitForFunction(function() {
            return window.app && window.app.vfs && window.app.vfs.connected && window.app.tabManager
                && window.app.settings.inited;
        }, null, { timeout: 120000 });
        return otherPage.evaluate(function() {
            return new Promise(function(resolve) {
                window.app.fs.readFile("/only-here.txt", "utf8", function(err, data) {
                    resolve({
                        dir: window.app.c9.workspaceDir,
                        file: err ? "ERROR " + err.message : data,
                        trusted: window.app.settings.trusted,
                        tabSize: window.app.settings.getNumber("project/ace/@tabSize")
                    });
                });
            });
        });
    }

    await check("?w=: another folder is opened with its own files", async function() {
        var state = await openWorkspace(other);
        assert.equal(state.dir, other);
        assert.equal(state.file, "in the other folder\n");
        // and the configured workspace, opened after it, with its own
        state = await openWorkspace(workspace);
        assert.equal(state.dir, workspace);
        assert(/^ERROR /.test(state.file), "the workspace has the other folder's files: " + state.file);
    });

    await check("?w=: only a folder in the workspace or the home folder", async function() {
        var state = await openWorkspace("/etc");
        assert.equal(state.dir, workspace);
        state = await openWorkspace(path.join(tmp, "nothing-here"));
        assert.equal(state.dir, workspace);
    });

    await check("?w=: a folder's own settings wait until the folder is trusted", async function() {
        var state = await openWorkspace(other);
        assert.equal(state.trusted, false);
        assert.notEqual(state.tabSize, 3);
        var button = otherPage.getByText("Trust Folder", { exact: true }).last();
        await button.waitFor({ timeout: 30000 });
        // settings changed here are not written over the folder's
        await otherPage.evaluate(function() {
            window.app.settings.set("project/ace/@tabSize", 5);
            window.app.settings.save(true);
        });
        await wait(2500);
        assert.equal(fs.readFileSync(path.join(other, ".c9/project.settings"), "utf8"), otherSettings);
        assert(!fs.existsSync(path.join(other, ".c9/state.settings")), "state.settings was written");

        await Promise.all([otherPage.waitForNavigation({ timeout: 60000 }), button.click()]);
        state = await openWorkspace(other);
        assert.equal(state.trusted, true);
        assert.equal(state.tabSize, 3);
        await otherPage.close();
        // the approval is not in a file that the IDE's other tab writes
        await page.evaluate(function() {
            window.app.settings.set("user/general/@smoke", Date.now());
            window.app.settings.save(true);
        });
        await wait(2500);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".c9/trusted.folders"), "utf8")), [fs.realpathSync(other)]);
        // the configured workspace needed no approval
        assert.equal(await page.evaluate(function() { return window.app.settings.trusted; }), true);
    });

    await check("a file changed on disk: shown at once in a tab without unsaved changes, asked about otherwise", async function() {
        var file = path.join(workspace, "ondisk.js");
        fs.writeFileSync(file, "var a = 1;\nvar b = 2;\nvar c = 3;\n");
        await page.evaluate(function() {
            return new Promise(function(resolve) {
                window.app.tabManager.open({ path: "/ondisk.js", focus: true }, function(err, tab) {
                    tab.editor.ace.gotoLine(3, 4);
                    resolve();
                });
            });
        });
        var state = function() {
            return page.evaluate(function() {
                var tab = window.app.tabManager.findTab("/ondisk.js");
                return {
                    value: tab.document.value,
                    changed: !!tab.document.changed,
                    row: tab.editor.ace.getCursorPosition().row,
                    asked: /has been changed on disk/.test(document.body.innerText)
                };
            });
        };
        // (the watcher of a file starts a moment after it is opened)
        await wait(1500);
        fs.writeFileSync(file, "var a = 1;\nvar b = 20;\nvar c = 3;\n");
        await until("the editor to show the file", async function() {
            return (await state()).value == "var a = 1;\nvar b = 20;\nvar c = 3;\n";
        });
        var now = await state();
        assert.equal(now.asked, false);
        assert.equal(now.changed, false);
        assert.equal(now.row, 2, "the cursor stays");

        // with text of the user's that is not saved: asked, nothing replaced
        await page.evaluate(function() {
            window.app.tabManager.findTab("/ondisk.js").editor.ace.insert("mine ");
        });
        fs.writeFileSync(file, "var a = 1;\nvar b = 300;\nvar c = 3;\n");
        await until("the question", async function() { return (await state()).asked; });
        assert.ok(/mine /.test((await state()).value));
        // (the caption is under another layer of the button)
        await page.getByText("Keep Mine", { exact: true }).click({ force: true });
        await until("the question to go", async function() { return !(await state()).asked; });
        assert.ok(/mine /.test((await state()).value));
        await page.evaluate(function() {
            return new Promise(function(resolve) {
                var tab = window.app.tabManager.findTab("/ondisk.js");
                tab.document.undoManager.bookmark();
                tab.close();
                resolve();
            });
        });
    });

    await check("Claude Code IDE bridge: the selection, a diff to accept or reject, no files from elsewhere", async function() {
        // in the place of a `claude` in a terminal: what it would find and do
        var lockDir = path.join(home, ".claude/ide");
        // (the folder that an earlier check opened as a workspace of its
        // own has a bridge and a lock file too)
        var lockName, lock;
        // (an earlier check opened this workspace in a second page, whose
        // bridge had the lock file while it was there; the window that is
        // used gets it back)
        await page.evaluate(function() { window.dispatchEvent(new Event("focus")); });
        await until("the bridge's lock file", function() {
            if (!fs.existsSync(lockDir)) return false;
            return fs.readdirSync(lockDir).some(function(name) {
                lockName = name;
                lock = JSON.parse(fs.readFileSync(path.join(lockDir, name), "utf8"));
                return lock.workspaceFolders[0] == fs.realpathSync(workspace);
            });
        });
        assert.equal(lock.ideName, "Cloud9");
        assert.equal(fs.statSync(path.join(lockDir, lockName)).mode & 63, 0, "the token is for the user only");
        var bridgePort = parseInt(lockName, 10);
        var refused = await new Promise(function(resolve) {
            wsClient(bridgePort, {}, function(err, res) { resolve(res && res.status); });
        });
        assert.equal(refused, 401);
        var cli = await new Promise(function(resolve, reject) {
            wsClient(bridgePort, { "x-claude-code-ide-authorization": lock.authToken }, function(err, client) {
                if (err || client.status != 101) return reject(err || new Error("refused: " + client.status));
                resolve(client);
            });
        });
        try {
            cli.send({ jsonrpc: "2.0", method: "ide_connected", params: { pid: process.pid }});
            await until("the IDE to see the CLI", function() {
                return page.evaluate(function() { return window.app["claude.ide"].clients == 1; });
            });

            // the selection of the focused editor
            fs.writeFileSync(path.join(workspace, "bridge.js"), "var first = 1;\nvar second = 2;\n");
            await page.evaluate(function() {
                return new Promise(function(resolve) {
                    window.app.tabManager.open({ path: "/bridge.js", focus: true }, function(err, tab) {
                        tab.editor.ace.selection.setSelectionRange({ start: { row: 1, column: 4 }, end: { row: 1, column: 10 }});
                        resolve();
                    });
                });
            });
            var file = path.join(fs.realpathSync(workspace), "bridge.js");
            var selection = await cli.call("getCurrentSelection");
            selection = JSON.parse(selection.content[0].text);
            assert.equal(selection.text, "second");
            assert.equal(selection.filePath, file);
            assert.deepEqual(selection.selection.start, { line: 1, character: 4 });
            await until("the selection to be sent", function() {
                return cli.messages.some(function(m) {
                    return m.method == "selection_changed" && m.params.text == "second" && m.params.filePath == file;
                });
            });
            var editors = JSON.parse((await cli.call("getOpenEditors")).content[0].text);
            assert.ok(editors.tabs.some(function(tab) { return tab.uri == "file://" + file && tab.isActive; }));
            var diagnostics = JSON.parse((await cli.call("getDiagnostics", { uri: "file://" + file })).content[0].text);
            assert.ok(Array.isArray(diagnostics));

            // a proposed change: a diff in a tab; the proposed side is
            // edited, then accepted
            var proposal = { old_file_path: file, new_file_path: file, new_file_contents: "var first = 100;\nvar second = 2;\n", tab_name: "smoke diff" };
            var answer = cli.call("openDiff", proposal);
            await until("the diff", function() {
                return page.evaluate(function() {
                    var tab = window.app.tabManager.focussedTab;
                    var view = tab && tab.editorType == "diffview" && tab.editor.diffview;
                    return !!view && view.orig.session.getValue() == "var first = 1;\nvar second = 2;\n"
                        && view.edit.session.getValue() == "var first = 100;\nvar second = 2;\n";
                });
            });
            await page.evaluate(function() {
                window.app.tabManager.focussedTab.editor.diffview.edit.session.insert({ row: 0, column: 0 }, "// seen\n");
            });
            await page.getByText("Accept", { exact: true }).click();
            answer = await answer;
            assert.equal(answer.content[0].text, "FILE_SAVED");
            assert.equal(answer.content[1].text, "// seen\nvar first = 100;\nvar second = 2;\n");
            // the CLI writes the file, not the IDE
            assert.equal(fs.readFileSync(file, "utf8"), "var first = 1;\nvar second = 2;\n");
            var diffTabs = function() {
                return page.evaluate(function() {
                    return window.app.tabManager.getTabs().filter(function(tab) { return tab.editorType == "diffview"; }).length;
                });
            };
            await until("the diff to be closed", async function() { return await diffTabs() == 0; });

            // rejected; and one that the CLI closes itself (answered in the terminal)
            answer = cli.call("openDiff", proposal);
            await until("the second diff", async function() { return await diffTabs() == 1; });
            await page.getByText("Reject", { exact: true }).click();
            assert.equal((await answer).content[0].text, "DIFF_REJECTED");
            cli.call("openDiff", proposal);
            await until("the third diff", async function() { return await diffTabs() == 1; });
            cli.send({ jsonrpc: "2.0", id: "close", method: "tools/call", params: { name: "close_tab", arguments: { tab_name: "smoke diff" }}});
            await until("the diff to be closed", async function() { return await diffTabs() == 0; });

            // only files the editor may open
            var outside = await cli.call("openFile", { filePath: "/etc/passwd" });
            assert.equal(outside.isError, true);
            outside = await cli.call("openDiff", { old_file_path: "/etc/passwd", new_file_path: "/etc/passwd", new_file_contents: "", tab_name: "x" });
            assert.equal(outside.isError, true);
        } finally {
            cli.socket.destroy();
        }
        await until("the IDE to see the CLI go", function() {
            return page.evaluate(function() { return window.app["claude.ide"].clients === 0; });
        });
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

    await check("DeepSeek inline completions: a suggestion as you type, Tab accepts it", async function() {
        fs.writeFileSync(path.join(workspace, "inline.js"), "function add(a, b) {\n    \n}\n");
        await page.evaluate(function() {
            window.app.settings.set("user/deepseek/inline/@mode", "auto");
            return new Promise(function(resolve) { window.app.tabManager.openFile("/inline.js", true, resolve); });
        });
        await until("the file", function() {
            return page.evaluate(function() {
                var tab = window.app.tabManager.findTab("/inline.js");
                var ace = tab && tab.editor.ace;
                if (!ace || ace.session.getLength() < 3) return false;
                ace.focus();
                ace.moveCursorTo(1, 4);
                return true;
            });
        });
        await page.keyboard.type("return ");
        var ghost = await until("the suggestion", function() {
            return page.evaluate(function() {
                var span = document.querySelector(".ace_text-layer .ace_ghost_text");
                return span && span.textContent;
            });
        });
        assert.equal(ghost, "a + b;");
        // from the server, with the account's key; the code around the cursor
        var sent = fimRequests[fimRequests.length - 1];
        assert.equal(sent.auth, "Bearer sk-smoke-deepseek");
        assert.equal(sent.body.model, "deepseek-flash");
        assert.equal(sent.body.prompt, "function add(a, b) {\n    return ");
        assert.equal(sent.body.suffix, "\n}\n");
        await page.keyboard.press("Tab");
        await until("the suggestion in the file", function() {
            return page.evaluate(function() {
                return window.app.tabManager.findTab("/inline.js").editor.ace.session.getLine(1) == "    return a + b;"
                    && !document.querySelector(".ace_ghost_text");
            });
        });
        await page.evaluate(function() { window.app.settings.set("user/deepseek/inline/@mode", "off"); });
    });

    // the panels: a chat through Claude Code to the mock API
    // (one panel for both providers: c9.ide.agent; its root has the provider's class)
    var panels = [["deepseek", ".agent-deepseek"], ["claude", ".agent-claude"]];
    for (var i = 0; i < panels.length; i++) {
        await (function(name, rootSelector) {
            return check(name + " panel: a chat answer", async function() {
                await page.evaluate(function(name) { window.app[name].show(); }, name);
                var input = page.locator(rootSelector + " textarea.agent-input");
                await input.waitFor({ timeout: 30000 });
                var state = await until("the panel to find claude", function() {
                    return page.evaluate(function(rootSelector) {
                        var root = document.querySelector(rootSelector);
                        var text = root ? root.innerText : "";
                        if (/claude CLI was not found/.test(text)) return "missing";
                        if (/\(Claude Code\)/.test(text)) return "found";
                    }, rootSelector);
                }, 30000);
                if (state == "missing")
                    return "skipped: the claude CLI is not installed";
                await input.fill("ping");
                await input.press("Enter");
                await page.waitForFunction(function(rootSelector) {
                    var root = document.querySelector(rootSelector);
                    return root && /\bpong\b/.test(root.innerText);
                }, rootSelector, { timeout: 90000 });
                // what the answer cost: the CLI's own figure in the Claude
                // panel, an estimate with DeepSeek's prices in the other
                var footer = await until("the answer's footer", function() {
                    return page.evaluate(function(rootSelector) {
                        var el = document.querySelector(rootSelector + " .agent-turn-footer");
                        return el && el.textContent;
                    }, rootSelector);
                }, 30000);
                if (name == "deepseek") assert(/≈\$[\d.]+ · (off-)?peak/.test(footer), footer);
                else assert(!/≈|peak/.test(footer), footer);
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

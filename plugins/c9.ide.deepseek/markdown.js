/**
 * Markdown and code rendering for the DeepSeek panel (a copy of the Claude panel's).
 *
 * Model output is rendered with remarkable (raw HTML disabled), parsed in an
 * inert document and then filtered through a whitelist of tags and
 * attributes before it touches the IDE's DOM. Links only keep http(s) and
 * mailto targets and open in a new window; anything else that looks like a
 * file path is turned into a link that opens the file in the editor.
 *
 * Code is highlighted with the tokenizer of the matching Ace mode; tokens are
 * written with textContent, never as HTML.
 */
define(function(require, exports, module) {
    "use strict";

    var Remarkable = require("plugins/c9.ide.preview.markdown/remarkable.min");
    var config = require("ace/config");
    var modelist = require("ace/ext/modelist");

    var md = new Remarkable("full", {
        html: false,
        xhtmlOut: false,
        breaks: true,       // like the terminal: a newline is a line break
        langPrefix: "language-",
        linkify: true,
        typographer: false
    });

    var escapeHtml = Remarkable.utils && Remarkable.utils.escapeHtml || function(str) {
        return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    };

    // Images in model output would make the browser fetch arbitrary URLs:
    // show them as links instead.
    md.renderer.rules.image = function(tokens, idx) {
        var token = tokens[idx];
        var label = token.alt || token.src || "image";
        return '<a href="' + escapeHtml(token.src || "") + '">' + escapeHtml(label) + "</a>";
    };

    var ALLOWED_TAGS = {
        A: 1, B: 1, BLOCKQUOTE: 1, BR: 1, CODE: 1, DD: 1, DEL: 1, DIV: 1, DL: 1, DT: 1,
        EM: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HR: 1, I: 1, INS: 1, LI: 1,
        MARK: 1, OL: 1, P: 1, PRE: 1, S: 1, SPAN: 1, STRONG: 1, SUB: 1, SUP: 1,
        TABLE: 1, TBODY: 1, TD: 1, TH: 1, THEAD: 1, TR: 1, UL: 1
    };
    var SAFE_URL = /^(https?:|mailto:)/i;

    var inertDoc = document.implementation.createHTMLDocument("");

    /**
     * Turns a link target into either a safe external URL or a file
     * reference ({ path, line }); returns null for anything else.
     */
    function classifyHref(href) {
        // browsers ignore tabs, newlines and leading control characters in URLs
        var clean = String(href || "").replace(/[\u0000- \u007f]+/g, "");
        if (!clean) return null;
        if (SAFE_URL.test(clean))
            return { url: clean };
        if (/^[a-z][a-z0-9+.\-]*:/i.test(clean) || /^\/\//.test(clean))
            return null;
        // file.js, src/file.js:12, ./src/file.js#L12, /abs/path.py#L3-L9
        var m = /^([^#?]+?)(?::(\d+)(?::\d+)?)?(?:#L(\d+)(?:-L?\d+)?)?$/.exec(clean);
        if (!m) return null;
        var file;
        try { file = decodeURIComponent(m[1]); } catch (e) { file = m[1]; }
        if (!/[\w]/.test(file)) return null;
        return { path: file, line: m[2] || m[3] ? parseInt(m[2] || m[3], 10) : null };
    }

    function sanitize(node, onFileLink) {
        var children = [].slice.call(node.childNodes);
        children.forEach(function(child) {
            if (child.nodeType == 3) return;
            if (child.nodeType != 1 || !ALLOWED_TAGS[child.tagName]) {
                // keep the text of anything unexpected, drop the element
                if (child.nodeType == 1)
                    node.replaceChild(inertDoc.createTextNode(child.textContent), child);
                else
                    node.removeChild(child);
                return;
            }
            var attrs = [].slice.call(child.attributes);
            var href = child.tagName == "A" ? child.getAttribute("href") : null;
            attrs.forEach(function(attr) {
                var name = attr.name.toLowerCase();
                var keep = false;
                if (name == "title") keep = true;
                else if (name == "class") keep = /^language-[\w+#.\-]+$/.test(attr.value);
                else if (name == "start" && child.tagName == "OL") keep = /^\d+$/.test(attr.value);
                else if (name == "align" && /^T[DH]$/.test(child.tagName)) keep = /^(left|right|center)$/.test(attr.value);
                else if (name == "style" && /^T[DH]$/.test(child.tagName)) keep = /^text-align:\s*(left|right|center);?$/.test(attr.value);
                if (!keep)
                    child.removeAttribute(attr.name);
            });
            if (child.tagName == "A") {
                var target = classifyHref(href);
                if (target && target.url) {
                    child.setAttribute("href", target.url);
                    child.setAttribute("target", "_blank");
                    child.setAttribute("rel", "noopener noreferrer");
                }
                else if (target && target.path && onFileLink) {
                    child.setAttribute("href", "#");
                    child.className = "ds-file-link";
                    child.setAttribute("data-path", target.path);
                    if (target.line) child.setAttribute("data-line", String(target.line));
                }
                else {
                    child.removeAttribute("href");
                }
            }
            sanitize(child, onFileLink);
        });
    }

    /**
     * Renders markdown text into the element el (its old content is
     * replaced). Returns the list of <pre><code> elements.
     */
    function render(text, el, onFileLink) {
        var html;
        try {
            html = md.render(String(text || ""));
        } catch (e) {
            el.textContent = text;
            return [];
        }
        var holder = inertDoc.createElement("div");
        holder.innerHTML = html;
        sanitize(holder, onFileLink);

        var frag = document.createDocumentFragment();
        while (holder.firstChild)
            frag.appendChild(document.adoptNode(holder.firstChild));
        el.textContent = "";
        el.appendChild(frag);
        return [].slice.call(el.querySelectorAll("pre > code"));
    }

    /***** Syntax highlighting *****/

    var ALIASES = {
        sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh", shellscript: "sh", shellsession: "sh",
        js: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
        ts: "typescript", py: "python", python3: "python", rb: "ruby", rs: "rust",
        go: "golang", yml: "yaml", md: "markdown", jsonc: "json", json5: "json",
        "c++": "c_cpp", cpp: "c_cpp", cc: "c_cpp", c: "c_cpp", h: "c_cpp", hpp: "c_cpp",
        cs: "csharp", "c#": "csharp", kt: "kotlin", ps1: "powershell", ps: "powershell",
        patch: "diff", udiff: "diff", tex: "latex", vim: "text", text: "text", plaintext: "text", txt: "text"
    };
    var MAX_HIGHLIGHT_LINES = 3000;
    var modeCache = {};

    function modeForLanguage(lang) {
        lang = String(lang || "").toLowerCase().replace(/[^\w+#.\-]/g, "");
        if (!lang) return null;
        var name = ALIASES[lang] || lang;
        if (name == "text") return null;
        var mode = modelist.modesByName[name];
        if (!mode) {
            mode = modelist.getModeForPath("file." + lang);
            if (!mode || mode.name == "text") return null;
        }
        return mode.mode;
    }

    function loadMode(path, callback) {
        if (modeCache[path]) {
            if (modeCache[path].mode) return callback(modeCache[path].mode);
            return modeCache[path].waiting.push(callback);
        }
        var entry = modeCache[path] = { waiting: [callback] };
        config.loadModule(["mode", path], function(m) {
            try {
                entry.mode = new m.Mode();
            } catch (e) {
                entry.mode = null;
            }
            entry.waiting.forEach(function(cb) { cb(entry.mode); });
            entry.waiting = [];
        });
    }

    /**
     * Highlights the text of a <code> element in place.
     */
    function highlight(codeEl, lang, callback) {
        var path = modeForLanguage(lang);
        if (!path) return callback && callback(false);
        var text = codeEl.textContent;
        if (text.split("\n").length > MAX_HIGHLIGHT_LINES)
            return callback && callback(false);
        loadMode(path, function(mode) {
            if (!mode || codeEl.textContent !== text)
                return callback && callback(false);
            var tokenizer = mode.getTokenizer();
            var state = "start";
            var frag = document.createDocumentFragment();
            var lines = text.replace(/\n$/, "").split("\n");
            lines.forEach(function(line, i) {
                var data = tokenizer.getLineTokens(line, state);
                state = data.state;
                data.tokens.forEach(function(token) {
                    if (token.type == "text") {
                        frag.appendChild(document.createTextNode(token.value));
                    }
                    else {
                        var span = document.createElement("span");
                        span.className = "ace_" + token.type.replace(/\./g, " ace_");
                        span.textContent = token.value;
                        frag.appendChild(span);
                    }
                });
                if (i < lines.length - 1)
                    frag.appendChild(document.createTextNode("\n"));
            });
            codeEl.textContent = "";
            codeEl.appendChild(frag);
            callback && callback(true);
        });
    }

    function languageOf(codeEl) {
        var m = /(?:^|\s)language-([\w+#.\-]+)/.exec(codeEl.className || "");
        return m ? m[1] : "";
    }

    module.exports = {
        render: render,
        highlight: highlight,
        languageOf: languageOf,
        modeForLanguage: modeForLanguage,
        classifyHref: classifyHref
    };
});

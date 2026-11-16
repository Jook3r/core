/**
 * Small line diff for the Edit/MultiEdit cards of the Claude panel.
 */
define(function(require, exports, module) {
    "use strict";

    var MAX_CELLS = 250000; // lines(a) x lines(b) above which no LCS is computed

    function splitLines(text) {
        text = String(text == null ? "" : text);
        if (text === "") return [];
        return text.replace(/\n$/, "").split("\n");
    }

    /**
     * Line diff of two strings: [{ type: " " | "-" | "+", text }]
     */
    function lines(a, b) {
        var x = splitLines(a), y = splitLines(b);
        // common prefix and suffix first: edits are usually small
        var start = 0;
        while (start < x.length && start < y.length && x[start] === y[start]) start++;
        var endX = x.length, endY = y.length;
        while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) { endX--; endY--; }

        var out = [];
        var i;
        for (i = 0; i < start; i++) out.push({ type: " ", text: x[i] });

        var mx = x.slice(start, endX), my = y.slice(start, endY);
        if (mx.length * my.length > MAX_CELLS) {
            mx.forEach(function(t) { out.push({ type: "-", text: t }); });
            my.forEach(function(t) { out.push({ type: "+", text: t }); });
        }
        else {
            // LCS table, filled from the end
            var n = mx.length, m = my.length;
            var table = [];
            for (i = 0; i <= n; i++) table.push(zeros(m + 1));
            for (i = n - 1; i >= 0; i--) {
                for (var j = m - 1; j >= 0; j--) {
                    table[i][j] = mx[i] === my[j]
                        ? table[i + 1][j + 1] + 1
                        : Math.max(table[i + 1][j], table[i][j + 1]);
                }
            }
            var p = 0, q = 0;
            while (p < n || q < m) {
                if (p < n && q < m && mx[p] === my[q]) {
                    out.push({ type: " ", text: mx[p] }); p++; q++;
                }
                // on a tie the removed line comes first: "- old" above "+ new"
                else if (q < m && (p >= n || table[p][q + 1] > table[p + 1][q])) {
                    out.push({ type: "+", text: my[q] }); q++;
                }
                else {
                    out.push({ type: "-", text: mx[p] }); p++;
                }
            }
        }
        for (i = endX; i < x.length; i++) out.push({ type: " ", text: x[i] });
        return out;
    }

    function zeros(n) {
        var a = [];
        for (var i = 0; i < n; i++) a.push(0);
        return a;
    }

    /**
     * Keeps changed lines plus `context` lines around them; long unchanged
     * runs become { type: "...", count }.
     */
    function collapse(diff, context) {
        context = context == null ? 3 : context;
        var keep = diff.map(function() { return false; });
        diff.forEach(function(line, i) {
            if (line.type == " ") return;
            for (var k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++)
                keep[k] = true;
        });
        var out = [];
        var skipped = 0;
        diff.forEach(function(line, i) {
            if (keep[i]) {
                if (skipped) out.push({ type: "...", count: skipped });
                skipped = 0;
                out.push(line);
            }
            else skipped++;
        });
        if (skipped) out.push({ type: "...", count: skipped });
        return out;
    }

    function stats(diff) {
        var added = 0, removed = 0;
        diff.forEach(function(line) {
            if (line.type == "+") added++;
            else if (line.type == "-") removed++;
        });
        return { added: added, removed: removed };
    }

    module.exports = {
        lines: lines,
        collapse: collapse,
        stats: stats
    };
});

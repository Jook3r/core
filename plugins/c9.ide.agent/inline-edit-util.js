/**
 * The parts of the inline edit (./inline-edit.js) that only work on text:
 * what of a model's answer is the code, its indentation, and the changes
 * between the lines that were selected and the answer's.
 */
define(function(require, exports, module) {
    "use strict";

    var diff = require("./diff");

    /**
     * The code of an answer, or what it says in place of code.
     *
     * A model is asked for the selection's new text and nothing else, and
     * to start a refusal with "NOTE:". Some still wrap the code in a
     * Markdown fence, with or without a sentence around it.
     *
     * @param {String} answer
     * @return {Object} { text } or { note }
     */
    function clean(answer) {
        var text = String(answer == null ? "" : answer).replace(/\r\n?/g, "\n");
        var note = /^\s*NOTE:\s*([\s\S]*)$/.exec(text);
        if (note)
            return { note: note[1].trim() || "No change was proposed" };

        // one fence that is the whole answer, or the only one in it
        var fences = text.match(/^[ \t]*```/gm) || [];
        if (fences.length == 2) {
            var fenced = /^[ \t]*```[^\n]*\n([\s\S]*?)\n?^[ \t]*```[ \t]*$/m.exec(text);
            if (fenced)
                text = fenced[1];
        }
        return { text: text };
    }

    /**
     * An answer's lines. Empty lines at its end are not kept (an answer
     * ends with a line break or not, by the model's mood); an answer that
     * is empty or only white space has no lines (the selection is deleted).
     */
    function toLines(text) {
        text = String(text == null ? "" : text).replace(/\r\n?/g, "\n").replace(/[ \t\n]+$/, "");
        return text === "" ? [] : text.split("\n");
    }

    function indentOf(line) {
        return /^[ \t]*/.exec(line)[0];
    }

    // the smallest indentation of the lines that have text; null without one
    function minIndent(lines) {
        var min = null;
        lines.forEach(function(line) {
            if (!/\S/.test(line)) return;
            var indent = indentOf(line);
            if (min == null || indent.length < min.length) min = indent;
        });
        return min;
    }

    /**
     * Gives an answer the indentation of what it replaces, when the model
     * left it out: every line is moved right by what the least indented
     * line of the answer is short of the least indented line that was
     * selected. An answer that is indented as much or more stays.
     *
     * @param {String[]} original  the lines that were selected
     * @param {String[]} lines     the answer's
     * @param {String} [fallback]  the indentation at the selection's place
     *   when it has no line with text (an insertion on an empty line)
     */
    function reindent(original, lines, fallback) {
        var want = minIndent(original);
        if (want == null) want = fallback || "";
        var have = minIndent(lines);
        if (have == null || have.length >= want.length || want.indexOf(have) !== 0)
            return lines.slice();
        var add = want.slice(have.length);
        return lines.map(function(line) {
            return /\S/.test(line) ? add + line : line;
        });
    }

    /**
     * The changes between two lists of lines, as the places in the new one:
     * [{ start, added, removed }]: `added` lines from index `start` of the
     * new lines stand where the lines `removed` (their texts) were.
     */
    function hunks(original, lines) {
        var changes = diff.lines(original.join("\n") + (original.length ? "\n" : ""),
            lines.join("\n") + (lines.length ? "\n" : ""));
        // (an empty line is a line: diff.lines takes "" for no lines at all)
        if (original.length && original.join("") === "" || lines.length && lines.join("") === "")
            changes = plainDiff(original, lines);
        var out = [];
        var index = 0;      // in the new lines
        var current = null;
        changes.forEach(function(change) {
            if (change.type == " ") {
                current = null;
                index++;
                return;
            }
            if (!current) {
                current = { start: index, added: 0, removed: [] };
                out.push(current);
            }
            if (change.type == "+") {
                current.added++;
                index++;
            }
            else {
                current.removed.push(change.text);
            }
        });
        return out;
    }

    // lists of only empty lines: nothing to align
    function plainDiff(original, lines) {
        var out = [];
        var same = Math.min(original.length, lines.length);
        var i;
        for (i = 0; i < same && original[i] === lines[i]; i++)
            out.push({ type: " ", text: original[i] });
        for (var j = i; j < original.length; j++) out.push({ type: "-", text: original[j] });
        for (j = i; j < lines.length; j++) out.push({ type: "+", text: lines[j] });
        return out;
    }

    /**
     * The rows an edit is about, for a selection of the editor: whole
     * lines. A selection that ends at the start of a line does not take
     * that line; without a selection it is the cursor's line when that is
     * empty, and else the place after it (an insertion: `end` is `start -
     * 1`).
     *
     * @param {Object} range   { start: { row, column }, end: { row, column } }
     * @param {Function} line  (row) the text of a row
     * @return {Object} { start, end } (rows, `end` inclusive)
     */
    function rows(range, line) {
        var start = range.start.row, end = range.end.row;
        var empty = start == end && range.start.column == range.end.column;
        if (empty)
            return /\S/.test(line(start)) ? { start: start + 1, end: start } : { start: start, end: start };
        if (end > start && range.end.column === 0)
            end--;
        return { start: start, end: end };
    }

    module.exports = {
        clean: clean,
        toLines: toLines,
        reindent: reindent,
        hunks: hunks,
        rows: rows
    };
});

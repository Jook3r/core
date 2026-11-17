#!/usr/bin/env node
/*global describe it before after beforeEach afterEach */
"use strict";
"use server";

require("c9/inline-mocha")(module);
require("amd-loader");

var assert = require("assert");
var util = require("./inline-edit-util");

describe(__filename, function() {
    describe("clean", function() {
        it("takes an answer as it is", function() {
            assert.deepEqual(util.clean("    return a + b;\n"), { text: "    return a + b;\n" });
        });

        it("takes the code out of a fence, with or without words around it", function() {
            assert.deepEqual(util.clean("```js\nconst a = 1;\nconst b = 2;\n```"), { text: "const a = 1;\nconst b = 2;" });
            assert.deepEqual(util.clean("```\n    x\n```\n"), { text: "    x" });
            assert.deepEqual(util.clean("Here is the code:\n\n```python\nprint(1)\n```\n\nIt prints 1."), { text: "print(1)" });
        });

        it("leaves fences that are part of the code", function() {
            var markdown = "Run:\n\n```\nnpm test\n```\n\nand then:\n\n```\nnpm start\n```\n";
            assert.deepEqual(util.clean(markdown), { text: markdown });
            assert.deepEqual(util.clean("var s = '```';\n"), { text: "var s = '```';\n" });
        });

        it("knows a note from code", function() {
            assert.deepEqual(util.clean("NOTE: which of the two functions?"), { note: "which of the two functions?" });
            assert.deepEqual(util.clean("\n NOTE:\n"), { note: "No change was proposed" });
            assert.deepEqual(util.clean("// NOTE: keep this\n"), { text: "// NOTE: keep this\n" });
        });

        it("makes line ends the same", function() {
            assert.deepEqual(util.clean("a\r\nb\r\n"), { text: "a\nb\n" });
        });
    });

    describe("toLines", function() {
        it("drops the empty lines at the end only", function() {
            assert.deepEqual(util.toLines("\n  a\n\n  b\n\n\n"), ["", "  a", "", "  b"]);
            assert.deepEqual(util.toLines("a"), ["a"]);
        });

        it("has no lines for an answer without text", function() {
            assert.deepEqual(util.toLines(""), []);
            assert.deepEqual(util.toLines(" \n\n"), []);
        });
    });

    describe("reindent", function() {
        it("moves an answer that lost its indentation", function() {
            assert.deepEqual(
                util.reindent(["        if (x) {", "            y();", "        }"], ["if (x && z) {", "    y();", "", "}"]),
                ["        if (x && z) {", "            y();", "", "        }"]);
        });

        it("adds only what is missing", function() {
            assert.deepEqual(util.reindent(["        a"], ["    b", "      c"]), ["        b", "          c"]);
        });

        it("leaves an answer that is indented as much or more", function() {
            assert.deepEqual(util.reindent(["    a"], ["    b", "        c"]), ["    b", "        c"]);
            assert.deepEqual(util.reindent(["    a"], ["        b"]), ["        b"]);
        });

        it("does not mix tabs and spaces", function() {
            assert.deepEqual(util.reindent(["\t\ta"], ["  b"]), ["  b"]);
            assert.deepEqual(util.reindent(["\t\ta"], ["\tb"]), ["\t\tb"]);
        });

        it("uses the indentation of the place for an insertion", function() {
            assert.deepEqual(util.reindent([""], ["a();", "b();"], "    "), ["    a();", "    b();"]);
            assert.deepEqual(util.reindent([], ["a();"], ""), ["a();"]);
        });
    });

    describe("hunks", function() {
        it("finds changed, added and removed lines", function() {
            var original = ["function add(a, b) {", "    return a+b", "}", "", "var x = 1;", "var y = 2;"];
            var lines = ["function add(a, b) {", "    // the sum", "    return a + b;", "}", "", "var y = 2;", "var z = 3;"];
            assert.deepEqual(util.hunks(original, lines), [
                { start: 1, added: 2, removed: ["    return a+b"] },
                { start: 5, added: 0, removed: ["var x = 1;"] },
                { start: 6, added: 1, removed: [] }
            ]);
        });

        it("has none for the same lines", function() {
            assert.deepEqual(util.hunks(["a", "b"], ["a", "b"]), []);
            assert.deepEqual(util.hunks([], []), []);
        });

        it("takes an insertion and a deletion as one change", function() {
            assert.deepEqual(util.hunks([], ["a", "b"]), [{ start: 0, added: 2, removed: [] }]);
            assert.deepEqual(util.hunks(["a", "b"], []), [{ start: 0, added: 0, removed: ["a", "b"] }]);
        });

        it("counts empty lines as lines", function() {
            assert.deepEqual(util.hunks([""], ["a"]), [{ start: 0, added: 1, removed: [""] }]);
            assert.deepEqual(util.hunks(["a", ""], ["a"]), [{ start: 1, added: 0, removed: [""] }]);
            assert.deepEqual(util.hunks([""], ["", ""]), [{ start: 1, added: 1, removed: [] }]);
        });
    });

    describe("rows", function() {
        var text = ["function f() {", "    return 1;", "", "}"];
        var line = function(row) { return text[row]; };
        function range(r1, c1, r2, c2) {
            return { start: { row: r1, column: c1 }, end: { row: r2, column: c2 } };
        }

        it("takes whole lines for a selection", function() {
            assert.deepEqual(util.rows(range(0, 3, 1, 5), line), { start: 0, end: 1 });
            assert.deepEqual(util.rows(range(1, 4, 1, 10), line), { start: 1, end: 1 });
        });

        it("leaves out a line the selection only reaches the start of", function() {
            assert.deepEqual(util.rows(range(0, 0, 2, 0), line), { start: 0, end: 1 });
        });

        it("takes the cursor's line when it is empty, and else the place after it", function() {
            assert.deepEqual(util.rows(range(2, 0, 2, 0), line), { start: 2, end: 2 });
            assert.deepEqual(util.rows(range(1, 6, 1, 6), line), { start: 2, end: 1 });
        });
    });
});

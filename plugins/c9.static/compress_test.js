#!/usr/bin/env node
/*global describe it */
"use strict";
"use server";

require("c9/inline-mocha")(module);

var assert = require("assert");
var compress = require("architect-build/compress");

describe(__filename, function() {
    function minify(source) {
        return compress([{ source: source, file: "test.js" }], {}).code;
    }
    // what the minified code leaves in `exports` when it runs
    function run(source) {
        var exports = {};
        new Function("define", minify(source))(function(fn) { fn(null, exports, {}); });
        return exports;
    }

    it("minifies", function() {
        var code = minify("define(function(require, exports, module) {\n    // a comment\n    var longName = 1 + 1;\n    exports.value = longName;\n});");
        assert(!/a comment/.test(code), code);
        assert(code.length < 80, code);
        assert.equal(run("define(function(require, exports, module) { exports.value = 1 + 1; });").value, 2);
    });

    it("takes the JavaScript of today, and leaves it that", function(done) {
        var exports = run([
            "define(function(require, exports, module) {",
            "    const add = (a, b = 1) => a + b;",
            "    class Counter { #count = 0; static start = 5; next() { return ++this.#count; } }",
            "    const { x, ...rest } = { x: 1, y: 2, z: 3 };",
            "    exports.sum = add(2);",
            "    exports.text = `${x}:${Object.keys(rest).join()}`;",
            "    exports.count = new Counter().next() + Counter.start;",
            "    exports.missing = ({}).a?.b ?? 'none';",
            "    exports.later = async function() { return await Promise.resolve([...'ab'].length); };",
            "    exports.big = 2n ** 64n;",
            "});"
        ].join("\n"));
        assert.equal(exports.sum, 3);
        assert.equal(exports.text, "1:y,z");
        assert.equal(exports.count, 6);
        assert.equal(exports.missing, "none");
        assert.equal(String(exports.big), "18446744073709551616");
        exports.later().then(function(length) {
            assert.equal(length, 2);
            done();
        }).catch(done);
    });

    it("keeps the parameters that the module loader reads", function() {
        // define()'s function is asked for its parameters (fn.length, fn.toString())
        var code = minify("define(function(require, exports, module) { exports.a = 1; });");
        assert(/function\(\w+,\w+,\w+\)/.test(code), code);
    });

    it("leaves code alone that says \"disable compress\"", function() {
        var source = "\"disable compress\";\nvar   spaced   =   1;";
        assert(minify(source).indexOf("var   spaced   =   1;") != -1);
    });

    it("says where a syntax error is", function() {
        var error = console.error, messages = [];
        console.error = function() { messages.push([].join.call(arguments, " ")); };
        try {
            assert.throws(function() { minify("var a = ;"); });
        } finally {
            console.error = error;
        }
        assert(/test\.js:1:/.test(messages.join("\n")), messages.join("\n"));
    });
});

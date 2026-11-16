#!/usr/bin/env node
/*global describe it */
"use strict";
"use server";

require("c9/inline-mocha")(module);
require("amd-loader");

var assert = require("assert");
var Terminal = require("./libterm");

describe(__filename, function() {
    function attributes(params, term) {
        term = term || new Terminal(80, 24, function() {});
        term.charAttributes(params);
        return {
            term: term,
            flags: Terminal.attrFlags(term.curAttr),
            fg: Terminal.color(Terminal.attrFg(term.curAttr)),
            bg: Terminal.color(Terminal.attrBg(term.curAttr)),
            fgIndex: Terminal.attrFg(term.curAttr),
            bgIndex: Terminal.attrBg(term.curAttr)
        };
    }

    it("starts with the default colors and no flags", function() {
        var a = attributes([]);
        assert.equal(a.flags, 0);
        assert.equal(a.fgIndex, 257);
        assert.equal(a.bgIndex, 256);
        assert.equal(a.term.curAttr, a.term.defAttr);
    });

    it("takes the 16 and the 256 colors", function() {
        var a = attributes([31, 42]);
        assert.equal(a.fgIndex, 1);
        assert.equal(a.bgIndex, 2);
        a = attributes([91, 107]);
        assert.equal(a.fgIndex, 9);
        assert.equal(a.bgIndex, 15);
        a = attributes([38, 5, 202, 48, 5, 17]);
        assert.equal(a.fgIndex, 202);
        assert.equal(a.bgIndex, 17);
    });

    it("takes 24-bit colors, for the foreground and the background", function() {
        var a = attributes([38, 2, 255, 100, 0]);
        assert.equal(a.fg, "rgb(255,100,0)");
        assert.equal(a.bgIndex, 256);
        a = attributes([48, 2, 0, 40, 200, 38, 2, 1, 2, 3]);
        assert.equal(a.bg, "rgb(0,40,200)");
        assert.equal(a.fg, "rgb(1,2,3)");
        // the same color is the same attribute
        assert.equal(attributes([38, 2, 255, 100, 0]).fgIndex, attributes([38, 2, 255, 100, 0]).fgIndex);
    });

    it("doesn't read a color's parameters as attributes", function() {
        // red 1 is not bold, green 4 not underlined, blue 7 not inverse, 0 no reset
        var a = attributes([3, 38, 2, 1, 4, 7, 48, 2, 0, 0, 0]);
        assert.equal(a.flags, Terminal.ITALIC);
        assert.equal(a.fg, "rgb(1,4,7)");
        assert.equal(a.bg, "rgb(0,0,0)");
        // the underline's color is not drawn, and changes nothing else
        a = attributes([58, 2, 1, 2, 3, 4]);
        assert.equal(a.flags, Terminal.UNDERLINE);
        assert.equal(a.fgIndex, 257);
        a = attributes([58, 5, 1, 9]);
        assert.equal(a.flags, Terminal.STRIKE);
    });

    it("sets and resets bold, italic, underlined and crossed out", function() {
        var a = attributes([1, 3, 4, 9]);
        assert.equal(a.flags, Terminal.BOLD | Terminal.ITALIC | Terminal.UNDERLINE | Terminal.STRIKE);
        a = attributes([23, 29], a.term);
        assert.equal(a.flags, Terminal.BOLD | Terminal.UNDERLINE);
        a = attributes([22, 24], a.term);
        assert.equal(a.flags, 0);
    });

    it("swaps the colors for inverse, also 24-bit ones, and back", function() {
        var a = attributes([38, 2, 10, 20, 30, 7]);
        assert.equal(a.flags, Terminal.INVERSE);
        assert.equal(a.bg, "rgb(10,20,30)");
        assert.equal(a.fgIndex, 256);
        a = attributes([27], a.term);
        assert.equal(a.flags, 0);
        assert.equal(a.fg, "rgb(10,20,30)");
        assert.equal(a.bgIndex, 256);
    });

    it("resets colors and everything", function() {
        var a = attributes([1, 38, 2, 1, 2, 3, 48, 5, 4, 39]);
        assert.equal(a.fgIndex, 257);
        assert.equal(a.bgIndex, 4);
        a = attributes([49], a.term);
        assert.equal(a.bgIndex, 256);
        a = attributes([0], a.term);
        assert.equal(a.term.curAttr, a.term.defAttr);
    });

    it("keeps flags, foreground and background apart in one number", function() {
        var attr = Terminal.attr(31, 131071, 131070);
        assert.equal(Terminal.attrFlags(attr), 31);
        assert.equal(Terminal.attrFg(attr), 131071);
        assert.equal(Terminal.attrBg(attr), 131070);
    });
});

// Generates ../ace.themes/code-server-{dark,light}.css from one rule table,
// so both variants stay structurally identical. Edit this file, not the CSS,
// then run:  node plugins/c9.ide.theme.codeserver/tools/gen-themes.js [outdir]
//
// Colours: VS Code "2026 Dark"/"2026 Light" (extensions/theme-defaults, MIT,
// Copyright (c) Microsoft Corporation) resolved through their include chains
// (2026 -> *_modern -> *_plus -> *_vs) the way VS Code matches TextMate scopes
// (the more specific scope wins); the resolved values are in the table below.
// The glyphs (fold chevrons, ellipsis, squiggle) are simple shapes drawn here.
const fs = require("fs"), path = require("path");
const OUT = process.argv[2] || path.join(__dirname, "../ace.themes");

// hex with alpha (#RRGGBBAA) -> rgba()
function c(hex) {
    const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
    if (!m || !m[2]) return hex;
    const n = parseInt(m[1], 16), a = parseInt(m[2], 16) / 255;
    return "rgba(" + [n >> 16, (n >> 8) & 255, n & 255].join(", ") + ", " + (Math.round(a * 1000) / 1000) + ")";
}
const svg = s => 'url("data:image/svg+xml,' + encodeURIComponent(s).replace(/%20/g, " ").replace(/%3D/g, "=").replace(/%3A/g, ":").replace(/%2F/g, "/").replace(/%2C/g, ",") + '")';
// fold chevrons: 1.25px strokes, the same shapes as the skin's glyphs (less/tokens.less)
const chevron = (d, col) => svg("<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'><path d='" + d +
    "' fill='none' stroke='" + col + "' stroke-width='1.25' stroke-linecap='round' stroke-linejoin='round'/></svg>");
const CHEVRON_DOWN = "M4.5 6.5L8 10l3.5-3.5";
const CHEVRON_RIGHT = "M6.5 4.5L10 8l-3.5 3.5";
const CHEVRON_UP = "M4.5 9.5L8 6l3.5 3.5";
// squiggly underline like VS Code's error/warning decorations, 6x3 tile
const squiggle = col => svg("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 6 3' height='3' width='6'><g fill='" + col + "'><polygon points='5.5,0 2.5,3 1.1,3 4.1,0'/><polygon points='4,0 6,2 6,0.6 5.4,0'/><polygon points='0,2 1,3 2.4,3 0,0.6'/></g></svg>");
const dots = col => svg("<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'><g fill='" + col + "'><circle cx='3.5' cy='8' r='1'/><circle cx='8' cy='8' r='1'/><circle cx='12.5' cy='8' r='1'/></g></svg>");

const V = {
    dark: {
        name: "code-server-dark", title: "Code Server Dark", src: "2026 Dark (2026-dark.json > dark_modern > dark_plus > dark_vs)",
        bg: "#121314", fg: "#BBBEBF",                       // editor.background / editor.foreground
        panelBg: "#191A1B",                                 // panel.background (Immediate window, like the debug console)
        gutterBg: "#121314",                                // editorGutter.background
        lineNumber: "#858889", lineNumberActive: "#BBBEBF", // editorLineNumber.(active)foreground
        cursor: "#BBBEBF",                                  // editorCursor.foreground
        selection: "#276782dd",                             // editor.selectionBackground
        inactiveSelection: "#27678260",                     // editor.inactiveSelectionBackground
        selectedWord: "#27678280",                          // editor.findMatchHighlightBackground (~selectionHighlight #27678260)
        activeLine: "#242526",                              // editor.lineHighlightBackground (no border: bg is opaque)
        bracketBg: "#3994BC55", bracketBorder: "#2A2B2C",   // editorBracketMatch.background/border
        indentGuide: "#8384854D",                           // editorIndentGuide.background1
        invisible: "#8C8C8C4D",                             // editorWhitespace.foreground
        printMargin: "#2A2B2C",                             // rulers are off in VS Code; surface.border tone
        foldWidget: "#8C8C8C", foldWidgetHover: "#BFBFBF",  // icon.foreground / foreground
        hoverBg: "#FFFFFF14",                               // list.hoverBackground (fold widget hover)
        foldBg: "#27678233",                                // editor.foldBackground default (selection * .3)
        foldPlaceholder: "#808080",                         // editor.foldPlaceholderForeground
        step: "#ffff0033", stack: "#7abd7a4d",              // editor.(focused)stackFrameHighlightBackground
        error: "#F14C4C", warning: "#CCA700", info: "#59a4f9", // editorError/Warning/Info.foreground
        occurrence: "#27678250", occurrenceMain: "#27678280",  // editor.wordHighlight(Strong)Background
        // immediate window (VS Code debug console / debugTokenExpression.*)
        repl: { text: "#bfbfbf", error: "#f48771", warn: "#CCA700", name: "#c586c0", value: "#cccccc99",
            string: "#ce9178", number: "#b5cea8", bool: "#4e94ce", source: "#bfbfbf", border: "#2A2B2C" },
        t: {
            comment: "#8B949E",          // comment
            docTag: "#FF7B72",           // storage.type.class.jsdoc
            keyword: "#C586C0",          // keyword.control (dark_plus): import/if/return/for/def...
            operator: "#D4D4D4",         // keyword.operator (dark_vs)
            storage: "#FF7B72",          // storage, storage.type (2026)
            modifier: "#569CD6",         // storage.modifier (dark_vs)
            constant: "#79C0FF",         // constant (2026)
            numeric: "#B5CEA8",          // constant.numeric (dark_vs)
            language: "#569CD6",         // constant.language (dark_vs)
            character: "#FF7B72",        // constant.character (2026), HTML entities
            escape: "#D7BA7D",           // constant.character.escape (dark_plus)
            string: "#A5D6FF",           // string (2026)
            attrValue: "#A5D6FF",        // string.quoted.double.html -> string (2026)
            regexpOp: "#79C0FF",         // string.regexp constant.other.character-class.escape -> constant
            supportFunction: "#DCDCAA",  // support.function (dark_plus)
            supportClass: "#4EC9B0",     // support.class / entity.name.type (dark_plus)
            supportType: "#9CDCFE",      // support.type.property-name (dark_vs): Ace's CSS property token
            supportConstant: "#CE9178",  // support.constant.property-value (dark_plus): Ace's CSS value token
            supportVariable: "#79C0FF",  // support.variable (2026)
            variable: "#7EE787",         // support.type.property-name.json (2026): Ace's JSON key token
            variableLanguage: "#79C0FF", // variable.language (2026): this/self
            parameter: "#FFA657",        // variable (2026): JS parameters
            func: "#D2A8FF",             // entity.name.function (2026)
            tag: "#7EE787",              // entity.name.tag (2026)
            tagPunct: "#808080",         // punctuation.definition.tag (dark_vs)
            attr: "#9CDCFE",             // entity.other.attribute-name (dark_vs)
            templatePunct: "#569CD6",    // punctuation.definition.template-expression (dark_vs)
            invalid: "#FFA198",          // invalid.illegal/deprecated (2026), italic
            heading: "#79C0FF",          // markup.heading (2026), bold
            listBullet: "#FFA657",       // punctuation.definition.list.begin.markdown (2026)
            quote: "#7EE787",            // markup.quote (2026)
            emphasis: "#C9D1D9",         // markup.italic / markup.bold (2026)
            inserted: "#7EE787", deleted: "#FFA198", changed: "#FFA657" // markup.*
        }
    },
    light: {
        name: "code-server-light", title: "Code Server Light", src: "2026 Light (2026-light.json > light_modern > light_plus > light_vs)",
        bg: "#FFFFFF", fg: "#202020",
        panelBg: "#FAFAFD",
        gutterBg: "#FFFFFF",
        lineNumber: "#606060", lineNumberActive: "#202020",
        cursor: "#202020",
        selection: "#0069CC40",
        inactiveSelection: "#0069CC1A",
        selectedWord: "#0069CC1A",                          // editor.findMatchHighlightBackground (~selectionHighlight #0069CC15)
        activeLine: "#EAEAEA40",
        bracketBg: "#0069CC40", bracketBorder: "#F0F1F2",
        indentGuide: "#EEEEEE",                             // editorIndentGuide.activeBackground1 (background1 #F7F7F740 is invisible)
        invisible: "#60606040",
        printMargin: "#EEEEEE",
        foldWidget: "#606060", foldWidgetHover: "#202020",
        hoverBg: "#00000014",
        foldBg: "#0069CC13",
        foldPlaceholder: "#808080",
        step: "#ffff6673", stack: "#cee7ce73",
        error: "#E51400", warning: "#BF8803", info: "#0063d3",
        occurrence: "#0069CC26", occurrenceMain: "#0069CC26",
        repl: { text: "#202020", error: "#ad0707", warn: "#BF8803", name: "#9b46b0", value: "#6c6c6ccc",
            string: "#a31515", number: "#098658", bool: "#0000ff", source: "#202020", border: "#F0F1F2" },
        t: {
            comment: "#6E7781",
            docTag: "#CF222E",
            keyword: "#AF00DB",
            operator: "#000000",
            storage: "#CF222E",
            modifier: "#0000FF",
            constant: "#0550AE",
            numeric: "#098658",
            language: "#0000FF",
            character: "#CF222E",
            escape: "#EE0000",
            string: "#0A3069",
            attrValue: "#0000FF",        // string.quoted.double.html (light_vs) beats 2026's string
            regexpOp: "#0550AE",
            supportFunction: "#795E26",
            supportClass: "#267F99",
            supportType: "#E50000",
            supportConstant: "#0451A5",
            supportVariable: "#0550AE",
            variable: "#116329",
            variableLanguage: "#0550AE",
            parameter: "#953800",
            func: "#8250DF",
            tag: "#116329",
            tagPunct: "#800000",
            attr: "#E50000",
            templatePunct: "#0000FF",
            invalid: "#82071E",
            heading: "#0550AE",
            listBullet: "#953800",
            quote: "#116329",
            emphasis: "#1F2328",
            inserted: "#116329", deleted: "#82071E", changed: "#953800"
        }
    }
};

function css(v) {
    const t = v.t, P = "." + "ace-" + v.name;
    const r = [];
    const rule = (sel, body, note) => {
        const sels = (Array.isArray(sel) ? sel : [sel]).map(s => s.replace(/&/g, P));
        r.push((note ? "/* " + note + " */\n" : "") + sels.join(",\n") + " {\n" +
            Object.entries(body).map(([k, val]) => "  " + k + ": " + val + ";").join("\n") + "\n}");
    };
    r.push("/*\n * " + v.title + " editor theme for Cloud9.\n * Colours from VS Code's " + v.src + ", MIT licensed.\n" +
        " * Ace token types are mapped to the TextMate scopes they stand for and resolved the\n" +
        " * way VS Code does (more specific scope wins). Where Ace uses one token type for\n" +
        " * several constructs, the colour of its most frequent use is taken (see notes).\n *\n" +
        " * Generated by plugins/c9.ide.theme.codeserver/tools/gen-themes.js: edit that\n" +
        " * file and run it instead of editing this one.\n */");

    /* ---- Editor surface ---- */
    rule("&", { "background-color": v.bg, color: v.fg });
    rule("& .ace_gutter", { background: v.gutterBg, color: v.lineNumber }, "Gutter: same colour as the editor, as in VS Code");
    rule("& .ace_gutter-active-line", { "background-color": "transparent", color: v.lineNumberActive },
        "VS Code (renderLineHighlight: line) only brightens the active line number");
    rule("& .ace_print-margin", { width: "1px", background: v.printMargin });
    rule("& .ace_cursor", { color: v.cursor });
    rule("& .ace_marker-layer .ace_selection", { background: c(v.selection) });
    rule("&:not(.ace_focus) .ace_marker-layer .ace_selection", { background: c(v.inactiveSelection) });
    rule("&.ace_multiselect .ace_selection.ace_start", { "box-shadow": "0 0 3px 0 " + v.bg });
    rule("& .ace_marker-layer .ace_step", { background: c(v.step) }, "Debugger: current and selected stack frame lines");
    rule("& .ace_marker-layer .ace_stack", { background: c(v.stack) });
    rule("& .ace_marker-layer .ace_bracket", { margin: "0", "box-sizing": "border-box",
        border: "1px solid " + v.bracketBorder, background: c(v.bracketBg) });
    rule("& .ace_marker-layer .ace_active-line", { background: c(v.activeLine) });
    rule("& .ace_marker-layer .ace_selected-word", { background: c(v.selectedWord), border: "0" },
        "Other occurrences of the selected word and search matches");
    rule("& .ace_invisible", { color: c(v.invisible) });
    rule("& .ace_indent-guide", { background: "linear-gradient(" + c(v.indentGuide) + ", " + c(v.indentGuide) + ") right / 1px 100% no-repeat" },
        "Solid 1px guides like VS Code's");

    /* ---- Folding ---- */
    rule("& .ace_gutter-cell > .ace_fold-widget", { "background-image": chevron(CHEVRON_DOWN, v.foldWidget),
        "background-size": "14px 14px", "background-position": "center", border: "1px solid transparent", "box-shadow": "none" },
        "Fold widgets: chevrons in icon.foreground");
    rule("& .ace_gutter-cell > .ace_fold-widget.ace_closed", { "background-image": chevron(CHEVRON_RIGHT, v.foldWidget) });
    rule("& .ace_gutter-cell > .ace_fold-widget.ace_end", { "background-image": chevron(CHEVRON_UP, v.foldWidget) });
    rule(["& .ace_gutter-cell > .ace_fold-widget:hover", "& .ace_gutter-cell > .ace_fold-widget:active"],
        { "background-color": c(v.hoverBg), border: "1px solid transparent", "box-shadow": "none" });
    rule("& .ace_gutter-cell > .ace_fold-widget.ace_invalid", { "background-color": "transparent", "border-color": v.error });
    rule("& .ace_line .ace_fold", { "background-color": c(v.foldBg), "background-image": dots(v.foldPlaceholder),
        "background-repeat": "no-repeat", "background-position": "center", "background-size": "16px 16px",
        border: "0", "border-radius": "3px" }, "Folded range placeholder: VS Code's ellipsis");
    rule("& .ace_line .ace_fold:hover", { "background-color": c(v.selection), "background-image": dots(v.fg) });

    /* ---- Diagnostics and occurrences (c9.ide.language.core markers) ---- */
    rule("&.ace_editor .language_highlight_error", { "border-bottom": "0", background: squiggle(v.error) + " repeat-x left bottom" },
        "Squiggly underlines in editorError/Warning/Info.foreground");
    rule("&.ace_editor .language_highlight_warning", { "border-bottom": "0", background: squiggle(v.warning) + " repeat-x left bottom" });
    rule("&.ace_editor .language_highlight_info", { "border-bottom": "1px dotted " + v.info });
    rule("&.ace_editor .language_highlight_occurrence_main", { border: "0", background: c(v.occurrenceMain) },
        "Occurrences of the symbol at the cursor: editor.wordHighlight(Strong)Background");
    rule("&.ace_editor .language_highlight_occurrence_other", { border: "0", background: c(v.occurrence) });

    /* ---- Tokens ---- */
    rule(["& .ace_comment", "& .ace_comment.ace_doc"], { color: t.comment, "font-style": "normal" });
    rule("& .ace_comment.ace_doc.ace_tag", { color: t.docTag }, "JSDoc @tags");
    rule("& .ace_keyword", { color: t.keyword },
        "Ace's one 'keyword' token covers import/if/return/for (keyword.control: most of them),\n   def/class (storage.type) and in/not/new/typeof (keyword.operator.*)");
    rule("& .ace_keyword.ace_operator", { color: t.operator });
    rule(["& .ace_storage", "& .ace_storage.ace_type"], { color: t.storage }, "const/let/var/function, =>");
    rule("& .ace_storage.ace_modifier", { color: t.modifier });
    rule(["& .ace_constant", "& .ace_constant.ace_other"], { color: t.constant });
    rule("& .ace_constant.ace_numeric", { color: t.numeric });
    rule(["& .ace_constant.ace_language", "& .ace_constant.ace_language.ace_boolean"], { color: t.language }, "True/None/null/false");
    rule("& .ace_constant.ace_character", { color: t.character });
    rule(["& .ace_constant.ace_language.ace_escape", "& .ace_constant.ace_character.ace_escape"], { color: t.escape },
        "String escapes; Ace's JS mode also uses this for regexp anchors/groups/quantifiers");
    rule("& .ace_constant.ace_language.ace_escape.ace_reference", { color: t.character }, "HTML entities (&amp;)");
    rule("& .ace_string", { color: t.string });
    rule("& .ace_string.ace_regexp", { color: t.string });
    rule("& .ace_regexp.ace_keyword.ace_operator", { color: t.regexpOp }, "\\d, \\w ... inside regexps");
    rule(["& .ace_support.ace_function", "& .ace_support.ace_function.ace_builtin"], { color: t.supportFunction },
        "Builtins: print/len/str, Math.min, echo/printf, url()/rgba()");
    rule(["& .ace_support.ace_class", "& .ace_entity.ace_name.ace_type", "& .ace_entity.ace_other.ace_inherited-class"], { color: t.supportClass });
    rule("& .ace_support.ace_type", { color: t.supportType }, "Ace's CSS/SCSS/LESS property names");
    rule(["& .ace_support.ace_constant", "& .ace_support.ace_constant.ace_fonts"], { color: t.supportConstant }, "Ace's CSS property values");
    rule("& .ace_support.ace_variable", { color: t.supportVariable });
    rule("& .ace_variable", { color: t.variable },
        "Ace's plain 'variable' is mostly JSON keys (also CSS class selectors, shell/PHP variables)");
    rule("& .ace_variable.ace_language", { color: t.variableLanguage }, "this/self/super, document");
    rule("& .ace_variable.ace_parameter", { color: t.parameter });
    rule(["& .ace_entity.ace_name.ace_function", "& .ace_support.ace_function.ace_dom"], { color: t.func });
    rule(["& .ace_entity.ace_name.ace_tag", "& .ace_meta.ace_tag"], { color: t.tag }, "HTML/XML tag names, YAML keys");
    rule(["& .ace_meta.ace_tag.ace_punctuation", "& .ace_xml-pe"], { color: t.tagPunct }, "< / > and <!DOCTYPE>");
    rule("& .ace_entity.ace_other.ace_attribute-name", { color: t.attr });
    rule("& .ace_string.ace_attribute-value", { color: t.attrValue });
    rule("& .ace_paren.ace_quasi", { color: t.templatePunct }, "${ } in template strings");
    rule(["& .ace_invalid", "& .ace_invalid.ace_illegal", "& .ace_invalid.ace_deprecated"],
        { color: t.invalid, "background-color": "transparent", "font-style": "italic" });

    /* ---- Markup (Markdown and friends) ---- */
    rule(["& .ace_heading", "& .ace_markup.ace_heading"], { color: t.heading, "font-weight": "bold" });
    rule("& .ace_markup.ace_list", { color: t.listBullet }, "List bullets (the item text keeps the foreground)");
    rule(["& .ace_string.ace_blockquote", "& .ace_markup.ace_quote"], { color: t.quote });
    rule(["& .ace_string.ace_emphasis", "& .ace_markup.ace_italic"], { color: t.emphasis, "font-style": "italic" });
    rule(["& .ace_string.ace_strong", "& .ace_markup.ace_bold"], { color: t.emphasis, "font-weight": "bold" });
    rule("& .ace_markup.ace_underline", { "text-decoration": "underline" });
    rule("& .ace_markup.ace_inserted", { color: t.inserted });
    rule("& .ace_markup.ace_deleted", { color: t.deleted });
    rule("& .ace_markup.ace_changed", { color: t.changed });

    /* ---- Immediate window (an Ace editor in this theme): VS Code debug console colours ---- */
    const R = v.repl, I = ".immediate " + P + ".ace_editor";
    const im = (sels, body, note) => rule(sels.map(s => I + " " + s), body, note);
    rule([I, I + " .ace_gutter"], { "background-color": v.panelBg },
        "Immediate window: on the panel background, like VS Code's debug console (panel.background)");
    rule(".session_page.immediate:has(> " + P + ")", { "background-color": v.panelBg + " !important" },
        "...and so is its page around the editor (ace.js paints it inline with the editor colour)");
    im([".log", ".return"], { color: R.text, "border-color": R.border }, "Immediate window: debugConsole.* and debugTokenExpression.*");
    im([".error", ".warn"], { "border-color": R.border });
    im([".ace_lineWidgetContainer > div:first-child"], { "border-top-color": R.border });
    im([".warning"], { color: R.warn });
    im([".error", ".err", ".stack"], { color: R.error });
    im([".stack a"], { color: R.source });
    im([".property"], { color: R.name });
    im([".null"], { color: c(R.value) });
    im([".string", ".regexp"], { color: R.string });
    im([".number"], { color: R.number });
    im([".boolean"], { color: R.bool });
    im([".ace_gutter-cell.repl_prompt:after"], { color: R.text });
    return r.join("\n\n") + "\n";
}

for (const k of ["dark", "light"]) {
    const v = V[k];
    const file = path.join(OUT, v.name + ".css");
    fs.writeFileSync(file, css(v));
    console.log("wrote", file);
}

// Generates ../ace.themes/slate-{dark,light}.css from one rule table, so
// both variants stay structurally identical. Edit this file, not the CSS,
// then run:  node plugins/c9.ide.theme.slate/tools/gen-themes.js [outdir]
//
// The colours are the Slate palette's (less/palette-*.less); the table of
// rules maps Ace's token types to them. The glyphs (fold chevrons, ellipsis,
// squiggle) are simple shapes drawn here.
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
        name: "slate-dark", title: "Slate Dark",
        bg: "#1A1D23", fg: "#C5CAD3",                       // the card colour and the text colour of the skin
        panelBg: "#1A1D23",                                 // Immediate window
        gutterBg: "#1A1D23",
        lineNumber: "#5B6270", lineNumberActive: "#C5CAD3",
        cursor: "#C5CAD3",
        selection: "#4C82F04D",
        inactiveSelection: "#4C82F02B",
        selectedWord: "#4C82F033",
        activeLine: "#20242B",
        bracketBg: "#4C82F040", bracketBorder: "#3A4150",
        indentGuide: "#2A2F39",
        invisible: "#3A4150",
        printMargin: "#262A33",
        foldWidget: "#808897", foldWidgetHover: "#C5CAD3",
        hoverBg: "#FFFFFF12",
        foldBg: "#4C82F01F",
        foldPlaceholder: "#808897",
        step: "#DCB46C33", stack: "#8FC78A2E",
        error: "#E0707C", warning: "#DCB46C", info: "#6C9EF8",
        occurrence: "#FFFFFF14", occurrenceMain: "#FFFFFF24",
        repl: { text: "#C5CAD3", error: "#F08C96", warn: "#DCB46C", name: "#B890F0", value: "#808897",
            string: "#8FC78A", number: "#E39A6A", bool: "#E39A6A", source: "#C5CAD3", border: "#262A33" },
        // nine hues, the ones of the file icons and the terminal:
        // purple for what structures (keywords), blue for what is called,
        // green for text, orange for values, yellow for types, teal for
        // what is special inside text, red for names of data and markup
        t: {
            comment: "#6B7382",
            docTag: "#B890F0",
            keyword: "#B890F0",
            operator: "#9AA3B2",
            storage: "#B890F0",
            modifier: "#B890F0",
            constant: "#E39A6A",
            numeric: "#E39A6A",
            language: "#E39A6A",
            character: "#5FC0C8",
            escape: "#5FC0C8",
            string: "#8FC78A",
            attrValue: "#8FC78A",
            regexpOp: "#5FC0C8",
            supportFunction: "#6C9EF8",
            supportClass: "#DCB46C",
            supportType: "#5FC0C8",      // Ace's CSS property token
            supportConstant: "#E39A6A",  // Ace's CSS value token
            supportVariable: "#E0707C",
            variable: "#E0707C",         // Ace's JSON key token
            variableLanguage: "#E0707C", // this/self
            parameter: "#E5B089",
            func: "#6C9EF8",
            tag: "#E0707C",
            tagPunct: "#6B7382",
            attr: "#DCB46C",
            templatePunct: "#B890F0",
            invalid: "#F08C96",
            heading: "#6C9EF8",
            listBullet: "#E39A6A",
            quote: "#8FC78A",
            emphasis: "#EEF0F4",
            inserted: "#8FC78A", deleted: "#E0707C", changed: "#DCB46C"
        }
    },
    light: {
        name: "slate-light", title: "Slate Light",
        bg: "#FFFFFF", fg: "#2A2E36",
        panelBg: "#FFFFFF",
        gutterBg: "#FFFFFF",
        lineNumber: "#9AA1AC", lineNumberActive: "#2A2E36",
        cursor: "#2A2E36",
        selection: "#2F6FDE33",
        inactiveSelection: "#2F6FDE1A",
        selectedWord: "#2F6FDE1F",
        activeLine: "#F4F6F9",
        bracketBg: "#2F6FDE2E", bracketBorder: "#C5CAD3",
        indentGuide: "#E9ECF1",
        invisible: "#C5CAD3",
        printMargin: "#E9ECF1",
        foldWidget: "#6A7280", foldWidgetHover: "#2A2E36",
        hoverBg: "#141E3212",
        foldBg: "#2F6FDE14",
        foldPlaceholder: "#8A919C",
        step: "#F5D76E66", stack: "#BFE5C573",
        error: "#C93A48", warning: "#A66D00", info: "#2F6FDE",
        occurrence: "#141E3214", occurrenceMain: "#141E3224",
        repl: { text: "#2A2E36", error: "#C93A48", warn: "#A66D00", name: "#8A4FD0", value: "#6A7280",
            string: "#23783A", number: "#B5561F", bool: "#B5561F", source: "#2A2E36", border: "#E9ECF1" },
        t: {
            comment: "#8A919C",
            docTag: "#8A4FD0",
            keyword: "#8A4FD0",
            operator: "#5A6270",
            storage: "#8A4FD0",
            modifier: "#8A4FD0",
            constant: "#B5561F",
            numeric: "#B5561F",
            language: "#B5561F",
            character: "#1787A0",
            escape: "#1787A0",
            string: "#23783A",
            attrValue: "#23783A",
            regexpOp: "#1787A0",
            supportFunction: "#2F6FDE",
            supportClass: "#9A6500",
            supportType: "#1787A0",
            supportConstant: "#B5561F",
            supportVariable: "#C93A48",
            variable: "#C93A48",
            variableLanguage: "#C93A48",
            parameter: "#A6532A",
            func: "#2F6FDE",
            tag: "#C93A48",
            tagPunct: "#8A919C",
            attr: "#9A6500",
            templatePunct: "#8A4FD0",
            invalid: "#C93A48",
            heading: "#2F6FDE",
            listBullet: "#B5561F",
            quote: "#23783A",
            emphasis: "#111418",
            inserted: "#23783A", deleted: "#C93A48", changed: "#A66D00"
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
    r.push("/*\n * " + v.title + " editor theme for Cloud9: the colours of the " + v.title + " skin.\n" +
        " * Where Ace uses one token type for several constructs, the colour of its most\n" +
        " * frequent use is taken (see notes).\n *\n" +
        " * Generated by plugins/c9.ide.theme.slate/tools/gen-themes.js: edit that\n" +
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

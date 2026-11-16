/**
 * Claude chat panel: the agent panel (c9.ide.agent/panel.js) with the user's
 * Claude login. Claude Code runs as in a terminal: the default account is
 * the user's own ~/.claude, the models are those the CLI reports, and what
 * an answer cost is what the CLI says.
 */
define(function(require, exports, module) {
    "use strict";

    var createPanel = require("../c9.ide.agent/panel");

    var PROVIDER = {
        id: "claude",
        name: "Claude",
        // in "No ... sessions yet", the welcome title, "... reports a billing problem"
        product: "Claude Code",

        // the panel's place among the panels, and its items in the menus
        index: 40,
        menu: { ask: 910, fix: 920, terminal: 2000, tree: 1025 },
        prefsPosition: 950,
        icon: "spark",

        // the default account is Claude Code's own
        accountName: "Personal",
        accountDir: ".claude",

        // user/claude/@model, @effort and @mode
        defaults: [
            ["model", "default"],
            ["effort", ""],
            ["mode", ""]
        ],
        // "Auto" effort
        autoEffort: "Claude's settings decide",
        maxEffortNote: "Max may use many tokens and respond slowly",
        maxEffortDesc: "May use many tokens and respond slowly",
        // a tab starts with the effort last chosen, but not above High
        capEffort: true,

        // what the CLI says when it is not logged in, or can't bill
        loginRe: /\/login\b|not logged in|invalid api key|authentication_error|oauth token|please run .{0,20}login/i,
        billingRe: /credit balance|billing|payment required|insufficient credit/i,
        installHelp: "Install Claude Code with `curl -fsSL https://claude.ai/install.sh | bash` "
            + "or `npm install -g @anthropic-ai/claude-code`, then log in once: Preferences › User Settings › "
            + "Claude › Log in… (or run `claude` in a new terminal)."
    };

    main.consumes = createPanel.consumes;
    main.provides = ["claude"];
    return main;

    function main(options, imports, register) {
        createPanel(PROVIDER, options, imports, register);
    }
});

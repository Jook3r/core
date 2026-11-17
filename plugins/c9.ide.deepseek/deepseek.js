/**
 * DeepSeek chat panel: the agent panel (c9.ide.agent/panel.js) on DeepSeek's
 * Anthropic-compatible API. Claude Code runs with the account's DeepSeek API
 * key, which stays on the server, in account folders of its own (never the
 * user's Claude login).
 *
 * The models, their prices and DeepSeek's peak hours are user settings
 * (Preferences > DeepSeek); the panel prices each answer from its tokens and
 * shows whether it is peak time now.
 */
define(function(require, exports, module) {
    "use strict";

    var createPanel = require("../c9.ide.agent/panel");

    // The models (Preferences > DeepSeek > Models): DeepSeek's prices in USD
    // per 1M tokens at peak hours (cache hit, cache miss, output); off-peak
    // they cost peak.offPeakPercent of that. "[1m]" tells the CLI the model
    // has a 1M-token context.
    var MODELS = [
        { id: "deepseek-flash[1m]", name: "DeepSeek Flash", images: true, hit: 0.006, miss: 0.3, output: 1.2 },
        { id: "deepseek-v4-pro[1m]", name: "DeepSeek V4 Pro", images: false, hit: 0.044, miss: 1.32, output: 3.96 }
    ];
    // sub-agents and background tasks (titles, summaries)
    var FAST_MODEL = "deepseek-flash[1m]";
    // DeepSeek's peak hours (UTC), and its dates without them (Chinese
    // public holidays, in China time) as a user setting
    var PEAK = { hours: "01:00-04:00, 06:00-10:00", days: "Mon-Fri", noPeak: "", offPeakPercent: 50 };
    var SEARCH_PRICE = 0.75;        // USD per 1000 web searches (a setting)

    var PROVIDER = {
        id: "deepseek",
        name: "DeepSeek",
        product: "DeepSeek",
        // an API key of DeepSeek's in place of the Claude login
        keyed: true,
        // configured models with prices, and peak hours
        priced: true,

        // after the Claude panel, and after its items in the menus
        index: 45,
        menu: { ask: 930, fix: 940, terminal: 2010, tree: 1026 },
        prefsPosition: 960,
        icon: "whale",

        // the default account: a folder of its own
        accountName: "Default",
        accountDir: ".claude-deepseek",

        models: MODELS,
        fastModel: FAST_MODEL,
        // inline edits
        editModel: FAST_MODEL,
        peak: PEAK,
        searchPrice: SEARCH_PRICE,

        // user/deepseek/@...: effort Max, as DeepSeek recommends for Claude Code
        defaults: [
            ["model", MODELS[0].id],
            ["effort", "max"],
            ["mode", ""],
            ["fastModel", FAST_MODEL],
            ["peakHours", PEAK.hours],
            ["peakDays", PEAK.days],
            ["noPeakDates", PEAK.noPeak],
            ["offPeakPercent", String(PEAK.offPeakPercent)],
            ["searchPrice", String(SEARCH_PRICE)],
            ["peakNotices", "true"]
        ],
        autoEffort: "the CLI's default",
        maxEffortNote: "Max is DeepSeek's recommendation for coding",
        maxEffortDesc: "DeepSeek's recommendation for coding",

        loginRe: /authentication|invalid api key|api key.{0,40}(invalid|incorrect)|\b401\b|no deepseek api key/i,
        billingRe: /insufficient balance|\b402\b|payment required|billing/i,
        installHelp: "Install Claude Code with `curl -fsSL https://claude.ai/install.sh | bash` "
            + "or `npm install -g @anthropic-ai/claude-code`. The panel only runs it: DeepSeek answers, "
            + "with your DeepSeek API key; no Claude login is needed."
    };

    main.consumes = createPanel.consumes;
    main.provides = ["deepseek"];
    return main;

    function main(options, imports, register) {
        createPanel(PROVIDER, options, imports, register);
    }
});

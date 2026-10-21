/**
 * code-server Dark: Cloud9 editor theme with the colours of VS Code's
 * "2026 Dark" theme (MIT). Default editor theme of the code-server-dark skin
 * (plugins/c9.ide.theme.codeserver/plugin.js); see code-server-dark.css.
 */
define(function(require, exports, module) {

exports.isDark = true;
exports.cssClass = "ace-code-server-dark";
exports.cssText = require("text!./code-server-dark.css");

var dom = require("ace/lib/dom");
dom.importCssString(exports.cssText, exports.cssClass);
});

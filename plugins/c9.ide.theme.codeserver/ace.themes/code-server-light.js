/**
 * code-server Light: Cloud9 editor theme with the colours of VS Code's
 * "2026 Light" theme (MIT). Default editor theme of the code-server-light skin
 * (plugins/c9.ide.theme.codeserver/plugin.js); see code-server-light.css.
 */
define(function(require, exports, module) {

exports.isDark = false;
exports.cssClass = "ace-code-server-light";
exports.cssText = require("text!./code-server-light.css");

var dom = require("ace/lib/dom");
dom.importCssString(exports.cssText, exports.cssClass);
});

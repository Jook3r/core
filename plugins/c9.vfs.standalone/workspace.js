"use strict";

/**
 * Which folder the browser may open as the workspace, and whether its
 * settings are trusted.
 *
 * A folder's own .c9/project.settings and .c9/state.settings can run commands
 * on the server (a code formatter, the linter's options, a restored Run tab),
 * so they are applied only for a folder the user chose:
 *
 * - The configured workspace (the one the server was started with, -w) is the
 *   operator's own, so it is trusted and its settings apply as before.
 * - Any other folder, opened with ?w=, is trusted only once the user has
 *   approved it (the approved folders are kept in the user's own settings,
 *   ~/.c9/user.settings, not in the workspace). Until then its project and
 *   state settings are left out.
 *
 * And ?w= may only choose the configured workspace or a folder inside it or
 * inside the home folder, so a link can't point the server at any path on the
 * disk (/etc, another user's home, ...). The paths compared here are real
 * paths (symlinks resolved by the caller), so a link inside the workspace
 * can't reach outside it either.
 */

// Is `child` the same folder as `parent`, or inside it? Both absolute, with
// symlinks resolved and no trailing slash (as fs.realpath returns them).
function isInside(child, parent) {
    if (!child || !parent) return false;
    if (child === parent) return true;
    return child.lastIndexOf(parent.replace(/\/+$/, "") + "/", 0) === 0;
}

// The folder a ?w= request may open, given the real paths of the request, the
// configured workspace and the home folder. A request outside the allowed
// folders falls back to the configured workspace.
function resolveWorkspace(requestedReal, configuredReal, homeReal) {
    if (!requestedReal || requestedReal === configuredReal)
        return configuredReal;
    if (isInside(requestedReal, configuredReal) || isInside(requestedReal, homeReal))
        return requestedReal;
    return configuredReal;
}

// Whether a folder's own settings may be applied without asking: the
// configured workspace, or one the user has approved (approved holds real
// paths).
function isTrusted(workspaceReal, configuredReal, approved) {
    return workspaceReal === configuredReal
        || (Array.isArray(approved) && approved.indexOf(workspaceReal) !== -1);
}

// The approved folders in a user.settings file (its text), or [] if there are
// none or it can't be read. Stored at user/workspaceTrust/@folders as a JSON
// array of real paths.
function trustedFolders(userSettings) {
    try {
        var user = typeof userSettings == "string" ? JSON.parse(userSettings) : userSettings;
        var raw = user && user.workspaceTrust && user.workspaceTrust["@folders"];
        var list = typeof raw == "string" ? JSON.parse(raw) : raw;
        return Array.isArray(list) ? list.filter(function(p) { return typeof p == "string"; }) : [];
    } catch (e) {
        return [];
    }
}

module.exports = {
    isInside: isInside,
    resolveWorkspace: resolveWorkspace,
    isTrusted: isTrusted,
    trustedFolders: trustedFolders
};

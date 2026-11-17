// Generates ../less/icons.less: every icon of the Slate skins, as SVG masks
// painted in a colour of the palette. Edit the tables below, not the LESS,
// then run:
//
//     npm install --prefix /tmp/slate-icons lucide-static simple-icons
//     node plugins/c9.ide.theme.slate/tools/gen-icons.js /tmp/slate-icons
//
// The two packages are only read here; they are not dependencies of Cloud9.
//  - Lucide (https://lucide.dev, ISC): the line icons of the interface and
//    of the generic file types.
//  - Simple Icons (https://simpleicons.org, CC0-1.0): the marks of languages
//    and tools, for their file types.
const fs = require("fs"), path = require("path");
const SRC = path.resolve(process.argv[2] || "/tmp/slate-icons", "node_modules");
const OUT = path.join(__dirname, "../less/icons.less");

const STROKE = 1.75; // of a 24px drawing: 1.17px at 16px

function lucide(name, stroke) {
    const svg = fs.readFileSync(path.join(SRC, "lucide-static/icons", name + ".svg"), "utf8");
    const body = svg.replace(/<!--[\s\S]*?-->/g, "").replace(/<svg[\s\S]*?>/, "").replace(/<\/svg>/, "")
        .replace(/\s*\n\s*/g, " ").replace(/\s+\/>/g, "/>").replace(/>\s+</g, "><").trim();
    return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='"
        + (stroke || STROKE) + "' stroke-linecap='round' stroke-linejoin='round'>" + body.replace(/"/g, "'") + "</svg>";
}
function brand(slug) {
    const svg = fs.readFileSync(path.join(SRC, "simple-icons/icons", slug + ".svg"), "utf8");
    const d = /<path d="([^"]+)"/.exec(svg)[1];
    return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='" + d + "'/></svg>";
}
function url(svg) {
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg)
        .replace(/%20/g, " ").replace(/%3D/g, "=").replace(/%3A/g, ":").replace(/%2F/g, "/")
        .replace(/%2C/g, ",").replace(/%27/g, "'") + '")';
}

// ---- the interface: @sl-icon-<name> (the ones tokens.less draws by hand
// ---- are replaced: this file comes after it in the build)
const UI = {
    "close": "x", "plus": "plus", "check": "check", "list": "menu",
    "chevron-down": "chevron-down", "chevron-right": "chevron-right", "chevron-up": "chevron-up",
    "json": "braces", "gear": "settings", "maximize": "maximize-2", "restore": "minimize-2",
    "search": "search", "play": "play", "eye": "eye", "folder": "folder", "file": "file",
    "panel-workspace": "files", "panel-navigate": "search", "panel-commands": "command",
    "panel-changes": "git-branch", "panel-outline": "list-tree", "panel-debugger": "bug",
    "panel-collab": "users", "panel-test": "flask-conical"
};

// ---- file types: class of the icon (the file's extension, or the name of a
// ---- file without one, see getIconClass in c9.ide.theme.jett/plugin.js)
// ---- -> [source, icon, colour of the palette]
const L = "lucide", B = "brand";
const FILES = [
    // languages
    [["py", "pyw", "pyi", "pyx"], B, "python", "blue"],
    [["ipynb"], B, "jupyter", "orange"],
    [["js", "mjs", "cjs", "ejs", "sjs"], B, "javascript", "yellow"],
    [["jsx"], B, "react", "teal"],
    [["ts", "mts", "cts"], B, "typescript", "blue"],
    [["tsx"], B, "react", "blue"],
    [["vue"], B, "vuedotjs", "green"],
    [["svelte"], B, "svelte", "orange"],
    [["html", "htm", "xhtml"], B, "html5", "orange"],
    [["css"], B, "css", "purple"],
    [["scss", "sass"], B, "sass", "pink"],
    [["less"], B, "less", "blue"],
    [["go", "mod", "sum"], B, "go", "teal"],
    [["rs"], B, "rust", "orange"],
    [["php", "php5", "inc"], B, "php", "purple"],
    [["rb", "ru", "erb", "gemspec"], B, "ruby", "red"],
    [["c", "h"], B, "c", "blue"],
    [["cpp", "cc", "cxx", "hpp", "hh", "hxx"], B, "cplusplus", "blue"],
    [["cs"], B, "dotnet", "purple"],
    [["java", "jar", "class"], B, "openjdk", "red"],
    [["kt", "kts"], B, "kotlin", "purple"],
    [["swift"], B, "swift", "orange"],
    [["lua"], B, "lua", "blue"],
    [["pl", "pm"], B, "perl", "teal"],
    [["scala"], B, "scala", "red"],
    [["hs"], B, "haskell", "purple"],
    [["clj", "cljs", "edn"], B, "clojure", "green"],
    [["ex", "exs"], B, "elixir", "purple"],
    [["erl"], B, "erlang", "red"],
    [["dart"], B, "dart", "teal"],
    [["r"], B, "r", "blue"],
    [["jl"], B, "julia", "purple"],
    [["zig"], B, "zig", "orange"],
    [["coffee"], B, "coffeescript", "orange"],
    [["groovy", "gradle"], B, "gradle", "teal"],
    [["tf", "tfvars"], B, "terraform", "purple"],
    [["graphql", "gql"], B, "graphql", "pink"],
    [["tex", "bib"], B, "latex", "teal"],
    [["sol"], B, "solidity", "muted"],
    // data and configuration
    [["json", "jsonc", "json5", "map"], L, "braces", "yellow"],
    [["yaml", "yml"], B, "yaml", "red"],
    [["toml"], B, "toml", "orange"],
    [["xml", "xsl", "xsd", "plist", "cfm", "rhtml", "smarty", "jsp", "twig"], L, "code-xml", "orange"],
    [["md", "markdown", "mdx", "rst"], B, "markdown", "muted"],
    [["sql", "sqlserver", "pgsql", "mysql", "sqlite", "db"], L, "database", "pink"],
    [["csv", "tsv", "xls", "xlsx"], L, "table", "green"],
    [["ini", "cfg", "conf", "properties", "editorconfig", "settings"], L, "settings-2", "muted"],
    [["env"], L, "key-round", "yellow"],
    [["lock"], L, "lock", "muted"],
    // tools
    [["dockerfile", "dockerignore"], B, "docker", "blue"],
    [["npm", "npmrc", "npmignore"], B, "npm", "red"],
    [["gitignore", "gitattributes", "gitmodules", "gitkeep"], B, "git", "orange"],
    [["composer"], B, "composer", "muted"],
    [["bower"], B, "bower", "orange"],
    [["gulp"], B, "gulp", "red"],
    [["grunt"], B, "grunt", "orange"],
    [["makefile", "mk", "cmake"], L, "hammer", "muted"],
    [["sh", "bash", "zsh", "fish", "bat", "cmd", "ps1"], L, "square-terminal", "green"],
    [["vim", "vimrc"], B, "vim", "green"],
    [["nginx"], B, "nginx", "green"],
    // documents and media
    [["txt", "log", "text"], L, "file-text", "muted"],
    [["pdf"], L, "file-type", "red"],
    [["png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "avif"], L, "image", "purple"],
    [["svg"], L, "pen-tool", "orange"],
    [["mp3", "wav", "ogg", "flac"], L, "music", "pink"],
    [["mp4", "mov", "webm", "mkv", "avi"], L, "film", "pink"],
    [["zip", "tar", "gz", "tgz", "bz2", "xz", "rar"], L, "package", "yellow"],
    [["eot", "ttf", "otf", "woff", "woff2"], L, "type", "muted"],
    [["license", "licence"], L, "scale", "yellow"],
    [["run"], L, "play", "green"],
    // tabs that are not files
    [["preferences"], L, "settings", "muted"],
    [["searchresults"], L, "search", "muted"],
    [["terminal"], L, "square-terminal", "muted"]
];

let out = `/*
 * Slate skins: the icons. GENERATED by tools/gen-icons.js: edit that file.
 *
 * Every icon is an SVG drawn as a mask and painted with a colour, so an icon
 * takes the colour of the text around it, or one of the palette's
 * (@sl-fi-*, in palette-dark.less and palette-light.less), and stays sharp
 * at any zoom. No icon font and no bitmap is loaded.
 *
 * The line icons are Lucide's (ISC); the marks of languages and tools are
 * from Simple Icons (CC0-1.0). See ../NOTICE.
 */

/* ---- Interface ----------------------------------------------------------- */

`;
Object.keys(UI).forEach(name => {
    out += "@sl-icon-" + name + ": " + url(lucide(UI[name])) + ";\n";
});
out += "@sl-icon-check: " + url(lucide("check", 2.25)) + ";\n";
// drawn here: filled shapes for Run and Stop
const filled = body => "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='black' stroke='black' stroke-width='2' stroke-linejoin='round'>" + body + "</svg>";
out += "@sl-icon-run: " + url(filled("<path d='M8 5.5l10.5 6.5L8 18.5z'/>")) + ";\n";
out += "@sl-icon-stop: " + url(filled("<rect x='6.5' y='6.5' width='11' height='11' rx='1.5'/>")) + ";\n";

out += `
/* ---- File types ---------------------------------------------------------- */

/* The icon is the :before of a .filetree-icon (tree rows, tabs, Navigate):
   a 16px box with the generic file, replaced per type below. */
.filetree-icon {
    background-image: none !important;
    width: 16px;
    height: 16px;
    font-size: 16px;
    line-height: 18px !important;
}
.filetree-icon:before {
    content: "";
    display: inline-block;
    width: 16px;
    height: 16px;
    background-color: @sl-fi-muted;
    -webkit-mask: @sl-icon-file center / 16px 16px no-repeat;
    mask: @sl-icon-file center / 16px 16px no-repeat;
}
.filetree-icon.folder:before {
    -webkit-mask-image: @sl-icon-folder;
    mask-image: @sl-icon-folder;
}
`;
FILES.forEach(([classes, source, icon, colour]) => {
    const image = url(source == B ? brand(icon) : lucide(icon));
    // the marks are filled shapes: drawn a little smaller than the line icons
    const size = source == B ? "\n    mask-size: 14px 14px;" : "";
    out += classes.map(c => ".filetree-icon." + c + ":before").join(",\n") + " {\n"
        + "    background-color: @sl-fi-" + colour + ";\n"
        + "    mask-image: " + image + ";" + size + "\n}\n";
});

fs.writeFileSync(OUT, out);
console.log(OUT + ": " + Object.keys(UI).length + " interface icons, "
    + FILES.reduce((n, f) => n + f[0].length, 0) + " file types, " + (out.length >> 10) + " KB");

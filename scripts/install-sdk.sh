#!/bin/bash -e
#
# Sets up a Cloud9 checkout to run with `node server.js`.
#
# Requirements (Ubuntu 24.04 / 26.04):
#   - Node.js 16 or newer (24 LTS recommended), from nodejs.org or NodeSource
#   - sudo apt-get install -y git tmux python3 python3-venv build-essential
#     (build-essential and python3 are needed to compile node-pty,
#     python3-venv for the Python linter, completion and formatter)
#
# Run it again after pulling new changes.

set -e
has() {
  type "$1" > /dev/null 2>&1
}

cd "$(dirname "$0")/.."

red=$'\e[01;31m'
green=$'\e[01;32m'
yellow=$'\e[01;33m'
magenta=$'\e[01;35m'
resetColor=$'\e[0m'

checkDeps() {
    local missing=
    has git || missing="$missing git"
    has tmux || missing="$missing tmux"
    has python3 || missing="$missing python3"
    # "python3 -m venv" (Python support) needs ensurepip, which Ubuntu ships separately
    ! has python3 || python3 -c "import ensurepip" 2>/dev/null || missing="$missing python3-venv"
    has make || missing="$missing build-essential"
    has g++ || [[ $missing == *build-essential* ]] || missing="$missing build-essential"
    if [ "$missing" ]; then
        echo "${red}Missing system packages:$missing${resetColor}" >&2
        echo "Install them with:" >&2
        echo "  sudo apt-get install -y$missing" >&2
        exit 1
    fi

    if ! has node || ! has npm; then
        echo "${red}Node.js is not installed.${resetColor} Install Node.js 24 LTS from https://nodejs.org" >&2
        exit 1
    fi
    local major=$(node -p 'process.versions.node.split(".")[0]')
    # 16: the npm of older versions can't build node-pty with Python 3.11+
    if [ "$major" -lt 16 ]; then
        echo "${red}Node.js $(node -v) is too old.${resetColor} Cloud9 needs Node.js 16 or newer (24 LTS recommended)." >&2
        exit 1
    fi
    if [ "$major" -lt 22 ]; then
        echo "${yellow}Node.js $(node -v) no longer gets security fixes; 24 LTS is recommended.${resetColor}" >&2
    fi
}

updateNodeModules() {
    echo "${magenta}--- Running npm install --------------------------------------------${resetColor}"
    # npm applies the "overrides" of package.json only to what it installs,
    # not to what an earlier install left: set the packages they are for
    # aside (also where another package has its own copy) for npm to
    # install them again, and put them back if npm fails
    local aside=build/npm-aside name dir i=0
    rm -rf "$aside"
    mkdir -p "$aside"
    for name in $(node -p 'Object.keys(require("./package.json").overrides || {}).join(" ")'); do
        for dir in $(find node_modules -mindepth 1 -type d -path "*node_modules/$name" -prune 2>/dev/null); do
            i=$((i + 1))
            mkdir "$aside/$i"
            echo "$dir" > "$aside/$i/path"
            mv "$dir" "$aside/$i/package"
        done
    done
    if ! npm install --omit=dev --no-audit --no-fund; then
        for dir in "$aside"/*/; do
            [ -f "$dir/path" ] && [ ! -e "$(cat "$dir/path")" ] && mv "$dir/package" "$(cat "$dir/path")"
        done
        rm -rf "$aside"
        echo "${red}npm install failed; node_modules is as it was.${resetColor}" >&2
        exit 1
    fi
    rm -rf "$aside"

    # npm deletes the modules that are vendored in git (they are not in
    # package.json), so check them out again
    if [ -e .git ]; then
        for i in $(git ls-tree --name-only HEAD node_modules/); do
            [ -d "$i" ] || git checkout HEAD -- "$i"
        done
    else
        echo "${yellow}Not a git checkout: can't restore the vendored modules in node_modules${resetColor}" >&2
        exit 1
    fi
    rm -f package-lock.json

    if ! node -e 'require("node-pty")' 2>/dev/null; then
        echo "${red}node-pty failed to build; the terminal won't work.${resetColor}" >&2
        echo "Make sure build-essential and python3 are installed and run this script again." >&2
        exit 1
    fi
    echo "${magenta}--------------------------------------------------------------------${resetColor}"
}

checkDeps

updateNodeModules

echo -e "nak\n.gitignore" >  node_modules/.gitignore

# Python support: pylint, jedi and ruff in ~/.c9/python3 (the IDE would
# otherwise install them the first time a .py file is opened), and the
# debugger used by the "Python 3" runner
setupPython() {
    echo "${magenta}--- Setting up Python support ---------------------------------------${resetColor}"
    if ! bash plugins/c9.ide.language.python/server/launch_command.sh python3 true; then
        echo "${red}Could not set up Python support (linting, completion, formatting).${resetColor}" >&2
        exit 1
    fi
    mkdir -p ~/.c9/ikp3db
    ln -sf "$PWD/plugins/c9.ide.run.debug.ikpdb/python/ikp3db.py" ~/.c9/ikp3db/ikp3db.py
}
setupPython

# prebuild the packed and minified client for `server.js --packed` (fewer
# requests, smaller downloads, less RAM); rerun after changing client code
echo "${magenta}--- Building the packed client ----------------------------------------${resetColor}"
# (it starts from scratch: until here the previous build keeps working)
./scripts/makestandalone.sh --compress > /dev/null

echo "${green}Success!${resetColor} Start Cloud9 with:"
echo "  C9_AUTH=user:password node server.js -p 8181 -l 127.0.0.1 --packed -w ~/workspace"

# the places the panels look for it besides the PATH (the usual ones)
if ! has claude && [ ! -x ~/.local/bin/claude ] && [ ! -x ~/.claude/local/claude ]; then
    echo
    echo "${yellow}The Claude and DeepSeek panels need Claude Code, which is not installed.${resetColor} Install it with:"
    echo "  curl -fsSL https://claude.ai/install.sh | bash"
fi

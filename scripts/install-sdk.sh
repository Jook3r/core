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
    # The modules that are in git (they are not in package.json) would be
    # deleted by npm: they wait aside, as they are, until it is done
    local aside=build/npm-aside name vendored
    if [ -e .git ]; then
        vendored=$(git ls-tree --name-only HEAD node_modules/ | sed 's|^node_modules/||')
    else
        vendored="amd-loader architect c9 connect-architect frontdoor kaefer msgpack-js smith treehugger"
    fi
    restoreVendored() {
        for name in $vendored; do
            if [ -e "$aside/$name" ]; then
                rm -rf "node_modules/$name"
                mv "$aside/$name" "node_modules/$name"
            fi
        done
        rmdir "$aside" 2>/dev/null || true
    }
    # (an install that was interrupted left them there)
    restoreVendored
    mkdir -p "$aside"
    for name in $vendored; do
        [ -e "node_modules/$name" ] && mv "node_modules/$name" "$aside/$name"
    done
    local lockBefore=$(cksum < package-lock.json)
    # package-lock.json has the version and the checksum of every package:
    # npm installs those, and replaces what an earlier install left
    if ! npm install --omit=dev --no-audit --no-fund; then
        restoreVendored
        echo "${red}npm install failed.${resetColor}" >&2
        exit 1
    fi
    restoreVendored
    for name in $vendored; do
        if [ ! -e "node_modules/$name" ]; then
            echo "${red}node_modules/$name is missing: restore it from git (git checkout HEAD -- node_modules/$name)${resetColor}" >&2
            exit 1
        fi
    done
    if [ "$lockBefore" != "$(cksum < package-lock.json)" ]; then
        echo "${yellow}npm changed package-lock.json: it did not match package.json${resetColor}" >&2
    fi

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
# debuggers used by the Python runners
setupPython() {
    echo "${magenta}--- Setting up Python support ---------------------------------------${resetColor}"
    if ! bash plugins/c9.ide.language.python/server/launch_command.sh python3 true; then
        echo "${red}Could not set up Python support (linting, completion, formatting).${resetColor}" >&2
        exit 1
    fi
    mkdir -p ~/.c9/ikp3db
    ln -sf "$PWD/plugins/c9.ide.run.debug.ikpdb/python/ikp3db.py" ~/.c9/ikp3db/ikp3db.py
    # debugpy, in a folder of its own: the "Python 3" runner debugs with
    # the python3 of the project, which need not have it
    if ! ~/.c9/python3/bin/python -m pip install --quiet --upgrade --target ~/.c9/debugpy debugpy; then
        echo "${red}Could not install debugpy: the Python 3 runner will run but not debug.${resetColor}" >&2
    fi
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

#!/usr/bin/env bash
# Helper script to launch jedi/pylint/ruff in a python3 virtualenv
set -e

PYTHON=$1
COMMAND=$2

# Python 2 is not supported anymore; a stale "python2" setting uses python3
case $PYTHON in
    python3|python3.[0-9]*) ;;
    *) PYTHON=python3 ;;
esac

# Known-good versions (with their dependencies), installed on first use or
# up front by scripts/install-sdk.sh, which runs this script
PACKAGES="jedi==0.20.0 parso==0.8.7 pylint==4.1.2 astroid==4.3.3 dill==0.4.1 isort==9.0.2 mccabe==0.7.0 mypy-extensions==1.1.0 platformdirs==4.12.3 tomlkit==0.15.1 pylint-django==2.8.0 pylint-plugin-utils==0.9.0 ruff==0.16.10"

SHAREDENV="/mnt/shared/lib/$PYTHON"
FALLBACKENV="$HOME/.c9/$PYTHON"

# The env is current if it has these packages and still runs on the python
# it was made with (a distribution upgrade may replace it)
isCurrent() {
    [[ -x $ENV/bin/python && "$(<"$ENV/.c9-packages")" == "$(readlink -f "$ENV/bin/python") $PACKAGES" ]] 2>/dev/null
}

createEnv() {
    echo "Installing python support dependencies into $ENV" >&2
    rm -rf "$ENV"
    if ! command -v $PYTHON &>/dev/null; then
        echo "Python support fatal error: $PYTHON not installed" >&2
        echo "try 'sudo apt install python3 python3-venv'" >&2
        exit 1
    fi
    if ! $PYTHON -m venv "$ENV" >&2; then
        rm -rf "$ENV"
        echo "Python support fatal error: '$PYTHON -m venv' failed" >&2
        echo "try 'sudo apt install python3-venv'" >&2
        exit 1
    fi
    if ! "$ENV/bin/python" -m pip install --disable-pip-version-check --only-binary :all: $PACKAGES >&2; then
        echo "Python support fatal error: could not install $PACKAGES" >&2
        exit 1
    fi
    echo "$(readlink -f "$ENV/bin/python") $PACKAGES" > "$ENV/.c9-packages"
}

if [[ -d $SHAREDENV ]]; then
    ENV=$SHAREDENV
else
    ENV=$FALLBACKENV
    if ! isCurrent; then
        mkdir -p "$(dirname "$ENV")"
        # The linter and the completer may both get here on first use
        {
            ! command -v flock &>/dev/null || flock 9
            isCurrent || createEnv
        } 9>"$ENV.lock"
    fi
fi

source $ENV/bin/activate
PYTHON=$ENV/bin/python

COMMAND=${COMMAND/\$PYTHON/$PYTHON}
COMMAND=${COMMAND/\$ENV/$ENV}
# exec (so COMMAND must be a single command): killing this script, as the
# jedi daemon restart does, then stops python rather than orphaning it
eval "exec $COMMAND"

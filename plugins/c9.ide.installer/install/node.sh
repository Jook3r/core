set -e

has() {
  type "$1" > /dev/null 2>&1
  return $?
}

if has "wget"; then
    DOWNLOAD="wget --no-check-certificate -nc"
elif has "curl"; then
    DOWNLOAD="curl -sSOL"
else
    echo "Error: you need curl or wget to proceed" >&2;
    exit 1
fi

C9_DIR="$HOME/.c9"
NPM="$C9_DIR/node/bin/npm"
cd "$C9_DIR"

download_virtualenv() {
  VIRTUALENV_VERSION="virtualenv-12.0.7"
  $DOWNLOAD "https://pypi.python.org/packages/source/v/virtualenv/$VIRTUALENV_VERSION.tar.gz"
  tar xzf $VIRTUALENV_VERSION.tar.gz
  rm $VIRTUALENV_VERSION.tar.gz
  mv $VIRTUALENV_VERSION virtualenv
}

check_python() {
  if which python3 &> /dev/null; then
    PYTHON="python3"
  else
    echo "Python 3 is required. Please install python3 and try again."
    exit 100
  fi
}

configure_python() {
  check_python
  "$NPM" config -g set python "$PYTHON"
  "$NPM" config -g set unsafe-perm true
}

# use local npm cache
"$NPM" config -g set cache  "$C9_DIR/tmp/.npm"


PYTHON=python
configure_python


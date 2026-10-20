import argparse
import inspect
import jedi
import json
import sys
import os
import urllib.parse as urlparse
from http.server import BaseHTTPRequestHandler, HTTPServer

def main(args):
    if args.mode != "daemon":
        print(run(sys.stdin.read(), args.__dict__))
        return

    jedi.preload_module("os", "sys", "math")
    try:
        server = HTTPServer(("localhost", int(args.port)), Daemon)
    except:
        sys.stderr.write("Daemon unable to listen at :%s\n" % args.port)
        sys.exit(98)
    sys.stderr.write("Daemon " + "listening at :%s\n" % args.port) # concat strings to avoid matching this string in the client
    server.serve_forever()

def run(source, args):
    if isinstance(source, bytes):
        source = source.decode("utf8", "replace")
    mode = args.get("mode")
    row = int(args.get("row"))
    column = int(args.get("column"))
    # paths are relative to the workspace (our cwd) or start with ~
    path = args.get("path") and os.path.expanduser(args.get("path"))
    try:
        # jedi >= 0.18 takes the position in the methods, not in Script()
        script = jedi.Script(source, path=path)
        if mode == "completions":
            result = script.complete(row, column)
        elif mode == "goto_definitions":
            result = script.goto(row, column, follow_imports=True) or script.infer(row, column)
        else:
            result = script.goto(row, column)
    except Exception:
        result = []
    return json.dumps(result, default=to_json(mode, args.get("nodoc")))

class Daemon(BaseHTTPRequestHandler):
    def do_POST(self):
        query = urlparse.urlparse(self.path).query
        args = urlparse.parse_qsl(query)

        length = int(self.headers.get("content-length", 0))
        source = self.rfile.read(length)

        self.send_response(200)
        self.end_headers()
        self.wfile.write(run(source, dict(args)).encode("utf8"))

    def log_message(self, format, *args):
        return # log silently

STARS = {
    inspect.Parameter.VAR_POSITIONAL: "*",
    inspect.Parameter.VAR_KEYWORD: "**",
}

def to_json(mode, nodoc):
    include_pos = mode == "goto_definitions"
    def to_json(c):
        if c.type == "function":
            try:
                signatures = c.get_signatures()
                paramList = [STARS.get(p.kind, "") + p.name for p in signatures[0].params] if signatures else []
                params = ", ".join([p for p in paramList if p != "self"])
            except Exception:
                params = ""
        return remove_nulls({
            "name": c.name + ("(" + params + ")" if c.type == "function" else ""),
            "replaceText": c.name + "(^^)" if c.type == "function" else None,
            "row": c.line - 1 if c.line and include_pos else None, # jedi counts lines from 1
            "column": c.column if c.column and include_pos else None,
            "path": "/" + str(c.module_path) if c.module_path and include_pos else None,
            "doc": abbrev(c.docstring()) if c.type != "module" # module docs dont work
                                         and c.name[-2:] != "__" # skim on bandwidth
                                         and not nodoc
                                         else None,
            "icon": {
                "function": "method",
                "module": "package",
                "class": "property",
            }.get(c.type, None),
        })
    return to_json

def remove_nulls(d):
    # iterate over list copy to avoid size change in Python 3
    # http://stackoverflow.com/a/11941855/1797347
    for key, value in list(d.items()):
        if value is None:
            del d[key]
        elif isinstance(value, dict):
            remove_nulls(value)
    return d

def abbrev(s):
    return s if len(s) < 2500 else s[:2500] + "..."

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run jedi functions as a daemon or via stdin")
    parser.add_argument("mode", help="Mode of operation", choices=["daemon", "completions", "goto_definitions", "goto_assignments"])
    parser.add_argument("--row", type=int, help="The row to read from")
    parser.add_argument("--column", type=int, help="The column to read from")
    parser.add_argument("--path", help="The path of the script")
    parser.add_argument("--port", type=int, help="The port for the daemon to listen on")
    parser.add_argument("--nodoc", help="Don't include docstrings in output")
    args = parser.parse_args()
    main(args)

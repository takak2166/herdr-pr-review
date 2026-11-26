#!/bin/sh
# Claude Code reads a pull request ahead of the review (research.js writes the request):
#   research.sh <clone> <sha> <request-file> <json-schema> <model> <effort>
# Prints Claude Code's result as JSON (`claude -p --output-format json`; the findings are its
# `structured_output`). It runs in the head commit's files (tree.sh), with only the tools that
# read: Read, Grep, Glob. Nothing is written anywhere and no command runs. Exits 2 when `claude`
# isn't installed, 1 when the commit can't be taken out.
set -u
clone=$1 sha=$2 request=$3 schema=$4 model=$5 effort=$6
# Run from the app, PATH may lack where `claude` is: the person's login shell knows, so its PATH
# is borrowed then (as gopls-refs.sh does).
if ! command -v claude >/dev/null 2>&1; then
  login=$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | awk '{print $2}')
  case "$login" in
    (*fish) more=$("$login" -lc 'string join : $PATH' 2>/dev/null) ;;
    (?*) more=$("$login" -lc 'printf %s "$PATH"' 2>/dev/null) ;;
    (*) more="" ;;
  esac
  PATH="$PATH:$more:$HOME/.local/bin"
  export PATH
fi
command -v claude >/dev/null 2>&1 || exit 2
tree=$(sh "$(dirname "$0")/tree.sh" "$clone" "$sha") || exit 1
cd "$tree" || exit 1
exec claude -p --model "$model" --effort "$effort" --output-format json --json-schema "$schema" --tools Read,Grep,Glob --no-session-persistence < "$request"

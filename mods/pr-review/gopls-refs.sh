#!/bin/sh
# Where a Go name is used, as gopls (the Go language server) finds it: by type, not by spelling.
#   gopls-refs.sh <clone> <sha> <path> <line> <name>
# Prints one "<path>\t<line>\t<text>\t<how>" per use (the declaration itself left out), paths relative to
# the repository. Exits 2 when gopls isn't installed, 1 when it fails.
#
# The files are the pull request's head commit, taken out of the clone's git objects into a cache
# folder (~/Library/Caches/herdr-pr-review/trees/<sha>); the clone itself is only read. The five
# most recently used trees are kept. gopls runs as one server shared by every lookup
# (gopls serve on a socket in the cache folder), started the first time and kept running, so a
# lookup after the first is a few seconds instead of a full load.
set -u
clone=$1 sha=$2 path=$3 line=$4 name=$5
# Run from the app, PATH may lack where Go's tools are (~/go/bin, Go itself): the person's login
# shell knows, so its PATH is borrowed then. gopls needs both itself and `go`.
if ! command -v gopls >/dev/null 2>&1 || ! command -v go >/dev/null 2>&1; then
  login=$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | awk '{print $2}')
  case "$login" in
    (*fish) more=$("$login" -lc 'string join : $PATH' 2>/dev/null) ;;
    (?*) more=$("$login" -lc 'printf %s "$PATH"' 2>/dev/null) ;;
    (*) more="" ;;
  esac
  PATH="$PATH:$more:$HOME/go/bin:/usr/local/go/bin"
  export PATH
fi
command -v gopls >/dev/null 2>&1 || exit 2
cache="$HOME/Library/Caches/herdr-pr-review"
tree="$cache/trees/$sha"
sock="$cache/gopls.sock"
mkdir -p "$cache/trees"

if [ ! -f "$tree/.complete" ]; then
  rm -rf "$tree.part" && mkdir -p "$tree.part" || exit 1
  git -C "$clone" archive "$sha" | tar -x -C "$tree.part" || { rm -rf "$tree.part"; exit 1; }
  touch "$tree.part/.complete" && rm -rf "$tree" && mv "$tree.part" "$tree" || exit 1
fi
touch "$tree"
# Older trees go: each is a whole checkout.
ls -1t "$cache/trees" | grep -v '\.part$' | tail -n +6 | while read -r old; do rm -rf "$cache/trees/$old"; done

file="$tree/$path"
[ -f "$file" ] || exit 1
# The name's column on its line, in bytes from 1 as gopls counts. When that line doesn't have the
# name as a word (the mark was set elsewhere), its first line in the file that does.
at=$(LC_ALL=C awk -v want="$line" -v name="$name" '
  function col(s,   i, k, before, after) {
    k = 0
    while ((i = index(substr(s, k + 1), name)) > 0) {
      k += i
      before = (k > 1) ? substr(s, k - 1, 1) : ""
      after = substr(s, k + length(name), 1)
      if (before !~ /[A-Za-z0-9_]/ && after !~ /[A-Za-z0-9_]/) return k
    }
    return 0
  }
  NR == want { c = col($0); if (c) { print NR ":" c; found = 1; exit } }
  !first { c = col($0); if (c) first = NR ":" c }
  END { if (!found && first) print first }' "$file")
[ -n "$at" ] || exit 1

serve() { rm -f "$sock"; (nohup gopls serve -listen="unix;$sock" >/dev/null 2>&1 &); i=0; while [ ! -S "$sock" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done; }
[ -S "$sock" ] || serve
cd "$tree" || exit 1
out=$(gopls -remote="unix;$sock" references "$path:$at" 2>&1) || {
  # A socket left by a server that has stopped: start another and ask once more.
  serve
  out=$(gopls -remote="unix;$sock" references "$path:$at" 2>&1) || { printf '%s\n' "$out" | head -n 3 >&2; exit 1; }
}
# Prints gopls' answer as "<path>\t<line>\t<text>\t<how>" lines.
emit() {
  printf '%s\n' "$1" | sed -n "s|^$tree/||p" | while IFS=: read -r p l _; do
    [ -n "$p" ] || continue
    printf '%s\t%s\t%s\t%s\n' "$p" "$l" "$(sed -n "${l}p" "$tree/$p" | sed 's/^[[:space:]]*//' | cut -c1-160)" "$2"
  done
}
emit "$out" ""

# Across services. The services (pkg/<service>/) call one another through clients generated from
# proto (proto/gen/go/<service>/v1/*_grpc.pb.go), so a server method and its callers in other
# services are tied only by the RPC's name. When the name is an RPC of a service (`rpc <name>(` in
# proto/src/<service>/), the uses of that service's generated client method are added -- the calls
# from other services -- and so is the server's own method in pkg/<service>/adapter/ (where a call
# lands). Which service is where gopls says the name is defined: a generated client of
# proto/gen/go/<service>/ (a call to that service), or a method in pkg/<service>/ (that service's own
# handler); several services can have an RPC of the same name (a gateway and the service behind it).
# When gopls can't say, every service that has the RPC.
svcs=$(grep -rlE "^[[:space:]]*rpc[[:space:]]+$name[[:space:]]*\(" proto/src 2>/dev/null | sed -n 's|^proto/src/\([^/]*\)/.*|\1|p' | sort -u)
if [ -n "$svcs" ]; then
  def=$(gopls -remote="unix;$sock" definition "$path:$at" 2>/dev/null | head -n 1 | sed "s|^$tree/||")
  owner=$(printf '%s\n' "$def" | sed -n -e 's|^proto/gen/go/\([^/]*\)/.*|\1|p' -e 's|^pkg/\([^/]*\)/.*|\1|p' | head -n 1)
  if [ -n "$owner" ]; then svcs=$(printf '%s\n' "$svcs" | grep -x "$owner"); fi
fi
for svc in $svcs; do
  for gen in proto/gen/go/"$svc"/v*/*_grpc.pb.go; do
    [ -f "$gen" ] || continue
    # The client interface's method: `<name>(ctx context.Context, in *<Request>, opts ...grpc.CallOption)`.
    l=$(grep -nE "^[[:space:]]+$name\(ctx context\.Context, in \*" "$gen" | head -n 1 | cut -d: -f1)
    [ -n "$l" ] || continue
    c=$(sed -n "${l}p" "$gen" | LC_ALL=C awk -v n="$name" '{ print index($0, n) }')
    # The generated code's own uses (its mocks) are not calls from a service.
    more=$(gopls -remote="unix;$sock" references "$gen:$l:$c" 2>/dev/null) && emit "$(printf '%s\n' "$more" | grep -v "^$tree/proto/gen/")" "rpc $svc"
  done
  grep -nE "^func \([A-Za-z_]+ \*?Server\) $name\(" pkg/"$svc"/adapter/*.go 2>/dev/null | while IFS=: read -r p l _; do
    printf '%s\t%s\t%s\t%s\n' "$p" "$l" "$(sed -n "${l}p" "$p" | cut -c1-160)" "impl $svc"
  done
done

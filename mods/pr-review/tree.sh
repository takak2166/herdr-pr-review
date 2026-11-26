#!/bin/sh
# The pull request's head commit as plain files, for tools that read a folder (gopls, Claude Code):
#   tree.sh <clone> <sha>
# Prints the folder. The files are taken out of the clone's git objects into a cache folder
# (~/Library/Caches/herdr-pr-review/trees/<sha>); the clone itself is only read. The five most
# recently used trees are kept. Exits 1 when the commit can't be taken out.
set -u
clone=$1 sha=$2
cache="$HOME/Library/Caches/herdr-pr-review"
tree="$cache/trees/$sha"
mkdir -p "$cache/trees" || exit 1
if [ ! -f "$tree/.complete" ]; then
  rm -rf "$tree.part" && mkdir -p "$tree.part" || exit 1
  git -C "$clone" archive "$sha" | tar -x -C "$tree.part" || { rm -rf "$tree.part"; exit 1; }
  touch "$tree.part/.complete" && rm -rf "$tree" && mv "$tree.part" "$tree" || exit 1
fi
touch "$tree"
# Older trees go: each is a whole checkout.
ls -1t "$cache/trees" | grep -v '\.part$' | tail -n +6 | while read -r old; do rm -rf "$cache/trees/$old"; done
printf '%s\n' "$tree"

#!/usr/bin/env bash
# Shim — see README.md
command -v wt >/dev/null || { echo "wt not installed — see bin/worktree/README.md" >&2; exit 1; }
cd "$(wt path "$1")" && exec "${SHELL:-/bin/sh}"

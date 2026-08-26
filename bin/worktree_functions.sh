# Shim — see bin/worktree/README.md
if [[ -f "$HOME/.local/share/wt/worktree_functions.sh" ]]; then
    source "$HOME/.local/share/wt/worktree_functions.sh"
else
    echo "wt not installed — see bin/worktree/README.md" >&2
    return 1 2>/dev/null || exit 1
fi

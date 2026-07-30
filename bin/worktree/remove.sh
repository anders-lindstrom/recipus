#!/usr/bin/env bash
# Removes a git worktree. Deletes the branch only if fully merged into the main branch, otherwise keeps it.
# usage: ./bin/worktree/remove.sh work_name

set -euo pipefail

BASE_DIR=$(git rev-parse --show-toplevel)
source ${BASE_DIR}/bin/env_check_functions.sh || { echo "not right setup"; exit 1; }
source ${BASE_DIR}/bin/worktree_functions.sh || { echo "not right setup"; exit 1; }

# Load configuration with defaults
load_worktree_config

if [[ "$#" -lt 1 ]]; then
    echo "Usage: $0 work_name" >&2
    echo "Removes worktree and branch $WORKTREE_BRANCH_PREFIX/work_name" >&2
    exit 1
fi

# Validate work name
work="$1"
validate_work_name "$work" || exit 1

worktree_path=$(get_worktree_path "$work")
branch_name="$WORKTREE_BRANCH_PREFIX/$work"

# Verify we're in a git repository
verify_root_folder

# Check if worktree exists
if [[ ! -d "$worktree_path" ]]; then
    echo "Error: Worktree directory $worktree_path does not exist" >&2
    exit 1
fi

# Check if branch exists
if ! branch_exists "$branch_name"; then
    echo "Warning: Branch $branch_name does not exist, continuing with worktree removal" >&2
fi

# Check for submodules in the worktree
HAS_SUBMODULES=false
if [[ -f "$worktree_path/.gitmodules" ]]; then
    HAS_SUBMODULES=true
    echo "Note: Worktree contains submodules, using manual removal method"
fi

# Remove the worktree
echo "Removing worktree at $worktree_path"
if [[ "$HAS_SUBMODULES" == "true" ]]; then
    # Manual removal for worktrees with submodules
    echo "Performing manual removal due to submodules..."

    # Get the worktree git directory
    WORKTREE_GIT_DIR=$(cd "$worktree_path" 2>/dev/null && git rev-parse --git-dir 2>/dev/null || echo "")

    # Remove the worktree directory
    echo "Removing worktree directory..."
    rm -rf "$worktree_path"

    # Clean up git's worktree tracking
    echo "Cleaning up git worktree tracking..."
    git worktree prune

    echo "Worktree removed successfully using manual method"
else
    # Standard removal for worktrees without submodules
    if ! git worktree remove "$worktree_path"; then
        echo "Error: Failed to remove worktree. It may have uncommitted changes or be busy" >&2
        echo "Try: git worktree remove --force \"$worktree_path\"" >&2
        exit 1
    fi
fi

# Delete the associated branch only if it exists and is fully merged
if branch_exists "$branch_name"; then
    if branch_exists "$MAIN_BRANCH" && is_branch_merged "$branch_name" "$MAIN_BRANCH"; then
        echo "Branch is merged into $MAIN_BRANCH, deleting $branch_name..."
        git branch -d "$branch_name"
    else
        # Rename branch to strip the worktree prefix (e.g. feat_wt/xyz -> xyz)
        if git branch -m "$branch_name" "$work" 2>/dev/null; then
            echo "Kept and renamed branch: $branch_name -> $work (not yet merged into $MAIN_BRANCH)"
        else
            echo "Keeping branch $branch_name (not yet merged into $MAIN_BRANCH)"
        fi
        echo "  To delete later: git branch -d \"${work}\""
    fi
fi

echo "Successfully removed worktree"

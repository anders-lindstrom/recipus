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
    echo "Usage: $0 [type/]work_name" >&2
    echo "Removes the worktree named work_name and the branch checked out in it" >&2
    echo "A type may be given for symmetry with new.sh; it is ignored, because the" >&2
    echo "branch is read from the worktree rather than rebuilt from its name." >&2
    exit 1
fi

# Accept "type/work" so remove mirrors new, but derive nothing from the type:
# the directory has never carried it, and the branch is discovered below.
read -r _work_type work <<< "$(split_work_type "$1")"
validate_work_name "$work" || exit 1

worktree_path=$(get_worktree_path "$work")

# Verify we're in a git repository
verify_root_folder

# Check if worktree exists
if [[ ! -d "$worktree_path" ]]; then
    echo "Error: Worktree directory $worktree_path does not exist" >&2
    exit 1
fi

# Ask git which branch this worktree is on rather than rebuilding it from the
# work name. With one fixed prefix the two agreed; now that the type varies per
# worktree, reconstruction would name a branch that does not exist here — and
# the merged-branch deletion below would act on the wrong one. Fall back to the
# old construction only if git cannot answer.
branch_name="$(worktree_branch_at "$worktree_path" || true)"
if [[ -z "$branch_name" || "$branch_name" == "HEAD" ]]; then
    branch_name="$(worktree_branch_name "$WORKTREE_DEFAULT_TYPE" "$work")"
    echo "Warning: could not read the branch at $worktree_path; assuming $branch_name" >&2
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
        # Rename branch to strip the worktree prefix (e.g. fix_wt/xyz -> xyz)
        if git branch -m "$branch_name" "$work" 2>/dev/null; then
            echo "Kept and renamed branch: $branch_name -> $work (not yet merged into $MAIN_BRANCH)"
        else
            echo "Keeping branch $branch_name (not yet merged into $MAIN_BRANCH)"
        fi
        echo "  To delete later: git branch -d \"${work}\""
    fi
fi

echo "Successfully removed worktree"

#!/usr/bin/env bash
# Removes the current worktree and optionally its branch
# This script MUST be run from within a worktree (not the main repository)
# It will cd back to the main repository before removing the worktree
# usage: ./bin/worktree/remove_me.sh [--force]

set -euo pipefail

BASE_DIR=$(git rev-parse --show-toplevel)
source ${BASE_DIR}/bin/env_check_functions.sh || { echo "not right setup"; exit 1; }
source ${BASE_DIR}/bin/worktree_functions.sh || { echo "not right setup"; exit 1; }

# Load configuration with defaults
load_worktree_config || { echo "Failed to load worktree config" >&2; }

# Check if --force flag is provided
FORCE_REMOVE=false
if [[ "${1:-}" == "--force" ]]; then
    FORCE_REMOVE=true
fi

# CRITICAL: Check if we're in a worktree (not the main repository)
echo "Checking if we're in a worktree..."
if ! is_in_worktree; then
    echo "Error: You are in the main repository, not a worktree!" >&2
    echo "This script can only be run from within a worktree." >&2
    exit 1
fi
echo "✓ Confirmed: Running from a worktree"

# Get worktree information
echo "Getting worktree information..."
WORKTREE_PATH=$(pwd)
echo "  Worktree path: $WORKTREE_PATH"
WORKTREE_NAME=$(basename "$WORKTREE_PATH")
echo "  Worktree name: $WORKTREE_NAME"
echo "  Repo name: $REPO_NAME"

# Extract the work name from the worktree directory name
echo "Extracting work name..."
WORK_NAME=$(get_work_name_from_path "$WORKTREE_PATH" 2>/dev/null || echo "")
if [[ -z "$WORK_NAME" ]]; then
    echo "Error: Unable to determine work name from worktree path: $WORKTREE_NAME" >&2
    echo "Expected ${REPO_NAME}-<work_name> or ${REPO_NAME}_wt/<work_name>" >&2
    echo "Debug: WORKTREE_PATH=$WORKTREE_PATH, REPO_NAME=$REPO_NAME" >&2
    exit 1
fi
echo "  Work name: $WORK_NAME"

# Get the current branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo "========================================"
echo "Worktree Removal Summary:"
echo "  Worktree: $WORKTREE_PATH"
echo "  Branch: $CURRENT_BRANCH"
echo "  Work name: $WORK_NAME"
echo "========================================"

# Perform pre-removal checks
echo ""
echo "Running pre-removal checks..."

# Check for uncommitted changes
CHANGE_COUNT=$(count_uncommitted_changes)
if [[ "$CHANGE_COUNT" -gt 0 ]]; then
    echo "⚠️  Warning: You have $CHANGE_COUNT uncommitted changes"
    if [[ "$FORCE_REMOVE" != "true" ]]; then
        git status --short
        echo ""
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Aborted."
            exit 1
        fi
    fi
fi

# Check for untracked files
UNTRACKED_FILES=$(count_untracked_files)
if [[ "$UNTRACKED_FILES" -gt 0 ]]; then
    echo "⚠️  Warning: You have $UNTRACKED_FILES untracked files"
    if [[ "$FORCE_REMOVE" != "true" ]]; then
        git ls-files --others --exclude-standard | head -10
        if [[ "$UNTRACKED_FILES" -gt 10 ]]; then
            echo "... and $((UNTRACKED_FILES - 10)) more"
        fi
        echo ""
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Aborted."
            exit 1
        fi
    fi
fi

# Check for unpushed commits
if branch_exists "origin/$CURRENT_BRANCH"; then
    UNPUSHED_COUNT=$(count_unpushed_commits "$CURRENT_BRANCH")
    if [[ "$UNPUSHED_COUNT" -gt 0 ]]; then
        echo "⚠️  Warning: You have $UNPUSHED_COUNT unpushed commits"
        if [[ "$FORCE_REMOVE" != "true" ]]; then
            git log --oneline origin/"$CURRENT_BRANCH"..HEAD | head -5
            if [[ "$UNPUSHED_COUNT" -gt 5 ]]; then
                echo "... and $((UNPUSHED_COUNT - 5)) more"
            fi
            echo ""
            read -p "Continue anyway? (y/N) " -n 1 -r
            echo ""
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                echo "Aborted."
                exit 1
            fi
        fi
    fi
fi

# Check if branch is merged into main branch
if branch_exists "$MAIN_BRANCH"; then
    if ! is_branch_merged "$CURRENT_BRANCH" "$MAIN_BRANCH"; then
        echo "⚠️  Warning: Branch $CURRENT_BRANCH is not fully merged into $MAIN_BRANCH"
        if [[ "$FORCE_REMOVE" != "true" ]]; then
            echo ""
            read -p "Continue anyway? (y/N) " -n 1 -r
            echo ""
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                echo "Aborted."
                exit 1
            fi
        fi
    else
        echo "✓ Branch is fully merged into $MAIN_BRANCH"
    fi
fi

# Get the main repository path
MAIN_REPO_PATH=$(get_main_repo_path)

if [[ -z "$MAIN_REPO_PATH" ]]; then
    echo "Error: Unable to determine main repository path" >&2
    exit 1
fi

# Final confirmation
if [[ "$FORCE_REMOVE" != "true" ]]; then
    echo ""
    echo "========================================"
    echo "This will:"
    echo "  1. Change directory to: $MAIN_REPO_PATH"
    echo "  2. Remove worktree at: $WORKTREE_PATH"
    echo "  3. Delete branch: $CURRENT_BRANCH (if merged into $MAIN_BRANCH) or rename to $WORK_NAME"
    echo "========================================"
    echo ""
    read -p "Are you sure you want to remove this worktree? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 1
    fi
fi

echo ""
echo "Switching to main repository..."
cd "$MAIN_REPO_PATH"

echo "Current directory: $(pwd)"
echo ""

# Save the main repo path for the user
SAVED_MAIN_PATH="$MAIN_REPO_PATH"

# Check for submodules in the worktree
HAS_SUBMODULES=false
if [[ -f "$WORKTREE_PATH/.gitmodules" ]]; then
    HAS_SUBMODULES=true
    echo "Note: Worktree contains submodules, using manual removal method"
fi

# Remove the worktree
echo "Removing worktree at $WORKTREE_PATH..."
if [[ "$HAS_SUBMODULES" == "true" ]]; then
    # Manual removal for worktrees with submodules
    echo "Performing manual removal due to submodules..."

    # Remove the worktree directory
    echo "Removing worktree directory..."
    rm -rf "$WORKTREE_PATH"

    # Clean up git's worktree tracking
    echo "Cleaning up git worktree tracking..."
    git worktree prune

    echo "Worktree removed successfully using manual method"
else
    # Standard removal for worktrees without submodules.
    # FORCE_REMOVE holds the string "true"/"false", never an empty value, so
    # ${FORCE_REMOVE:+--force} expanded on both — passing --force unconditionally
    # and disabling git's refusal to remove a worktree with uncommitted changes.
    # That refusal is the backstop behind the "continue?" prompts above, so it
    # has to be an explicit test, the way the branch deletion below already does it.
    remove_args=()
    [[ "$FORCE_REMOVE" == "true" ]] && remove_args=(--force)
    if ! git worktree remove "$WORKTREE_PATH" "${remove_args[@]+"${remove_args[@]}"}"; then
        echo "Error: Failed to remove worktree" >&2
        echo "The worktree may have uncommitted changes or be busy" >&2
        echo "Try: git worktree remove --force \"$WORKTREE_PATH\"" >&2
        exit 1
    fi
fi

# Delete the branch only if it's a worktree branch AND fully merged (or --force)
if is_worktree_branch "$CURRENT_BRANCH"; then
    if [[ "$FORCE_REMOVE" == "true" ]]; then
        echo "Force deleting branch $CURRENT_BRANCH..."
        git branch -D "$CURRENT_BRANCH"
    elif branch_exists "$MAIN_BRANCH" && is_branch_merged "$CURRENT_BRANCH" "$MAIN_BRANCH"; then
        echo "Branch is merged into $MAIN_BRANCH, deleting $CURRENT_BRANCH..."
        git branch -d "$CURRENT_BRANCH"
    else
        # Rename branch to strip the worktree prefix (e.g. feat_wt/xyz -> xyz)
        if git branch -m "$CURRENT_BRANCH" "$WORK_NAME" 2>/dev/null; then
            echo "Kept and renamed branch: $CURRENT_BRANCH -> $WORK_NAME (not yet merged into $MAIN_BRANCH)"
        else
            echo "Keeping branch $CURRENT_BRANCH (not yet merged into $MAIN_BRANCH)"
        fi
        echo "  To delete later: git branch -d \"${WORK_NAME}\""
    fi
else
    echo "Keeping branch $CURRENT_BRANCH (not a worktree branch)"
fi

echo ""
echo "✓ Successfully removed worktree"
echo ""
echo "⚠️ Please go back to main folder with:"
echo "   cd $SAVED_MAIN_PATH"
echo ""

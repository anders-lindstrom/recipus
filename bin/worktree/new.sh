#!/usr/bin/env bash
# Creates a new git worktree with a new branch
# usage: ./bin/worktree/new.sh work_name [base_branch]
#
# work_name: Name for the worktree and new branch
# base_branch: Optional - branch to base the new branch on (defaults to development)

set -euo pipefail

BASE_DIR=$(git rev-parse --show-toplevel)
source ${BASE_DIR}/bin/env_check_functions.sh || { echo "not right setup"; exit 1; }
source ${BASE_DIR}/bin/worktree_functions.sh || { echo "not right setup"; exit 1; }

# Load configuration with defaults
load_worktree_config

if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
    echo "Usage: $0 work_name [base_branch]" >&2
    echo "Creates a new worktree with branch $WORKTREE_BRANCH_PREFIX/work_name based on base_branch" >&2
    echo "" >&2
    echo "Examples:" >&2
    echo "  $0 myfeature                    # Creates $WORKTREE_BRANCH_PREFIX/myfeature from $MAIN_BRANCH" >&2
    echo "  $0 myfeature main               # Creates $WORKTREE_BRANCH_PREFIX/myfeature from main" >&2
    echo "" >&2
    echo "To checkout existing branches, use: ./bin/worktree/checkout.sh" >&2
    exit 1
fi

# Validate work name
work="$1"
validate_work_name "$work" || exit 1

src_dir=$(pwd -P)
./bin/worktree/setup_precheck.sh "$src_dir" || exit 1

# Handle base branch parameter
base_branch="${2:-$MAIN_BRANCH}"
branch_name="$WORKTREE_BRANCH_PREFIX/$work"

worktree_path=$(get_worktree_path "$work")

# Verify we're in a git repository
verify_root_folder

# Check if worktree path already exists
if [[ -e "$worktree_path" ]]; then
    echo "Error: Directory $worktree_path already exists" >&2
    exit 1
fi

# Validate base branch exists
if ! branch_exists "$base_branch"; then
    echo "Error: Base branch $base_branch does not exist locally or on origin" >&2
    exit 1
fi

# Check if new branch already exists
if branch_exists "$branch_name"; then
    echo "Error: Branch $branch_name already exists" >&2
    exit 1
fi

# Create the worktree and branch
echo "Creating worktree at $worktree_path with new branch $branch_name based on $base_branch"
if ! git worktree add -b "$branch_name" "$worktree_path" "$base_branch"; then
    echo "Error: Failed to create worktree" >&2
    exit 1
fi

# Navigate to the new worktree (branch already created by worktree add)
if ! cd "$worktree_path"; then
    echo "Error: Failed to navigate to worktree directory" >&2
    exit 1
fi

echo "Successfully created worktree and branch at $worktree_path on branch $branch_name"

# Run setup script to configure AWS context and decrypt secrets
echo ""
echo "Running worktree setup..."
if ! ./bin/worktree/setup.sh "$src_dir"; then
    echo "Warning: Setup failed. You may need to run it manually later:" >&2
    echo "  ./bin/worktree/setup.sh $src_dir" >&2
    exit 1
fi

echo ""
echo "To navigate to your new worktree, run:"
echo "  cd $worktree_path"

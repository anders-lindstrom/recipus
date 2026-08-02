#!/usr/bin/env bash
# Creates a worktree for an existing branch (useful for PR reviews, hotfixes, etc.)
# usage:
#   ./bin/worktree/checkout.sh work_name existing_branch
#   ./bin/worktree/checkout.sh existing_branch              # 1-arg mode: work_name derived from branch

set -euo pipefail

BASE_DIR=$(git rev-parse --show-toplevel)
source ${BASE_DIR}/bin/env_check_functions.sh || { echo "not right setup"; exit 1; }
source ${BASE_DIR}/bin/worktree_functions.sh || { echo "not right setup"; exit 1; }

# Load configuration with defaults
load_worktree_config

print_usage() {
    echo "Usage:" >&2
    echo "  $0 work_name existing_branch" >&2
    echo "  $0 existing_branch                  # work_name derived from branch" >&2
    echo "" >&2
    echo "Creates a worktree checking out an existing branch" >&2
    echo "" >&2
    echo "Examples:" >&2
    echo "  $0 review-pr feature/pr-123        # Review a PR branch" >&2
    echo "  $0 hotfix hotfix/critical-bug      # Work on a hotfix" >&2
    echo "  $0 main-work main                  # Work on main branch" >&2
    echo "  $0 feature/pr-123                  # 1-arg: work_name becomes 'feature-pr-123'" >&2
    echo "  $0 feat_wt/accounts_and_metrics    # Strips 'feat_wt/' prefix automatically" >&2
}

if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
    print_usage
    exit 1
fi

src_dir=$(pwd -P)

./bin/worktree/setup_precheck.sh "$src_dir" || exit 1


# Determine work name and branch
if [[ "$#" -eq 2 ]]; then
    work="$1"
    existing_branch="$2"
else
    # 1-arg mode: treat input as the branch; derive a safe work name from it.
    existing_branch="$1"

    # Strip a worktree branch prefix of any configured type, not just the
    # default one — otherwise fix_wt/login-crash yields the work name
    # "fix_wt-login-crash" once the sanitiser below replaces the slash.
    work="$(strip_worktree_prefix "$existing_branch")"
    if [[ "$work" != "$existing_branch" ]]; then
        echo "Info: Stripped worktree prefix from branch name, using work name '$work'." >&2
    fi

    # Replace any run of characters not in [a-zA-Z0-9._-] with '-'
    work="$(echo "$work" | sed -E 's/[^a-zA-Z0-9._-]+/-/g' | sed -E 's/^-+|-+$//g' | sed -E 's/-{2,}/-/g')"
    if [[ -z "$work" ]]; then
        echo "Error: Could not derive a safe work name from branch '$existing_branch'." >&2
        exit 1
    fi
    if [[ "$work" != "$existing_branch" ]] && ! is_worktree_branch "$existing_branch"; then
        echo "Info: Derived work name '$work' from branch '$existing_branch'." >&2
    fi
fi

# Validate work name
validate_work_name "$work" || exit 1

worktree_path=$(get_worktree_path "$work")

# Verify we're in a git repository
verify_root_folder

# Check if worktree path already exists
if [[ -e "$worktree_path" ]]; then
    echo "Error: Directory $worktree_path already exists" >&2
    exit 1
fi

# Verify the target branch exists
if ! branch_exists "$existing_branch"; then
    echo "Error: Branch '$existing_branch' does not exist locally or on origin" >&2
    exit 1
fi

# Create the worktree with existing branch
echo "Creating worktree at $worktree_path checking out existing branch '$existing_branch'"
if ! git worktree add "$worktree_path" "$existing_branch"; then
    echo "Error: Failed to create worktree" >&2
    exit 1
fi

# Navigate to the new worktree
if ! cd "$worktree_path"; then
    echo "Error: Failed to navigate to worktree directory" >&2
    exit 1
fi

echo "Successfully created worktree at $worktree_path on branch '$existing_branch'"

# Run setup script to configure AWS context and decrypt secrets
echo ""
echo "Running worktree setup..."
if ! ./bin/worktree/setup.sh "$src_dir"; then
    echo "Warning: Setup failed. You may need to run it manually later:" >&2
    echo "  ./bin/worktree/setup.sh $src_dir" >&2
    exit 1
fi

echo ""
echo "To navigate to your worktree, run:"
echo "  cd $worktree_path"
#!/usr/bin/env bash
# Shared functions for worktree management scripts
# This file should be sourced by worktree scripts

# Load worktree configuration with defaults
function load_worktree_config() {
    local config_file="${BASE_DIR}/bin/worktree/worktree.conf"
    
    # Load configuration if it exists
    if [[ -f "$config_file" ]]; then
        source "$config_file"
    fi
    
    # Set defaults for all configuration values
    REPO_NAME="${REPO_NAME:-$(get_repo_name)}"
    AWS_SETUP_ENABLED="${AWS_SETUP_ENABLED:-true}"
    RUN_TESTS_BEFORE_REMOVE="${RUN_TESTS_BEFORE_REMOVE:-false}"
    TEST_COMMAND="${TEST_COMMAND:-./gradlew test}"
    MAIN_BRANCH="${MAIN_BRANCH:-development}"
    # Handle array defaults properly
    if [[ -z "${DEVELOPER_CONFIG_DIRS:-}" ]]; then
        DEVELOPER_CONFIG_DIRS=(.cursor .claude .run .vscode .idea)
    fi
    if [[ -z "${DEVELOPER_CONFIG_FILES:-}" ]]; then
        DEVELOPER_CONFIG_FILES=()
    fi
    WORKTREE_BRANCH_PREFIX="${WORKTREE_BRANCH_PREFIX:-feat_wt}"
    BUILD_INIT_ENABLED="${BUILD_INIT_ENABLED:-true}"
    BUILD_INIT_COMMAND="${BUILD_INIT_COMMAND:-./gradlew build -x test --quiet}"
}

# Get the repository name from the git root directory
function get_repo_name() {
    # Always get the main repository name, even when in a worktree
    local main_repo_path=$(git worktree list 2>/dev/null | head -1 | awk '{print $1}')
    if [[ -n "$main_repo_path" ]]; then
        basename "$main_repo_path"
    else
        # Fallback to root folder if worktree list fails
        basename "$(root_folder)"
    fi
}

# Check if we're in a worktree (not the main repository)
function is_in_worktree() {
    local git_dir=$(git rev-parse --git-dir 2>/dev/null || echo "")
    local git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null || echo "")
    
    if [[ -z "$git_dir" ]]; then
        return 1  # Not in a git repository
    fi
    
    # In the main repository, --git-dir and --git-common-dir are the same
    # In a worktree, they differ
    if [[ "$git_dir" != "$git_common_dir" ]]; then
        return 0  # In a worktree
    else
        return 1  # In main repository
    fi
}

# Get worktree information for the current directory
function get_worktree_info() {
    local current_dir=$(pwd)
    local worktree_name=$(basename "$current_dir")
    local branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    local commit=$(git rev-parse --short HEAD 2>/dev/null || echo "")
    
    echo "WORKTREE_PATH=$current_dir"
    echo "WORKTREE_NAME=$worktree_name"
    echo "BRANCH=$branch"
    echo "COMMIT=$commit"
}

# Extract work name from worktree directory name
function get_work_name_from_path() {
    local worktree_path="$1"
    local worktree_name=$(basename "$worktree_path")
    local repo_name="${REPO_NAME:-$(get_repo_name)}"
    
    # Expected format: <repo>-<work>
    if [[ "$worktree_name" =~ ^${repo_name}-(.+)$ ]]; then
        echo "${BASH_REMATCH[1]}"
        return 0
    else
        return 1
    fi
}

# Get the main repository path from any worktree
function get_main_repo_path() {
    git worktree list | head -1 | awk '{print $1}'
}

# Check if a branch exists (locally or on origin)
function branch_exists() {
    local branch="$1"
    git show-ref --verify --quiet "refs/heads/$branch" || \
    git show-ref --verify --quiet "refs/remotes/origin/$branch"
}

# Check if a branch is fully merged into another branch
function is_branch_merged() {
    local source_branch="$1"
    local target_branch="$2"
    
    if branch_exists "$target_branch"; then
        git merge-base --is-ancestor "$source_branch" "$target_branch" 2>/dev/null
    else
        return 1
    fi
}

# Count uncommitted changes
function count_uncommitted_changes() {
    local modified=$(git diff --numstat | wc -l | tr -d ' ')
    local staged=$(git diff --cached --numstat | wc -l | tr -d ' ')
    echo $((modified + staged))
}

# Count untracked files
function count_untracked_files() {
    git ls-files --others --exclude-standard | wc -l | tr -d ' '
}

# Count unpushed commits
function count_unpushed_commits() {
    local branch="$1"
    if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
        git rev-list --count origin/"$branch"..HEAD 2>/dev/null || echo "0"
    else
        echo "0"
    fi
}

# Count commits behind origin
function count_behind_commits() {
    local branch="$1"
    if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
        git rev-list --count HEAD..origin/"$branch" 2>/dev/null || echo "0"
    else
        echo "0"
    fi
}

# Validate work name contains only safe characters
function validate_work_name() {
    local work="$1"
    if [[ ! "$work" =~ ^[a-zA-Z0-9._-]+$ ]]; then
        echo "Error: work_name must contain only letters, numbers, dots, underscores, and hyphens" >&2
        return 1
    fi
    return 0
}

# Create standard worktree path from work name
function get_worktree_path() {
    local work="$1"
    local repo_name="${REPO_NAME:-$(get_repo_name)}"
    echo "../${repo_name}-${work}"
}

# Colors for consistent output
export RED='\033[0;31m'
export GREEN='\033[0;32m'
export YELLOW='\033[1;33m'
export BLUE='\033[0;34m'
export NC='\033[0m' # No Color
export BOLD='\033[1m'
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
    # Branches are <type><suffix>/<work>. The suffix is what marks a branch as
    # belonging to a worktree at all; the type says what the work is.
    WORKTREE_TYPE_SUFFIX="${WORKTREE_TYPE_SUFFIX:-_wt}"
    # The default type is read back out of WORKTREE_BRANCH_PREFIX so a repo that
    # only ever set that one value keeps its exact previous behaviour without
    # touching its config.
    WORKTREE_DEFAULT_TYPE="${WORKTREE_DEFAULT_TYPE:-${WORKTREE_BRANCH_PREFIX%"$WORKTREE_TYPE_SUFFIX"}}"
    # Conventional Commits types, so a worktree's type and the commits it carries
    # use one vocabulary, plus the two exploratory kinds that produce no feature.
    if [[ -z "${WORKTREE_TYPES:-}" ]]; then
        WORKTREE_TYPES="feat fix docs style refactor perf test build ci chore revert research spike"
    fi
    WORKTREE_LAYOUT="${WORKTREE_LAYOUT:-flat}"
    BUILD_INIT_ENABLED="${BUILD_INIT_ENABLED:-true}"
    BUILD_INIT_COMMAND="${BUILD_INIT_COMMAND:-./gradlew build -x test --quiet}"
}

# Get the repository name from the git root directory
function get_repo_name() {
    # Always get the main repository name, even when in a worktree.
    # --porcelain puts the path alone on its line; `git worktree list` columns
    # are space-separated, so a repo under a path containing a space resolved to
    # a truncated prefix and every worktree path built from it was wrong.
    local main_repo_path=$(git worktree list --porcelain 2>/dev/null \
        | awk '/^worktree /{sub(/^worktree /,""); print; exit}')
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
    local parent_name=$(basename "$(dirname "$worktree_path")")
    local repo_name="${REPO_NAME:-$(get_repo_name)}"

    # Both layouts are recognised regardless of which one is configured, so a
    # worktree created under the old layout stays identifiable after a switch.

    # nested: <repo>_wt/<work>
    if [[ "$parent_name" == "${repo_name}_wt" ]]; then
        echo "$worktree_name"
        return 0
    fi

    # flat: <repo>-<work>. The repo name is interpolated into a regex, so a dot
    # in it would match any character and a bracket or paren would make the
    # pattern invalid — compare the prefix literally instead.
    local flat_prefix="${repo_name}-"
    if [[ "$worktree_name" == "$flat_prefix"* ]]; then
        echo "${worktree_name#"$flat_prefix"}"
        return 0
    fi

    return 1
}

# Get the main repository path from any worktree
function get_main_repo_path() {
    git worktree list --porcelain 2>/dev/null \
        | awk '/^worktree /{sub(/^worktree /,""); print; exit}'
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

# Split a "type/work" argument into its parts, echoing "<type> <work>".
# A bare work name takes the default type, so every existing invocation is
# unchanged. Work names cannot contain a slash (see validate_work_name), which
# is what makes the first slash unambiguously the type separator.
function split_work_type() {
    local arg="$1"
    if [[ "$arg" == */* ]]; then
        echo "${arg%%/*} ${arg#*/}"
    else
        echo "${WORKTREE_DEFAULT_TYPE:-feat} $arg"
    fi
}

# Membership test against the space-separated WORKTREE_TYPES.
#
# Matching a padded string rather than looping over an unquoted expansion is
# deliberate: `for t in ${WORKTREE_TYPES}` needs word-splitting, which zsh does
# not do to unquoted parameters, so these helpers silently matched nothing when
# sourced from a zsh shell.
function is_known_worktree_type() {
    case " ${WORKTREE_TYPES} " in
        *" $1 "*) return 0 ;;
    esac
    return 1
}

function validate_work_type() {
    if is_known_worktree_type "$1"; then
        return 0
    fi
    echo "Error: unknown worktree type '$1'" >&2
    echo "Valid types: ${WORKTREE_TYPES}" >&2
    echo "Set WORKTREE_TYPES in bin/worktree/worktree.conf to change this list." >&2
    return 1
}

# The branch a worktree of this type and name gets.
function worktree_branch_name() {
    echo "${1}${WORKTREE_TYPE_SUFFIX}/${2}"
}

# True when a branch looks like one of ours, whatever its type. Used instead of
# matching a single hard-coded prefix, which only ever recognised feature
# worktrees and silently treated every other type as an unrelated branch.
function is_worktree_branch() {
    local branch="$1"
    [[ "$branch" == *"${WORKTREE_TYPE_SUFFIX}/"* ]] || return 1
    is_known_worktree_type "${branch%%"${WORKTREE_TYPE_SUFFIX}/"*}"
}

# Strip a "<type><suffix>/" prefix of any configured type, echoing what is left.
# A branch that carries no such prefix comes back unchanged.
function strip_worktree_prefix() {
    local branch="$1"
    if is_worktree_branch "$branch"; then
        local t="${branch%%"${WORKTREE_TYPE_SUFFIX}/"*}"
        echo "${branch#"${t}${WORKTREE_TYPE_SUFFIX}/"}"
    else
        echo "$branch"
    fi
}

# The branch actually checked out at a worktree path.
#
# Ask git rather than rebuilding "<prefix>/<work>" from the work name. Once the
# type varies per worktree the name alone no longer determines the branch, and
# reconstruction would delete or skip the wrong one. This is also more truthful
# for existing worktrees: it survives a branch someone renamed by hand.
function worktree_branch_at() {
    # Not named `path`: zsh ties that name to $PATH as an array, so `local
    # path=...` empties the command search path for the rest of the function and
    # git itself stops resolving. Harmless under bash, but these helpers get
    # sourced into interactive shells too.
    local wt_path="$1"
    [[ -e "$wt_path" ]] || return 1
    git -C "$wt_path" rev-parse --abbrev-ref HEAD 2>/dev/null
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

# Where a worktree for <work> belongs. Two layouts, chosen in worktree.conf:
#
#   flat    ../<repo>-<work>      one sibling directory per worktree (default)
#   nested  ../<repo>_wt/<work>   all of a repo's worktrees under one parent
#
# Nested keeps the parent directory tidy once a repo has several worktrees, at
# the cost of one more level. Flat stays the default so repos that never opt in
# are untouched.
#
# Whichever layout is configured, a worktree that already exists at the other
# one keeps its path. Switching layouts must not orphan existing checkouts —
# remove.sh and switch.sh find worktrees through this function, so a layout
# change that silently relocated them would leave them unreachable by the very
# scripts meant to manage them.
function get_worktree_path() {
    local work="$1"
    local repo_name="${REPO_NAME:-$(get_repo_name)}"
    local flat="../${repo_name}-${work}"
    local nested="../${repo_name}_wt/${work}"

    if [[ "${WORKTREE_LAYOUT:-flat}" == "nested" ]]; then
        if [[ ! -e "$nested" && -e "$flat" ]]; then echo "$flat"; else echo "$nested"; fi
    else
        if [[ ! -e "$flat" && -e "$nested" ]]; then echo "$nested"; else echo "$flat"; fi
    fi
}

# Colors for consistent output
export RED='\033[0;31m'
export GREEN='\033[0;32m'
export YELLOW='\033[1;33m'
export BLUE='\033[0;34m'
export NC='\033[0m' # No Color
export BOLD='\033[1m'
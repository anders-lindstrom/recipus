#!/usr/bin/env bash
# Source this file to add the remove_me function to your shell
# Add this line to your ~/.bashrc or ~/.zshrc:
#   source /path/to/repo/bin/worktree/remove_me_function.sh

function remove_worktree() {
    # Check if we're in a worktree
    local git_dir=$(git rev-parse --git-dir 2>/dev/null || echo "")
    local git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null || echo "")
    
    if [[ -z "$git_dir" ]]; then
        echo "Error: Not in a git repository" >&2
        return 1
    fi
    
    if [[ "$git_dir" == "$git_common_dir" ]]; then
        echo "Error: You are in the main repository, not a worktree!" >&2
        echo "This function can only be run from within a worktree." >&2
        return 1
    fi
    
    # Get the main repository path before removal
    local main_repo_path=$(git worktree list | head -1 | awk '{print $1}')
    
    # Run the actual removal script
    local script_path="$(git rev-parse --show-toplevel)/bin/worktree/remove_me.sh"
    if [[ ! -f "$script_path" ]]; then
        echo "Error: Cannot find remove_me.sh script" >&2
        return 1
    fi
    
    # Run the script with any arguments
    "$script_path" "$@"
    local exit_code=$?
    
    # If successful, change directory to main repo
    if [[ $exit_code -eq 0 ]]; then
        echo "Changing directory to main repository..."
        cd "$main_repo_path"
        echo "✓ You are now in: $(pwd)"
    fi
    
    return $exit_code
}

# Add alias for convenience
alias worktree-remove-me='remove_worktree'

echo "✓ Loaded remove_worktree function. Use 'remove_worktree' or 'worktree-remove-me' to remove the current worktree and return to main repo."
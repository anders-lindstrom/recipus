#!/usr/bin/env bash
# Quickly switch between worktrees
# usage: ./bin/worktree/switch.sh [work_name]
# If no work_name is provided, shows an interactive menu

set -euo pipefail

BASE_DIR=$(git rev-parse --show-toplevel)
source ${BASE_DIR}/bin/env_check_functions.sh || { echo "not right setup"; exit 1; }
source ${BASE_DIR}/bin/worktree_functions.sh || { echo "not right setup"; exit 1; }

# Load configuration with defaults
load_worktree_config

# Verify we're in a git repository
verify_root_folder

# Function to switch to a worktree
switch_to_worktree() {
    local target_path="$1"
    
    if [[ ! -d "$target_path" ]]; then
        echo "Error: Worktree directory not found: $target_path" >&2
        exit 1
    fi
    
    echo "Switching to: $target_path"
    cd "$target_path"
    
    # Start a new shell in the worktree directory
    # This ensures the user stays in the worktree after the script exits
    exec $SHELL
}

# If a work name is provided as argument
if [[ "$#" -eq 1 ]]; then
    WORK_NAME="$1"
    
    # Try to find the worktree
    TARGET_PATH=""
    
    # First, try exact match with expected naming pattern
    EXPECTED_PATH=$(get_worktree_path "$WORK_NAME")
    if [[ -d "$EXPECTED_PATH" ]]; then
        TARGET_PATH="$EXPECTED_PATH"
    else
        # Search through all worktrees for a match
        while IFS=$'\t' read -r path _; do
            if [[ "$(basename "$path")" == "${REPO_NAME}-${WORK_NAME}" ]] || \
               [[ "$(basename "$path")" == "$WORK_NAME" ]] || \
               [[ "$path" == *"$WORK_NAME"* ]]; then
                TARGET_PATH="$path"
                break
            fi
        done < <(git worktree list --porcelain | grep "^worktree " | cut -d' ' -f2-)
    fi
    
    if [[ -z "$TARGET_PATH" ]]; then
        echo "Error: No worktree found matching: $WORK_NAME" >&2
        echo "" >&2
        echo "Available worktrees:" >&2
        git worktree list | while read -r line; do
            echo "  $(basename "$(echo "$line" | awk '{print $1}')")" >&2
        done
        exit 1
    fi
    
    switch_to_worktree "$TARGET_PATH"
fi

# Interactive mode - show menu
echo "Select a worktree to switch to:"
echo "================================"

# Build array of worktree paths and display menu
declare -a WORKTREE_PATHS
declare -a WORKTREE_NAMES
INDEX=0
CURRENT_DIR=$(pwd)

while IFS=$'\t' read -r path rest; do
    # Skip if this is the current directory
    if [[ "$(realpath "$CURRENT_DIR")" == "$(realpath "$path")" ]]; then
        continue
    fi
    
    WORKTREE_PATHS[$INDEX]="$path"
    WORKTREE_NAME=$(basename "$path")
    
    # Extract branch name if available
    BRANCH=""
    if [[ "$rest" =~ \[([^\]]+)\] ]]; then
        BRANCH="${BASH_REMATCH[1]}"
    fi
    
    # Show menu item
    printf "%2d) %-30s %s\n" $((INDEX + 1)) "$WORKTREE_NAME" "[$BRANCH]"
    WORKTREE_NAMES[$INDEX]="$WORKTREE_NAME"
    
    ((INDEX++))
done < <(git worktree list)

if [[ "$INDEX" -eq 0 ]]; then
    echo "No other worktrees available to switch to." >&2
    exit 1
fi

echo ""
echo " 0) Cancel"
echo ""

# Read user choice
read -p "Enter choice (1-$INDEX): " CHOICE

# Validate choice
if [[ "$CHOICE" == "0" ]]; then
    echo "Cancelled."
    exit 0
fi

if ! [[ "$CHOICE" =~ ^[0-9]+$ ]] || [[ "$CHOICE" -lt 1 ]] || [[ "$CHOICE" -gt "$INDEX" ]]; then
    echo "Error: Invalid choice" >&2
    exit 1
fi

# Switch to selected worktree
TARGET_PATH="${WORKTREE_PATHS[$((CHOICE - 1))]}"
switch_to_worktree "$TARGET_PATH"
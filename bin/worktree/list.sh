#!/usr/bin/env bash
# Lists all worktrees with detailed status information
# usage: ./bin/worktree/list.sh

set -euo pipefail

BASE_DIR=$(git rev-parse --show-toplevel)
source ${BASE_DIR}/bin/env_check_functions.sh || { echo "not right setup"; exit 1; }
source ${BASE_DIR}/bin/worktree_functions.sh || { echo "not right setup"; exit 1; }

# Load configuration with defaults
load_worktree_config

# Verify we're in a git repository
verify_root_folder

echo -e "${BOLD}Git Worktrees:${NC}"
echo "========================================"

# Get current directory to mark current worktree
CURRENT_DIR=$(pwd)

# Get the main repository path
MAIN_REPO_PATH=$(get_main_repo_path)
IS_FIRST=true

# Process each worktree
git worktree list --porcelain | while IFS= read -r line; do
    if [[ "$line" =~ ^worktree ]]; then
        WORKTREE_PATH="${line#worktree }"
        IS_CURRENT=false
        IS_MAIN_REPO=false
        
        # Check if this is the main repository
        if [[ "$(realpath "$WORKTREE_PATH")" == "$(realpath "$MAIN_REPO_PATH")" ]]; then
            IS_MAIN_REPO=true
        fi
        
        # Check if this is the current location
        if [[ "$(realpath "$CURRENT_DIR")" == "$(realpath "$WORKTREE_PATH")" ]]; then
            IS_CURRENT=true
        fi
    elif [[ "$line" =~ ^HEAD ]]; then
        COMMIT="${line#HEAD }"
    elif [[ "$line" =~ ^branch ]]; then
        BRANCH="${line#branch refs/heads/}"
        
        # Display worktree information
        if [[ "$IS_MAIN_REPO" == "true" ]]; then
            # Show main repository differently
            if [[ "$IS_CURRENT" == "true" ]]; then
                echo -e "${GREEN}→${NC} ${BOLD}$WORKTREE_PATH${NC} ${BLUE}[MAIN REPOSITORY]${NC} ${GREEN}[CURRENT]${NC}"
            else
                echo -e "  ${BOLD}$WORKTREE_PATH${NC} ${BLUE}[MAIN REPOSITORY]${NC}"
            fi
            echo -e "  ${BLUE}Branch:${NC} $BRANCH"
            echo -e "  ${BLUE}Commit:${NC} ${COMMIT:0:8}"
            # Skip detailed status for main repository
            echo ""
            continue
        else
            # Regular worktree display
            if [[ "$IS_CURRENT" == "true" ]]; then
                echo -e "${GREEN}→${NC} ${BOLD}$WORKTREE_PATH${NC} ${GREEN}[CURRENT]${NC}"
            else
                echo -e "  $WORKTREE_PATH"
            fi
            echo -e "  ${BLUE}Branch:${NC} $BRANCH"
            echo -e "  ${BLUE}Commit:${NC} ${COMMIT:0:8}"
        fi
        
        # Check status if directory exists (only for worktrees, not main repo)
        if [[ -d "$WORKTREE_PATH" ]]; then
            # Save current directory
            SAVED_DIR=$(pwd)
            cd "$WORKTREE_PATH"
            
            # Check for uncommitted changes
            if ! git diff --quiet || ! git diff --cached --quiet; then
                CHANGES=$(git diff --shortstat)
                STAGED=$(git diff --cached --shortstat)
                if [[ -n "$STAGED" ]]; then
                    echo -e "  ${YELLOW}⚠ Staged changes:${NC} $STAGED"
                fi
                if [[ -n "$CHANGES" ]]; then
                    echo -e "  ${YELLOW}⚠ Uncommitted changes:${NC} $CHANGES"
                fi
            fi
            
            # Check for untracked files
            UNTRACKED_COUNT=$(count_untracked_files)
            if [[ "$UNTRACKED_COUNT" -gt 0 ]]; then
                echo -e "  ${YELLOW}⚠ Untracked files:${NC} $UNTRACKED_COUNT"
            fi
            
            # Check for unpushed commits
            if branch_exists "$BRANCH"; then
                AHEAD=$(count_unpushed_commits "$BRANCH")
                BEHIND=$(count_behind_commits "$BRANCH")
                
                if [[ "$AHEAD" -gt 0 ]] || [[ "$BEHIND" -gt 0 ]]; then
                    STATUS=""
                    if [[ "$AHEAD" -gt 0 ]]; then
                        STATUS="${STATUS}ahead $AHEAD"
                    fi
                    if [[ "$BEHIND" -gt 0 ]]; then
                        if [[ -n "$STATUS" ]]; then
                            STATUS="${STATUS}, "
                        fi
                        STATUS="${STATUS}behind $BEHIND"
                    fi
                    echo -e "  ${YELLOW}⚠ Remote:${NC} $STATUS"
                fi
            else
                echo -e "  ${YELLOW}⚠ Remote:${NC} branch not on origin"
            fi
            
            # Check if merged to main branch
            if branch_exists "$MAIN_BRANCH"; then
                # Check if branch has any commits not in main
                UNIQUE_COMMITS=$(git rev-list --count "$MAIN_BRANCH".."$BRANCH" 2>/dev/null || echo "0")
                # Check if main has commits not in branch
                BEHIND_MAIN=$(git rev-list --count "$BRANCH".."$MAIN_BRANCH" 2>/dev/null || echo "0")
                
                if [[ "$UNIQUE_COMMITS" -eq 0 ]]; then
                    # Branch has no unique commits
                    if [[ "$BEHIND_MAIN" -eq 0 ]]; then
                        echo -e "  ${BLUE}ℹ No new commits:${NC} at same point as $MAIN_BRANCH"
                    else
                        echo -e "  ${BLUE}ℹ No new commits:${NC} $BEHIND_MAIN commits behind $MAIN_BRANCH"
                    fi
                elif is_branch_merged "$BRANCH" "$MAIN_BRANCH"; then
                    # Branch has commits and they're all merged
                    echo -e "  ${GREEN}✓ Merged:${NC} into $MAIN_BRANCH"
                else
                    # Branch has unmerged commits (shown by not displaying anything)
                    # The "ahead" count above already shows this information
                    :
                fi
            fi
            
            # Return to saved directory
            cd "$SAVED_DIR"
        else
            echo -e "  ${RED}⚠ Directory not found${NC}"
        fi
        
        echo ""
    elif [[ "$line" =~ ^detached$ ]]; then
        echo -e "  ${YELLOW}Branch:${NC} (detached HEAD)"
        echo -e "  ${BLUE}Commit:${NC} ${COMMIT:0:8}"
        echo ""
    fi
done

# Summary
TOTAL_COUNT=$(git worktree list | wc -l | tr -d ' ')
echo "========================================"
echo -e "${BOLD}Total worktrees: $TOTAL_COUNT${NC}"
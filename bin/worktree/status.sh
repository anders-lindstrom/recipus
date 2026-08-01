#!/usr/bin/env bash
# Shows detailed status of the current worktree
# usage: ./bin/worktree/status.sh

set -euo pipefail

BASE_DIR=$(git rev-parse --show-toplevel)
source ${BASE_DIR}/bin/env_check_functions.sh || { echo "not right setup"; exit 1; }
source ${BASE_DIR}/bin/worktree_functions.sh || { echo "not right setup"; exit 1; }

# Load configuration with defaults
load_worktree_config

# Get worktree information
CURRENT_DIR=$(pwd)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
CURRENT_COMMIT=$(git rev-parse --short HEAD)

echo -e "${BOLD}Worktree Status${NC}"
echo "========================================"

# Check if we're in a worktree or main repository
if ! is_in_worktree; then
    echo -e "${BLUE}Type:${NC} Main repository"
else
    echo -e "${BLUE}Type:${NC} Worktree"
    
    # Extract work name if in a worktree. Ask the shared helper rather than
    # re-deriving the layout here, so this keeps working under either layout.
    WORKTREE_NAME=$(basename "$CURRENT_DIR")
    WORK_NAME=$(get_work_name_from_path "$CURRENT_DIR" 2>/dev/null || echo "")
    if [[ -n "$WORK_NAME" ]]; then
        echo -e "${BLUE}Work name:${NC} $WORK_NAME"
    fi
fi

echo -e "${BLUE}Path:${NC} $CURRENT_DIR"
echo -e "${BLUE}Branch:${NC} $CURRENT_BRANCH"
echo -e "${BLUE}Commit:${NC} $CURRENT_COMMIT"

# Show last commit info
LAST_COMMIT_MSG=$(git log -1 --pretty=format:"%s" 2>/dev/null || echo "No commits")
LAST_COMMIT_AUTHOR=$(git log -1 --pretty=format:"%an" 2>/dev/null || echo "")
LAST_COMMIT_DATE=$(git log -1 --pretty=format:"%cr" 2>/dev/null || echo "")
if [[ -n "$LAST_COMMIT_AUTHOR" ]]; then
    echo -e "${BLUE}Last commit:${NC} \"$LAST_COMMIT_MSG\" by $LAST_COMMIT_AUTHOR ($LAST_COMMIT_DATE)"
fi

echo ""
echo -e "${BOLD}Working Tree Status:${NC}"
echo "----------------------------------------"

# Check for uncommitted changes
HAS_CHANGES=false
if ! git diff --quiet; then
    HAS_CHANGES=true
    CHANGES=$(git diff --stat | tail -1)
    echo -e "${YELLOW}⚠ Uncommitted changes:${NC} $CHANGES"
    echo ""
    echo "Modified files:"
    git diff --name-status | while IFS=$'\t' read -r status file; do
        echo "  $status $file"
    done
    echo ""
fi

# Check for staged changes
if ! git diff --cached --quiet; then
    HAS_CHANGES=true
    STAGED=$(git diff --cached --stat | tail -1)
    echo -e "${YELLOW}⚠ Staged changes:${NC} $STAGED"
    echo ""
    echo "Staged files:"
    git diff --cached --name-status | while IFS=$'\t' read -r status file; do
        echo "  $status $file"
    done
    echo ""
fi

# Check for untracked files
UNTRACKED_COUNT=$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')
if [[ "$UNTRACKED_COUNT" -gt 0 ]]; then
    HAS_CHANGES=true
    echo -e "${YELLOW}⚠ Untracked files:${NC} $UNTRACKED_COUNT"
    echo ""
    echo "Untracked files:"
    git ls-files --others --exclude-standard | head -10 | while read -r file; do
        echo "  ? $file"
    done
    if [[ "$UNTRACKED_COUNT" -gt 10 ]]; then
        echo "  ... and $((UNTRACKED_COUNT - 10)) more"
    fi
    echo ""
fi

if [[ "$HAS_CHANGES" == "false" ]]; then
    echo -e "${GREEN}✓ Working tree clean${NC}"
    echo ""
fi

# Remote status
echo -e "${BOLD}Remote Status:${NC}"
echo "----------------------------------------"

if git show-ref --verify --quiet "refs/remotes/origin/$CURRENT_BRANCH"; then
    # Fetch latest remote info (without pulling)
    echo "Fetching remote status..."
    git fetch --dry-run 2>&1 | grep -v "From" || true
    
    AHEAD=$(git rev-list --count origin/"$CURRENT_BRANCH"..HEAD 2>/dev/null || echo "0")
    BEHIND=$(git rev-list --count HEAD..origin/"$CURRENT_BRANCH" 2>/dev/null || echo "0")
    
    if [[ "$AHEAD" -eq 0 ]] && [[ "$BEHIND" -eq 0 ]]; then
        echo -e "${GREEN}✓ Up to date with origin/$CURRENT_BRANCH${NC}"
    else
        if [[ "$AHEAD" -gt 0 ]]; then
            echo -e "${YELLOW}⚠ Ahead of origin by $AHEAD commit(s)${NC}"
            echo ""
            echo "Unpushed commits:"
            git log --oneline origin/"$CURRENT_BRANCH"..HEAD | head -5 | while read -r line; do
                echo "  $line"
            done
            if [[ "$AHEAD" -gt 5 ]]; then
                echo "  ... and $((AHEAD - 5)) more"
            fi
            echo ""
        fi
        
        if [[ "$BEHIND" -gt 0 ]]; then
            echo -e "${YELLOW}⚠ Behind origin by $BEHIND commit(s)${NC}"
            echo ""
            echo "New commits on origin:"
            git log --oneline HEAD..origin/"$CURRENT_BRANCH" | head -5 | while read -r line; do
                echo "  $line"
            done
            if [[ "$BEHIND" -gt 5 ]]; then
                echo "  ... and $((BEHIND - 5)) more"
            fi
            echo ""
        fi
    fi
else
    echo -e "${YELLOW}⚠ Branch not tracked on origin${NC}"
    echo "To push this branch to origin, run:"
    echo "  git push -u origin $CURRENT_BRANCH"
    echo ""
fi

# Merge status with main branch
if branch_exists "$MAIN_BRANCH"; then
    echo -e "${BOLD}Merge Status:${NC}"
    echo "----------------------------------------"
    
    # Check if branch has any commits not in main
    UNIQUE_COMMITS=$(git rev-list --count "$MAIN_BRANCH".."$CURRENT_BRANCH" 2>/dev/null || echo "0")
    # Check if main branch has new commits
    BEHIND_MAIN=$(git rev-list --count "$CURRENT_BRANCH".."$MAIN_BRANCH" 2>/dev/null || echo "0")
    
    if [[ "$UNIQUE_COMMITS" -eq 0 ]]; then
        # No unique commits on this branch
        if [[ "$BEHIND_MAIN" -eq 0 ]]; then
            echo -e "${BLUE}ℹ No new commits: at same point as $MAIN_BRANCH${NC}"
        else
            echo -e "${BLUE}ℹ No new commits on this branch${NC}"
            echo -e "${YELLOW}⚠ Behind $MAIN_BRANCH by $BEHIND_MAIN commit(s)${NC}"
            echo "To update from $MAIN_BRANCH, run:"
            echo "  git merge $MAIN_BRANCH"
        fi
    elif is_branch_merged "$CURRENT_BRANCH" "$MAIN_BRANCH"; then
        # Has commits and they're merged
        echo -e "${GREEN}✓ Fully merged into $MAIN_BRANCH${NC}"
    else
        # Has unmerged commits
        echo -e "${YELLOW}⚠ Not merged: $UNIQUE_COMMITS commit(s) not in $MAIN_BRANCH${NC}"
        if [[ "$BEHIND_MAIN" -gt 0 ]]; then
            echo -e "${YELLOW}⚠ Behind $MAIN_BRANCH by $BEHIND_MAIN commit(s)${NC}"
            echo "To update from $MAIN_BRANCH, run:"
            echo "  git merge $MAIN_BRANCH"
        fi
    fi
fi

echo ""
echo "========================================"
#!/usr/bin/env bash
# Sets up AWS context and decrypts local secrets for a new worktree
# This script should be run at the start of working in a new worktree
# usage: ./bin/worktree/setup.sh <source_dir>
#
# <source_dir>: Absolute path to the repo/worktree to copy configuration from

set -euo pipefail

BASE_DIR=$(git rev-parse --show-toplevel)
source ${BASE_DIR}/bin/env_check_functions.sh || { echo "not right setup"; exit 1; }
source ${BASE_DIR}/bin/worktree_functions.sh || { echo "not right setup"; exit 1; }

# Load configuration with defaults
load_worktree_config

echo "Setting up worktree development environment..."

# Parse arguments
if [[ "$#" -ne 1 ]]; then
    echo "Usage: $0 <source_dir>" >&2
    exit 1
fi

src_dir="$1"

# Verify we're in a git repository
verify_root_folder

# Copy developer config directories from the provided source worktree
echo "Syncing developer config directories: ${DEVELOPER_CONFIG_DIRS[*]}"

if [[ -d "$src_dir" ]]; then
    for d in "${DEVELOPER_CONFIG_DIRS[@]}"; do
        if [[ -d "$src_dir/$d" ]]; then
            if [[ -e "$d" ]]; then
                echo " - $d already exists, skipping"
            else
                if ! cp -R "$src_dir/$d" "$d"; then
                    echo "Warning: Failed to copy $d from $src_dir" >&2
                else
                    echo " ✓ Copied $d from $src_dir"
                fi
            fi
        else
            echo " - $d not found in source worktree, skipping"
        fi
    done

    # Copy individual developer config files (if any are configured)
    if [[ ${#DEVELOPER_CONFIG_FILES[@]} -gt 0 ]]; then
        echo "Syncing developer config files: ${DEVELOPER_CONFIG_FILES[*]}"
        for f in "${DEVELOPER_CONFIG_FILES[@]}"; do
            if [[ -f "$src_dir/$f" ]]; then
                if [[ -e "$f" ]]; then
                    echo " - $f already exists, skipping"
                else
                    # Create parent directory if it doesn't exist
                    parent_dir=$(dirname "$f")
                    if [[ ! -d "$parent_dir" ]]; then
                        if ! mkdir -p "$parent_dir"; then
                            echo "Warning: Failed to create directory $parent_dir" >&2
                            continue
                        fi
                    fi

                    if ! cp "$src_dir/$f" "$f"; then
                        echo "Warning: Failed to copy $f from $src_dir" >&2
                    else
                        echo " ✓ Copied $f from $src_dir"
                    fi
                fi
            else
                echo " - $f not found in source worktree, skipping"
            fi
        done
    fi
else
    echo " - Source directory $src_dir not found; skipping config sync"
fi

# AWS setup (if enabled)
if [[ "$AWS_SETUP_ENABLED" == "true" ]]; then
    # Get current AWS identity for confirmation
    aws_identity=$(aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null || echo "unknown")
    echo "AWS access confirmed: $aws_identity"
    
    # Decrypt local secrets
    echo "Decrypting local secrets..."
    if [[ -f etc/encrypted/bin/decrypt.sh ]] && ! etc/encrypted/bin/decrypt.sh local; then
        echo "Error: Failed to decrypt local secrets" >&2
        echo "This may be due to:" >&2
        echo "  - Missing or invalid AWS permissions" >&2
        echo "  - Incorrect AWS region configuration" >&2
        echo "  - KMS key access issues" >&2
        exit 1
    fi
else
    echo "Skipping AWS setup (disabled in configuration)"
fi

# Initialize submodules if present
if [[ -f ".gitmodules" ]]; then
    echo "Initializing git submodules..."
    if ! git submodule update --init --recursive; then
        echo "Warning: Failed to initialize submodules" >&2
        echo "Dependency installation may fail without submodules" >&2
    else
        # Count how many submodules were initialized
        SUBMODULE_COUNT=$(git submodule status | wc -l | tr -d ' ')
        echo "✓ Initialized $SUBMODULE_COUNT submodule(s) successfully"
    fi
else
    echo "No submodules detected in this repository"
fi

# Initialize build system (if enabled)
BUILD_SUCCESS=false
if [[ "$BUILD_INIT_ENABLED" == "true" ]]; then
    echo "Initializing build system..."

    # Detect project type and validate tools
    PROJECT_TYPE="unknown"
    if [[ -f "pubspec.yaml" ]]; then
        PROJECT_TYPE="flutter"
        echo "Detected Flutter/Dart project"

        # Check if Flutter SDK is available
        if ! flutter --version >/dev/null 2>&1; then
            echo "Error: Flutter SDK not found or not in PATH" >&2
            exit 1
        fi

        # Check if very_good CLI is available for monorepos
        if [[ -d "packages" ]] && ! very_good --version >/dev/null 2>&1; then
            echo "Warning: very_good CLI not found. Install with: dart pub global activate very_good_cli" >&2
            echo "Continuing without recursive package management..." >&2
        fi
    elif [[ -f "package.json" ]]; then
        PROJECT_TYPE="node"
        echo "Detected Node.js project"
    elif [[ -f "Cargo.toml" ]]; then
        PROJECT_TYPE="rust"
        echo "Detected Rust project"
    elif [[ -f "go.mod" ]]; then
        PROJECT_TYPE="go"
        echo "Detected Go project"
    elif [[ -f "pom.xml" ]] || [[ -f "build.gradle" ]] || [[ -f "gradlew" ]]; then
        PROJECT_TYPE="java"
        echo "Detected Java/Gradle project"

        # Check if Gradle wrapper exists
        if [[ -f "./gradlew" ]]; then
            if ! ./gradlew --version >/dev/null 2>&1; then
                echo "Error: Gradle wrapper not found or not executable" >&2
                exit 1
            fi
        fi
    else
        echo "Could not detect project type - using configured build command"
    fi

    echo "Running build initialization..."
    if eval "$BUILD_INIT_COMMAND"; then
        echo "✓ Build initialization successful - dependencies downloaded"
        BUILD_SUCCESS=true
    else
        echo "Warning: Build initialization failed. You may need to resolve build issues manually." >&2
        echo "Try running: $BUILD_INIT_COMMAND" >&2
    fi
else
    echo "Skipping build initialization (disabled in configuration)"
fi

echo ""
echo "✓ Worktree setup complete!"

if [[ "$AWS_SETUP_ENABLED" == "true" ]]; then
    echo "✓ AWS access verified: $aws_identity"
    echo "✓ Local secrets decrypted successfully"
fi

if [[ "$BUILD_INIT_ENABLED" == "true" ]] && [[ "$BUILD_SUCCESS" == "true" ]]; then
    echo "✓ Build dependencies downloaded and verified"
elif [[ "$BUILD_INIT_ENABLED" == "true" ]]; then
    echo "⚠ Build initialization was attempted but failed - manual intervention may be required"
fi

echo "✓ Developer config directories synced where available"
echo ""
echo "You can now start development in this worktree."
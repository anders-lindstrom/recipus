#!/usr/bin/env bash
# Verifies various parameters and things that should be set up for worktree handlings

set -euo pipefail

BASE_DIR=$(git rev-parse --show-toplevel)
source ${BASE_DIR}/bin/env_check_functions.sh || { echo "not right setup"; exit 1; }
source ${BASE_DIR}/bin/worktree_functions.sh || { echo "not right setup"; exit 1; }

# Load configuration with defaults
load_worktree_config

# The toolchain a worktree needs is repo-specific — aws/jq in the backend repos,
# flutter/fvm/very_good in the app repos — so it comes from worktree.conf rather
# than being hardcoded in a file that is meant to be identical everywhere. That
# hardcoding is what split this script into two variants in the first place.
if [[ -n "${REQUIRED_BINS:-}" ]]; then
    verify_bins "${REQUIRED_BINS}"
fi

verify_root_folder

src_dir="${1:-}"

# The AWS helpers are only a prerequisite for repos whose setup decrypts
# secrets. Sourcing them unconditionally breaks every repo that sets
# AWS_SETUP_ENABLED=false and therefore has no reason to carry the file.
if [[ "${AWS_SETUP_ENABLED:-true}" == "true" ]]; then
    source ${BASE_DIR}/bin/env_check_functions_aws.sh || { echo "not right setup"; exit 1; }
    aws_cli || exit 1
    aws_verify_credentials || exit 1
fi

#!/usr/bin/env bash
# Verifies various parameters and things that should be set up for worktree handlings

set -euo pipefail

BASE_DIR=$(git rev-parse --show-toplevel)
source ${BASE_DIR}/bin/env_check_functions.sh || { echo "not right setup"; exit 1; }
source ${BASE_DIR}/bin/worktree_functions.sh || { echo "not right setup"; exit 1; }

# Load configuration with defaults
load_worktree_config

verify_root_folder

src_dir="${1:-}"

# The AWS toolchain is only a prerequisite for repos whose setup decrypts
# secrets. Repos with AWS_SETUP_ENABLED=false must not require aws/jq at all.
if [[ "${AWS_SETUP_ENABLED:-true}" == "true" ]]; then
    source ${BASE_DIR}/bin/env_check_functions_aws.sh || { echo "not right setup"; exit 1; }
    verify_bins "aws jq"
    aws_cli || exit 1
    aws_verify_credentials || exit 1
fi

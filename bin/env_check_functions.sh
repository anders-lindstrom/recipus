#!/usr/bin/env bash
# meant to be sourced in

function verify_root_folder() {
  is_root_folder || {
    echo "must be in the root repo folder"
    exit 1
  }
}
function verify_relative_folder() {
  is_relative_folder "${1}" || {
    echo "must be in the relative repo folder [repo]/${1}"
    exit 1
  }
}
function verify_env_var_set() {
  is_env_var_set "${1}" || {
    echo "The environment variable '${1}' is not set."
    exit 1
  }
}

function is_env_var_set() {
  local var_name=$1
  if [ -z "$(eval echo \$"$var_name")" ]; then
    return 1
  fi
}

function is_relative_folder() {
  local rel_path=${1}
  [[ ${rel_path} ]] || {
    echo "Need to specify the rel_path."
    return 123
  }
  
  local root_path="$(root_folder)"
  local target_path="${root_path}/${rel_path}"

  [[ -d ${target_path} ]] || {
    echo "No such directory ${target_path}"
    return 124
  }
  
  local real_target_path=$(realpath "${target_path}")
  local current_path=$(realpath "$(pwd)")

  if [[ "${real_target_path}" == "${current_path}" ]]; then
    return 0
  else
    return 1
  fi
}

# Check if we're in a git repository (works for both regular repos and worktrees)
function is_root_folder() {
  git rev-parse --git-dir >/dev/null 2>&1 || { return 1; }
  
  local current_dir="$(pwd)"
  local repo_root="$(git rev-parse --show-toplevel)"
  [[ "$current_dir" == "$repo_root" ]] || { return 1; }
}

function root_folder() {
  echo -e "$(git rev-parse --show-toplevel)"
  return 0
}

function verify_bin() {
  local app=${1}
  [[ ${app} ]] || {
    echo "need to specify the app"
    return 1
  }

  type "$app" &>/dev/null || {
    echo "no $app installed, brew install it"
    return 1
  }
}

function verify_bins() {
  local bins=${1}
  [[ ${bins} ]] || {
    echo "need to specify the bins"
    return 1
  }

  for bin in ${bins}; do
    verify_bin ${bin}
  done
}

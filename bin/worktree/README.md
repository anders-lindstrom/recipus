# Worktree tooling

The scripts in this directory are **shims**. The implementation lives in
[`wt`](https://github.com/anders-lindstrom/wt) — one copy, shared by every repo,
so a fix lands once instead of being copied into seven.

```sh
./bin/worktree/new.sh fix/login-crash     # same as: wt new fix/login-crash
wt cd fix/login-crash                     # jump there
wt cd .                                   # back to this checkout
wt --help                                 # everything else
```

The shims stay because several things reference these exact paths:
`.superset/config.json`, the Herdr plugin, `.claude` hooks, and habit.

## What this repository owns

| file | |
|---|---|
| `worktree.conf` | how this repo works — main branch, build command, which config to copy into a new worktree, required tools |
| `provision.sh` | optional: this repo's own setup step, run in each new worktree (decrypting secrets, checking a cloud identity) |

Everything else here is a shim, including `../worktree_functions.sh`, which
exists for tools that source it by name.

## Notes

`switch.sh` spawns a *new* shell in the worktree, as it always has. To change
your current shell's directory use `wt cd <name>`, or `wt cd .` to come back
here — those run in your shell rather than in a child process.

## Install

```sh
git clone git@github.com:anders-lindstrom/wt.git && cd wt && ./install.sh
```

Then run `wt doctor` in this repo if something looks wrong.

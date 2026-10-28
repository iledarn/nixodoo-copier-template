#!/usr/bin/env bash
# ADR numbers across branches: a branch sees only its own docs/adr/, so two parallel branches can
# take one number, and git merges both files cleanly because the names differ.
# Usage: adr-number.sh next  [<repo>]   the highest number here, on any branch and in any other
#                                       worktree of the repo, plus one
#        adr-number.sh check [<repo>]   exit 1 when a record this branch adds shares its number with
#                                       a different record on an unmerged branch or uncommitted in
#                                       another worktree, or two files here share one
# <repo> defaults to the git checkout of the current directory. Both fetch origin first.
set -euo pipefail

cmd="${1:-}"
case "$cmd" in next|check) ;; *) echo "usage: adr-number.sh next|check [<repo>]" >&2; exit 2 ;; esac
repo="$(git -C "${2:-.}" rev-parse --show-toplevel)"
dir=docs/adr
g() { git -C "$repo" "$@"; }

if g remote get-url origin >/dev/null 2>&1; then
    g fetch -q origin 2>/dev/null \
        || echo "adr-number: fetching origin failed; branches pushed since the last fetch are not seen" >&2
fi

# NNNN-slug.md names, one per line: in a tree-ish of checkout $1 ($2), or on disk in checkout $1
tree_names() { git -C "$1" ls-tree --name-only "$2" -- "$dir/" 2>/dev/null | sed -n "s|^$dir/\([0-9]\{4\}-.*\.md\)$|\1|p"; }
dir_names() { [ -d "$1/$dir" ] && ls "$1/$dir" | grep -E '^[0-9]{4}-.*\.md$' || true; }
# "<sha> <short name>" of every local and remote branch but origin/HEAD; $1 = extra for-each-ref args
branches() { g for-each-ref ${1:-} --format='%(objectname) %(refname:short)' refs/heads refs/remotes | grep -v '/HEAD$' || true; }
# the other checkouts of this repository
worktrees() { g worktree list --porcelain | sed -n 's/^worktree //p' | grep -vxF "$repo" || true; }

if [ "$cmd" = next ]; then
    max="$( {
        dir_names "$repo"
        worktrees | while read -r wt; do dir_names "$wt"; done
        branches | cut -d' ' -f1 | sort -u | while read -r sha; do tree_names "$repo" "$sha"; done
    } | cut -c1-4 | sort -n | tail -n1)"
    printf '%04d\n' "$((10#${max:-0} + 1))"
    exit 0
fi

here="$(dir_names "$repo")"
rc=0
for n in $(cut -c1-4 <<<"$here" | sort | uniq -d); do
    echo "collision: $n is taken twice here: $(grep "^$n-" <<<"$here" | tr '\n' ' ')"
    rc=1
done

# The records this branch adds are the ones the default branch lacks; a number there never moves.
base=""
for b in "$(g symbolic-ref -q --short refs/remotes/origin/HEAD || true)" origin/main main; do
    [ -n "$b" ] && g rev-parse -q --verify "$b^{commit}" >/dev/null && { base="$b"; break; }
done
added="$(comm -23 <(sort <<<"$here") <(if [ -n "$base" ]; then tree_names "$repo" "$base"; fi | sort) | grep . || true)"

collide() {  # $1 = their names, $2 = where they are
    local name other
    for name in $added; do
        other="$(grep "^${name:0:4}-" <<<"$1" | grep -vxF "$name" || true)"
        [ -n "$other" ] || continue
        echo "collision: $name here, $(tr '\n' ' ' <<<"$other")on $2"
        rc=1
    done
}

if [ -n "$added" ]; then
    # a branch merged into HEAD has its records here already
    while read -r sha ref; do
        collide "$(tree_names "$repo" "$sha")" "$ref"
    done < <(branches --no-merged=HEAD)
    # committed records in another worktree are on its branch; only the uncommitted ones are new
    while read -r wt; do
        collide "$(comm -23 <(dir_names "$wt" | sort) <(tree_names "$wt" HEAD | sort))" "worktree $wt"
    done < <(worktrees)
fi

[ "$rc" = 0 ] && echo "adr-number: no collision ($(grep -c . <<<"$added" || true) record(s) added on this branch)"
exit "$rc"

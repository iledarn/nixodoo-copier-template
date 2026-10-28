#!/usr/bin/env python3
"""Corpus for the ADR number guard (template/.../skills/domain-modeling/scripts/adr-number.sh).

Run from the repo root: python3 tests/test_adr_number.py

Every case builds a throwaway origin (a bare repo) with two clones of it, so the script's
`git fetch origin`, its branch scan and its worktree scan all run on real git, no network.
Every case is one claim the skill's "ADR numbers" section makes.
"""

import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

SCRIPT = pathlib.Path(
    "template/{% if use_agent_layer %}.claude{% endif %}/skills/domain-modeling/scripts/adr-number.sh"
).resolve()

GIT_ENV = dict(
    os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t",
    GIT_COMMITTER_EMAIL="t@t", GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1",
)


class Box:
    def __init__(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="adr-number-"))
        self.origin = self.tmp / "origin.git"
        self.git("init", "-q", "--bare", "-b", "main", str(self.origin))
        self.a = self.tmp / "a"
        self.git("clone", "-q", str(self.origin), str(self.a))
        self.adr(self.a, "0001-first.md", "0002-second.md")
        self.commit(self.a, "main")
        self.b = self.tmp / "b"
        self.git("clone", "-q", str(self.origin), str(self.b))

    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd, env=GIT_ENV, check=True,
                              capture_output=True, text=True).stdout

    def adr(self, repo, *names):
        (repo / "docs" / "adr").mkdir(parents=True, exist_ok=True)
        for name in names:
            (repo / "docs" / "adr" / name).write_text(f"# {name}\n")

    def commit(self, repo, push_branch=None):
        self.git("add", "-A", cwd=repo)
        self.git("commit", "-qm", "c", cwd=repo)
        if push_branch:
            self.git("push", "-q", "origin", f"HEAD:{push_branch}", cwd=repo)

    def branch(self, repo, name, start="origin/main"):
        self.git("fetch", "-q", "origin", cwd=repo)
        self.git("checkout", "-q", "-b", name, start, cwd=repo)

    def run(self, cmd, repo):
        proc = subprocess.run(["bash", str(SCRIPT), cmd, str(repo)], env=GIT_ENV,
                              capture_output=True, text=True)
        return proc.returncode, proc.stdout + proc.stderr

    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


CASES = []


def case(label):
    def deco(fn):
        CASES.append((label, fn))
        return fn
    return deco


def expect(cond, detail):
    if not cond:
        raise AssertionError(detail)


@case("next on a repo with no docs/adr is 0001")
def _(b):
    fresh = b.tmp / "fresh"
    b.git("init", "-q", str(fresh))
    rc, out = b.run("next", fresh)
    expect(rc == 0 and out.strip() == "0001", (rc, out))


@case("next is the highest on the checkout + 1")
def _(b):
    rc, out = b.run("next", b.a)
    expect(rc == 0 and out.strip() == "0003", (rc, out))


@case("next sees a number another clone pushed on its own branch (fetches origin)")
def _(b):
    b.branch(b.b, "feat-b")
    b.adr(b.b, "0003-on-b.md")
    b.commit(b.b, "feat-b")
    rc, out = b.run("next", b.a)
    expect(rc == 0 and out.strip() == "0004", (rc, out))


@case("next sees an unpushed local branch and an uncommitted record in another worktree")
def _(b):
    b.git("checkout", "-q", "-b", "local-only", cwd=b.a)
    b.adr(b.a, "0005-local.md")
    b.commit(b.a)
    b.git("checkout", "-q", "main", cwd=b.a)
    wt = b.tmp / "wt"
    b.git("worktree", "add", "-q", "-b", "wt-branch", str(wt), "main", cwd=b.a)
    b.adr(wt, "0007-uncommitted.md")
    rc, out = b.run("next", b.a)
    expect(rc == 0 and out.strip() == "0008", (rc, out))


@case("check passes on a branch that adds a free number")
def _(b):
    b.branch(b.a, "feat-a")
    b.adr(b.a, "0003-mine.md")
    rc, out = b.run("check", b.a)
    expect(rc == 0 and "no collision (1 record" in out, (rc, out))


@case("check fails when an unmerged pushed branch uses the number for another record")
def _(b):
    b.branch(b.b, "feat-b")
    b.adr(b.b, "0003-theirs.md")
    b.commit(b.b, "feat-b")
    b.branch(b.a, "feat-a")
    b.adr(b.a, "0003-mine.md")
    rc, out = b.run("check", b.a)
    expect(rc == 1 and "0003-mine.md here, 0003-theirs.md on origin/feat-b" in out, (rc, out))


@case("check fails on another worktree's uncommitted record with the number")
def _(b):
    b.branch(b.a, "feat-a")
    b.adr(b.a, "0003-mine.md")
    wt = b.tmp / "wt"
    b.git("worktree", "add", "-q", "-b", "wt-branch", str(wt), "origin/main", cwd=b.a)
    b.adr(wt, "0003-parallel.md")
    rc, out = b.run("check", b.a)
    expect(rc == 1 and f"0003-parallel.md on worktree {wt.resolve()}" in out, (rc, out))


@case("check fails on two files in the checkout sharing a number (the merged-cleanly case)")
def _(b):
    b.adr(b.a, "0002-duplicate.md")
    rc, out = b.run("check", b.a)
    expect(rc == 1 and "0002 is taken twice here" in out, (rc, out))


@case("check leaves records the default branch already has alone")
def _(b):
    b.branch(b.b, "stale")
    (b.b / "docs" / "adr" / "0002-second.md").rename(b.b / "docs" / "adr" / "0002-renamed-there.md")
    b.commit(b.b, "stale")
    rc, out = b.run("check", b.a)
    expect(rc == 0 and "no collision (0 record" in out, (rc, out))


@case("check ignores a branch merged into HEAD (its old name for a renamed record)")
def _(b):
    b.branch(b.a, "feat-a")
    b.adr(b.a, "0003-old-name.md")
    b.commit(b.a, "feat-a")
    (b.a / "docs" / "adr" / "0003-old-name.md").rename(b.a / "docs" / "adr" / "0003-new-name.md")
    b.commit(b.a)
    rc, out = b.run("check", b.a)
    expect(rc == 0, ("origin/feat-a is an ancestor of HEAD", rc, out))


@case("an unreachable origin warns and still answers")
def _(b):
    shutil.rmtree(b.origin)
    rc, out = b.run("next", b.a)
    expect(rc == 0 and out.splitlines()[0] == "0003" and "fetching origin failed" in out, (rc, out))


@case("no origin remote: no fetch, no warning")
def _(b):
    b.git("remote", "remove", "origin", cwd=b.a)
    rc, out = b.run("check", b.a)
    expect(rc == 0 and "fetching" not in out, (rc, out))


def main():
    failures = 0
    for label, fn in CASES:
        box = Box()
        try:
            fn(box)
            print(f"ok    {label}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL  {label}\n      {exc}")
        finally:
            box.cleanup()
    print(f"\n{len(CASES) - failures}/{len(CASES)} passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()

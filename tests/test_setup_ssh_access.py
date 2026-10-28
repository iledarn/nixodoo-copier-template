#!/usr/bin/env python3
"""Corpus for nix/scripts/setup-ssh-access.sh: the project's .ssh/config follows the answers.

Run from the repo root: python3 tests/test_setup_ssh_access.py

It wrote .ssh/config only when the file was missing, so a host changed in the answers (a prod
box moved to its LAN address) never reached a checkout that had run it once. Each case renders
the script with an answer set and runs it in a scratch project whose key pair already exists
(ssh-keygen is never reached). CI runs this file once per push (the ssh-config job).
"""

import pathlib
import subprocess
import sys
import tempfile

import jinja2

SRC = pathlib.Path("template/nix/scripts/{% if prod_ssh_host %}setup-ssh-access.sh{% endif %}.jinja")
BASE = dict(odoo_major="16", prod_ssh_host="203.0.113.1", prod_ssh_user="ubuntu", prod_local_ssh_host="",
            test_ssh_hosts={"test": "203.0.113.2"}, test_ssh_user="ubuntu", test_ssh_port=22)
CASES = []


def case(fn):
    CASES.append(fn)
    return fn


def run(root, **answers):
    env = jinja2.Environment(trim_blocks=True, lstrip_blocks=True, keep_trailing_newline=True)
    script = root / "setup-ssh-access.sh"
    script.write_text(env.from_string(SRC.read_text()).render(**{**BASE, **answers}))
    (root / ".ssh").mkdir(exist_ok=True)
    for name in ("odoo16", "odoo16.pub"):
        (root / ".ssh" / name).touch()
    proc = subprocess.run(["bash", str(script)], cwd=root, capture_output=True, text=True, timeout=20)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return proc.stdout


def hosts(config):
    """{alias: HostName} of a config."""
    found, alias = {}, None
    for line in config.read_text().splitlines():
        words = line.split()
        if words[:1] == ["Host"]:
            alias = words[1]
        elif words[:1] == ["HostName"]:
            found[alias] = words[1]
    return found


@case
def a_new_checkout_gets_the_config():
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        out = run(root)
        config = root / ".ssh/config"
        assert "Wrote" in out and hosts(config) == {"prod": "203.0.113.1", "test": "203.0.113.2"}, out
        assert f"IdentityFile {root}/.ssh/odoo16" in config.read_text()
        assert config.stat().st_mode & 0o777 == 0o644 and not list(root.glob(".ssh/config.*")), list(root.iterdir())


@case
def a_changed_host_replaces_the_config_and_keeps_the_old_one():
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        run(root, prod_local_ssh_host="10.0.0.5")
        config = root / ".ssh/config"
        before = config.read_text()
        out = run(root, prod_ssh_host="10.0.0.5")
        assert hosts(config) == {"prod": "10.0.0.5", "test": "203.0.113.2"}, config.read_text()
        assert (root / ".ssh/config.bak").read_text() == before, out
        assert "-  HostName 203.0.113.1" in out and "-Host prod-local" in out and f"+++ {config}\n" in out, out
        assert sorted(p.name for p in (root / ".ssh").iterdir()) == ["config", "config.bak", "odoo16", "odoo16.pub"]


@case
def an_unchanged_config_is_left_alone():
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        run(root)
        config = root / ".ssh/config"
        stamp = config.stat().st_mtime_ns
        out = run(root)
        assert "up to date" in out and config.stat().st_mtime_ns == stamp, out
        assert not (root / ".ssh/config.bak").exists() and len(list((root / ".ssh").iterdir())) == 3, out


if __name__ == "__main__":
    failed = 0
    for fn in CASES:
        try:
            fn()
            print(f"  ok   {fn.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL {fn.__name__}: {exc}")
    print("PASS" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)

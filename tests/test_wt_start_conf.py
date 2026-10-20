#!/usr/bin/env python3
"""Corpus for the per-session odoo.conf that worktree-env's wt-start.sh writes.

Run from the repo root: python3 tests/test_wt_start_conf.py

The heredoc used to hardcode server_wide_modules=base,web,queue_job,
longpolling_port and db_user/db_password odoo, whatever the answers said: a
project without queue_job logged "Couldn't load module queue_job" in every
session, and Odoo 17+ got the pre-17 port name. Each case renders the script
with an answer set and reads the [options] block back.
"""

import os
import pathlib
import re
import sys

import jinja2

SRC = pathlib.Path(
    "template/{% if use_agent_layer %}.claude{% endif %}/skills"
    "/{% if custom_repo_name %}worktree-env{% endif %}/scripts/wt-start.sh.jinja"
)
TEST_SRC = SRC.with_name("wt-test.sh.jinja")
COMMON_SRC = SRC.with_name("wt-common.sh.jinja")

BASE = dict(
    odoo_version="16.0", odoo_major="16", use_queue_job=True, db_user="odoo", db_password="odoo",
    postgres_port=16432, service_suffix="", backup_s3_bucket="bucket",
)


def render(**answers):
    env = jinja2.Environment(trim_blocks=True, lstrip_blocks=True, keep_trailing_newline=True)
    return env.from_string(SRC.read_text()).render(**{**BASE, **answers})


def sections(text):
    block = re.search(r'cat > "\$CONF" <<EOF\n(.*?)\nEOF\n', text, re.S).group(1)
    found, current = {}, None
    for line in block.splitlines():
        if re.fullmatch(r"\[[a-z_]+\]", line):
            current = found.setdefault(line[1:-1], {})
        elif line:
            key, value = line.split(" = ", 1)
            current[key] = value
    return found


def conf(text):
    return sections(text)["options"]


CASES = []


def case(fn):
    CASES.append(fn)
    return fn


@case
def queue_job_follows_the_answer():
    assert conf(render(use_queue_job=True))["server_wide_modules"] == "base,web,queue_job"
    assert conf(render(use_queue_job=False))["server_wide_modules"] == "base,web"


@case
def port_name_follows_the_major():
    for major, key, other in (("16", "longpolling_port", "gevent_port"),
                              ("17", "gevent_port", "longpolling_port"),
                              ("20", "gevent_port", "longpolling_port")):
        c = conf(render(odoo_version=f"{major}.0", odoo_major=major))
        assert c.get(key) == "$((PORT + 1000))", (major, c)
        assert other not in c, (major, c)


@case
def db_connection_comes_from_wt_common():
    # host/port/password are wt-common's WT_* (answers by default, .env overrides);
    # the role stays the answer
    c = conf(render(db_user="erp", db_password="s3cret"))
    assert (c["db_user"], c["db_host"], c["db_port"], c["db_password"]) == \
        ("erp", "$WT_DB_HOST", "$WT_DB_PORT", "$WT_DB_PASSWORD"), c


def common_vars(env_lines=None, **answers):
    """Source the rendered wt-common.sh in bash (PROJ = a temp dir holding .env)
    and return the WT_* values and PSQL it ends up with."""
    import subprocess, tempfile
    text = jinja2.Environment(trim_blocks=True, lstrip_blocks=True, keep_trailing_newline=True).from_string(
        COMMON_SRC.read_text()).render(**{**BASE, "project_dir_var": "PROJ_DIR", "project_name": "proj",
                                          "custom_repo_name": "addons", **answers})
    with tempfile.TemporaryDirectory() as d:
        if env_lines is not None:
            pathlib.Path(d, ".env").write_text("\n".join(env_lines) + "\n")
        common = pathlib.Path(d, "wt-common.sh")
        common.write_text(text)
        names = ("WT_DB_HOST", "WT_DB_PORT", "WT_DB_PASSWORD", "WT_HTTP_INTERFACE", "WT_HOST_SUFFIX", "PSQL", "PGPASSWORD")
        out = subprocess.run(
            ["bash", "-c", 'set -euo pipefail; source "$1"; for v in ' + " ".join(names) + '; do printf "%s=%s\\n" "$v" "${!v}"; done; session_host wt_x',
             "_", str(common)],
            env={"PATH": os.environ["PATH"], "HOME": d, "PROJ_DIR": d}, capture_output=True, text=True, check=True).stdout
    lines = out.splitlines()
    vals = dict(line.split("=", 1) for line in lines[:-1])
    vals["session_host"] = lines[-1]
    return vals


@case
def without_overrides_a_session_is_local():
    for env_lines in (None, ["PGHOST=elsewhere", "ODOO_URL=http://x"]):
        v = common_vars(env_lines, db_password="s3cret", postgres_port=16432)
        assert (v["WT_DB_HOST"], v["WT_DB_PORT"], v["WT_DB_PASSWORD"], v["WT_HTTP_INTERFACE"], v["WT_HOST_SUFFIX"]) == \
            ("localhost", "16432", "s3cret", "::1", "localhost"), (env_lines, v)
        assert v["PSQL"] == "psql -h localhost -p 16432 -U odoo" and v["PGPASSWORD"] == "s3cret", v
        assert v["session_host"] == "wt_x.localhost", v


@case
def a_shared_test_server_overrides_from_dotenv():
    v = common_vars(["PGPASSWORD=ignored", "WT_DB_HOST=10.0.0.5", "WT_DB_PORT=5432", "WT_DB_PASSWORD=p=w d",
                     "WT_HTTP_INTERFACE=0.0.0.0", "WT_HOST_SUFFIX=box1.lan", "WT_EVIL=1", "#WT_DB_HOST=no"])
    assert (v["WT_DB_HOST"], v["WT_DB_PORT"], v["WT_DB_PASSWORD"], v["WT_HTTP_INTERFACE"], v["WT_HOST_SUFFIX"]) == \
        ("10.0.0.5", "5432", "p=w d", "0.0.0.0", "box1.lan"), v
    assert v["PSQL"] == "psql -h 10.0.0.5 -p 5432 -U odoo" and v["PGPASSWORD"] == "p=w d", v
    assert v["session_host"] == "wt_x.box1.lan", v


@case
def no_report_url_option():
    assert "report_url" not in conf(render())


@case
def report_url_param_pinned_before_the_restart():
    text = render()
    marker = "VALUES ('report.url', 'http://$HOST:$PORT')"
    assert marker in text, "wt-start does not pin report.url"
    pin = text.index(marker)
    assert text.index('bash "$WT_SCRIPT_DIR/wt-restore.sh"') < pin < text.index("systemctl --user restart"), \
        "report.url must be pinned after the restore and before the restart"


@case
def the_host_names_the_database():
    # http://wt_<slug>.localhost:<port>: %d is the first label of the Host, and
    # *.localhost resolves to ::1, the only interface a session listens on (a
    # prod copy with admin/admin stays off the LAN)
    # (locally; a shared test server moves both through WT_HTTP_INTERFACE / WT_HOST_SUFFIX)
    c = conf(render())
    assert (c["dbfilter"], c["http_interface"]) == ("^%d\\$", "$WT_HTTP_INTERFACE"), c
    text = render()
    assert 'HOST="$(session_host "$DB")"' in text
    assert 'echo "URL: http://$HOST:$PORT/web"' in text


@case
def no_attachment_seed_from_a_main_database():
    assert "SEED_FILESTORE" not in render()


@case
def the_queue_job_runner_reaches_the_session():
    # the runner's job URL is http://<host>:<port>/queue_job/runjob: left to http_interface
    # the host is ::1 (an invalid URL host), and only the DB-named host passes ^%d$
    c = sections(render(use_queue_job=True))["queue_job"]
    assert c == {"channels": "root:3", "host": "$HOST", "port": "$PORT"}, c
    assert "queue_job" not in sections(render(use_queue_job=False))


@case
def a_test_run_talks_to_ipv4_loopback_with_the_session_db():
    text = jinja2.Environment(trim_blocks=True, lstrip_blocks=True, keep_trailing_newline=True).from_string(
        TEST_SRC.read_text()).render(nix_profile_rel=".nix-profile", module_prefix="acme")
    run = text[text.index('exec "$HOME/.nix-profile/bin/odoo"'):]
    for flag in ('-c "$CONF"', "--http-interface 127.0.0.1", '--http-port "$PORT"', '--db-filter "^${DB}\\$"', '"$@"'):
        assert flag in run, (flag, run)


@case
def every_line_of_the_block_is_one_option_or_a_section():
    for answers in ({}, {"use_queue_job": False}, {"odoo_version": "20.0", "odoo_major": "20"}):
        block = re.search(r'<<EOF\n(.*?)\nEOF\n', render(**answers), re.S).group(1).splitlines()
        assert block[0] == "[options]", block[0]
        assert all(re.fullmatch(r"[a-z_]+ = \S.*|\[[a-z_]+\]|", line) for line in block[1:]), (answers, block)


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

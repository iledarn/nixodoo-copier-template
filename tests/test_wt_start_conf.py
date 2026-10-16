#!/usr/bin/env python3
"""Corpus for the per-session odoo.conf that worktree-env's wt-start.sh writes.

Run from the repo root: python3 tests/test_wt_start_conf.py

The heredoc used to hardcode server_wide_modules=base,web,queue_job,
longpolling_port and db_user/db_password odoo, whatever the answers said: a
project without queue_job logged "Couldn't load module queue_job" in every
session, and Odoo 17+ got the pre-17 port name. Each case renders the script
with an answer set and reads the [options] block back.
"""

import pathlib
import re
import sys

import jinja2

SRC = pathlib.Path(
    "template/{% if use_agent_layer %}.claude{% endif %}/skills"
    "/{% if custom_repo_name %}worktree-env{% endif %}/scripts/wt-start.sh.jinja"
)
TEST_SRC = SRC.with_name("wt-test.sh.jinja")

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
def db_credentials_come_from_the_answers():
    c = conf(render(db_user="erp", db_password="s3cret"))
    assert (c["db_user"], c["db_password"]) == ("erp", "s3cret"), c


@case
def no_report_url_option():
    assert "report_url" not in conf(render())


@case
def report_url_param_pinned_before_the_restart():
    text = render()
    marker = "VALUES ('report.url', 'http://$DB.localhost:$PORT')"
    assert marker in text, "wt-start does not pin report.url"
    pin = text.index(marker)
    assert text.index('bash "$WT_SCRIPT_DIR/wt-restore.sh"') < pin < text.index("systemctl --user restart"), \
        "report.url must be pinned after the restore and before the restart"


@case
def the_host_names_the_database():
    # http://wt_<slug>.localhost:<port>: %d is the first label of the Host, and
    # *.localhost resolves to ::1, the only interface a session listens on (a
    # prod copy with admin/admin stays off the LAN)
    c = conf(render())
    assert (c["dbfilter"], c["http_interface"]) == ("^%d\\$", "::1"), c
    assert 'echo "URL: http://$DB.localhost:$PORT/web"' in render()


@case
def no_attachment_seed_from_a_main_database():
    assert "SEED_FILESTORE" not in render()


@case
def the_queue_job_runner_reaches_the_session():
    # the runner's job URL is http://<host>:<port>/queue_job/runjob: left to http_interface
    # the host is ::1 (an invalid URL host), and only the DB-named host passes ^%d$
    c = sections(render(use_queue_job=True))["queue_job"]
    assert c == {"channels": "root:3", "host": "$DB.localhost", "port": "$PORT"}, c
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

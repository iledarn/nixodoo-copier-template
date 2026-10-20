#!/usr/bin/env python3
"""Corpus for the per-session odoo.conf that worktree-env's wt-start.sh writes.

Run from the repo root: python3 tests/test_wt_start_conf.py

The heredoc used to hardcode server_wide_modules=base,web,queue_job,
longpolling_port and db_user/db_password odoo, whatever the answers said: a
project without queue_job logged "Couldn't load module queue_job" in every
session, and Odoo 17+ got the pre-17 port name. Each case renders the script
with an answer set and reads the [options] block back.

The wt-test.sh cases run the rendered wrapper with psql and odoo stubbed, plus
its module-state query against a live PostgreSQL when one answers (else skip).
The Claude-worktree cases run the rendered wt-start.sh up to its bootstrap step.
"""

import itertools
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

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


def render_script(src):
    env = jinja2.Environment(trim_blocks=True, lstrip_blocks=True, keep_trailing_newline=True)
    answers = dict(BASE, project_dir_var="WT_TEST_PROJECT_DIR", project_name="p", custom_repo_name="acme-addons",
                   nix_profile_rel=".nix-profile", module_prefix="acme")
    return env.from_string(src.read_text()).render(**answers)


CASES = []


class Skip(Exception):
    pass


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
    text = render_script(TEST_SRC)
    run = text[text.index('ODOO=("$HOME/.nix-profile/bin/odoo"'):]
    for flag in ('-c "$CONF"', "--http-interface 127.0.0.1", '--http-port "$PORT"', '--db-filter "^${DB}\\$"'):
        assert flag in run[:run.index(")\n")], (flag, run)
    assert 'exec "${ODOO[@]}" "$@"' in run and '"$@" 2>&1 | tee' in run, run


def stub(argv_file, body):
    return f'#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "{argv_file}"\n{body}'


def read_argv(path):
    return path.read_text().splitlines() if path.exists() else None


def psql_vars(argv):
    return dict(argv[i + 1].split("=", 1) for i, arg in enumerate(argv or []) if arg == "-v")


def run_wt_test(args, missing="", psql_rc=0, odoo_out="", odoo_rc=0):
    """Run the rendered wt-test.sh for slug `x` with psql and odoo stubbed.

    The psql stub answers the module-state query with `missing` and exits
    `psql_rc`; the odoo stub logs `odoo_out` to stderr, as Odoo does, and exits
    `odoo_rc`. Returns (exit code, stdout+stderr, psql argv, odoo argv), an argv
    being None when that program did not run.
    """
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        scripts, bin_dir, odoo_bin = root / "scripts", root / "bin", root / ".nix-profile/bin"
        for d in (scripts, bin_dir, odoo_bin, root / ".worktrees/_env/x"):
            d.mkdir(parents=True)
        (root / ".worktrees/_env/x/odoo.conf").write_text("[options]\n")
        for src in (TEST_SRC, TEST_SRC.with_name("wt-common.sh.jinja")):
            (scripts / src.name.removesuffix(".jinja")).write_text(render_script(src))
        (bin_dir / "psql").write_text(stub(root / "psql.argv", f"cat > /dev/null\nprintf '%s' {shlex.quote(missing)}\n"
                                                               f"exit {psql_rc}\n"))
        (odoo_bin / "odoo").write_text(stub(root / "odoo.argv", f'printf "%s\\n" {shlex.quote(odoo_out)} >&2\n'
                                                                f"exit {odoo_rc}\n"))
        for f in (bin_dir / "psql", odoo_bin / "odoo"):
            f.chmod(0o755)
        proc = subprocess.run(
            ["bash", str(scripts / "wt-test.sh"), "x", *args], capture_output=True, text=True,
            env={**os.environ, "HOME": tmp, "WT_TEST_PROJECT_DIR": tmp, "PATH": f"{bin_dir}:{os.environ['PATH']}"})
        return (proc.returncode, proc.stdout + proc.stderr,
                read_argv(root / "psql.argv"), read_argv(root / "odoo.argv"))


RESULT = "INFO wt_x odoo.tests.result: {} failed, 0 error(s) of {} tests when loading database 'wt_x'"


@case
def an_update_of_a_module_the_db_lacks_stops_before_odoo():
    rc, out, psql, odoo = run_wt_test(["-u", "acme_new", "--test-enable", "--test-tags", "/acme_new"],
                                      missing="acme_new uninstalled\n")
    assert (rc, psql_vars(psql).get("modules"), odoo) == (2, "acme_new", None), (rc, psql, odoo, out)
    assert "acme_new is uninstalled in wt_x" in out and "-i acme_new" in out, out


@case
def every_update_and_init_spelling_reaches_the_module_check():
    _rc, out, psql, _odoo = run_wt_test(["-u", "a,b", "--update=c", "-ud", "-i", "e", "--init=f", "-ig",
                                         "--test-tags=/a"], odoo_out=RESULT.format(0, 3))
    found = psql_vars(psql)
    assert (found.get("modules"), found.get("init")) == ("a,b,c,d", "e,f,g"), (psql, out)


@case
def the_module_check_skips_psqlrc_and_stops_on_a_sql_error():
    _rc, out, psql, _odoo = run_wt_test(["-u", "acme_mod"])
    assert "-X" in (psql or []) and psql_vars(psql).get("ON_ERROR_STOP") == "1", (psql, out)


@case
def unreadable_module_states_stop_before_odoo():
    rc, out, _psql, odoo = run_wt_test(["-u", "acme_mod", "--test-enable"], psql_rc=2)
    assert (rc, odoo) == (1, None), (rc, odoo, out)
    assert "cannot read module states from wt_x" in out, out


@case
def a_module_list_with_a_space_is_refused_with_its_spelling():
    for args in (["-u", "acme_sale, acme_stock"], ["-u", "acme_sale", "-i", "acme_x ,acme_y"]):
        rc, out, psql, odoo = run_wt_test([*args, "--test-enable"])
        assert (rc, psql, odoo) == (2, None, None), (args, rc, psql, odoo, out)
        assert "write " + args[-1].replace(" ", "") in out, out


STATE_FIXTURE = ("(VALUES ('a', 'installed'), ('b', 'to upgrade'), ('c', 'to install'), ('d', 'uninstalled'))"
                 " AS ir_module_module(name, state)")


def missing_modules(modules, init=""):
    """The module-state query of the rendered wt-test.sh, run on the live server
    against STATE_FIXTURE in place of ir_module_module (read-only)."""
    sql = re.search(r"<<'SQL'\n(.*?\n)SQL\n", render_script(TEST_SRC), re.S).group(1)
    assert sql.count("ir_module_module") == 1, sql
    psql = ["psql", "-X", "-h", "localhost", "-p", str(BASE["postgres_port"]), "-U", BASE["db_user"], "-d", "postgres"]
    env = {**os.environ, "PGPASSWORD": BASE["db_password"], "PGCONNECT_TIMEOUT": "3"}
    probe = shutil.which("psql") and subprocess.run([*psql, "-c", "SELECT 1"], capture_output=True, text=True, env=env)
    if not probe or probe.returncode:
        raise Skip(f"no PostgreSQL on localhost:{BASE['postgres_port']}")
    proc = subprocess.run([*psql, "-tA", "-F", " ", "-v", "ON_ERROR_STOP=1", "-v", f"modules={modules}",
                           "-v", f"init={init}"], input=sql.replace("ir_module_module", STATE_FIXTURE),
                          capture_output=True, text=True, env=env)
    assert proc.returncode == 0, proc.stderr
    return set(proc.stdout.splitlines())


@case
def the_module_check_passes_what_an_update_run_loads():
    found = missing_modules("a,b,c,d,e,all,")
    assert found == {"d uninstalled", "e absent"}, found
    found = missing_modules("a,d,e", init="d,e")
    assert found == set(), found


@case
def a_test_run_that_ran_no_test_fails():
    for selector in (["--test-tags", "acme_mod.test_file"], ["--test-tags=/acme_mod:NoSuchClass"]):
        rc, out, _psql, odoo = run_wt_test(selector, odoo_out=RESULT.format(0, 0))
        assert rc == 3 and odoo is not None, (selector, rc, odoo, out)
        assert "executed 0 tests" in out, out


@case
def a_test_run_with_tests_keeps_odoos_exit_code_and_output():
    rc, out, _psql, _odoo = run_wt_test(["-u", "acme_mod", "--test-enable"], odoo_out=RESULT.format(0, 12))
    assert rc == 0 and RESULT.format(0, 12) in out, (rc, out)
    rc, out, _psql, _odoo = run_wt_test(["--test-tags", "/acme_mod"], odoo_out=RESULT.format(2, 12), odoo_rc=1)
    assert rc == 1 and "executed 0 tests" not in out, (rc, out)


@case
def the_test_summary_shows_under_any_log_level():
    _rc, out, _psql, odoo = run_wt_test(["--test-enable", "--log-level=warn"], odoo_out=RESULT.format(0, 4))
    assert ("--log-handler", "odoo.tests.result:INFO") in itertools.pairwise(odoo), (odoo, out)


@case
def a_test_file_alone_is_not_counted():
    rc, out, _psql, odoo = run_wt_test(["--test-file", "acme_mod/tests/test_x.py"])
    assert rc == 0 and odoo is not None and "WARNING" not in out and "0 tests" not in out, (rc, odoo, out)


@case
def a_test_run_without_a_summary_keeps_odoos_exit_code_and_warns():
    rc, out, _psql, _odoo = run_wt_test(["--test-enable", "--logfile=/var/tmp/own.log"])
    assert rc == 0 and "no test summary in the output" in out and "executed 0 tests" not in out, (rc, out)


@case
def a_crashed_test_run_keeps_its_exit_code():
    rc, out, _psql, _odoo = run_wt_test(["--test-enable"], odoo_out="CRITICAL wt_x odoo.service.server: boom",
                                        odoo_rc=255)
    assert rc == 255 and "executed 0 tests" not in out and "WARNING" not in out, (rc, out)


@case
def a_run_without_tests_is_not_counted():
    rc, out, psql, odoo = run_wt_test(["-u", "all"])
    assert (rc, psql_vars(psql).get("modules"), odoo is not None) == (0, "all", True), (rc, psql, odoo, out)


@case
def every_line_of_the_block_is_one_option_or_a_section():
    for answers in ({}, {"use_queue_job": False}, {"odoo_version": "20.0", "odoo_major": "20"}):
        block = re.search(r'<<EOF\n(.*?)\nEOF\n', render(**answers), re.S).group(1).splitlines()
        assert block[0] == "[options]", block[0]
        assert all(re.fullmatch(r"[a-z_]+ = \S.*|\[[a-z_]+\]|", line) for line in block[1:]), (answers, block)



def run_wt_start_from(where, allow=False):
    """Run the rendered wt-start.sh for slug `x` with the cwd at `where` under the project.

    wt-bootstrap.sh is a stub that exits 7, so a run that got past the Claude-worktree
    check stops there. Returns (exit code, stdout+stderr).
    """
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        scripts, cwd = root / "scripts", root / where
        for d in (scripts, cwd):
            d.mkdir(parents=True, exist_ok=True)
        for src in (SRC, SRC.with_name("wt-common.sh.jinja")):
            (scripts / src.name.removesuffix(".jinja")).write_text(render_script(src))
        (scripts / "wt-bootstrap.sh").write_text("echo BOOTSTRAP; exit 7\n")
        env = {**os.environ, "HOME": tmp, "WT_TEST_PROJECT_DIR": tmp}
        env.pop("WT_ALLOW_CLAUDE_WORKTREE", None)
        if allow:
            env["WT_ALLOW_CLAUDE_WORKTREE"] = "1"
        proc = subprocess.run(["bash", str(scripts / "wt-start.sh"), "x"], cwd=cwd,
                              capture_output=True, text=True, env=env)
        return proc.returncode, proc.stdout + proc.stderr


@case
def a_claude_worktree_session_is_refused_before_anything_is_made():
    # the desktop app's worktree guard refuses Edit/Write in the base checkout, and the
    # env's code worktree would be there: the session would get an env it cannot edit
    rc, out = run_wt_start_from(".claude/worktrees/w/src")
    assert rc == 4 and "BOOTSTRAP" not in out, (rc, out)
    assert "Claude worktree" in out and "/.worktrees/x" in out and "WT_ALLOW_CLAUDE_WORKTREE=1" in out, out


@case
def the_base_checkout_and_its_addons_worktrees_go_through():
    for where in (".", "src/acme-addons", ".worktrees/x", ".claude/skills"):
        rc, out = run_wt_start_from(where)
        assert (rc, out.strip()) == (7, "BOOTSTRAP"), (where, rc, out)


@case
def the_override_lets_a_claude_worktree_through():
    rc, out = run_wt_start_from(".claude/worktrees/w", allow=True)
    assert (rc, out.strip()) == (7, "BOOTSTRAP"), (rc, out)


if __name__ == "__main__":
    failed = 0
    for fn in CASES:
        try:
            fn()
            print(f"  ok   {fn.__name__}")
        except Skip as exc:
            print(f"  skip {fn.__name__}: {exc}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL {fn.__name__}: {exc}")
    print("PASS" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)

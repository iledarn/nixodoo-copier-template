#!/usr/bin/env python3
"""Bring Claude Code settings up to the team's: add what is missing, never overwrite.

    sync.py check      [--connector NAME=SERVER ...]   what apply would do; writes nothing
    sync.py apply      [--connector NAME=SERVER ...]   everyone, on any machine
    sync.py save       [--connector NAME=SERVER ...]   the maintainer: the project layer from their settings
    sync.py connectors                                 the connectors the layers name, as JSON

Two layers, the second applied over the first:
  baseline/ beside this file   from the copier template: settings any project of it shares
  .claude/settings-sync/       this project's own (not the template's): what only it needs, and
                               `maintainer`, the git email whose `save` writes it
Each holds user.json (for ~/.claude/settings.json), local.json (for the checkout's
.claude/settings.local.json), files/ (a hook's script under ~/.claude/hooks/) and connectors.json.

Paths are stored as placeholders, so a layer saved on one machine applies on another: @HOME@,
@PROJECT@ (this checkout) and @PROJECT_SLUG@ (its folder name under ~/.claude/projects). A claude.ai
connector's server name differs per account and per app, so a layer names it @NAME@ and declares it in
connectors.json by the tools it carries ({"NAME": ["tool", ...]}): the /settings-sync command finds
the server in the session and passes it in as --connector NAME=SERVER.

apply adds a missing key, a missing list item and a missing file. A setting you have with another
value is kept and reported. A file is backed up beside itself before it is written.

The layers sit in a shared repository, so they are read as someone else's word: check comes first
and marks with ! what runs code or widens what Claude may do unasked (hooks, permissions, autoMode,
env), a file lands only under ~/.claude/hooks/, and save leaves out what looks like a secret.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
PLACEHOLDER = re.compile(r'@([A-Z][A-Z0-9_]*)@')
BUILTIN = ('PROJECT_SLUG', 'PROJECT', 'HOME')
# a hook command naming a file under the home folder: what a layer carries in files/
HOME_FILE = re.compile(r'@HOME@/(\.claude/[^\s"\']+)')
# where a layer may put a file: a hook's script, nothing else under the home folder
FILES_ROOT = ('.claude', 'hooks')
# what `save` leaves out, the layer going into a shared repository: a variable named like a secret,
# and any value in the shape of a key, a token or a password
SECRET_NAME = re.compile(r'KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH', re.IGNORECASE)
SECRET_VALUE = re.compile(
    r'sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}'
    r'|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.'
    r'|(?i:bearer\s+[A-Za-z0-9._~+/-]{16,})'
    r'|(?i:(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*["\']?[^\s"\']{6,})'
)
# settings that run code or widen what Claude may do unasked: check and apply mark them for review
SENSITIVE = {
    'hooks', 'permissions', 'autoMode', 'env', 'enableAllProjectMcpServers', 'apiKeyHelper', 'statusLine',
    'enabledPlugins', 'extraKnownMarketplaces', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper',
}


@dataclass
class Place:
    """Where the settings live on this machine, and the layers that describe them."""

    home: Path
    project: Path
    template_layer: Path = HERE / 'baseline'

    @property
    def project_layer(self) -> Path:
        return self.project / '.claude' / 'settings-sync'

    @property
    def slug(self) -> str:
        # how Claude Code names a project's folder under ~/.claude/projects
        return re.sub(r'[^A-Za-z0-9]', '-', str(self.project))

    @property
    def user_file(self) -> Path:
        return self.home / '.claude' / 'settings.json'

    @property
    def local_file(self) -> Path:
        return self.project / '.claude' / 'settings.local.json'

    def builtins(self) -> dict[str, str]:
        return {'PROJECT_SLUG': self.slug, 'PROJECT': str(self.project), 'HOME': str(self.home)}


@dataclass
class Report:
    # (setting path, line)
    added: list[tuple[str, str]] = field(default_factory=list)
    kept: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def short(value: Any) -> str:
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= 110 else text[:107] + '...'


def read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise SystemExit(f'{path} is not a JSON object')
    return data


def write_json(path: Path, data: dict, stamp: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        shutil.copy2(path, path.with_name(f'{path.name}.bak-{stamp}'))
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')


def declared_connectors(place: Place) -> dict[str, list[str]]:
    """The connectors the layers name, each with the tools that tell its server apart."""
    found: dict[str, list[str]] = {}
    for layer in (place.template_layer, place.project_layer):
        for name, tools in read_json(layer / 'connectors.json').items():
            if re.fullmatch(r'[A-Z][A-Z0-9_]*', name) and name not in BUILTIN and isinstance(tools, list):
                found[name] = sorted({*found.get(name, []), *map(str, tools)})
    return found


def to_template(value: Any, place: Place, connectors: dict[str, list[str]]) -> Any:
    """A setting as a layer stores it: this machine's paths and connector servers made placeholders."""
    if isinstance(value, dict):
        return {key: to_template(item, place, connectors) for key, item in value.items()}
    if isinstance(value, list):
        return [to_template(item, place, connectors) for item in value]
    if not isinstance(value, str):
        return value
    for name, actual in place.builtins().items():
        value = value.replace(actual, f'@{name}@')
    for name, servers in connectors.items():
        for server in servers:
            value = value.replace(f'mcp__{server}__', f'mcp__@{name}@__')
    return value


def expand(text: str, place: Place, connectors: dict[str, list[str]]) -> list[str] | None:
    """A stored string on this machine: one per server of a connector it names; None when a
    connector it names was not found in the session. `connectors` holds every declared name."""
    for name, actual in place.builtins().items():
        text = text.replace(f'@{name}@', actual)
    named = [name for name in PLACEHOLDER.findall(text) if name in connectors]
    if not named:
        return [text]
    results = [text]
    for name in dict.fromkeys(named):
        servers = connectors.get(name, [])
        if not servers:
            return None
        results = [item.replace(f'@{name}@', server) for item in results for server in servers]
    return results


def from_template(value: Any, place: Place, connectors: dict[str, list[str]], report: Report, path: str) -> Any:
    """A layer on this machine; what names a connector not found here is left out and reported."""
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            here = f'{path}.{key}' if path else key
            if isinstance(item, str):
                found = expand(item, place, connectors)
                if found is None:
                    report.skipped.append(f'{here}: {short(item)} (its connector is not in this session)')
                    continue
                out[key] = found[0]
            else:
                out[key] = from_template(item, place, connectors, report, here)
        return out
    if isinstance(value, list):
        out_list: list[Any] = []
        for item in value:
            if isinstance(item, str):
                found = expand(item, place, connectors)
                if found is None:
                    report.skipped.append(f'{path}[]: {short(item)} (its connector is not in this session)')
                    continue
                out_list.extend(found)
            else:
                out_list.append(from_template(item, place, connectors, report, path))
        return out_list
    return value


def fill_missing(current: dict, wanted: dict, report: Report | None, path: str = '') -> None:
    """Add to `current` what `wanted` has and it lacks; a value it holds otherwise stays."""
    for key, want in wanted.items():
        here = f'{path}.{key}' if path else key
        if key not in current:
            current[key] = copy.deepcopy(want)
            if report is not None:
                report.added.append((here, f'{here} = {short(want)}'))
            continue
        have = current[key]
        if isinstance(want, dict) and isinstance(have, dict):
            fill_missing(have, want, report, here)
        elif isinstance(want, list) and isinstance(have, list):
            for item in want:
                if item not in have:
                    have.append(copy.deepcopy(item))
                    if report is not None:
                        report.added.append((here, f'{here} += {short(item)}'))
        elif have != want and report is not None:
            report.kept.append(f'{here}: yours {short(have)}, baseline {short(want)}')


def subtract(current: Any, base: Any) -> Any:
    """What `current` holds that `base` does not: the project layer is the settings less the template's."""
    if isinstance(current, dict) and isinstance(base, dict):
        out = {}
        for key, value in current.items():
            if key not in base:
                out[key] = value
                continue
            rest = subtract(value, base[key])
            if rest is not None:
                out[key] = rest
        return out or None
    if isinstance(current, list) and isinstance(base, list):
        return [item for item in current if item not in base] or None
    return None if current == base else current


def layered(name: str, place: Place) -> dict:
    """One settings file as the two layers ask for it, the project's over the template's."""
    wanted = read_json(place.project_layer / name)
    fill_missing(wanted, read_json(place.template_layer / name), None)
    return wanted


def is_hook_file(home: Path, relative: Path) -> bool:
    """A path a layer may carry: under ~/.claude/hooks/, with no way out of it."""
    if relative.is_absolute() or '..' in relative.parts or relative.parts[: len(FILES_ROOT)] != FILES_ROOT:
        return False
    root = home.joinpath(*FILES_ROOT).resolve()
    return home.joinpath(relative).resolve().is_relative_to(root)


def mark(path: str) -> str:
    return '!' if re.split(r'[.\[]', path, maxsplit=1)[0] in SENSITIVE else '+'


def without_secrets(value: Any, path: str, lines: list[str]) -> Any:
    """The settings less every value shaped like a secret, and env variables named like one."""
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            here = f'{path}.{key}' if path else key
            if path == 'env' and SECRET_NAME.search(key):
                lines.append(f'left out {here}: named like a secret')
            elif isinstance(item, str) and SECRET_VALUE.search(item):
                lines.append(f'left out {here}: its value looks like a secret')
            else:
                out[key] = without_secrets(item, here, lines)
        return out
    if isinstance(value, list):
        kept = []
        for item in value:
            if isinstance(item, str) and SECRET_VALUE.search(item):
                lines.append(f'left out an item of {path}: it looks like a secret')
            else:
                kept.append(without_secrets(item, path, lines))
        return kept
    return value


def apply(place: Place, connectors: dict[str, list[str]], dry_run: bool, stamp: str) -> list[str]:
    lines: list[str] = []
    for label, target, name in (
        ('~/.claude/settings.json', place.user_file, 'user.json'),
        ('.claude/settings.local.json', place.local_file, 'local.json'),
    ):
        report = Report()
        wanted = from_template(layered(name, place), place, connectors, report, '')
        current = read_json(target)
        fill_missing(current, wanted, report)
        if report.added and not dry_run:
            write_json(target, current, stamp)
        verb = 'would add' if dry_run else 'added'
        lines.append(f'{label}: {verb} {len(report.added)}, kept {len(report.kept)} of yours, skipped {len(report.skipped)}')
        lines += [f'  {mark(path)} {line}' for path, line in report.added]
        lines += [f'  = {line}' for line in report.kept]
        lines += [f'  - {line}' for line in report.skipped]
    seen: set[Path] = set()
    for layer in (place.project_layer, place.template_layer):
        files = layer / 'files'
        for source in sorted(path for path in files.rglob('*') if path.is_file()) if files.exists() else []:
            relative = source.relative_to(files)
            if relative in seen:
                continue
            seen.add(relative)
            if source.is_symlink() or not is_hook_file(place.home, relative):
                lines.append(f'refused ~/{relative}: a layer restores files under ~/.claude/hooks/ only')
                continue
            target = place.home / relative
            if target.exists():
                continue
            digest = hashlib.sha256(source.read_bytes()).hexdigest()[:12]
            size = len(source.read_text(errors='replace').splitlines())
            lines.append(f'  ! {"would restore" if dry_run else "restored"} ~/{relative} ({size} lines, sha256 {digest})')
            if not dry_run:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                target.chmod(0o755)
    return lines


def save(place: Place, connectors: dict[str, list[str]]) -> list[str]:
    """The project layer: your settings less what the template's layer already gives."""
    layer = place.project_layer
    layer.mkdir(parents=True, exist_ok=True)
    lines = []
    for name, source in (('user.json', place.user_file), ('local.json', place.local_file)):
        mine = without_secrets(to_template(read_json(source), place, connectors), '', lines)
        rest = subtract(mine, read_json(place.template_layer / name)) or {}
        (layer / name).write_text(json.dumps(rest, indent=2, ensure_ascii=False) + '\n')
        lines.append(f'saved {source} -> {layer}/{name} (less what the template layer gives)')
        for match in HOME_FILE.finditer(json.dumps(mine)):
            relative = Path(match.group(1))
            if not (place.home / relative).is_file():
                continue
            if not is_hook_file(place.home, relative):
                lines.append(f'not saved ~/{relative}: a layer carries files under ~/.claude/hooks/ only')
                continue
            text = (place.home / relative).read_bytes()
            given = place.template_layer / 'files' / relative
            if given.is_file() and given.read_bytes() == text:
                continue
            if SECRET_VALUE.search(text.decode(errors='replace')):
                lines.append(f'not saved ~/{relative}: it holds something that looks like a secret')
                continue
            target = layer / 'files' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(place.home / relative, target)
            lines.append(f'saved ~/{relative} -> {target}')
    return lines


def git_email(project: Path) -> str:
    try:
        return subprocess.run(
            ['git', '-C', str(project), 'config', 'user.email'], capture_output=True, text=True, timeout=10
        ).stdout.strip()
    except OSError:
        return ''


def parse_connectors(pairs: list[str], declared: dict[str, list[str]]) -> dict[str, list[str]]:
    """Every declared connector with the servers found for it in the session (none: not found)."""
    servers: dict[str, list[str]] = {name: [] for name in declared}
    for pair in pairs:
        name, _, server = pair.partition('=')
        if name in servers and re.fullmatch(r'[\w.-]+', server) and server not in servers[name]:
            servers[name].append(server)
    return servers


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('mode', choices=['check', 'apply', 'save', 'connectors'])
    parser.add_argument('--connector', action='append', default=[], metavar='NAME=SERVER',
                        help="a declared connector's server name in this session")
    parser.add_argument('--home', type=Path, default=Path.home(), help=argparse.SUPPRESS)
    parser.add_argument('--project', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    # this file sits at <project>/.claude/skills/settings-sync/
    place = Place(home=args.home, project=args.project or HERE.parents[2], template_layer=HERE / 'baseline')
    declared = declared_connectors(place)
    if args.mode == 'connectors':
        print(json.dumps(declared))
        return 0
    connectors = parse_connectors(args.connector, declared)
    if args.mode == 'save':
        maintainer_file = place.project_layer / 'maintainer'
        maintainer = maintainer_file.read_text().strip() if maintainer_file.exists() else ''
        email = git_email(place.project)
        if maintainer and email != maintainer:
            print(f"save writes the project layer from its maintainer's settings: {maintainer}, not {email or 'you'}.")
            print('To get the team settings, run `check`, then `apply`.')
            return 2
        lines = save(place, connectors)
        if not maintainer and email:
            maintainer_file.write_text(email + '\n')
            lines.append(f'maintainer set to {email}')
        print('\n'.join(lines))
        print(f'Read the diff of {place.project_layer} before you commit it.')
        return 0
    stamp = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
    is_check = args.mode == 'check'
    lines = apply(place, connectors, is_check, stamp)
    print('team settings' + (' (check: nothing written)' if is_check else ''))
    print('\n'.join(lines))
    if is_check and any(line.startswith(('  + ', '  ! ')) for line in lines):
        print('! marks what runs code or lets Claude act unasked: read those lines, then `/settings-sync apply`.')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

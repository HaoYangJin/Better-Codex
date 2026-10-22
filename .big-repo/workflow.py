#!/usr/bin/env python3
"""Big-Repo 稳定入口：运行目录切换中断时从生命周期备份恢复。"""
# big-repo:stable-launcher
import json
from pathlib import Path
import hashlib
import re
import runpy
import subprocess
import sys


def fail(message):
    print(json.dumps({"status": "blocked", "issues": [message]}))
    raise SystemExit(2)


def runtime_hashes(root):
    if not root.is_dir():
        return None
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in root.rglob("*")
        if path.is_file()
        and "__pycache__" not in path.relative_to(root).parts
        and path.suffix not in {".pyc", ".pyo"}
    }


repo = Path(__file__).resolve().parents[1]
try:
    config = json.loads((repo / ".big-repo/config.json").read_text(encoding="utf-8"))
    plugin = (repo / config["plugin_path"]).resolve()
except (OSError, ValueError, KeyError, TypeError):
    fail("stable-launcher-config-unavailable")
if not plugin.is_relative_to(repo):
    fail("stable-launcher-plugin-outside-repository")

script = plugin / "scripts/project_workflow.py"
if not script.is_file():
    result = subprocess.run(
        ["git", "rev-parse", "--absolute-git-dir"],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode:
        fail("stable-launcher-git-directory-unavailable")
    git_dir = Path(result.stdout.strip()).resolve()
    ledger = git_dir / "big-repo/lifecycle.json"
    try:
        journal = json.loads(ledger.read_text(encoding="utf-8"))
        backup = journal["backup"]
    except (OSError, ValueError, KeyError, TypeError):
        fail("stable-launcher-recovery-state-unavailable")
    if journal.get("status") != "prepared" or not isinstance(backup, str) or not re.fullmatch(r"backup-[0-9a-f]+", backup):
        fail("stable-launcher-recovery-state-invalid")
    backup_root = git_dir / "big-repo" / backup
    candidates = []
    for runtime, key in (("new-runtime", "runtime_hashes"), ("old-runtime", "installed_hashes")):
        raw_root = backup_root / runtime
        if raw_root.is_symlink():
            continue
        root = raw_root.resolve()
        if not root.is_relative_to(git_dir):
            continue
        expected = journal.get(key)
        try:
            matches = root.is_dir() and isinstance(expected, dict) and runtime_hashes(root) == expected
        except OSError:
            matches = False
        if matches:
            candidates.append(root / "scripts/project_workflow.py")
    if not candidates:
        fail("stable-launcher-recovery-script-unavailable")
    script = candidates[0].resolve()
    if not script.is_file() or not script.is_relative_to(git_dir):
        fail("stable-launcher-recovery-script-unavailable")

runpy.run_path(str(script), run_name="__main__")

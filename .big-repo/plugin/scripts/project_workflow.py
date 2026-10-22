"""Project onboarding and task/feedback delivery. No scheduler or model credentials."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit

SPEC = importlib.util.spec_from_file_location('workflow_repo_tools', Path(__file__).with_name('repo_tools.py'))
TOOLS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOLS)
CONFIG = '.big-repo/config.json'
START = '<!-- big-repo:workflow:start -->'
END = '<!-- big-repo:workflow:end -->'
LEVELS = {'commit': 0, 'pr': 1, 'merge': 2}
RUNTIME_ROOTS = {'.codex-plugin', '.claude-plugin', 'skills', 'scripts', 'references', 'templates', 'assets',
                 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE'}
RECOVERY_LAUNCHER = '''#!/usr/bin/env python3
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
'''


class WorkflowError(ValueError):
    pass


def command(argv, repo=None):
    result = subprocess.run(argv, cwd=repo, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
    if result.returncode:
        raise WorkflowError('command-failed:' + Path(argv[0]).name)
    return result.stdout


def root(path):
    path = Path(path).resolve()
    actual = Path(command(['git', 'rev-parse', '--show-toplevel'], path).strip()).resolve()
    if actual != path:
        raise WorkflowError('pass-repository-root')
    return path


def safe_path(repo, relative):
    repo = Path(repo).resolve()
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts or (not path.parts and relative != '.'):
        raise WorkflowError('expected-repository-relative-path')
    target = repo / path
    for part in (target, *target.parents):
        if part == repo:
            break
        if part.is_symlink() or not part.resolve().is_relative_to(repo):
            raise WorkflowError('linked-project-path')
    return target


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', newline='\n', dir=path.parent,
                                     prefix='.workflow-', delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_text(path, text):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.' + path.name + '.big-repo-', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(text.encode('utf-8'))
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def identity(repo):
    result = subprocess.run(['git', 'remote', 'get-url', 'origin'], cwd=repo,
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
    if result.returncode:
        return None
    value = result.stdout.strip()
    if '://' in value:
        parsed = urlsplit(value)
        host, name = parsed.hostname, parsed.path.strip('/')
    else:
        match = re.fullmatch(r'(?:[^@/]+@)?([^:/]+):(.+)', value)
        if not match:
            return None
        host, name = match.groups()
    name = name.removesuffix('.git')
    if host != 'github.com' or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', name):
        return None
    return name


def infer_checks(repo):
    package = repo / 'package.json'
    if package.is_file():
        data = json.loads(package.read_text(encoding='utf-8'))
        manager = str(data.get('packageManager', '')).split('@')[0]
        if manager not in ('npm', 'pnpm', 'yarn'):
            manager = 'pnpm' if (repo / 'pnpm-lock.yaml').exists() else ('yarn' if (repo / 'yarn.lock').exists() else 'npm')
        return [{'id': name, 'argv': [manager, 'run', name]} for name in ('lint', 'typecheck', 'test')
                if isinstance(data.get('scripts', {}).get(name), str)
                and 'no test specified' not in data['scripts'][name]]
    tests = repo / 'tests'
    # Infer unittest only with direct evidence; the agent supplies other runners.
    if tests.is_dir() and any('unittest.TestCase' in p.read_text(encoding='utf-8')
                              for p in tests.glob('test*.py') if p.is_file()):
        return [{'id': 'tests', 'argv': ['python', '-m', 'unittest', 'discover', '-s', 'tests']}]
    return []


def validate_config(data):
    if (data.get('schema_version') not in (1, 2) or data.get('trigger') != 'task-or-feedback'
            or data.get('delivery') not in LEVELS or data.get('ci_policy') not in ('required', 'none')
            or data.get('release') != 'explicit-request'):
        raise WorkflowError('invalid-project-policy')
    if not isinstance(data.get('base_branch'), str) or not data['base_branch'].strip():
        raise WorkflowError('missing-base-branch')
    if (not isinstance(data.get('plugin_path'), str) or not data['plugin_path']
            or not isinstance(data.get('clients'), list) or (data['schema_version'] == 1 and not data['clients'])
            or any(c not in ('codex', 'claude') for c in data['clients'])
            or (data.get('repository') is not None and not re.fullmatch(
                r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', str(data['repository'])))):
        raise WorkflowError('invalid-project-identity-or-client')
    if data['schema_version'] == 2 and (
            not isinstance(data.get('enabled'), bool) or not isinstance(data.get('policy_confirmed'), bool)
            or data.get('profile') not in ('core', 'full') or data.get('showcase') not in ('none', 'local', 'public')
            or not isinstance(data.get('runtime_version'), str) or not isinstance(data.get('policy_record'), dict)):
        raise WorkflowError('invalid-project-policy-record')
    checks = data.get('validation')
    if not isinstance(checks, list):
        raise WorkflowError('invalid-validation-list')
    names = []
    for check in checks:
        if (not isinstance(check, dict) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', str(check.get('id', '')))
                or not isinstance(check.get('argv'), list) or not check['argv']
                or any(not isinstance(a, str) or not a or '\0' in a for a in check['argv'])):
            raise WorkflowError('invalid-validation-command')
        names.append(check['id'])
    ci = data.get('required_checks')
    if (len(names) != len(set(names)) or not isinstance(ci, list)
            or any(not isinstance(c, str) or not c.strip() for c in ci) or len(ci) != len(set(ci))
            or (data['ci_policy'] == 'none' and ci)):
        raise WorkflowError('invalid-check-policy')


def configuration(repo):
    data = json.loads(safe_path(repo, CONFIG).read_text(encoding='utf-8'))
    validate_config(data)
    return data


def config_digest(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def instruction_block(plugin, delivery='commit'):
    script = plugin + '/scripts/project_workflow.py'
    outcome = {'commit': '仅本地提交，不推送、不创建 PR、不合并。',
               'pr': '验证与独立审查通过后推送并创建 PR，不合并。',
               'merge': '验证、独立审查及全部 CI 通过后，锁定最终 SHA 自动合并。'}[delivery]
    return f'''{START}
## 开发任务与反馈的自动交付

本项目已显式启用 Big-Repo 客户端入口。收到开发需求、缺陷或测试/CI 反馈时，读取 `{CONFIG}` 和 `{plugin}/skills/maintenance-delivery/SKILL.md`。本项目策略：{outcome}普通问答、规划和只读审查不创建任务、不提交或执行远端写入；用户本轮更窄限制优先。

由当前 AI 客户端执行：理解任务及项目规则 → 运行 `python {script} begin --repo . --objective "实际需求" --allowed-path "实际改动范围"`（已有任务先 status）→ 开发并同步本轮相关说明（展示仅按已选择的策略同步）→ 精确提交 → check → 独立 AI 审查并用 review 登记真实结论 → deliver。严格遵守配置的交付终点，等待中的 CI 只读等待；结果不确定先查询，不盲目重试写入。

命令详情与故障恢复见 `{plugin}/references/project-workflow.md`。这是依赖客户端遵循协议的协作流程，不能拦截绕过脚本的 Git 操作。保留用户工作及 Git 元数据内的任务/日志；不伪造验证或独立审查。配置不取代用户授权、项目规则与客户端权限；不读取凭据值，不设置定时任务。版本发布只有获明确版本授权才执行。
{END}
'''


_runtime_spec = importlib.util.spec_from_file_location('runtime_resources', Path(__file__).with_name('runtime_resources.py'))
RUNTIME = importlib.util.module_from_spec(_runtime_spec)
_runtime_spec.loader.exec_module(RUNTIME)


def runtime_files(directory, profile='full'):
    return RUNTIME.runtime_files(directory, profile=profile)


def runtime_resource_bytes(relative, path, files, version):
    return RUNTIME.resource_bytes(relative, path, files, version)


def runtime_version(repo=None):
    manifest = Path(__file__).resolve().parents[1] / '.codex-plugin/plugin.json'
    if not manifest.is_file() and repo is not None:
        try:
            config = configuration(repo)
        except (OSError, ValueError):
            config = None
        if config:
            manifest = safe_path(repo, config['plugin_path']) / '.codex-plugin/plugin.json'
    return json.loads(manifest.read_text(encoding='utf-8'))['version']


def ensure_recovery_launcher(repo):
    launcher = safe_path(repo, '.big-repo/workflow.py')
    if launcher.exists():
        current = launcher.read_text(encoding='utf-8')
        if '# big-repo:stable-launcher' not in current:
            raise WorkflowError('stable-launcher-conflict')
        if current == RECOVERY_LAUNCHER:
            return launcher
    launcher.parent.mkdir(parents=True, exist_ok=True)
    atomic_text(launcher, RECOVERY_LAUNCHER)
    return launcher


def normalize_explorer_header(repo, version):
    output = safe_path(repo, 'docs/big-repo-explorer.html')
    if not output.is_file():
        raise WorkflowError('explorer-output-missing')
    text = output.read_text(encoding='utf-8')
    normalized, replaced = re.subn(
        r'(<span class="tag">)\d+\.\d+\.\d+(</span>)',
        lambda match: match.group(1) + version + match.group(2),
        text,
        count=1,
    )
    if replaced != 1:
        raise WorkflowError('explorer-version-marker-missing')
    if normalized != text:
        atomic_text(output, normalized)


def policy_gate(config):
    if not config.get('enabled', True):
        return {'status': 'disconnected', 'note': 'Explicitly initialize again before starting work.'}
    if config.get('schema_version') != 2 or not config.get('policy_confirmed'):
        return {'status': 'needs-policy-confirmation', 'note': 'Use upgrade with explicit delivery, client and profile choices.'}
    return None


def _rollback_migration(repo, git_dir, journal):
    """Restore only transaction-owned paths; refuse concurrent user modifications."""
    state = git_dir / 'big-repo'
    backup = state / 'legacy-project-backup'
    if state.is_symlink() or state.resolve() != git_dir.resolve() / 'big-repo':
        raise WorkflowError('invalid-migration-state-cleanup-target')
    if backup.is_symlink() or (backup.exists() and backup.resolve() != state.resolve() / 'legacy-project-backup'):
        raise WorkflowError('linked-migration-backup')
    old_root = safe_path(repo, '.repo-maintainer')
    config = safe_path(repo, CONFIG)
    if config.exists() and json.loads(config.read_text(encoding='utf-8')) != journal['config']:
        raise WorkflowError('migration-recovery-config-conflict')
    for name, original in journal['original_instructions'].items():
        if name not in ('AGENTS.md', 'CLAUDE.md'):
            raise WorkflowError('invalid-migration-journal')
        file = safe_path(repo, name)
        current = file.read_bytes().decode('utf-8') if file.exists() else None
        if current not in (original, journal['instructions'][name]):
            raise WorkflowError('migration-recovery-instruction-conflict')
    runtime = safe_path(repo, '.big-repo/plugin')
    if journal['config']['plugin_path'] != '.' and runtime.exists():
        expected = journal['runtime_hashes']
        paths = list(runtime.rglob('*'))
        if any(p.is_symlink() or not p.resolve().is_relative_to(runtime.resolve()) for p in paths):
            raise WorkflowError('migration-recovery-runtime-conflict')
        actual = {p.relative_to(runtime).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in paths if p.is_file() and '__pycache__' not in p.relative_to(runtime).parts
                  and p.suffix not in ('.pyc', '.pyo')}
        if actual != expected:
            raise WorkflowError('migration-recovery-runtime-conflict')
    if backup.exists():
        if old_root.exists():
            raise WorkflowError('migration-recovery-legacy-conflict')
        backup.replace(old_root)
    if not (old_root / 'config.json').exists():
        raise WorkflowError('migration-recovery-missing-legacy-backup')
    for name, original in journal['original_instructions'].items():
        file = safe_path(repo, name)
        if original is None:
            file.unlink(missing_ok=True)
        else:
            with tempfile.NamedTemporaryFile(dir=repo, delete=False) as stream:
                restore = Path(stream.name)
                stream.write(original.encode('utf-8'))
            restore.replace(file)
    config.unlink(missing_ok=True)
    if journal['config']['plugin_path'] != '.' and runtime.exists():
        # Validated absolute target is the transaction's new runtime within this project.
        if runtime.resolve() != (repo / '.big-repo/plugin').resolve() or not runtime.resolve().is_relative_to(repo):
            raise WorkflowError('invalid-migration-cleanup-target')
        shutil.rmtree(runtime)
    try:
        (repo / '.big-repo').rmdir()
    except OSError:
        pass
    if state.resolve() != git_dir.resolve() / 'big-repo' or state.is_symlink():
        raise WorkflowError('invalid-migration-state-cleanup-target')
    shutil.rmtree(state)


def migrate(repo, repository=None):
    repo = root(repo)
    source = Path(__file__).resolve().parents[1]
    git_dir = Path(command(['git', 'rev-parse', '--absolute-git-dir'], repo).strip()).resolve()
    # Recovery removes the abandoned new runtime. Preserve the caller's portable
    # runtime first when the recovery CLI itself is executing from that directory.
    with tempfile.TemporaryDirectory(dir=git_dir, prefix='big-repo-recovery-') as temporary:
        if source == (repo / '.big-repo/plugin').resolve() and (git_dir / 'big-repo/migration.json').exists():
            preserved = Path(temporary) / 'runtime'
            for relative, file in runtime_files(source).items():
                destination = preserved / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(file, destination)
            source = preserved
        return _migrate(repo, repository, source)


def _migrate(repo, repository, source):
    """Explicit namespace migration with an interruption journal and rollback."""
    repo = root(repo)
    source_version = json.loads((source / '.codex-plugin/plugin.json').read_text(encoding='utf-8'))['version']
    old_file, new_file = safe_path(repo, '.repo-maintainer/config.json'), safe_path(repo, CONFIG)
    git_dir = Path(command(['git', 'rev-parse', '--absolute-git-dir'], repo).strip()).resolve()
    old_state, new_state = git_dir / 'repo-maintainer', git_dir / 'big-repo'
    ledger = new_state / 'migration.json'
    for directory in (old_state, new_state):
        if directory.is_symlink() or directory.resolve() != git_dir / directory.name:
            raise WorkflowError('linked-migration-state')
    if ledger.is_symlink() or ledger.resolve() != new_state.resolve() / 'migration.json':
        raise WorkflowError('linked-migration-journal')
    if ledger.exists() and not new_state.is_symlink():
        journal = json.loads(ledger.read_text(encoding='utf-8'))
        if journal.get('transaction_version') == 1 and journal.get('status') != 'completed':
            old_state.mkdir(exist_ok=True)
            with locked(old_state):
                _rollback_migration(repo, git_dir, journal)
    if new_file.exists():
        if old_file.exists():
            raise WorkflowError('migration-conflicting-configurations')
        return {'status': 'configured', 'config': configuration(repo), 'migrated': False}
    previous = json.loads(old_file.read_text(encoding='utf-8'))
    validate_config(previous)
    if (old_state / 'active.json').exists() and active(old_state)[1]['status'] not in ('completed', 'cancelled'):
        raise WorkflowError('legacy-active-task-complete-or-explicitly-cancel-before-migration')
    if repository and not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise WorkflowError('invalid-migration-repository')
    chosen = repository or previous['repository']
    if previous['delivery'] != 'commit' and (identity(repo) or '').casefold() != (chosen or '').casefold():
        raise WorkflowError('migration-origin-mismatch')
    if new_state.exists():
        raise WorkflowError('migration-conflicting-task-state')
    old_state.mkdir(exist_ok=True)
    if old_state.is_symlink() or not old_state.resolve().is_relative_to(git_dir):
        raise WorkflowError('linked-legacy-task-state')
    for path in old_state.rglob('*'):
        if path.is_symlink() or not path.resolve().is_relative_to(old_state.resolve()):
            raise WorkflowError('linked-legacy-task-state')
    plugin = '.' if repo == source else '.big-repo/plugin'
    if plugin != '.' and safe_path(repo, plugin).exists():
        raise WorkflowError('migration-conflicting-runtime')
    data = {**previous, 'plugin_path': plugin, 'repository': chosen}
    instructions, originals = {}, {}
    for client in previous['clients']:
        name = 'AGENTS.md' if client == 'codex' else 'CLAUDE.md'
        file = safe_path(repo, name)
        originals[name] = file.read_bytes().decode('utf-8') if file.exists() else None
        text = originals[name] or ''
        for start, finish in [('<!-- repo-maintainer:workflow:start -->', '<!-- repo-maintainer:workflow:end -->'), (START, END)]:
            if text.count(start) != text.count(finish) or text.count(start) > 1 or (start in text and text.index(finish) < text.index(start)):
                raise WorkflowError('malformed-managed-instructions')
        old_start, old_end = '<!-- repo-maintainer:workflow:start -->', '<!-- repo-maintainer:workflow:end -->'
        if old_start in text and START in text:
            raise WorkflowError('migration-conflicting-instruction-blocks')
        if old_start in text:
            text = text.replace(old_start, START).replace(old_end, END)
        block = instruction_block(plugin, previous['delivery'])
        instructions[name] = (text[:text.index(START)] + block + text[text.index(END) + len(END):]
                              if START in text else text.rstrip() + '\n\n' + block)
    with locked(old_state):
        if (old_state / 'active.json').exists() and active(old_state)[1]['config_digest'] != config_digest(previous):
            raise WorkflowError('migration-policy-drift-reconcile-first')
        with tempfile.TemporaryDirectory(dir=git_dir, prefix='big-repo-migrate-') as temporary:
            temporary = Path(temporary)
            staged = temporary / 'state'
            shutil.copytree(old_state, staged, ignore=shutil.ignore_patterns('workflow.lock'))
            hashes = {}
            staged_runtime = temporary / 'runtime'
            if plugin != '.':
                candidates = runtime_files(source)
                for relative, file in candidates.items():
                    destination = staged_runtime / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    payload = runtime_resource_bytes(relative, file, candidates, source_version)
                    destination.write_bytes(payload)
                    hashes[relative.as_posix()] = hashlib.sha256(payload).hexdigest()
            journal = {'transaction_version': 1, 'status': 'prepared', 'previous_config': previous, 'config': data,
                       'original_instructions': originals, 'instructions': instructions, 'runtime_hashes': hashes,
                       'evidence_invalidated': False}
            write_json(staged / 'migration.json', journal)
            staged.replace(new_state)
            try:
                if plugin != '.':
                    target = safe_path(repo, plugin)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    staged_runtime.replace(target)
                write_json(new_file, data)
                for name, text in instructions.items():
                    atomic_text(safe_path(repo, name), text)
                safe_path(repo, '.repo-maintainer').replace(new_state / 'legacy-project-backup')
                journal['status'] = 'completed'
                write_json(new_state / 'migration.json', journal)
            except BaseException:
                _rollback_migration(repo, git_dir, journal)
                raise
    return {'status': 'configured', 'config': data, 'migrated': True,
            'note': 'Task identity and history retained; validation and independent review must run again.'}


def create(repo, repository=None, visibility='private', **options):
    """Initialize locally before first commit; remote creation is explicit and recoverable."""
    repo = Path(repo).absolute()
    if repo.is_symlink() or visibility not in ('private', 'public'):
        raise WorkflowError('invalid-create-target-or-visibility')
    if repository and not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise WorkflowError('invalid-create-repository')
    delivery = options.get('delivery') or 'commit'
    clients = parse_clients(options.get('client') or 'none')
    profile, showcase = options.get('profile') or 'core', options.get('showcase') or 'none'
    if delivery not in LEVELS:
        raise WorkflowError('invalid-delivery-selection')
    validate_showcase(profile, showcase, repository, verify_public=False)
    if showcase == 'public' and not repository:
        raise WorkflowError('public-showcase-needs-repository')
    if showcase == 'public' and visibility != 'public':
        raise WorkflowError('public-showcase-needs-public-visibility')
    if showcase != 'none':
        preflight_showcase(repo, repository, public=showcase == 'public')
    if options.get('dry_run'):
        return {'status': 'preview', 'repository': repository, 'visibility': visibility,
                'delivery': delivery, 'clients': clients, 'profile': profile, 'showcase': showcase,
                'changes': [CONFIG, '.big-repo/plugin/', '.big-repo/workflow.py', 'README.md (only if absent)'] +
                           [('AGENTS.md' if c == 'codex' else 'CLAUDE.md') for c in clients] +
                           (['README showcase blocks', 'docs/big-repo-explorer.html'] if showcase != 'none' else []),
                'note': 'No files, Git repository or remote created.'}
    if (repo / '.git').exists():
        require_lifecycle_ready(repo)
    repo.mkdir(parents=True, exist_ok=True)
    if not (repo / '.git').exists():
        probe = subprocess.run(['git', 'rev-parse', '--show-toplevel'], cwd=repo, capture_output=True)
        if probe.returncode == 0:
            raise WorkflowError('cannot-create-inside-another-repository')
        command(['git', 'init', '-b', options.get('base') or 'main'], repo)
    else:
        root(repo)
    if (repo / '.repo-maintainer/config.json').exists():
        raise WorkflowError('legacy-project-use-init-migrate')
    if repository:
        existing_origin = identity(repo)
        has_origin = subprocess.run(['git', 'remote', 'get-url', 'origin'], cwd=repo, capture_output=True).returncode == 0
        if has_origin and not existing_origin:
            raise WorkflowError('create-origin-mismatch')
        if existing_origin and existing_origin.casefold() != repository.casefold():
            raise WorkflowError('create-origin-mismatch')
        journal = state_dir(repo) / 'create.json'
        previous = json.loads(journal.read_text(encoding='utf-8')) if journal.exists() else None
        if previous and (previous['repository'] != repository or previous['visibility'] != visibility):
            raise WorkflowError('create-request-changed-reconcile-journal')
        result = subprocess.run(['gh', 'api', f'repos/{repository}'], capture_output=True, text=True, timeout=30)
        try:
            observed = json.loads(result.stdout)
        except ValueError:
            raise WorkflowError('create-remote-query-unavailable')
        if result.returncode == 0 and not previous and not existing_origin:
            raise WorkflowError('create-remote-already-exists-use-init')
        if result.returncode:
            if previous:
                raise WorkflowError('create-outcome-unconfirmed-inspect-before-retry')
            if observed.get('message') != 'Not Found':
                raise WorkflowError('create-remote-query-unavailable')
            write_json(journal, {'repository': repository, 'visibility': visibility, 'status': 'attempted'})
            try:
                command(['gh', 'repo', 'create', repository, '--' + visibility])
            except (WorkflowError, subprocess.SubprocessError, OSError):
                pass
            try:
                observed = json.loads(command(['gh', 'api', f'repos/{repository}']))
            except (WorkflowError, ValueError):
                raise WorkflowError('create-outcome-unconfirmed-inspect-before-retry')
        if observed.get('full_name', '').casefold() != repository.casefold() or observed.get('private') != (visibility == 'private'):
            raise WorkflowError('create-remote-identity-or-visibility-mismatch')
        if not existing_origin:
            command(['git', 'remote', 'add', 'origin', f'https://github.com/{repository}.git'], repo)
        write_json(journal, {'repository': repository, 'visibility': visibility, 'status': 'confirmed', 'id': observed['id']})
    result = initialize(repo, **options)
    readme = safe_path(repo, 'README.md')
    if not readme.exists():
        atomic_text(readme, '# ' + repo.name + '\n\n请补充项目用途、功能与验证方式。\n')
    result['created'] = True
    result['note'] = 'Local project prepared; persistent instructions and showcase require explicit choices.'
    return result


def initialize(repo, client=None, delivery=None, checks=None, ci=None, no_ci=False,
               base=None, plugin_path=None, update=False, sync=False, profile=None, showcase=None, dry_run=False):
    repo = root(repo)
    require_lifecycle_ready(repo)
    if (repo / '.repo-maintainer/config.json').exists():
        raise WorkflowError('legacy-project-use-init-migrate')
    config_file = safe_path(repo, CONFIG)
    previous = configuration(repo) if config_file.exists() else None
    if previous and not update:
        if dry_run:
            return {'status': 'preview', 'config': previous, 'changes': []}
        gate = policy_gate(previous)
        if gate:
            return {**gate, 'config': previous}
        missing = readiness(previous)
        return {'status': 'needs-configuration' if missing else 'configured', 'missing': missing,
                'config': previous, 'note': 'Existing project settings preserved; use init --update for an intentional policy change.'}
    if previous and previous['schema_version'] != 2:
        raise WorkflowError('legacy-policy-use-upgrade')
    if previous and update:
        require_idle(repo)
    clients = parse_clients(client) if client is not None else (previous['clients'] if previous else [])
    selected_profile = profile or (previous.get('profile', 'core') if previous else 'core')
    if previous and selected_profile != previous.get('profile'):
        raise WorkflowError('runtime-profile-change-use-upgrade')
    showcase = showcase if showcase is not None else (previous.get('showcase', 'none') if previous else 'none')
    validate_showcase(selected_profile, showcase, identity(repo))
    if showcase != 'none':
        preflight_showcase(repo, identity(repo), public=showcase == 'public')
    files = [safe_path(repo, 'AGENTS.md' if c == 'codex' else 'CLAUDE.md')
             for c in sorted(set(clients + (previous['clients'] if previous else [])))]
    texts = {}
    for file in files:
        text = file.read_bytes().decode('utf-8') if file.exists() else ''
        if '<!-- repo-maintainer:workflow:' in text:
            raise WorkflowError('legacy-instructions-use-init-migrate')
        if text.count(START) != text.count(END) or text.count(START) > 1 or (START in text and text.index(END) < text.index(START)):
            raise WorkflowError('malformed-managed-instructions')
        texts[file] = text
    plugin = plugin_path or (previous['plugin_path'] if previous else '.big-repo/plugin')
    target = safe_path(repo, plugin)
    source = Path(__file__).resolve().parents[1]
    if plugin_path and target.resolve() != source:
        raise WorkflowError('plugin-path-must-be-this-plugin-in-project')
    if not previous and not plugin_path and target.exists():
        # An interrupted copy may be reused only when it matches this runtime.
        existing = runtime_files(target, selected_profile)
        expected = runtime_files(source, selected_profile)
        if (set(existing) != set(expected)
                or any(existing[name].read_bytes() != runtime_resource_bytes(name, file, expected, runtime_version())
                       for name, file in expected.items())):
            raise WorkflowError('existing-runtime-needs-reconciliation-not-overwrite')
    branch = command(['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repo).strip() if subprocess.run(
        ['git', 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd=repo, capture_output=True).returncode == 0 else None
    current = command(['git', 'branch', '--show-current'], repo).strip()
    data = {'schema_version': 2, 'trigger': 'task-or-feedback', 'plugin_path': plugin,
            'repository': identity(repo), 'base_branch': base or (previous['base_branch'] if previous else (branch.removeprefix('origin/') if branch else current or 'main')),
            'delivery': delivery or (previous['delivery'] if previous else 'commit'),
            'release': 'explicit-request', 'clients': sorted(set(clients)),
            'enabled': True, 'policy_confirmed': True, 'profile': selected_profile, 'showcase': showcase,
            'runtime_version': runtime_version(),
            'policy_record': (
                {'source': 'explicit-init',
                 'recorded_at': datetime.now(timezone.utc).isoformat(timespec='seconds')}
                if delivery is not None
                else previous['policy_record']
                if previous
                else {'source': 'safe-default-init',
                      'recorded_at': datetime.now(timezone.utc).isoformat(timespec='seconds')}
            ),
            'validation': ([{'id': f'check-{i + 1}', 'argv': shlex.split(c)} for i, c in enumerate(checks)]
                           if checks is not None else (previous['validation'] if previous else infer_checks(repo))),
            'ci_policy': 'none' if no_ci else (previous['ci_policy'] if previous and ci is None else 'required'),
            'required_checks': [] if no_ci else (ci if ci is not None else (previous['required_checks'] if previous else []))}
    validate_config(data)
    if dry_run:
        return {'status': 'preview', 'config': data,
                'changes': [CONFIG, plugin, '.big-repo/workflow.py'] + [str(f.relative_to(repo)) for f in files]}
    ensure_recovery_launcher(repo)
    if not plugin_path and not target.exists():
        candidates = runtime_files(source, selected_profile)
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=target.parent) as temporary:
            staged = Path(temporary) / 'plugin'
            staged.mkdir()
            for relative, path in candidates.items():
                destination = staged / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(runtime_resource_bytes(relative, path, candidates, runtime_version()))
            staged.replace(target)
    if not (target / 'scripts/project_workflow.py').is_file():
        raise WorkflowError('project-runtime-missing')
    if showcase != 'none':
        TOOLS.sync_showcase(repo, data['repository'], public=showcase == 'public')
        normalize_explorer_header(repo, data['runtime_version'])
    block = instruction_block(plugin, data['delivery'])
    for file, text in texts.items():
        chosen = ('codex' if file.name == 'AGENTS.md' else 'claude') in clients
        result = managed_text(text, block if chosen else None)
        if result != text:
            atomic_text(file, result)
    write_json(config_file, data)
    missing = readiness(data)
    return {'status': 'needs-configuration' if missing else 'configured', 'missing': missing, 'config': data}


def readiness(config):
    missing = []
    if not config['validation']:
        missing.append('project-validation-commands')
    if config['delivery'] != 'commit' and not config.get('repository'):
        missing.append('github-origin')
    if config['delivery'] == 'merge' and config['ci_policy'] == 'required' and not config['required_checks']:
        missing.append('actual-ci-check-names-or-confirmed-no-ci-policy')
    return missing


def parse_clients(client):
    if client not in ('none', 'codex', 'claude', 'both'):
        raise WorkflowError('invalid-client-selection')
    return [] if client == 'none' else (['codex', 'claude'] if client == 'both' else [client])


def validate_showcase(profile, showcase, repository, verify_public=True):
    if profile not in ('core', 'full') or showcase not in ('none', 'local', 'public'):
        raise WorkflowError('invalid-runtime-or-showcase-selection')
    source = Path(__file__).resolve().parents[1]
    if profile == 'full':
        required = ([source / 'assets' / name for name in RUNTIME.ASSETS]
                    + [source / 'scripts/explore.py', source / 'scripts/collect_research.py',
                       source / 'research/roster.json', source / 'research/source-index.json'])
        if any(not path.is_file() for path in required):
            raise WorkflowError('full-source-required-run-from-complete-plugin')
    if showcase != 'none' and (profile != 'full' or not (source / 'assets/explorer.html').is_file()):
        raise WorkflowError('showcase-needs-full-resources')
    if showcase == 'public' and verify_public:
        if not repository:
            raise WorkflowError('public-showcase-needs-repository')
        observed = json.loads(command(['gh', 'api', 'repos/' + repository]))
        if observed.get('private') is not False or observed.get('full_name', '').casefold() != repository.casefold():
            raise WorkflowError('public-showcase-repository-not-verified')


def preflight_showcase(repo, repository, public=False):
    """Render every owned showcase target without writing project files."""
    repo = Path(repo).resolve()
    repository = repository or 'local/project'
    output = safe_path(repo, 'docs/big-repo-explorer.html')
    if output.exists() and 'big-repo:generated-explorer' not in output.read_text(encoding='utf-8'):
        raise ValueError('existing explorer is not owned by Big-Repo')
    explorer_spec = importlib.util.spec_from_file_location(
        'showcase_preflight_explorer', Path(__file__).with_name('explore.py')
    )
    explorer = importlib.util.module_from_spec(explorer_spec)
    explorer_spec.loader.exec_module(explorer)
    explorer.render(explorer.demo())
    workflows = []
    folder = repo / '.github/workflows'
    if folder.is_dir() and not folder.is_symlink():
        workflows = sorted(
            path.name for path in folder.iterdir()
            if path.is_file() and not path.is_symlink() and path.suffix in {'.yml', '.yaml'}
        )
    for name in ('README.md', 'README.en.md'):
        target = safe_path(repo, name)
        if name == 'README.en.md' and not target.exists():
            continue
        text = target.read_text(encoding='utf-8') if target.exists() else '# ' + repo.name + '\n'
        old_start, old_end = '<!-- repo-maintainer:showcase:start -->', '<!-- repo-maintainer:showcase:end -->'
        if old_start in text or old_end in text:
            if (text.count(old_start) != 1 or text.count(old_end) != 1
                    or text.index(old_end) < text.index(old_start)
                    or '<!-- big-repo:showcase:start -->' in text):
                raise ValueError('Conflicting legacy showcase block')
            text = text.replace(old_start, '<!-- big-repo:showcase:start -->').replace(
                old_end, '<!-- big-repo:showcase:end -->'
            )
        TOOLS.render_showcase(
            text,
            repository,
            private=not public,
            star_history=public,
            english=name == 'README.en.md',
            workflows=workflows,
            links=[(
                'Big-Repo offline playground' if name == 'README.en.md' else 'Big-Repo 离线体验台',
                'docs/big-repo-explorer.html',
            )],
        )


def managed_text(text, block):
    if text.count(START) != text.count(END) or text.count(START) > 1 or (START in text and text.index(START) > text.index(END)):
        raise WorkflowError('malformed-managed-instructions')
    if START in text:
        return text[:text.index(START)] + (block.rstrip('\n') if block else '') + text[text.index(END) + len(END):]
    return text + ('\n\n' if text and not text.endswith('\n\n') else '') + block if block else text


def require_idle(repo):
    directory = state_dir(repo, create=False)
    if (directory / 'active.json').exists() and active(directory)[1]['status'] not in ('completed', 'cancelled'):
        raise WorkflowError('active-task-complete-or-explicitly-cancel-first')


def upgrade(repo, delivery=None, client=None, profile=None, dry_run=False):
    repo = root(repo)
    recover_lifecycle(repo, dry_run)
    require_idle(repo)
    if delivery not in LEVELS or client is None or profile not in ('core', 'full'):
        raise WorkflowError('upgrade-needs-explicit-delivery-client-profile')
    previous = configuration(repo)
    validate_showcase(profile, 'none', previous['repository'])
    clients = parse_clients(client)
    data = {**previous, 'schema_version': 2, 'delivery': delivery, 'clients': clients,
            'profile': profile, 'showcase': previous.get('showcase', 'none') if profile == 'full' else 'none',
            'enabled': True, 'policy_confirmed': True, 'runtime_version': runtime_version(repo),
            'policy_record': {'source': 'explicit-upgrade', 'recorded_at': datetime.now(timezone.utc).isoformat(timespec='seconds')}}
    validate_config(data)
    pending, snapshots = {}, {}
    for name, which in [('AGENTS.md', 'codex'), ('CLAUDE.md', 'claude')]:
        file = safe_path(repo, name)
        text = file.read_bytes().decode('utf-8') if file.exists() else ''
        rendered = managed_text(text, instruction_block(data['plugin_path'], delivery) if which in clients else None)
        if rendered != text:
            pending[name] = rendered
            snapshots[name] = file.read_bytes().hex() if file.exists() else None
    return lifecycle(repo, previous, data, pending, 'upgrade', dry_run, snapshots)


def disconnect(repo, dry_run=False):
    repo = root(repo)
    recover_lifecycle(repo, dry_run)
    require_idle(repo)
    previous = configuration(repo)
    data = {**previous, 'enabled': False}
    pending, snapshots = {}, {}
    for name in ('AGENTS.md', 'CLAUDE.md'):
        file = safe_path(repo, name)
        if file.exists():
            text = file.read_bytes().decode('utf-8')
            rendered = managed_text(text, None)
            if text != rendered:
                pending[name] = rendered
                snapshots[name] = text.encode('utf-8').hex()
    return lifecycle(repo, previous, data, pending, 'disconnect', dry_run, snapshots)


def lifecycle(repo, previous, data, pending, operation, dry_run, snapshots):
    """Stage owned resources and preserve a durable rollback journal before replacement."""
    target = safe_path(repo, previous['plugin_path'])
    source = Path(__file__).resolve().parents[1]
    if not source.is_dir():
        source = target
    resources = runtime_files(source, data['profile']) if operation == 'upgrade' and target != repo else {}
    installed = {}
    if resources and target.exists():
        owned = runtime_files(target)
        for file in target.rglob('*'):
            relative = file.relative_to(target)
            if '__pycache__' in relative.parts or file.suffix == '.pyc':
                continue
            if file.is_symlink() or (file.is_file() and relative not in owned):
                raise WorkflowError('unowned-runtime-content-reconcile-first')
            if file.is_file():
                installed[relative.as_posix()] = file.read_bytes()
    if dry_run:
        return {'status': 'preview', 'config': data, 'changes': [CONFIG, *pending, *(['runtime'] if resources else [])]}
    ensure_recovery_launcher(repo)
    directory = state_dir(repo)
    with locked(directory):
        require_idle(repo)
        if configuration(repo) != previous:
            raise WorkflowError('policy-changed-during-lifecycle')
        for name, content in snapshots.items():
            file = safe_path(repo, name)
            current = file.read_bytes().hex() if file.exists() else None
            if current != content:
                raise WorkflowError('instructions-changed-during-lifecycle')
        if resources and target.exists():
            current = {}
            for file in target.rglob('*'):
                if file.is_symlink():
                    raise WorkflowError('runtime-changed-during-lifecycle')
                if file.is_file() and '__pycache__' not in file.relative_to(target).parts and file.suffix != '.pyc':
                    current[file.relative_to(target).as_posix()] = file.read_bytes()
            if current != installed:
                raise WorkflowError('runtime-changed-during-lifecycle')
        ledger = directory / 'lifecycle.json'
        if ledger.exists() and json.loads(ledger.read_text(encoding='utf-8'))['status'] == 'prepared':
            raise WorkflowError('interrupted-lifecycle-needs-recovery')
        backup = directory / ('backup-' + uuid.uuid4().hex)
        backup.mkdir()
        originals = {}
        for name in [CONFIG, *pending]:
            file = safe_path(repo, name)
            originals[name] = file.read_bytes().hex() if file.exists() else None
        if installed:
            for name, content in installed.items():
                file = backup / 'runtime' / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(content)
        journal = {'operation': operation, 'status': 'prepared', 'originals': originals,
                   'backup': backup.name, 'plugin_path': previous['plugin_path'], 'installed': sorted(installed),
                   'installed_hashes': {name: hashlib.sha256(content).hexdigest() for name, content in installed.items()},
                   'runtime_replaced': False, 'runtime_created': False,
                   'expected': {CONFIG: (json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode().hex(),
                                **{name: text.encode().hex() for name, text in pending.items()}}}
        write_json(ledger, journal)
        try:
            if resources:
                staged = backup / 'new-runtime'
                staged.mkdir()
                for relative, file in resources.items():
                    destination = staged / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(runtime_resource_bytes(relative, file, resources, runtime_version(repo)))
                journal['runtime_hashes'] = {p.relative_to(staged).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                                             for p in staged.rglob('*') if p.is_file()}
                write_json(ledger, journal)
                if target.exists():
                    journal['runtime_replaced'] = True
                    write_json(ledger, journal)
                    target.replace(backup / 'old-runtime')
                else:
                    journal['runtime_created'] = True
                    write_json(ledger, journal)
                staged.replace(target)
            write_json(safe_path(repo, CONFIG), data)
            for name, text in pending.items():
                atomic_text(safe_path(repo, name), text)
            journal['status'] = 'completed'
            write_json(ledger, journal)
        except BaseException:
            rollback_lifecycle(repo, directory, journal)
            raise
    return {'status': 'upgraded' if operation == 'upgrade' else 'disconnected', 'config': data,
            'backup': str(backup), 'note': 'Task logs and PR associations retained; policy records are caller-attested.'}


def rollback_lifecycle(repo, directory, journal):
    backup = safe_path(directory, journal['backup'])
    target = safe_path(repo, journal['plugin_path'])
    for name, content in journal['originals'].items():
        file = safe_path(repo, name)
        current = file.read_bytes().hex() if file.exists() else None
        if current not in (content, journal['expected'][name]):
            raise WorkflowError('lifecycle-recovery-project-conflict')
    if journal['runtime_replaced'] or journal['runtime_created']:
        if target.exists():
            actual = {}
            for file in target.rglob('*'):
                if file.is_symlink():
                    raise WorkflowError('lifecycle-recovery-runtime-conflict')
                if file.is_file() and '__pycache__' not in file.relative_to(target).parts:
                    actual[file.relative_to(target).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
            if actual not in (journal.get('runtime_hashes', {}), journal['installed_hashes']):
                raise WorkflowError('lifecycle-recovery-runtime-conflict')
        if journal['runtime_replaced'] and not (backup / 'old-runtime').exists():
            # The process stopped after journaling intent but before the directory move.
            if not target.exists() or actual != journal['installed_hashes']:
                raise WorkflowError('lifecycle-recovery-runtime-backup-missing')
            journal['runtime_replaced'] = False
    if journal['runtime_replaced'] or journal['runtime_created']:
        if target.exists():
            target.replace(backup / ('interrupted-runtime-' + uuid.uuid4().hex))
        if journal['runtime_replaced']:
            (backup / 'old-runtime').replace(target)
    for name, content in journal['originals'].items():
        file = safe_path(repo, name)
        if content is None:
            file.unlink(missing_ok=True)
        else:
            # Restore exact bytes independently of the write function that failed.
            file.write_bytes(bytes.fromhex(content))
    journal['status'] = 'rolled-back'
    write_json(directory / 'lifecycle.json', journal)


def recover_lifecycle(repo, dry_run=False):
    directory = state_dir(repo, create=False)
    ledger = safe_path(directory, 'lifecycle.json')
    if ledger.exists():
        journal = json.loads(ledger.read_text(encoding='utf-8'))
        if journal['status'] == 'prepared':
            require_idle(repo)
            if dry_run:
                raise WorkflowError('interrupted-lifecycle-recovery-required')
            with locked(directory):
                journal = json.loads(ledger.read_text(encoding='utf-8'))
                if journal['status'] == 'prepared':
                    require_idle(repo)
                    rollback_lifecycle(repo, directory, journal)


def lifecycle_pending(repo):
    ledger = safe_path(state_dir(repo, create=False), 'lifecycle.json')
    return ledger.exists() and json.loads(ledger.read_text(encoding='utf-8'))['status'] == 'prepared'


def require_lifecycle_ready(repo):
    if lifecycle_pending(repo):
        raise WorkflowError('lifecycle-recovery-required-retry-upgrade-or-disconnect')


def state_dir(repo, create=True):
    git_directory = Path(command(['git', 'rev-parse', '--absolute-git-dir'], repo).strip()).resolve()
    directory = git_directory / 'big-repo'
    if directory.is_symlink() or directory.resolve() != git_directory / 'big-repo':
        raise WorkflowError('linked-task-state-directory')
    if create:
        directory.mkdir(parents=True, exist_ok=True)
    return directory


@contextmanager
def locked(directory):
    # Kernel locks release on process exit, including crashes; no stale PID locks.
    with (directory / 'workflow.lock').open('a+b') as stream:
        # Windows byte locks also prohibit reads of an already locked byte.
        # Inspect metadata before acquiring the lock instead of reading it.
        if os.fstat(stream.fileno()).st_size == 0:
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise WorkflowError('another-task-operation-is-running') from error
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def active(directory):
    pointer = json.loads((directory / 'active.json').read_text(encoding="utf-8"))
    identifier = pointer.get('id', '')
    if not re.fullmatch(r'[0-9a-f]{64}', identifier):
        raise WorkflowError('invalid-task-state')
    path = directory / 'tasks' / identifier
    return path, json.loads((path / 'state.json').read_text(encoding="utf-8"))


def save(path, state, status, **details):
    if status != 'blocked':
        state.pop('reason', None)
    state.update(status=status, **details)
    state.setdefault('history', []).append({'status': status, **details})
    write_json(path / 'state.json', state)


def begin(repo, objective, allowed_paths, event=None, delivery=None):
    repo = root(repo)
    require_lifecycle_ready(repo)
    config = configuration(repo)
    gate = policy_gate(config)
    if gate:
        return gate
    if readiness(config):
        return {'status': 'needs-configuration', 'missing': readiness(config)}
    chosen = delivery or config['delivery']
    if LEVELS[chosen] > LEVELS[config['delivery']]:
        raise WorkflowError('task-cannot-expand-project-delivery-policy')
    if chosen != 'commit' and (identity(repo) or '').casefold() != config['repository'].casefold():
        raise WorkflowError('origin-repository-changed')
    directory = state_dir(repo)
    with locked(directory):
        identifier = hashlib.sha256((event or str(uuid.uuid4())).encode()).hexdigest()
        path = directory / 'tasks' / identifier
        if path.exists():
            state = json.loads((path / 'state.json').read_text(encoding="utf-8"))
            if state['objective'] != objective or state['config_digest'] != config_digest(config):
                raise WorkflowError('event-already-bound-to-different-task')
            if state['delivery'] != chosen:
                raise WorkflowError('delivery-changed-cancel-and-replan-task')
            if set(json.loads((path / 'task.json').read_text(encoding='utf-8'))['allowed_paths']) != set(allowed_paths):
                raise WorkflowError('scope-changed-cancel-and-replan-task')
            return {'status': state['status'], 'task_id': identifier, 'state_directory': str(path), 'resumed': True}
        if (directory / 'active.json').exists():
            previous_path, previous = active(directory)
            if previous['status'] not in ('completed', 'cancelled'):
                if previous['objective'] == objective and previous['config_digest'] == config_digest(config):
                    if previous['delivery'] != chosen:
                        raise WorkflowError('delivery-changed-cancel-and-replan-task')
                    if set(json.loads((previous_path / 'task.json').read_text(encoding='utf-8'))['allowed_paths']) != set(allowed_paths):
                        raise WorkflowError('scope-changed-cancel-and-replan-task')
                    return {'status': previous['status'], 'task_id': previous['id'], 'state_directory': str(previous_path), 'resumed': True}
                raise WorkflowError('unfinished-task-resume-before-starting-another')
        current = TOOLS.snapshot(repo)
        baseline = current['head_sha']
        if chosen != 'commit':
            baseline = None
            for ref in ('refs/remotes/origin/' + config['base_branch'], 'refs/heads/' + config['base_branch']):
                try:
                    baseline = command(['git', 'rev-parse', '--verify', ref + '^{commit}'], repo).strip()
                    break
                except WorkflowError:
                    continue
            if baseline is None:
                raise WorkflowError('base-branch-reference-unavailable-fetch-and-reconcile')
            command(['git', 'merge-base', '--is-ancestor', baseline, current['head_sha']], repo)
        task = {'objective': objective, 'base_sha': baseline, 'allowed_paths': allowed_paths,
                'allowed_actions': ['commit'] + (['push', 'create-pr'] if chosen != 'commit' else []) + (['merge'] if chosen == 'merge' else []),
                'validation': [{'id': c['id'], 'command': shlex.join(c['argv'])} for c in config['validation']],
                'done_when': ['Current task verified, independently reviewed and delivered using project policy']}
        if chosen == 'merge':
            task['merge'] = {'repository': config['repository'], 'base_branch': config['base_branch'],
                             'required_checks': config['required_checks'], 'ci_policy': config['ci_policy']}
        TOOLS.validate_task(task)
        if not current['branch']:
            raise WorkflowError('detached-head-needs-task-branch')
        if current['branch'] == config['base_branch'] and chosen != 'commit':
            command(['git', 'switch', '-c', 'maintain/' + identifier[:12]], repo)
        path.mkdir(parents=True)
        state = {'id': identifier, 'objective': objective, 'config_digest': config_digest(config),
                 'delivery': chosen, 'initial_snapshot': current, 'attempts': 0}
        write_json(path / 'task.json', task)
        save(path, state, 'working')
        write_json(directory / 'active.json', {'id': identifier})
        return {'status': 'working', 'task_id': identifier, 'state_directory': str(path),
                'initial_changes_require_reconciliation': current['dirty'] or baseline != current['head_sha']}


def current_task(repo):
    directory = state_dir(repo)
    path, state = active(directory)
    config = configuration(repo)
    if config_digest(config) != state['config_digest']:
        raise WorkflowError('project-policy-changed-reconcile-active-task')
    return path, state, config, json.loads((path / 'task.json').read_text(encoding="utf-8"))


def check(repo, retry_reason=None):
    repo = root(repo)
    with locked(state_dir(repo)):
        path, state, config, task = current_task(repo)
        if state['status'] in ('completed', 'cancelled'):
            return {'status': state['status'], 'note': 'Start a new task for new work.'}
        before = TOOLS.snapshot(repo)
        if state.get('failed_fingerprint') == before['fingerprint'] and not retry_reason:
            raise WorkflowError('unchanged-failed-candidate-needs-diagnosis-before-retry')
        attempt = state['attempts'] + 1
        logs = path / 'runs' / str(attempt)
        logs.mkdir(parents=True)
        checks = []
        for item, expected in zip(config['validation'], task['validation']):
            try:
                result = subprocess.run(item['argv'], cwd=repo, capture_output=True, timeout=300)
                code, output = result.returncode, result.stdout + result.stderr
            except subprocess.TimeoutExpired:
                code, output = 124, b'Validation timed out; diagnose before retrying.\n'
            except OSError:
                code, output = 127, b'Validation executable unavailable.\n'
            log = logs / (item['id'] + '.log')
            log.write_bytes(output)
            checks.append({**expected, 'exit_code': code, 'result': str(log)})
        after = TOOLS.snapshot(repo)
        evidence = {'fingerprint': before['fingerprint'], 'checks': checks}
        write_json(logs / 'evidence.json', evidence)
        write_json(path / 'evidence.json', evidence)
        accepted = TOOLS.accept(repo, task, evidence)
        passed = accepted['status'] == 'verified-local' and before['fingerprint'] == after['fingerprint']
        save(path, state, 'validated' if passed else 'blocked', attempts=attempt,
             failed_fingerprint=None if passed else before['fingerprint'],
             head_sha=before['head_sha'], issues=accepted.get('issues', []), retry_reason=retry_reason)
        return {'status': state['status'], 'checks': checks, 'issues': state['issues'], 'state_directory': str(path)}


def review(repo, head, reviewers, blocking=0):
    repo = root(repo)
    with locked(state_dir(repo)):
        path, state, _, task = current_task(repo)
        if state['status'] in ('completed', 'cancelled'):
            raise WorkflowError('closed-task-does-not-accept-new-review')
        evidence = json.loads((path / 'evidence.json').read_text(encoding="utf-8"))
        current = TOOLS.snapshot(repo)
        if (head != current['head_sha'] or current['dirty'] or not reviewers
                or any(not r.strip() for r in reviewers) or blocking < 0
                or TOOLS.accept(repo, task, evidence)['status'] != 'verified-local'):
            raise WorkflowError('review-needs-clean-validated-final-head')
        evidence['review'] = {'head_sha': head, 'status': 'approved' if blocking == 0 else 'changes-requested',
                              'reviewers': reviewers, 'blocking_findings': blocking}
        write_json(path / 'evidence.json', evidence)
        save(path, state, 'reviewed' if blocking == 0 else 'blocked')
        return {'status': state['status'], 'review': evidence['review']}


def pr_list(config, branch):
    output = command(['gh', 'pr', 'list', '--repo', config['repository'], '--head', branch,
                      '--base', config['base_branch'], '--state', 'all', '--json', 'number,state,headRefOid'])
    return json.loads(output)


def observed_pr(config, number):
    reference = f'{config["repository"]}#{number}'
    observed = TOOLS.pr_status(reference)
    if observed.get('status') != 'observed':
        raise WorkflowError('github-pr-unavailable')
    return reference, observed['pr']


def deliver(repo, title=None, body_file=None, retry_reason=None):
    repo = root(repo)
    require_lifecycle_ready(repo)
    gate = policy_gate(configuration(repo))
    if gate:
        return gate
    with locked(state_dir(repo)):
        path, state, config, task = current_task(repo)
        if state['status'] in ('completed', 'cancelled'):
            return {'status': state['status'], 'result': state.get('result'), 'note': 'Event is closed; no write performed.'}
        evidence = json.loads((path / 'evidence.json').read_text(encoding="utf-8"))
        if state.get('pr_number'):
            _, observed = observed_pr(config, state['pr_number'])
            if (observed.get('state') == 'MERGED' and observed.get('headRefOid') == state.get('delivery_head')
                    and evidence.get('review', {}).get('head_sha') == state.get('delivery_head')
                    and evidence.get('review', {}).get('status') == 'approved'
                    and observed.get('headRefName') == state.get('delivery_branch')
                    and observed.get('baseRefName') == config['base_branch']
                    and observed.get('url', '').casefold() == f'https://github.com/{config["repository"]}/pull/{state["pr_number"]}'.casefold()
                    and re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', str((observed.get('mergeCommit') or {}).get('oid', '')))):
                result = {'status': 'merged', 'pr_url': observed['url'], 'merge_commit': observed['mergeCommit']['oid']}
                save(path, state, 'completed', result=result)
                return {'status': 'completed', 'result': result}
            if observed.get('state') == 'CLOSED':
                raise WorkflowError('pr-closed-reconcile-feedback-before-delivery')
            if ('merge-outcome-unconfirmed' in state.get('result', {}).get('issues', [])
                    or 'merge-command-failed' in state.get('result', {}).get('issues', [])) and not retry_reason:
                raise WorkflowError('query-merge-outcome-and-diagnose-before-retry')
        current = TOOLS.snapshot(repo)
        accepted = TOOLS.accept(repo, task, evidence)
        reviewed = evidence.get('review', {})
        if (accepted['status'] != 'verified-local' or current['dirty']
                or reviewed.get('head_sha') != current['head_sha'] or reviewed.get('status') != 'approved'
                or reviewed.get('blocking_findings') != 0 or not reviewed.get('reviewers')):
            raise WorkflowError('delivery-needs-current-validation-and-independent-review')
        if current['head_sha'] == task['base_sha']:
            result = {'status': 'no-changes', 'head_sha': current['head_sha']}
            save(path, state, 'completed', result=result)
            return {'status': 'completed', 'result': result}
        if state['delivery'] == 'commit':
            result = {'status': 'committed', 'head_sha': current['head_sha']}
            save(path, state, 'completed', result=result)
            return {'status': 'completed', 'result': result}
        if (identity(repo) or '').casefold() != config['repository'].casefold() or current['branch'] == config['base_branch']:
            raise WorkflowError('delivery-needs-task-branch-and-matching-origin')
        state['delivery_head'] = current['head_sha']
        state['delivery_branch'] = current['branch']
        remote = command(['git', 'ls-remote', 'origin', 'refs/heads/' + current['branch']], repo).split()
        if not remote or remote[0] != current['head_sha']:
            save(path, state, 'pushing')
            try:
                command(['git', 'push', 'origin', 'HEAD:refs/heads/' + current['branch']], repo)
            except WorkflowError:
                remote = command(['git', 'ls-remote', 'origin', 'refs/heads/' + current['branch']], repo).split()
                if not remote or remote[0] != current['head_sha']:
                    save(path, state, 'blocked', issues=['push-not-confirmed'])
                    return {'status': 'blocked', 'issues': state['issues']}
        prs = pr_list(config, current['branch'])
        opened = [p for p in prs if p['state'] == 'OPEN']
        merged = [p for p in prs if p['state'] == 'MERGED' and p['headRefOid'] == current['head_sha']]
        if len(opened) > 1:
            raise WorkflowError('ambiguous-open-pr')
        if not opened and merged:
            number = merged[0]['number']
        elif opened:
            number = opened[0]['number']
        else:
            if state.get('creation_unconfirmed') and not retry_reason:
                raise WorkflowError('query-pr-outcome-before-retrying-creation')
            if not title or not body_file:
                raise WorkflowError('new-pr-needs-agent-written-title-and-body-file')
            save(path, state, 'creating-pr', creation_unconfirmed=True)
            try:
                command(['gh', 'pr', 'create', '--repo', config['repository'], '--base', config['base_branch'],
                         '--head', current['branch'], '--title', title, '--body-file', str(Path(body_file).resolve())])
            except WorkflowError:
                pass
            opened = [p for p in pr_list(config, current['branch']) if p['state'] == 'OPEN']
            if len(opened) != 1:
                save(path, state, 'blocked', issues=['pr-creation-unconfirmed'])
                return {'status': 'blocked', 'issues': state['issues']}
            number = opened[0]['number']
        reference, pr = observed_pr(config, number)
        if (pr.get('headRefOid') != current['head_sha'] or pr.get('headRefName') != current['branch']
                or pr.get('baseRefName') != config['base_branch']
                or pr.get('url', '').casefold() != f'https://github.com/{config["repository"]}/pull/{number}'.casefold()):
            raise WorkflowError('pr-identity-or-head-mismatch')
        save(path, state, 'observed-pr', pr_number=number, creation_unconfirmed=False)
        if state['delivery'] == 'pr' and pr.get('state') == 'OPEN':
            result = {'status': 'pr-delivered', 'pr_url': pr['url'], 'head_sha': current['head_sha']}
            save(path, state, 'completed', result=result)
            return {'status': 'completed', 'result': result}
        if pr.get('state') == 'MERGED' and (pr.get('mergeCommit') or {}).get('oid'):
            result = {'status': 'merged', 'pr_url': pr['url'], 'merge_commit': pr['mergeCommit']['oid']}
        else:
            result = TOOLS.merge_pr(repo, task, evidence, reference)
        status = 'completed' if result['status'] == 'merged' else ('waiting' if result['status'] == 'waiting' else 'blocked')
        save(path, state, status, result=result)
        return {'status': status, 'result': result}


def status(repo):
    repo = root(repo)
    config = configuration(repo)
    if lifecycle_pending(repo):
        return {'status': 'recovery-required', 'policy': config,
                'note': 'Retry upgrade or disconnect before starting work.'}
    directory = state_dir(repo, create=False)
    if not (directory / 'active.json').exists():
        missing = readiness(config)
        gate = policy_gate(config)
        return {'status': gate['status'] if gate else ('needs-configuration' if missing else 'configured'), 'missing': missing, 'policy': config}
    path, state = active(directory)
    return {'status': state['status'], 'task_id': state['id'], 'objective': state['objective'],
            'state_directory': str(path), 'attempts': state['attempts'], 'result': state.get('result'),
            'policy_changed': state['config_digest'] != config_digest(config), 'policy': config}


def cancel(repo, reason):
    repo = root(repo)
    with locked(state_dir(repo)):
        path, state = active(state_dir(repo))
        if state['status'] == 'completed':
            raise WorkflowError('completed-task-cannot-be-cancelled')
        save(path, state, 'cancelled', cancellation_reason=reason)
        return {'status': 'cancelled', 'state_directory': str(path),
                'note': 'Task records, user work, branches and existing PRs preserved.'}


def block(repo, reason):
    repo = root(repo)
    with locked(state_dir(repo)):
        path, state, _, _ = current_task(repo)
        if state['status'] in ('completed', 'cancelled'):
            raise WorkflowError('task-already-closed')
        save(path, state, 'blocked', reason=reason)
        return {'status': 'blocked', 'state_directory': str(path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['create', 'init', 'upgrade', 'disconnect', 'begin', 'check', 'review', 'deliver', 'status', 'block', 'cancel'])
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--client', choices=['none', 'codex', 'claude', 'both'])
    parser.add_argument('--profile', choices=['core', 'full'])
    parser.add_argument('--showcase', choices=['none', 'local', 'public'])
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--delivery', choices=list(LEVELS))
    parser.add_argument('--check', action='append')
    parser.add_argument('--ci-check', action='append')
    parser.add_argument('--no-ci', action='store_true')
    parser.add_argument('--base-branch')
    parser.add_argument('--plugin-path')
    parser.add_argument('--update', action='store_true')
    parser.add_argument('--migrate', action='store_true')
    parser.add_argument('--repository')
    parser.add_argument('--visibility', choices=['private', 'public'], default='private')
    parser.add_argument('--public', action='store_true')
    parser.add_argument('--objective')
    parser.add_argument('--allowed-path', action='append')
    parser.add_argument('--event-id')
    parser.add_argument('--head')
    parser.add_argument('--reviewer', action='append')
    parser.add_argument('--blocking-findings', type=int, default=0)
    parser.add_argument('--title')
    parser.add_argument('--body-file', type=Path)
    parser.add_argument('--retry-reason')
    parser.add_argument('--reason')
    try:
        args = parser.parse_args()
        if args.public and args.showcase not in (None, 'public'):
            raise WorkflowError('conflicting-public-showcase-options')
        showcase = 'public' if args.public else args.showcase
        if args.dry_run and args.operation not in ('create', 'init', 'upgrade', 'disconnect'):
            raise WorkflowError('dry-run-not-supported-for-this-operation')
        if args.migrate and args.dry_run:
            raise WorkflowError('legacy-migration-dry-run-not-supported')
        if args.operation == 'create':
            result = create(args.repo, args.repository, args.visibility, client=args.client, delivery=args.delivery,
                            checks=args.check, ci=args.ci_check, no_ci=args.no_ci, base=args.base_branch,
                            profile=args.profile, showcase=showcase, dry_run=args.dry_run)
        elif args.operation == 'init' and args.migrate:
            result = migrate(args.repo, args.repository)
        elif args.operation == 'init':
            result = initialize(args.repo, args.client, args.delivery, args.check, args.ci_check,
                                args.no_ci, args.base_branch, args.plugin_path, args.update,
                                profile=args.profile, showcase=showcase, dry_run=args.dry_run)
        elif args.operation == 'upgrade':
            result = upgrade(args.repo, args.delivery, args.client, args.profile, args.dry_run)
        elif args.operation == 'disconnect':
            result = disconnect(args.repo, args.dry_run)
        elif args.operation == 'begin':
            if not args.objective or not args.allowed_path:
                raise WorkflowError('begin-needs-objective-and-actual-allowed-paths')
            result = begin(args.repo, args.objective, args.allowed_path, args.event_id, args.delivery)
        elif args.operation == 'check':
            result = check(args.repo, args.retry_reason)
        elif args.operation == 'review':
            if not args.head or not args.reviewer:
                raise WorkflowError('review-needs-final-head-and-real-reviewer')
            result = review(args.repo, args.head, args.reviewer, args.blocking_findings)
        elif args.operation == 'deliver':
            result = deliver(args.repo, args.title, args.body_file, args.retry_reason)
        elif args.operation == 'status':
            result = status(args.repo)
        elif args.operation == 'cancel':
            if not args.reason:
                raise WorkflowError('cancellation-needs-user-directed-reason')
            result = cancel(args.repo, args.reason)
        else:
            if not args.reason:
                raise WorkflowError('block-needs-concrete-reason')
            result = block(args.repo, args.reason)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 3 if result['status'] == 'waiting' else (2 if result['status'] in ('blocked', 'needs-configuration', 'needs-policy-confirmation') else 0)
    except WorkflowError as error:
        print(json.dumps({'status': 'blocked', 'issues': [str(error)]}))
        return 2
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(json.dumps({'status': 'blocked', 'issues': [type(error).__name__],
                          'note': 'Read project policy and task state; reconcile the failed prerequisite before retrying. No credentials or raw CLI errors printed.'}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())

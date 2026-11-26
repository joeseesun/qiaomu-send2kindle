"""[INPUT]: 已固定身份的 SSH/SFTP、校验摘要与安装 ZIP。
[OUTPUT]: 安装备份、Kindle 本机校验收据与设备文件基线。
[POS]: 安装入口；复用 kindle_transport，不改凭据与阅读设置。
[PROTOCOL]: Update this header on change, then check AGENTS.md
"""
from __future__ import annotations
import contextlib, hashlib, json, os, re, shlex, stat, time, uuid, zipfile
from pathlib import Path
from filelock import FileLock, Timeout
from kindle_store import KindleError
from kindle_transport import profile_for, private_for, session

MAX_FILES = 8000
MAX_FILE = 64 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
UNSET = object()

# 固定程序只读取清单内的文件；不执行清单内容，不依赖 KOReader 模块。
VERIFY_SCRIPT = r'''
command -v sha256sum >/dev/null 2>&1 || exit 70
command -v readlink >/dev/null 2>&1 || exit 70
count=0
tab=$(printf '\t')
while IFS="$tab" read -r expected expected_size relative; do
    target="/mnt/us/$relative"
    if [ ! -f "$target" ]; then
        printf 'missing\t%s\n' "$relative"; count=$((count+1)); continue
    fi
    resolved=$(readlink -f "$target")
    case "$resolved" in /mnt/us/koreader/*|/mnt/us/extensions/koreader/*) ;;
        *) printf 'outside\t%s\n' "$relative"; count=$((count+1)); continue;; esac
    if [ ! -r "$target" ]; then
        printf 'unreadable\t%s\n' "$relative"
    else
        actual_size=$(wc -c < "$target")
        result=$(sha256sum "$target")
        status=$?
        actual=${result%% *}
        if [ "$status" -ne 0 ]; then printf 'unreadable\t%s\n' "$relative"
        elif [ "$actual_size" -ne "$expected_size" ]; then printf 'size\t%s\n' "$relative"
        elif [ "$actual" != "$expected" ]; then printf 'sha256\t%s\n' "$relative"; fi
    fi
    count=$((count+1))
done < "$1"
printf 'verified\t%s\n' "$count"
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_target(relative):
    if not isinstance(relative, str) or len(relative.encode()) > 240:
        raise KindleError('package-path', 'Invalid installation path.')
    if re.search(r'[\x00-\x1f\x7f\\:]', relative):
        raise KindleError('package-path', 'Invalid installation path.')
    parts = relative.split('/')
    if any(p in {'', '.', '..'} or p.startswith('.') for p in parts):
        raise KindleError('package-path', 'Unsafe installation path.')
    if parts[0] == 'koreader' and len(parts) > 1:
        if parts[1] in {'settings', 'cache', 'screenshots', 'clipboard'} or parts[1].startswith(('settings.', 'history.')):
            raise KindleError('package-settings', 'Packages cannot replace device settings or caches.')
    elif parts[:2] != ['extensions', 'koreader']:
        raise KindleError('package-path', 'Package target must be KOReader or its launcher.')
    return relative


def package_manifest(path, expected):
    path = Path(path).expanduser().resolve(strict=True)
    if not isinstance(expected, str) or not re.fullmatch('[a-fA-F0-9]{64}', expected):
        raise KindleError('package-sha256', 'Supply the publisher SHA-256 with --sha256.')
    if path.stat().st_size > MAX_TOTAL:
        raise KindleError('package-size', 'Installation ZIP exceeds 512 MiB.')
    if digest(path.read_bytes()) != expected.lower():
        raise KindleError('package-sha256', 'ZIP SHA-256 does not match; nothing was installed.')
    with zipfile.ZipFile(path) as archive:
        members = [i for i in archive.infolist() if not i.is_dir()]
        if not 0 < len(members) <= MAX_FILES or sum(i.file_size for i in members) > MAX_TOTAL:
            raise KindleError('package-size', 'Empty or oversized installation ZIP.')
        names = [i.filename for i in members]
        roots = {n.split('/')[0] for n in names}
        if roots <= {'koreader', 'extensions'} and 'koreader/reader.lua' in names:
            kind, component = 'core', 'koreader'
            if 'koreader/frontend/apps/reader/readerui.lua' not in names:
                raise KindleError('package-layout', 'Incomplete KOReader package.')
        elif len(roots) == 1 and re.fullmatch(r'[A-Za-z0-9_-]+\.koplugin', next(iter(roots))):
            kind, component = 'plugin', next(iter(roots))
            if component + '/main.lua' not in names:
                raise KindleError('package-layout', 'Plugin ZIP must contain main.lua.')
        else:
            raise KindleError('package-layout', 'Use an installable KOReader or .koplugin ZIP, not a source ZIP.')
        files = []
        seen = set()
        for info in members:
            if info.flag_bits & 1 or stat.S_ISLNK(info.external_attr >> 16) or info.file_size > MAX_FILE:
                raise KindleError('package-type', 'Encrypted, linked or oversized ZIP member.')
            relative = info.filename if kind == 'core' else 'koreader/plugins/' + info.filename
            validate_target(relative)
            folded = relative.casefold()
            if folded in seen:
                raise KindleError('package-path', 'Duplicate or case-colliding ZIP paths.')
            seen.add(folded)
            data = archive.read(info)
            files.append({'path': relative, 'member': info.filename, 'size': len(data), 'sha256': digest(data)})
    return {'kind': kind, 'component': component, 'zip': str(path), 'package_sha256': expected.lower(), 'files': files}


def run_remote(transport, command, timeout=180):
    channel = transport.open_session(timeout=6)
    channel.settimeout(1)
    output = bytearray()
    deadline = time.monotonic() + timeout
    try:
        channel.exec_command(command)
        while True:
            if time.monotonic() > deadline:
                raise KindleError('verification-timeout', 'Native check timed out; installation is unverified.')
            if channel.recv_ready():
                chunk = channel.recv(65536)
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > 4 * 1024 * 1024:
                    raise KindleError('verification-output', 'Native check response exceeds its limit.')
            elif channel.exit_status_ready():
                break
            else:
                time.sleep(.01)
        code = channel.recv_exit_status()
        if code != 0:
            raise KindleError('verification-runner', 'Kindle native checker failed; no success receipt is available.')
        return output.decode('utf-8', errors='strict')
    finally:
        channel.close()


def native_verify(transport, sftp, files):
    if not files:
        raise KindleError('verification-empty', 'No files to verify.')
    for item in files:
        validate_target(item['path'])
    remote = '/tmp/qiaomu-integrity-' + uuid.uuid4().hex
    sftp.mkdir(remote)
    try:
        sftp.chmod(remote, 0o700)
        manifest = remote + '/manifest.tsv'
        data = ''.join(f"{i['sha256']}\t{i['size']}\t{i['path']}\n" for i in files).encode()
        with sftp.open(manifest, 'wx') as stream:
            stream.write(data)
        output = run_remote(transport, 'sh -c ' + shlex.quote(VERIFY_SCRIPT) + ' -- ' + shlex.quote(manifest))
        issues, count = [], None
        known = {i['path'] for i in files}
        for line in output.splitlines():
            status, sep, value = line.partition('\t')
            if status == 'verified' and sep and value.isdigit() and count is None:
                count = int(value)
            elif status in {'missing', 'unreadable', 'outside', 'size', 'sha256'} and value in known:
                issues.append({'path': value, 'reason': status})
            else:
                raise KindleError('verification-protocol', 'Incomplete or invalid native check response.')
        if count != len(files):
            raise KindleError('verification-incomplete', 'Native checker did not examine every expected file.')
        return {'ok': not issues, 'verification': 'kindle-native-sha256', 'files_checked': count, 'issues': issues}
    finally:
        with contextlib.suppress(OSError):
            sftp.remove(remote + '/manifest.tsv')
        with contextlib.suppress(OSError):
            sftp.rmdir(remote)


def safe_remote_path(sftp, relative, create=False):
    validate_target(relative)
    current = '/mnt/us'
    parts = relative.split('/')
    for index, part in enumerate(parts):
        current += '/' + part
        try:
            entry = sftp.lstat(current)
        except OSError as error:
            if error.errno != 2:
                raise
            if index < len(parts) - 1 and create:
                sftp.mkdir(current)
            continue
        if stat.S_ISLNK(entry.st_mode) or (index < len(parts) - 1 and not stat.S_ISDIR(entry.st_mode)):
            raise KindleError('installation-path', 'Linked or non-directory installation target; nothing replaced there.')
    return current


def replace_remote(sftp, relative, data, expected_before=UNSET):
    path = safe_remote_path(sftp, relative, create=True)
    temporary = path + '.qiaomu-install-' + uuid.uuid4().hex
    try:
        with sftp.open(temporary, 'wx') as stream:
            stream.write(data)
        with sftp.open(temporary, 'rb') as stream:
            if digest(stream.read()) != digest(data):
                raise KindleError('installation-upload', 'Uploaded file readback failed.')
        if expected_before is not UNSET:
            safe_remote_path(sftp, relative)
            try:
                with sftp.open(path, 'rb') as stream:
                    current = digest(stream.read(MAX_FILE + 1))
            except OSError as error:
                if error.errno != 2:
                    raise
                current = None
            if current != expected_before:
                raise KindleError('installation-changed', 'Target changed after backup; concurrent content was not overwritten.')
        sftp.posix_rename(temporary, path)
    finally:
        with contextlib.suppress(OSError):
            sftp.remove(temporary)


def load_baseline(path, fingerprint):
    if not path.exists():
        return {'fingerprint': fingerprint, 'components': []}
    if path.is_symlink() or path.stat().st_size > 8 * 1024 * 1024:
        raise KindleError('baseline', 'Invalid local installation baseline.')
    value = json.loads(path.read_text(encoding='utf-8'))
    if value.get('fingerprint') != fingerprint or not isinstance(value.get('components'), list):
        raise KindleError('baseline', 'Installation baseline belongs to another device identity.')
    for component in value['components']:
        for item in component['files']:
            validate_target(item['path'])
            if not re.fullmatch('[a-f0-9]{64}', item['sha256']) or type(item['size']) is not int or not 0 <= item['size'] <= MAX_FILE:
                raise KindleError('baseline', 'Invalid baseline file record.')
    return value


def maintenance(store, keys, package, expected, device_id=None, mode=None, install=False):
    candidate = package_manifest(package, expected)
    did, device, mode, profile = profile_for(store, device_id, mode)
    if mode != 'koreader':
        raise KindleError('maintenance-mode', 'Package maintenance requires the paired KOReader SSH profile.')
    folder = store.root / 'installations' / did
    if folder.is_symlink() or folder.parent.is_symlink():
        raise KindleError('baseline', 'Installation state cannot use linked directories.')
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        with FileLock(str(folder / 'operation.lock'), timeout=0):
            baseline_path = folder / 'baseline.json'
            baseline = load_baseline(baseline_path, profile.get('fingerprint'))
            if candidate['kind'] != 'core' and not any(c['kind'] == 'core' for c in baseline['components']):
                raise KindleError('baseline-required', 'First verify the matching official KOReader ZIP to establish a core baseline.')
            components = [c for c in baseline['components'] if c['component'] != candidate['component']]
            components.append({k: candidate[k] for k in ['kind', 'component', 'package_sha256', 'files']})
            merged = {}
            for component in components:
                merged.update({i['path']: i for i in component['files']})
            with session(profile, private_for(keys, device)) as (transport, sftp, fingerprint):
                backup = None
                changed = []
                try:
                    if install:
                        if candidate['kind'] == 'core':
                            busy = run_remote(transport, "for p in /proc/[0-9]*/comm; do IFS= read -r n < \"$p\"; case \"$n\" in reader.lua|luajit) printf busy; break;; esac; done", timeout=10)
                            if busy:
                                raise KindleError('reader-running', 'Exit KOReader before updating its core; retain the existing SSH service.')
                        backup = folder / ('backup-' + uuid.uuid4().hex)
                        backup.mkdir(mode=0o700)
                        (backup / 'operation.json').write_text(json.dumps({
                            'component': candidate['component'], 'package_sha256': candidate['package_sha256'],
                            'files': candidate['files']}, ensure_ascii=False, indent=2), encoding='utf-8')
                        with zipfile.ZipFile(candidate['zip']) as archive:
                            for item in candidate['files']:
                                path = safe_remote_path(sftp, item['path'])
                                try:
                                    with sftp.open(path, 'rb') as stream:
                                        old = stream.read(MAX_FILE + 1)
                                    if len(old) > MAX_FILE:
                                        raise KindleError('installation-backup', 'Existing file exceeds backup limit.')
                                except OSError as error:
                                    if error.errno != 2:
                                        raise
                                    old = None
                                data = archive.read(item['member'])
                                if digest(data) != item['sha256'] or len(data) != item['size']:
                                    raise KindleError('package-changed', 'ZIP changed during installation; stop and restore replaced files.')
                                if old == data:
                                    continue
                                if old is not None:
                                    target = backup / item['path']
                                    target.parent.mkdir(parents=True, exist_ok=True)
                                    target.write_bytes(old)
                                    if digest(target.read_bytes()) != digest(old):
                                        raise KindleError('installation-backup', 'Backup readback failed; existing file not replaced.')
                                changed.append((item['path'], old, digest(data)))
                                replace_remote(sftp, item['path'], data, digest(old) if old is not None else None)
                        run_remote(transport, 'sync', timeout=30)
                    report = native_verify(transport, sftp, list(merged.values()))
                    report.update(device=did, component=candidate['component'], package_sha256=candidate['package_sha256'], operation='install-package' if install else 'verify-installation')
                    if not report['ok']:
                        report['installed'] = False
                        if install:
                            report['rollback'] = rollback(sftp, changed)
                            report['backup'] = str(backup)
                        return report
                except Exception as error:
                    if install and changed:
                        return {'ok': False, 'code': getattr(error, 'code', 'installation-failed'),
                                'error': str(error) if isinstance(error, KindleError) else 'Installation failed; inspect rollback and backup before retrying.',
                                'backup': str(backup), 'installed': False, 'rollback': rollback(sftp, changed)}
                    raise
                # 只有设备本机完整校验通过，才接受新基线。
                value = {'fingerprint': fingerprint, 'components': components}
                temp = baseline_path.with_name('baseline-' + uuid.uuid4().hex + '.tmp')
                try:
                    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                        json.dump(value, stream, ensure_ascii=False)
                        stream.flush(); os.fsync(stream.fileno())
                    os.replace(temp, baseline_path)
                except OSError:
                    with contextlib.suppress(OSError):
                        temp.unlink()
                    return {'ok': False, 'code': 'baseline-save', 'error': 'Could not save the verified baseline.',
                            'installed': False, 'backup': str(backup) if backup else None,
                            'rollback': rollback(sftp, changed) if changed else None}
                report.update(installed=install, changed_files=len(changed), baseline_saved=True,
                              restart_required=install and bool(changed), runtime_verified=False)
                if backup:
                    report['backup'] = str(backup)
                return report
    except Timeout:
        raise KindleError('installation-busy', 'Another installation/check is active for this device.') from None


def rollback(sftp, changed):
    failed = []
    for relative, old, installed_hash in reversed(changed):
        try:
            path = safe_remote_path(sftp, relative)
            try:
                with sftp.open(path, 'rb') as stream:
                    current = stream.read(MAX_FILE + 1)
            except OSError as error:
                if error.errno != 2:
                    raise
                current = None
            # 保留其他进程在安装期间写入的内容。
            if current is not None and digest(current) not in {installed_hash, digest(old) if old is not None else ''}:
                failed.append(relative); continue
            if old is None:
                if current is not None:
                    sftp.remove(path)
            else:
                replace_remote(sftp, relative, old)
        except Exception:
            failed.append(relative)
    return {'ok': not failed, 'failed_paths': failed}


SCRIPT_INTERFACE = "internal-module"

"""[INPUT]: ZIP 样本、独立 SFTP/设备文件视图与固定校验程序。
[OUTPUT]: 安装门禁、基线、回退和设备端校验回归。
[POS]: 安装模块的行为测试；不连接真实设备。
[PROTOCOL]: Update this header on change, then check AGENTS.md
"""
import contextlib, hashlib, io, json, os, shlex, shutil, stat, subprocess, sys, tempfile, unittest, zipfile
from pathlib import Path
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import kindle_install as install
from kindle_store import ConfigStore, KindleError


class SFTP:
    def __init__(self, root): self.root = root
    def path(self, path): return self.root / path.lstrip('/')
    def open(self, path, mode): return self.path(path).open(('xb' if 'x' in mode else mode + ('' if 'b' in mode else 'b')))
    def mkdir(self, path): self.path(path).mkdir()
    def chmod(self, path, mode): self.path(path).chmod(mode)
    def rmdir(self, path): self.path(path).rmdir()
    def remove(self, path): self.path(path).unlink()
    def lstat(self, path): return self.path(path).lstat()
    def posix_rename(self, source, dest): os.replace(self.path(source), self.path(dest))


class Channel:
    def __init__(self, root): self.root = root; self.output = b''; self.code = 0
    def settimeout(self, n): pass
    def exec_command(self, command):
        if command.startswith('for p in /proc/') or command == 'sync': return
        # 相同校验程序在隔离文件树执行；不接触主机真实 /mnt/us。
        command = command.replace('/mnt/us/', str(self.root / 'mnt/us') + '/').replace('/tmp/qiaomu-integrity-', str(self.root / 'tmp/qiaomu-integrity-'))
        run = subprocess.run(command, shell=True, capture_output=True, timeout=10)
        self.output, self.code = run.stdout, run.returncode
    def recv_ready(self): return bool(self.output)
    def recv(self, n): chunk, self.output = self.output[:n], self.output[n:]; return chunk
    def exit_status_ready(self): return not self.output
    def recv_exit_status(self): return self.code
    def close(self): pass


class Transport:
    def __init__(self, root): self.root = root
    def open_session(self, **kwargs): return Channel(self.root)


class PackageTests(unittest.TestCase):
    def package(self, root, files, name='package.zip'):
        path = root / name
        with zipfile.ZipFile(path, 'w') as archive:
            for key, value in files.items(): archive.writestr(key, value)
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def test_archive_boundaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ['../escape', '/absolute', 'p.koplugin/../escape', 'p.koplugin/a\nb', 'p.koplugin/a\\b']:
                path, sha = self.package(root, {'p.koplugin/main.lua': 'return {}', name: 'bad'})
                with self.assertRaises(KindleError): install.package_manifest(path, sha)
            for name in ['koreader/settings/SSH/authorized_keys', 'koreader/settings.reader.lua', 'extensions/other/main.sh']:
                path, sha = self.package(root, {'koreader/reader.lua': 'ok', 'koreader/frontend/apps/reader/readerui.lua': 'ok', name: 'bad'})
                with self.assertRaises(KindleError): install.package_manifest(path, sha)
            path, sha = self.package(root, {'p.koplugin/main.lua': 'return {}'})
            with self.assertRaises(KindleError): install.package_manifest(path, '0' * 64)
            with self.assertRaises(KindleError): install.package_manifest(path, None)
            path, sha = self.package(root, {'p.koplugin/main.lua': 'a', 'p.koplugin/MAIN.lua': 'b'})
            with self.assertRaises(KindleError): install.package_manifest(path, sha)
            path = root / 'link.zip'
            with zipfile.ZipFile(path, 'w') as archive:
                link = zipfile.ZipInfo('p.koplugin/main.lua'); link.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(link, '/etc/passwd')
            with self.assertRaises(KindleError): install.package_manifest(path, hashlib.sha256(path.read_bytes()).hexdigest())


@unittest.skipUnless(os.name != 'nt' and shutil.which('sh') and shutil.which('sha256sum') and shutil.which('readlink'), 'Native shell simulation requires POSIX checksum tools; archive tests still run.')
class NativeTests(PackageTests):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.device = self.root / 'device'
        (self.device / 'mnt/us/koreader').mkdir(parents=True)
        (self.device / 'tmp').mkdir()
        self.sftp, self.transport = SFTP(self.device), Transport(self.device)
        self.store = ConfigStore(self.root / 'state')
        self.profile = {'fingerprint': 'a' * 64}
        self.device_record = {'credential_id': 'fixture'}
        self.patches = [patch.object(install, 'profile_for', return_value=('fixture', self.device_record, 'koreader', self.profile)),
                        patch.object(install, 'private_for', return_value='never exported'),
                        patch.object(install, 'session', self.session)]
        for item in self.patches: item.start(); self.addCleanup(item.stop)

    @contextlib.contextmanager
    def session(self, *args, **kwargs): yield self.transport, self.sftp, 'a' * 64

    def core(self):
        files = {'koreader/reader.lua': b'return {}', 'koreader/frontend/apps/reader/readerui.lua': b'return {}',
                 'koreader/frontend/apps/reader/modules/readerkeyselection.lua': b'return {restored=true}'}
        for relative, data in files.items():
            p = self.device / 'mnt/us' / relative; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data)
        return self.package(self.root, files, 'core.zip')

    def test_native_missing_even_when_host_can_read(self):
        path, sha = self.core(); manifest = install.package_manifest(path, sha)
        missing = self.device / 'mnt/us/koreader/frontend/apps/reader/modules/readerkeyselection.lua'
        missing.unlink()
        # ZIP 和主机文件均存在，设备文件视图独立缺失。
        (self.root / 'readerkeyselection.lua').write_text('host sees file')
        report = install.native_verify(self.transport, self.sftp, manifest['files'])
        self.assertFalse(report['ok']); self.assertEqual(report['issues'][0]['reason'], 'missing')
        self.assertEqual(list((self.device / 'tmp').iterdir()), [])

    def test_hash_size_and_symlink_failures(self):
        path, sha = self.core(); manifest = install.package_manifest(path, sha)
        target = self.device / 'mnt/us/koreader/reader.lua'
        target.write_bytes(b'x' * len(b'return {}'))
        self.assertEqual(install.native_verify(self.transport, self.sftp, manifest['files'])['issues'][0]['reason'], 'sha256')
        target.write_bytes(b'x')
        self.assertEqual(install.native_verify(self.transport, self.sftp, manifest['files'])['issues'][0]['reason'], 'size')
        target.unlink(); outside = self.root / 'outside'; outside.write_text('private'); target.symlink_to(outside)
        self.assertEqual(install.native_verify(self.transport, self.sftp, manifest['files'])['issues'][0]['reason'], 'outside')

    def test_installation_always_verifies_core_and_plugin_and_preserves_settings(self):
        core, sha = self.core()
        self.assertTrue(install.maintenance(self.store, None, core, sha)['ok'])
        settings = self.device / 'mnt/us/koreader/settings.reader.lua'; settings.write_text('keep original')
        archive, checksum = self.package(self.root, {'p.koplugin/main.lua': 'return {version=1}'}, 'plugin.zip')
        report = install.maintenance(self.store, None, archive, checksum, install=True)
        self.assertTrue(report['ok']); self.assertEqual(report['files_checked'], 4)
        self.assertEqual(settings.read_text(), 'keep original'); self.assertFalse(report['runtime_verified'])
        archive, checksum = self.package(self.root, {'p.koplugin/main.lua': 'return {version=2}'}, 'plugin.zip')
        (self.device / 'mnt/us/koreader/frontend/apps/reader/modules/readerkeyselection.lua').unlink()
        failed = install.maintenance(self.store, None, archive, checksum, install=True)
        self.assertFalse(failed['ok']); self.assertTrue(failed['rollback']['ok'])
        self.assertIn('version=1', (self.device / 'mnt/us/koreader/plugins/p.koplugin/main.lua').read_text())
        baseline = json.loads((self.store.root / 'installations/fixture/baseline.json').read_text())
        self.assertEqual(baseline['components'][-1]['package_sha256'], report['package_sha256'])

    def test_empty_or_truncated_native_response_cannot_pass(self):
        core, sha = self.core(); files = install.package_manifest(core, sha)['files']
        for response in ['', 'verified\t0\n', 'verified\t3\nverified\t3\n', 'garbage\n']:
            with patch.object(install, 'run_remote', return_value=response), self.assertRaises(KindleError):
                install.native_verify(self.transport, self.sftp, files)

    def test_first_plugin_requires_core_baseline(self):
        archive, checksum = self.package(self.root, {'p.koplugin/main.lua': 'return {}'})
        with self.assertRaises(KindleError) as e:
            install.maintenance(self.store, None, archive, checksum, install=True)
        self.assertEqual(e.exception.code, 'baseline-required')
        self.assertFalse((self.device / 'mnt/us/koreader/plugins').exists())

    def test_core_update_refuses_running_reader(self):
        core, sha = self.core()
        with patch.object(install, 'run_remote', return_value='busy'), self.assertRaises(KindleError) as e:
            install.maintenance(self.store, None, core, sha, install=True)
        self.assertEqual(e.exception.code, 'reader-running')

    def test_identity_change_refuses_old_baseline(self):
        core, sha = self.core(); install.maintenance(self.store, None, core, sha)
        self.profile['fingerprint'] = 'b' * 64
        with self.assertRaises(KindleError): install.maintenance(self.store, None, core, sha)

    def test_rollback_keeps_concurrent_changes(self):
        self.core()
        relative = 'koreader/reader.lua'
        path = self.device / 'mnt/us' / relative
        path.write_bytes(b'another installer wrote this')
        result = install.rollback(self.sftp, [(relative, b'old', install.digest(b'ours'))])
        self.assertFalse(result['ok']); self.assertEqual(result['failed_paths'], [relative])
        self.assertEqual(path.read_bytes(), b'another installer wrote this')

    def test_replacement_refuses_changed_target(self):
        self.core()
        relative = 'koreader/reader.lua'
        path = self.device / 'mnt/us' / relative
        path.write_bytes(b'changed since backup')
        with self.assertRaises(KindleError) as error:
            install.replace_remote(self.sftp, relative, b'new install', install.digest(b'old backup'))
        self.assertEqual(error.exception.code, 'installation-changed')
        self.assertEqual(path.read_bytes(), b'changed since backup')
        self.assertFalse(list(path.parent.glob('*.qiaomu-install-*')))


if __name__ == '__main__': unittest.main()

#!/usr/bin/env python3
"""Explicit, standalone preparation of a jailbroken Kindle. Never run by the plugin.

Downloads pinned USBNetLite distributions from their original author. Extracts only
Dropbear and OpenSSH binaries; does not execute their installer or change USB mode.
The SP01/FD04 wire format was checked against NiLuJe/KindleTool (GPL-3.0).
This parser is an independent, deliberately limited implementation of that format.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import struct
import tarfile
import tempfile
import urllib.request

PACKAGES = {
    'standard': ('Update_usbnetlite_1.0.M_install_khf.bin', 'cbd2a7806460efc5129f43d982193b2f8091f8067a54a61810e124b0833c09e4'),
    'recent': ('Update_usbnetlite_1.0.P_install_khf_11thgenplus.bin', '233f976018c6fbdd4094f43097b1ce013b5d1343c9b3bba858b9da62d8ff52c6'),
}

def ungarble(data):
    return bytes((((x ^ 0x7a) & 15) << 4) | ((x ^ 0x7a) >> 4) for x in data)

def binaries(data, digest):
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Upstream package SHA256 mismatch; nothing installed.')
    if data[:4] != b'SP01' or data[192:196] != b'FD04':
        raise ValueError('Unsupported upstream package format.')
    offset = 196
    count = struct.unpack_from('<H', data, offset + 16)[0]
    offset += 18 + 2 * count
    header = data[offset:offset + 36]
    offset += 36
    for _ in range(struct.unpack_from('<H', header, 34)[0]):
        length = struct.unpack_from('>H', data, offset)[0]
        offset += 2 + length
    payload = ungarble(data[offset:])
    # MD5 is only a container integrity check. SHA256 above authenticates the pin.
    if hashlib.md5(payload).hexdigest().encode() != ungarble(header[2:34]):
        raise ValueError('Invalid package payload.')
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as outer:
        info = outer.getmember('usbnetlite.tar.xz')
        if not info.isfile() or info.size > 5_000_000:
            raise ValueError('Invalid inner archive.')
        inner_bytes = outer.extractfile(info).read()
    result = {}
    with tarfile.open(fileobj=io.BytesIO(inner_bytes), mode='r:xz') as inner:
        for name in ['dropbearmulti', 'sftp-server']:
            matches = [m for m in inner.getmembers() if m.name.endswith('/bin/' + name) and m.isfile()]
            if len(matches) != 1 or matches[0].size > 5_000_000:
                raise ValueError('Missing or ambiguous receiver binary: ' + name)
            content = inner.extractfile(matches[0]).read()
            if content[:5] != b'\x7fELF\x01':
                raise ValueError('Receiver is not a 32-bit ELF.')
            result[name] = content
    return result

def contained(root, path):
    if not path.resolve().is_relative_to(root):
        raise ValueError('Path leaves Kindle storage: ' + path.name)
    return path

def prepare(volume, package_dir=None):
    root = Path(volume).resolve(strict=True)
    version_file = contained(root, root / 'system/version.txt')
    if not version_file.read_text().startswith('Kindle 5.'):
        raise ValueError('Not a recognized Kindle drive.')
    target = contained(root, root / 'qiaomu-kindle')
    if target.exists():
        raise ValueError('Receiver already prepared. Keep its keys; do not overwrite it.')
    documents = contained(root, root / 'documents')
    if not documents.is_dir():
        raise ValueError('Kindle documents folder missing.')
    scripts = Path(__file__).resolve().parent
    # Finish all network and extraction work before touching Kindle.
    prepared = {}
    for variant, (name, digest) in PACKAGES.items():
        if package_dir:
            data = (Path(package_dir) / name).read_bytes()
        else:
            url = 'https://github.com/notmarek/kindle-usbnetlite/releases/download/1.0.M/' + name
            with urllib.request.urlopen(url, timeout=30) as response:
                data = response.read(10_000_001)
        if len(data) > 10_000_000:
            raise ValueError('Oversized upstream download.')
        prepared[variant] = binaries(data, digest)
    staging = Path(tempfile.mkdtemp(prefix='.qiaomu-prepare-', dir=root))
    created_scripts = []
    try:
        for variant, files in prepared.items():
            directory = staging / 'bin' / variant
            directory.mkdir(parents=True)
            for name, data in files.items():
                dest = directory / name
                dest.write_bytes(data)
                if dest.read_bytes() != data:
                    raise IOError('Kindle readback failed.')
        for name in ['serve.sh', 'dispatch.sh', 'firewall.sh', 'scan.sh', 'qiaomu-kindle.conf', 'qiaomu-kindle-scan.conf']:
            shutil.copyfile(scripts / name, staging / name)
        (staging / 'receiver.json').write_text(json.dumps({'protocol': 1, 'port': 2223, 'prepared': True, 'installed': False}) + '\n')
        keydir = contained(root, root / 'usbnetlite/etc/dropbear')
        keydir.mkdir(parents=True, exist_ok=True)
        contained(root, keydir)
        install = contained(root, documents / 'Install Qiaomu Kindle.sh')
        uninstall = contained(root, documents / 'Remove Qiaomu Kindle.sh')
        if install.exists() or uninstall.exists():
            raise ValueError('Setup script already exists; inspect before replacing.')
        for source, destination in [('install.sh', install), ('uninstall.sh', uninstall)]:
            content = (scripts / source).read_bytes()
            with destination.open('xb') as output:
                created_scripts.append(destination)
                output.write(content)
            if destination.read_bytes() != content:
                raise IOError('Setup script readback failed.')
        # The prepared marker becomes visible only after both scriptlets exist.
        staging.rename(target)
    except Exception:
        for destination in created_scripts:
            destination.unlink(missing_ok=True)
        raise
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    print('Prepared. Run the skill pair command in native mode while USB is connected.')
    print('Then safely eject, unplug, and open Install Qiaomu Kindle in the Kindle library.')
    print('Existing KOReader, USB networking, books and OTA protection were not modified.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('volume', help='Mounted Kindle drive')
    parser.add_argument('--package-dir', help='Use the two pinned upstream packages downloaded separately')
    args = parser.parse_args()
    try:
        prepare(args.volume, args.package_dir)
    except (OSError, ValueError, KeyError, struct.error, tarfile.TarError) as error:
        parser.exit(1, str(error) + '\n')

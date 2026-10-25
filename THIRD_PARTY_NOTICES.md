# Copyright and third-party notices

Copyright (c) 2026 向阳乔木. The complete skill is distributed under GPL-3.0-only; see LICENSE.

- `scripts/converter/src/kindle-epub.js`, configuration, scheduler, native receiver and synthetic test fixture: adapted from **joeseesun/qiaomu-reader**, GPL-3.0-only, source revision bf16816. Changes: standalone Node CLI, browser scheduler portability, standalone setup instructions. Corresponding modified source is included.
- `scripts/converter/vendor/kindle-azw3`: adapted Lyceum AZW3 writer, original MIT terms retained in vendor README and licenses/lyceum-MIT.txt.
- Converter bundle dependencies: JSZip 3.10.1, @xmldom/xmldom 0.9.12, PostCSS 8.5.31 and their bundled dependency closure. Original full license files are included under scripts/converter/licenses, with linked legal comments in converter.cjs.LEGAL.txt. JSZip is dual licensed MIT/GPLv3; the MIT option applies to its dependency use here.
- Independent reader tests use foliate-js (MIT) and jsdom (MIT), installed for development only; they are not bundled into the distributed converter.
- Python dependencies are installed separately from the pinned requirements. Their own distribution licenses apply (Paramiko LGPL, keyring MIT, filelock Unlicense, psutil BSD and dependency notices).
- Receiver preparation downloads checksum-pinned original USBNetLite release binaries only when explicitly invoked. Those binaries are not redistributed in this repository. See receiver/README.md for upstream credits.

No third-party code was relabeled as proprietary or silently relicensed. Full source and build lockfile for the distributed converter are included.

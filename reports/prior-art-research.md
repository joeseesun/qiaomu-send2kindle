# Prior-art research — 2026-10-25 (v2.0.0)

## Current redesign

The dual-catalog runner queried `kindle wireless ssh transfer skill` and `system keychain credentials python`: 10 deduplicated families. skills.sh had no parseable Kindle-transfer candidate; SkillsMP returned mostly lexical “kindly” matches. The sole skills.sh keychain result, xixu-me/skills openclaw-secure-linux-cloud (13 installs), concerns cloud OpenClaw deployment, not local device credentials; rejected by intent without executing its code. ECC continuous-learning/design-system/healthcare/verification candidates and the kindly-advice family were similarly unrelated. These catalog results were not adopted; no quality or superiority claim is supported. Catalog metrics are not ratings.

Primary implementation material: first-party Qiaomu Reader bf16816, GPL-3.0-only. Keep its bounded EPUB conversion, upstream AZW writer attribution and native receiver protocol. Adapt to a fixed local Node CLI and isolated Python transport. The overall skill is now GPL-3.0-only, with modified source and third-party licenses included; the old API bridge below is historical.

Original v2 work: native OS credential references, physical public-key pairing, pinned host checks before authentication, bounded LAN discovery, full SFTP readback, explicit migration and same-name preservation. The Obsidian entry remains supported by its existing implementation. Its vault-bound SecretStorage is rejected as a dependency for the independent skill, not removed as a product feature.

Storage references: [Apple Keychain](https://developer.apple.com/documentation/security/storing-keys-in-the-keychain), [Windows Credential Manager](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew), [Secret Service](https://specifications.freedesktop.org/secret-service/latest/). The installed keyring backend source was inspected to confirm direct Security.framework calls on macOS. No candidate/catalog code was run.

Missing evidence: no directly equivalent catalog skill found; no Windows/Linux device/keychain runtime acceptance, user study or fair comparative benchmark.

## Historical v1 research — 2026-10-24

Queries: `kindle wireless send ebook`, `koreader sftp transfer`. Meta skill's dual-catalog runner returned 14 deduplicated source families via SkillsMP. skills.sh returned no parseable candidates for either query: missing evidence, no adoption comparison claim.

Studied sources:

- Local `qiaomu-ebook-downloader/SKILL.md`: retain the remote MCP route, sequential search/download, actual file inspection and status-first diagnosis. Adapt by continuing to a verified device receipt. Reject the historical local Telegram fallback.
- [readest/readest koreader-e2e](https://github.com/readest/readest/tree/main/apps/readest-app/.claude/skills/koreader-e2e): 25,287 repository stars reported by SkillsMP on this run; this measures repository popularity, not this skill's quality. Inspected SKILL.md read-only. Retain the distinction between protocol fixtures and a real device, and sleeping/Wi-Fi diagnosis. Reject its installation-specific blank-password advice: our device has verified key-only authentication. No code or prose copied; candidate license was not established and no execution was permitted.
- Qiaomu Reader's current Kindle controller and the installed KOReader SSH source: reuse actual pairing, pinned identity and full read-back verification. Do not duplicate GPL implementation in the skill; this original Python adapter calls the running plugin API.

Rejected unrelated catalog results: “kindly” feedback skills were lexical false matches; KMReader App Store/localization skills solve a different task; KOReader development/weather skills do not provide a download-to-device workflow. No catalog code was executed.

Original contribution: compose ebook MCP selection with explicit local-file inspection and a key-free Obsidian bridge; preserve a library copy and require a SHA256/byte-count device receipt. Treat mismatched editions and unknown timeout state as actionable boundaries.

Official references: [KOReader SSH](https://github.com/koreader/koreader/wiki/SSH), [Obsidian SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage). Observed compatibility is macOS + Obsidian 1.13.7 + KOReader 2026.07.1; other combinations remain missing evidence.

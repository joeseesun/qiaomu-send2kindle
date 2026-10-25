# Bundled AZW3 writer

Adapted from Higino-Neto/Lyceum commit 806be2fd3677c77cd2bff5f61793ef4564ad2cca, MIT. See ../../licenses/lyceum-MIT.txt. Original files: src/lib/lyceum/mobi/azw3Writer.ts, epub/cssSanitizer.ts, textual.ts and schema/types.ts.

The binary KF8/PalmDOC/index writer is reused with attribution. Qiaomu replaces JSDOM with a small xmldom traversal adapter, removes unused source-EPUB embedding, supplies EPUB parsing/sanitization/resource bounds in src/kindle-epub.js, and runs conversion inside a disposable Node process in this skill (a browser worker in Qiaomu Reader). Correct EXTH title/language field types, preserve source headings and IDs, map same-chapter NCX anchors to their byte positions, add Chinese locale codes and disable CSS source-map loading. No upstream application UI, accounts or filesystem exporter is bundled.

Compatibility is verified with an independent reader. This is not a claim that upstream's sample output or our own headers prove Kindle readability. Unsupported resource/layout and malformed inputs fail before any book upload; no silent text truncation or cloud fallback.

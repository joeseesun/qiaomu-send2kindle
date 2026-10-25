/*! Adapted from Lyceum, Copyright (c) 2026 Higino P. C. Neto, MIT.
 * Source: https://github.com/Higino-Neto/Lyceum/tree/806be2fd3677c77cd2bff5f61793ef4564ad2cca
 * Qiaomu adaptation: portable XML DOM, no source EPUB embedding, bounded input.
 * Complete permission notice: licenses/lyceum-MIT.txt.
 */
import type { LyceumBookMetadata, LyceumTextualContent, LyceumTextualResource } from "./types.ts";
import { parseXml, serializeXml, selectElements } from "./xml.js";
import { renderKindleDefaultCss, sanitizeCss } from "./cssSanitizer.ts";
import { escapeXml, extractBodyHtml, isPlaceholderTitle, normalizeHtmlEntitiesForXhtml, stripHtml } from "./textual.ts";
interface PdbRecord {
  data: Uint8Array;
}

interface TagMeta {
  number: number;
  valuesPerEntry: number;
  mask: number;
}

interface SkeletonEntry {
  label: string;
  startPos: number;
  length: number;
  chunkCount: number;
}

interface FragmentEntry {
  insertPos: number;
  selector: string;
  fileNumber: number;
  sequenceNumber: number;
  startPos: number;
  length: number;
}

interface InternalLinkTarget {
  chapterHref: string;
  fragment: string;
}

interface InternalLinkReference {
  placeholder: string;
  target: InternalLinkTarget;
}

interface KindlePosition {
  sequenceNumber: number;
  offset: number;
}

interface Kf8BuildResult {
  textRecords: PdbRecord[];
  textLength: number;
  htmlLength: number;
  totalTextLength: number;
  extraDataFlags: number;
  fdst: Uint8Array;
  fragmentIndx: Uint8Array[];
  fragmentCncx: Uint8Array[];
  skeletonIndx: Uint8Array[];
  ncxIndx: Uint8Array[];
  ncxCncx: Uint8Array[];
  datp: Uint8Array;
  sourceEpub: Uint8Array;
  skeletonCount: number;
  fragmentCount: number;
  maxFragmentLength: number;
  tbsRecordCount: number;
  tbsByteCount: number;
  unsupportedResourceCount: number;
  unresolvedInternalLinkCount: number;
}

interface ImageResourceRecord {
  resource: LyceumTextualResource;
  data: Uint8Array;
  embedIndex: number;
}

interface TextRecordPayload {
  raw: Uint8Array;
}

interface NcxTbsEntry {
  index: number;
  start: number;
  length: number;
  depth: number;
  label: string;
  parent?: number;
  firstChild?: number;
  lastChild?: number;
}

interface NcxIndexEntry extends NcxTbsEntry {
  title: string;
  labelBytes: Uint8Array;
  labelOffset: number;
  posFid: [number, number];
}

interface FilledTbsEntry extends NcxTbsEntry {
  action: "starts" | "spans" | "ends" | "completes";
  startOffset: number;
  lengthOffset: number;
  textRecordLength: number;
}

export interface Azw3BuildOptions {
  metadata: LyceumBookMetadata;
  textual: LyceumTextualContent;
  /**
   * Enable only if you want source EPUB roundtrip support.
   * For very large books with many images this can make the AZW3 much bigger.
   */
  embedSource?: boolean;
}

export interface Azw3BuildResult {
  buffer: ArrayBuffer;
  stats: {
    chapterCount: number;
    textRecordCount: number;
    recordCount: number;
    rawTextBytes: number;
    htmlLength: number;
    totalTextLength: number;
    extraDataFlags?: number;
    skeletonCount: number;
    fragmentCount: number;
    maxFragmentLength?: number;
    tbsRecordCount?: number;
    tbsByteCount?: number;
    textPaddingBytes?: number;
    fdstRecord: number;
    fragmentIndexRecord: number;
    skeletonIndexRecord: number;
    ncxIndexRecord: number;
    datpRecord: number;
    flisRecord: number;
    fcisRecord: number;
    srcsRecord: number | null;
    compressedTextBytes?: number;
    compressionRatio?: number;
    anchorOffsetCount?: number;
    imageResourceCount?: number;
    coverImageOffset?: number | null;
    thumbnailImageOffset?: number | null;
  } & Record<string, number | string | boolean | null | undefined>;
}

const TEXT_RECORD_SIZE = 4096;
const KF8_CHUNK_SIZE = 8192;
const PALMDOC_HEADER_LENGTH = 16;
const MOBI_HEADER_LENGTH = 264;
const MOBI_HEADER_OFFSET = PALMDOC_HEADER_LENGTH;
const INDX_HEADER_LENGTH = 192;
const PDB_EPOCH = Date.UTC(1904, 0, 1);
const NULL_INDEX = 0xffffffff;
const MOBI_EXTH_FLAGS = 0x00000040;
const END_TAG = 1;
const PALMDOC_COMPRESSION = 2;

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

function padToFour(value: Uint8Array): Uint8Array {
  const padding = (4 - (value.length % 4)) % 4;
  if (padding === 0) return value;
  return concatBytes([value, new Uint8Array(padding)]);
}

function writeAscii(buffer: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    buffer[offset + index] = value.charCodeAt(index) & 0xff;
  }
}

function writeUInt32BE(value: number): Uint8Array {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value >>> 0, false);
  return output;
}

function put32(buffer: Uint8Array, offset: number, value: number): void {
  new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setUint32(offset, value >>> 0, false);
}

function clampPdbName(value: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\x00-\x1f]/g, " ").trim() || "Untitled";
  const encoded = encodeUtf8(clean);

  if (encoded.length <= 31) return clean;

  let output = "";
  for (const char of clean) {
    const next = output + char;
    if (encodeUtf8(next).length > 31) break;
    output = next;
  }

  return output || "Untitled";
}

function pdbTimestamp(date = new Date()): number {
  return Math.max(0, Math.floor((date.getTime() - PDB_EPOCH) / 1000));
}

function deterministicId(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function bookIdentifierSeed(metadata: LyceumBookMetadata): string {
  return [
    metadata.identifier,
    metadata.isbn,
    metadata.title,
    metadata.author,
    metadata.publisher,
    metadata.publishDate,
  ].filter(Boolean).join(":");
}

function generateStableIdentifier(seed: string): string {
  const value = deterministicId(seed || "lyceum");
  return `urn:uuid:00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function normalizeLanguage(language?: string): string {
  return language || "und";
}

function metadataString(value: string | string[] | number | undefined): string | undefined {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean).join("; ") || undefined;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  return value?.trim() || undefined;
}

function metadataSubjects(value: LyceumBookMetadata["subject"]): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  return value.split(";").map((item) => item.trim()).filter(Boolean);
}

function localeCode(language?: string): number {
  const lang = normalizeLanguage(language).toLowerCase();
  if (lang.startsWith("pt")) return 0x00000416;
  if (lang.startsWith("en")) return 0x00000409;
  if (lang.startsWith("es")) return 0x00000c0a;
  if (lang.startsWith("fr")) return 0x0000040c;
  if (lang.startsWith("de")) return 0x00000407;
  if (lang.startsWith("it")) return 0x00000410;
  if (lang.startsWith("zh-hant") || lang.startsWith("zh-tw")) return 0x00000404;
  if (lang.startsWith("zh")) return 0x00000804;
  if (lang.startsWith("ja")) return 0x00000411;
  if (lang.startsWith("ko")) return 0x00000412;
  return 0x00000409;
}

function sanitizeXmlId(value: string, fallback: string): string {
  const clean = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  return clean || fallback;
}

function buildChapterId(index: number): string {
  return `chapter-${String(index + 1).padStart(4, "0")}`;
}

function encodeBase32(value: number, minDigits = 0): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
  let output = "";
  let current = Math.max(0, value >>> 0);

  do {
    output = chars[current & 0x1f] + output;
    current >>>= 5;
  } while (current > 0);

  return output.padStart(minDigits, "0");
}

function kindlePosHref(position: KindlePosition): string {
  return `kindle:pos:fid:${encodeBase32(position.sequenceNumber, 4)}:off:${encodeBase32(position.offset, 10)}`;
}

function internalLinkPlaceholder(index: number): string {
  return `kindle:pos:fid:0000:off:${encodeBase32(index, 10)}`;
}

function firstHeadingText(value: string): string | undefined {
  const heading = value.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1];
  const text = heading ? stripHtml(heading) : "";
  return text || undefined;
}

function chapterTitle(chapter: LyceumTextualContent["chapters"][number], index: number) {
  if (!isPlaceholderTitle(chapter.title)) return chapter.title;
  const heading = firstHeadingText(extractBodyHtml(chapter.xhtml));
  return isPlaceholderTitle(heading) ? `Chapter ${index + 1}` : heading!;
}

function removeDuplicateLeadingHeading(bodyHtml: string, _title: string): string {
  return bodyHtml.replace(/^\s*<h1\b[^>]*>[\s\S]*?<\/h1>/i, "");
}

function hrefPath(value: string): string {
  const raw = value.split("#")[0].split("?")[0].replace(/\\/g, "/");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function dirname(value: string): string {
  const normalized = hrefPath(value);
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : "";
}

function normalizeContentPath(value: string): string {
  const parts = hrefPath(value).split("/");
  const output: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") output.pop();
    else output.push(part);
  }
  return output.join("/");
}

function resolveContentHref(baseHref: string, href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return href;
  const base = dirname(baseHref);
  return normalizeContentPath(base ? `${base}/${href}` : href);
}

function normalizeLinkFragment(value: string): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resourceBytes(resource: LyceumTextualResource): Uint8Array | null {
  if (resource.data instanceof ArrayBuffer) return new Uint8Array(resource.data);
  if (resource.data) return new Uint8Array(resource.data.buffer, resource.data.byteOffset, resource.data.byteLength);
  return null;
}

function isKindleImageResource(resource: LyceumTextualResource): boolean {
  return ["image/jpeg", "image/png", "image/gif"].includes(resource.mediaType.toLowerCase());
}

function hasResourceProperty(resource: LyceumTextualResource, property: string): boolean {
  return Boolean(resource.properties?.split(/\s+/).includes(property));
}

function buildImageResources(textual: LyceumTextualContent): ImageResourceRecord[] {
  const resources = textual.resources || [];
  const images: ImageResourceRecord[] = [];

  for (const resource of resources) {
    const data = resourceBytes(resource);
    if (!data || data.length === 0 || !isKindleImageResource(resource)) continue;
    images.push({
      resource,
      data,
      embedIndex: images.length + 1,
    });
  }

  return images;
}

function imageEmbedMap(images: ImageResourceRecord[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const image of images) {
    map.set(normalizeContentPath(image.resource.href).toLowerCase(), image.embedIndex);
  }
  return map;
}

function buildKf8Css(textual: LyceumTextualContent): string {
  const resources = textual.resources || [];
  const cssResources = new Map<string, string>();
  const embeds = imageEmbedMap(buildImageResources(textual));

  for (const resource of resources) {
    if (resource.mediaType.toLowerCase() !== "text/css") continue;
    const data = resourceBytes(resource);
    if (!data) continue;
    cssResources.set(normalizeContentPath(resource.href).toLowerCase(), decodeUtf8(data));
  }

  const parts = [renderKindleDefaultCss()];
  for (const resource of resources) {
    if (resource.mediaType.toLowerCase() !== "text/css") continue;
    const css = cssResources.get(normalizeContentPath(resource.href).toLowerCase());
    if (!css) continue;
    const sanitized = sanitizeCss(css, {
      resolveImport: (href) => cssResources.get(resolveContentHref(resource.href, href).toLowerCase()),
      rewriteUrl: (href) => {
        const embed = embeds.get(resolveContentHref(resource.href, href).toLowerCase());
        return embed ? `kindle:embed:${String(embed).padStart(4, "0")}?mime=image` : undefined;
      },
    });
    if (sanitized.css) parts.push(sanitized.css);
  }

  return parts.join("\n");
}

function rewriteResourceReferences(
  html: string,
  chapterHref: string,
  embeds: Map<string, number>,
  chapterPaths: Set<string>,
  internalLinks: InternalLinkReference[],
): { html: string; unresolved: number } {
  let unresolved = 0;
  const document = parseXml(`<root xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:xlink="http://www.w3.org/1999/xlink">${html}</root>`);
  const rewrite = (value: string) => {
    if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("#")) return value;
    const resolved = resolveContentHref(chapterHref, value).toLowerCase();
    const embed = embeds.get(resolved);
    if (!embed) {
      unresolved += 1;
      return value;
    }
    return `kindle:embed:${String(embed).padStart(4, "0")}?mime=image`;
  };

  for (const anchor of Array.from(selectElements(document, "a[href]"))) {
    const value = anchor.getAttribute("href") || "";
    if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value)) continue;
    const [targetPath, fragment = ""] = value.split("#", 2);
    const resolved = targetPath
      ? resolveContentHref(chapterHref, targetPath).toLowerCase()
      : normalizeContentPath(chapterHref).toLowerCase();
    if (!targetPath || chapterPaths.has(resolved)) {
      const placeholder = internalLinkPlaceholder(internalLinks.length + 1);
      internalLinks.push({
        placeholder,
        target: { chapterHref: resolved, fragment: normalizeLinkFragment(fragment) },
      });
      anchor.setAttribute("href", placeholder);
    } else {
      unresolved += 1;
      anchor.removeAttribute("href");
    }
  }

  for (const element of Array.from(selectElements(document, "[src],[href],[xlink\\:href],[poster]"))) {
    if (element.localName === "a") continue;
    for (const name of ["src", "href", "xlink:href", "poster"]) {
      const value = element.getAttribute(name);
      if (value) element.setAttribute(name, rewrite(value));
    }
  }

  for (const element of Array.from(selectElements(document, "[srcset]"))) {
    const candidates = (element.getAttribute("srcset") || "").split(",").map((candidate) => {
      const [value, descriptor] = candidate.trim().split(/\s+/, 2);
      return `${rewrite(value)}${descriptor ? ` ${descriptor}` : ""}`;
    });
    element.setAttribute("srcset", candidates.join(", "));
  }

    const root = document.documentElement;

  return {
    html: Array.from(root.childNodes).map((node) => serializeXml(node)).join(""),
    unresolved,
  };
}

function buildChapterDocument(
  metadata: LyceumBookMetadata,
  chapter: LyceumTextualContent["chapters"][number],
  index: number,
  bodyHtmlOverride?: string,
): string {
  const language = normalizeLanguage(metadata.language);
  const id = buildChapterId(index);
  const sourceId = sanitizeXmlId(chapter.id || "", id);
  const title = chapterTitle(chapter, index);
  const bodyHtml = bodyHtmlOverride ?? normalizeHtmlEntitiesForXhtml(extractBodyHtml(chapter.xhtml));

  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(language)}" xml:lang="${escapeXml(language)}">
<head>
<meta charset="utf-8" />
<title>${escapeXml(title)}</title>
</head>
<body>
<section id="${id}" data-lyceum-id="${escapeXml(sourceId)}" class="chapter">
${bodyHtml}
</section>
</body>
</html>`;
}

function addAidAttributes(html: string, aidCounterRef: { value: number }): string {
  const document = parseXml(html);
  const selector = "p,div,h1,h2,h3,h4,h5,h6,li,ul,ol,table,tr,td,th,section,article,aside,nav,header,footer,figure,figcaption,blockquote,span,a,em,strong,b,i,body";
  for (const element of Array.from(selectElements(document, selector))) {
    if (element.hasAttribute("aid")) continue;
    const aid = encodeAidBase32(aidCounterRef.value);
    aidCounterRef.value += 1;
    element.setAttribute("aid", aid);
  }
    return `<?xml version="1.0" encoding="utf-8"?>\n${serializeXml(document.documentElement)}`;
}

interface BodySplit {
  skeleton: string;
  bodyInner: string;
  bodyInnerOffset: number;
  bodyAid: string;
}

function findBodyOpen(html: string): { start: number; end: number; aid: string } | null {
  const match = /<body\b[^>]*>/i.exec(html);
  if (!match || match.index === undefined) return null;
  const tag = match[0];
  const aidMatch = /\said\s*=\s*["']([^"']*)["']/i.exec(tag);
  return {
    start: match.index,
    end: match.index + tag.length,
    aid: aidMatch?.[1] || "0",
  };
}

function findLastBodyClose(html: string): number {
  return html.toLowerCase().lastIndexOf("</body>");
}

function splitSkeletonAndBody(html: string): BodySplit {
  const bodyOpen = findBodyOpen(html);
  const bodyClose = findLastBodyClose(html);

  if (!bodyOpen || bodyClose < bodyOpen.end) {
    return {
      skeleton: html,
      bodyInner: "",
      bodyInnerOffset: encodeUtf8(html).length,
      bodyAid: "0",
    };
  }

  const head = html.slice(0, bodyOpen.end);
  const inner = html.slice(bodyOpen.end, bodyClose);
  const tail = html.slice(bodyClose);

  return {
    skeleton: head + tail,
    bodyInner: inner,
    bodyInnerOffset: encodeUtf8(head).length,
    bodyAid: bodyOpen.aid,
  };
}

function safeUtf8ChunkEnd(input: Uint8Array, start: number, maxLength: number): number {
  let end = Math.min(start + maxLength, input.length);
  if (end >= input.length) return input.length;

  while (end > start && (input[end] & 0xc0) === 0x80) {
    end -= 1;
  }

  return end > start ? end : Math.min(start + maxLength, input.length);
}

function splitKf8Chunks(input: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];

  for (let offset = 0; offset < input.length;) {
    const end = safeUtf8ChunkEnd(input, offset, KF8_CHUNK_SIZE);
    chunks.push(input.slice(offset, end));
    offset = end;
  }

  return chunks;
}

function internalTargetKey(chapterHref: string, fragment: string): string {
  return `${normalizeContentPath(chapterHref).toLowerCase()}#${normalizeLinkFragment(fragment)}`;
}

function collectInternalTargetsFromChunk(
  chapterHref: string,
  chunk: Uint8Array,
  sequenceNumber: number,
  targets: Map<string, KindlePosition>,
): void {
  const html = decodeUtf8(chunk);
  const tagPattern = /<([a-z][a-z0-9:-]*)(\s[^<>]*?)?>/gi;

  for (const match of html.matchAll(tagPattern)) {
    const attrs = match[2] || "";
    const idMatch = /\sid\s*=\s*(["'])(.*?)\1/i.exec(attrs);
    const nameMatch = /\sname\s*=\s*(["'])(.*?)\1/i.exec(attrs);
    const target = idMatch?.[2] || nameMatch?.[2];
    if (!target) continue;

    targets.set(internalTargetKey(chapterHref, target), {
      sequenceNumber,
      offset: encodeUtf8(html.slice(0, match.index || 0)).length,
    });
  }
}

function resolveInternalLinksInText(
  text: Uint8Array,
  internalLinks: InternalLinkReference[],
  targets: Map<string, KindlePosition>,
): { text: Uint8Array; unresolved: number } {
  if (internalLinks.length === 0) return { text, unresolved: 0 };

  let html = decodeUtf8(text);
  let unresolved = 0;

  for (const link of internalLinks) {
    const exact = targets.get(internalTargetKey(link.target.chapterHref, link.target.fragment));
    const chapterStart = targets.get(internalTargetKey(link.target.chapterHref, ""));
    let position = exact || chapterStart;
    if (!position) {
      unresolved += 1;
      position = { sequenceNumber: 0, offset: 0 };
    }
    html = html.split(link.placeholder).join(kindlePosHref(position));
  }

  return { text: encodeUtf8(html), unresolved };
}

function buildKf8HtmlParts(metadata: LyceumBookMetadata, textual: LyceumTextualContent): {
  combinedHtml: Uint8Array;
  skeletons: SkeletonEntry[];
  fragments: FragmentEntry[];
  maxFragmentLength: number;
  unresolvedInternalLinkCount: number;
  internalTargets: Map<string, KindlePosition>;
} {
  const skeletons: SkeletonEntry[] = [];
  const fragments: FragmentEntry[] = [];
  const parts: Uint8Array[] = [];
  let absoluteOffset = 0;
  let sequence = 0;
  const aidCounter = { value: 0 };
  const embeds = imageEmbedMap(buildImageResources(textual));
  const chapterPaths = new Set(textual.chapters.map((chapter) => normalizeContentPath(chapter.href).toLowerCase()));
  const internalLinks: InternalLinkReference[] = [];
  const internalTargets = new Map<string, KindlePosition>();
  let unresolvedInternalLinkCount = 0;
  let maxFragmentLength = 0;

  textual.chapters.forEach((chapter, index) => {
    const body = normalizeHtmlEntitiesForXhtml(extractBodyHtml(chapter.xhtml));
    const chapterPath = normalizeContentPath(chapter.href).toLowerCase();
    const rewritten = rewriteResourceReferences(body, chapter.href, embeds, chapterPaths, internalLinks);
    unresolvedInternalLinkCount += rewritten.unresolved;
    const aided = addAidAttributes(buildChapterDocument(metadata, chapter, index, rewritten.html), aidCounter);
    const split = splitSkeletonAndBody(aided);
    const skelBytes = encodeUtf8(split.skeleton);
    const fragBytes = encodeUtf8(split.bodyInner);
    const fragChunks = splitKf8Chunks(fragBytes);
    const skelStart = absoluteOffset;

    parts.push(skelBytes);
    absoluteOffset += skelBytes.length;

    let chunkOffset = 0;
    for (const chunk of fragChunks) {
      const chunkSequence = sequence;
      const insertPos = skelStart + split.bodyInnerOffset + chunkOffset;
      parts.push(chunk);
      absoluteOffset += chunk.length;
      maxFragmentLength = Math.max(maxFragmentLength, chunk.length);

      fragments.push({
        insertPos,
        selector: `P-//*[@aid='${split.bodyAid}']`,
        fileNumber: index,
        sequenceNumber: chunkSequence,
        startPos: chunkOffset,
        length: chunk.length,
      });
      if (chunkOffset === 0) {
        internalTargets.set(internalTargetKey(chapterPath, ""), {
          sequenceNumber: chunkSequence,
          offset: 0,
        });
      }
      collectInternalTargetsFromChunk(chapterPath, chunk, chunkSequence, internalTargets);

      chunkOffset += chunk.length;
      sequence += 1;
    }

    skeletons.push({
      label: `SKEL${String(index).padStart(10, "0")}`,
      startPos: skelStart,
      length: skelBytes.length,
      chunkCount: fragChunks.length,
    });
  });
  const resolvedText = resolveInternalLinksInText(concatBytes(parts), internalLinks, internalTargets);
  unresolvedInternalLinkCount += resolvedText.unresolved;

  return {
    combinedHtml: resolvedText.text,
    skeletons,
    fragments,
    maxFragmentLength,
    unresolvedInternalLinkCount,
    internalTargets,
  };
}

function encodeAidBase32(value: number): string {
  if (value === 0) return "0";
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
  let output = "";
  let current = value >>> 0;

  while (current > 0) {
    output = chars[current & 0x1f] + output;
    current >>>= 5;
  }

  return output;
}

function encodeVwiInv(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = value >>> 0;

  bytes.push(current & 0x7f);
  current >>>= 7;

  while (current > 0) {
    bytes.push(current & 0x7f);
    current >>>= 7;
  }

  bytes.reverse();
  bytes[bytes.length - 1] |= 0x80;
  return new Uint8Array(bytes);
}

function encodeBackwardVwi(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = value >>> 0;

  bytes.push(current & 0x7f);
  current >>>= 7;

  while (current > 0) {
    bytes.push(current & 0x7f);
    current >>>= 7;
  }

  bytes[bytes.length - 1] |= 0x80;
  bytes.reverse();
  return new Uint8Array(bytes);
}

function encodeTrailingData(raw: Uint8Array): Uint8Array {
  let sizeByteLength = 1;

  while (true) {
    const encodedSize = encodeBackwardVwi(raw.length + sizeByteLength);
    if (encodedSize.length === sizeByteLength) {
      return concatBytes([raw, encodedSize]);
    }
    sizeByteLength += 1;
  }
}

function encodeTbsValue(value: number, extra: Record<number, number | true>, flagSize: number): Uint8Array {
  let flags = 0;
  for (const bit of Object.keys(extra)) flags |= Number(bit);

  const parts = [encodeVwiInv(((value >>> 0) << flagSize) | flags)];
  for (const bit of [0b0010, 0b0001]) {
    const extraValue = extra[bit];
    if (typeof extraValue === "number") {
      parts.push(encodeVwiInv(extraValue >>> 0));
    }
  }
  const siblingCount = extra[0b0100];
  if (typeof siblingCount === "number") {
    parts.splice(extra[0b0010] ? 2 : 1, 0, new Uint8Array([Math.max(0, Math.min(255, siblingCount))]));
  }

  return concatBytes(parts);
}

function isPalmDocDirectByte(byte: number): boolean {
  return byte === 0 || (byte >= 0x09 && byte <= 0x7f);
}

function compressPalmDocRecord(input: Uint8Array): Uint8Array {
  const output: number[] = [];
  const recent = new Map<string, number[]>();
  const maxDistance = 2047;
  const maxLength = 10;
  const maxCandidates = 32;

  const keyAt = (offset: number) => (
    offset + 2 < input.length
      ? `${input[offset]},${input[offset + 1]},${input[offset + 2]}`
      : ""
  );

  const remember = (offset: number) => {
    const key = keyAt(offset);
    if (!key) return;
    const positions = recent.get(key) || [];
    positions.push(offset);
    while (positions.length > 0 && offset - positions[0] > maxDistance) positions.shift();
    while (positions.length > maxCandidates) positions.shift();
    recent.set(key, positions);
  };

  const bestMatchAt = (offset: number) => {
    const key = keyAt(offset);
    const positions = key ? recent.get(key) : undefined;
    if (!positions?.length) return { distance: 0, length: 0 };

    let bestDistance = 0;
    let bestLength = 0;
    for (let index = positions.length - 1; index >= 0; index -= 1) {
      const position = positions[index];
      const distance = offset - position;
      if (distance <= 0 || distance > maxDistance) continue;

      let length = 0;
      while (
        length < maxLength
        && offset + length < input.length
        && input[position + length] === input[offset + length]
      ) {
        length += 1;
      }

      if (length > bestLength) {
        bestLength = length;
        bestDistance = distance;
        if (bestLength === maxLength) break;
      }
    }

    return bestLength >= 3 ? { distance: bestDistance, length: bestLength } : { distance: 0, length: 0 };
  };

  for (let index = 0; index < input.length; index += 1) {
    const match = bestMatchAt(index);
    if (match.length >= 3) {
      const pair = (match.distance << 3) | (match.length - 3);
      output.push(0x80 | ((pair >> 8) & 0x3f), pair & 0xff);
      for (let offset = 0; offset < match.length; offset += 1) remember(index + offset);
      index += match.length - 1;
      continue;
    }

    const byte = input[index];
    const next = input[index + 1];

    if (byte === 0x20 && next >= 0x40 && next <= 0x7f) {
      output.push(next ^ 0x80);
      remember(index);
      remember(index + 1);
      index += 1;
      continue;
    }

    if (isPalmDocDirectByte(byte)) {
      output.push(byte);
      remember(index);
      continue;
    }

    const literalStart = index;
    let literalLength = 0;
    while (literalStart + literalLength < input.length && literalLength < 8) {
      const current = input[literalStart + literalLength];
      const following = input[literalStart + literalLength + 1];
      if (current === 0x20 && following >= 0x40 && following <= 0x7f) break;
      if (isPalmDocDirectByte(current)) break;
      literalLength += 1;
    }

    if (literalLength === 0) {
      output.push(byte);
      continue;
    }

    output.push(literalLength);
    for (let offset = 0; offset < literalLength; offset += 1) {
      output.push(input[literalStart + offset]);
      remember(literalStart + offset);
    }
    index += literalLength - 1;
  }

  return new Uint8Array(output);
}

function safeUtf8RecordEnd(input: Uint8Array, start: number): number {
  let end = Math.min(start + TEXT_RECORD_SIZE, input.length);
  if (end >= input.length) return input.length;

  while (end > start && (input[end] & 0xc0) === 0x80) {
    end -= 1;
  }

  return end > start ? end : Math.min(start + TEXT_RECORD_SIZE, input.length);
}

function splitTextRecordPayloads(rawText: Uint8Array): TextRecordPayload[] {
  const records: TextRecordPayload[] = [];

  for (let offset = 0; offset < rawText.length;) {
    const end = safeUtf8RecordEnd(rawText, offset);
    records.push({ raw: rawText.slice(offset, end) });
    offset = end;
  }

  return records.length > 0 ? records : [{ raw: new Uint8Array() }];
}

function buildTextRecordsKf8(
  payloads: TextRecordPayload[],
  tbsByRecord: Map<number, Uint8Array>,
  includeTbs: boolean,
): PdbRecord[] {
  return payloads.map((payload, index) => {
    const multibyteTrailer = new Uint8Array([0x00]);
    const tbs = tbsByRecord.get(index + 1) || new Uint8Array();
    const trailing = includeTbs ? encodeTrailingData(tbs) : new Uint8Array();
    return {
      data: concatBytes([compressPalmDocRecord(payload.raw), multibyteTrailer, trailing]),
    };
  });
}

function fillTbsEntry(entry: NcxTbsEntry, startOffset: number, textRecordLength: number): FilledTbsEntry {
  const lengthOffset = startOffset + entry.length;
  let action: FilledTbsEntry["action"];
  if (startOffset < 0) {
    action = lengthOffset > textRecordLength ? "spans" : "ends";
  } else {
    action = lengthOffset > textRecordLength ? "starts" : "completes";
  }

  return {
    ...entry,
    action,
    startOffset,
    lengthOffset,
    textRecordLength,
  };
}

function populateTbsStrand(parent: FilledTbsEntry, entries: FilledTbsEntry[]): FilledTbsEntry[] {
  const strand = [parent];
  const childIndex = entries.findIndex((entry) => entry.parent === parent.index);

  if (childIndex >= 0) {
    const [child] = entries.splice(childIndex, 1);
    strand.push(...populateTbsStrand(child, entries));
    return strand;
  }

  let currentIndex = parent.index;
  for (let index = 0; index < entries.length;) {
    const entry = entries[index];
    if (entry.depth === parent.depth && entry.parent === parent.parent && entry.index === currentIndex + 1) {
      currentIndex += 1;
      entries.splice(index, 1);
      const siblingHasChildren = entries.some((candidate) => candidate.parent === entry.index);
      if (siblingHasChildren) {
        strand.push(...populateTbsStrand(entry, entries));
        break;
      }
      strand.push(entry);
      continue;
    }
    index += 1;
  }

  return strand;
}

function separateTbsStrands(entries: FilledTbsEntry[]): FilledTbsEntry[][][] {
  const remaining = entries.slice();
  const strands: FilledTbsEntry[][][] = [];

  while (remaining.length > 0) {
    const parent = remaining.shift()!;
    const strand = populateTbsStrand(parent, remaining);
    const layers: FilledTbsEntry[][] = [];

    for (const entry of strand) {
      const existing = layers.find((layer) => layer[0]?.depth === entry.depth);
      if (existing) existing.push(entry);
      else layers.push([entry]);
    }

    strands.push(layers);
  }

  return strands;
}

function collectTbsIndexingData(entries: NcxTbsEntry[], textRecordLengths: number[]): FilledTbsEntry[][][][] {
  const ordered = entries.slice().sort((a, b) => a.start - b.start || a.index - b.index);
  const records: FilledTbsEntry[][][][] = [];
  let recordStart = 0;

  for (const recordLength of textRecordLengths) {
    const recordEnd = recordStart + recordLength;
    const localEntries: FilledTbsEntry[] = [];

    for (const entry of ordered) {
      if (entry.start >= recordEnd) break;
      if (entry.start + entry.length <= recordStart) continue;
      localEntries.push(fillTbsEntry(entry, entry.start - recordStart, recordLength));
    }

    records.push(separateTbsStrands(localEntries));
    recordStart = recordEnd;
  }

  return records;
}

function encodeTbsStrandsAsSequences(strands: FilledTbsEntry[][][], tbsType: 8 | 5 = 8): [number, Record<number, number | true>][] {
  const sequences: [number, Record<number, number | true>][] = [];
  let lastIndex: number | null = null;
  let maxLengthOffset = 0;
  let firstEntry: FilledTbsEntry | null = null;

  for (const strand of strands) {
    for (const entries of strand) {
      for (const entry of entries) {
        if (!firstEntry) firstEntry = entry;
        maxLengthOffset = Math.max(maxLengthOffset, entry.lengthOffset);
      }
    }
  }

  for (const strand of strands) {
    const strandSequences: [number, Record<number, number | true>][] = [];

    for (const entries of strand) {
      const extra: Record<number, number | true> = {};
      const lastEntry = entries[entries.length - 1];
      const firstLayerEntry = entries[0];

      if (lastEntry.action === "spans") {
        extra[0b1] = 0;
      } else if (
        false
        && lastEntry.lengthOffset < lastEntry.textRecordLength
        && lastEntry.action === "completes"
        && lastEntry.lengthOffset !== maxLengthOffset
      ) {
        extra[0b1] = lastEntry.lengthOffset;
      }

      if (firstLayerEntry === firstEntry) {
        extra[0b10] = tbsType;
      }

      if (entries.length > 1) {
        extra[0b100] = entries.length;
      }

      let indexValue = firstLayerEntry.index - (firstLayerEntry.parent || 0);
      if (sequences.length > 0 && strandSequences.length === 0 && lastIndex !== null) {
        indexValue = lastIndex - firstLayerEntry.index;
        if (indexValue < 0) {
          if (tbsType === 5) indexValue = -indexValue;
          else throw new Error("negative-tbs-strand-index");
        } else {
          extra[0b1000] = true;
        }
      }

      lastIndex = lastEntry.index;
      strandSequences.push([indexValue, extra]);
    }

    for (let index = 0; index < strandSequences.length - 1; index += 1) {
      if (0b1 in strandSequences[index][1] && 0b1 in strandSequences[index + 1][1]) {
        delete strandSequences[index][1][0b1];
      }
    }

    sequences.push(...strandSequences);
  }

  return sequences;
}

function tbsSequencesToBytes(sequences: [number, Record<number, number | true>][]): Uint8Array {
  const parts: Uint8Array[] = [];
  let flagSize = 3;

  for (const [value, extra] of sequences) {
    parts.push(encodeTbsValue(value, extra, flagSize));
    flagSize = 4;
  }

  return concatBytes(parts);
}

function calculateTbsRecords(indexingData: FilledTbsEntry[][][][], tbsType: 8 | 5 = 8): Map<number, Uint8Array> {
  const output = new Map<number, Uint8Array>();
  indexingData.forEach((strands, index) => {
    output.set(index + 1, tbsSequencesToBytes(encodeTbsStrandsAsSequences(strands, tbsType)));
  });
  return output;
}

function buildTbsForTextRecords(entries: NcxTbsEntry[], textRecordLengths: number[]): Map<number, Uint8Array> {
  if (entries.length === 0 || textRecordLengths.length === 0) return new Map();
  const indexingData = collectTbsIndexingData(entries, textRecordLengths);

  try {
    return calculateTbsRecords(indexingData, 8);
  } catch (error) {
    if (error instanceof Error && error.message === "negative-tbs-strand-index") {
      return calculateTbsRecords(indexingData, 5);
    }
    throw error;
  }
}

function buildFdstRecord(htmlLength: number, totalLength: number): Uint8Array {
  const flowCount = 2;
  const record = new Uint8Array(12 + flowCount * 8);
  const view = new DataView(record.buffer);

  writeAscii(record, 0, "FDST");
  view.setUint32(4, 12, false);
  view.setUint32(8, flowCount, false);

  // Flow 0: HTML.
  view.setUint32(12, 0, false);
  view.setUint32(16, htmlLength, false);

  // Flow 1: CSS. It can be zero-length but still exists.
  view.setUint32(20, htmlLength, false);
  view.setUint32(24, totalLength, false);

  return record;
}

class CncxBuilder {
  private chunks: Uint8Array[] = [];
  private offsets = new Map<string, number>();
  private totalLength = 0;

  add(value: string): number {
    const existing = this.offsets.get(value);
    if (existing !== undefined) return existing;

    const bytes = encodeUtf8(value);
    const prefix = encodeVwiInv(bytes.length);
    const offset = this.totalLength;
    const chunk = concatBytes([prefix, bytes]);

    this.offsets.set(value, offset);
    this.chunks.push(chunk);
    this.totalLength += chunk.length;

    return offset;
  }

  recordCount(): number {
    return this.totalLength === 0 ? 0 : Math.ceil(this.totalLength / TEXT_RECORD_SIZE);
  }

  intoRecords(): Uint8Array[] {
    const data = concatBytes(this.chunks);
    if (data.length === 0) return [];

    const records: Uint8Array[] = [];
    for (let offset = 0; offset < data.length; offset += TEXT_RECORD_SIZE) {
      records.push(padToFour(data.slice(offset, offset + TEXT_RECORD_SIZE)));
    }
    return records;
  }
}

function maskShifts(mask: number): number {
  switch (mask) {
    case 1: return 0;
    case 2: return 1;
    case 3: return 0;
    case 4: return 2;
    case 8: return 3;
    case 12: return 2;
    case 16: return 4;
    case 32: return 5;
    case 48: return 4;
    case 64: return 6;
    case 128: return 7;
    case 192: return 6;
    default: return 0;
  }
}

function buildTagx(tagDefs: [number, number, number][]): Uint8Array {
  const body: number[] = [];

  for (const [num, vpe, mask] of tagDefs) {
    body.push(num & 0xff, vpe & 0xff, mask & 0xff, 0);
  }

  body.push(0, 0, 0, END_TAG);

  const totalLength = 12 + body.length;
  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);

  writeAscii(out, 0, "TAGX");
  view.setUint32(4, totalLength, false);
  view.setUint32(8, 1, false);
  out.set(body, 12);

  return out;
}

function controlByteFor(tagDefs: TagMeta[], nvalsPerTag: number[]): number {
  let answer = 0;

  tagDefs.forEach((tag, index) => {
    const nentries = Math.floor(nvalsPerTag[index] / tag.valuesPerEntry);
    const shifts = maskShifts(tag.mask);
    answer |= tag.mask & (nentries << shifts);
  });

  return answer & 0xff;
}

function encodeIndxEntry(label: Uint8Array, tagDefs: TagMeta[], valuesByTag: number[][]): Uint8Array {
  const nvalsPerTag = valuesByTag.map((values) => values.length);
  const control = controlByteFor(tagDefs, nvalsPerTag);
  const parts: Uint8Array[] = [new Uint8Array([label.length]), label, new Uint8Array([control])];

  for (const values of valuesByTag) {
    for (const value of values) {
      parts.push(encodeVwiInv(value >>> 0));
    }
  }

  return concatBytes(parts);
}

function buildIndxDataRecord(entries: Uint8Array[]): Uint8Array {
  const header = new Uint8Array(INDX_HEADER_LENGTH);
  writeAscii(header, 0, "INDX");
  put32(header, 4, INDX_HEADER_LENGTH);
  put32(header, 12, 1);

  const entryParts: Uint8Array[] = [];
  const offsets: number[] = [];
  let currentLength = 0;

  for (const entry of entries) {
    offsets.push(INDX_HEADER_LENGTH + currentLength);
    entryParts.push(entry);
    currentLength += entry.length;
  }

  let entriesData = concatBytes(entryParts);
  while ((INDX_HEADER_LENGTH + entriesData.length) % 4 !== 0) {
    entriesData = concatBytes([entriesData, new Uint8Array([0])]);
  }

  const idxtOffset = INDX_HEADER_LENGTH + entriesData.length;
  put32(header, 20, idxtOffset);
  put32(header, 24, entries.length);
  header.fill(0xff, 28, 36);

  const idxt = new Uint8Array(4 + offsets.length * 2 + ((4 - ((4 + offsets.length * 2) % 4)) % 4));
  const idxtView = new DataView(idxt.buffer);
  writeAscii(idxt, 0, "IDXT");
  offsets.forEach((offset, index) => {
    idxtView.setUint16(4 + index * 2, offset, false);
  });

  return concatBytes([header, entriesData, idxt]);
}

function buildIndxPrimary(
  tagx: Uint8Array,
  numDataRecords: number,
  numEntries: number,
  numCncx: number,
  geometry: [Uint8Array, number][],
): Uint8Array {
  const header = new Uint8Array(INDX_HEADER_LENGTH);
  writeAscii(header, 0, "INDX");
  put32(header, 4, INDX_HEADER_LENGTH);
  put32(header, 16, 2);
  put32(header, 24, numDataRecords);
  put32(header, 28, 65001);
  put32(header, 32, NULL_INDEX);
  put32(header, 36, numEntries);
  put32(header, 52, numCncx);
  put32(header, 180, INDX_HEADER_LENGTH);

  let tagxBlock = tagx;
  while (tagxBlock.length % 4 !== 0) tagxBlock = concatBytes([tagxBlock, new Uint8Array([0])]);

  const geomParts: Uint8Array[] = [];
  const geomOffsets: number[] = [];
  const geomBase = INDX_HEADER_LENGTH + tagxBlock.length;
  let geomLength = 0;

  for (const [label, count] of geometry) {
    geomOffsets.push(geomBase + geomLength);
    const geom = new Uint8Array(1 + label.length + 2);
    const geomView = new DataView(geom.buffer);
    geom[0] = label.length;
    geom.set(label, 1);
    geomView.setUint16(1 + label.length, count, false);
    geomParts.push(geom);
    geomLength += geom.length;
  }

  let geomBlock = concatBytes(geomParts);
  while (geomBlock.length % 4 !== 0) geomBlock = concatBytes([geomBlock, new Uint8Array([0])]);

  const idxtOffset = geomBase + geomBlock.length;
  put32(header, 20, idxtOffset);

  const idxt = new Uint8Array(4 + geomOffsets.length * 2 + ((4 - ((4 + geomOffsets.length * 2) % 4)) % 4));
  const idxtView = new DataView(idxt.buffer);
  writeAscii(idxt, 0, "IDXT");
  geomOffsets.forEach((offset, index) => {
    idxtView.setUint16(4 + index * 2, offset, false);
  });

  return concatBytes([header, tagxBlock, geomBlock, idxt]);
}

function minimalIndx(): Uint8Array[] {
  const tagx = buildTagx([[1, 1, 1]]);
  const data = buildIndxDataRecord([]);
  const primary = buildIndxPrimary(tagx, 1, 0, 0, []);
  return [primary, data];
}

function buildSkeletonIndx(skeletons: SkeletonEntry[]): Uint8Array[] {
  if (skeletons.length === 0) return minimalIndx();

  const tagDefs: TagMeta[] = [
    { number: 1, valuesPerEntry: 1, mask: 3 },
    { number: 6, valuesPerEntry: 2, mask: 12 },
  ];
  const tagx = buildTagx([[1, 1, 3], [6, 2, 12]]);

  const entries = skeletons.map((skeleton) => encodeIndxEntry(
    encodeUtf8(skeleton.label),
    tagDefs,
    [
      [skeleton.chunkCount, skeleton.chunkCount],
      [skeleton.startPos, skeleton.length, skeleton.startPos, skeleton.length],
    ],
  ));

  const dataRecord = buildIndxDataRecord(entries);
  const lastLabel = encodeUtf8(skeletons[skeletons.length - 1].label);
  const primary = buildIndxPrimary(tagx, 1, skeletons.length, 0, [[lastLabel, skeletons.length]]);

  return [primary, dataRecord];
}

function buildFragmentIndxWithCncx(fragments: FragmentEntry[]): { indx: Uint8Array[]; cncx: Uint8Array[] } {
  if (fragments.length === 0) return { indx: minimalIndx(), cncx: [] };

  const tagDefs: TagMeta[] = [
    { number: 2, valuesPerEntry: 1, mask: 1 },
    { number: 3, valuesPerEntry: 1, mask: 2 },
    { number: 4, valuesPerEntry: 1, mask: 4 },
    { number: 6, valuesPerEntry: 2, mask: 8 },
  ];
  const tagx = buildTagx([[2, 1, 1], [3, 1, 2], [4, 1, 4], [6, 2, 8]]);

  const cncx = new CncxBuilder();
  const entries = fragments.map((fragment) => {
    const cncxOffset = cncx.add(fragment.selector);
    const label = encodeUtf8(String(fragment.insertPos).padStart(10, "0"));

    return encodeIndxEntry(label, tagDefs, [
      [cncxOffset],
      [fragment.fileNumber],
      [fragment.sequenceNumber],
      [fragment.startPos, fragment.length],
    ]);
  });

  const dataRecord = buildIndxDataRecord(entries);
  const lastLabel = encodeUtf8(String(fragments[fragments.length - 1].insertPos).padStart(10, "0"));
  const cncxRecords = cncx.intoRecords();
  const primary = buildIndxPrimary(tagx, 1, fragments.length, cncxRecords.length, [[lastLabel, fragments.length]]);

  return { indx: [primary, dataRecord], cncx: cncxRecords };
}

function resolveTocChapterIndex(itemHref: string, textual: LyceumTextualContent, fallbackIndex: number): number {
  const [hrefWithoutFragment] = itemHref.split("#");
  const normalized = normalizeContentPath(hrefWithoutFragment).toLowerCase();
  const exactIndex = textual.chapters.findIndex((chapter) => normalizeContentPath(chapter.href).toLowerCase() === normalized);
  if (exactIndex >= 0) return exactIndex;
  return Math.max(0, Math.min(fallbackIndex, textual.chapters.length - 1));
}

function buildNcxTreeEntries(
  metadata: LyceumBookMetadata,
  textual: LyceumTextualContent,
  skeletons: SkeletonEntry[],
  fragments: FragmentEntry[],
  textLength: number,
  internalTargets: Map<string, KindlePosition>,
): NcxIndexEntry[] {
  const firstFragmentByChapter = new Map<number, FragmentEntry>();
  for (const fragment of fragments) {
    const current = firstFragmentByChapter.get(fragment.fileNumber);
    if (!current || fragment.sequenceNumber < current.sequenceNumber) {
      firstFragmentByChapter.set(fragment.fileNumber, fragment);
    }
  }

  const rawEntries = (textual.toc.length > 0
    ? textual.toc.map((item, fallbackIndex) => {
      const chapterIndex = resolveTocChapterIndex(item.href, textual, fallbackIndex);
      const chapter = textual.chapters[chapterIndex];
      return {
        originalId: `toc-${fallbackIndex}`,
        title: isPlaceholderTitle(item.title) && chapter ? chapterTitle(chapter, chapterIndex) : item.title,
        chapterIndex,
        target: internalTargets.get(internalTargetKey(chapter.href, normalizeLinkFragment(item.href.split("#")[1] || ""))),
        depth: Math.max(0, Math.floor((item.level || 1) - 1)),
      };
    })
    : textual.chapters.map((chapter, index) => ({
      originalId: `chapter-${index}`,
      title: chapterTitle(chapter, index),
      chapterIndex: index,
      depth: 0,
    })));

  const safeRawEntries = rawEntries.length > 0
    ? rawEntries
    : [{ originalId: "book", title: metadata.title || "Untitled", chapterIndex: 0, depth: 0 }];

  const stack: { depth: number; originalId: string }[] = [];
  const childrenById = new Map<string, string[]>();
  const parentById = new Map<string, string>();

  safeRawEntries.forEach((entry) => {
    while (stack.length > 0 && stack[stack.length - 1].depth >= entry.depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) {
      parentById.set(entry.originalId, parent.originalId);
      const children = childrenById.get(parent.originalId) || [];
      children.push(entry.originalId);
      childrenById.set(parent.originalId, children);
    }
    stack.push({ depth: entry.depth, originalId: entry.originalId });
  });

  const entries = safeRawEntries
    .map((entry, playOrder) => {
      const skeleton = skeletons[Math.max(0, Math.min(entry.chapterIndex, skeletons.length - 1))];
      const target = entry.target;
      const fragment = target ? fragments.find(f => f.sequenceNumber === target.sequenceNumber) : firstFragmentByChapter.get(entry.chapterIndex);
      const offset = (fragment?.insertPos ?? skeleton?.startPos ?? 0) + (target?.offset || 0);
      return {
        ...entry,
        playOrder,
        offset,
        posFid: (fragment ? [fragment.sequenceNumber, target?.offset || 0] : [0, 0]) as [number, number],
      };
    })
    .sort((a, b) => a.depth - b.depth || a.offset - b.offset || a.playOrder - b.playOrder)
    .map((entry, index) => ({ ...entry, index }));

  const indexById = new Map(entries.map((entry) => [entry.originalId, entry.index]));
  const largestIndex = Math.max(0, ...entries.map((entry) => entry.index));
  const labelWidth = Math.max(2, largestIndex.toString(16).length);
  const cncx = new CncxBuilder();

  return entries.map((entry): NcxIndexEntry => {
    const childIndexes = (childrenById.get(entry.originalId) || [])
      .map((childId) => indexById.get(childId))
      .filter((index): index is number => typeof index === "number")
      .sort((a, b) => a - b);
    const parentIndex = parentById.has(entry.originalId) ? indexById.get(parentById.get(entry.originalId)!) : undefined;
    const nextStart = entries
      .filter((candidate) => candidate.depth <= entry.depth && candidate.offset > entry.offset)
      .map((candidate) => candidate.offset)
      .sort((a, b) => a - b)[0] ?? textLength;
    const title = entry.title || metadata.title || "Untitled";

    return {
      index: entry.index,
      start: entry.offset,
      length: Math.max(0, nextStart - entry.offset),
      depth: entry.depth,
      label: title,
      title,
      labelBytes: encodeUtf8(entry.index.toString(16).toUpperCase().padStart(labelWidth, "0")),
      labelOffset: cncx.add(title),
      posFid: entry.posFid,
      parent: parentIndex,
      firstChild: childIndexes[0],
      lastChild: childIndexes[childIndexes.length - 1],
    };
  });
}

function buildNcxIndx(
  metadata: LyceumBookMetadata,
  textual: LyceumTextualContent,
  skeletons: SkeletonEntry[],
  fragments: FragmentEntry[],
  textLength: number,
  internalTargets: Map<string, KindlePosition>,
): { indx: Uint8Array[]; cncx: Uint8Array[]; tbsEntries: NcxTbsEntry[] } {
  const tagDefs: TagMeta[] = [
    { number: 1, valuesPerEntry: 1, mask: 0x01 },
    { number: 2, valuesPerEntry: 1, mask: 0x02 },
    { number: 3, valuesPerEntry: 1, mask: 0x04 },
    { number: 4, valuesPerEntry: 1, mask: 0x08 },
    { number: 21, valuesPerEntry: 1, mask: 0x10 },
    { number: 22, valuesPerEntry: 1, mask: 0x20 },
    { number: 23, valuesPerEntry: 1, mask: 0x40 },
    { number: 6, valuesPerEntry: 2, mask: 0x80 },
  ];
  const tagx = buildTagx([[1, 1, 0x01], [2, 1, 0x02], [3, 1, 0x04], [4, 1, 0x08], [21, 1, 0x10], [22, 1, 0x20], [23, 1, 0x40], [6, 2, 0x80]]);
  const resolvedEntries = buildNcxTreeEntries(metadata, textual, skeletons, fragments, textLength, internalTargets);
  const entries = resolvedEntries.map((entry) => encodeIndxEntry(entry.labelBytes, tagDefs, [
    [entry.start],
    [entry.length],
    [entry.labelOffset],
    [entry.depth],
    typeof entry.parent === "number" ? [entry.parent] : [],
    typeof entry.firstChild === "number" ? [entry.firstChild] : [],
    typeof entry.lastChild === "number" ? [entry.lastChild] : [],
    entry.posFid,
  ]));

  const dataRecord = buildIndxDataRecord(entries);
  const lastLabel = resolvedEntries[resolvedEntries.length - 1]?.labelBytes || encodeUtf8("00");
  const cncxRecords = new CncxBuilder();
  for (const entry of resolvedEntries) cncxRecords.add(entry.title);
  const cncxRecordBytes = cncxRecords.intoRecords();
  const primary = buildIndxPrimary(tagx, 1, entries.length, cncxRecordBytes.length, [[lastLabel, entries.length]]);
  const tbsEntries = resolvedEntries.map((entry) => ({
    index: entry.index,
    start: entry.start,
    length: entry.length,
    depth: entry.depth,
    label: entry.label,
    parent: entry.parent,
    firstChild: entry.firstChild,
    lastChild: entry.lastChild,
  }));

  return { indx: [primary, dataRecord], cncx: cncxRecordBytes, tbsEntries };
}

function buildDatpRecord(): Uint8Array {
  return new Uint8Array([
    0x44, 0x41, 0x54, 0x50,
    0x00, 0x00, 0x00, 0x0d,
    0x01, 0x04, 0x00, 0x04,
    0x02, 0x00, 0x00, 0x06,
    0x19, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x01,
    0x6d, 0x02, 0x46, 0x02,
    0x66, 0x00, 0x00, 0x00,
  ]);
}

function buildFlisRecord(): Uint8Array {
  return new Uint8Array([
    0x46, 0x4c, 0x49, 0x53,
    0x00, 0x00, 0x00, 0x08,
    0x00, 0x41, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0xff, 0xff, 0xff, 0xff,
    0x00, 0x01, 0x00, 0x03,
    0x00, 0x00, 0x00, 0x03,
    0x00, 0x00, 0x00, 0x01,
    0xff, 0xff, 0xff, 0xff,
  ]);
}

function buildFcisRecord(rawTextLength: number): Uint8Array {
  const record = new Uint8Array(52);
  const view = new DataView(record.buffer);

  writeAscii(record, 0, "FCIS");
  view.setUint32(4, 20, false);
  view.setUint32(8, 16, false);
  view.setUint32(12, 2, false);
  view.setUint32(16, 0, false);
  view.setUint32(20, rawTextLength, false);
  view.setUint32(24, 0, false);
  view.setUint32(28, 40, false);
  view.setUint32(32, 0, false);
  view.setUint32(36, 40, false);
  view.setUint32(40, 8, false);
  view.setUint32(44, 0x00010001, false);
  view.setUint32(48, 0, false);

  return record;
}

function buildEofRecord(): Uint8Array {
  return new Uint8Array([0xe9, 0x8e, 0x0d, 0x0a]);
}

function buildExthRecord(type: number, payload: Uint8Array): Uint8Array {
  const record = new Uint8Array(8 + payload.length);
  const view = new DataView(record.buffer);

  view.setUint32(0, type, false);
  view.setUint32(4, record.length, false);
  record.set(payload, 8);

  return record;
}

function buildExth(
  metadata: LyceumBookMetadata,
  options: {
    coverImageOffset?: number | null;
    thumbnailImageOffset?: number | null;
    kf8Boundary?: number;
  } = {},
): Uint8Array {
  const records: Uint8Array[] = [];

  const pushString = (type: number, value?: string | string[] | number) => {
    const normalized = metadataString(value);
    if (!normalized) return;
    records.push(buildExthRecord(type, encodeUtf8(normalized)));
  };

  const pushUInt32 = (type: number, value: number) => {
    records.push(buildExthRecord(type, writeUInt32BE(value)));
  };

  const stableIdentifier = generateStableIdentifier(bookIdentifierSeed(metadata));
  const identifier = metadata.identifier || metadata.isbn || stableIdentifier;
  const asin = metadata.asin || stableIdentifier;

  pushString(100, metadata.author);
  pushString(101, metadata.publisher);
  pushString(102, metadata.description);
  pushString(103, metadata.description);
  pushString(104, metadata.isbn || metadata.identifier || stableIdentifier);
  for (const subject of metadataSubjects(metadata.subject)) pushString(105, subject);
  pushString(106, metadata.publishDate);
  pushString(107, metadata.description);
  pushString(108, metadata.contributor);
  pushString(109, metadata.rights);
  pushString(110, metadata.title || "Untitled");
  pushString(111, "EBOK");
  pushString(112, "Qiaomu Reader");
  pushString(113, asin || identifier);
  pushString(114, normalizeLanguage(metadata.language));
  pushString(115, metadata.authorSort);
  pushString(118, metadata.titleSort);
  pushString(119, metadata.series);
  pushString(501, "EBOK");
  pushString(503, metadata.title || "Untitled");
  pushString(524, normalizeLanguage(metadata.language));
  if (typeof options.coverImageOffset === "number" && options.coverImageOffset >= 0) {
    pushUInt32(201, options.coverImageOffset);
  }
  if (typeof options.thumbnailImageOffset === "number" && options.thumbnailImageOffset >= 0) {
    pushUInt32(202, options.thumbnailImageOffset);
  }

  pushUInt32(121, options.kf8Boundary ?? NULL_INDEX);

  const recordsPayload = concatBytes(records);
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);

  writeAscii(header, 0, "EXTH");
  view.setUint32(4, header.length + recordsPayload.length, false);
  view.setUint32(8, records.length, false);

  return padToFour(concatBytes([header, recordsPayload]));
}

function buildRecordZero(args: {
  metadata: LyceumBookMetadata;
  rawTextLength: number;
  textRecordCount: number;
  extraDataFlags: number;
  firstNonTextRecord: number;
  firstResourceRecord: number;
  fdstRecord: number;
  coverImageOffset: number | null;
  thumbnailImageOffset: number | null;
  fcisRecord: number;
  flisRecord: number;
  srcsRecord: number | null;
  ncxIndexRecord: number;
  fragmentIndexRecord: number;
  skeletonIndexRecord: number;
  datpRecord: number;
}): Uint8Array {
  const title = args.metadata.title || "Untitled";
  const fullName = encodeUtf8(title);
  const exth = buildExth(args.metadata, {
    coverImageOffset: args.coverImageOffset,
    thumbnailImageOffset: args.thumbnailImageOffset,
    kf8Boundary: NULL_INDEX,
  });
  const fullNameOffset = PALMDOC_HEADER_LENGTH + MOBI_HEADER_LENGTH + exth.length;
  const recordLength = fullNameOffset + fullName.length + 2;
  const record = padToFour(new Uint8Array(recordLength));
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);

  // PalmDOC header.
  view.setUint16(0, PALMDOC_COMPRESSION, false);
  view.setUint16(2, 0, false);
  view.setUint32(4, args.rawTextLength, false);          // length without KF8 trailing bytes
  view.setUint16(8, args.textRecordCount, false);
  view.setUint16(10, TEXT_RECORD_SIZE, false);
  view.setUint32(12, 0, false);

  // MOBI header.
  writeAscii(record, MOBI_HEADER_OFFSET, "MOBI");
  view.setUint32(MOBI_HEADER_OFFSET + 4, MOBI_HEADER_LENGTH, false);
  view.setUint32(MOBI_HEADER_OFFSET + 8, 2, false);      // book
  view.setUint32(MOBI_HEADER_OFFSET + 12, 65001, false); // UTF-8
  view.setUint32(MOBI_HEADER_OFFSET + 16, deterministicId(`${title}:${args.metadata.author || ""}:kf8`), false);
  view.setUint32(MOBI_HEADER_OFFSET + 20, 8, false);     // version 8 = KF8/AZW3

  for (const offset of [28, 32, 36, 40, 44, 48, 52, 56, 60]) {
    view.setUint32(MOBI_HEADER_OFFSET + offset, NULL_INDEX, false);
  }
  view.setUint32(MOBI_HEADER_OFFSET + 24, 0, false); // orthographic_index = 0 (none)

  view.setUint32(MOBI_HEADER_OFFSET + 64, args.firstNonTextRecord, false);
  view.setUint32(MOBI_HEADER_OFFSET + 68, fullNameOffset, false);
  view.setUint32(MOBI_HEADER_OFFSET + 72, fullName.length, false);
  view.setUint32(MOBI_HEADER_OFFSET + 76, localeCode(args.metadata.language), false);
  view.setUint32(MOBI_HEADER_OFFSET + 80, 0, false);
  view.setUint32(MOBI_HEADER_OFFSET + 84, 0, false);
  view.setUint32(MOBI_HEADER_OFFSET + 88, 8, false);
  view.setUint32(MOBI_HEADER_OFFSET + 92, args.firstResourceRecord, false);

  view.setUint32(MOBI_HEADER_OFFSET + 96, 0, false);
  view.setUint32(MOBI_HEADER_OFFSET + 100, 0, false);
  view.setUint32(MOBI_HEADER_OFFSET + 104, 0, false);
  view.setUint32(MOBI_HEADER_OFFSET + 108, 0, false);

  view.setUint32(MOBI_HEADER_OFFSET + 112, MOBI_EXTH_FLAGS, false); // EXTH header follows the MOBI header.

  view.setUint32(MOBI_HEADER_OFFSET + 148, NULL_INDEX, false);
  view.setUint32(MOBI_HEADER_OFFSET + 152, NULL_INDEX, false);
  view.setUint32(MOBI_HEADER_OFFSET + 156, NULL_INDEX, false);
  view.setUint32(MOBI_HEADER_OFFSET + 160, 0, false);
  view.setUint32(MOBI_HEADER_OFFSET + 164, 0, false);

  view.setUint32(MOBI_HEADER_OFFSET + 176, args.fdstRecord, false);
  view.setUint32(MOBI_HEADER_OFFSET + 180, 1, false);

  view.setUint32(MOBI_HEADER_OFFSET + 184, args.fcisRecord, false);
  view.setUint32(MOBI_HEADER_OFFSET + 188, 1, false);
  view.setUint32(MOBI_HEADER_OFFSET + 192, args.flisRecord, false);
  view.setUint32(MOBI_HEADER_OFFSET + 196, 1, false);
  view.setUint32(MOBI_HEADER_OFFSET + 200, NULL_INDEX, false);
  view.setUint32(MOBI_HEADER_OFFSET + 204, NULL_INDEX, false);

  view.setUint32(MOBI_HEADER_OFFSET + 208, args.srcsRecord ?? NULL_INDEX, false);
  view.setUint32(MOBI_HEADER_OFFSET + 212, args.srcsRecord === null ? 0 : 1, false);
  view.setUint32(MOBI_HEADER_OFFSET + 216, NULL_INDEX, false);
  view.setUint32(MOBI_HEADER_OFFSET + 220, NULL_INDEX, false);

  view.setUint32(MOBI_HEADER_OFFSET + 224, args.extraDataFlags, false);

  view.setUint32(MOBI_HEADER_OFFSET + 228, args.ncxIndexRecord, false);
  view.setUint32(MOBI_HEADER_OFFSET + 232, args.fragmentIndexRecord, false);
  view.setUint32(MOBI_HEADER_OFFSET + 236, args.skeletonIndexRecord, false);
  view.setUint32(MOBI_HEADER_OFFSET + 240, args.datpRecord, false);
  view.setUint32(MOBI_HEADER_OFFSET + 244, NULL_INDEX, false);

  record.set(exth, PALMDOC_HEADER_LENGTH + MOBI_HEADER_LENGTH);
  record.set(fullName, fullNameOffset);

  return record;
}

function buildKf8Section(
  metadata: LyceumBookMetadata,
  textual: LyceumTextualContent,
  sourceEpub: Uint8Array = new Uint8Array(),
): Kf8BuildResult {
  const { combinedHtml, skeletons, fragments, maxFragmentLength, unresolvedInternalLinkCount, internalTargets } = buildKf8HtmlParts(metadata, textual);
  const cssBytes = encodeUtf8(buildKf8Css(textual));
  const htmlLength = combinedHtml.length;
  const combinedText = concatBytes([combinedHtml, cssBytes]);
  const textRecordPayloads = splitTextRecordPayloads(combinedText);
  const fdst = buildFdstRecord(htmlLength, combinedText.length);
  const { indx: fragmentIndx, cncx: fragmentCncx } = buildFragmentIndxWithCncx(fragments);
  const skeletonIndx = buildSkeletonIndx(skeletons);
  const { indx: ncxIndx, cncx: ncxCncx, tbsEntries } = buildNcxIndx(metadata, textual, skeletons, fragments, htmlLength, internalTargets);
  const tbsByRecord = buildTbsForTextRecords(tbsEntries, textRecordPayloads.map((record) => record.raw.length));
  const includeTbs = tbsEntries.length > 0;
  const textRecords = buildTextRecordsKf8(textRecordPayloads, tbsByRecord, includeTbs);
  const datp = buildDatpRecord();
  return {
    textRecords,
    textLength: combinedText.length,
    htmlLength,
    totalTextLength: combinedText.length,
    extraDataFlags: includeTbs ? 3 : 1,
    fdst,
    fragmentIndx,
    fragmentCncx,
    skeletonIndx,
    ncxIndx,
    ncxCncx,
    datp,
    sourceEpub,
    skeletonCount: skeletons.length,
    fragmentCount: fragments.length,
    maxFragmentLength,
    tbsRecordCount: includeTbs ? textRecordPayloads.length : 0,
    tbsByteCount: Array.from(tbsByRecord.values()).reduce((sum, bytes) => sum + bytes.length, 0),
    unsupportedResourceCount: 0,
    unresolvedInternalLinkCount,
  };
}

function buildPdb(name: string, records: PdbRecord[]): ArrayBuffer {
  const recordListOffset = 78;
  const pdbGap = 2;
  const dataStartOffset = recordListOffset + records.length * 8 + pdbGap;
  const recordOffsets: number[] = [];
  let dataOffset = dataStartOffset;

  for (const record of records) {
    recordOffsets.push(dataOffset);
    dataOffset += record.data.length;
  }

  const output = new Uint8Array(dataOffset);
  const view = new DataView(output.buffer);
  const pdbName = encodeUtf8(clampPdbName(name));
  output.set(pdbName, 0);

  view.setUint16(32, 0, false);
  view.setUint16(34, 0, false);

  const timestamp = pdbTimestamp();
  view.setUint32(36, timestamp, false);
  view.setUint32(40, timestamp, false);
  view.setUint32(44, 0, false);
  view.setUint32(48, 0, false);
  view.setUint32(52, 0, false);
  view.setUint32(56, 0, false);

  writeAscii(output, 60, "BOOK");
  writeAscii(output, 64, "MOBI");

  view.setUint32(68, deterministicId(name), false);
  view.setUint32(72, 0, false);
  view.setUint16(76, records.length, false);

  records.forEach((record, index) => {
    const entryOffset = recordListOffset + index * 8;
    view.setUint32(entryOffset, recordOffsets[index], false);
    view.setUint32(entryOffset + 4, index + 1, false);
    output.set(record.data, recordOffsets[index]);
  });

  return output.buffer;
}

function assertRecordMagic(records: PdbRecord[], index: number, magic: string): void {
  if (index < 0 || index >= records.length) {
    throw new Error(`Record ${index} is outside record table.`);
  }
  const got = decodeUtf8(records[index].data.slice(0, magic.length));
  if (got !== magic) {
    throw new Error(`Record ${index} should start with ${magic}, got ${JSON.stringify(got)}.`);
  }
}

function buildAzw3FromKf8(options: Azw3BuildOptions, kf8: Kf8BuildResult, embedSource: boolean): Azw3BuildResult {
  const textRecordCount = kf8.textRecords.length;
  const imageResources = buildImageResources(options.textual);
  const imageRecords: PdbRecord[] = imageResources.map((image) => ({ data: image.data }));
  const imageResourceCount = imageRecords.length;
  const coverImageOffset = imageResources.findIndex((image) => hasResourceProperty(image.resource, "cover-image"));
  const thumbnailImageOffset = imageResources.findIndex((image) => hasResourceProperty(image.resource, "kindle-thumbnail"));
  const textRecordsByteLength = kf8.textRecords.reduce((sum, record) => sum + record.data.length, 0);
  const textPaddingBytes = (4 - (textRecordsByteLength % 4)) % 4;
  const textPaddingRecords: PdbRecord[] = textPaddingBytes > 0
    ? [{ data: new Uint8Array(textPaddingBytes) }]
    : [];
  const firstKf8IndexRecord = textRecordCount + 1 + textPaddingRecords.length;

  const fragmentIndexRecord = firstKf8IndexRecord;
  const fragmentCncxRecord = fragmentIndexRecord + kf8.fragmentIndx.length;
  const skeletonIndexRecord = fragmentCncxRecord + kf8.fragmentCncx.length;
  const ncxIndexRecord = skeletonIndexRecord + kf8.skeletonIndx.length;
  const ncxCncxRecord = ncxIndexRecord + kf8.ncxIndx.length;
  const firstImageRecord = imageResourceCount > 0
    ? ncxCncxRecord + kf8.ncxCncx.length
    : null;
  const fdstRecord = ncxCncxRecord + kf8.ncxCncx.length + imageResourceCount;
  const datpRecord = fdstRecord + 1;
  const flisRecord = datpRecord + 1;
  const fcisRecord = flisRecord + 1;
  const srcsRecord = embedSource ? fcisRecord + 1 : null;
  const eofRecord = srcsRecord !== null ? srcsRecord + 1 : fcisRecord + 1;
  const firstNonTextRecord = fragmentIndexRecord;
  const firstResourceRecord = firstImageRecord ?? NULL_INDEX;

  const nonBookRecords: PdbRecord[] = [
    ...kf8.fragmentIndx.map((data) => ({ data })),
    ...kf8.fragmentCncx.map((data) => ({ data })),
    ...kf8.skeletonIndx.map((data) => ({ data })),
    ...kf8.ncxIndx.map((data) => ({ data })),
    ...kf8.ncxCncx.map((data) => ({ data })),
    ...imageRecords,
    { data: kf8.fdst },
    { data: kf8.datp },
    { data: buildFlisRecord() },
    { data: buildFcisRecord(kf8.textLength) },
  ];


  nonBookRecords.push({ data: buildEofRecord() });

  const recordZero = buildRecordZero({
    metadata: options.metadata,
    rawTextLength: kf8.textLength,
    textRecordCount,
    extraDataFlags: kf8.extraDataFlags,
    firstNonTextRecord,
    firstResourceRecord,
    fdstRecord,
    coverImageOffset: coverImageOffset >= 0 ? coverImageOffset : null,
    thumbnailImageOffset: thumbnailImageOffset >= 0 ? thumbnailImageOffset : null,
    fcisRecord,
    flisRecord,
    srcsRecord,
    ncxIndexRecord,
    fragmentIndexRecord,
    skeletonIndexRecord,
    datpRecord,
  });

  const records: PdbRecord[] = [
    { data: recordZero },
    ...kf8.textRecords,
    ...textPaddingRecords,
    ...nonBookRecords,
  ];

  assertRecordMagic(records, fdstRecord, "FDST");
  assertRecordMagic(records, fragmentIndexRecord, "INDX");
  assertRecordMagic(records, skeletonIndexRecord, "INDX");
  assertRecordMagic(records, ncxIndexRecord, "INDX");
  assertRecordMagic(records, datpRecord, "DATP");
  assertRecordMagic(records, flisRecord, "FLIS");
  assertRecordMagic(records, fcisRecord, "FCIS");
  if (srcsRecord !== null) assertRecordMagic(records, srcsRecord, "SRCS");
  const expectedEof = buildEofRecord();
  const actualEof = records[eofRecord]?.data;
  if (!actualEof || actualEof.length !== expectedEof.length || expectedEof.some((byte, index) => actualEof[index] !== byte)) {
    throw new Error(`Record ${eofRecord} should be the MOBI EOF marker.`);
  }

  return {
    buffer: buildPdb(options.metadata.title || "Untitled", records),
    stats: {
      chapterCount: options.textual.chapters.length,
      textRecordCount,
      recordCount: records.length,
      rawTextBytes: kf8.textLength,
      extraDataFlags: kf8.extraDataFlags,
      compressedTextBytes: kf8.textRecords.reduce((sum, record) => sum + record.data.length, 0),
      textPaddingBytes,
      compressionRatio: kf8.textLength > 0
        ? Number((kf8.textRecords.reduce((sum, record) => sum + record.data.length, 0) / kf8.textLength).toFixed(4))
        : 1,
      htmlLength: kf8.htmlLength,
      totalTextLength: kf8.totalTextLength,
      skeletonCount: kf8.skeletonCount,
      fragmentCount: kf8.fragmentCount,
      maxFragmentLength: kf8.maxFragmentLength,
      tbsRecordCount: kf8.tbsRecordCount,
      tbsByteCount: kf8.tbsByteCount,
      anchorOffsetCount: 0,
      tocItemCount: options.textual.toc.length,
      maxTocDepth: options.textual.toc.reduce((max, item) => Math.max(max, item.level || 1), 0),
      imageResourceCount,
      firstImageRecord,
      coverImageOffset: coverImageOffset >= 0 ? coverImageOffset : null,
      thumbnailImageOffset: thumbnailImageOffset >= 0 ? thumbnailImageOffset : null,
      unsupportedResourceCount: kf8.unsupportedResourceCount,
      unresolvedInternalLinkCount: kf8.unresolvedInternalLinkCount,
      fdstRecord,
      fragmentIndexRecord,
      skeletonIndexRecord,
      ncxIndexRecord,
      datpRecord,
      flisRecord,
      fcisRecord,
      srcsRecord,
    },
  };
}

export function buildAzw3(options: Azw3BuildOptions): Azw3BuildResult {
  if (options.embedSource) {
    throw new Error("buildAzw3 com embedSource requer buildAzw3Async para empacotar o EPUB com JSZip.");
  }

  return buildAzw3FromKf8(
    options,
    buildKf8Section(options.metadata, options.textual),
    false,
  );
}

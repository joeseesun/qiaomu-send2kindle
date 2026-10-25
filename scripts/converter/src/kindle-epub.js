// Local EPUB -> KF8 input adapter. Runs only in the disposable desktop worker.
import JSZip from 'jszip';
import { buildAzw3 } from '../vendor/kindle-azw3/azw3Writer.ts';
import { parseXml, serializeXml } from '../vendor/kindle-azw3/xml.js';
import { sanitizeCss } from '../vendor/kindle-azw3/cssSanitizer.ts';
import { kindleError } from './kindle-config.js';
export const KINDLE_CONVERSION_LIMITS = Object.freeze({ file: 64 * 1024 * 1024, expanded: 128 * 1024 * 1024, entry: 16 * 1024 * 1024, entries: 10000, chapters: 5000, text: 32 * 1024 * 1024 });
const fail = (code = 'conversion') => { throw kindleError(code); };
const elements = (root, name) => Array.from(root.getElementsByTagNameNS('*', name));
const plain = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
const hasControl = value => Array.from(value).some(c => c.charCodeAt(0) < 32);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => { let crc = i; for (let n = 0; n < 8; n++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; return crc >>> 0; });
function resolvePath(base, href, fragment = false) {
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(href)) fail();
  const [raw, hash] = href.split('#', 2);
  let path;
  try { path = decodeURIComponent(raw); } catch { fail(); }
  if (path.includes('\\') || hasControl(path)) fail();
  const parts = base.split('/').slice(0, -1);
  if (!raw && hash !== undefined) return base + (fragment ? '#' + hash : '');
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) fail(); parts.pop(); } else parts.push(part);
  }
  return parts.join('/') + (fragment && hash !== undefined ? '#' + hash : '');
}
// Bound central-directory declarations before decompression. Reject ZIP64 and
// encrypted containers rather than allocating unbounded decompressed buffers.
function checkZip(bytes, limits) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
  if (end < Math.max(0, bytes.length - 65557) || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) fail();
  const count = view.getUint16(end + 10, true), offset = view.getUint32(end + 16, true), size = view.getUint32(end + 12, true);
  if (!count || count === 65535 || count > limits.entries || offset + size > end || view.getUint16(end + 8, true) !== count) fail('conversion-size');
  let cursor = offset, total = 0;
  const seen = new Set(), entries = new Map();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) fail();
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true), expanded = view.getUint32(cursor + 24, true);
    const length = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true);
    if (flags & 1 || ![0, 8].includes(method)) fail();
    if ((total += expanded) > limits.expanded || expanded > limits.entry) fail('conversion-size');
    if (cursor + 46 + length + extra + comment > offset + size) fail();
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + length));
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some(p => p === '..' || p === '.') || hasControl(name) || seen.has(name.toLowerCase())) fail();
    entries.set(name, { size: expanded, crc: view.getUint32(cursor + 16, true) });
    seen.add(name.toLowerCase()); cursor += 46 + length + extra + comment;
  }
  if (cursor !== offset + size) fail();
  return entries;
}
function checkAzw3(bytes) {
  if (bytes.length < 1024 || String.fromCharCode(...bytes.subarray(60, 68)) !== 'BOOKMOBI') fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getUint16(76), offsets = [];
  if (!count || 78 + count * 8 > bytes.length) fail();
  for (let i = 0; i < count; i++) {
    const offset = view.getUint32(78 + i * 8);
    if (offset < 78 + count * 8 || offset >= bytes.length || i && offset <= offsets[i - 1]) fail();
    offsets.push(offset);
  }
  const mobi = offsets[0] + 16;
  if (mobi + 24 >= bytes.length || String.fromCharCode(...bytes.subarray(mobi, mobi + 4)) !== 'MOBI' || view.getUint32(mobi + 20) !== 8) fail();
  if (![0xe9, 0x8e, 0x0d, 0x0a].every((b, i) => bytes[bytes.length - 4 + i] === b)) fail();
}
export async function convertKindleEpub(input, { limits = KINDLE_CONVERSION_LIMITS } = {}) {
  const bytes = new Uint8Array(input);
  if (!bytes.length || bytes.length > limits.file) fail('conversion-size');
  const entries = checkZip(bytes, limits);
  const zip = await JSZip.loadAsync(bytes, { createFolders: false });
  let actualTotal = 0;
  const cache = new Map();
  const read = async path => {
    if (cache.has(path)) return cache.get(path);
    const file = zip.file(path);
    if (!file) fail();
    let size = 0, crc = 0xffffffff;
    const data = await new Promise((resolve, reject) => {
      const chunks = [], stream = file.internalStream('uint8array');
      stream.on('data', chunk => {
        size += chunk.length; actualTotal += chunk.length;
        if (size > limits.entry || actualTotal > limits.expanded) { stream.pause(); reject(kindleError('conversion-size')); return; }
        for (const b of chunk) crc = CRC_TABLE[(crc ^ b) & 255] ^ crc >>> 8;
        chunks.push(chunk);
      }).on('error', reject).on('end', () => {
        const expected = entries.get(path);
        if (!expected || size !== expected.size || ((crc ^ 0xffffffff) >>> 0) !== expected.crc) { reject(kindleError('conversion')); return; }
        const result = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
        resolve(result);
      }).resume();
    });
    cache.set(path, data); return data;
  };
  const text = async path => new TextDecoder('utf-8', { fatal: true }).decode(await read(path));
  if ((await text('mimetype')).trim() !== 'application/epub+zip') fail();
  const container = parseXml(await text('META-INF/container.xml'));
  const opfPath = resolvePath('', elements(container, 'rootfile')[0]?.getAttribute('full-path'));
  const opf = parseXml(await text(opfPath));
  const metadataNode = elements(opf, 'metadata')[0];
  if (!metadataNode || elements(metadataNode, 'meta').some(m => m.getAttribute('property') === 'rendition:layout' && plain(m) === 'pre-paginated')) fail('conversion-resource');
  const values = name => elements(metadataNode, name).map(plain).filter(Boolean);
  const metadata = { title: values('title')[0] || 'Untitled', author: values('creator').join('; '), language: values('language')[0] || 'und', identifier: values('identifier')[0], publisher: values('publisher')[0], description: values('description')[0], publishDate: values('date')[0], subject: values('subject') };
  const items = new Map();
  for (const item of elements(opf, 'item')) {
    const id = item.getAttribute('id');
    if (!id || items.has(id)) fail();
    items.set(id, { id, href: resolvePath(opfPath, item.getAttribute('href')), mediaType: item.getAttribute('media-type') || '', properties: item.getAttribute('properties') || '' });
  }
  if (zip.file('META-INF/encryption.xml')) {
    const data = elements(parseXml(await text('META-INF/encryption.xml')), 'EncryptedData');
    if (!data.length) fail();
    for (const encrypted of data) {
      const algorithm = elements(encrypted, 'EncryptionMethod')[0]?.getAttribute('Algorithm');
      const uri = resolvePath('', elements(encrypted, 'CipherReference')[0]?.getAttribute('URI'));
      const font = Array.from(items.values()).find(i => i.href === uri);
      // Standard font obfuscation is not book DRM. The native reader uses its
      // own fonts; this writer deliberately does not embed EPUB font files.
      if (!['http://www.idpf.org/2008/embedding','http://ns.adobe.com/pdf/enc#RC'].includes(algorithm) || !font || !/\.(?:otf|ttf|woff2?)$/i.test(font.href)) fail();
    }
  }
  const coverId = elements(metadataNode, 'meta').find(m => m.getAttribute('name') === 'cover')?.getAttribute('content');
  if (coverId && items.has(coverId)) items.get(coverId).properties += ' cover-image';
  const refs = elements(opf, 'itemref');
  if (!refs.length || refs.length > limits.chapters) fail('conversion-size');
  const chapters = [], resources = [], toc = [], anchorsByPath = new Map();
  let textBytes = 0;
  for (const ref of refs) {
    const item = items.get(ref.getAttribute('idref'));
    if (!item || !['application/xhtml+xml', 'text/html'].includes(item.mediaType)) fail('conversion-resource');
    const content = await text(item.href);
    if ((textBytes += content.length * 2) > limits.text) fail('conversion-size');
    const doc = parseXml(content), body = elements(doc, 'body')[0];
    if (!body) fail();
    // Preserve static book content, never run active content or leave external
    // image/CSS URLs in the generated book. Unsupported visible media fails.
    for (const el of Array.from(body.getElementsByTagName('*'))) {
      const tag = el.localName.toLowerCase();
      if (['script', 'iframe', 'object', 'embed', 'form', 'style', 'link'].includes(tag)) { el.parentNode?.removeChild(el); continue; }
      if (['math', 'audio', 'video'].includes(tag)) fail('conversion-resource');
      if (tag === 'svg') {
        const images = elements(el, 'image'), shapes = Array.from(el.getElementsByTagName('*')).filter(n => !['image','title','desc','g'].includes(n.localName));
        if (images.length !== 1 || shapes.length) fail('conversion-resource');
        const image = doc.createElementNS('http://www.w3.org/1999/xhtml', 'img');
        image.setAttribute('src', images[0].getAttribute('href') || images[0].getAttribute('xlink:href') || ''); image.setAttribute('alt', plain(elements(el, 'title')[0]));
        el.parentNode.replaceChild(image, el);
      }
      for (const attr of Array.from(el.attributes)) {
        if (/^on/i.test(attr.name) || ['srcset','poster'].includes(attr.name)) el.removeAttribute(attr.name);
        if (['href','src','xlink:href'].includes(attr.name) && /^(?:javascript|data|file):/i.test(attr.value)) el.removeAttribute(attr.name);
      }
      if (el.hasAttribute('style')) {
        const clean = sanitizeCss(`p {${el.getAttribute('style')}}`, { rewriteUrl: () => undefined }).css;
        el.setAttribute('style', clean.slice(clean.indexOf('{') + 1, clean.lastIndexOf('}')));
      }
    }
    for (const img of elements(body, 'img')) {
      const path = resolvePath(item.href, img.getAttribute('src'));
      const resource = Array.from(items.values()).find(i => i.href === path);
      if (!resource || !['image/jpeg','image/png','image/gif'].includes(resource.mediaType.toLowerCase())) fail('conversion-resource');
    }
    const anchors = new Set();
    for (const el of [body, ...Array.from(body.getElementsByTagName('*'))]) for (const attr of ['id','name']) {
      const value = el.getAttribute(attr);
      if (value) anchors.add(value);
    }
    if (anchorsByPath.has(item.href)) fail('conversion-resource');
    anchorsByPath.set(item.href, anchors);
    const chapterStyles = elements(doc, 'style').map(el => plain(el)).join('\n');
    if (chapterStyles) resources.push({ id: item.id + '-inline-css', href: item.href + '.css', mediaType: 'text/css', data: new TextEncoder().encode(chapterStyles) });
    chapters.push({ ...item, title: plain(elements(body, 'h1')[0] || elements(doc, 'title')[0]) || 'Untitled', xhtml: serializeXml(doc), linear: ref.getAttribute('linear') !== 'no' });
  }
  for (const item of items.values()) if (['image/jpeg','image/png','image/gif','text/css'].includes(item.mediaType.toLowerCase())) resources.push({ ...item, data: await read(item.href) });
  const nav = Array.from(items.values()).find(i => i.properties.split(/\s+/).includes('nav'));
  const ncx = Array.from(items.values()).find(i => i.mediaType === 'application/x-dtbncx+xml');
  if (nav) {
    const doc = parseXml(await text(nav.href));
    const root = elements(doc, 'nav').find(el => (el.getAttribute('epub:type') || el.getAttribute('type') || '').split(/\s+/).includes('toc'));
    if (root) for (const a of elements(root, 'a')) {
      let level = 0; for (let n = a.parentNode; n && n !== root; n = n.parentNode) if (n.localName === 'ol') level++;
      toc.push({ id: 'toc-' + toc.length, title: plain(a), href: resolvePath(nav.href, a.getAttribute('href'), true), level: Math.max(1, level) });
    }
  } else if (ncx) {
    const doc = parseXml(await text(ncx.href));
    for (const point of elements(doc, 'navPoint')) {
      let level = 1; for (let n = point.parentNode; n; n = n.parentNode) if (n.localName === 'navPoint') level++;
      toc.push({ id: 'toc-' + toc.length, title: plain(elements(point, 'navLabel')[0]), href: resolvePath(ncx.href, elements(point, 'content')[0]?.getAttribute('src'), true), level });
    }
  }
  const paths = new Set(chapters.map(c => c.href));
  for (const item of toc) {
    const [path, hash] = item.href.split('#', 2);
    if (!paths.has(path) || hash && !anchorsByPath.get(path)?.has(decodeURIComponent(hash))) fail('conversion-resource');
  }
  const result = buildAzw3({ metadata, textual: { chapters, resources, toc, spine: chapters, fulltext: '' } });
  if (result.stats.unresolvedInternalLinkCount) fail('conversion-resource');
  const output = new Uint8Array(result.buffer); checkAzw3(output);
  return { bytes: output, stats: { ...result.stats, title: metadata.title, author: metadata.author, language: metadata.language } };
}

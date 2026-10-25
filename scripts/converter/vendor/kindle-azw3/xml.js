// Qiaomu's portable adapter: detached XML only, no document/window or resource loader.
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { normalizeHtmlEntitiesForXhtml } from './textual.ts';
export function parseXml(text) {
  if (/<!ENTITY\b|<!DOCTYPE[^>]*\[/i.test(text)) throw new Error('Unsupported XML declaration');
  const source = normalizeHtmlEntitiesForXhtml(text.replace(/<!DOCTYPE[^>]*>/gi, ''));
  return new DOMParser({ onError(level) { if (level !== 'warning') throw new Error('Invalid book XML'); } }).parseFromString(source, 'application/xhtml+xml');
}
export const serializeXml = node => new XMLSerializer().serializeToString(node);
export function selectElements(document, selector) {
  const choices = selector.split(',').map(s => {
    const match = /^(\w+)?(?:\[([^\]]+)\])?$/.exec(s.trim().replaceAll('\\:', ':'));
    if (!match) throw new Error('Unsupported internal selector');
    return { tag: match[1], attr: match[2] };
  });
  return Array.from(document.getElementsByTagName('*')).filter(el => choices.some(c => (!c.tag || el.localName === c.tag) && (!c.attr || el.hasAttribute(c.attr))));
}
export const renderDefaultCss = () => 'body { margin: 0; line-height: 1.5; } p { margin: 0 0 0.6em; } img { max-width: 100%; height: auto; } h1,h2,h3 { page-break-after: avoid; } table { border-collapse: collapse; }';

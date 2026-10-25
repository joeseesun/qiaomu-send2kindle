/*! Adapted from Lyceum, Copyright (c) 2026 Higino P. C. Neto, MIT.
 * Source: https://github.com/Higino-Neto/Lyceum/tree/806be2fd3677c77cd2bff5f61793ef4564ad2cca
 * Qiaomu adaptation: portable XML DOM, no source EPUB embedding, bounded input.
 * Complete permission notice: licenses/lyceum-MIT.txt.
 */
import { renderDefaultCss } from "./xml.js";
import postcss, { type AtRule, type Root } from "postcss";

export interface CssSanitizeOptions {
  resolveImport?: (href: string) => string | null | undefined;
  rewriteUrl?: (href: string) => string | null | undefined;
}

const SAFE_PROPERTIES = new Set([
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-variant",
  "color",
  "background",
  "background-color",
  "background-image",
  "background-position",
  "background-repeat",
  "background-size",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "text-indent",
  "text-align",
  "text-decoration",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "page-break-before",
  "page-break-after",
  "page-break-inside",
  "widows",
  "orphans",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-style",
  "border-width",
  "width",
  "height",
  "max-width",
  "max-height",
  "float",
  "display",
  "visibility",
  "border-collapse",
  "border-spacing",
  "vertical-align",
]);

const UNSAFE_VALUE_PATTERN = /\b(expression|javascript:|fixed|absolute|sticky|flex|grid|transform|transition|animation|filter|backdrop-filter|box-shadow|text-shadow|z-index)\b|[-\d.]+v[whminmax]\b/i;
const SAFE_DISPLAY_VALUES = new Set(["block", "inline", "inline-block", "none", "table", "table-row", "table-cell", "table-caption", "list-item"]);

function importHref(rule: AtRule) {
  return rule.params.match(/^(?:url\(\s*)?["']?([^"')\s]+)["']?/i)?.[1] || "";
}

function rewriteUrls(value: string, options: CssSanitizeOptions, warnings: string[]) {
  let unresolved = false;
  const rewrittenValue = value.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (match, href: string) => {
    if (/^(?:data:|kindle:embed:)/i.test(href)) return match;
    const rewritten = options.rewriteUrl?.(href);
    if (rewritten) return `url("${rewritten}")`;
    unresolved = Boolean(options.rewriteUrl);
    return match;
  });
  if (unresolved) warnings.push("Declaracao CSS removida porque um recurso url() nao foi empacotado.");
  return unresolved ? null : rewrittenValue;
}

function safeDeclaration(property: string, value: string) {
  if (!SAFE_PROPERTIES.has(property)) return false;
  if (UNSAFE_VALUE_PATTERN.test(value)) return false;
  if (property === "float" && !/^(left|right|none)$/i.test(value.trim())) return false;
  if (property === "display" && !SAFE_DISPLAY_VALUES.has(value.trim().toLowerCase())) return false;
  return true;
}

function inlineImports(root: Root, options: CssSanitizeOptions, warnings: string[], depth: number) {
  root.walkAtRules("import", (rule) => {
    const href = importHref(rule);
    const imported = href && depth < 8 ? options.resolveImport?.(href) : undefined;
    if (!imported) {
      warnings.push(`Import CSS removido porque nao foi resolvido: ${href || rule.params}`);
      rule.remove();
      return;
    }
    try {
      const importedRoot = postcss.parse(imported, { from: href, map: false });
      inlineImports(importedRoot, options, warnings, depth + 1);
      rule.replaceWith(...importedRoot.nodes);
    } catch (error) {
      warnings.push(`Import CSS invalido removido (${href}): ${error instanceof Error ? error.message : String(error)}`);
      rule.remove();
    }
  });
}

export function sanitizeCss(css: string, options: CssSanitizeOptions = {}) {
  const warnings: string[] = [];
  let root: Root;
  try {
    root = postcss.parse(css, { map: false });
  } catch (error) {
    return {
      css: "",
      warnings: [`CSS invalido removido: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  inlineImports(root, options, warnings, 0);
  root.walkComments((comment) => {
    comment.remove();
  });
  root.walkAtRules((rule) => {
    if (["media", "page"].includes(rule.name.toLowerCase())) return;
    if (rule.name.toLowerCase() !== "import") {
      warnings.push(`Regra CSS @${rule.name} removida por incompatibilidade Kindle.`);
      rule.remove();
    }
  });
  root.walkDecls((declaration) => {
    const property = declaration.prop.trim().toLowerCase();
    const value = rewriteUrls(declaration.value.trim(), options, warnings);
    if (!value || !safeDeclaration(property, value)) {
      warnings.push(`Propriedade CSS removida: ${property}.`);
      declaration.remove();
      return;
    }
    declaration.prop = property;
    declaration.value = value;
  });
  root.walkRules((rule) => {
    if (!rule.nodes?.some((node) => node.type === "decl" || node.type === "atrule")) rule.remove();
  });

  return {
    css: root.toString().replace(/\s+/g, " ").trim(),
    warnings: [...new Set(warnings)],
  };
}

export function extractCssReferences(css: string) {
  const references = new Set<string>();
  try {
    const root = postcss.parse(css, { map: false });
    root.walkAtRules("import", (rule) => {
      const href = importHref(rule);
      if (href) references.add(href);
    });
    root.walkDecls((declaration) => {
      for (const match of declaration.value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) references.add(match[1]);
    });
  } catch {
    for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) references.add(match[1]);
    for (const match of css.matchAll(/@import\s+(?:url\()?["']?([^"')\s]+)["']?\)?/gi)) references.add(match[1]);
  }
  return [...references];
}

export function renderKindleDefaultCss() {
  return renderDefaultCss();
}

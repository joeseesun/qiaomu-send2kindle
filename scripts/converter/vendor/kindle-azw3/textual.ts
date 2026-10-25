/*! Adapted from Lyceum, Copyright (c) 2026 Higino P. C. Neto, MIT.
 * Source: https://github.com/Higino-Neto/Lyceum/tree/806be2fd3677c77cd2bff5f61793ef4564ad2cca
 * Qiaomu adaptation: portable XML DOM, no source EPUB embedding, bounded input.
 * Complete permission notice: licenses/lyceum-MIT.txt.
 */
const ENTITY_MAP: Record<string, string> = {
  nbsp: "\u00a0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  cent: "\u00a2",
  pound: "\u00a3",
  yen: "\u00a5",
  euro: "\u20ac",
  sect: "\u00a7",
  para: "\u00b6",
  middot: "\u00b7",
  laquo: "\u00ab",
  raquo: "\u00bb",
  deg: "\u00b0",
  plusmn: "\u00b1",
  sup2: "\u00b2",
  sup3: "\u00b3",
  acute: "\u00b4",
  micro: "\u00b5",
  frac14: "\u00bc",
  frac12: "\u00bd",
  frac34: "\u00be",
  iquest: "\u00bf",
  times: "\u00d7",
  divide: "\u00f7",
  ndash: "\u2013",
  mdash: "\u2014",
  lsquo: "\u2018",
  rsquo: "\u2019",
  sbquo: "\u201a",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bdquo: "\u201e",
  dagger: "\u2020",
  ddagger: "\u2021",
  bull: "\u2022",
  hellip: "\u2026",
  prime: "\u2032",
  Prime: "\u2033",
  lsaquo: "\u2039",
  rsaquo: "\u203a",
  oline: "\u203e",
  frasl: "\u2044",
  image: "\u2111",
  weierp: "\u2118",
  real: "\u211c",
  alefsym: "\u2135",
  larr: "\u2190",
  uarr: "\u2191",
  rarr: "\u2192",
  darr: "\u2193",
  harr: "\u2194",
  crarr: "\u21b5",
  lArr: "\u21d0",
  uArr: "\u21d1",
  rArr: "\u21d2",
  dArr: "\u21d3",
  hArr: "\u21d4",
  forall: "\u2200",
  part: "\u2202",
  exist: "\u2203",
  empty: "\u2205",
  nabla: "\u2207",
  isin: "\u2208",
  notin: "\u2209",
  ni: "\u220b",
  prod: "\u220f",
  sum: "\u2211",
  minus: "\u2212",
  lowast: "\u2217",
  radic: "\u221a",
  prop: "\u221d",
  infin: "\u221e",
  ang: "\u2220",
  and: "\u2227",
  or: "\u2228",
  cap: "\u2229",
  cup: "\u222a",
  int: "\u222b",
  there4: "\u2234",
  sim: "\u223c",
  cong: "\u2245",
  asymp: "\u2248",
  ne: "\u2260",
  equiv: "\u2261",
  le: "\u2264",
  ge: "\u2265",
  sub: "\u2282",
  sup: "\u2283",
  nsub: "\u2284",
  sube: "\u2286",
  supe: "\u2287",
  oplus: "\u2295",
  otimes: "\u2297",
  perp: "\u22a5",
  sdot: "\u22c5",
  lceil: "\u2308",
  rceil: "\u2309",
  lfloor: "\u230a",
  rfloor: "\u230b",
  lang: "\u2329",
  rang: "\u232a",
  loz: "\u25ca",
  spades: "\u2660",
  clubs: "\u2663",
  hearts: "\u2665",
  diams: "\u2666",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
};

const XML_ENTITY_NAMES = new Set(["amp", "lt", "gt", "quot", "apos"]);

const XHTML_ENTITY_MAP: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(ENTITY_MAP)
      .filter(([name]) => !XML_ENTITY_NAMES.has(name))
      .map(([name, value]) => [name, `&#${value.codePointAt(0)};`]),
  ),
};

export function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z][a-z0-9]+);/gi, (match, entity) => ENTITY_MAP[entity] ?? ENTITY_MAP[entity.toLowerCase()] ?? match);
}

export function normalizeHtmlEntitiesForXhtml(value: string) {
  return value.replace(/&([a-z][a-z0-9]+);/gi, (match, entity) => {
    const normalized = entity.toLowerCase();
    if (XML_ENTITY_NAMES.has(normalized)) return match;
    return XHTML_ENTITY_MAP[entity] ?? XHTML_ENTITY_MAP[normalized] ?? match;
  });
}

export function stripHtml(value: string) {
  return decodeHtmlEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isPlaceholderTitle(value?: string) {
  if (!value) return true;
  const clean = value.replace(/\s+/g, " ").trim().toLowerCase();
  return !clean || clean === "desconhecido" || clean === "unknown" || clean === "untitled";
}

export function extractBodyHtml(value: string) {
  return value.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? value;
}

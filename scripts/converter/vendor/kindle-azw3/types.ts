/*! Lyceum types, Copyright (c) 2026 Higino P. C. Neto, MIT. See licenses/lyceum-MIT.txt. */
export type BookFormat =
  | "pdf"
  | "epub"
  | "docx"
  | "html"
  | "cbz"
  | "mobi"
  | "azw"
  | "azw3"
  | "azw4"
  | "kfx"
  | "prc"
  | "txt"
  | "lyceum";

export type LyceumContentKind = "textual" | "pdf" | "comic" | "audio";

export interface LyceumConversionOptions {
  preserveCover?: boolean;
  preserveMetadata?: boolean;
  optimizeImages?: boolean;
  generateIndex?: boolean;
  pdfPageSize?: "A4" | "A5" | "Letter" | "Legal";
  pdfMarginTopMm?: number;
  pdfMarginBottomMm?: number;
  pdfMarginLeftMm?: number;
  pdfMarginRightMm?: number;
  pdfLineHeight?: number;
  pdfParagraphSpacingEm?: number;
  pdfFontSizePt?: number;
  pdfChapterPageBreaks?: boolean;
  pdfIncludeToc?: boolean;
  pdfGenerateOutline?: boolean;
  epubLayout?: "auto" | "reflow" | "fixed-layout";
  epubLineHeight?: number;
  epubParagraphSpacingEm?: number;
  kindleProfile?: "legacy-paperwhite" | "kindle-compatible" | "modern-kindle" | "scribe";
  txtChapterHeadings?: boolean;
  txtLineEnding?: "lf" | "crlf";
  htmlIncludeToc?: boolean;
}

export interface LyceumManifest {
  schemaVersion: 1;
  packageId: string;
  title: string;
  sourceFormat: BookFormat;
  originalFileName: string;
  primaryContentKind: LyceumContentKind;
  contentKinds: LyceumContentKind[];
  createdAt: string;
  updatedAt: string;
}

export interface LyceumMetadataEntry {
  value: string;
  id?: string;
  scheme?: string;
  role?: string;
  fileAs?: string;
  language?: string;
  refinements?: Record<string, string[]>;
}

export interface LyceumBookMetadata {
  title: string;
  author?: string;
  language?: string;
  identifier?: string;
  publisher?: string;
  description?: string;
  publishDate?: string;
  subject?: string | string[];
  rights?: string;
  contributor?: string;
  authorSort?: string;
  titleSort?: string;
  series?: string;
  seriesIndex?: string;
  groupPosition?: string;
  displaySeq?: string;
  isbn?: string;
  asin?: string;
  rating?: number;
  timestamp?: string;
  coverResourceId?: string;
  coverHref?: string;
  coverPageHref?: string;
  titles?: LyceumMetadataEntry[];
  creators?: LyceumMetadataEntry[];
  contributors?: LyceumMetadataEntry[];
  identifiers?: LyceumMetadataEntry[];
  subjects?: LyceumMetadataEntry[];
  dates?: LyceumMetadataEntry[];
  customMetadata?: Record<string, string[]>;
}

export interface LyceumTextualChapter {
  id: string;
  href: string;
  title: string;
  xhtml: string;
  mediaType?: string;
  properties?: string;
}

export interface LyceumSpineItem {
  id: string;
  href: string;
  title: string;
  linear?: boolean;
  properties?: string;
  mediaType?: string;
}

export interface LyceumTocItem {
  id: string;
  href: string;
  title: string;
  level: number;
}

export interface LyceumTextualResource {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
  sourceHref?: string;
  fallback?: string;
  linear?: boolean;
  data?: Uint8Array | ArrayBuffer;
}

export interface LyceumTextualContent {
  chapters: LyceumTextualChapter[];
  spine: LyceumSpineItem[];
  toc: LyceumTocItem[];
  fulltext: string;
  resources?: LyceumTextualResource[];
}

export interface LyceumComicPage {
  id: string;
  href: string;
  title: string;
  mediaType: string;
  byteLength: number;
  width?: number;
  height?: number;
  resourceHref?: string;
  originalPath?: string;
}

export interface LyceumComicContent {
  pages: LyceumComicPage[];
  pageCount: number;
  totalBytes: number;
}

export interface LyceumPackage {
  rootPath: string;
  manifest: LyceumManifest;
  metadata: LyceumBookMetadata;
  textual?: LyceumTextualContent;
  comic?: LyceumComicContent;
}

export interface ImportInput {
  sourcePath: string;
  sourceFormat: BookFormat;
  packageRoot: string;
  metadata?: Partial<LyceumBookMetadata>;
  renderImageAsset?: unknown;
  conversionOptions?: LyceumConversionOptions;
  onProgress?: (progress: number, message: string) => void;
}

export interface ImportReport {
  sourceFormat: BookFormat;
  contentKinds: LyceumContentKind[];
  warnings: string[];
  stats: Record<string, number | string | boolean>;
}

export interface ImportResult {
  package: LyceumPackage;
  report: ImportReport;
}

export interface ExportInput {
  package: LyceumPackage;
  outputPath: string;
  metadata?: Partial<LyceumBookMetadata>;
  conversionOptions?: LyceumConversionOptions;
}

export interface ExportReport {
  outputFormat: BookFormat;
  warnings: string[];
  stats: Record<string, number | string | boolean>;
}

export interface ExportResult {
  outputPath: string;
  outputFormat: BookFormat;
  report: ExportReport;
}

export interface LyceumImporter {
  inputFormat: BookFormat;
  import(input: ImportInput): Promise<ImportResult>;
}

export interface ExportCapability {
  supported: boolean;
  reason?: string;
}

export interface LyceumExporter {
  outputFormat: BookFormat;
  canExport(pkg: LyceumPackage): ExportCapability;
  export(input: ExportInput): Promise<ExportResult>;
}

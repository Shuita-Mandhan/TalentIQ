// Reading text out of a PDF or a DOCX.
//
// This layer knows nothing about AI. It takes bytes and returns pages of text, which is the whole of
// its contract:
//
//   resume bytes  ->  document extractor  ->  normalized resume text  ->  AI provider
//
// Keeping it separate is what makes the pipeline testable without a model running, and what means a
// failure to read a document is distinguishable from a failure to understand one.
//
// Neither extractor executes anything. The DOCX reader inflates exactly one entry from the archive
// and parses it as XML text; it never looks at macros, embedded objects, external relationships or
// any other part of the container, so a .docm renamed to .docx has nothing here to run it. The PDF
// reader is pdf.js by way of unpdf, used only for its text layer.

import { inflateRawSync } from "node:zlib";
import { getDocumentProxy } from "unpdf";
import {
  MAX_PDF_PAGES,
  joinWrappedLines,
  looksLikeHeading,
  normalizeDocument,
  type DocumentText,
} from "./text.ts";

export type DocumentParser = "pdf" | "docx";

// ---------------------------------------------------------------------------------------------
// limits
//
// A resume file is attacker-controlled. Phase 7 caps what may be uploaded at 10 MiB, but 10 MiB of
// PDF can declare ten thousand pages, and 10 KiB of DOCX can decompress into a gigabyte of XML, so
// size alone is not a bound on work. These are.
//
// Every one of them produces an ordinary refusal with a sentence a recruiter can act on. None of
// them is configurable: they are properties of what a resume is, not of a deployment.
// ---------------------------------------------------------------------------------------------

// MAX_PDF_PAGES lives in ./text, next to the other facts about documents.

/**
 * The most decompressed XML one DOCX may expand into.
 *
 * word/document.xml for a text resume is a few kilobytes. Four megabytes is three orders of magnitude
 * of headroom, and it is enforced by zlib while inflating rather than checked afterwards, so a
 * declared size that lies cannot get past it either.
 */
export const MAX_DOCX_XML_BYTES = 4 * 1024 * 1024;

/**
 * The most archive entries to walk looking for word/document.xml.
 *
 * A ZIP's own header states how many entries it has, and a malformed one may state 65535. A resume
 * has a handful.
 */
export const MAX_ZIP_ENTRIES = 2000;

/**
 * How long text extraction may take.
 *
 * Worth being precise about what this does and does not do: it bounds how long the REQUEST waits, not
 * how much CPU pdf.js spends, because pdf.js runs in this process here and there is no worker to
 * terminate. The real bound on work is MAX_PDF_PAGES above; this catches the pathological single page
 * that takes minutes, and turns it into a refusal rather than a hung action.
 */
export const EXTRACTION_TIMEOUT_MS = 20_000;

/** Pages of text, or the reason there are none. The message is for a recruiter, not a log. */
export type ExtractionFailure = "extract_failed" | "unsupported" | "too_large" | "extract_timeout";

export type ExtractionOutcome =
  | { document: DocumentText }
  | { failure: ExtractionFailure; message: string };

export const EXTRACTION_FAILURES = {
  extract_failed: "This document could not be read. It may be damaged or password protected.",
  unsupported: "Only PDF and DOCX resumes can be processed.",
  too_large: `This document is too large to process. Resumes of up to ${MAX_PDF_PAGES} pages can be read.`,
  extract_timeout: "This document took too long to read and was stopped.",
} as const;

/** Resolves with the work's result, or with the failure, whichever comes first. Never rejects. */
async function withinTimeout(
  work: Promise<ExtractionOutcome>,
  failure: ExtractionFailure,
): Promise<ExtractionOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<ExtractionOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ failure, message: EXTRACTION_FAILURES[failure] }),
      EXTRACTION_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    // So a finished extraction does not hold the process open for the rest of the budget.
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// PDF
//
// pdf.js hands back text runs in CONTENT-STREAM order, which is the order the producing tool wrote
// them and is not necessarily the order a person reads them. Resume templates built in design tools
// routinely write a sidebar's headings before its contents, or a whole column out of sequence, and
// taking that order as the reading order detaches every heading from the text under it. One real
// resume arrived with "SKILLS" and "LANGUAGE" adjacent on lines 3 and 4 and the actual skills six
// lines further down under "EDUCATION" - at which point no model, however well prompted, can tell
// which section a line belongs to, because that information is no longer in the text.
//
// So the order is reconstructed from the positions pdf.js also provides: columns first, then top to
// bottom within each column. A document with no column gutter is simply sorted top to bottom, which
// is what a single-column file already was.
//
// The same positions settle a second question. A list item too long for its column arrives as two
// lines - "Packaged Consumer Goods" and "Sales" - and read as two lines it becomes two skills, one of
// them a word of the other. The lines of one wrapped piece of text all end flush at the margin that
// broke them, which is what isWrappedBlock looks for, and lines that merely sit under one another do
// not.
// ---------------------------------------------------------------------------------------------

/** A positioned text run, as pdf.js reports it. PDF coordinates put y=0 at the bottom of the page. */
type TextRun = {
  x: number;
  y: number;
  width: number;
  /** The run's point size, which is how a resume marks a heading. */
  height: number;
  /** pdf.js saw a line break after this run: whatever it reported next is the next line of it. */
  eol: boolean;
  /** Position in the order pdf.js reported, which is the order the producing tool wrote. */
  order: number;
  str: string;
};

/** One visual line, with what is needed to tell a wrapped line from a separately placed one. */
type TextLine = {
  text: string;
  x: number;
  right: number;
  height: number;
  firstOrder: number;
  lastOrder: number;
  lastEol: boolean;
};

/** Runs whose baselines are within this many points are on the same visual line. */
const LINE_TOLERANCE_PT = 3;

/** Narrower than this is letter-spacing or a wide margin, not a column gutter. */
const MIN_GUTTER_PT = 24;

/** A side holding less of the page than this is a stray label, not a column. */
const MIN_COLUMN_SHARE = 0.15;

/** Below this there is not enough on the page for "column" to mean anything. */
const MIN_RUNS_FOR_COLUMNS = 10;

/** Edges within this many points are the same edge, allowing for rounding in the page's numbers. */
const SAME_EDGE_PT = 2;

/** How much larger than the body text a line must be set before it counts as a heading. */
const HEADING_SIZE_RATIO = 1.25;

/** A line ending in one of these finished a sentence, so it did not run out of room. */
const ENDS_SENTENCE = /[.?!:;]$/;

function textRuns(items: readonly unknown[]): TextRun[] {
  const runs: TextRun[] = [];
  for (const item of items) {
    const candidate = item as {
      str?: unknown;
      width?: unknown;
      height?: unknown;
      hasEOL?: unknown;
      transform?: unknown;
    };
    if (typeof candidate.str !== "string" || candidate.str.trim() === "") continue;
    const transform = candidate.transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;
    runs.push({
      x: Number(transform[4]),
      y: Number(transform[5]),
      width: typeof candidate.width === "number" ? candidate.width : 0,
      height: typeof candidate.height === "number" ? candidate.height : 0,
      eol: candidate.hasEOL === true,
      order: runs.length,
      str: candidate.str,
    });
  }
  return runs;
}

/**
 * The x of the widest vertical band no run crosses, or null when the page has no columns.
 *
 * Decided from runs rather than from assembled lines, and that ordering matters: a sidebar run and a
 * main-column run often share a baseline, so grouping into lines first invents full-width lines that
 * cross every candidate band and the gutter is never found.
 *
 * Deliberately conservative - it finds at most one gutter, requires a real gap, and requires both
 * sides to carry a meaningful share of the page. Anything less clear-cut is treated as one column,
 * because mis-splitting a single-column resume would be worse than not splitting a two-column one.
 */
function findGutter(runs: readonly TextRun[]): number | null {
  if (runs.length < MIN_RUNS_FOR_COLUMNS) return null;

  let bestEdge: number | null = null;
  let bestGap = 0;
  for (const edge of new Set(runs.map((run) => run.x + run.width))) {
    if (runs.some((run) => run.x < edge && run.x + run.width > edge)) continue;
    const left = runs.filter((run) => run.x + run.width <= edge);
    const right = runs.filter((run) => run.x >= edge);
    if (left.length === 0 || right.length === 0) continue;
    if (Math.min(left.length, right.length) / runs.length < MIN_COLUMN_SHARE) continue;

    const gap =
      Math.min(...right.map((run) => run.x)) - Math.max(...left.map((run) => run.x + run.width));
    if (gap >= MIN_GUTTER_PT && gap > bestGap) {
      bestGap = gap;
      bestEdge = edge;
    }
  }
  return bestEdge;
}

/** Runs grouped into visual lines, top to bottom, each line left to right. */
function linesOf(runs: readonly TextRun[]): TextLine[] {
  const grouped: { y: number; runs: TextRun[] }[] = [];
  for (const run of runs) {
    const line = grouped.find((candidate) => Math.abs(candidate.y - run.y) <= LINE_TOLERANCE_PT);
    if (line) line.runs.push(run);
    else grouped.push({ y: run.y, runs: [run] });
  }

  return grouped
    .sort((a, b) => b.y - a.y)
    .map(({ runs: lineRuns }) => {
      const across = [...lineRuns].sort((a, b) => a.x - b.x);
      const written = [...lineRuns].sort((a, b) => a.order - b.order);
      const last = written[written.length - 1] as TextRun;
      return {
        text: across.reduce((text, run, index) => {
          if (index === 0) return run.str;
          const previous = across[index - 1] as TextRun;
          // Runs that touch are one word split by kerning; a real gap is a space. Joining everything
          // with a space would spell a word out letter by letter, and joining everything without one
          // would run "French" into the phone number beside it.
          const apart = run.x - (previous.x + previous.width) > 1;
          return apart ? `${text} ${run.str}` : text + run.str;
        }, ""),
        x: Math.min(...across.map((run) => run.x)),
        right: Math.max(...across.map((run) => run.x + run.width)),
        height: Math.max(...across.map((run) => run.height)),
        firstOrder: (written[0] as TextRun).order,
        lastOrder: last.order,
        lastEol: last.eol,
      };
    });
}

/**
 * A column's lines cut into the blocks of text the document drew them in.
 *
 * Two consecutive lines are one block when pdf.js says the first ends in a line break, the second is
 * the very next run it reported, and both begin at the same left edge - which together say the
 * producing tool emitted them as one piece of text. Anything else starts a new block, including the
 * next line of a scrambled content stream, which is how a sidebar heading stays out of the block
 * belonging to the item below it.
 */
function blocksOf(lines: readonly TextLine[]): TextLine[][] {
  const blocks: TextLine[][] = [];
  for (const line of lines) {
    const open = blocks[blocks.length - 1];
    const previous = open?.[open.length - 1];
    const continues =
      open !== undefined &&
      previous !== undefined &&
      previous.lastEol &&
      line.firstOrder === previous.lastOrder + 1 &&
      Math.abs(line.x - previous.x) <= SAME_EDGE_PT;
    if (continues && open) open.push(line);
    else blocks.push([line]);
  }
  return blocks;
}

/**
 * Whether a block is one piece of text the layout wrapped, rather than lines placed one under another.
 *
 * The test is the geometry that defines wrapping: every line but the last ends flush at the same right
 * margin, because reaching that margin is what broke the line. A list item too long for its column
 * and a paragraph both pass. A run of separately positioned lines - a heading, then a skills line,
 * then a date - has a ragged right edge and fails, which is what stops a whole section being glued
 * into one line, and a line that ended a sentence did not run out of room either.
 *
 * The last line must also fall SHORT of that margin, because text that reached it would have wrapped
 * again. Two lines of one block are otherwise indistinguishable from two lines placed under each
 * other - a name above a job title - since a single line is trivially flush with itself.
 *
 * Being wrong in the cautious direction leaves a wrapped item split across two lines, which is what
 * the document looks like anyway. Being wrong the other way invents a line the resume does not have.
 */
function isWrappedBlock(block: readonly TextLine[]): boolean {
  if (block.length < 2) return false;
  const broken = block.slice(0, -1);
  const margin = Math.max(...broken.map((line) => line.right));
  const flush = broken.every(
    (line) => Math.abs(line.right - margin) <= SAME_EDGE_PT && !ENDS_SENTENCE.test(line.text.trim()),
  );
  return flush && margin - (block[block.length - 1] as TextLine).right > SAME_EDGE_PT;
}

/** A column's lines, with the ones the layout wrapped put back together. */
function columnLines(runs: readonly TextRun[]): TextLine[] {
  return blocksOf(linesOf(runs)).flatMap((block) => {
    if (!isWrappedBlock(block)) return block;
    const first = block[0] as TextLine;
    const last = block[block.length - 1] as TextLine;
    return [
      {
        ...first,
        text: block.map((line) => line.text).reduce((left, right) => joinWrappedLines(left, right)),
        right: Math.max(...block.map((line) => line.right)),
        height: Math.max(...block.map((line) => line.height)),
        lastOrder: last.lastOrder,
        lastEol: last.lastEol,
      },
    ];
  });
}

/**
 * The lines this page sets larger than its body text, which is how a resume marks a section.
 *
 * Point size is the heading signal a PDF reliably carries, and the only one available here: "SKILLS"
 * and "Corporate sales account management" are both short and unpunctuated, so no reading of the TEXT
 * can separate them, and guessing wrongly is what files a skill under the languages section. Measured
 * against this page's median line so it is a fact about this document rather than a point size, and
 * when a document sets its headings at body size this finds none and the text-shaped fallback stands.
 */
function headingsOf(lines: readonly TextLine[]): string[] {
  const heights = lines.map((line) => line.height).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] ?? 0;
  if (median <= 0) return [];
  return lines
    .map((line) => ({ height: line.height, text: line.text.trim() }))
    .filter((line) => line.height >= median * HEADING_SIZE_RATIO && looksLikeHeading(line.text))
    .map((line) => line.text);
}

/** One page, in the order a person would read it, and the headings it marks out. */
function pageText(items: readonly unknown[]): { text: string; headings: string[] } {
  const runs = textRuns(items);
  const gutter = findGutter(runs);
  const columns =
    gutter === null
      ? [runs]
      : [runs.filter((run) => run.x + run.width <= gutter), runs.filter((run) => run.x >= gutter)];
  // Column by column, but sized against the whole page: body text is a property of the document.
  const lines = columns.flatMap((column) => columnLines(column));
  return { text: lines.map((line) => line.text).join("\n"), headings: headingsOf(lines) };
}

async function readPdf(bytes: Uint8Array): Promise<ExtractionOutcome> {
  try {
    // A COPY, because pdf.js transfers the buffer it is given to its worker and the original comes
    // back detached - the caller's array silently becomes zero length. Nothing in this application
    // reads the bytes after extracting, but a function that quietly destroys its argument is a trap
    // for whatever is written next, and the copy costs one allocation of a file already in memory.
    const owned = new Uint8Array(bytes);

    // The structure first, which is what makes the page bound cheap: numPages is read from the
    // document's own catalogue, so an enormous file is refused before a single page is rendered.
    const pdf = await getDocumentProxy(owned);
    if (pdf.numPages > MAX_PDF_PAGES) {
      return { failure: "too_large", message: EXTRACTION_FAILURES.too_large };
    }

    // A page at a time, so each page's columns are resolved against that page's own layout and a
    // quote can still be placed on the page it came from.
    const pages: string[] = [];
    const headings: string[] = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const { items } = await page.getTextContent();
      const read = pageText(items);
      pages.push(read.text);
      headings.push(...read.headings);
    }
    return { document: normalizeDocument(pages, headings) };
  } catch {
    // Whatever pdf.js said about the file stays here. A recruiter gets one sentence.
    return { failure: "extract_failed", message: EXTRACTION_FAILURES.extract_failed };
  }
}

function extractPdf(bytes: Uint8Array): Promise<ExtractionOutcome> {
  return withinTimeout(readPdf(bytes), "extract_timeout");
}

// ---------------------------------------------------------------------------------------------
// DOCX
//
// A .docx is a ZIP. Everything needed is in one entry, word/document.xml, so this finds that entry
// in the central directory, inflates it and reads the text runs out of it. Writing it by hand rather
// than taking a dependency is deliberate: the surface is one entry and one element vocabulary, and
// nothing else in the container is touched or trusted.
// ---------------------------------------------------------------------------------------------

const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;

/** Thrown when an archive's document XML exceeds the cap, so it reads as "too large", not "damaged". */
class DocxTooLarge extends Error {
  constructor() {
    super("docx document.xml exceeds the decompressed limit");
    this.name = "DocxTooLarge";
  }
}

/**
 * The uncompressed bytes of one named entry, or null when it is not there or not readable.
 *
 * Bounded three ways, because every number it reads comes out of the file it is reading: the
 * backward scan for the directory covers only the span a comment may occupy, the walk stops after
 * MAX_ZIP_ENTRIES, and the inflate is capped at MAX_DOCX_XML_BYTES by zlib itself rather than
 * checked after the fact - so a declared size that lies does not get a gigabyte allocated first.
 */
function readZipEntry(bytes: Uint8Array, wanted: string): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record sits at the end, after a comment of unknown length, so it is
  // found by scanning backwards. A ZIP comment is at most 65535 bytes, so the record is within the
  // last 65557, and there is no reason to walk a 10 MiB file looking further.
  const floor = Math.max(0, bytes.length - (22 + 0xffff));
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= floor; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) return null;

  const entries = Math.min(view.getUint16(eocd + 10, true), MAX_ZIP_ENTRIES);
  let pointer = view.getUint32(eocd + 16, true);

  for (let index = 0; index < entries; index += 1) {
    if (pointer + 46 > bytes.length) return null;
    if (view.getUint32(pointer, true) !== ZIP_CENTRAL_SIGNATURE) return null;

    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const declaredSize = view.getUint32(pointer + 24, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));

    if (name === wanted) {
      // The archive's own claim about the size, refused before anything is allocated. It may be a
      // lie in either direction, which is why it is not the only check.
      if (declaredSize > MAX_DOCX_XML_BYTES) throw new DocxTooLarge();
      if (localOffset + 30 > bytes.length) return null;
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = bytes.subarray(start, start + compressedSize);
      // 0 is stored, 8 is deflate. A resume written by anything ordinary uses one of the two.
      if (method === 0) {
        if (data.length > MAX_DOCX_XML_BYTES) throw new DocxTooLarge();
        return data;
      }
      if (method === 8) {
        // maxOutputLength is the bound that actually holds: zlib stops inflating at the limit and
        // throws, so a small entry claiming to be small while expanding forever never gets the
        // memory. This is the one check a crafted archive cannot talk its way past.
        return new Uint8Array(inflateRawSync(data, { maxOutputLength: MAX_DOCX_XML_BYTES }));
      }
      return null;
    }

    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlText(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[entity] ?? whole;
  });
}

/**
 * Paragraph text out of WordprocessingML.
 *
 * Only four things are read: the paragraph (w:p), the text run (w:t), the explicit line break
 * (w:br) and the tab (w:tab). A table cell is a paragraph like any other, so tables come through as
 * lines without any table handling. Everything else in the document - drawings, comments, fields,
 * revision marks - is skipped rather than interpreted.
 */
function docxParagraphs(xml: string): string[] {
  const paragraphs: string[] = [];
  // Paragraph boundaries. Self-closing <w:p/> is an empty paragraph and contributes a blank line.
  const blocks = xml.split(/<w:p[ >]/).slice(1);

  for (const block of blocks) {
    const body = block.slice(0, block.indexOf("</w:p>") === -1 ? block.length : block.indexOf("</w:p>"));
    let line = "";
    // w:t runs in document order, with breaks and tabs where the document puts them.
    for (const token of body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/?>|<w:tab\s*\/?>/g)) {
      if (token[0].startsWith("<w:br")) {
        line += "\n";
      } else if (token[0].startsWith("<w:tab")) {
        line += " ";
      } else {
        line += decodeXmlText(token[1] ?? "");
      }
    }
    paragraphs.push(line);
  }
  return paragraphs;
}

function extractDocx(bytes: Uint8Array): ExtractionOutcome {
  let xml: string;
  try {
    const entry = readZipEntry(bytes, "word/document.xml");
    if (entry === null) {
      return { failure: "extract_failed", message: EXTRACTION_FAILURES.extract_failed };
    }
    xml = new TextDecoder().decode(entry);
  } catch (cause) {
    // A bomb and a damaged file are both refusals, but they are not the same refusal, and telling a
    // recruiter their file is corrupt when it is merely enormous would send them looking for the
    // wrong problem. zlib signals the cap with ERR_BUFFER_TOO_LARGE.
    const tooLarge =
      cause instanceof DocxTooLarge ||
      (cause instanceof Error &&
        (cause as { code?: string }).code === "ERR_BUFFER_TOO_LARGE");
    return tooLarge
      ? { failure: "too_large", message: EXTRACTION_FAILURES.too_large }
      : { failure: "extract_failed", message: EXTRACTION_FAILURES.extract_failed };
  }

  const paragraphs = docxParagraphs(xml);
  // A DOCX has no page boundaries until something lays it out, so it is one page. Saying so is
  // honest; inventing page breaks from paragraph counts would not be, and every quote's page number
  // would then be fiction.
  return { document: normalizeDocument([paragraphs.join("\n")]) };
}

// ---------------------------------------------------------------------------------------------

/** Which extractor a stored content type calls for. */
export function parserFor(contentType: string): DocumentParser | null {
  if (contentType === "application/pdf") return "pdf";
  if (contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return "docx";
  }
  return null;
}

/** Reads a resume's text. Never throws: an unreadable document is an outcome, not an exception. */
export async function extractDocument(
  bytes: Uint8Array,
  contentType: string,
): Promise<ExtractionOutcome> {
  const parser = parserFor(contentType);
  if (parser === null) {
    return { failure: "unsupported", message: EXTRACTION_FAILURES.unsupported };
  }
  return parser === "pdf" ? extractPdf(bytes) : extractDocx(bytes);
}

export function isExtracted(
  outcome: ExtractionOutcome,
): outcome is { document: DocumentText } {
  return "document" in outcome;
}

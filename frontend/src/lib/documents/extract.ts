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
import { extractText, getDocumentProxy } from "unpdf";
import { MAX_PDF_PAGES, normalizeDocument, type DocumentText } from "./text.ts";

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
// ---------------------------------------------------------------------------------------------

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

    // mergePages: false is the point - a page per entry is what lets the application decide, later
    // and for itself, which page a quote came from.
    const result = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(result.text) ? result.text : [String(result.text)];
    return { document: normalizeDocument(pages) };
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

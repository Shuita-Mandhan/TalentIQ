// What a resume file actually is, decided from its bytes.
//
// The filename, the extension and the browser's declared MIME type are all claims made by whoever
// uploaded the file, so none of them decides anything here. This module is the authority, and it
// runs on the server before a byte is handed to storage: a file that does not pass is never stored
// at all, which is why there is no quarantine state and no cleanup path for rejected content.
//
// It reads format signatures ONLY. It does not open the document, decompress it, or look at a word
// of what the applicant wrote — that is the next phase's work, and nothing here anticipates it.

import { REJECTIONS, RESUME_FORMATS, type ResumeFormat } from "./types.ts";

/** A ZIP local file header, which every OOXML container starts with. */
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

/**
 * How far into the file a PDF header may sit.
 *
 * The specification says offset zero. Real files written by real tools sometimes carry a byte-order
 * mark or a few bytes of junk first, and every PDF reader tolerates it, so refusing a resume a
 * recruiter can open in Preview would be this application's bug rather than the file's.
 */
const PDF_HEADER = "%PDF-";
const PDF_SEARCH_WINDOW = 1024 + PDF_HEADER.length;

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/** Index of an ASCII needle in the bytes, or -1. Used on ZIP entry names, which are stored plainly. */
function indexOfAscii(bytes: Uint8Array, needle: string, limit = bytes.length): number {
  const codes = [...needle].map((character) => character.charCodeAt(0));
  const last = Math.min(bytes.length, limit) - codes.length;
  for (let start = 0; start <= last; start += 1) {
    let matched = true;
    for (let offset = 0; offset < codes.length; offset += 1) {
      if (bytes[start + offset] !== codes[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

/** The format the bytes are, or null when they are neither of the two this phase accepts. */
export function sniffFormat(bytes: Uint8Array): ResumeFormat | null {
  // The ZIP test comes first because it is the exact one: an OOXML container's header is at offset
  // zero or it is not an OOXML container. Which OOXML it is shows in the names of the entries it
  // holds, and those names sit in the archive as plain ASCII, so a Word document can be told from a
  // spreadsheet, a slide deck or a plain ZIP of resumes without unpacking anything. "word/" is the
  // part no .docx lacks.
  if (startsWith(bytes, ZIP_SIGNATURE)) {
    return indexOfAscii(bytes, "word/") !== -1 ? "docx" : null;
  }

  // The PDF test is the tolerant one, so it goes second: searching a window could in principle find
  // those five bytes inside something else's compressed data, and anything that is already known to
  // be an archive has been answered above.
  if (indexOfAscii(bytes, PDF_HEADER, PDF_SEARCH_WINDOW) !== -1) return "pdf";

  return null;
}

/** Accepted with the format the contents proved, or refused with the sentence to show. */
export type Inspection = { format: ResumeFormat } | { rejection: string };

/**
 * Decides a file on its contents, and checks that its name was telling the truth.
 *
 * `claimedFormat` is what the extension said. A mismatch is refused rather than quietly corrected:
 * a .docx renamed to .pdf would be stored under a content type that is wrong, and the next phase
 * would then try to read it with the wrong reader. Better to say so now, to the person who can fix it.
 */
export function inspectResumeBytes(bytes: Uint8Array, claimedFormat: ResumeFormat): Inspection {
  if (bytes.length === 0) return { rejection: REJECTIONS.empty };

  const actual = sniffFormat(bytes);
  if (actual === null) return { rejection: REJECTIONS.unsupported };
  if (!RESUME_FORMATS.includes(claimedFormat)) return { rejection: REJECTIONS.unsupported };
  if (actual !== claimedFormat) return { rejection: REJECTIONS.mismatched };
  return { format: actual };
}

/**
 * SHA-256 of the bytes, lowercase hex.
 *
 * This is the only identity a resume has in this phase, and the whole of the duplicate rule. It is
 * computed over the bytes the server received, not over anything a client reported, because a
 * checksum supplied by the uploader would let the uploader decide what counts as a duplicate.
 */
export async function checksumHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

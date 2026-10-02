// Turning whatever an extractor produced into text a model can read, deterministically.
//
// The rule throughout is that this cleans up extraction artifacts and nothing else. It never
// rewrites the resume, never reorders it, never fills a gap and never invents a word. Given the same
// pages it always returns the same text, because the text it returns is what every evidence quote
// will later be checked against — a normalizer that varied would make provenance meaningless.
//
// Empty pages are KEPT. A blank page three means page four is still page four, and a page number
// that no longer matches the document a recruiter opens is worse than no page number at all.

/** Bumped when the rules below change, so text produced by an older version is identifiable. */
export const PARSER_VERSION = "extract@1";

/**
 * Below this there is nothing worth asking a model about.
 *
 * A scanned resume typically extracts to a handful of stray characters, so this is the line between
 * "a short resume" and "a picture of a resume". It counts non-whitespace characters, not bytes.
 */
export const MIN_USEFUL_CHARS = 120;

/**
 * The most pages a resume may have.
 *
 * Long for a resume - a thirty-page CV is an academic one with a full publication list - and short
 * enough that reading every page is bounded work. It lives here, with the other facts about documents,
 * rather than in the extractor, because the sentence shown to a recruiter who hits it has to quote the
 * same number and the message catalogue cannot import the extractor (which reaches for node:zlib and
 * pdf.js, neither of which belongs in a browser bundle).
 */
export const MAX_PDF_PAGES = 30;

export type DocumentText = {
  /** Normalized text per page. Index 0 is page 1, and a blank entry is a blank page. */
  pages: string[];
  /** Every page, joined. What the model is given and what quotes are verified against. */
  text: string;
  pageCount: number;
  /** Non-whitespace characters across the whole document. */
  contentLength: number;
  /** Repeated page headers or footers this removed, for the record. */
  removedRunningLines: string[];
};

/** Characters that are extraction noise rather than content. */
function stripInvisibles(text: string): string {
  return (
    text
      // Line endings first, so everything after can assume one form.
      .replace(/\r\n?/g, "\n")
      // Soft hyphen: a hyphenation hint that is not part of the word.
      .replace(/­/g, "")
      // Zero-width space, non-joiner, joiner, and a byte-order mark that wandered in.
      .replace(/[​‌‍﻿]/g, "")
      // Non-breaking and other fixed-width spaces become ordinary spaces.
      .replace(/[          ]/g, " ")
  );
}

/**
 * Rejoins a word a PDF broke across two lines.
 *
 * Only when the evidence is unambiguous: a hyphen at the end of a line, a letter before it, and a
 * lower-case letter beginning the next line. "Full-\nstack" becomes "Fullstack" under this rule,
 * which is wrong, so the hyphen is kept when the next line starts a capital — the common case for a
 * genuine compound. Anything less clear-cut is left exactly as it was.
 */
function rejoinHyphenation(text: string): string {
  return text.replace(/([a-z])-\n([a-z])/g, "$1$2");
}

function normalizePage(raw: string): string {
  return rejoinHyphenation(stripInvisibles(raw))
    .split("\n")
    // Trailing and leading space on a line is always noise; the line's content is not.
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    // Three or more blank lines carry no more meaning than one blank line.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstLine(page: string): string | null {
  const line = page.split("\n").find((value) => value.length > 0);
  return line ?? null;
}

function lastLine(page: string): string | null {
  const lines = page.split("\n").filter((value) => value.length > 0);
  return lines.length > 0 ? (lines[lines.length - 1] as string) : null;
}

/**
 * A line repeated at the same edge of most pages is furniture, not content.
 *
 * Requires at least three pages and a clear majority, because on two pages a repeated line is as
 * likely to be a real heading. Only the first occurrence is kept, so the information is not lost -
 * it simply stops appearing between every section and confusing a model about where sections begin.
 */
function stripRunningLines(pages: string[]): { pages: string[]; removed: string[] } {
  if (pages.length < 3) return { pages, removed: [] };

  const threshold = Math.ceil(pages.length * 0.6);
  const removed: string[] = [];
  let working = [...pages];

  for (const edge of ["first", "last"] as const) {
    const pick = edge === "first" ? firstLine : lastLine;
    const counts = new Map<string, number>();
    for (const page of working) {
      const line = pick(page);
      if (line !== null) counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    for (const [line, count] of counts) {
      // A page number differs on every page, so it never reaches the threshold - which is correct,
      // because removing it would be removing content this cannot distinguish from a date.
      if (count < threshold || line.length === 0) continue;
      removed.push(line);
      let seen = 0;
      working = working.map((page) => {
        if (pick(page) !== line) return page;
        seen += 1;
        if (seen === 1) return page;
        const lines = page.split("\n");
        const index = edge === "first" ? lines.indexOf(line) : lines.lastIndexOf(line);
        if (index === -1) return page;
        return [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n").trim();
      });
    }
  }

  return { pages: working, removed };
}

export function normalizeDocument(rawPages: readonly string[]): DocumentText {
  const normalized = rawPages.map(normalizePage);
  const { pages, removed } = stripRunningLines(normalized);
  const text = pages.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    pages,
    text,
    pageCount: pages.length,
    contentLength: text.replace(/\s+/g, "").length,
    removedRunningLines: removed,
  };
}

/** Whether there is enough text here to be worth reading. A scan is not. */
export function hasUsefulText(document: DocumentText): boolean {
  return document.contentLength >= MIN_USEFUL_CHARS;
}

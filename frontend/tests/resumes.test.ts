// Resume intake: what the system will accept, and how it behaves over a hundred files.
//
// Two tests, which is Phase 7's whole frontend budget. The first is about one file — the decisions
// that let a document in or keep it out, including the ones made from the bytes rather than from the
// name. The second is about a batch — the arithmetic and the queue discipline that make ninety-eight
// successes survive two failures.
//
// Tenant authorization, duplicates, persistence and archived jobs are the database's to enforce and
// are asserted in supabase/tests/rls_checks.sql, where the policies actually run.
//
//   npm test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checksumHex, inspectResumeBytes, sniffFormat } from "../src/lib/resumes/inspect.ts";
import {
  MAX_BATCH_FILES,
  MAX_RESUME_BYTES,
  REJECTIONS,
  UPLOAD_CONCURRENCY,
  checkBatchSize,
  checkResumeFile,
  displayFilename,
  isAccepted,
  resumeStoragePath,
  retryable,
  runBounded,
  safeStorageFilename,
  summariseBatch,
  STATE_LABELS,
  type IntakeState,
} from "../src/lib/resumes/types.ts";

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const uploadRoute = read("../src/app/api/workspace/[organizationSlug]/jobs/[jobId]/resumes/route.ts");
const downloadRoute = read(
  "../src/app/api/workspace/[organizationSlug]/jobs/[jobId]/resumes/[resumeId]/route.ts",
);
const intakePage = read("../src/app/app/[organizationSlug]/jobs/[jobId]/resumes/page.tsx");
const uploader = read("../src/app/app/[organizationSlug]/jobs/[jobId]/resumes/intake-uploader.tsx");
const resumeActions = read("../src/app/app/[organizationSlug]/jobs/[jobId]/resumes/actions.ts");
const migration = read("../../supabase/migrations/20261006120000_resume_intake.sql");

/** Bytes from ASCII, for building file signatures without a fixture directory. */
function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

function bytes(...parts: (number[] | string)[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? ascii(part) : part)));
}

const ZIP = [0x50, 0x4b, 0x03, 0x04];

const PDF_FILE = bytes("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n");
const DOCX_FILE = bytes(ZIP, "\u0014\u0000\u0006\u0000", "[Content_Types].xml", "word/document.xml");
const XLSX_FILE = bytes(ZIP, "\u0014\u0000\u0006\u0000", "[Content_Types].xml", "xl/workbook.xml");
const PLAIN_ZIP = bytes(ZIP, "\u0014\u0000\u0006\u0000", "resumes/first.pdf", "resumes/second.pdf");
const PNG_FILE = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], "IHDR");
const TEXT_FILE = bytes("Jane Doe\nSenior Engineer\n");

test("phase 7 new test 1: a resume is accepted on what it is, not on what it claims", async () => {
  // --- the claim: name, declared type and size, checked before a byte is sent ------------------
  const pdf = checkResumeFile({ name: "Resume.pdf", size: 240_000, type: "application/pdf" });
  assert.ok(isAccepted(pdf) && pdf.format === "pdf", "a PDF is accepted");
  const docx = checkResumeFile({
    name: "cv.DOCX",
    size: 50_000,
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  assert.ok(isAccepted(docx) && docx.format === "docx", "a DOCX is accepted, whatever the case");

  // An absent or generic type is normal, not suspicious: plenty of systems report nothing for DOCX.
  assert.ok(isAccepted(checkResumeFile({ name: "cv.docx", size: 10, type: "" })), "no type is fine");
  assert.ok(
    isAccepted(checkResumeFile({ name: "cv.docx", size: 10, type: "application/octet-stream" })),
    "and neither is a generic one",
  );

  // Everything this phase does not take.
  for (const name of ["photo.png", "scan.jpg", "resume.zip", "notes.txt", "payload.exe", "sheet.xlsx", "deck.pptx", "old.doc", "resume"]) {
    const check = checkResumeFile({ name, size: 1_000, type: "" });
    assert.ok(!isAccepted(check), `${name} is refused`);
    assert.equal(
      "rejection" in check ? check.rejection : "",
      REJECTIONS.unsupported,
      "and is told why in one sentence a recruiter can act on",
    );
  }
  // A file that admits to being something else is refused on its own admission.
  assert.ok(
    !isAccepted(checkResumeFile({ name: "resume.pdf", size: 10, type: "image/png" })),
    "a PNG calling itself a PDF is refused on its declared type alone",
  );
  // Two extensions: the last one is the one that counts.
  assert.ok(!isAccepted(checkResumeFile({ name: "cv.pdf.exe", size: 10, type: "" })), "cv.pdf.exe is an exe");

  // --- the size boundary ------------------------------------------------------------------------
  assert.ok(
    isAccepted(checkResumeFile({ name: "big.pdf", size: MAX_RESUME_BYTES, type: "" })),
    "exactly the limit is within the limit",
  );
  const over = checkResumeFile({ name: "big.pdf", size: MAX_RESUME_BYTES + 1, type: "" });
  assert.ok(!isAccepted(over) && over.rejection === REJECTIONS.tooLarge, "one byte more is not");
  const empty = checkResumeFile({ name: "nothing.pdf", size: 0, type: "" });
  assert.ok(!isAccepted(empty) && empty.rejection === REJECTIONS.empty, "and nothing at all is not");

  // --- the bytes: the only authority. Every case above could have been lied about. --------------
  assert.equal(sniffFormat(PDF_FILE), "pdf");
  assert.equal(sniffFormat(DOCX_FILE), "docx");
  assert.equal(sniffFormat(XLSX_FILE), null, "a spreadsheet is not a resume, OOXML or not");
  assert.equal(sniffFormat(PLAIN_ZIP), null, "nor is a zip full of resumes");
  assert.equal(sniffFormat(PNG_FILE), null);
  assert.equal(sniffFormat(TEXT_FILE), null);
  // Real PDFs sometimes carry a few bytes before the header, and every reader tolerates it.
  assert.equal(sniffFormat(bytes([0xef, 0xbb, 0xbf], "%PDF-1.4\n")), "pdf");

  assert.deepEqual(inspectResumeBytes(PDF_FILE, "pdf"), { format: "pdf" });
  assert.deepEqual(inspectResumeBytes(DOCX_FILE, "docx"), { format: "docx" });
  assert.deepEqual(inspectResumeBytes(PNG_FILE, "pdf"), { rejection: REJECTIONS.unsupported });
  assert.deepEqual(inspectResumeBytes(PLAIN_ZIP, "docx"), { rejection: REJECTIONS.unsupported });
  assert.deepEqual(inspectResumeBytes(bytes(), "pdf"), { rejection: REJECTIONS.empty });
  // A renamed file is not silently corrected: stored under the wrong type it would later be read
  // with the wrong reader, so the person who can fix it is told now.
  assert.deepEqual(inspectResumeBytes(DOCX_FILE, "pdf"), { rejection: REJECTIONS.mismatched });
  assert.deepEqual(inspectResumeBytes(PDF_FILE, "docx"), { rejection: REJECTIONS.mismatched });

  // --- the checksum: the whole of the duplicate rule, so it is pinned to published digests -------
  assert.equal(
    await checksumHex(bytes("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "SHA-256 of 'abc', as the standard states it",
  );
  assert.equal(
    await checksumHex(bytes()),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "and of nothing at all",
  );
  assert.equal(
    await checksumHex(PDF_FILE),
    await checksumHex(PDF_FILE),
    "the same bytes are the same resume every time, which is what makes a duplicate detectable",
  );
  assert.notEqual(
    await checksumHex(PDF_FILE),
    await checksumHex(DOCX_FILE),
    "and two different documents are two different applications",
  );
  assert.ok(
    /^[0-9a-f]{64}$/.test(await checksumHex(DOCX_FILE)),
    "in the lowercase hex the checksum column's own constraint requires",
  );

  // --- filenames never widen a path, and never become a candidate -------------------------------
  assert.equal(safeStorageFilename("../../etc/passwd.pdf", "pdf"), "passwd.pdf", "traversal is gone");
  assert.equal(safeStorageFilename("C:\\Users\\me\\My CV.docx", "docx"), "My-CV.docx");
  assert.equal(safeStorageFilename("\u65e5\u672c\u8a9e.pdf", "pdf"), "resume.pdf", "and a name that survives as nothing still has a name");
  // The extension comes from the format the bytes proved, not from what the name said.
  assert.equal(safeStorageFilename("report.docx", "pdf"), "report.pdf");
  for (const hostile of ["../../x.pdf", "a/b/c.pdf", "....pdf", " .pdf", "\u0000x.pdf"]) {
    const safe = safeStorageFilename(hostile, "pdf");
    assert.ok(!safe.includes("/"), `${JSON.stringify(hostile)} yields no separator`);
    assert.ok(!safe.includes(".."), "and no traversal");
    assert.ok(safe.endsWith(".pdf") && safe.length > 4, "and is still a usable name");
  }
  assert.equal(displayFilename("C:\\Users\\me\\cv.pdf", "pdf"), "cv.pdf", "the shown name is the basename");
  assert.equal([...displayFilename("x".repeat(400) + ".pdf", "pdf")].length, 255, "capped by code point");

  // The path the storage policies parse, and the prefix the check constraint pins.
  const path = resumeStoragePath({
    organizationId: "11111111-1111-1111-1111-111111111111",
    jobId: "22222222-2222-2222-2222-222222222222",
    intakeId: "33333333-3333-3333-3333-333333333333",
    filename: "resume.pdf",
  });
  assert.equal(
    path,
    "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/resumes/33333333-3333-3333-3333-333333333333/resume.pdf",
  );
  assert.equal(path.split("/").length, 5, "organization, job, 'resumes', a fresh id, then the name");
  assert.equal(path.split("/")[2], "resumes", "which is the segment the storage policies require");

  // --- the server does the inspecting, and nothing else is reachable from there ------------------
  assert.ok(uploadRoute.includes("requireOrganizationActionAccess(organizationSlug)"), "the route authenticates itself");
  assert.ok(uploadRoute.includes("requirePermission(context, PERMISSIONS.JOBS_MANAGE)"), "and requires jobs.manage");
  assert.ok(uploadRoute.includes("await getJob(organizationId, jobId)"), "re-reads the job in the resolved organization");
  assert.ok(uploadRoute.includes('job.status === "archived"'), "and refuses an archived one");
  assert.ok(uploadRoute.includes("inspectResumeBytes(bytes, claim.format)"), "the bytes decide the format");
  assert.ok(uploadRoute.includes("await checksumHex(bytes)"), "and the checksum is taken from them, not from the client");
  assert.ok(uploadRoute.includes("upsert: false"), "an upload never overwrites");
  assert.ok(
    /insert\.error[\s\S]{0,400}storage[\s\S]{0,80}remove\(\[storagePath\]\)/.test(uploadRoute),
    "and a failed insert takes the stored bytes back out, so no file is left unreferenced",
  );
  assert.ok(
    !/organizationId\s*=\s*(form|request)/.test(uploadRoute) && !uploadRoute.includes('form.get("organizationId")'),
    "an organization id is never read from the submission",
  );

  // Phase 7 is independent of every AI provider, and of the secret-key client.
  for (const [label, source] of [
    ["the upload route", uploadRoute],
    ["the download route", downloadRoute],
    ["the intake page", intakePage],
    ["the uploader", uploader],
    ["the remove action", resumeActions],
  ] as const) {
    assert.ok(!/lib\/ai/.test(source), `${label} reaches no AI provider`);
    assert.ok(!/ollama|gemini|OLLAMA|GEMINI/i.test(source), `${label} names no model service`);
    assert.ok(!/supabase\/admin|createAdminClient/.test(source), `${label} holds no secret key`);
    assert.ok(!/getPublicUrl/.test(source), `${label} never mints a public URL`);
    // Nothing a resume contains is ever written to a log.
    assert.ok(!/console\.(log|info|warn|error)/.test(source), `${label} logs nothing`);
  }
  // Nor does it guess at a person from a filename.
  assert.ok(
    !/(candidate|applicant)(Name|_name)|parseName|extractName/i.test(uploadRoute + intakePage + uploader),
    "no candidate identity is derived from a filename",
  );

  // The private bucket, and the limit agreeing with the constant above.
  assert.ok(/insert into storage\.buckets[\s\S]*?false,/.test(migration), "the bucket is created private");
  assert.ok(migration.includes("public = false"), "and is forced private if it already existed");
  assert.ok(
    migration.includes(String(MAX_RESUME_BYTES)),
    "the bucket and the application agree on the size limit",
  );
  assert.ok(
    !/create policy[^;]*on storage\.objects for update/i.test(migration),
    "there is no UPDATE policy, so a stored resume cannot be overwritten in place",
  );
});

test("phase 7 new test 2: a hundred files behave like a hundred files", async () => {
  // --- the batch ceiling, refused whole rather than quietly truncated ---------------------------
  assert.equal(checkBatchSize(1), null);
  assert.equal(checkBatchSize(MAX_BATCH_FILES), null, "a hundred is the requirement, not a stretch");
  assert.ok(checkBatchSize(0) !== null, "and nothing is not a batch");
  const tooMany = checkBatchSize(137);
  assert.ok(tooMany !== null && tooMany.includes("137") && tooMany.includes(String(MAX_BATCH_FILES)),
    "an oversized selection says how many were offered and how many are allowed");
  assert.ok(checkBatchSize(MAX_BATCH_FILES + 1) !== null, "one over the line is over the line");

  // --- the queue: bounded, ordered, and nothing cancels anything else ---------------------------
  const work = Array.from({ length: MAX_BATCH_FILES }, (_, index) => index);
  let inFlight = 0;
  let peak = 0;
  const results = await runBounded(work, UPLOAD_CONCURRENCY, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, item % 3));
    inFlight -= 1;
    // Two of the hundred go wrong, and they are answers rather than exceptions.
    return item === 11 || item === 67
      ? ({ state: "failed" } as const)
      : ({ state: "uploaded" } as const);
  });
  assert.equal(peak, UPLOAD_CONCURRENCY, "the budget is used in full");
  assert.ok(peak <= UPLOAD_CONCURRENCY, "and never exceeded");
  assert.equal(results.length, MAX_BATCH_FILES, "every file is accounted for");
  assert.equal(results.filter((result) => result.state === "uploaded").length, 98,
    "ninety-eight successes are not undone by two failures");
  assert.equal(results[11]?.state, "failed", "results come back against the file they belong to");
  assert.equal(results[12]?.state, "uploaded", "and its neighbour is unaffected");

  // --- what the recruiter is shown, derived only from those states ------------------------------
  const states: IntakeState[] = [
    ...Array<IntakeState>(62).fill("uploaded"),
    ...Array<IntakeState>(3).fill("duplicate"),
    ...Array<IntakeState>(2).fill("failed"),
    ...Array<IntakeState>(33).fill("waiting"),
  ];
  const partway = summariseBatch(states);
  assert.equal(partway.total, 100);
  assert.equal(partway.settled, 67, "67 of 100 settled");
  assert.equal(partway.uploaded, 62);
  assert.equal(partway.duplicates, 3);
  assert.equal(partway.failed, 2);
  assert.equal(partway.percent, 67, "and the bar is the count, never an estimate");
  assert.equal(partway.done, false);
  assert.deepEqual(summariseBatch([]), {
    total: 0, settled: 0, uploaded: 0, duplicates: 0, failed: 0, rejected: 0, percent: 0, done: true,
  });

  // --- retry sends back exactly what failed ----------------------------------------------------
  const settled = [
    ...Array.from({ length: 96 }, (_, index) => ({ id: `u${index}`, state: "uploaded" as IntakeState })),
    { id: "d1", state: "duplicate" as IntakeState },
    { id: "d2", state: "duplicate" as IntakeState },
    { id: "f1", state: "failed" as IntakeState },
    { id: "f2", state: "failed" as IntakeState },
  ];
  assert.deepEqual(retryable(settled).map((item) => item.id), ["f1", "f2"],
    "the failures, and only the failures");
  for (const state of ["uploaded", "duplicate", "rejected", "waiting", "uploading"] as IntakeState[]) {
    assert.deepEqual(retryable([{ state }]), [],
      `a ${state} file is never sent again — a duplicate is an answer and an upload must not happen twice`);
  }

  // A retry round: the two that failed succeed, and the count can only go up.
  const afterRetry = settled.map((item) =>
    item.state === "failed" ? { ...item, state: "uploaded" as IntakeState } : item,
  );
  const before = summariseBatch(settled.map((item) => item.state));
  const after = summariseBatch(afterRetry.map((item) => item.state));
  assert.equal(before.uploaded, 96);
  assert.equal(after.uploaded, 98, "two more in");
  assert.equal(after.duplicates, 2, "the duplicates stayed duplicates");
  assert.equal(after.failed, 0);
  assert.ok(after.uploaded >= before.uploaded, "a retry never costs a success");

  // --- the uploader is wired to all of the above -----------------------------------------------
  assert.ok(uploader.includes("runBounded(pending, UPLOAD_CONCURRENCY"), "the queue is bounded by the constant");
  assert.ok(uploader.includes("checkBatchSize(files.length)"), "the ceiling is checked on selection");
  assert.ok(
    /item\.state === "failed"[\s\S]{0,120}"waiting"/.test(uploader),
    "retry re-queues failures and nothing else",
  );
  assert.ok(uploader.includes("request.upload.addEventListener(\"progress\""),
    "progress comes from the request's own upload events");
  assert.ok(
    !/setInterval|requestAnimationFrame/.test(uploader),
    "nothing animates a number the upload did not report",
  );
  assert.ok(
    uploader.includes("summariseBatch(items.map((item) => item.state))"),
    "and the batch figures are derived from the queue rather than tracked separately",
  );
  // A failure resolves rather than throws; that is what keeps the other files going.
  assert.ok(
    /Promise<IntakeOutcome>[\s\S]{0,2000}addEventListener\("error", fail\)/.test(uploader),
    "a network error is an outcome, not an exception that cancels the batch",
  );
  // No state is shown that the system cannot be in. Asserted against the label catalog the queue
  // renders from rather than against the file's prose, so it is a claim about what a recruiter sees.
  assert.ok(uploader.includes("STATE_LABELS[item.state]"), "every state's text comes from the catalog");
  assert.deepEqual(
    Object.keys(STATE_LABELS).sort(),
    ["duplicate", "failed", "rejected", "uploaded", "uploading", "waiting"],
    "and the catalog holds exactly the six states intake can reach",
  );
  assert.ok(
    !Object.values(STATE_LABELS).some((label) => /pars|extract|scor|match|rank|analys/i.test(label)),
    "none of which names a process that does not exist yet",
  );
});

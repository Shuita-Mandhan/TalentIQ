// Phase 8 environment verification: the real pipeline, with the real provider.
//
// Runs the production code paths over a real document and a real model, then emits the SQL that
// persists the result so it can be run against a local throwaway PostgreSQL carrying migrations 1-14.
// Nothing here is mocked: the extractor is the extractor, the prompt is the prompt, the provider is
// whatever AI_PROVIDER names, and the parser is the one the server action uses.
//
// It is not part of `npm test`, deliberately: the suite must not depend on a model being installed.
//
//   # 1. a throwaway cluster with the whole migration chain and the test helpers
//   createdb -p <port> smoke
//   psql -p <port> -d smoke -v ON_ERROR_STOP=1 -f supabase/tests/rls_checks.sql
//   psql -p <port> -d smoke -v ON_ERROR_STOP=1 -f <out>/seed.sql
//
//   # 2. the real pipeline (reads AI_PROVIDER / AI_MODEL / OLLAMA_URL from frontend/.env.local)
//   node --conditions=react-server scripts/smoke-resume-processing.mjs <fixture.pdf> <out-dir>
//
//   # 3. persist and read back, as the authenticated recruiter rather than as the owner
//   psql -p <port> -d smoke -v ON_ERROR_STOP=1 -f <out>/complete.sql
//
// --conditions=react-server is needed because the provider modules are marked "server-only", which
// is a module that throws anywhere the react-server condition is not set.
//
// What this does NOT cover, and the Phase 8 report says so: the Supabase Storage download (the bytes
// are read from disk here) and the Next.js Server Action wrapper around these calls.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { extractDocument, isExtracted } from "../src/lib/documents/extract.ts";
import { hasUsefulText, PARSER_VERSION } from "../src/lib/documents/text.ts";
import {
  PROFILE_SCHEMA_VERSION,
  PROFILE_SYSTEM_PROMPT,
  buildProfileRequest,
  parseCandidateProfile,
} from "../src/lib/resumes/profile.ts";
import { getAiProvider } from "../src/lib/ai/provider.ts";

const [fixturePath, outDir = "smoke-out"] = process.argv.slice(2);
if (!fixturePath) {
  console.error("usage: node --conditions=react-server scripts/smoke-resume-processing.mjs <file> [out]");
  process.exit(2);
}

// The server reads these from the process environment; locally they live in .env.local, which Node
// does not load on its own.
const envFile = new URL("../.env.local", import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

// Fixed ids, so the emitted SQL needs nothing read back from the seed.
const ORG = "11111111-1111-4111-8111-111111111111";
const JOB = "33333333-3333-4333-8333-333333333333";
const RESUME = "44444444-4444-4444-8444-444444444444";

/** A dollar-quoted SQL literal, or NULL. The tag is checked against the payload before use. */
function sql(value, tag) {
  if (value === null || value === undefined) return "null";
  const text = String(value);
  const quote = `$${tag}$`;
  if (text.includes(quote)) throw new Error(`payload contains the quote tag ${quote}`);
  return `${quote}${text}${quote}`;
}

const contentType = fixturePath.endsWith(".docx")
  ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  : "application/pdf";

const bytes = new Uint8Array(readFileSync(fixturePath));
// Captured before extraction: pdf.js used to hand the buffer to its worker and leave the caller's
// array detached. The extractor copies now, but a size read once is still the right habit.
const byteLength = bytes.length;
console.log(`document      ${fixturePath} (${byteLength} bytes, ${contentType})`);

const extractStarted = Date.now();
const extraction = await extractDocument(bytes, contentType);
const extractMs = Date.now() - extractStarted;
if (!isExtracted(extraction)) {
  console.error(`extraction failed: ${extraction.failure}`);
  process.exit(1);
}
const document = extraction.document;
console.log(
  `extraction    ${extractMs} ms · ${document.pageCount} page(s) · ${document.contentLength} chars · useful=${hasUsefulText(document)}`,
);
if (!hasUsefulText(document)) {
  console.log("no usable text; the application would record needs_review and ask no model");
  process.exit(0);
}

const provider = getAiProvider();
console.log(`provider      ${provider.name} · model ${provider.model}`);

const aiStarted = Date.now();
const raw = await provider.completeJson({
  system: PROFILE_SYSTEM_PROMPT,
  user: buildProfileRequest(document.text),
});
const aiMs = Date.now() - aiStarted;
console.log(`extraction AI ${(aiMs / 1000).toFixed(1)} s`);

const parsed = parseCandidateProfile(raw, document.text, document.pages);
if ("error" in parsed) {
  console.error(`the reply was refused: ${parsed.error}`);
  writeFileSync(join(outDir, "raw.json"), JSON.stringify(raw, null, 2));
  process.exit(1);
}

const verified = parsed.evidence.filter((item) => item.quote_verified).length;
console.log(
  `parsed        ${parsed.profile.skills.length} skills · ${parsed.profile.experience.length} roles · ` +
    `${parsed.profile.education.length} education · ${parsed.evidence.length} evidence (${verified} quote-verified) · ` +
    `${parsed.dropped} dropped`,
);
console.log(
  `identity      name=${parsed.identity.name ?? "-"} email=${parsed.identity.email ?? "-"} phone=${parsed.identity.phone ?? "-"}`,
);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "raw.json"), JSON.stringify(raw, null, 2));
writeFileSync(join(outDir, "parsed.json"), JSON.stringify(parsed, null, 2));

const seed = `-- Seeds one organization, one recruiter holding jobs.view and jobs.manage, one job and one
-- resume row, as the migration owner, exactly as the RLS harness seeds its own fixtures.
\\set ON_ERROR_STOP on
insert into auth.users (id, email) values (test.uid('smoker'), 'smoker@smoke.test');
insert into public.organizations (id, name, slug) values ('${ORG}', 'Smoke Org', 'smoke');
do $seed$
declare r uuid; m uuid;
begin
  insert into public.roles (organization_id, name) values ('${ORG}', 'Recruiter') returning id into r;
  insert into public.role_permissions (role_id, organization_id, permission_key)
    values (r, '${ORG}', 'jobs.view'), (r, '${ORG}', 'jobs.manage');
  insert into public.organization_memberships (organization_id, user_id)
    values ('${ORG}', test.uid('smoker')) returning id into m;
  insert into public.membership_roles (membership_id, role_id, organization_id) values (m, r, '${ORG}');
end $seed$;
insert into public.jobs (id, organization_id, title) values ('${JOB}', '${ORG}', 'Smoke Role');
insert into public.job_resumes
  (id, organization_id, job_id, storage_path, original_filename, content_type, size_bytes, checksum)
values (
  '${RESUME}', '${ORG}', '${JOB}',
  '${ORG}/${JOB}/resumes/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resume.pdf',
  'resume.pdf', '${contentType}', ${byteLength}, repeat('a', 64)
);
select 'smoke fixture seeded' as result;
`;
writeFileSync(join(outDir, "seed.sql"), seed);

const complete = `-- Persists the result of a real extraction, as the recruiter rather than as the owner, so RLS and
-- the archive guard both apply exactly as they do in the application.
\\set ON_ERROR_STOP on
do $run$
declare
  attempt_id uuid;
  application_id uuid;
begin
  perform test.login('smoker');
  attempt_id := public.start_resume_processing(
    '${ORG}', '${JOB}', '${RESUME}', 'pdf', ${sql(PARSER_VERSION, "pv")},
    ${sql(`${PARSER_VERSION}|${PROFILE_SCHEMA_VERSION}`, "ver")}, now() - interval '1 hour');

  application_id := public.complete_resume_processing(
    '${ORG}', attempt_id,
    ${sql(document.text, "doc")},
    ${document.pageCount},
    ${sql(provider.name, "pn")},
    ${sql(provider.model, "mn")},
    ${sql(JSON.stringify(parsed.profile), "prof")}::jsonb,
    ${sql(JSON.stringify(parsed.evidence), "ev")}::jsonb,
    ${sql(parsed.identity.name, "nm")},
    ${sql(parsed.identity.email, "em")},
    ${sql(parsed.identity.phone, "ph")}
  );

  raise notice 'attempt % application %', attempt_id, application_id;
  assert (select status from public.resume_processings where id = attempt_id)
    in ('succeeded', 'needs_review'), 'the attempt settled';
  assert (select structured_profile from public.resume_processings where id = attempt_id) is not null,
    'the profile was stored';
  assert (select extracted_text from public.resume_processings where id = attempt_id) is not null,
    'and the text it was drawn from';
  assert (select count(*) from public.candidates where organization_id = '${ORG}') = 1,
    'exactly one candidate';
end $run$;

-- Read back as the recruiter, through RLS, which is what the profile page does.
begin;
select test.login('smoker');
select p.status, p.provider, p.model, p.page_count, p.parser, p.processing_version
from public.resume_processings p where p.resume_id = '${RESUME}';
select c.full_name, c.email, c.phone, c.location, c.identity_state
from public.candidates c where c.organization_id = '${ORG}';
select jsonb_array_length(p.structured_profile -> 'skills') as skills,
       jsonb_array_length(p.structured_profile -> 'experience') as roles,
       jsonb_array_length(p.structured_profile -> 'education') as education
from public.resume_processings p where p.resume_id = '${RESUME}';
select e.fact_type, e.fact_key, e.evidence_status, e.quote_verified, e.source_page,
       left(e.source_quote, 48) as quote
from public.candidate_evidence e
join public.resume_processings p on p.id = e.processing_id
where p.resume_id = '${RESUME}'
order by e.fact_type, e.fact_key;
commit;
`;
writeFileSync(join(outDir, "complete.sql"), complete);

console.log(`wrote         ${join(outDir, "seed.sql")}, ${join(outDir, "complete.sql")}`);
console.log(`timings       extraction ${extractMs} ms · provider ${(aiMs / 1000).toFixed(1)} s`);

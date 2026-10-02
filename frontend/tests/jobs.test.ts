// Job domain and wiring checks.
//
// Two kinds, kept distinct. The lifecycle table is real shipping code and is executed directly.
// The permission gating lives in "use server" actions and server components that pull in
// next/headers and a cookie-bound client, so those are pinned structurally - which control is
// behind which key, and that no action trusts the page that rendered it. The database harness is
// what proves the rules themselves; these stop the interface from offering what the database would
// refuse, or hiding what it would allow.
//
//   npm test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  JOB_STATUSES,
  STATUS_TRANSITIONS,
  filterAndSortJobs,
  summariseJobs,
  type Job,
  type JobStatus,
} from "../src/lib/jobs/types.ts";

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const actions = read("../src/app/app/[organizationSlug]/jobs/actions.ts");
const layout = read("../src/app/app/[organizationSlug]/layout.tsx");
const listPage = read("../src/app/app/[organizationSlug]/jobs/page.tsx");
const detailPage = read("../src/app/app/[organizationSlug]/jobs/[jobId]/page.tsx");
const editPage = read("../src/app/app/[organizationSlug]/jobs/[jobId]/edit/page.tsx");
const newPage = read("../src/app/app/[organizationSlug]/jobs/new/page.tsx");

function job(status: JobStatus, openings = 1): Job {
  return {
    id: "x",
    organization_id: "o",
    title: "t",
    description: null,
    status,
    employment_type: null,
    work_mode: null,
    location: null,
    department: null,
    openings,
    application_deadline: null,
    created_by: null,
    created_at: "",
    updated_at: "",
  };
}

test("the lifecycle offers only the moves the database allows", () => {
  assert.deepEqual(STATUS_TRANSITIONS.draft, ["open", "archived"]);
  assert.deepEqual(STATUS_TRANSITIONS.open, ["paused", "closed"]);
  assert.deepEqual(STATUS_TRANSITIONS.paused, ["open", "closed"]);
  assert.deepEqual(STATUS_TRANSITIONS.closed, ["archived"]);
  // Archived is terminal: nothing leads out of it, which is what makes it safe for later phases
  // to hang screening history off an archived job.
  assert.deepEqual(STATUS_TRANSITIONS.archived, []);
});

test("no status reaches another except through a declared transition", () => {
  const declared = new Set(
    JOB_STATUSES.flatMap((from) => STATUS_TRANSITIONS[from].map((to) => `${from}->${to}`)),
  );
  // The moves the product deliberately does not offer, each of which the trigger also refuses.
  for (const forbidden of [
    "draft->paused",
    "draft->closed",
    "open->draft",
    "open->archived",
    "paused->draft",
    "paused->archived",
    "closed->open",
    "closed->draft",
    "archived->open",
    "archived->draft",
  ]) {
    assert.ok(!declared.has(forbidden), `${forbidden} must not be offered`);
  }
  // And every declared target is a real status.
  for (const move of declared) {
    assert.ok((JOB_STATUSES as readonly string[]).includes(move.split("->")[1]));
  }
});

test("the overview counts only what it claims to", () => {
  const summary = summariseJobs([
    job("open", 3),
    job("open", 2),
    job("draft"),
    job("paused"),
    job("closed"),
    job("archived"),
  ]);
  assert.equal(summary.total, 6);
  assert.equal(summary.open, 2);
  assert.equal(summary.draft, 1);
  assert.equal(summary.paused, 1);
  // Openings are the ones actually being hired for, not every opening ever recorded.
  assert.equal(summary.openings, 5);
  assert.deepEqual(summariseJobs([]), {
    total: 0,
    open: 0,
    draft: 0,
    paused: 0,
    openings: 0,
  });
});

test("17: Jobs navigation is behind jobs.view", () => {
  const nav = layout.indexOf("PERMISSIONS.JOBS_VIEW");
  assert.notEqual(nav, -1, "the nav item is permission-gated");
  assert.ok(
    layout.includes('{ href: `${base}/jobs`, label: "Jobs", icon: "jobs" as const }'),
    "and the item it gates is the Jobs route",
  );
  assert.ok(!layout.includes("JOBS_MANAGE"), "seeing jobs is not managing them");
});

test("18 + 19: creating and editing are behind jobs.manage", () => {
  assert.ok(listPage.includes("hasPermission(context, PERMISSIONS.JOBS_MANAGE)"), "the list computes it");
  assert.ok(listPage.includes("canManage && ("), "and the New job action is conditional on it");
  assert.ok(detailPage.includes("canManage &&"), "the detail page gates its controls");
  assert.ok(
    detailPage.includes("canManage && job.status !== \"archived\""),
    "and offers nothing on an archived job",
  );
});

test("20: every job route rejects the unauthorized itself", () => {
  for (const [name, source, permission] of [
    ["list", listPage, "JOBS_VIEW"],
    ["detail", detailPage, "JOBS_VIEW"],
    ["new", newPage, "JOBS_MANAGE"],
    ["edit", editPage, "JOBS_MANAGE"],
  ] as const) {
    assert.ok(source.includes("requireOrganizationAccess"), `${name}: resolves the tenant`);
    assert.ok(
      source.includes(`hasPermission(context, PERMISSIONS.${permission})`),
      `${name}: checks ${permission}`,
    );
    assert.ok(source.includes("notFound()"), `${name}: refuses rather than redirects`);
  }
  // A malformed id is not a job, and never reaches the database as one.
  assert.ok(detailPage.includes("UUID_PATTERN.test(jobId)"), "13: the detail page validates the id");
  assert.ok(editPage.includes("UUID_PATTERN.test(jobId)"), "13: so does the editor");
});

test("every mutation authorizes itself and is scoped to the resolved organization", () => {
  const exported = actions.match(/export async function (\w+)/g) ?? [];
  assert.equal(
    exported.length,
    8,
    "createJob, updateJob, setJobStatus, the four requirement actions and setRequirementWeights",
  );
  // One guard per action, plus the import.
  assert.equal(
    (actions.match(/requireOrganizationActionAccess\(slug\)/g) ?? []).length,
    exported.length,
    "no action trusts the page that rendered it",
  );
  assert.equal(
    (actions.match(/requirePermission\(context, PERMISSIONS\.JOBS_MANAGE\)/g) ?? []).length,
    exported.length,
    "and every one of them requires jobs.manage",
  );
  // The organization is never taken from the form.
  assert.ok(
    !/organization_id:\s*text\(formData/.test(actions),
    "an organization id is never read from the submission",
  );
  assert.ok(
    (actions.match(/\.eq\("organization_id", context\.organization\.id\)/g) ?? []).length >= 4,
    "and every write is scoped to the resolved organization",
  );
  assert.ok(actions.includes("created_by: user.userId"), "the author comes from the session");
});

test("21 + 22: input is validated server-side and success revalidates", () => {
  for (const rule of [
    "Enter a job title.",
    "Number of openings must be a whole number of at least 1.",
    "Enter a valid application deadline.",
    "Weight must be between 0 and 10.",
    "Enter the requirement.",
  ]) {
    assert.ok(actions.includes(rule), `validated: ${rule}`);
  }
  // Raw database wording never reaches the UI; failures go through the sanitized mapping.
  assert.ok(actions.includes("accessErrorMessage("), "database errors are mapped, not shown");
  assert.ok(!/error\.message/.test(actions), "and never surfaced verbatim");

  assert.ok(actions.includes("revalidatePath(`/app/${slug}/jobs`)"), "the list is revalidated");
  assert.ok(actions.includes("revalidatePath(`/app/${slug}`)"), "and the workspace overview with it");
  assert.ok(
    actions.includes("revalidatePath(`/app/${slug}/jobs/${jobId}`)"),
    "and the job that changed",
  );
});

// ---------------------------------------------------------------------------------------------
// Phase 4 completion. Three tests, joining the two added to the SQL harness.
// ---------------------------------------------------------------------------------------------

const editor = read("../src/app/app/[organizationSlug]/jobs/[jobId]/requirements-editor.tsx");

test("completion 3: the list query filters, searches and sorts as the page claims", () => {
  const rows: Job[] = [
    { ...job("open", 2), id: "a", title: "Backend Engineer", department: "Platform", updated_at: "2026-01-02" },
    { ...job("draft"), id: "b", title: "Designer", location: "Berlin", updated_at: "2026-01-03" },
    { ...job("archived"), id: "c", title: "Archived Role", updated_at: "2026-01-04" },
    { ...job("open", 9), id: "d", title: "Analyst", updated_at: "2026-01-01" },
  ];
  const ids = (list: Job[]) => list.map((item) => item.id);

  // Archived is history: absent until it is asked for by name.
  assert.deepEqual(
    ids(filterAndSortJobs(rows, { search: "", status: null, sort: "updated" })),
    ["b", "a", "d"],
    "newest first, archived excluded",
  );
  assert.deepEqual(
    ids(filterAndSortJobs(rows, { search: "", status: "archived", sort: "updated" })),
    ["c"],
    "and present when filtered for",
  );

  // Search covers the three fields the input promises, case-insensitively.
  assert.deepEqual(ids(filterAndSortJobs(rows, { search: "engineer", status: null, sort: "updated" })), ["a"]);
  assert.deepEqual(ids(filterAndSortJobs(rows, { search: "PLATFORM", status: null, sort: "updated" })), ["a"]);
  assert.deepEqual(ids(filterAndSortJobs(rows, { search: "berlin", status: null, sort: "updated" })), ["b"]);
  assert.deepEqual(ids(filterAndSortJobs(rows, { search: "  ", status: null, sort: "updated" })), ["b", "a", "d"]);
  assert.deepEqual(ids(filterAndSortJobs(rows, { search: "nothing", status: null, sort: "updated" })), []);

  assert.deepEqual(ids(filterAndSortJobs(rows, { search: "", status: null, sort: "title" })), ["d", "a", "b"]);
  assert.deepEqual(ids(filterAndSortJobs(rows, { search: "", status: null, sort: "openings" })), ["d", "a", "b"]);
  // Filter and search compose rather than overriding one another.
  assert.deepEqual(ids(filterAndSortJobs(rows, { search: "a", status: "open", sort: "title" })), ["d", "a"]);
});

test("completion 4: reordering is keyboard-reachable and submits the whole order", () => {
  // Dragging is offered, but it is not the only way: the arrows are real buttons with labels.
  assert.ok(editor.includes('draggable={canManage}'), "rows drag only for someone who may reorder");
  assert.ok(editor.includes('aria-label={`Move up: ${requirement.requirement}`}'), "move up is labelled");
  assert.ok(editor.includes('aria-label={`Move down: ${requirement.requirement}`}'), "move down is labelled");
  assert.ok(editor.includes("disabled={index === 0}"), "and the ends are disabled rather than wrapping");
  assert.ok(editor.includes("disabled={index === total - 1}"));

  // The whole order is submitted, not a pair of indices, so the server stores what is on screen.
  assert.ok(editor.includes('name="requirementIds"'), "every id is submitted");
  assert.ok(editor.includes("orderForm.current?.requestSubmit()"), "and saving is automatic");
  // Source is editable, and no control treats a suggested requirement differently.
  assert.ok(editor.includes('name="source"'), "source is an ordinary editable field");
  assert.ok(
    !/source === "ai"[^)]*disabled|disabled[^)]*source === "ai"/.test(editor),
    "nothing is disabled because a requirement was suggested",
  );
});

test("completion 5: the archived state removes every mutation path, and reorder authorizes itself", () => {
  // One flag drives every control, and it is false for an archived job. Requirement editing moved
  // to the rubric page in Phase 6, so that is where the flag now lives — the assertion is the
  // same, pointed at the page that owns the editor.
  const rubricPage = read("../src/app/app/[organizationSlug]/jobs/[jobId]/rubric/page.tsx");
  assert.ok(
    rubricPage.includes('const editable = canManage && job.status !== "archived"'),
    "editing is gated on both permission and a non-archived job",
  );
  assert.ok(
    rubricPage.includes("canManage={editable}"),
    "the requirements editor is read-only on an archived job",
  );
  assert.ok(
    rubricPage.includes("requirements.length > 0 && editable"),
    "and the weight editor is not offered either",
  );
  assert.ok(
    detailPage.includes('canManage &&\n          job.status !== "archived" && ('),
    "and the Edit job link is not offered",
  );
  // STATUS_TRANSITIONS.archived is empty, so the status section renders nothing at all.
  assert.deepEqual(STATUS_TRANSITIONS.archived, [], "and no transition is available");
  assert.ok(editPage.includes('job.status === "archived"'), "the editor route refuses directly too");

  // Reorder is a mutation and is guarded exactly like the others.
  assert.ok(actions.includes("export async function reorderRequirements"), "the action exists");
  const reorder = actions.slice(actions.indexOf("export async function reorderRequirements"));
  assert.ok(reorder.includes("requirePermission(context, PERMISSIONS.JOBS_MANAGE)"), "and requires jobs.manage");
  assert.ok(reorder.includes("target_organization_id: context.organization.id"), "scoped server-side");
  assert.ok(reorder.includes("UUID_PATTERN.test(id)"), "every submitted id is checked");
  assert.ok(reorder.includes("new Set(orderedIds).size !== orderedIds.length"), "and duplicates refused");
});

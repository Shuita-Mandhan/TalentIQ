// The screening rubric: readiness and the weight arithmetic that decides it.
//
// Readiness is derived from the rows, never stored, so it is a pure function and is exercised
// directly. The second test pins the wiring — that the rubric reads the approved requirements
// rather than copying them, and that nothing adjusts a weight unless a person asked.
//
//   npm test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  RUBRIC_TOTAL,
  balanceWeights,
  summariseRubric,
  type Importance,
  type JobRequirement,
} from "../src/lib/jobs/types.ts";

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const rubricPage = read("../src/app/app/[organizationSlug]/jobs/[jobId]/rubric/page.tsx");
const weightsForm = read("../src/app/app/[organizationSlug]/jobs/[jobId]/rubric/weights-form.tsx");
const jobActions = read("../src/app/app/[organizationSlug]/jobs/actions.ts");

let counter = 0;
function requirement(weight: number, importance: Importance = "required"): JobRequirement {
  counter += 1;
  return {
    id: `r${counter}`,
    organization_id: "o",
    job_id: "j",
    category: "skill",
    requirement: `Requirement ${counter}`,
    importance,
    weight,
    source: "manual",
    display_order: counter,
  };
}

test("phase 6 new test 4: a rubric is ready only at exactly 100", () => {
  // Nothing at all.
  const empty = summariseRubric([]);
  assert.equal(empty.readiness, "empty");
  assert.equal(empty.totalWeight, 0);
  assert.ok(empty.issues.some((issue) => issue.includes("no requirements")));

  // Short.
  const under = summariseRubric([requirement(40), requirement(35)]);
  assert.equal(under.readiness, "incomplete");
  assert.equal(under.totalWeight, 75);
  assert.ok(under.issues.some((issue) => issue.includes("25 short of 100")));

  // Over — and never shown as ready for having "enough" points.
  const over = summariseRubric([requirement(60), requirement(55)]);
  assert.equal(over.readiness, "incomplete");
  assert.equal(over.totalWeight, 115);
  assert.ok(over.issues.some((issue) => issue.includes("15 over 100")));

  // Exactly 100, across both importances.
  const ready = summariseRubric([
    requirement(50),
    requirement(20, "preferred"),
    requirement(30),
  ]);
  assert.equal(ready.readiness, "ready");
  assert.equal(ready.totalWeight, RUBRIC_TOTAL);
  assert.deepEqual(ready.issues, [], "a ready rubric has nothing to say");
  assert.deepEqual(ready.warnings, [], "and nothing to flag either");
  assert.equal(ready.required, 2);
  assert.equal(ready.preferred, 1);
  assert.equal(ready.requiredWeight, 80);
  assert.equal(ready.preferredWeight, 20);

  // Fractions must not drift the total: 33.33 + 33.33 + 33.34 is a hundred, not 99.99999.
  const fractional = summariseRubric([requirement(33.33), requirement(33.33), requirement(33.34)]);
  assert.equal(fractional.totalWeight, 100);
  assert.equal(fractional.readiness, "ready");

  // A requirement carrying nothing is called out, not quietly fixed — and not treated as a defect
  // either. Zero is a legal weight, so this is advice, and advice must not contradict the verdict:
  // the rubric totals 100, so it is ready, and the only thing said about the zero is a warning.
  const weightless = summariseRubric([requirement(100), requirement(0)]);
  assert.equal(weightless.totalWeight, 100);
  assert.ok(weightless.warnings.some((warning) => warning.includes("no weight")));
  assert.deepEqual(weightless.issues, [], "a warning is not a reason to withhold readiness");
  assert.equal(weightless.readiness, "ready", "and the verdict agrees with the empty issue list");

  // The invariant behind all of the above, stated once over every case in this test: issues and
  // readiness are the same judgement, so the UI can never show "Ready" beside a blocking issue.
  for (const summary of [empty, under, over, ready, fractional, weightless]) {
    assert.equal(
      summary.issues.length === 0,
      summary.readiness === "ready",
      `issues and readiness disagree at total ${summary.totalWeight}`,
    );
  }
});

test("phase 6 new test 5: the rubric reads requirements and never reweights them unasked", () => {
  // summariseRubric is a reading. It returns the same numbers it was given, every time.
  const rows = [requirement(20), requirement(20), requirement(20)];
  const before = rows.map((row) => row.weight);
  const summary = summariseRubric(rows);
  assert.equal(summary.totalWeight, 60, "60 stays 60 — it is not scaled up to 100");
  assert.deepEqual(rows.map((row) => row.weight), before, "and the rows themselves are untouched");

  // balanceWeights is the explicit opt-in, and it returns a proposal rather than mutating.
  const balanced = balanceWeights(rows);
  assert.deepEqual(rows.map((row) => row.weight), before, "balancing does not write to the rows");
  assert.equal(
    balanced.reduce((total, item) => total + Math.round(item.weight * 100), 0),
    RUBRIC_TOTAL * 100,
    "and totals exactly 100 with no rounding drift",
  );
  // Three equal weights divide evenly enough that the remainder has to land somewhere explicit.
  assert.equal(balanceWeights([requirement(1), requirement(1), requirement(1)])
    .reduce((total, item) => total + Math.round(item.weight * 100), 0), RUBRIC_TOTAL * 100);
  // Proportions are preserved: twice the weight, twice the share.
  const proportional = balanceWeights([requirement(10), requirement(20), requirement(10)]);
  assert.equal(proportional[1].weight, 50);
  assert.equal(proportional[0].weight, 25);
  assert.deepEqual(balanceWeights([]), [], "and nothing to balance is nothing to do");

  // The page is a reader: it fetches the approved requirements and creates nothing.
  assert.ok(rubricPage.includes("getJobRequirements("), "the rubric reads job_requirements");
  assert.ok(rubricPage.includes("summariseRubric(requirements)"), "and derives readiness from them");
  assert.ok(
    !/\.insert\(|\.upsert\(/.test(rubricPage),
    "opening the rubric writes nothing — no shadow copy is created",
  );
  assert.ok(
    rubricPage.includes("RequirementsEditor"),
    "and it reuses the existing editor rather than a second one",
  );
  // Balancing is a deliberate press, never automatic.
  assert.ok(weightsForm.includes("Balance to"), "the control is named");
  assert.ok(weightsForm.includes('type="button"'), "and is a button, not a side effect of saving");
  assert.ok(
    !/useEffect[\s\S]{0,200}balanceWeights/.test(weightsForm),
    "nothing balances on its own",
  );

  // The weights mutation authorizes itself and is scoped server-side like every other.
  const weights = jobActions.slice(jobActions.indexOf("export async function setRequirementWeights"));
  assert.ok(weights.includes("requirePermission(context, PERMISSIONS.JOBS_MANAGE)"), "jobs.manage required");
  assert.ok(weights.includes("target_organization_id: context.organization.id"), "organization resolved server-side");
  assert.ok(weights.includes("UUID_PATTERN.test(id)"), "every id is checked");
  assert.ok(weights.includes("accessErrorMessage("), "and failures are sanitized");
});

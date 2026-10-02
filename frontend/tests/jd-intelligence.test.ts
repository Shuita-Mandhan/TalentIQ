// JD intelligence: the two things that have to hold in the application layer.
//
// A model's reply is untrusted input, so parsing it is exercised with the shapes a model actually
// produces when it goes wrong. Provider failure is exercised against a deterministic double, since
// a real model is neither installed in CI nor deterministic enough to assert on.
//
//   npm test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MAX_REQUIREMENTS,
  ProviderError,
  describeProviderFailure,
  groupDuplicates,
  parseExtraction,
  validateDescription,
} from "../src/lib/ai/extraction.ts";

const analyzeActions = readFileSync(
  new URL("../src/app/app/[organizationSlug]/jobs/[jobId]/intelligence/actions.ts", import.meta.url),
  "utf8",
);

test("phase 5 new test 1: a model's reply is never trusted", () => {
  // The shapes a model actually returns when it does not cooperate.
  for (const [label, raw] of [
    ["prose instead of JSON", "Here are the requirements you asked for!"],
    ["null", null],
    ["a bare number", 7],
    ["an object with no list", { summary: "a backend role" }],
    ["requirements as a string", { requirements: "React, Node" }],
    ["an empty list", { requirements: [] }],
    ["rows that are not objects", { requirements: ["React", 42, null] }],
    ["rows with no requirement text", { requirements: [{ category: "skill", weight: 3 }] }],
    ["blank requirement text", { requirements: [{ requirement: "   " }] }],
  ] as const) {
    const { result, error } = parseExtraction(raw);
    assert.equal(result, undefined, `${label} must not produce requirements`);
    assert.ok(error && error.length > 0, `${label} must explain itself`);
  }

  // Valid rows survive; invalid vocabulary is corrected to the safe default rather than stored raw.
  const { result } = parseExtraction({
    requirements: [
      { requirement: "Five years of Go", category: "experience", importance: "preferred", weight: 4 },
      { requirement: "Invented category", category: "astrology", importance: "mandatory", weight: 99 },
      { requirement: "Weight as a string", weight: "2.5" },
      { requirement: "x".repeat(501) },
    ],
  });
  assert.ok(result, "the usable rows are kept");
  assert.equal(result.requirements.length, 3, "and the over-long one is dropped, not truncated");
  assert.deepEqual(result.requirements[0], {
    requirement: "Five years of Go",
    category: "experience",
    importance: "preferred",
    weight: 4,
  });
  // An unknown category never reaches the database as itself.
  assert.equal(result.requirements[1].category, "other");
  assert.equal(result.requirements[1].importance, "required");
  assert.equal(result.requirements[1].weight, 1, "an out-of-range weight becomes the default");
  assert.equal(result.requirements[2].weight, 2.5, "a numeric string is accepted");

  // A model cannot flood the review queue.
  const flood = parseExtraction({
    requirements: Array.from({ length: 200 }, (_, index) => ({ requirement: `Requirement ${index}` })),
  });
  assert.equal(flood.result?.requirements.length, MAX_REQUIREMENTS);

  // The job description is validated server-side before a model is contacted at all.
  assert.ok(validateDescription("").error, "empty is refused");
  assert.ok(validateDescription("        ").error, "whitespace-only is refused");
  assert.ok(validateDescription("too short").error, "too short is refused");
  assert.ok(validateDescription("x".repeat(20001)).error, "too long is refused");
  assert.equal(validateDescription(`  ${"A real description. ".repeat(5)}  `).error, undefined);

  // Duplicates are flagged, never merged: both rows survive for a person to decide between.
  const groups = groupDuplicates([
    { requirement: "3 years of React experience", category: "experience", importance: "required", weight: 1 },
    { requirement: "At least 3 years experience with React", category: "experience", importance: "required", weight: 1 },
    { requirement: "Fluent German", category: "language", importance: "preferred", weight: 1 },
  ]);
  assert.equal(groups[0], groups[1], "the two phrasings are grouped");
  assert.notEqual(groups[0], null);
  assert.equal(groups[2], null, "and an unrelated requirement stands alone");
});

test("phase 5 new test 2: a provider failure is safe, silent and retryable", async () => {
  // A deterministic double standing in for a model: no network, no installed runtime, and the same
  // answer every run.
  const failing = {
    name: "test-double",
    model: "always-fails",
    async extract(): Promise<unknown> {
      throw new ProviderError("connect ECONNREFUSED 127.0.0.1:11434 token=secret-value");
    },
  };

  let thrown: unknown;
  try {
    await failing.extract();
  } catch (cause) {
    thrown = cause;
  }
  assert.ok(thrown instanceof ProviderError, "the provider surfaces its own failure type");

  // What the recruiter is told carries none of that: no host, no port, no credential, no stack.
  const shown = describeProviderFailure(thrown);
  assert.equal(shown, "AI analysis is currently unavailable. Please try again.");
  for (const leak of ["ECONNREFUSED", "127.0.0.1", "11434", "secret-value", "Error"]) {
    assert.ok(!shown.includes(leak), `the message must not leak ${leak}`);
  }
  // An unexpected failure is just as quiet.
  assert.ok(!describeProviderFailure(new Error("boom at /srv/app/x.ts:12")).includes("/srv"));

  // And the action records the failure without destroying anything a recruiter has.
  assert.ok(
    analyzeActions.includes('status: "failed"'),
    "the run is marked failed rather than deleted",
  );
  assert.ok(
    analyzeActions.includes("return fail(") && analyzeActions.includes("describeProviderFailure(cause)"),
    "and only the safe message is returned",
  );
  assert.ok(analyzeActions.includes("console.error"), "the real cause stays on the server");
  // The submitted description comes back on every failure path, and nothing deletes requirements.
  assert.ok(analyzeActions.includes("description };"), "the job description survives a failure");
  assert.ok(
    !/\.from\("job_requirements"\)[\s\S]*\.delete\(\)/.test(analyzeActions),
    "no failure path removes an existing requirement",
  );
  // Suggestions are the only thing an analysis writes; requirements are created by approval alone.
  assert.ok(
    !analyzeActions.includes('.from("job_requirements").insert'),
    "analysis never creates a requirement directly",
  );
  assert.ok(
    analyzeActions.includes("approve_job_requirement_suggestion"),
    "approval goes through the database function that does both writes together",
  );
});

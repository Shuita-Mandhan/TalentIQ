// Structural guards on how the reset-password action is wired.
//
// These read the source rather than running it: the action is a "use server" entrypoint that pulls
// in next/navigation and a cookie-bound Supabase client, so it cannot be driven directly here. The
// behaviour it delegates is covered for real in account-setup.test.ts; what is left to pin is
// which branch reaches which step, and that no second password form survives on the setup path.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const action = readFileSync(new URL("../src/app/reset-password/actions.ts", import.meta.url), "utf8");
const inviteAction = readFileSync(
  new URL("../src/app/invite/[invitationId]/actions.ts", import.meta.url),
  "utf8",
);

/** Asserts the marker is present exactly once and returns where, so a rename fails loudly. */
function onlyIndex(source: string, marker: string, label: string): number {
  const first = source.indexOf(marker);
  assert.notEqual(first, -1, `${label}: expected to find ${marker}`);
  assert.equal(source.indexOf(marker, first + 1), -1, `${label}: expected ${marker} exactly once`);
  return first;
}

test("the recovery continuation never hands off to a second password page", () => {
  assert.ok(!action.includes("/invite/"), "setup finishes where it starts, not on /invite");
  assert.ok(action.includes("redirect(`/app/${outcome.organizationSlug}`)"), "it ends in the workspace");
});

test("acceptance is reachable only from the continuation branch", () => {
  const branch = onlyIndex(action, "if (invitationId) {", "continuation branch");
  const accept = onlyIndex(action, "accept_organization_invitation", "acceptance RPC");
  // The plain recovery path begins at its own password update, after the branch has closed.
  const plainPath = onlyIndex(action, "const { error } = await supabase.auth.updateUser", "plain path");

  assert.ok(branch < accept, "acceptance sits inside the continuation branch");
  assert.ok(accept < plainPath, "and before the path taken when there is no continuation");
});

test("the invitation is loaded through the existing recipient-side helper", () => {
  const load = onlyIndex(action, "loadInvitation: (id) => getMyInvitation(id)", "invitation read");
  const setPassword = onlyIndex(action, "setPassword: async", "password step");
  // Ordering inside the orchestrator is what enforces this; the wiring must supply the real read.
  assert.ok(action.includes('from "@/lib/organization/invitation"'));
  assert.ok(load < setPassword, "the read is wired ahead of the write");
});

test("only the plain recovery path signs out globally", () => {
  const others = onlyIndex(action, 'signOut({ scope: "others" })', "scoped sign-out");
  const global = onlyIndex(action, 'signOut({ scope: "global" })', "global sign-out");
  const plainPath = onlyIndex(action, "const { error } = await supabase.auth.updateUser", "plain path");

  assert.ok(others < plainPath, "the setup path revokes other sessions only");
  assert.ok(plainPath < global, "the global sign-out belongs to the path with no continuation");
});

test("the first-time invitation path still sets its own password and accepts", () => {
  // Someone opening a fresh invite has never been through recovery, so /invite keeps both steps.
  assert.ok(inviteAction.includes("supabase.auth.updateUser({ password })"));
  assert.ok(inviteAction.includes("accept_organization_invitation"));
});

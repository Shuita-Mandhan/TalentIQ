// Behavioural checks for the invited-account setup path.
//
// The orchestrator takes its steps as arguments, so these drive the real sequencing code with
// recording fakes: the order below is what actually runs, not a reading of it.
//
//   npm test

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completeInvitedAccountSetup,
  type AccountSetupSteps,
} from "../src/lib/organization/account-setup.ts";

const ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const PASSWORD = "a-good-enough-password";

type Recorded = { calls: string[]; steps: AccountSetupSteps };

function steps(
  overrides: {
    invitation?: unknown | null;
    passwordAccepted?: boolean;
    acceptedSlug?: string | null;
  } = {},
): Recorded {
  const {
    invitation = { id: ID, organization_slug: "acme" },
    passwordAccepted = true,
    acceptedSlug = "acme",
  } = overrides;
  const calls: string[] = [];

  return {
    calls,
    steps: {
      loadInvitation: async (id) => {
        assert.equal(id, ID, "the invitation is looked up by the validated id");
        calls.push("load");
        return invitation;
      },
      setPassword: async (value) => {
        assert.equal(value, PASSWORD);
        calls.push("password");
        return passwordAccepted;
      },
      revokeOtherSessions: async () => {
        calls.push("revoke-others");
      },
      acceptInvitation: async (id) => {
        assert.equal(id, ID);
        calls.push("accept");
        return acceptedSlug;
      },
    },
  };
}

test("the invitation is proved before anything is changed, and joining needs no second password", async () => {
  const { calls, steps: s } = steps();
  const outcome = await completeInvitedAccountSetup(s, ID, PASSWORD);

  // One password, then acceptance, in that order and in one submit.
  assert.deepEqual(calls, ["load", "password", "revoke-others", "accept"]);
  assert.deepEqual(outcome, { status: "joined", organizationSlug: "acme" });
});

test("an unavailable invitation costs the recipient nothing", async () => {
  // Revoked, already accepted, or addressed to somebody else: the database returns none of them.
  const { calls, steps: s } = steps({ invitation: null });
  const outcome = await completeInvitedAccountSetup(s, ID, PASSWORD);

  assert.deepEqual(calls, ["load"], "no password change and no acceptance attempt");
  assert.deepEqual(outcome, { status: "unavailable" });
});

test("acceptance is never attempted unless the password was actually set", async () => {
  const { calls, steps: s } = steps({ passwordAccepted: false });
  const outcome = await completeInvitedAccountSetup(s, ID, PASSWORD);

  assert.deepEqual(calls, ["load", "password"]);
  assert.ok(!calls.includes("accept"), "a rejected password grants no membership");
  assert.deepEqual(outcome, { status: "password-rejected" });
});

test("a failed acceptance leaves the password set and the invitation retryable", async () => {
  const { calls, steps: s } = steps({ acceptedSlug: null });
  const outcome = await completeInvitedAccountSetup(s, ID, PASSWORD);

  assert.deepEqual(outcome, { status: "not-joined" });
  // Nothing after the password change may undo it: the only steps that ran are the ones above.
  assert.deepEqual(calls, ["load", "password", "revoke-others", "accept"]);
  assert.ok(calls.indexOf("password") < calls.indexOf("accept"), "the password is set first");

  // Acceptance is idempotent, so resubmitting the same form is the retry - not a second password
  // page. A repeat run reaches acceptance again and joins.
  const retry = steps();
  assert.deepEqual(await completeInvitedAccountSetup(retry.steps, ID, PASSWORD), {
    status: "joined",
    organizationSlug: "acme",
  });
});

test("the current session is never globally revoked on this path", async () => {
  const { calls, steps: s } = steps();
  await completeInvitedAccountSetup(s, ID, PASSWORD);

  // Only other sessions are dropped, and only after the password is set - this session has to
  // survive to carry the recipient into the workspace they just joined.
  assert.ok(calls.includes("revoke-others"));
  assert.ok(calls.indexOf("password") < calls.indexOf("revoke-others"));
  assert.ok(calls.indexOf("revoke-others") < calls.indexOf("accept"));
});

// Continuation-validator checks for the invited-account setup link.
//
// The recovery email leaves the server carrying an invitation id and comes back through the
// browser, so the id is the one thing on that round trip an attacker can edit. Everything here
// pins the rule that it is accepted only as a bare UUID and that the destination is assembled
// from it rather than taken from it.
//
//   npm test
//
// Node's own runner with native TypeScript type stripping; no test framework is installed.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  invitationContinuation,
  inviteContinuationPath,
  inviteDestination,
  recoveryDestination,
} from "../src/lib/auth/invite-redirect.ts";

const ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const APP_URL = "https://app.talentiq.test";

test("a pending invitation id becomes exactly one invitation path", () => {
  assert.equal(inviteContinuationPath(ID), `/invite/${ID}`);
  assert.equal(invitationContinuation(ID), ID);
});

test("an id is canonicalized rather than reflected", () => {
  assert.equal(inviteContinuationPath(ID.toUpperCase()), `/invite/${ID}`);
});

test("an absolute URL is rejected, including one on the deployment's own origin", () => {
  assert.equal(inviteContinuationPath(`${APP_URL}/invite/${ID}`), null);
  assert.equal(inviteContinuationPath(`https://evil.test/invite/${ID}`), null);
  assert.equal(inviteContinuationPath(`https://evil.test/${ID}`), null);
  assert.equal(inviteContinuationPath(`//evil.test/${ID}`), null);
  assert.equal(inviteContinuationPath(`javascript:alert(1)//${ID}`), null);
});

test("an attacker-controlled relative path is rejected", () => {
  assert.equal(inviteContinuationPath(`/invite/${ID}`), null);
  assert.equal(inviteContinuationPath(`/platform`), null);
  assert.equal(inviteContinuationPath(`${ID}/../../platform`), null);
  assert.equal(inviteContinuationPath(`../${ID}`), null);
  assert.equal(inviteContinuationPath(`${ID}/`), null);
});

test("query and fragment tricks are rejected", () => {
  assert.equal(inviteContinuationPath(`${ID}?next=https://evil.test`), null);
  assert.equal(inviteContinuationPath(`${ID}&invite=${OTHER}`), null);
  assert.equal(inviteContinuationPath(`${ID}#/platform`), null);
  assert.equal(inviteContinuationPath(`${ID}%2F..%2Fplatform`), null);
  assert.equal(inviteContinuationPath(`${ID}\n${OTHER}`), null);
});

test("a malformed id is rejected", () => {
  assert.equal(inviteContinuationPath("not-a-uuid"), null);
  assert.equal(inviteContinuationPath(ID.slice(0, -1)), null);
  assert.equal(inviteContinuationPath(`${ID}0`), null);
  assert.equal(inviteContinuationPath(ID.replace("-", "")), null);
  assert.equal(inviteContinuationPath(` ${ID} `), null);
  assert.equal(inviteContinuationPath("1b9d6bcz-bbfd-4b2d-9b5d-ab8dfbbd4bed"), null);
});

test("anything that is not a single string is rejected", () => {
  // A repeated query parameter arrives as an array, which must not be coerced into a destination.
  assert.equal(inviteContinuationPath([ID, OTHER]), null);
  assert.equal(inviteContinuationPath([ID]), null);
  assert.equal(inviteContinuationPath({ toString: () => ID }), null);
  assert.equal(inviteContinuationPath(null), null);
  assert.equal(inviteContinuationPath(undefined), null);
  assert.equal(inviteContinuationPath(""), null);
});

test("an ordinary recovery carries no continuation, so the normal flow is unchanged", () => {
  // What /auth/callback and the reset-password action see when forgot-password sent the email:
  // no `invite` parameter and no hidden field, which must stay a plain password reset.
  assert.equal(invitationContinuation(new URLSearchParams("next=/reset-password").get("invite")), null);
  assert.equal(inviteContinuationPath(new FormData().get("invitationId")), null);
});

test("the invitation email's own redirect validation is unchanged", () => {
  assert.equal(inviteDestination(`${APP_URL}/invite/${ID}`, APP_URL), `/invite/${ID}`);
  assert.equal(inviteDestination(`https://evil.test/invite/${ID}`, APP_URL), null);
  assert.equal(inviteDestination(`${APP_URL}/invite/${ID}?x=1`, APP_URL), null);
  assert.equal(inviteDestination(`${APP_URL}/platform`, APP_URL), null);
  assert.equal(inviteDestination(`${APP_URL}/invite/${ID}`, undefined), null);
  assert.equal(inviteDestination(null, APP_URL), null);
});

test("a recovery link resolves to the reset screen, with or without a continuation", () => {
  assert.equal(recoveryDestination(`${APP_URL}/reset-password`, APP_URL), "/reset-password");
  assert.equal(
    recoveryDestination(`${APP_URL}/reset-password?invite=${ID}`, APP_URL),
    `/reset-password?invite=${ID}`,
  );
  assert.equal(
    recoveryDestination(`${APP_URL}/reset-password?invite=${ID.toUpperCase()}`, APP_URL),
    `/reset-password?invite=${ID}`,
  );
});

test("a recovery link off the trusted origin is rejected", () => {
  assert.equal(recoveryDestination(`https://evil.test/reset-password`, APP_URL), null);
  assert.equal(recoveryDestination(`http://app.talentiq.test/reset-password`, APP_URL), null);
  assert.equal(recoveryDestination(`${APP_URL}:8443/reset-password`, APP_URL), null);
  assert.equal(recoveryDestination(`https://user:pw@app.talentiq.test/reset-password`, APP_URL), null);
  assert.equal(recoveryDestination(`${APP_URL}/reset-password`, undefined), null);
  assert.equal(recoveryDestination(null, APP_URL), null);
});

test("a recovery link may not name any other page", () => {
  assert.equal(recoveryDestination(`${APP_URL}/platform`, APP_URL), null);
  assert.equal(recoveryDestination(`${APP_URL}/reset-password/../platform`, APP_URL), null);
  assert.equal(recoveryDestination(`${APP_URL}/reset-password/x`, APP_URL), null);
  assert.equal(recoveryDestination(`${APP_URL}/invite/${ID}`, APP_URL), null);
});

test("the continuation is the only parameter a recovery link may carry", () => {
  assert.equal(recoveryDestination(`${APP_URL}/reset-password?next=/platform`, APP_URL), null);
  assert.equal(recoveryDestination(`${APP_URL}/reset-password?invite=${ID}&next=/platform`, APP_URL), null);
  // A repeated parameter is refused outright rather than resolved to one of its values.
  assert.equal(recoveryDestination(`${APP_URL}/reset-password?invite=${ID}&invite=${OTHER}`, APP_URL), null);
  assert.equal(recoveryDestination(`${APP_URL}/reset-password?invite=nope`, APP_URL), null);
  assert.equal(recoveryDestination(`${APP_URL}/reset-password?invite=`, APP_URL), null);
  assert.equal(recoveryDestination(`${APP_URL}/reset-password#/platform`, APP_URL), null);
  assert.equal(recoveryDestination(`${APP_URL}/reset-password?invite=${ID}#/platform`, APP_URL), null);
});

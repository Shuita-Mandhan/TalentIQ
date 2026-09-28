// Structural guards on who sends the recovery emails.
//
// Both senders must be session-less. A recovery link verifies server-side through /auth/confirm
// precisely so it can be opened on another device, in another browser, or after the requesting
// browser's storage is gone - and that only holds while no sender writes PKCE state into whichever
// browser happened to ask. @supabase/ssr hard-codes flowType "pkce", so the request-scoped client
// is exactly what must not appear beside resetPasswordForEmail.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const mailer = read("../src/lib/supabase/mailer.ts");
const forgotPassword = read("../src/app/forgot-password/actions.ts");
const members = read("../src/app/app/[organizationSlug]/members/actions.ts");

const SENDERS: [string, string][] = [
  ["forgot-password", forgotPassword],
  ["members resend", members],
];

test("every recovery email is sent from the session-less mailer", () => {
  for (const [label, source] of SENDERS) {
    const send = source.indexOf("resetPasswordForEmail");
    assert.notEqual(send, -1, `${label}: expected a recovery send`);
    assert.ok(
      source.includes("createMailerClient().auth.resetPasswordForEmail"),
      `${label}: the send must go through createMailerClient`,
    );
    assert.ok(
      source.includes('from "@/lib/supabase/mailer"'),
      `${label}: expected the mailer import`,
    );
  }
});

test("no recovery send goes through the request-scoped PKCE client", () => {
  for (const [label, source] of SENDERS) {
    assert.ok(
      !/(?:supabase|createClient\(\))[^\n]*\.auth\.resetPasswordForEmail/.test(source),
      `${label}: a cookie-bound client must never send a recovery email`,
    );
  }

  // forgot-password has no other use for a request-scoped client, so it should not import one.
  assert.ok(
    !forgotPassword.includes("@/lib/supabase/server"),
    "forgot-password no longer needs the request-scoped client at all",
  );
});

test("the confirmed-pending resend is the branch that uses the mailer", () => {
  const branch = members.indexOf("if (invitation.recipient_confirmed) {");
  const send = members.indexOf("createMailerClient().auth.resetPasswordForEmail");
  assert.notEqual(branch, -1, "expected the confirmed-recipient branch");
  assert.ok(branch < send, "the setup link is sent inside that branch");
  // The unconfirmed branch keeps the ordinary invitation, which is a different mechanism.
  assert.ok(members.includes("inviteUserByEmail"), "first-time invitations are unchanged");
});

test("the mailer holds no secret and keeps no session", () => {
  assert.ok(!mailer.includes("SUPABASE_SECRET_KEY"), "no secret key");
  assert.ok(!/SERVICE_ROLE|service_role/.test(mailer), "no service role key");
  assert.ok(mailer.includes("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), "publishable key only");
  assert.ok(mailer.includes('import "server-only"'), "never reachable from the browser");
  for (const option of ["persistSession: false", "autoRefreshToken: false", "detectSessionInUrl: false"]) {
    assert.ok(mailer.includes(option), `expected ${option}`);
  }
  // It must not be built on @supabase/ssr, which would reintroduce cookies and PKCE.
  assert.ok(!mailer.includes("@supabase/ssr"), "not a cookie-bound client");
  assert.ok(mailer.includes('from "@supabase/supabase-js"'));
});

import "server-only";
import { createClient } from "@supabase/supabase-js";

// A session-less client for asking Supabase Auth to send an email to somebody other than the
// caller. It carries no cookies and no secret - the publishable key is all the recovery endpoint
// needs - and it is deliberately not the caller's client: a link only the recipient will ever open
// must not leave a PKCE verifier behind in the sender's browser, where it could never be used and
// would occupy a slot belonging to the sender's own flows. The email itself verifies server-side
// through /auth/confirm, so it works in whichever browser the recipient happens to open it in.
export function createMailerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } },
  );
}

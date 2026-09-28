import { NextResponse } from "next/server";
import { inviteDestination, recoveryDestination } from "@/lib/auth/invite-redirect";
import { createClient } from "@/lib/supabase/server";

// SSR verification for the emails that carry someone into the application (Supabase's documented
// token_hash pattern). The template forwards Supabase's own `redirect_to`, which is the absolute
// URL the application passed when it asked for the email, so it is validated against trusted
// deployment configuration rather than treated as an opaque destination.
//
// Verifying here rather than through the PKCE callback is what makes these links work in a
// different browser from the one that asked for them: the session is established from the token
// alone, with no code verifier held in anyone's cookies. That matters for the setup link an
// administrator sends on someone else's behalf, which is never opened in the sender's browser.

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const redirectTo = searchParams.get("redirect_to");
  const appUrl = process.env.APP_URL;

  // A spent or tampered link returns to the screen that can issue a fresh one.
  let next = type === "recovery" ? "/forgot-password?error=invalid-link" : "/login?error=invalid-link";

  // The destination is resolved before the token is spent, so an unusable link never consumes one.
  const destination =
    type === "invite"
      ? inviteDestination(redirectTo, appUrl)
      : type === "recovery"
        ? recoveryDestination(redirectTo, appUrl)
        : null;

  if (tokenHash && destination && (type === "invite" || type === "recovery")) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    // Redirecting drops token_hash from the address bar; only the session cookies survive.
    if (!error) next = destination;
  }

  return NextResponse.redirect(new URL(next, origin), {
    headers: {
      "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

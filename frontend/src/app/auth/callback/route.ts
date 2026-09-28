import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// The PKCE callback. Recovery emails now verify server-side through /auth/confirm, which works in
// any browser rather than only the one that asked for the link, so this route serves nothing but
// emails that were already in flight when that template changed. It can go once none remain.

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const flowId = searchParams.get("sb_flow_id");
  let destination = "/forgot-password?error=invalid-link";

  // `next` is compared for exact equality: the only destination this callback may reach is the
  // password reset screen, so a tampered link can never redirect elsewhere.
  if (code && searchParams.get("next") === "/reset-password") {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(
      code,
      flowId ? { flowId } : undefined,
    );
    if (!error) destination = "/reset-password";
  }

  // The redirect carries freshly written auth cookies and must never be cached.
  return NextResponse.redirect(new URL(destination, origin), {
    headers: {
      "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

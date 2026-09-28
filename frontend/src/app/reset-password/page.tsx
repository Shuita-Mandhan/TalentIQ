import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/layout/auth-shell";
import { invitationContinuation } from "@/lib/auth/invite-redirect";
import { getMyInvitation } from "@/lib/organization/invitation";
import { createClient } from "@/lib/supabase/server";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/forgot-password?error=invalid-link");

  // Present only when an administrator sent a setup link for a pending invitation. The id is a
  // hint and nothing more: the database returns the invitation only to the account it was
  // addressed to, so an invitation that is not this caller's reads as none at all and the ordinary
  // recovery screen is shown instead. Someone with a valid recovery session can always set a
  // password, whether or not the invitation beside it is still good.
  const invitationId = invitationContinuation((await searchParams).invite);
  const invitation = invitationId ? await getMyInvitation(invitationId) : null;

  return (
    <AuthShell>
      <h1 className="text-2xl font-semibold tracking-tight text-balance">
        {invitation ? `Set your password to join ${invitation.organization_name}` : "Choose a new password"}
      </h1>
      <p className="mt-2 text-sm text-pretty text-muted-foreground">
        {invitation ? (
          <>
            Choose a password for <span className="font-mono break-all">{invitation.email}</span>{" "}
            and you will join {invitation.organization_name} straight away. Your administrator
            assigns your roles once you join.
          </>
        ) : (
          "Create a new password for your account."
        )}
      </p>
      <div className="mt-8">
        <ResetPasswordForm invitationId={invitation?.id ?? null} />
      </div>
    </AuthShell>
  );
}

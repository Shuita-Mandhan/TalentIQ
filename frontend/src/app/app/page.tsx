import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserContext } from "@/lib/auth/organization-context";
import { getMyPendingInvitations } from "@/lib/organization/invitation";
import { Brand } from "@/components/layout/brand";
import { SignOutButton } from "@/components/layout/sign-out-button";
import { StatusDot } from "@/components/ui/status-dot";

export const metadata: Metadata = { title: "Workspaces" };

export default async function AppPage() {
  const user = await getUserContext();
  if (!user) redirect("/login");
  if (user.organizations.length === 1) redirect(`/app/${user.organizations[0].slug}`);

  // Recovery for someone who confirmed their invitation email but never finished setting up: they
  // are not a member yet, so their own pending invitations are how they get back into the flow.
  const invitations = user.organizations.length === 0 ? await getMyPendingInvitations() : [];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 sm:px-10">
      <header className="flex items-center justify-between gap-4 py-8">
        <Brand />
        <div className="flex items-center gap-4">
          {user.isPlatformAdmin && (
            <Link
              href="/platform"
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Platform
            </Link>
          )}
          <SignOutButton />
        </div>
      </header>

      <main className="flex flex-1 flex-col justify-center py-16">
        {user.organizations.length === 0 ? (
          <>
            <p className="flex animate-rise items-center gap-3 text-sm font-medium text-accent motion-reduce:animate-none">
              <StatusDot />
              Signed in as {user.email}
            </p>
            <h1
              style={{ animationDelay: "80ms" }}
              className="mt-4 animate-rise text-3xl font-semibold tracking-tight motion-reduce:animate-none sm:text-4xl"
            >
              {invitations.length > 0 ? "Finish your setup" : "No organization access"}
            </h1>
            <p
              style={{ animationDelay: "160ms" }}
              className="mt-4 max-w-md animate-rise text-pretty text-muted-foreground motion-reduce:animate-none"
            >
              {invitations.length > 0
                ? "You have an invitation waiting. Finish setting up to join the workspace."
                : "Your account is not a member of any active organization yet. Ask an organization administrator to add you."}
              {user.isPlatformAdmin && " As a platform administrator you can still open Platform."}
            </p>

            {invitations.length > 0 && (
              <section
                style={{ animationDelay: "240ms" }}
                className="mt-10 max-w-lg animate-rise motion-reduce:animate-none"
              >
                <h2 className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
                  Pending invitations
                </h2>
                <ul className="mt-3 divide-y divide-border border-y border-border">
                  {invitations.map((invitation) => (
                    <li key={invitation.id}>
                      <Link
                        href={`/invite/${invitation.id}`}
                        className="group flex items-center justify-between gap-6 py-4 transition-colors hover:text-accent"
                      >
                        <span className="font-medium tracking-tight">
                          {invitation.organization_name}
                        </span>
                        <span className="flex items-center gap-3 text-sm text-muted-foreground">
                          Continue setup
                          <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                            →
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : (
          <>
            <h1 className="animate-rise text-3xl font-semibold tracking-tight motion-reduce:animate-none sm:text-4xl">
              Choose workspace
            </h1>
            <p
              style={{ animationDelay: "80ms" }}
              className="mt-3 animate-rise text-muted-foreground motion-reduce:animate-none"
            >
              You belong to {user.organizations.length} organizations.
            </p>
            <ul className="mt-10 max-w-lg divide-y divide-border border-y border-border">
              {user.organizations.map((organization, index) => (
                <li
                  key={organization.id}
                  style={{ animationDelay: `${160 + index * 60}ms` }}
                  className="animate-rise motion-reduce:animate-none"
                >
                  <Link
                    href={`/app/${organization.slug}`}
                    className="group flex items-center justify-between gap-6 py-4 transition-colors hover:text-accent"
                  >
                    <span className="font-medium tracking-tight">{organization.name}</span>
                    <span className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
                      {organization.slug}
                      <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                        →
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}

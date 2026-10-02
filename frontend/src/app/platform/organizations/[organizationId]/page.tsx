import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePlatformPageAccess } from "@/lib/platform/auth";
import {
  getOrganizationServiceEntitlements,
  getPlatformOrganization,
  getPlatformServices,
} from "@/lib/platform/data";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDate } from "@/lib/format";
import { getAdministrationState } from "@/lib/platform/bootstrap";
import {
  cancelAdministratorSetup,
  resendAdministratorSetup,
  setOrganizationStatus,
  setServiceEntitlement,
} from "../actions";
import { AdministratorForm } from "../administrator-form";
import { ActionForm } from "@/components/ui/action-form";

export const metadata: Metadata = { title: "Organization" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PlatformOrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const operator = await requirePlatformPageAccess();
  const { organizationId } = await params;
  if (!UUID_PATTERN.test(organizationId)) notFound();

  const organization = await getPlatformOrganization(organizationId);
  if (!organization) notFound();

  const [services, entitlements, administration] = await Promise.all([
    getPlatformServices(),
    getOrganizationServiceEntitlements(organization.id),
    getAdministrationState(organization.id),
  ]);
  const enabledByKey = new Map(entitlements.map((e) => [e.service_key, e.enabled]));

  // A one-shot notice from the create flow. Everything else about setup is derived from the
  // database below, so a stale or forged value can only add a warning, never hide real state.
  const setupIncomplete = (await searchParams).setup === "incomplete";

  return (
    <>
      <Link
        href="/platform/organizations"
        className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        ← Organizations
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{organization.name}</h1>
          <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Slug</dt>
              <dd className="font-mono">{organization.slug}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Created</dt>
              <dd className="font-mono">{formatDate(organization.created_at)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <StatusBadge active={organization.is_active} labels={["Active", "Suspended"]} />
              </dd>
            </div>
          </dl>
        </div>

        <ActionForm
          action={setOrganizationStatus}
          fields={{ organizationId: organization.id, active: organization.is_active ? "false" : "true" }}
          label={organization.is_active ? "Suspend organization" : "Reactivate organization"}
        />
      </div>

      {!organization.is_active && (
        <p className="mt-6 max-w-xl border-l-2 border-border pl-3 text-sm text-muted-foreground">
          Suspended: members cannot use the workspace and no service is available. Memberships,
          roles and data are kept, and everything resumes on reactivation.
        </p>
      )}

      <section className="mt-12">
        <h2 className="text-lg font-semibold tracking-tight">Administration</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Who administers this organization from inside its own workspace.
        </p>

        {setupIncomplete && (
          <p
            role="status"
            className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-pretty"
          >
            The organization was created, but setting up its administrator did not complete. It is
            safe to try again below — nothing is duplicated.
          </p>
        )}

        <div className="mt-5 rounded-xl border border-border bg-surface p-5 shadow-sm">
          {!administration ? (
            <>
              <p className="flex items-center gap-2.5 font-medium tracking-tight">
                <span aria-hidden className="size-2 rounded-full bg-border-strong" />
                Administration state unavailable
              </p>
              <p className="mt-1.5 text-sm text-pretty text-muted-foreground">
                The administration function could not be reached, so this organization&apos;s
                onboarding state cannot be shown. If the organization bootstrap migrations have not
                been applied to this project yet, that is the likely cause. Everything else on this
                page still works.
              </p>
            </>
          ) : administration.has_recovery_manager ? (
            <>
              <p className="flex items-center gap-2.5 font-medium tracking-tight">
                <span aria-hidden className="size-2 rounded-full bg-accent" />
                Tenant administration ready
              </p>
              <p className="mt-1.5 text-sm text-pretty text-muted-foreground">
                This organization manages its own members and roles. The control plane no longer
                takes part, and cannot be used to add administrators to it.
              </p>
              <ul className="mt-4 flex flex-wrap gap-2">
                {administration.administrator_emails.map((email) => (
                  <li
                    key={email}
                    className="rounded-md bg-surface-sunken px-2.5 py-1 font-mono text-xs"
                  >
                    {email}
                  </li>
                ))}
              </ul>

              {/* An admin-bearing invitation is still live here. Acceptance already refuses it
                  while this organization administers itself, but it is not hidden: it is a real
                  grant until someone cancels it. */}
              {administration.pending_admin_invitation_id && (
                <div className="mt-5 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
                  <p className="text-sm font-medium">Pending obsolete setup</p>
                  <p className="mt-1 font-mono text-sm break-all">
                    {administration.pending_admin_email}
                  </p>
                  <p className="mt-1.5 text-sm text-pretty text-muted-foreground">
                    This setup was issued before the organization had an administrator. It cannot be
                    accepted while one exists, but cancel it so it can never be used.
                  </p>
                  <div className="mt-3 flex items-start">
                    <ActionForm
                      action={cancelAdministratorSetup}
                      fields={{
                        organizationId: organization.id,
                        invitationId: administration.pending_admin_invitation_id,
                      }}
                      label="Cancel setup"
                      ariaLabel={`Cancel the obsolete administrator setup for ${administration.pending_admin_email}`}
                    />
                  </div>
                </div>
              )}
            </>
          ) : administration.pending_admin_invitation_id ? (
            <>
              <p className="flex items-center gap-2.5 font-medium tracking-tight">
                <span aria-hidden className="size-2 rounded-full bg-border-strong" />
                Administrator setup pending
              </p>
              <p className="mt-1.5 font-mono text-sm break-all">
                {administration.pending_admin_email}
              </p>
              <p className="mt-1.5 text-sm text-pretty text-muted-foreground">
                They become the administrator once they finish setting up their account. To name
                someone else instead, cancel this setup first — an organization has one
                administrator setup in progress, or none.
              </p>
              <div className="mt-4 flex flex-wrap items-start gap-2">
                <ActionForm
                  action={resendAdministratorSetup}
                  fields={{ organizationId: organization.id }}
                  label="Resend setup"
                  ariaLabel={`Resend the administrator setup to ${administration.pending_admin_email}`}
                />
                <ActionForm
                  action={cancelAdministratorSetup}
                  fields={{
                    organizationId: organization.id,
                    invitationId: administration.pending_admin_invitation_id,
                  }}
                  label="Cancel setup"
                  ariaLabel={`Cancel the administrator setup for ${administration.pending_admin_email}`}
                />
              </div>
            </>
          ) : (
            <>
              <p className="flex items-center gap-2.5 font-medium tracking-tight">
                <span aria-hidden className="size-2 rounded-full bg-destructive" />
                No administrator configured
              </p>
              <p className="mt-1.5 text-sm text-pretty text-muted-foreground">
                Nobody can administer this organization yet, so its workspace cannot be used. Name
                the person who should own it.
              </p>
              <AdministratorForm
                organizationId={organization.id}
                defaultEmail={operator.email ?? ""}
                submitLabel="Set up administrator"
              />
            </>
          )}

          <div className="mt-5 border-t border-border pt-4 text-sm">
            {administration?.caller_is_member ? (
              <Link
                href={`/app/${organization.slug}`}
                className="group inline-flex items-center gap-1.5 font-medium text-accent transition-colors duration-150 hover:text-accent-strong"
              >
                Open workspace
                <span
                  aria-hidden
                  className="transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:group-hover:translate-x-0"
                >
                  &rarr;
                </span>
              </Link>
            ) : (
              // Platform administration is not tenant access, so it is not offered as though it were.
              <p className="text-muted-foreground">
                You do not have tenant access to this organization. Administering the platform does
                not grant it — name your own address above to join as its administrator.
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-semibold tracking-tight">Services</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Which TalentIQ services this organization is entitled to use.
        </p>

        {services.length === 0 ? (
          <p className="mt-6 border-t border-border pt-6 text-sm text-muted-foreground">
            No services are registered yet. Entitlements can be managed here once TalentIQ modules
            are introduced.
          </p>
        ) : (
          <ul className="mt-6 divide-y divide-border border-y border-border">
            {services.map((service) => {
              const enabled = enabledByKey.get(service.key) ?? false;
              return (
                <li
                  key={service.key}
                  className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4"
                >
                  <div>
                    <p className="font-medium">
                      {service.name}
                      {!service.is_active && (
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          inactive service
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">{service.key}</p>
                    {service.description && (
                      <p className="mt-1 text-sm text-muted-foreground">{service.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-5">
                    <StatusBadge active={enabled} labels={["Enabled", "Disabled"]} />
                    <ActionForm
                      action={setServiceEntitlement}
                      fields={{
                        organizationId: organization.id,
                        serviceKey: service.key,
                        enabled: enabled ? "false" : "true",
                      }}
                      label={enabled ? "Disable" : "Enable"}
                      ariaLabel={`${enabled ? "Disable" : "Enable"} ${service.name}`}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

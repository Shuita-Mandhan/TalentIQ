import type { Metadata } from "next";
import Link from "next/link";
import { requirePlatformPageAccess } from "@/lib/platform/auth";
import { CreateOrganizationForm } from "./create-organization-form";

export const metadata: Metadata = { title: "Create organization" };

export default async function CreateOrganizationPage() {
  await requirePlatformPageAccess();

  return (
    <div className="max-w-md">
      <Link
        href="/platform/organizations"
        className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <span
          aria-hidden
          className="transition-transform duration-200 group-hover:-translate-x-0.5 motion-reduce:group-hover:translate-x-0"
        >
          &larr;
        </span>
        Organizations
      </Link>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">Create organization</h1>
      <p className="mt-2 text-sm text-pretty text-muted-foreground">
        The organization starts active with a protected Organization Admin role, and the
        administrator you name below is set up with it so the workspace is usable straight away.
      </p>
      <div className="mt-8">
        {/* Deliberately not prefilled with the operator's own address. Naming yourself creates a
            real tenant membership, and platform administration on its own creates none - so it has
            to be a decision, not a default. */}
        <CreateOrganizationForm />
      </div>
    </div>
  );
}

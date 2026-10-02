"use client";

import { useActionState } from "react";
import { setupAdministrator, type CreateOrganizationState } from "./actions";

/**
 * Retry for an organization that still cannot administer itself. Success is not announced here:
 * the page revalidates and the administration state above it changes, which is the honest signal.
 */
export function AdministratorForm({
  organizationId,
  defaultEmail,
  submitLabel,
}: {
  organizationId: string;
  defaultEmail: string;
  submitLabel: string;
}) {
  const [state, formAction, isPending] = useActionState<CreateOrganizationState, FormData>(
    setupAdministrator,
    {},
  );

  return (
    <form action={formAction} className="mt-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor="adminEmail" className="mb-1.5 block text-sm font-medium">
            Administrator email
          </label>
          <input
            id="adminEmail"
            name="adminEmail"
            type="email"
            required
            autoComplete="off"
            spellCheck={false}
            defaultValue={state.adminEmail ?? defaultEmail}
            className="h-10 w-full rounded-md border border-border bg-surface px-3.5 font-mono text-sm transition-colors duration-150 hover:border-border-strong focus:border-accent"
          />
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-10 shrink-0 items-center rounded-md bg-accent px-4 text-sm font-medium text-white shadow-sm transition-colors duration-150 hover:bg-accent-strong disabled:cursor-progress disabled:opacity-70"
        >
          {isPending ? "Setting up…" : submitLabel}
        </button>
      </div>
      {state.error && (
        <p role="alert" className="mt-2.5 text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}

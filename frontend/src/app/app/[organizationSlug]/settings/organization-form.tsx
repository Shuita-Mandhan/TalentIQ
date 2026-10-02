"use client";

import { useActionState } from "react";
import { updateOrganization, type OrganizationSettingsState } from "./actions";

const inputClass =
  "h-11 w-full rounded-md border border-border bg-surface px-3.5 text-sm transition-colors duration-150 hover:border-border-strong focus:border-accent";

export function OrganizationForm({
  organizationSlug,
  initialName,
}: {
  organizationSlug: string;
  initialName: string;
}) {
  const [state, formAction, isPending] = useActionState<OrganizationSettingsState, FormData>(
    updateOrganization,
    { name: initialName },
  );

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="organizationSlug" value={organizationSlug} />

      <div>
        <label htmlFor="name" className="mb-1.5 block text-sm font-medium">
          Organization name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          maxLength={120}
          defaultValue={state.name ?? initialName}
          className={inputClass}
        />
        <p className="mt-1.5 text-sm text-muted-foreground">
          How this organization is named throughout TalentIQ.
        </p>
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-accent-strong disabled:cursor-progress disabled:opacity-70"
        >
          {isPending ? "Saving…" : "Save changes"}
        </button>
        {state.saved && !state.error && (
          <p role="status" className="text-sm text-accent">
            Saved.
          </p>
        )}
      </div>
    </form>
  );
}

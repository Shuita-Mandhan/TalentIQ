"use client";

import { useActionState, useState } from "react";
import { updatePassword, type ResetPasswordState } from "./actions";

const inputClass =
  "h-11 w-full rounded border border-border bg-surface px-3.5 text-sm transition-colors hover:border-foreground/30 focus:border-accent";

/**
 * With `invitationId` this is account setup: one password, and joining is part of the same submit.
 * The action re-validates the id and the database re-checks that the invitation is still pending
 * and still addressed to this account before anything is granted.
 */
export function ResetPasswordForm({ invitationId }: { invitationId?: string | null }) {
  const [state, formAction, isPending] = useActionState<ResetPasswordState, FormData>(
    updatePassword,
    {},
  );
  const [showPasswords, setShowPasswords] = useState(false);
  const type = showPasswords ? "text" : "password";
  const label = invitationId ? "Set password & join workspace" : "Update password";
  const pendingLabel = invitationId ? "Joining…" : "Updating…";

  return (
    <form action={formAction} className="space-y-5">
      {invitationId && <input type="hidden" name="invitationId" value={invitationId} />}

      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
          {invitationId ? "Password" : "New password"}
        </label>
        <input
          id="password"
          name="password"
          type={type}
          autoComplete="new-password"
          required
          minLength={8}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="confirmPassword" className="mb-1.5 block text-sm font-medium">
          {invitationId ? "Confirm password" : "Confirm new password"}
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type={type}
          autoComplete="new-password"
          required
          minLength={8}
          className={inputClass}
        />
      </div>

      <label className="flex items-center gap-2.5 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={showPasswords}
          onChange={(event) => setShowPasswords(event.target.checked)}
          className="size-4 accent-accent"
        />
        Show passwords
      </label>

      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="h-11 w-full rounded bg-accent text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:cursor-progress disabled:opacity-70"
      >
        {isPending ? pendingLabel : label}
      </button>
    </form>
  );
}

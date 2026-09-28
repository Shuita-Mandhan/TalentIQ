"use client";

import { useActionState } from "react";

/** `message` is a server-supplied success line for actions whose outcome depends on what happened. */
export type ActionState = { error?: string; done?: boolean; message?: string };

type Props = {
  action: (previous: ActionState, formData: FormData) => Promise<ActionState>;
  fields: Record<string, string>;
  label: string;
  ariaLabel?: string;
  /** Shown once the action reports success; omit for actions whose result is visible on the page. */
  successLabel?: string;
};

/** A one-button mutation with hidden inputs, pending state and an inline sanitized error. */
export function ActionForm({ action, fields, label, ariaLabel, successLabel }: Props) {
  const [state, formAction, isPending] = useActionState(action, {});
  const success = state.message ?? successLabel;

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        disabled={isPending}
        aria-label={ariaLabel}
        className="h-9 rounded border border-border bg-surface px-3.5 text-sm font-medium transition-colors hover:border-foreground/30 hover:bg-background disabled:cursor-progress disabled:opacity-70"
      >
        {isPending ? "Saving…" : label}
      </button>
      {state.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      )}
      {state.done && success && !state.error && (
        <p role="status" className="text-xs text-accent">
          {success}
        </p>
      )}
    </form>
  );
}

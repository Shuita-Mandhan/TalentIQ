const STYLES = {
  surface:
    "h-9 rounded-md border border-border bg-surface px-3.5 text-sm font-medium transition-colors duration-150 hover:border-border-strong hover:bg-surface-sunken",
  rail: "h-8 rounded-md border border-rail-border px-3 text-sm font-medium text-rail-muted transition-colors duration-150 hover:border-rail-muted/60 hover:text-rail-foreground",
} as const;

/** `rail` is the dark navigation plane variant; `surface` is the default light-canvas one. */
export function SignOutButton({ variant = "surface" }: { variant?: keyof typeof STYLES }) {
  return (
    <form action="/auth/signout" method="post">
      <button type="submit" className={STYLES[variant]}>
        Sign out
      </button>
    </form>
  );
}

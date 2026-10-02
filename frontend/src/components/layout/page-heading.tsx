import Link from "next/link";

// The framing Members, Roles and Settings genuinely share. Anything a single page needs alone
// stays in that page rather than growing another prop here.

export function PageHeading({
  back,
  eyebrow,
  title,
  description,
  actions,
}: {
  /** Upward navigation for a nested route; the rail already covers the top-level sections. */
  back?: { href: string; label: string };
  eyebrow?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="border-b border-border pb-6">
      {back && (
        <Link
          href={back.href}
          className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          <span
            aria-hidden
            className="transition-transform duration-200 group-hover:-translate-x-0.5 motion-reduce:group-hover:translate-x-0"
          >
            &larr;
          </span>
          {back.label}
        </Link>
      )}
      {eyebrow && <div className={back ? "mt-5" : undefined}>{eyebrow}</div>}
      <div
        className={`flex flex-wrap items-end justify-between gap-x-8 gap-y-4 ${
          back || eyebrow ? "mt-3" : ""
        }`}
      >
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-[28px]">
            {title}
          </h1>
          {description && (
            <p className="mt-2 max-w-prose text-sm text-pretty text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions}
      </div>
    </header>
  );
}

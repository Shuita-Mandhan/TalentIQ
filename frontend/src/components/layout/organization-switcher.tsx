"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { AccessibleOrganization } from "@/lib/auth/organization-context";

// A disclosure holding ordinary links, not a menu widget: it carries none of the ARIA menu
// keyboard model, so it does not claim to. Selecting a workspace is a plain navigation, which is
// why the URL remains the only source of tenant context - nothing is remembered anywhere.
//
// Rendered only where there is genuinely something to switch between, and styled for the dark
// navigation plane it lives on in both the rail and the mobile panel.

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export function OrganizationSwitcher({
  organizations,
  currentSlug,
}: {
  organizations: AccessibleOrganization[];
  currentSlug: string;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const current = organizations.find((organization) => organization.slug === currentSlug);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-2.5 rounded-lg border border-rail-border bg-rail-raised px-2.5 py-2 text-left transition-colors duration-150 hover:border-accent/50"
      >
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-md bg-accent/15 font-mono text-[11px] font-medium text-accent"
        >
          {initials(current?.name ?? "?")}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium tracking-tight text-rail-foreground">
            {current?.name ?? "Select workspace"}
          </span>
          <span className="block text-[11px] text-rail-muted">
            {organizations.length} workspaces
          </span>
        </span>
        <svg
          viewBox="0 0 12 12"
          aria-hidden
          className={`size-3 shrink-0 text-rail-muted transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        >
          <path
            d="M3 4.5 6 7.5 9 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* Hidden with a class rather than unmounted, so aria-controls always names a real element
          and display:none keeps the links out of the tab order while closed. */}
      <div
        id={panelId}
        className={`absolute top-full right-0 left-0 z-30 mt-1.5 overflow-hidden rounded-lg border border-rail-border bg-rail-raised p-1 shadow-md ${
          open ? "block" : "hidden"
        }`}
      >
        {organizations.map((organization) => {
          const isCurrent = organization.slug === currentSlug;
          return (
            <Link
              key={organization.slug}
              href={`/app/${organization.slug}`}
              onClick={() => setOpen(false)}
              aria-current={isCurrent ? "true" : undefined}
              className={`flex items-center gap-2.5 rounded-md px-2 py-2 transition-colors duration-150 ${
                isCurrent
                  ? "bg-accent/15 text-rail-foreground"
                  : "text-rail-muted hover:bg-white/5 hover:text-rail-foreground"
              }`}
            >
              <span
                aria-hidden
                className={`grid size-6 shrink-0 place-items-center rounded font-mono text-[10px] ${
                  isCurrent ? "bg-accent/25 text-accent" : "bg-white/5"
                }`}
              >
                {initials(organization.name)}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{organization.name}</span>
              {isCurrent && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useId, useState } from "react";
import { WorkspaceNav, type NavItem } from "./workspace-nav";

// The narrow-screen counterpart of the rail, and the same navigation plane: dark, not a collapsed
// copy of the desktop layout. The panel stays in the tree and is hidden with a class rather than
// unmounted, so aria-controls always names a real element; display:none keeps it out of the
// accessibility tree and out of the tab order while closed.

export function MobileWorkspaceNav({
  items,
  switcher,
  children,
}: {
  items: NavItem[];
  /** The same switcher the rail uses, or null when there is only one workspace to be in. */
  switcher?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close navigation menu" : "Open navigation menu"}
        className="-mr-1.5 inline-flex size-10 items-center justify-center rounded-md text-rail-muted transition-colors duration-150 hover:bg-rail-raised hover:text-rail-foreground"
      >
        <svg viewBox="0 0 16 16" aria-hidden className="size-[18px]">
          {open ? (
            <path
              d="m4 4 8 8M12 4l-8 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          ) : (
            <path
              d="M2 4.5h12M2 11.5h12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          )}
        </svg>
      </button>

      <div
        id={panelId}
        className={`on-rail fixed inset-x-0 top-14 bottom-0 z-30 flex-col overflow-y-auto border-t border-rail-border bg-rail px-4 py-5 lg:hidden ${
          open ? "flex" : "hidden"
        }`}
      >
        {switcher && (
          <div className="mb-6">
            <p className="px-3.5 pb-2 font-mono text-[10px] tracking-[0.12em] text-rail-muted/70 uppercase">
              Workspace
            </p>
            {switcher}
          </div>
        )}
        <WorkspaceNav items={items} onNavigate={() => setOpen(false)} />
        <div className="mt-auto border-t border-rail-border pt-6">{children}</div>
      </div>
    </>
  );
}

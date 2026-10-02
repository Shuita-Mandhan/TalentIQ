"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ICONS, type NavIconName } from "./nav-icons";

// Presentation only. Which items exist is decided on the server from the caller's effective
// permissions; the pathname decides nothing but which one looks current.

export type NavItem = { href: string; label: string; icon: NavIconName; exact?: boolean };

export function WorkspaceNav({
  items,
  onNavigate,
  label = "Workspace",
}: {
  items: NavItem[];
  onNavigate?: () => void;
  label?: string;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label={label} className="flex flex-col gap-0.5">
      {items.map(({ href, label: itemLabel, icon, exact }) => {
        // A nested route keeps its parent section current, but only on a path boundary so that a
        // sibling like /membership could never light up /members.
        const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
        const Icon = NAV_ICONS[icon];

        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`group relative flex items-center gap-3 rounded-md py-2 pr-3 pl-3.5 text-sm transition-[color,background-color] duration-150 ${
              active
                ? "bg-rail-raised font-medium text-rail-foreground"
                : "text-rail-muted hover:bg-rail-raised/60 hover:text-rail-foreground"
            }`}
          >
            <span
              aria-hidden
              className={`absolute top-1/2 -left-3 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent transition-[opacity,transform] duration-200 ${
                active ? "scale-y-100 opacity-100" : "scale-y-0 opacity-0"
              }`}
            />
            <Icon
              className={`size-4 shrink-0 transition-colors duration-150 ${
                active ? "text-accent" : "text-rail-muted group-hover:text-rail-foreground"
              }`}
            />
            {itemLabel}
          </Link>
        );
      })}
    </nav>
  );
}

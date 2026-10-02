"use client";

import Link from "next/link";
import { useCallback, useRef } from "react";

// Platform topology: TalentIQ at the centre, the organizations it serves around it, each showing
// how it is administered. The same scene mechanics the workspace Access Core uses - CSS transforms,
// two custom properties written by a rAF-throttled pointer handler, no animation loop and no
// library - evolved from one organization's interior to the control plane's exterior.
//
// Every node is a real link to that organization, so this is navigation with depth rather than a
// decoration placed over navigation. Only the core and the connectors are aria-hidden; the nodes
// carry their own text and reach by keyboard in the order they are listed below the scene.
//
// The attention state is the one thing that animates on its own, because it is the one thing that
// wants the operator to do something.

export type TopologyNode = {
  id: string;
  name: string;
  href: string;
  state: "pending" | "ready" | "suspended";
};

const STATE_LABEL: Record<TopologyNode["state"], string> = {
  pending: "Setup pending",
  ready: "Ready",
  suspended: "Suspended",
};

/** Ring placement. Beyond six the scene stops being readable, so the rest are counted instead. */
const MAX_NODES = 6;

function placement(index: number, count: number) {
  const angle = (-90 + index * (360 / count)) * (Math.PI / 180);
  return {
    left: `${50 + Math.cos(angle) * 37}%`,
    top: `${50 + Math.sin(angle) * 33}%`,
    depth: 34 + (index % 3) * 20,
  };
}

export function PlatformTopology({
  nodes,
  totalOrganizations,
}: {
  nodes: TopologyNode[];
  totalOrganizations: number;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    const element = stage.current;
    if (!element) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;

    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      element.style.setProperty("--tilt-y", `${x * 10}deg`);
      element.style.setProperty("--tilt-x", `${-y * 8}deg`);
    });
  }, []);

  const reset = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    const element = stage.current;
    if (!element) return;
    element.style.setProperty("--tilt-y", "0deg");
    element.style.setProperty("--tilt-x", "0deg");
  }, []);

  const shown = nodes.slice(0, MAX_NODES);
  const hidden = totalOrganizations - shown.length;

  return (
    <div
      onPointerMove={onPointerMove}
      onPointerLeave={reset}
      className="scene relative h-[320px] w-full select-none sm:h-[380px]"
    >
      <div
        ref={stage}
        style={{ transform: "rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg))" }}
        className="preserve-3d absolute inset-0 transition-transform duration-300 ease-out"
      >
        <svg
          aria-hidden
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full"
          style={{ transform: "translateZ(-28px)" }}
        >
          <g stroke="var(--border-strong)" strokeWidth="0.22" fill="none">
            {shown.map((node, index) => {
              const { left, top } = placement(index, shown.length);
              return (
                <path
                  key={node.id}
                  d={`M50 50 L${Number.parseFloat(left)} ${Number.parseFloat(top)}`}
                />
              );
            })}
          </g>
        </svg>

        <div
          aria-hidden
          className="absolute top-1/2 left-1/2"
          style={{ transform: "translate3d(-50%, -50%, 16px)" }}
        >
          <div className="relative grid size-[108px] place-items-center rounded-2xl border border-rail-border bg-rail shadow-md sm:size-[120px]">
            <span className="absolute inset-0 rounded-2xl ring-1 ring-accent/20 ring-inset" />
            <span className="grid size-7 place-items-center rounded-[6px] bg-accent text-xs font-semibold text-white">
              T
            </span>
            <span className="mt-2 text-[11px] font-medium tracking-tight text-rail-foreground">
              TalentIQ
            </span>
            <span className="font-mono text-[10px] text-rail-muted tabular-nums">
              {totalOrganizations} org{totalOrganizations === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        {shown.map((node, index) => {
          const { left, top, depth } = placement(index, shown.length);
          return (
            <div
              key={node.id}
              className="absolute w-[142px] sm:w-[158px]"
              style={{ left, top, transform: "translate(-50%, -50%)" }}
            >
              <Link
                href={node.href}
                style={{ transform: `translateZ(${depth}px)` }}
                className={`group block rounded-xl border bg-surface p-3 shadow-sm transition-[box-shadow,border-color,translate] duration-200 hover:shadow-md focus-visible:shadow-md ${
                  node.state === "pending"
                    ? "border-accent/40 hover:border-accent"
                    : "border-border hover:border-border-strong"
                }`}
              >
                <span className="flex items-center gap-2">
                  {node.state === "pending" ? (
                    <span className="relative flex size-2 shrink-0">
                      <span className="absolute inset-0 animate-pulse-ring rounded-full bg-accent motion-reduce:hidden" />
                      <span className="relative size-2 rounded-full bg-accent" />
                    </span>
                  ) : (
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        node.state === "suspended" ? "bg-destructive/60" : "bg-border-strong"
                      }`}
                    />
                  )}
                  <span className="truncate text-sm font-medium tracking-tight transition-colors duration-150 group-hover:text-accent">
                    {node.name}
                  </span>
                </span>
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  {STATE_LABEL[node.state]}
                </span>
              </Link>
            </div>
          );
        })}
      </div>

      {hidden > 0 && (
        <p className="absolute right-0 bottom-0 font-mono text-[11px] text-muted-foreground">
          +{hidden} more
        </p>
      )}
    </div>
  );
}

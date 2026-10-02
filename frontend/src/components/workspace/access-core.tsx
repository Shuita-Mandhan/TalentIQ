"use client";

import { useCallback, useRef } from "react";

// Workspace topology: the organization at the centre, and the three things this workspace actually
// governs layered around it. Every value shown is real - the member and role counts are the ones
// the caller is permitted to see, and the permission count is their own effective access. Nothing
// here is a projection, a KPI or a module that does not exist.
//
// Built from CSS transforms rather than a 3D library: the whole scene is four planes and a few
// lines. Pointer movement writes two custom properties through a rAF-throttled handler, so there
// is no animation loop and nothing recalculates layout. The scene is decorative and marked
// aria-hidden - the same figures are stated in text beside it, which is what screen readers and
// anyone with reduced motion get.

export type CoreNode = {
  label: string;
  /** Already formatted, or a dash when the caller may not see the figure. */
  value: string;
  hint: string;
};

/** Where each plane sits relative to the core: x%, y%, and how far forward it floats. */
const POSITIONS = [
  { x: "62%", y: "8%", z: 70, delay: "0s" },
  { x: "2%", y: "40%", z: 44, delay: "-4.6s" },
  { x: "56%", y: "68%", z: 58, delay: "-9.2s" },
] as const;

export function AccessCore({
  organizationName,
  nodes,
}: {
  organizationName: string;
  nodes: CoreNode[];
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
      // Deliberately shallow. Enough to feel like depth, not enough to read as a toy.
      element.style.setProperty("--tilt-y", `${x * 9}deg`);
      element.style.setProperty("--tilt-x", `${-y * 7}deg`);
    });
  }, []);

  const reset = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    const element = stage.current;
    if (!element) return;
    element.style.setProperty("--tilt-y", "0deg");
    element.style.setProperty("--tilt-x", "0deg");
  }, []);

  const initials = organizationName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div
      aria-hidden
      onPointerMove={onPointerMove}
      onPointerLeave={reset}
      className="scene relative h-[300px] w-full select-none sm:h-[360px]"
    >
      <div
        ref={stage}
        style={{ transform: "rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg))" }}
        className="preserve-3d absolute inset-0 transition-transform duration-300 ease-out"
      >
        {/* Connectors, drawn behind every plane. */}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full"
          style={{ transform: "translateZ(-30px)" }}
        >
          <g stroke="var(--border-strong)" strokeWidth="0.25" fill="none">
            <path d="M50 50 L72 20" />
            <path d="M50 50 L16 52" />
            <path d="M50 50 L66 78" />
          </g>
          <g fill="var(--accent)" opacity="0.35">
            <circle cx="72" cy="20" r="0.7" />
            <circle cx="16" cy="52" r="0.7" />
            <circle cx="66" cy="78" r="0.7" />
          </g>
        </svg>

        {/* The core: the organization itself. */}
        <div
          className="preserve-3d absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{ transform: "translate3d(-50%, -50%, 18px)" }}
        >
          <div className="relative grid size-[118px] place-items-center rounded-2xl border border-rail-border bg-rail shadow-md sm:size-[132px]">
            <span
              aria-hidden
              className="absolute inset-0 rounded-2xl ring-1 ring-accent/20 ring-inset"
            />
            <span className="font-mono text-2xl font-medium tracking-tight text-accent">
              {initials || "TQ"}
            </span>
            <span className="mt-1 max-w-[84%] truncate text-[11px] text-rail-muted">
              {organizationName}
            </span>
          </div>
        </div>

        {/* The layers around it. */}
        {nodes.slice(0, 3).map((node, index) => {
          const position = POSITIONS[index];
          return (
            <div
              key={node.label}
              className="group absolute w-[132px] sm:w-[148px]"
              style={{ left: position.x, top: position.y }}
            >
              <div
                className="animate-drift rounded-xl border border-border bg-surface p-3 shadow-sm transition-[transform,box-shadow,border-color] duration-200 group-hover:shadow-md"
                style={{
                  transform: `translateZ(${position.z}px)`,
                  animationDelay: position.delay,
                }}
              >
                <p className="font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
                  {node.label}
                </p>
                <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
                  {node.value}
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{node.hint}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

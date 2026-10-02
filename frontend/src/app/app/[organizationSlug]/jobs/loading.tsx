// Shown while a jobs route resolves. Skeletons match the real rhythm of the list, so the page
// settles into place rather than jumping when the data arrives.
export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite" className="animate-pulse motion-reduce:animate-none">
      <span className="sr-only">Loading jobs…</span>
      <div className="h-8 w-40 rounded bg-surface-sunken" />
      <div className="mt-3 h-4 w-full max-w-lg rounded bg-surface-sunken" />
      <div className="mt-8 grid gap-2.5">
        {[0, 1, 2].map((row) => (
          <div key={row} className="h-[76px] rounded-xl border border-border bg-surface" />
        ))}
      </div>
    </div>
  );
}

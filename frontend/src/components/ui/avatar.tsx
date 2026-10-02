// Initials from whatever identity we actually have. Four muted tints, chosen deterministically
// from the address so a person keeps the same one everywhere, and restrained enough that a list of
// them still reads as one surface rather than confetti.

const TINTS = [
  "bg-accent-soft text-accent-strong",
  "bg-[#eae7f1] text-[#4b4266]",
  "bg-[#f0e9e2] text-[#6b5744]",
  "bg-[#e3ecef] text-[#3c5a63]",
] as const;

const SIZES = {
  sm: "size-8 text-[11px]",
  md: "size-10 text-xs",
} as const;

function initialsOf(name: string | null, email: string): string {
  const source = name?.trim() || email.split("@")[0] || "?";
  const words = source.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function tintOf(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return TINTS[Math.abs(hash) % TINTS.length];
}

export function Avatar({
  name,
  email,
  size = "sm",
  muted = false,
}: {
  name: string | null;
  email: string;
  size?: keyof typeof SIZES;
  /** Inactive members are shown drained of colour rather than hidden away. */
  muted?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-full font-medium ${SIZES[size]} ${
        muted ? "bg-surface-sunken text-muted-foreground" : tintOf(email)
      }`}
    >
      {initialsOf(name, email)}
    </span>
  );
}

// The job domain: the shapes, the vocabulary and the lifecycle, with no data access in it.
//
// Kept free of server imports so client components can share exactly the same constants the server
// validates against - one definition of what a status or a category is, rather than a copy in the
// form that can drift from the one in the database.


export const JOB_STATUSES = ["draft", "open", "paused", "closed", "archived"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const EMPLOYMENT_TYPES = [
  "full_time",
  "part_time",
  "contract",
  "internship",
  "temporary",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const WORK_MODES = ["on_site", "hybrid", "remote"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const REQUIREMENT_CATEGORIES = [
  "skill",
  "experience",
  "education",
  "certification",
  "language",
  "other",
] as const;
export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number];

export const IMPORTANCES = ["required", "preferred"] as const;
export type Importance = (typeof IMPORTANCES)[number];

/** Display text for the stored values. The database keeps machine keys; only this file prettifies. */
export const STATUS_LABELS: Record<JobStatus, string> = {
  draft: "Draft",
  open: "Open",
  paused: "Paused",
  closed: "Closed",
  archived: "Archived",
};

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: "Full time",
  part_time: "Part time",
  contract: "Contract",
  internship: "Internship",
  temporary: "Temporary",
};

export const WORK_MODE_LABELS: Record<WorkMode, string> = {
  on_site: "On site",
  hybrid: "Hybrid",
  remote: "Remote",
};

export const CATEGORY_LABELS: Record<RequirementCategory, string> = {
  skill: "Skill",
  experience: "Experience",
  education: "Education",
  certification: "Certification",
  language: "Language",
  other: "Other",
};

/**
 * Where a job may go next. The database enforces the same table in a trigger; this exists so the
 * interface offers only the moves that exist, never as the thing that decides them.
 */
export const STATUS_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  draft: ["open", "archived"],
  open: ["paused", "closed"],
  paused: ["open", "closed"],
  closed: ["archived"],
  archived: [],
};

export type Job = {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  status: JobStatus;
  employment_type: EmploymentType | null;
  work_mode: WorkMode | null;
  location: string | null;
  department: string | null;
  openings: number;
  application_deadline: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type JobRequirement = {
  id: string;
  organization_id: string;
  job_id: string;
  category: RequirementCategory;
  requirement: string;
  importance: Importance;
  weight: number;
  source: "manual" | "ai";
  display_order: number;
};


/** The compact counts the workspace overview shows. Derived from the same rows, not a second source. */
export function summariseJobs(jobs: Job[]) {
  const by = (status: JobStatus) => jobs.filter((job) => job.status === status).length;
  return {
    total: jobs.length,
    open: by("open"),
    draft: by("draft"),
    paused: by("paused"),
    openings: jobs
      .filter((job) => job.status === "open")
      .reduce((total, job) => total + job.openings, 0),
  };
}

export const SOURCES = ["manual", "ai"] as const;
export type RequirementSource = (typeof SOURCES)[number];

/**
 * How a requirement got here. "Suggested" is what a later JD Intelligence phase will write; it is
 * a label on the row and nothing else, and a recruiter may change it like any other field.
 */
export const SOURCE_LABELS: Record<RequirementSource, string> = {
  manual: "Added by you",
  ai: "Suggested",
};

export const JOB_SORTS = {
  updated: "Recently updated",
  title: "Title",
  openings: "Openings",
} as const;
export type JobSort = keyof typeof JOB_SORTS;

export type JobListQuery = { search: string; status: JobStatus | null; sort: JobSort };

/**
 * What the Jobs list shows, as a pure function of the rows and the query.
 *
 * With no status chosen, archived jobs are left out: they are history, and a recruiter looking at
 * "jobs" means the ones still in play. Choosing Archived explicitly brings them back.
 */
export function filterAndSortJobs(jobs: Job[], query: JobListQuery): Job[] {
  const search = query.search.trim().toLowerCase();

  return jobs
    .filter((job) => (query.status ? job.status === query.status : job.status !== "archived"))
    .filter((job) => {
      if (search.length === 0) return true;
      return [job.title, job.department, job.location]
        .filter((field): field is string => Boolean(field))
        .some((field) => field.toLowerCase().includes(search));
    })
    .sort((a, b) => {
      if (query.sort === "title") return a.title.localeCompare(b.title);
      if (query.sort === "openings") return b.openings - a.openings;
      return b.updated_at.localeCompare(a.updated_at);
    });
}

export type AnalysisStatus = "running" | "succeeded" | "failed";

export type JobDescriptionAnalysis = {
  id: string;
  status: AnalysisStatus;
  provider: string;
  model: string;
  source_text: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  /** Still "running" long after it could be: its process disappeared. Decided by the read. */
  stalled: boolean;
};

export type SuggestionStatus = "pending" | "approved" | "rejected";

export type RequirementSuggestion = {
  id: string;
  analysis_id: string;
  category: RequirementCategory;
  requirement: string;
  importance: Importance;
  weight: number;
  status: SuggestionStatus;
  duplicate_group: number | null;
  display_order: number;
};

// ---------------------------------------------------------------------------------------------
// The screening rubric
//
// Not a stored object: a reading of the approved job requirements as a weighted configuration.
// Readiness is derived every time it is asked for, so it can never disagree with the rows.
// ---------------------------------------------------------------------------------------------

/** A rubric is a hundred points, distributed by the recruiter. */
export const RUBRIC_TOTAL = 100;
export const MAX_REQUIREMENT_WEIGHT = 100;

export type RubricReadiness = "empty" | "incomplete" | "ready";

export type RubricSummary = {
  requirements: number;
  required: number;
  preferred: number;
  totalWeight: number;
  requiredWeight: number;
  preferredWeight: number;
  readiness: RubricReadiness;
  /**
   * What stops the rubric being ready, in the recruiter's terms. Empty exactly when readiness is
   * "ready" — these two are the same judgement said two ways, so one can never contradict the other.
   */
  issues: string[];
  /**
   * Worth a second look, but not disqualifying. A ready rubric may still carry warnings: they are
   * things we decline to decide on the recruiter's behalf, not things we refuse to accept.
   */
  warnings: string[];
};

/** Weights are stored to two decimals; sum in integer hundredths so 33.33 + 33.33 + 33.34 is 100. */
function sumWeights(values: number[]): number {
  return values.reduce((total, value) => total + Math.round(value * 100), 0) / 100;
}

export function summariseRubric(requirements: JobRequirement[]): RubricSummary {
  const required = requirements.filter((item) => item.importance === "required");
  const preferred = requirements.filter((item) => item.importance === "preferred");
  const totalWeight = sumWeights(requirements.map((item) => Number(item.weight)));

  const issues: string[] = [];
  if (requirements.length === 0) {
    issues.push("The rubric has no requirements yet.");
  } else if (totalWeight !== RUBRIC_TOTAL) {
    const difference = Math.round((RUBRIC_TOTAL - totalWeight) * 100) / 100;
    issues.push(
      difference > 0
        ? `Weights total ${totalWeight} — ${difference} short of ${RUBRIC_TOTAL}.`
        : `Weights total ${totalWeight} — ${Math.abs(difference)} over ${RUBRIC_TOTAL}.`,
    );
  }
  // A requirement carrying nothing contributes nothing to screening, which is more often an
  // oversight than an intention — but it is a legitimate thing to want, so it is raised rather than
  // refused. It is deliberately NOT an issue: a rubric totalling 100 with a weightless requirement
  // is ready, and saying so while also saying it is unready would be the UI contradicting itself.
  const warnings: string[] = [];
  const weightless = requirements.filter((item) => Number(item.weight) === 0).length;
  if (weightless > 0) {
    warnings.push(
      `${weightless} requirement${weightless === 1 ? " carries" : "s carry"} no weight` +
        ` and will not affect a candidate's score.`,
    );
  }

  return {
    requirements: requirements.length,
    required: required.length,
    preferred: preferred.length,
    totalWeight,
    requiredWeight: sumWeights(required.map((item) => Number(item.weight))),
    preferredWeight: sumWeights(preferred.map((item) => Number(item.weight))),
    readiness:
      requirements.length === 0 ? "empty" : totalWeight === RUBRIC_TOTAL ? "ready" : "incomplete",
    issues,
    warnings,
  };
}

/**
 * Proportional weights that total exactly 100.
 *
 * Never applied on the recruiter's behalf. This exists only behind an explicit control, because
 * quietly rewriting the numbers somebody typed is precisely what a rubric must not do. Requirements
 * that currently carry nothing stay at nothing; with nothing to scale, the points are shared
 * evenly. The rounding remainder lands on the largest entries so the total is exact rather than
 * 99.99.
 */
export function balanceWeights(requirements: JobRequirement[]): { id: string; weight: number }[] {
  if (requirements.length === 0) return [];

  const current = requirements.map((item) => Number(item.weight));
  const total = current.reduce((sum, value) => sum + value, 0);
  // Work in integer hundredths throughout, so no float ever decides a total.
  const target = RUBRIC_TOTAL * 100;

  const shares =
    total > 0
      ? current.map((value) => Math.floor((value / total) * target))
      : current.map(() => Math.floor(target / requirements.length));

  let remainder = target - shares.reduce((sum, value) => sum + value, 0);
  // Largest first, so the leftover hundredths go where they matter least proportionally.
  const order = shares
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value || a.index - b.index);
  for (let step = 0; remainder > 0; step += 1, remainder -= 1) {
    shares[order[step % order.length].index] += 1;
  }

  return requirements.map((item, index) => ({ id: item.id, weight: shares[index] / 100 }));
}

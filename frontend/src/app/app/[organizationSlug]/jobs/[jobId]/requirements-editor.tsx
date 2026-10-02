"use client";

import { useActionState, useRef, useState } from "react";
import {
  CATEGORY_LABELS,
  IMPORTANCES,
  REQUIREMENT_CATEGORIES,
  SOURCES,
  SOURCE_LABELS,
  type JobRequirement,
} from "@/lib/jobs/types";
import {
  addRequirement,
  removeRequirement,
  reorderRequirements,
  updateRequirement,
  type RequirementFormState,
} from "../actions";
import type { ActionState } from "@/components/ui/action-form";

// The recruiter's own list. A requirement written by a later JD Intelligence phase arrives marked
// "Suggested" and is edited, reordered and removed through exactly these controls - nothing about
// its origin gives it standing, which is the point of showing the origin at all.
//
// Ordering works two ways on purpose. Dragging is the obvious gesture for a pointer; Move up and
// Move down are buttons, so the same job is doable from the keyboard without a drag model that
// assistive technology has to guess at. Both write through the same action, and the order is only
// ever confirmed by the server.

const inputClass =
  "h-10 w-full rounded-md border border-border bg-surface px-3 text-sm transition-colors duration-150 hover:border-border-strong focus:border-accent";

function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4" fill="currentColor">
      <circle cx="6" cy="4" r="1.1" />
      <circle cx="10" cy="4" r="1.1" />
      <circle cx="6" cy="8" r="1.1" />
      <circle cx="10" cy="8" r="1.1" />
      <circle cx="6" cy="12" r="1.1" />
      <circle cx="10" cy="12" r="1.1" />
    </svg>
  );
}

function RequirementFields({ requirement }: { requirement?: JobRequirement }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <select
        name="category"
        defaultValue={requirement?.category ?? "skill"}
        aria-label="Category"
        className={inputClass}
      >
        {REQUIREMENT_CATEGORIES.map((category) => (
          <option key={category} value={category}>
            {CATEGORY_LABELS[category]}
          </option>
        ))}
      </select>
      <select
        name="importance"
        defaultValue={requirement?.importance ?? "required"}
        aria-label="Importance"
        className={inputClass}
      >
        {IMPORTANCES.map((importance) => (
          <option key={importance} value={importance}>
            {importance === "required" ? "Required" : "Preferred"}
          </option>
        ))}
      </select>
      <select
        name="source"
        defaultValue={requirement?.source ?? "manual"}
        aria-label="Source"
        className={inputClass}
      >
        {SOURCES.map((source) => (
          <option key={source} value={source}>
            {SOURCE_LABELS[source]}
          </option>
        ))}
      </select>
      <input
        name="weight"
        type="number"
        min={0}
        max={10}
        step={0.5}
        defaultValue={requirement?.weight ?? 1}
        aria-label="Weight"
        className={inputClass}
      />
    </div>
  );
}

function RequirementRow({
  requirement,
  index,
  total,
  organizationSlug,
  jobId,
  canManage,
  onMove,
  onDragStart,
  onDragOver,
  onDrop,
  isDragging,
}: {
  requirement: JobRequirement;
  index: number;
  total: number;
  organizationSlug: string;
  jobId: string;
  canManage: boolean;
  onMove: (from: number, to: number) => void;
  onDragStart: (index: number) => void;
  onDragOver: (index: number) => void;
  onDrop: () => void;
  isDragging: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editState, editAction, editPending] = useActionState<RequirementFormState, FormData>(
    updateRequirement,
    {},
  );
  const [removeState, removeAction, removePending] = useActionState<ActionState, FormData>(
    removeRequirement,
    {},
  );

  // Collapse once the server confirms, so a successful save leaves the list as it found it.
  // Adjusted during render by comparing against the previous result rather than in an effect:
  // useActionState hands back a new object per submission, so the identity check fires exactly
  // once per answer and never schedules a second render pass.
  const [lastResult, setLastResult] = useState(editState);
  if (lastResult !== editState) {
    setLastResult(editState);
    if (editState.done && !editState.error) setEditing(false);
  }

  if (editing) {
    return (
      <li className="bg-surface-sunken/60 px-4 py-4 sm:px-5">
        <form action={editAction} className="grid gap-3">
          <input type="hidden" name="organizationSlug" value={organizationSlug} />
          <input type="hidden" name="jobId" value={jobId} />
          <input type="hidden" name="requirementId" value={requirement.id} />
          <input
            name="requirement"
            defaultValue={requirement.requirement}
            required
            maxLength={500}
            aria-label="Requirement"
            className={inputClass}
          />
          <RequirementFields requirement={requirement} />
          {editState.error && (
            <p role="alert" className="text-sm text-destructive">
              {editState.error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={editPending}
              className="h-9 rounded-md bg-accent px-3.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-accent-strong disabled:cursor-progress disabled:opacity-70"
            >
              {editPending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="h-9 rounded-md border border-border bg-surface px-3.5 text-sm font-medium transition-colors duration-150 hover:border-border-strong"
            >
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li
      draggable={canManage}
      onDragStart={() => onDragStart(index)}
      onDragOver={(event) => {
        if (!canManage) return;
        event.preventDefault();
        onDragOver(index);
      }}
      onDrop={(event) => {
        if (!canManage) return;
        event.preventDefault();
        onDrop();
      }}
      onDragEnd={onDrop}
      className={`flex flex-wrap items-start gap-x-4 gap-y-3 px-3 py-3.5 transition-[background-color,opacity] duration-150 hover:bg-surface-sunken/60 sm:px-4 ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      {canManage && (
        <span
          aria-hidden
          title="Drag to reorder"
          className="mt-0.5 cursor-grab text-muted-foreground/60 transition-colors duration-150 hover:text-muted-foreground active:cursor-grabbing"
        >
          <GripIcon />
        </span>
      )}

      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          aria-hidden
          className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
            requirement.importance === "required" ? "bg-accent" : "bg-border-strong"
          }`}
        />
        <div className="min-w-0">
          <p className="text-sm break-words">{requirement.requirement}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="rounded bg-surface-sunken px-2 py-0.5 text-[11px] text-muted-foreground">
              {CATEGORY_LABELS[requirement.category]}
            </span>
            <span
              className={`text-[11px] font-medium ${
                requirement.importance === "required" ? "text-accent-strong" : "text-muted-foreground"
              }`}
            >
              {requirement.importance === "required" ? "Required" : "Preferred"}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
              weight {requirement.weight}
            </span>
            {requirement.source === "ai" && (
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {SOURCE_LABELS.ai}
              </span>
            )}
          </p>
        </div>
      </div>

      {canManage && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {/* The keyboard path to the same reordering the grip offers a pointer. */}
          <button
            type="button"
            onClick={() => onMove(index, index - 1)}
            disabled={index === 0}
            aria-label={`Move up: ${requirement.requirement}`}
            className="grid size-8 place-items-center rounded-md border border-border bg-surface text-muted-foreground transition-colors duration-150 hover:border-border-strong hover:text-foreground disabled:opacity-30"
          >
            <span aria-hidden>&uarr;</span>
          </button>
          <button
            type="button"
            onClick={() => onMove(index, index + 1)}
            disabled={index === total - 1}
            aria-label={`Move down: ${requirement.requirement}`}
            className="grid size-8 place-items-center rounded-md border border-border bg-surface text-muted-foreground transition-colors duration-150 hover:border-border-strong hover:text-foreground disabled:opacity-30"
          >
            <span aria-hidden>&darr;</span>
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="h-8 rounded-md border border-border bg-surface px-3 text-xs font-medium transition-colors duration-150 hover:border-border-strong hover:bg-surface-sunken"
          >
            Edit
          </button>
          <form action={removeAction}>
            <input type="hidden" name="organizationSlug" value={organizationSlug} />
            <input type="hidden" name="jobId" value={jobId} />
            <input type="hidden" name="requirementId" value={requirement.id} />
            <button
              type="submit"
              disabled={removePending}
              aria-label={`Remove: ${requirement.requirement}`}
              className="h-8 rounded-md border border-border bg-surface px-3 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:border-destructive/40 hover:text-destructive disabled:cursor-progress"
            >
              {removePending ? "Removing…" : "Remove"}
            </button>
          </form>
          {removeState.error && (
            <p role="alert" className="w-full text-xs text-destructive">
              {removeState.error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function RequirementsEditor({
  requirements,
  organizationSlug,
  jobId,
  canManage,
}: {
  requirements: JobRequirement[];
  organizationSlug: string;
  jobId: string;
  canManage: boolean;
}) {
  const [addState, addAction, addPending] = useActionState<RequirementFormState, FormData>(
    addRequirement,
    {},
  );
  const [orderState, orderAction, orderPending] = useActionState<ActionState, FormData>(
    reorderRequirements,
    {},
  );
  const [adding, setAdding] = useState(false);

  // The order shown while dragging. The server remains the authority: whenever it sends a new
  // list, that list wins, which is why both of these are reconciled by comparing against the
  // previous value during render rather than in an effect.
  const [order, setOrder] = useState(requirements);
  const [fromRequirements, setFromRequirements] = useState(requirements);
  if (fromRequirements !== requirements) {
    setFromRequirements(requirements);
    setOrder(requirements);
  }

  const [lastAdd, setLastAdd] = useState(addState);
  if (lastAdd !== addState) {
    setLastAdd(addState);
    if (addState.done && !addState.error) setAdding(false);
  }

  // Which row is in flight. State rather than a ref: it changes what renders.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const orderForm = useRef<HTMLFormElement>(null);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    // Submit on the next frame, once the hidden inputs reflect the new order.
    requestAnimationFrame(() => orderForm.current?.requestSubmit());
  };

  const dirty = order.some((item, index) => item.id !== requirements[index]?.id);

  return (
    <>
      {order.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-border-strong bg-surface-sunken/60 p-8 text-center">
          <p className="font-medium tracking-tight">No requirements yet</p>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-pretty text-muted-foreground">
            These are what candidates will be evaluated against. You define them, and you keep
            control of them.
          </p>
        </div>
      ) : (
        <>
          <ul className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            {order.map((requirement, index) => (
              <RequirementRow
                key={requirement.id}
                requirement={requirement}
                index={index}
                total={order.length}
                organizationSlug={organizationSlug}
                jobId={jobId}
                canManage={canManage}
                onMove={move}
                onDragStart={setDragIndex}
                onDragOver={(over) => {
                  if (dragIndex === null || dragIndex === over) return;
                  const next = [...order];
                  const [moved] = next.splice(dragIndex, 1);
                  next.splice(over, 0, moved);
                  setDragIndex(over);
                  setOrder(next);
                }}
                onDrop={() => {
                  if (dragIndex === null) return;
                  setDragIndex(null);
                  if (dirty) requestAnimationFrame(() => orderForm.current?.requestSubmit());
                }}
                isDragging={dragIndex === index}
              />
            ))}
          </ul>

          {canManage && (
            <form ref={orderForm} action={orderAction} className="sr-only">
              <input type="hidden" name="organizationSlug" value={organizationSlug} />
              <input type="hidden" name="jobId" value={jobId} />
              {order.map((requirement) => (
                <input
                  key={requirement.id}
                  type="hidden"
                  name="requirementIds"
                  value={requirement.id}
                />
              ))}
              <button type="submit" tabIndex={-1}>
                Save order
              </button>
            </form>
          )}

          {canManage && (
            <p
              role="status"
              className={`mt-2 text-xs ${orderState.error ? "text-destructive" : "text-muted-foreground"}`}
            >
              {orderPending
                ? "Saving order…"
                : (orderState.error ?? (orderState.done ? "Order saved." : "Drag, or use the arrows, to reorder."))}
            </p>
          )}
        </>
      )}

      {canManage && (
        <div className="mt-4">
          {!adding ? (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium shadow-sm transition-colors duration-150 hover:border-border-strong hover:bg-surface-sunken"
            >
              <span aria-hidden className="text-base leading-none">
                &#43;
              </span>
              Add requirement
            </button>
          ) : (
            <form
              action={addAction}
              className="grid gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-5"
            >
              <input type="hidden" name="organizationSlug" value={organizationSlug} />
              <input type="hidden" name="jobId" value={jobId} />
              <input
                name="requirement"
                required
                maxLength={500}
                autoFocus
                placeholder="e.g. Five years building production React applications"
                aria-label="Requirement"
                defaultValue={addState.values?.requirement}
                className={inputClass}
              />
              <RequirementFields />
              {addState.error && (
                <p role="alert" className="text-sm text-destructive">
                  {addState.error}
                </p>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={addPending}
                  className="h-9 rounded-md bg-accent px-3.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-accent-strong disabled:cursor-progress disabled:opacity-70"
                >
                  {addPending ? "Adding…" : "Add requirement"}
                </button>
                <button
                  type="button"
                  onClick={() => setAdding(false)}
                  className="h-9 rounded-md border border-border bg-surface px-3.5 text-sm font-medium transition-colors duration-150 hover:border-border-strong"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </>
  );
}

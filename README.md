# Resume Intelligence Platform

An AI-assisted recruitment intelligence platform that converts resumes into evidence-backed candidate evaluations while keeping recruiters in control of hiring decisions.

## Status

```text
Phase 2G — Security & integrity hardening
```

Foundation, Supabase email/password authentication (sign in, protected `/app`, sign out, password recovery), and the multi-tenant database foundation in `supabase/migrations`: customer organizations with memberships, dynamic organization-defined roles over a system-defined permission catalog (users may hold several roles across several organizations), a separate platform-admin control plane, and per-organization service entitlements. Every table is protected by Row Level Security. After sign-in, `/app` resolves the user's workspaces and each tenant workspace lives at `/app/<organization-slug>`, where the user's effective permissions (union of their roles) are loaded once per request. Tenant authorization is permission-based: roles are dynamic bundles of system-defined permission keys (`frontend/src/lib/auth/permissions.ts`), and application guards complement — never replace — RLS. Platform admins (rows in `platform_admins`, independent of any tenant role) use `/platform` to create organizations, activate or suspend them, view the system service catalog and manage each organization's service entitlements; new organizations are provisioned with a protected Organization Admin role by the database. Inside a workspace, members with the right permissions manage access: a member directory, membership activation, multi-role assignment, and dynamic custom roles built from the system-defined permission catalog, while the Organization Admin system role stays fixed. Adding someone takes one email address: an existing TalentIQ account joins immediately, and a new address receives an invitation email, appears under pending invitations (revocable) until the recipient sets their own password and accepts, and joins with no roles assigned. There is still no public sign-up (the hosted project must also have e-mail sign-up disabled; the repository cannot enforce dashboard configuration). An organization that already has someone able to manage both members and roles can never be left without one: membership, role-assignment and role-definition changes are serialised per organization and refused if they would remove the last such manager. No one can hand out a permission they do not hold themselves, so managing members or roles is not a route to becoming an administrator. Role descriptions are bounded by the database, and the tenant tables accept writes only through the permission-checking functions. Pending invitations can be resent or revoked, an address left behind by a revoked invitation can be invited again, and someone who confirmed their e-mail but stopped before choosing a password finds their own pending invitations on `/app`. Resending to a recipient who already confirmed their address sends an account-setup link rather than a second invitation, because Supabase refuses to invite a confirmed address: it establishes a session and the recipient chooses a password once, joining that same pending invitation in the same submission. The invitation is still the only thing that can create their membership, nothing is granted until they ask for it, and an invitation that is no longer theirs costs them nothing. Nobody has to find "forgot password" on their own, and a spent invitation link is never made reusable. Someone opening a first invitation normally has not been through recovery, so `/invite/<invitation>` keeps its own password-and-accept step. Invited accounts are never deleted automatically and no invitation expiry is inferred in the database. The backend still exposes only `GET /health`. No recruitment features are implemented yet.

## Architecture

```text
frontend   Next.js frontend (App Router, TypeScript, Tailwind CSS)
backend    FastAPI backend
supabase   Database migrations and local RLS checks
```

The two applications are independent and are run separately. They do not communicate yet.

## Requirements

- Node.js 20+ and npm
- Python 3.12+

## Local setup

Frontend (terminal 1):

```sh
cd frontend
npm install
npm run dev
```

Serves the app at http://localhost:3000.

Backend (terminal 2):

```sh
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS / Linux
pip install -e ".[dev]"
uvicorn app.main:app --reload
```

Serves the API at http://localhost:8000. Verify with `GET /health` → `{"status": "ok"}`.

## Verification

Frontend lint and production build:

```sh
cd frontend
npm run lint
npm run build
```

Backend tests:

```sh
cd backend
pytest
```

## Database

Schema changes live in `supabase/migrations` and are applied to the hosted Supabase project through the dashboard SQL editor or `supabase db push`. `supabase/tests/rls_checks.sql` applies the migration to a throwaway local PostgreSQL and asserts tenant isolation (see its header for the command).

## Environment variables

The frontend reads `frontend/.env.local`; copy `frontend/.env.example` and fill in the Supabase URL and publishable key. `APP_URL` is the trusted server-side base URL (`http://localhost:3000` locally) and the only source of the destination in an authentication email; the request's `Origin` and `Host` are never used for one. `SUPABASE_SECRET_KEY` is server-only and is used solely by the Supabase Auth Admin client to send first-time member invitations; it must never be exposed to the browser or prefixed with `NEXT_PUBLIC_`. The backend needs none yet.

## Resume processing

Uploading a resume stores a document. Reading one turns it into a candidate profile, and the two are
separate steps on purpose: nothing is read automatically, nothing is read while a page renders, and a
page refresh cannot start a second attempt on a document already in flight.

A recruiter with `jobs.manage` presses **Process** on a row in Resume intake, or **Read N resumes** to
work through everything unread two at a time. The pipeline is:

```text
stored bytes -> document extractor (PDF or DOCX) -> normalized text -> AI provider -> strict parser -> database
```

Each attempt ends in one of five states. Attempts accumulate rather than overwrite one another, so a
failure stays readable after the retry that followed it.

| State | What it means |
| --- | --- |
| Waiting | Created, not started. |
| Processing | In flight. A second attempt is refused while this one can still be alive. |
| Ready for review | Text extracted, profile built, and the person identified by an exact email. |
| Needs review | There is something to look at, but a person has to decide: no readable text, no email or phone to identify anyone, or contact details that disagree with an existing candidate. |
| Failed | The document could not be read, or the provider did not answer. The original file is untouched. |

**Retrying.** A failed or needs-review attempt shows **Retry** on the row and on the profile page. A
successful one does not: nothing may overwrite a profile that was read correctly, and the database
refuses it as well as the interface.

**When a resume has no extractable text.** A scan or a photograph extracts to a few stray characters.
That is reported as *Needs review* with the reason, and no model is asked to invent a profile from
nothing. There is no OCR in this version; the document is kept and can be downloaded and re-made as a
text PDF.

**Evidence.** Every detail on a profile carries a quote, and the application searches the extracted
text for that quote itself rather than trusting the model's claim about it. A quote that cannot be
found is labelled unconfirmed, the page number shown is the page the application found the quote on,
and anything the model produced that is not written in the document at all is dropped before it is
stored.

## Hosted email templates

Both authentication emails must use Supabase's `token_hash` pattern so that verification happens server-side in `/auth/confirm`. This is what lets a link work in a different browser from the one that asked for it, which an account-setup link sent by an administrator always is. The repository cannot enforce dashboard configuration, so set **Invite** and **Reset Password** to:

```text
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&redirect_to={{ .RedirectTo }}
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&redirect_to={{ .RedirectTo }}
```

`/auth/confirm` re-validates `redirect_to` against `APP_URL` and continues only to `/invite/<invitation>` or `/reset-password`, so the template cannot widen where a link may land.

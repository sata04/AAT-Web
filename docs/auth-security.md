# Authentication and security

## The shape of the problem

AAT Web holds a research group's unpublished measurements. The people who use it are a handful of
researchers in one laboratory, not a public sign-up funnel, and the data is the kind that is
embarrassing to lose and worse to leak before publication.

That shape decides almost everything below. There is no open registration, because there is no
population of strangers who should be able to create an account. There is no password, because a
password is a secret a researcher has to keep and a deployment has to store. There is no email
login, no OTP and no magic link, because there is no email address in the system to send one to.
There is no social provider, because no third party belongs in the trust path of unpublished data.

What is left is: **an administrator invites you, and your device is your credential.**

## Better Auth, and what is enabled

Authentication is [Better Auth](https://www.better-auth.com/) 1.6.26 with the Drizzle adapter over
D1, mounted at `/api/auth`. Two plugins are enabled and nothing else:

| Plugin | Why |
| --- | --- |
| `@better-auth/passkey` 1.6.26 | The whole WebAuthn implementation |
| `admin` (built in) | Roles and the ban/disable primitives |

Deliberately **not** enabled, and each one would undo something above if it were:

- `emailAndPassword` — there is no password anywhere in this system.
- social providers — no third party in the trust path.
- magic links, email OTP — there is no address to send to.
- open sign-up — the only way to become a user is to redeem an invitation.

The Admin plugin's role string *is* AAT's role; there is no second vocabulary kept in sync.
Capabilities are derived from the role at request time (see `worker/middleware/authorize.ts`), so
the plugin's own permission statements are not configured — this Worker never asks the plugin "may
this user do X", it asks the capability table.

## Why the hand-written WebAuthn was removed

Until 2026-08, this repository verified attestations and assertions with roughly 780 lines of its
own code: a CBOR parser, a COSE key decoder, and a ceremony verifier. It existed for one reason —
a previous session had been instructed not to add dependencies — and it passed its tests.

Passing tests were never a sufficient reason to keep it. WebAuthn is a security protocol with a
large specification and a long tail of details that only matter when an attacker is exercising
them; a per-project implementation of one is a liability that grows quietly, because the failure
mode is not a crash, it is an acceptance that should have been a refusal. The tests proved that the
implementation did what its author expected, which is exactly the thing an implementation error
also does.

The official plugin now owns: challenge issuance, the signed challenge cookie, the single-use
verification row, attestation and assertion verification (through `@simplewebauthn/server`), and
the passkey table. `@simplewebauthn/server` is the plugin's dependency, not AAT's — nothing in this
repository imports it directly, and it is not a direct dependency.

`worker/auth/passkey-plugin.ts` still exists, and the boundary is worth being precise about: it
contains **no WebAuthn protocol code**. What it contains is invitation redemption, the synthetic
identity, role assignment, the audit trail, rate limits, and the policies below. If the passkey
plugin were replaced tomorrow, everything in that file would still make sense.

### Four places the plugin's defaults are not AAT's policy

These are restated in `passkey-plugin.ts` rather than inherited, and each has a test.

1. **`origin` is configured, never taken from the request.** Left unset, the plugin falls back to
   `ctx.headers.get('origin')` — which would let the caller nominate the origin its own ceremony is
   checked against. The configured list is passed explicitly.
2. **User verification is re-imposed at both seams.** The plugin calls SimpleWebAuthn with
   `requireUserVerification: false` for both registration and authentication. A credential that
   proves only *presence* proves that somebody touched the device, not that its owner did. The
   `userVerified` flag is checked in `afterVerification` on both paths.
3. **The ban check runs before a session exists.** `POST /passkey/verify-authentication` creates a
   session without consulting `user.banned`; the authentication seam refuses first, so a banned
   user never receives a cookie.
4. **The last-passkey rule guards the plugin's own delete endpoint.** See below.

A rejected ceremony is also translated from `500` to `400` on the way out. The plugin wraps every
SimpleWebAuthn refusal — wrong relying party, untrusted origin, stale challenge — as
`INTERNAL_SERVER_ERROR`. Those are the *expected* answers on a credential endpoint: anybody on the
internet can produce one at will, so leaving them as server errors means an alerting threshold that
strangers can cross.

## Invitation-only onboarding

```
Admin creates invite
        ↓  256-bit one-time secret; only its hash is stored
user opens /register?token=…
        ↓  token exchanged immediately, URL scrubbed
short-lived opaque registration context
        ↓  GET /passkey/generate-register-options?context=…
        ↓  POST /passkey/verify-registration
resolveUser validates the context      → who is this ceremony for?
afterVerification                      → spend invitation, create user, open session
        ↓
passkey stored by the official plugin
```

The invitation token is generated with 256 bits of entropy and **only its hash is stored**, so the
database cannot hand back a working invitation link — not to an administrator, not to an attacker
who reads the table. It can be shown exactly once, at creation.

### The two seams, and why the work is split the way it is

`registration.requireSession` is `false`, which removes the plugin's session middleware from
`generate-register-options` and lets it accept an opaque `context` parameter. That is what makes
passkey-first registration possible at all: the first thing an invited researcher does is register,
and they have no session and no way to get one.

**`resolveUser` only reads.** It decides which identity the ceremony is for and nothing else. A
ceremony that is then abandoned — the researcher dismisses the platform prompt, which is common and
blameless — must leave the invitation redeemable.

**`afterVerification` spends the invitation**, after the attestation has verified and before the
plugin writes the credential row. The ordering inside it is load-bearing:

1. checks that consume nothing (user verification, duplicate credential, the identity the context
   implies);
2. `consumeInvitation` — a single conditional `UPDATE`, so two ceremonies racing one invitation have
   exactly one winner and the loser is refused before creating anything;
3. create the user, record the link, audit, open the session;
4. return, and let the plugin store the credential.

Throwing anywhere in step 1 aborts with the invitation untouched. Only a failure *after* step 2 can
burn an invitation without producing a user, and that is the deliberate trade: the alternative
ordering — create the user first — can produce two users from one invitation, which is
unrecoverable.

One subtle check deserves naming. The identity the context implies must equal the identity the
ceremony was started for. Without it, a caller holding a valid context could sign in as somebody
else first, let the plugin prefer that session, and reach `afterVerification` with a user the
invitation never named — spending the invitation against the wrong account.

### Claims expire; invitations do not disappear

An invitation that has been claimed but not completed sits in `status = 'claimed'` with a
`claim_expires_at` ten minutes out. The claiming `UPDATE` treats an expired claim as redeemable
again, so a researcher who starts registration and closes the tab is not locked out permanently and
an administrator does not have to reissue anything.

## The synthetic address

Better Auth's user model requires a unique `email`. AAT collects none, so every user gets a
deterministic, non-routable address derived from their opaque id:

```
<opaque-user-id>@aat.invalid
```

`.invalid` is reserved by RFC 2606 precisely so that it can never be delegated or resolved, which
is the property that matters: a future bug that tries to send mail has nowhere to send it.

The rules around it are absolute. AAT never asks a user for a real address, never displays the
synthetic one as identity, never sends mail, never uses it for login and never uses it for
recovery. `toPublicUser()` omits `email` **by construction** — it is an artefact of the framework's
data model, and putting it in a response would make it an identity. The human identity everywhere
in the UI is the AAT display name.

Two things are deliberately *not* done to satisfy the framework: no random password is invented
(a password nobody knows is still a password an attacker can attack), and the Admin plugin's
`createUser` is not used, because it demands email, password and name from the caller and would
reintroduce exactly the onboarding path this design removes.

## Relying-party id and trusted origins

`AAT_RP_ID`, `AAT_TRUSTED_ORIGINS` and `BETTER_AUTH_URL` are **secrets, not vars**, and a missing
one is a startup error rather than a default.

Nothing security-relevant is inferred from the request. Deriving the RP ID from the `Host` header —
a client-supplied string — would let anyone who can route a request at the Worker choose the RP ID
a ceremony runs under. And an RP ID mismatch is not a soft failure: **a credential registered under
one RP ID is never offered again under another.** Getting it wrong looks precisely like every user
simultaneously losing their authenticator, with no migration path. Treat `AAT_RP_ID` as permanent
from the first registration onward.

Trusted origins are compared by **equality, never by suffix**. A suffix comparison is how
`aat.example.ac.jp.attacker.test` becomes a trusted origin.

Credentials are discoverable (`residentKey: 'required'`, `userVerification: 'required'`), so
sign-in needs no username and the server never has to publish which credentials exist for an
account in order for one to be offered. The authentication options endpoint returns an empty
`allowCredentials` for exactly that reason: a populated list on an unauthenticated endpoint is an
account-enumeration oracle.

## Multiple passkeys, and the deletion guard

A signed-in user may add further credentials to their own account; the plugin prefers a live
session over the invitation path, so no invitation is involved. The session is re-checked at
verification rather than assumed, because the plugin reads it at options time and again at verify
but only refuses on a *mismatch* — a session that expired between the two would otherwise leave the
challenge cookie as the sole credential.

**A user may not delete their last passkey.** With no password, no email and no social login, the
last passkey *is* the account: removing it does not lock somebody out temporarily, it destroys
their access with no self-service way back. The plugin's own `delete-passkey` endpoint does not
enforce this, so a `before` hook does. Three doors lead to deletion — the plugin's endpoint, AAT's
own `/me` route, and the administrative route — and all three enforce the one policy.

## Administrator-assisted recovery

There is no self-service recovery, because self-service recovery requires a second channel and this
system has none by design.

An administrator starts recovery for a user, which revokes that user's sessions and issues a
one-time recovery URL. The URL is shown **once, at creation**; only its hash is stored, so it
cannot be retrieved later by anybody. Redemption follows the same path as registration — immediate
exchange, URL scrubbing, single use — with one difference: the invitation names an existing user,
so `resolveUser` returns that id, no user is created, and the plugin populates `excludeCredentials`
with the credentials the user already has so their authenticator does not silently mint a duplicate.

## Sessions

Sessions last two weeks and slide forward a day at a time while in use. Cookies are issued through
Better Auth's own `setSessionCookie`, including on the registration path, so there is one cookie
implementation in this system rather than two that drift.

Session revocation is available to the user (`/security`) and to an administrator, and is part of
the recovery procedure rather than an optional extra: recovering an account whose old sessions are
still live has recovered nothing.

## Authorization: capabilities, not role comparisons

Authorization is three questions, in order (`worker/middleware/authorize.ts`):

1. **Is there a caller?** — session or no session.
2. **May they do this at all?** — a capability derived from the role.
3. **May they do it to *this*?** — `requireRun` / `requireRevision` / `requirePosterFigure` /
   `requireObjectAccess`, each naming the level it needs.

`role === 'Admin'` scattered through handlers is how an authorization model rots: the day a fourth
role appears, every one of those is a bug the compiler cannot find. Capabilities are middleware, so
the route table is where authorization can be read.

Since 2026-08-13 this deployment is **one team's shared workspace** — everyone who can register is
a member of one research group, and a signed-in researcher can see and reuse a colleague's
analysis:

| Capability | Meaning | Viewer | Researcher | Admin |
| --- | --- | --- | --- | --- |
| `workspace:read` | May read any member's work | no | yes | yes |
| `workspace:annotate` | May annotate any member's work | no | yes | yes |
| `workspace:destroy` | May destroy any member's work | no | no | yes |

Two doors deliberately did **not** widen. Creating a revision and uploading a snapshot remain
owner-only, administrator included, because both write into somebody else's provenance chain, where
"who analysed this, with what settings" must keep exactly one answer. Reusing a colleague's data
means reading their snapshot, not appending to their history.

## Refusals do not confirm existence

A resource that exists but is out of reach answers `RESOURCE_NOT_FOUND`, never `FORBIDDEN`. A 403
on another user's id confirms that the id exists, which turns an id space into an enumeration
oracle — and that matters more under the shared-workspace policy, not less, because a Viewer must
not learn that a colleague's run exists.

Every id is an opaque ULID for the same reason. Sequential integers leak how many users exist and
how many runs a colleague has uploaded, and they make an IDOR probe a matter of counting.

The sharpest form of this property is asserted in `test/worker/authorization.spec.ts`: a Researcher
who *can* read a run must receive an answer identical to a nonexistent id when they attempt to
delete it.

## Audit

`audit_logs` records authentication events, invitation lifecycle, administrative actions and
cross-user access. Entries about an owned resource carry `target_owner_user_id` — **including when
it equals the actor**, so that the field's absence is never itself the signal — and a `crossUser`
marker when actor ≠ owner. Reading a colleague's measurements is exactly the event an audit log
exists for.

Failed sign-ins are recorded from an `after` hook, which is the only place a ceremony refused
*inside* the plugin can still be logged; a failed sign-in that leaves no trace is one nobody can
investigate. Failures AAT's own seam raised are skipped there, because it has already written a row
naming the actual reason and a second row saying "ceremony_failed" would make the log less true.

**No secret is ever written to the log.** A failed redemption records that a redemption failed and
from where — never the token that was presented, and never its hash.

## Rate limits

Both halves of every ceremony are counted, not just the verify: issuing options writes a
verification row and sets a cookie, so an unlimited options endpoint is a cheap way to make a
database expensive. Limits are keyed by client address, never by the secret being presented.

## The client's share of this, which is small

Client-side route guards are **UX only**. Worker authorization is authoritative, and every test of
an authorization rule exercises the Worker, not a screen.

The one genuinely security-relevant thing the browser does is the invitation exchange. The
registration screen reads the token from the URL, exchanges it immediately, and scrubs it from the
address bar with `history.replaceState` **before anything else can observe it** — not after the
ceremony completes, by which time a back button, a bookmark or a shared screenshot has already
leaked it. The raw token never enters React state that outlives the exchange, never reaches
storage, never reaches an error path and is never logged.

## Bootstrapping the first administrator

A fresh deployment has no administrator, and therefore nobody who can issue the first invitation.
The procedure is in [`deployment.md`](./deployment.md): insert one invitation row directly into D1
and redeem it immediately. It is a deliberate manual step performed once, not an endpoint — an
endpoint that mints an administrator is an endpoint an attacker would very much like to find.

## What is tested

`apps/web/test/worker/` runs inside workerd against a real local D1 with the committed migrations
applied, because the invitation race, the quota reservation and the poster uniqueness constraint
are properties of SQL statements — a mocked database would test the mock.

The authentication suite covers, among others: the configured relying party rather than one the
request named; a registration signed for another relying party; a registration from an untrusted
origin; a challenge this server never issued; replay of a consumed ceremony; a credential proving
presence but not user verification, at both registration and sign-in; an assertion whose signature
counter did not advance; a banned user refused before any session exists; an invitation that must
survive a refused attestation; two ceremonies racing one invitation producing exactly one user; the
last-passkey guard through both AAT's route and the plugin's; recovery adding a credential without
creating a second account; and session revocation.

The aim is to test AAT's integration and configuration, not to re-test SimpleWebAuthn's internals.

## Related documents

- [`web-architecture.md`](./web-architecture.md) — why local analysis is the product
- [`cloud-data-model.md`](./cloud-data-model.md) — ownership, quotas and the deletion lifecycle
- [`deployment.md`](./deployment.md) — secrets, RP ID and the bootstrap procedure
- [`supply-chain.md`](./supply-chain.md) — how a dependency such as the passkey plugin is admitted

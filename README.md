# PG Ledger

A tenant / rent / accounts management app for a single-owner PG (paying-guest)
property with ~80 tenants across multiple floors. Built to the "Ledger" UI
direction you picked, and to the CRUD rules we designed — most importantly,
**rent charges are waived, never deleted**, so a due you zero out stays zero
even after the page reloads or the month's charges are regenerated.

## Why this stack

This was originally planned as Next.js + Prisma + Tailwind (see the
[blueprint artifact](https://claude.ai/code/artifact/aa9c18ae-569f-4103-b050-daaff4b661e9)).
While building it, the sandbox this was developed in turned out to have the
npm registry blocked, so nothing installable via `npm install` was reachable
— not Next.js, not Prisma, not Tailwind. Rather than hand you a half-built
app, this was rewritten with **zero npm dependencies**: plain Node.js
(`http`, `crypto`, `node:url`) talking to PostgreSQL by shelling out to the
`psql` CLI. Every piece — routing, HTML rendering, auth, SQL — is hand-written
and readable, nothing hidden behind a framework.

The upside: it runs anywhere Node + PostgreSQL run, with no `node_modules`,
no build step, no version drift. The tradeoff: no ORM type-safety and no
component framework. Given this is a single-owner internal tool, that trade
is a reasonable one — see "Moving to a real driver" below if you'd rather
swap in `pg` once you're on Oracle Cloud with normal internet access.

## What's in here

```
sql/schema.sql        Database schema (floors, rooms, tenants, rent_charges,
                       payments, accounts, account_transactions, expenses)
scripts/migrate.js     Applies sql/schema.sql
scripts/seed.js        Wipes and loads realistic demo data (32 tenants,
                        mixed paid/partial/overdue/waived charges)
src/db.js               Talks to Postgres via the psql CLI
src/auth.js              Login/session handling (scrypt password hashing)
src/render.js             Shared HTML layout + design tokens (the "Ledger" look)
src/repo.js                All business logic — this is the file to read to
                            understand the waive/void rules
src/pages/*.js               One file per screen (dashboard, floors, tenants,
                              rent collection, accounts, expenses, users) —
                              rent.js also has the "Manage this due" detail
                              page
src/server.js                 The HTTP server + routes
e2e/test.mjs                   Playwright end-to-end test (154 checks, desktop
                                + mobile viewport) that exercises every action,
                                including the exact waive → reload →
                                still-waived regression test
```

## Running it locally

Prerequisites: Node.js 18+, PostgreSQL running locally.

```bash
# 1. Create a database + user (adjust to your setup)
sudo -u postgres psql -c "CREATE USER pgledger WITH PASSWORD 'pgledger_dev_pw';"
sudo -u postgres psql -c "CREATE DATABASE pgledger OWNER pgledger;"

# 2. Set connection env vars (or edit the defaults in src/db.js)
export PGHOST=localhost PGPORT=5432 PGUSER=pgledger PGDATABASE=pgledger PGPASSWORD=pgledger_dev_pw

# 3. Create the schema
npm run migrate
# Already have a database from an earlier version of this app? Re-running
# `npm run migrate` is always safe — it re-applies sql/schema.sql, which
# only ever adds what's missing (new tables/columns), never drops data.

# 4. Load demo data (32 tenants, mixed payment states) — optional, but
#    handy to see the app populated. Skip this and the app just starts empty.
npm run seed

# 5. Start the server
npm run dev
# -> PG Ledger listening on http://localhost:3000
```

Log in with `owner@pgledger.local` / `change-me-123` (from the seed script —
change this before putting real data in; see "Security notes" below).

## The CRUD rules that matter

This is the part that was specifically designed to fix the bug you
described (a manually-zeroed due reappearing next month/reload):

- **Rent charges are generated idempotently, and only once each tenant's
  own due date arrives.** Every tenant has a "rent due day" (1–28, set on
  the Add/Edit tenant form). Every time the Rent Collection page loads
  (`ensureChargesForMonth` in `src/repo.js`), it checks each active
  tenant: does a charge row already exist for this tenant + this
  year/month? If yes — whether it's `active` or `waived` — it's skipped.
  If not, and it's the current month, the charge is only created once
  today's date has reached that tenant's due day (a tenant due on the
  15th doesn't show up as "due" — or "overdue" — on the 3rd). A tenant
  whose due day hasn't arrived yet shows in a separate "Not due yet this
  month" section on the Rent Collection page, with an **"Add due now"**
  button if you want to raise the due early (someone paying ahead,
  leaving before their usual date, etc.) — that's the manual override,
  and it still refuses to create a second charge for a tenant/month that
  already has one. Either way, a charge is only ever created once per
  tenant per month.
- **"Delete" a charge = waive it, not delete it.** Waiving sets
  `status = 'waived'` and records a reason + timestamp. The row stays in
  the database, so the idempotent check above sees it and never
  regenerates it. You can "Reinstate" a waived charge to put it back to
  normal if you waived it by mistake.
- **"Delete" a payment = void it, not delete it.** Voiding sets
  `status = 'voided'`, records a reason, and inserts a reversing entry in
  the account ledger (so the account balance goes back down). The
  original payment row is never removed — you keep a full audit trail of
  who paid what and what got corrected later.
- **Account balances are always computed, never stored as a running
  number.** Every payment and expense writes a row to
  `account_transactions` (credit or debit); the balance shown is
  `opening_balance + sum(credits) - sum(debits)` computed on the fly. This
  is what makes voiding safe — reverse the transaction and the balance is
  automatically correct.
- **A due's amount can be corrected without waiving it.** An "Edit" action
  on any active (non-waived) charge in Rent Collection lets you change what's
  actually expected that month — a wrong auto-generated figure, a prorated
  partial month, a late fee added on top. The first time a charge is
  edited, its starting amount is kept in `original_amount`, so the row
  shows a small "was ₹X" note rather than silently overwriting history.
  A waived charge has no direct Edit action — reinstate it first, so there's
  never two competing answers for "how much is due right now."

## Icon actions and inline editing on Rent Collection

Each row's actions are now small icons rather than buttons:

- **✎ (pencil)**, next to the Expected amount — click it and the figure
  itself turns into an editable field, right there in the cell, with a
  ✓ to save and a ✕ to cancel. No separate form, no page change.
- **🗂 (Record a payment)** and **⊘ (Waive this due)**, in the Actions
  column — click either and a small popover drops down with just that
  action's fields (amount/account/mode for a payment; a reason for a
  waive), again with ✓ to confirm and ✕ to cancel. A waived row swaps
  these for a single **↺ Reinstate** icon.
- **🕐 (view full history)** stays as a link to the fuller
  `/rent/charge/:id` page — that's still where you go to see every
  payment against this month's due, since a table row has no room for
  that.

All of it is plain HTML/CSS (the "checkbox hack": a hidden checkbox plus a
`<label for>` toggles each popover open and closed — the ✕ Cancel button is
just a second label pointing at the same checkbox), so there's no
JavaScript involved and it works the same on desktop and mobile.

**Voiding a payment** uses this same icon-popover pattern — a small ✕
icon next to any active payment opens a popover with a reason field and
a ✓ to confirm — and it's the *same* `voidPaymentCell()` markup shared
by two places: the "Payments against this due" table on
`/rent/charge/:id`, and a tenant's own profile page (`/tenants/:id`),
so voiding looks and behaves identically wherever you do it, rather than
one place having a polished icon and the other a plain text button.

## Editing and deleting accounts and expenses

Both follow the same rules as everything else money-touching in this app —
correct, don't silently overwrite; waive/void, don't hard-delete once
something real has happened.

- **Editing a payment** — every payment row (on `/rent/charge/:id` and on a
  tenant's own profile) now has an ✎ **Edit** icon next to its ✕ Void icon.
  It opens a popover with the amount, account, and mode. Saving doesn't
  overwrite the payment in place — it reverses the old amount out of the old
  account and re-applies the new amount into the new account (the same
  "reverse, then reapply" pattern the Edit-due-amount feature already used),
  so the account ledger always shows exactly what changed. Because this only
  ever touches the one payment row you opened, editing one leg of a payment
  that was **split across two accounts** leaves the other leg completely
  untouched — each account's own payment stays logged separately, as it
  should.
- **Editing an account** — an ✎ icon on each Accounts card lets you rename it,
  change its type, or correct its opening balance.
- **Deleting an account** — the same smart delete as rooms: an account with
  **zero transactions ever** (added by mistake) is removed outright. An
  account with **any transaction history** is marked **inactive** instead —
  it disappears from every "which account" picker on payments and expenses,
  but its balance and full history stay intact and viewable. An inactive
  account shows a dimmed card with an "Inactive" pill and swaps the ✕ Delete
  icon for a one-click ↺ Reactivate icon.
- **Editing an expense** — an ✎ icon on each Expenses row lets you correct
  the date, category, amount, account, or note.
- **Deleting an expense** — never a hard delete (it already moved money):
  it's voided, and a reversing credit is logged so the account balance goes
  back up. The row disappears from the active list but the ledger keeps the
  full trail.

## Filtering an account's transactions by Credit / Debit

Each account's ledger page (`/accounts/:id`) now has All / Credit / Debit
tabs above the transaction table — the same tab pattern as the floor filters
elsewhere in the app — so you can see just the money that came in, or just
what went out, without scanning past the other kind.

## Filtering expenses by account

The Expenses page has an "All accounts" + one-tab-per-account row above the
table, same pattern as the Credit/Debit tabs and the floor filters — pick an
account to see only what was spent from it, with the Total row at the
bottom recalculating to match. Clicking an expense's own Account cell is a
shortcut to the same filter (jumps straight to that account's tab). Editing
or deleting an expense while filtered keeps you on that filtered view
afterward rather than dropping you back to the unfiltered list —
`GET /expenses?accountId=<id>`, `repo.listExpenses({accountId})`.

## WhatsApp on tenant phone numbers

Everywhere a tenant's phone number is shown (the Tenants list and a tenant's
own profile page), it now has a small green WhatsApp icon next to it. Tapping
it opens `https://wa.me/<number>` in a new tab, which hands off straight to
the WhatsApp app (or WhatsApp Web) with that tenant's chat ready to go — no
need to save the number as a contact first. A bare 10-digit number is
assumed to be Indian and gets the `91` country code prefixed automatically;
the icon only renders at all if the tenant has a phone number on file.

## "Remember me" auto-login

The sign-in page has a **"Remember me on this device"** checkbox. Check it
and sign in, and the email + password are saved in the browser's
`localStorage` on that device; the next time you (or anyone using that same
browser) opens `/login`, the form fills itself in and submits automatically
— no typing needed. Signing out explicitly clears the saved credential (the
standard "remember me" convention: signing out means this device should stop
being auto-trusted). If a stored credential ever fails to log in — a changed
password, say — it's cleared immediately rather than retried, so a stale
saved password can't loop the page forever.

**Worth knowing**: this stores the password in plain text in that browser's
local storage, readable by anyone with devtools access to that specific
browser/device. That's a reasonable tradeoff for a single-owner tool run on
your own device, but it's not something to turn on for a shared or public
computer.

## Which account a tenant paid into

A tenant's Paid amount now shows which account it went to. If a whole
month was paid in one go, you'll see a small "via Cash" / "via UPI
Collect" note under the amount. If it was split across more than one
account (part cash, part UPI, say), the Paid figure becomes a small
dropdown — click it to see the breakdown by account.

## Filtering tenants by floor

The Tenants page now has a second row of tabs — All floors, then one tab
per floor — same pattern as Rent Collection's floor tabs. It composes with
the existing Active/Vacated/All status tabs rather than replacing them: pick
a floor and a status independently (e.g. "Vacated" + "2nd Floor") and each
tab remembers the other filter when you switch it.

## Searching tenants by name or phone

A search box above the Tenants table filters by name or phone (case-
insensitive, matches anywhere in either field) — useful once you're past
the point where scanning the list by eye is realistic. It's a plain HTML
`<form method="get">`, so no JavaScript is involved: typing a name and
hitting Search (or Enter) just reloads the page with `?q=`. It composes
with every other filter already on this page — searching while looking at
"Vacated" + "2nd Floor" keeps both, and switching floor/status tabs while a
search is active keeps the search term too, rather than silently dropping
it. A "✕ Clear search" link appears whenever a search is active.

## Giving notice, and recording a deposit refund when a tenant vacates

Two real gaps, both about the run-up to and aftermath of a tenant leaving:

- **Give notice** (button on an active tenant's profile) records that they
  said they're leaving, and optionally when. This deliberately does **not**
  change the tenant's underlying status — they're still fully "active" as
  far as billing, bed occupancy, and every dashboard count is concerned,
  right up until an actual Vacate. It only changes what pill shows (Notice
  instead of Active) and adds a line under Status showing when notice was
  given and the expected leaving date. **Cancel notice** reverses it back
  to a plain Active tenant. A tenant on notice still shows up under the
  Tenants page's **Active** tab, exactly as before — the point of notice is
  that they haven't left yet.
- **Vacate now also asks for the deposit refund** (amount + date) right in
  the same popover, instead of just flipping status with no record of the
  deposit ever coming back out. It's not required — leave the amount at 0
  and settle it later — and whatever's entered can be corrected afterward
  from a **✎ Refund** popover that appears on the Details card once a
  tenant is vacated (useful when the final figure isn't known until a
  move-out inspection). Before this, the deposit **paid in** was tracked
  but nothing about it going back out ever was.

## Deleting a vacated tenant

Once a tenant is **vacated**, their profile page (and their row on the
Tenants list, when the Vacated tab is showing) gets a **Delete** action in
place of Edit/Vacate — for someone who's genuinely done and just clutters
the Vacated list over time.

This only ever appears for a vacated tenant — an active or notice-period
tenant has to be vacated first, same two-step convention as everything else
in this app that removes something. Unlike almost every other "delete" in
this app, this one is a real, permanent removal: it deletes the tenant's
profile along with their rent charge and payment history rows, and it
can't be undone (the confirmation dialog says so). The one thing it
deliberately leaves untouched is the accounts ledger — every payment they
ever made already has its own row in `account_transactions`, and account
balances are computed from that table, not from the payment rows — so
deleting a tenant never changes any account's balance or its transaction
history, only the tenant-level detail behind it.

## Managing a tenant's dues from their own profile page

The **Rent charge history** card on a tenant's profile page now does more
than list past months — you can manage a due right there instead of going
to Rent Collection:

- **+ Add due** opens a small month/year picker and creates a rent charge
  for that tenant for whichever month you choose — the same underlying
  action as "Add due now" on the Rent Collection page's "Not due yet"
  section, just reachable straight from the tenant you're looking at. Handy
  for adding a due early (a tenant leaving before their usual due day) or
  for a month that's not showing yet.
- **🗂 Record a payment**, **✎ Edit amount**, and **⊘ Waive** are icon
  popovers on each row, same pattern as everywhere else in the app (Rent
  Collection, Accounts, Expenses) — record a payment enters what was
  actually paid (amount/account/mode) against that due without leaving the
  tenant's page; edit corrects the expected figure (prorating, a late fee,
  a discount) without losing the original amount; waive zeroes it out
  without deleting the row. A waived row swaps all three for a one-click
  **↺ Reinstate**. To correct a payment already entered (wrong amount, wrong
  account), that's the ✎ icon on the payment itself in the **Payments**
  card lower on the same page — see "Editing a payment" above.
- Each row's **Status** now shows the due's real state — **Paid**,
  **Partial**, **Overdue**, or **Waived** — computed the same way as Rent
  Collection (expected vs. what's actually been paid against it), instead
  of the flat "Active" label the raw database status used to show for
  every unpaid due (the `rent_charges.status` column only ever holds
  `active` or `waived` — it was never meant to describe payment progress on
  its own, so showing it directly was misleading).
- The **Details** card also gained a quick **✎ edit on Monthly rent** —
  a lighter-weight sibling to the full Edit Tenant form for when only that
  one figure needs changing. Same rule as everywhere else in this app that
  touches an ongoing figure: it only affects **future** auto-generated
  charges — anything already billed (this month's due, if it's already been
  created) is untouched, so past history never silently changes underneath
  you. The popover says so right under the input.

## Clicking a room shows its tenants

Every room number on the Floors & Rooms page is now a link — click it and
you land on the Tenants page filtered to just that room, with a small
banner ("Showing tenants in Ground Floor · Room G01") and a **✕ Clear room
filter** link to get back to the full list. It opens with the **All**
status tab (not just Active), so a room with only past/vacated tenants
still shows something instead of a confusing empty page. The room filter
composes with the existing status and floor tabs the same way floor and
status already compose with each other — switching tabs while looking at
one room's tenants keeps that room filter until you explicitly clear it.
`repo.listTenants` gained a `roomId` option (`GET /tenants?roomId=<id>`).

## Accounts income summary, and floor performance on the Dashboard

Two additions modeled on the summary tables in the owner's own tracking
spreadsheet:

- **Accounts page → "Income by account"**: a table above the account cards
  listing every account's **total income** — the sum of everything ever
  credited into it (rent payments, plus any credit-side corrections) — with
  a **Total** row at the bottom. This is deliberately a different number
  from the balance shown on each account's card below it: a card's balance
  is opening balance + credits − debits (so it drops when that account pays
  an expense), while "income" here is the credit side only, matching what
  the spreadsheet's "Collection" column tracks per account. Clicking an
  account name still goes to its full transaction ledger (filtered to
  Credit), same as before.
- **Dashboard → "Floor performance"**: the existing per-floor table gained
  a **Difference** column (Actual − Expected, negative in red when short,
  positive in green when a floor collected more than expected) plus **Total**
  and **Outstanding** summary rows underneath the floor list — matching the
  shape of the spreadsheet's own Performance table (floors, Expected,
  Actual, Difference, then a Total and an Outstanding line). This lives on
  the Dashboard rather than a new page because it was already the natural
  home for floor-level collection data — `floorPerformance()` already
  existed and was already feeding a simpler version of the same table.

Both are computed live from the app's own data every time the page loads
— not a one-time import of the spreadsheet's frozen numbers — so they stay
correct as new payments, expenses, and dues come in.

## Dashboard "Coming up" — dues about to land, and tenants on notice

The Dashboard's KPI tiles only ever told you about **this month, as of
now** — collected, outstanding, occupancy. There was nothing forward-
looking. A new **Coming up** card sits right under those tiles with two
panels, side by side:

- **Dues in the next 3 days** — tenants whose current-month rent charge
  hasn't been generated yet (because their due day hasn't arrived), sorted
  soonest-first, each showing the amount and "today" / "tomorrow" / "in Nd".
  This relies on the Dashboard's existing `ensureChargesForMonth()` call
  having already run first, and on due days being capped 1–28 (both already
  true everywhere else in the app), so there's no month-wraparound edge case
  to worry about.
- **On notice** — every tenant currently flagged as having given notice
  (see below), with their expected vacate date, and a count of how many are
  **vacating this month** highlighted in the panel's heading.

Both lists link straight through to the tenant's profile, same as Recent
payments does. Either panel shows a plain "nothing right now" line when
empty, rather than an empty table.

## Users — adding a second (or third) login

The `users` table always technically supported more than one login — there
was just no screen to add one. A new **Users** page (linked from the bottom
of the sidebar / mobile drawer, next to Sign out) now covers it:

- **Add a login** — name, email, password. Meant for a manager or family
  member who helps run the place and should have their own sign-in rather
  than sharing the owner's.
- The list shows every login with when it was added. The one you're
  currently signed in as is marked **(you)** instead of getting a delete
  icon — you can't remove your own login from under yourself.
- Deleting a login also ends any of its active sessions immediately.
- A duplicate email is rejected with a plain-language error, and the last
  remaining login can't be deleted (the app always needs at least one).

There is deliberately **no public sign-up page anywhere in this app.** A
new login can only ever be created by someone who is already signed in,
from this page.

## Editing and deleting rooms

Each room on the Floors & Rooms page now has its own actions:

- **✎ Edit room** opens a small popover (same pattern as Rent Collection's
  Pay/Waive) with the room number, sharing type, and rent per bed — change
  any of them and ✓ to save. Reducing the sharing type below the highest
  currently-occupied bed is refused with a clear error (e.g. you can't drop
  a 4-sharing room to 2-sharing while beds 3–4 are occupied).
- **✕ Delete room** follows the same "waive/void, not delete" philosophy as
  rent charges and payments, and picks the right behavior automatically:
  - A room that's **never had a tenant** (added by mistake, say) is deleted
    outright — nothing to lose.
  - A room with **past tenants but nobody active right now** is marked
    **inactive** instead of removed — it disappears from the Add/Edit
    Tenant room pickers so nobody gets assigned there, but its history
    (past tenants, their rent charges and payments) is kept intact.
  - A room with **active tenants right now** refuses to delete at all, with
    an error telling you to vacate or move them first.
- An inactive room shows a small "inactive" pill and swaps the ✕ Delete
  icon for a one-click **↺ Reactivate** icon, in case it was deactivated by
  mistake or the room's back in use.

## Mobile design

The whole app is responsive, adapting the same screens rather than
shipping a separate mobile app.

- **Below ~860px wide**, the left sidebar hides and a bottom tab bar takes
  over — Home, Tenants, a raised center button for Rent Collection (the
  action used most day-to-day), Accounts, and **More**.
- **"More" opens the pages side drawer** — a full panel that slides in from
  the right listing every page (the same list the desktop sidebar shows:
  Dashboard, Floors & Rooms, Tenants, Rent Collection, Accounts, Expenses),
  with the current page highlighted, plus Sign out at the bottom. Tap "More"
  again, tap the ✕ in the drawer, or tap the dimmed area behind it to close
  it. Built on the same CSS "checkbox hack" as the icon popovers below — a
  hidden checkbox holds the open/closed state and any `<label for>` toggles
  it — so this is a real slide-in drawer with no JavaScript.
- **Every table** (Rent Collection, tenant lists, payment/charge history,
  account ledgers, expenses, rooms) switches from a wide grid to stacked
  cards on narrow screens — each cell keeps its column label so nothing
  needs a horizontal scroll or a squint. This is a plain CSS technique
  (`data-label` attributes + a `table.responsive` media-query rule), not
  JavaScript, in keeping with the rest of the app.
- **Tenant identity on the Tenants and Rent Collection cards** — on a phone,
  the tenant's name now renders as its own bold header at the top of the
  card, with the room folded in underneath as a small subtitle, instead of
  being just another "Name: …" line the same size and weight as everything
  else. This was a direct fix for stacked cards being hard to tell apart at
  a glance — the separate Room field is hidden on mobile only (it's now
  redundant with the subtitle) while staying exactly as it was in the
  desktop table.
- **Multi-column layouts** (the dashboard's KPI tiles, the Details / Charge
  history / Payments row on a tenant's profile, multi-field forms) collapse
  to fewer columns, then one, as the screen narrows.
- The icon popovers described above work the same way on a phone — tap the
  pencil or an action icon and the field or form opens right in the card.
- **Icon buttons grow to a bigger tap target on touch-sized screens** —
  26×26px on desktop (fine for a mouse pointer), 32×32px under the 700px
  breakpoint, so Pay/Waive/Edit/Void icons are easier to hit with a
  fingertip without changing how they look on desktop.
- The **sign-in page** never overflows on a narrow phone — its box caps at
  the viewport width instead of a fixed 340px, so it still fits on the
  smallest phone screens.
- This isn't just Rent Collection: Floors & Rooms, Tenants (list, add,
  edit, profile), Accounts, and Expenses were all audited the same way —
  every table stacks into cards, every "+ Add…" form wraps its fields
  instead of overflowing, and none of them force a horizontal scrollbar
  at a phone width.

## A note on NULL vs empty string in this DB layer

Because this app talks to Postgres via `psql --csv` rather than a real
driver (see "Why this stack"), a `NULL` column and a column holding an
empty string `''` both come back from a query as `""` — the CSV output
doesn't distinguish them. This tripped up the "Edit due amount" feature
during testing: every charge's `original_amount` is `NULL` until it's
edited, but a naive `!== null` check saw the empty string psql returns
for `NULL` and treated it as "already has a value", showing a bogus "was
₹0" note on every single row. Fixed with a `hasValue()` helper in
`src/db.js` (treats `null`, `undefined`, and `""` all as "not set") — use
it instead of `!== null` anywhere you check whether an optional column
was ever written, and keep that in mind if you extend the schema with
more nullable columns later (or swap in the real `pg` driver on Oracle
Cloud, which won't have this quirk at all).

The same "everything is a string" quirk bit the Accounts feature during
this round: `accounts.is_active` is a real Postgres `boolean`, but `psql
--csv` hands it back as the literal string `"t"` or `"f"` — and in
JavaScript, both of those strings are truthy, so a naive `a.is_active ? … :
…` treated every account as active regardless of its real state. Fixed by
comparing explicitly (`a.is_active === "t"`) wherever an account's active
state is displayed — same lesson as `hasValue()`: nothing that comes back
from `query()`/`one()` is ever a real boolean or number, only a string, so
compare against the exact string psql sends, not JS truthiness.

## What was tested (browser, end-to-end)

`e2e/test.mjs` drives a real Chromium browser (Playwright) through the app
— once at a desktop viewport (1440×900), once at a phone viewport
(390×844) — and checks 154 things, including:

- Login (correct + incorrect password), logout, and that every page
  redirects to `/login` when not authenticated.
- **Room edit/delete/reactivate**: adding a room, editing its number/sharing/
  rent via the popover, then deleting it (a room with no tenant history is
  removed outright). Separately: assigning and then vacating a tenant in a
  different room, confirming a delete on that room *deactivates* it instead
  (past history kept), confirming the inactive pill + Reactivate icon show up,
  reactivating it, and confirming a currently-occupied room (still has active
  tenants) refuses to delete at all with a clear error.
- **Floor filter on Tenants**: the floor tabs show up alongside the status
  tabs, filtering to just that floor's tenants; switching the status tab
  while floor-filtered keeps the floor filter, and "All floors" clears it
  while keeping the status tab.
- Adding a tenant to a specific room/bed, and that an already-occupied bed
  shows as disabled in the picker.
- Editing an existing tenant's details (name, phone, occupation, emergency
  contact, rent, deposit, due day, and reassigning their room/bed) from an
  "Edit" button on their profile, with the same occupied-bed check as
  adding a new tenant — and confirming past rent charges and payments are
  untouched by an edit (only the tenant record itself changes; billing
  history is never rewritten).
- Due-date-gated charge generation: confirming a tenant whose due day
  hasn't arrived yet this month shows up in "Not due yet this month" (not
  as a due, and not as overdue), using the manual "Add due now" button to
  raise their due ahead of schedule, and confirming they then move into
  the normal Rent Collection table and drop out of the "not due yet" list.
- Editing a due's amount inline — clicking the pencil next to Expected,
  typing a new figure, and confirming with ✓: the row shows the new
  figure and a "was ₹X" note, a page reload keeps the edited amount
  (doesn't regenerate the original), the tenant's rent charge history
  shows the same adjustment note, and a waived row has no pencil icon at all.
- **The core regression test**: waiving an overdue ₹6,500 charge via the
  row's waive icon, then reloading the Rent Collection page twice and
  confirming it's still ₹0 outstanding / "Waived" — not regenerated. Then
  reinstating it with the one-click ↺ icon and confirming it goes back to
  "Overdue" with Pay/Waive/Edit icons restored.
- Recording a payment via the row's pay icon (status flips to "Paid",
  showing "via <account>"), then recording a second payment against the
  same charge from a **different** account and confirming the Paid figure
  turns into a "2 accounts" dropdown that breaks down the amount by
  account. Voiding one of those payments via its own ✕ icon on the "view
  full history" page (confirming the charge reverts to "Overdue"), then
  voiding the tenant's other remaining payment from their **profile
  page** instead — proving both places share the same icon-based Void
  popover rather than one having a plain text button.
- Accounts page and per-account transaction ledger rendering, plus the
  Credit/Debit filter tabs on an account's ledger page (filtering to
  Credit shows only Credit rows, filtering to Debit shows only Debit rows).
- **Account CRUD**: adding a throwaway account, editing its name via the
  popover, then deleting it (zero transactions ever → removed outright).
  Separately, deleting an account **with** transaction history (Cash, used
  by the test payments above) and confirming it's deactivated instead —
  inactive pill shown, ✕ Delete swapped for ↺ Reactivate — then reactivating
  it and confirming the Delete icon comes back.
- **Editing one leg of a split payment**: on the charge-detail page, after
  a charge was paid from two different accounts, editing just one of those
  two payment rows (new amount + account) and confirming only that row's
  amount changed — the other account's payment on the same charge is
  untouched.
- Logging an expense and seeing it in the list + total, then **editing**
  its category/amount via the popover and **deleting** it (removed from the
  active list — voided under the hood, not hard-deleted).
- A tenant's phone number showing a WhatsApp icon that links to
  `https://wa.me/91<number>`.
- **"Remember me" auto-login**: signing in with the box checked stores the
  credentials in `localStorage`; signing out clears them; a stored
  credential auto-submits the login form on the next visit to `/login` and
  lands straight on the dashboard; and a stored-but-now-wrong credential
  fails once and is cleared immediately rather than retried forever.
- **Vacating and then deleting a tenant**: vacating shows the profile
  switching from Edit/Vacate to a Delete button, and the Vacated list
  showing a matching Delete icon on that row. Deleting redirects to the
  Vacated list with a confirmation message, the tenant no longer appears
  anywhere in that list, and their old profile URL now 404s.
- **Mobile**: the sidebar is hidden and the bottom tab bar shows instead;
  the bottom bar's center button opens Rent Collection; rent rows render
  as stacked cards, with the tenant's name as a bold card header and the
  separate Room column hidden (same check repeated on the Tenants list);
  the pencil-edit and pay-popover icons open correctly
  in place without breaking the card layout; tapping "More" opens the pages
  side drawer with all 6 pages and the current one highlighted, clicking a
  page navigates there, and tapping the dimmed overlay closes the drawer.
  Floors, Tenants (list + profile), Accounts (list + detail), Expenses,
  and the sign-in page were all visited at the phone viewport too, each
  one checked for zero horizontal overflow, tables confirmed to render as
  stacked cards, and the "+ Add…" popovers (Add room, Log an expense)
  confirmed to open without pushing the page wider than the screen.
- **Every page checked for horizontal overflow at both viewports** —
  Dashboard, Floors, Tenants, Rent Collection, a tenant's profile,
  Accounts (list + detail), and Expenses never force a horizontal
  scrollbar, on desktop or mobile.
- **Managing a due from the tenant profile page**: adding a due for a
  future month via the +Add due picker creates the right row and shows it
  as Overdue (not a bare "Active"); editing its amount updates the Expected
  figure; waiving it flips the row to Waived and swaps in a Reinstate
  button; reinstating brings back the real Paid/Partial/Overdue status and
  the Edit/Waive icons.
- **Accounts income summary and Dashboard floor performance**: the Accounts
  page's new "Income by account" table is confirmed present with a Total
  row and one row per account (matching the card count below it); the
  Dashboard's Floor performance table is confirmed to carry a Difference
  column and to end with Total and Outstanding summary rows.
- **Editing monthly rent from the tenant profile page**: the Details card's
  inline edit updates the figure shown, confirmed via the popover rather
  than the full Edit Tenant form.
- **Clicking a room to see its tenants**: clicking a room number on Floors
  & Rooms lands on the Tenants page with `roomId` in the URL and a banner
  naming the room; every row shown is confirmed to belong to that room;
  clearing the filter is confirmed to return to the full (larger) list.
- **Filtering expenses by account**: clicking an expense's account jumps to
  that account's filter tab (marked active), every row shown is confirmed
  to be from that account, and clicking "All accounts" is confirmed to
  bring back the unfiltered list including the new expense.
- **Recording a payment from the tenant profile page**: entering a partial
  payment against a due (from the Rent charge history card, not Rent
  Collection) is confirmed to flip its status to Partial with the correct
  reduced Outstanding figure, and the payment is confirmed to appear in
  that tenant's own Payments list right below it.
- **Users — adding and removing logins**: adding a login is confirmed to
  show up in the list; adding one with a duplicate email is confirmed to
  be rejected with a clear message, not a raw database error; the row for
  whoever is currently signed in is confirmed to show "(you)" with no
  delete icon; and removing a different login is confirmed to take it out
  of the list.
- **Dashboard "Coming up"**: the card and both its panel labels are
  confirmed present. Separately, as part of the give-notice test above,
  giving a tenant notice with an expected vacate date in the current month
  is confirmed to surface them on the dashboard under "On notice", with
  the "vacating this month" callout showing.
- **Mobile**: the Users page is confirmed to render with zero horizontal
  overflow, and the drawer footer is confirmed to link to it.

All 154 checks passed. Run it yourself any time against a running server:

```bash
npm run dev &                 # server on :3000
node e2e/test.mjs             # needs `playwright` installed globally
                               # (npm install -g playwright, then
                               #  npx playwright install chromium)
```

## Security notes before you use this for real

- **Change the seed password.** `owner@pgledger.local` / `change-me-123` is
  a demo login. Either edit `scripts/seed.js` before running it against
  real data, or add a "change password" flow later.
- Sessions are a random 32-byte token in an HttpOnly cookie, stored in the
  `sessions` table with a 30-day expiry.
- **Login is now rate-limited.** 5 wrong passwords in a row for one email
  locks that email out for 15 minutes (a 6th attempt is refused outright,
  before even checking the password) — see `src/auth.js`. This is
  deliberately simple: an in-memory counter, keyed by email, that resets
  on every server restart. That's fine for a single-owner app with one
  real login — the realistic threat is someone who already knows the
  owner's email brute-forcing the password, which this stops — but it's
  worth knowing it isn't a distributed/persistent rate limiter, so it
  wouldn't help against, say, a botnet hitting from thousands of IPs.
- **The session cookie now gets `Secure` automatically once you're behind
  HTTPS** — `src/server.js`'s `isHttps()` checks for a direct TLS socket
  or an `X-Forwarded-Proto: https` header (the standard signal a reverse
  proxy like Caddy sends once it's terminating TLS in front of this app,
  per the Oracle Cloud plan below), and only adds `; Secure` to the cookie
  when one of those is true. Nothing to configure — plain `http://localhost`
  during local development keeps working exactly as before, and it starts
  adding `Secure` the moment Caddy (or any TLS-terminating proxy) is put in
  front of it and forwards that header.
- **Additional logins** (Users page) are hashed with `scrypt` the same way
  as the seed login (`src/auth.js`'s `hashPassword`) — never stored in
  plain text — and go through the same rate-limited login path as any
  other email. There is no self-serve sign-up route anywhere in the app;
  a new login can only be created by someone already signed in.
- SQL values are escaped by a hand-written literal-escaping function
  (`lit()` in `src/db.js`), not a parameterized driver. It's been used
  consistently everywhere, but this is worth knowing about since it's a
  different safety model than `pg`'s parameterized queries. See below for
  how to swap to a real driver if you want that peace of mind.

## Which database, and what stack for Oracle Cloud

**Database: PostgreSQL.** It's what's running and tested here. It's also
genuinely the right choice for Oracle Cloud specifically — Oracle's Always
Free tier gives you 2 always-free AMD VM.Standard.E2.1.Micro instances or
the Ampere A1 ARM allowance, and PostgreSQL runs natively and well on
either, with no licensing cost (unlike Oracle's own database product,
which is a different thing and not what you'd want here).

**Tech stack for Oracle Cloud — once you have normal internet access
there (unlike this sandbox):**

- **Keep PostgreSQL** — install it directly on the VM, or run it in Docker.
  Either is fine at 80-tenant scale (this is a tiny dataset — tens of
  thousands of rows a year, not millions).
- **Swap `psql`-shelling for the real `pg` driver.** The app's structure
  (`src/db.js` is the only file that touches Postgres) was deliberately
  kept small so this is a contained change — the rest of the app calls
  `query()`/`one()`, not `psql` directly. `pg` gives you proper
  parameterized queries and connection pooling, which is worth doing once
  `npm install` works again.
- **Either keep the hand-written Node server, or move to a small
  framework** (Express or Fastify) if you'd like more conventional
  middleware/routing — not required, but common once dependencies are
  available.
- **Add a process manager** (`pm2` or a `systemd` unit) so the server
  restarts on crash/reboot, and **Caddy** in front for automatic HTTPS
  (a single `Caddyfile` with your domain is usually all it takes).
- **Docker Compose** ties it together: one container for the app, one for
  Postgres, one for Caddy — this was the original plan in the blueprint
  artifact and still applies.

This mirrors the plan already saved in your Claude Design UI mockups and
the blueprint document — the only change from the original plan is the
zero-dependency implementation approach forced by this sandbox; the target
architecture on Oracle Cloud is unchanged.

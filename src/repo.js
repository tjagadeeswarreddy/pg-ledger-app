// Business logic, separated from HTTP handling so it can be unit-tested directly.
import { query, one, lit, hasValue, tx } from "./db.js";

// ---------- Floors & Rooms ----------

export async function listFloors() {
  return query(`
    SELECT * FROM floors
    ORDER BY
      CASE
        WHEN name = 'Ground Floor' THEN 0
        WHEN name LIKE '1st Floor' THEN 1
        WHEN name LIKE '2nd Floor' THEN 2
        WHEN name LIKE '3rd Floor' THEN 3
        WHEN name LIKE '4th Floor' THEN 4
        WHEN name LIKE '5th Floor' THEN 5
        ELSE 999
      END,
      sort_order,
      id
  `);
}

export async function createFloor({ name, sortOrder }) {
  return one(`INSERT INTO floors(name, sort_order) VALUES (${lit(name)}, ${Number(sortOrder) || 0}) RETURNING *`);
}

export async function updateFloor(id, { name }) {
  id = Number(id);
  const floor = await one(`SELECT * FROM floors WHERE id = ${id}`);
  if (!floor) throw new Error("Floor not found.");
  return one(`UPDATE floors SET name = ${lit(name)} WHERE id = ${id} RETURNING *`);
}

export async function deleteFloor(id) {
  id = Number(id);
  const floor = await one(`SELECT * FROM floors WHERE id = ${id}`);
  if (!floor) throw new Error("Floor not found.");
  const counts = await one(`SELECT count(*) AS room_count FROM rooms WHERE floor_id = ${id}`);
  if (Number(counts.room_count) > 0) {
    throw new Error(`Can't delete ${floor.name} — it still has ${counts.room_count} room${Number(counts.room_count) === 1 ? "" : "s"}. Delete or move those rooms first.`);
  }
  await query(`DELETE FROM floors WHERE id = ${id}`);
  return { floor };
}

// `activeOnly` is for room-picker dropdowns (Add/Edit tenant) — a deactivated
// room shouldn't be offered for a new assignment. `includeRoomId` re-adds one
// specific room even if it's inactive, so editing a tenant whose room was
// later deactivated still shows their current room as an option.
export async function listRoomsWithOccupancy({ activeOnly = false, includeRoomId = null } = {}) {
  const where = activeOnly
    ? `WHERE (r.status = 'active'${includeRoomId ? ` OR r.id = ${Number(includeRoomId)}` : ""})`
    : "";
  return query(`
    SELECT r.*, f.name AS floor_name,
      (SELECT count(*) FROM tenants t WHERE t.room_id = r.id AND t.status = 'active') AS occupied
    FROM rooms r JOIN floors f ON f.id = r.floor_id
    ${where}
    ORDER BY f.sort_order, f.id, r.room_no`);
}

// One room + its floor name — powers the "Showing tenants in Room X" banner
// on the Tenants page when arriving there via a room click from Floors & Rooms.
export async function getRoom(id) {
  return one(`SELECT r.*, f.name AS floor_name FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.id = ${Number(id)}`);
}

export async function createRoom({ floorId, roomNo, sharingType, defaultRent }) {
  return one(`INSERT INTO rooms(floor_id, room_no, sharing_type, default_rent)
    VALUES (${Number(floorId)}, ${lit(roomNo)}, ${Number(sharingType)}, ${Number(defaultRent)}) RETURNING *`);
}

export async function updateRoom(id, { roomNo, sharingType, defaultRent }) {
  id = Number(id);
  sharingType = Number(sharingType);
  defaultRent = Number(defaultRent);

  const room = await one(`SELECT * FROM rooms WHERE id = ${id}`);
  if (!room) throw new Error("Room not found.");

  const dup = await one(`SELECT id FROM rooms WHERE floor_id = ${Number(room.floor_id)} AND room_no = ${lit(roomNo)} AND id != ${id}`);
  if (dup) throw new Error(`Room ${roomNo} already exists on this floor.`);

  const maxBed = await one(`SELECT COALESCE(max(bed_no), 0) AS max_bed FROM tenants WHERE room_id = ${id} AND status = 'active'`);
  if (sharingType < Number(maxBed.max_bed)) {
    throw new Error(`Can't reduce ${room.room_no} to ${sharingType}-sharing — bed ${maxBed.max_bed} is currently occupied by an active tenant.`);
  }

  return one(`UPDATE rooms SET room_no = ${lit(roomNo)}, sharing_type = ${sharingType}, default_rent = ${defaultRent}
    WHERE id = ${id} RETURNING *`);
}

// "Delete" a room follows the same waive/void-not-delete philosophy as rent
// charges and payments: a room with zero tenant history ever (a mistaken
// entry, never assigned to anyone) is hard-deleted since there's nothing to
// lose; a room with past tenants but nobody active right now is deactivated
// instead (kept for the historical record, hidden from new assignments); a
// room with active tenants right now is refused outright.
export async function deleteRoom(id) {
  id = Number(id);
  const room = await one(`SELECT * FROM rooms WHERE id = ${id}`);
  if (!room) throw new Error("Room not found.");

  const counts = await one(`
    SELECT count(*) FILTER (WHERE status = 'active') AS active_count, count(*) AS ever_count
    FROM tenants WHERE room_id = ${id}`);

  if (Number(counts.active_count) > 0) {
    throw new Error(`Can't delete room ${room.room_no} — ${counts.active_count} active tenant${Number(counts.active_count) === 1 ? "" : "s"} still assigned. Vacate or move them first.`);
  }
  if (Number(counts.ever_count) > 0) {
    await query(`UPDATE rooms SET status = 'inactive' WHERE id = ${id}`);
    return { deactivated: true, room };
  }
  await query(`DELETE FROM rooms WHERE id = ${id}`);
  return { deactivated: false, room };
}

export async function reactivateRoom(id) {
  return one(`UPDATE rooms SET status = 'active' WHERE id = ${Number(id)} RETURNING *`);
}

// ---------- Tenants ----------

export async function listTenants({ status = "active", floorId, roomId, search } = {}) {
  const clauses = [];
  if (status !== "all") clauses.push(`t.status = ${lit(status)}`);
  if (floorId) clauses.push(`f.id = ${Number(floorId)}`);
  if (roomId) clauses.push(`r.id = ${Number(roomId)}`);
  // Free-text search box on the Tenants page — matches name or phone
  // (ILIKE, so it's case-insensitive and works as a substring match on
  // either field). `lit()` escapes the value, so the %wildcards% built here
  // are still a safe SQL string literal, not raw interpolation.
  if (search && search.trim()) clauses.push(`(t.full_name ILIKE ${lit("%" + search.trim() + "%")} OR t.phone ILIKE ${lit("%" + search.trim() + "%")})`);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return query(`
    SELECT t.*, r.room_no, f.name AS floor_name, f.id AS floor_id
    FROM tenants t JOIN rooms r ON r.id = t.room_id JOIN floors f ON f.id = r.floor_id
    ${where}
    ORDER BY f.sort_order, r.room_no, t.bed_no`);
}

export async function getTenant(id) {
  return one(`
    SELECT t.*, r.room_no, r.sharing_type, f.name AS floor_name, f.id AS floor_id
    FROM tenants t JOIN rooms r ON r.id = t.room_id JOIN floors f ON f.id = r.floor_id
    WHERE t.id = ${Number(id)}`);
}

export async function bedIsFree(roomId, bedNo, excludeTenantId = null) {
  const excludeClause = excludeTenantId ? ` AND id != ${Number(excludeTenantId)}` : "";
  const row = await one(`SELECT id FROM tenants WHERE room_id = ${Number(roomId)} AND bed_no = ${Number(bedNo)} AND status = 'active'${excludeClause}`);
  return !row;
}

export async function createTenant(input) {
  const free = await bedIsFree(input.roomId, input.bedNo);
  if (!free) throw new Error(`Bed ${input.bedNo} in that room is already occupied by an active tenant.`);
  return one(`
    INSERT INTO tenants(room_id, bed_no, full_name, phone, alt_phone, emergency_name, emergency_phone,
      emergency_relation, occupation, id_proof_type, id_proof_number, joining_date, rent_due_day,
      monthly_rent, deposit_amount, deposit_paid_date)
    VALUES (${Number(input.roomId)}, ${Number(input.bedNo)}, ${lit(input.fullName)}, ${lit(input.phone)},
      ${lit(input.altPhone)}, ${lit(input.emergencyName)}, ${lit(input.emergencyPhone)}, ${lit(input.emergencyRelation)},
      ${lit(input.occupation)}, ${lit(input.idProofType)}, ${lit(input.idProofNumber)}, ${lit(input.joiningDate)},
      ${Number(input.rentDueDay) || 5}, ${Number(input.monthlyRent)}, ${Number(input.depositAmount) || 0},
      ${lit(input.depositPaidDate || null)})
    RETURNING *`);
}

// Deposit refund is captured in the same step as vacating (most PGs settle it
// the same day) but nothing here is required — refundAmount blank/0 is fine,
// and it can be entered or corrected later via updateDepositRefund. Notice
// fields (if any were set) are deliberately left alone rather than cleared —
// "gave notice on the 1st, vacated on the 15th" is worth keeping as history.
export async function vacateTenant(id, { vacateDate, refundAmount, refundDate }) {
  const refund = refundAmount === undefined || refundAmount === null || refundAmount === "" ? 0 : Number(refundAmount);
  return one(`UPDATE tenants SET status = 'vacated', vacate_date = ${lit(vacateDate)},
      deposit_refund_amount = ${Number.isFinite(refund) ? refund : 0}, deposit_refund_date = ${lit(refundDate || vacateDate)}
    WHERE id = ${Number(id)} RETURNING *`);
}

// Correct/enter the deposit refund after the tenant has already vacated —
// e.g. the final figure wasn't known until a move-out inspection, or the
// vacate-time entry was simply wrong. Same "always overwrite-in-place"
// approach as everything else that's a plain fact rather than money moving
// through an account (this never touches the accounts ledger — a deposit was
// never modeled as flowing through an account_transactions row to begin with).
export async function updateDepositRefund(id, { refundAmount, refundDate }) {
  const refund = Number(refundAmount);
  if (!Number.isFinite(refund) || refund < 0) throw new Error("Enter a valid refund amount.");
  return one(`UPDATE tenants SET deposit_refund_amount = ${refund}, deposit_refund_date = ${lit(refundDate || null)}
    WHERE id = ${Number(id)} RETURNING *`);
}

// "Give notice" / "cancel notice" — see the schema.sql comment on
// notice_date/expected_vacate_date: this never touches tenants.status, only
// these two columns, so a tenant on notice keeps being treated as a fully
// active occupant everywhere else in the app (billing, bed occupancy,
// dashboard counts) right up until an actual Vacate.
export async function giveNotice(id, expectedVacateDate) {
  const t = await one(`SELECT status FROM tenants WHERE id = ${Number(id)}`);
  if (!t) throw new Error("Tenant not found.");
  if (t.status !== "active") throw new Error("Only an active tenant can be put on notice.");
  return one(`UPDATE tenants SET notice_date = CURRENT_DATE, expected_vacate_date = ${lit(expectedVacateDate || null)}
    WHERE id = ${Number(id)} RETURNING *`);
}

export async function cancelNotice(id) {
  return one(`UPDATE tenants SET notice_date = NULL, expected_vacate_date = NULL WHERE id = ${Number(id)} RETURNING *`);
}

// A tenant can only be deleted once they're vacated — vacating is already the
// "soft" removal step (hidden from active views, their bed freed up), so
// Delete is the deliberate next step for someone who's truly done and is just
// clutter in the Vacated list. This permanently removes their profile and all
// rent_charges/payments rows (no FK ON DELETE CASCADE here, so payments are
// removed before rent_charges, which are removed before the tenant, in one
// transaction). Account balances are unaffected: they're computed from
// account_transactions, which this never touches, so the ledger total stays
// exactly right even after the underlying payment rows are gone.
export async function deleteTenant(id) {
  id = Number(id);
  const t = await one(`SELECT * FROM tenants WHERE id = ${id}`);
  if (!t) throw new Error("Tenant not found.");
  if (t.status !== "vacated") throw new Error("Only a vacated tenant can be deleted — vacate them first.");
  await tx(`
    DELETE FROM payments WHERE tenant_id = ${id};
    DELETE FROM rent_charges WHERE tenant_id = ${id};
    DELETE FROM tenants WHERE id = ${id};
  `);
  return t;
}

// Update a tenant's own details, and optionally reassign their room/bed.
// This is a straight overwrite of the tenant record — it does NOT touch any
// past rent_charges or payments rows, so changing the monthly rent here only
// affects charges generated from this point on; history stays exactly as it
// was billed and paid, which is what you want for an audit trail.
export async function updateTenant(id, input) {
  const free = await bedIsFree(input.roomId, input.bedNo, id);
  if (!free) throw new Error(`Bed ${input.bedNo} in that room is already occupied by another active tenant.`);
  return one(`
    UPDATE tenants SET
      room_id = ${Number(input.roomId)}, bed_no = ${Number(input.bedNo)},
      full_name = ${lit(input.fullName)}, phone = ${lit(input.phone)}, alt_phone = ${lit(input.altPhone)},
      emergency_name = ${lit(input.emergencyName)}, emergency_phone = ${lit(input.emergencyPhone)},
      emergency_relation = ${lit(input.emergencyRelation)}, occupation = ${lit(input.occupation)},
      id_proof_type = ${lit(input.idProofType)}, id_proof_number = ${lit(input.idProofNumber)},
      joining_date = ${lit(input.joiningDate)}, monthly_rent = ${Number(input.monthlyRent)},
      deposit_amount = ${Number(input.depositAmount) || 0}, rent_due_day = ${Number(input.rentDueDay) || 5}
    WHERE id = ${Number(id)}
    RETURNING *`);
}

// A quick, single-field version of updateTenant for the profile page's inline
// "Edit" on Monthly rent — same effect (only future auto-generated charges
// pick up the new figure; nothing already billed changes), just without
// having to open the full Edit Tenant form for a one-number change.
export async function updateMonthlyRent(id, monthlyRent) {
  const amount = Number(monthlyRent);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a valid monthly rent.");
  return one(`UPDATE tenants SET monthly_rent = ${amount} WHERE id = ${Number(id)} RETURNING *`);
}

// ---------- Rent charges: the idempotent generator + waive/reinstate ----------

// Create a charge for every active tenant for (year, month) UNLESS one already exists
// (active OR waived) — this is what makes "waive" permanent instead of getting silently
// regenerated. Returns how many were created.
//
// Each tenant has their own rent_due_day (1-31, set on the tenant record). For the
// CURRENT real-world month, a tenant's charge is only auto-created once today's date
// has reached their due day — so a tenant due on the 15th doesn't show as "due" (or
// "overdue") on the 3rd. For a past month the due date has obviously already passed,
// so charges are created unconditionally. For a future month nothing is pre-generated —
// there's nothing due yet. The owner can always override this early with "Add due now"
// (addManualDue, below) — e.g. a tenant leaving before their usual due day.
export async function ensureChargesForMonth(year, month) {
  const today = new Date();
  const todayY = today.getFullYear(), todayM = today.getMonth() + 1, todayD = today.getDate();
  const isCurrentMonth = Number(year) === todayY && Number(month) === todayM;
  const isFutureMonth = Number(year) > todayY || (Number(year) === todayY && Number(month) > todayM);
  const isPastMonth = Number(year) < todayY || (Number(year) === todayY && Number(month) < todayM);

  // Only create charges for current month onwards, never for past months
  if (isFutureMonth || isPastMonth) return 0;

  const tenants = await query(`SELECT id, monthly_rent, rent_due_day FROM tenants WHERE status = 'active'`);
  let created = 0;
  for (const t of tenants) {
    if (isCurrentMonth) {
      const dueDay = Number(t.rent_due_day) || 5;
      if (todayD < dueDay) continue; // this tenant's due date hasn't arrived yet this month
    }
    const existing = await one(`SELECT id FROM rent_charges WHERE tenant_id = ${t.id} AND period_year = ${Number(year)} AND period_month = ${Number(month)}`);
    if (existing) continue;
    await query(`INSERT INTO rent_charges(tenant_id, period_year, period_month, expected_amount)
      VALUES (${t.id}, ${Number(year)}, ${Number(month)}, ${Number(t.monthly_rent)})`);
    created++;
  }
  return created;
}

// Tenants who don't yet have a rent_charges row for this (year, month) — either
// because their due date hasn't arrived yet this month, or the owner is looking at
// a future month. Powers the "Not due yet" section and the manual "Add due now" action.
export async function listTenantsMissingCharge({ year, month, floorId }) {
  const floorFilter = floorId ? `AND f.id = ${Number(floorId)}` : "";
  return query(`
    SELECT t.id AS tenant_id, t.full_name, t.monthly_rent, t.rent_due_day, r.room_no, f.name AS floor_name, f.id AS floor_id
    FROM tenants t
    JOIN rooms r ON r.id = t.room_id
    JOIN floors f ON f.id = r.floor_id
    WHERE t.status = 'active' ${floorFilter}
      AND NOT EXISTS (
        SELECT 1 FROM rent_charges rc
        WHERE rc.tenant_id = t.id AND rc.period_year = ${Number(year)} AND rc.period_month = ${Number(month)}
      )
    ORDER BY f.sort_order, r.room_no, t.bed_no`);
}

// Manually create a tenant's due for (year, month) right now, bypassing the due-day
// gate above. Still respects the one-charge-per-tenant-per-month rule — if a charge
// already exists (active or waived) this throws rather than creating a duplicate.
export async function addManualDue(tenantId, year, month) {
  const t = await one(`SELECT monthly_rent FROM tenants WHERE id = ${Number(tenantId)} AND status = 'active'`);
  if (!t) throw new Error("Tenant not found or not active.");
  const existing = await one(`SELECT id FROM rent_charges WHERE tenant_id = ${Number(tenantId)} AND period_year = ${Number(year)} AND period_month = ${Number(month)}`);
  if (existing) throw new Error("A rent due already exists for this tenant for that month.");
  return one(`INSERT INTO rent_charges(tenant_id, period_year, period_month, expected_amount)
    VALUES (${Number(tenantId)}, ${Number(year)}, ${Number(month)}, ${Number(t.monthly_rent)}) RETURNING *`);
}

export async function listChargesForMonth({ year, month, floorId }) {
  const floorFilter = floorId ? `AND f.id = ${Number(floorId)}` : "";
  return query(`
    SELECT rc.*, t.full_name, t.phone, r.room_no, f.name AS floor_name, f.id AS floor_id,
      COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.rent_charge_id = rc.id AND p.status = 'active'), 0) AS paid_amount
    FROM rent_charges rc
    JOIN tenants t ON t.id = rc.tenant_id
    JOIN rooms r ON r.id = t.room_id
    JOIN floors f ON f.id = r.floor_id
    WHERE rc.period_year = ${Number(year)} AND rc.period_month = ${Number(month)} ${floorFilter}
    ORDER BY f.sort_order, r.room_no, t.bed_no`);
}

// Per-account breakdown of active payments against each charge in a month — powers
// the "which account(s) did this rent get paid into" dropdown on the Rent
// Collection list. A tenant's month can be split across more than one account
// (part cash, part UPI, etc.), so this groups by (charge, account) rather than
// just returning a single total.
export async function paymentBreakdownForMonth({ year, month, floorId }) {
  const floorFilter = floorId ? `AND f.id = ${Number(floorId)}` : "";
  return query(`
    SELECT p.rent_charge_id, a.name AS account_name, sum(p.amount) AS amount, count(*) AS payment_count
    FROM payments p
    JOIN accounts a ON a.id = p.account_id
    JOIN rent_charges rc ON rc.id = p.rent_charge_id
    JOIN tenants t ON t.id = rc.tenant_id
    JOIN rooms r ON r.id = t.room_id
    JOIN floors f ON f.id = r.floor_id
    WHERE rc.period_year = ${Number(year)} AND rc.period_month = ${Number(month)} AND p.status = 'active' ${floorFilter}
    GROUP BY p.rent_charge_id, a.name
    ORDER BY p.rent_charge_id, a.name`);
}

// One charge with everything its "Manage this due" page needs — tenant, room,
// floor, and how much has actually been paid against it so far.
export async function getChargeDetail(id) {
  return one(`
    SELECT rc.*, t.id AS tenant_id, t.full_name, t.phone, t.monthly_rent, t.rent_due_day,
      r.room_no, r.id AS room_id, f.name AS floor_name, f.id AS floor_id,
      COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.rent_charge_id = rc.id AND p.status = 'active'), 0) AS paid_amount
    FROM rent_charges rc
    JOIN tenants t ON t.id = rc.tenant_id
    JOIN rooms r ON r.id = t.room_id
    JOIN floors f ON f.id = r.floor_id
    WHERE rc.id = ${Number(id)}`);
}

// Payments recorded against one specific charge (not a tenant's whole history) —
// what the "Manage this due" page shows underneath the actions.
export async function paymentsForCharge(chargeId) {
  return query(`
    SELECT p.*, a.name AS account_name
    FROM payments p JOIN accounts a ON a.id = p.account_id
    WHERE p.rent_charge_id = ${Number(chargeId)}
    ORDER BY p.pay_date DESC, p.id DESC`);
}

// A tenant's own rent charge history (most recent first), each row carrying
// how much has actually been paid against it — same paid_amount computation
// as getChargeDetail/listChargesForMonth — so the tenant profile page can
// show a real Paid/Partial/Overdue status instead of just echoing the raw
// 'active'/'waived' DB column (which looks like "Active" for every unpaid
// due too, and says nothing about whether it's been collected).
export async function listChargesForTenant(tenantId, limit = 12) {
  return query(`
    SELECT rc.*,
      COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.rent_charge_id = rc.id AND p.status = 'active'), 0) AS paid_amount
    FROM rent_charges rc
    WHERE rc.tenant_id = ${Number(tenantId)}
    ORDER BY rc.period_year DESC, rc.period_month DESC
    LIMIT ${Number(limit)}`);
}

export async function waiveCharge(id, reason) {
  return one(`UPDATE rent_charges SET status = 'waived', waived_reason = ${lit(reason)}, waived_at = now()
    WHERE id = ${Number(id)} RETURNING *`);
}

export async function reinstateCharge(id) {
  return one(`UPDATE rent_charges SET status = 'active', waived_reason = NULL, waived_at = NULL
    WHERE id = ${Number(id)} RETURNING *`);
}

// Correct the amount actually due for one month — a wrong auto-generated figure,
// a prorated partial month, a late fee added on top, a manual discount, etc. This
// is different from waiving: the charge stays active and still expects payment,
// just for a different amount. The first time a charge is edited, its starting
// amount is preserved in original_amount so the change is visible, not silently
// overwritten; a charge that's currently waived can't be edited directly — reinstate
// it first, so "how much is actually due right now" never has two competing answers.
export async function editChargeAmount(id, newAmount, reason) {
  const c = await one(`SELECT * FROM rent_charges WHERE id = ${Number(id)}`);
  if (!c) throw new Error("Rent due not found.");
  if (c.status === "waived") throw new Error("This due is waived — reinstate it before editing the amount.");
  const amount = Number(newAmount);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Enter a valid amount.");
  const original = hasValue(c.original_amount) ? Number(c.original_amount) : Number(c.expected_amount);
  return one(`UPDATE rent_charges SET
      expected_amount = ${amount}, original_amount = ${original},
      adjusted_reason = ${lit(reason || null)}, adjusted_at = now()
    WHERE id = ${Number(id)} RETURNING *`);
}

// ---------- Payments (record / void) ----------

export async function recordPayment({ rentChargeId, tenantId, accountId, amount, mode, payDate }) {
  // One atomic statement: the payment row and its matching account credit rise or fall together.
  const rows = await query(`
    WITH ins AS (
      INSERT INTO payments(tenant_id, rent_charge_id, account_id, amount, mode, pay_date)
      VALUES (${Number(tenantId)}, ${rentChargeId ? Number(rentChargeId) : "NULL"}, ${Number(accountId)}, ${Number(amount)}, ${lit(mode)}, ${lit(payDate)})
      RETURNING id, account_id, amount
    )
    INSERT INTO account_transactions(account_id, type, amount, source, source_id, note)
    SELECT account_id, 'credit', amount, 'payment', id, 'Rent payment' FROM ins
    RETURNING source_id AS payment_id;
  `);
  return Number(rows[0].payment_id);
}

export async function voidPayment(id, reason) {
  const p = await one(`SELECT * FROM payments WHERE id = ${Number(id)}`);
  if (!p || p.status === "voided") return p;
  await query(`UPDATE payments SET status = 'voided', voided_reason = ${lit(reason)}, voided_at = now() WHERE id = ${Number(id)}`);
  // Reverse the money: a debit transaction, never delete the original credit.
  await query(`INSERT INTO account_transactions(account_id, type, amount, source, source_id, note)
    VALUES (${Number(p.account_id)}, 'debit', ${Number(p.amount)}, 'payment_void', ${Number(id)}, ${lit(reason || "Payment voided")})`);
  return { ...p, status: "voided" };
}

// Correct a payment's amount, account, or mode without deleting it — same
// "never just overwrite money" rule as everywhere else: log a reversing debit
// against the old account for the old amount, then a fresh credit against the
// new account for the new amount, so the ledger always explains itself. The
// payment id (and pay_date) stays the same, so it's still the same row in the
// history and — if it was one leg of a split payment across two accounts —
// only that one leg changes, the other payment on the same charge is untouched.
export async function editPayment(id, { amount, accountId, mode, reason }) {
  const p = await one(`SELECT * FROM payments WHERE id = ${Number(id)}`);
  if (!p) throw new Error("Payment not found.");
  if (p.status === "voided") throw new Error("This payment is voided — reinstate isn't supported; void the correction reason instead.");
  amount = Number(amount);
  accountId = Number(accountId);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a valid amount.");
  await query(`INSERT INTO account_transactions(account_id, type, amount, source, source_id, note)
    VALUES (${Number(p.account_id)}, 'debit', ${Number(p.amount)}, 'payment_edit', ${Number(id)}, ${lit(reason || "Payment corrected")})`);
  await query(`UPDATE payments SET amount = ${amount}, account_id = ${accountId}, mode = ${lit(mode)} WHERE id = ${Number(id)}`);
  await query(`INSERT INTO account_transactions(account_id, type, amount, source, source_id, note)
    VALUES (${accountId}, 'credit', ${amount}, 'payment', ${Number(id)}, 'Rent payment (edited)')`);
  return one(`SELECT * FROM payments WHERE id = ${Number(id)}`);
}

// ---------- Accounts ----------

export async function listAccountsWithBalance() {
  return query(`
    SELECT a.*, a.opening_balance +
      COALESCE((SELECT sum(amount) FROM account_transactions WHERE account_id = a.id AND type = 'credit'), 0) -
      COALESCE((SELECT sum(amount) FROM account_transactions WHERE account_id = a.id AND type = 'debit'), 0) AS balance
    FROM accounts a WHERE a.is_active ORDER BY a.id`);
}

// Every account, active or not — for the Accounts page itself, so a
// deactivated account can still be seen (and reactivated). Every payment/
// expense "which account" picker keeps using listAccountsWithBalance (active
// only) so a deactivated account never gets picked for something new.
export async function listAllAccounts() {
  return query(`
    SELECT a.*, a.opening_balance +
      COALESCE((SELECT sum(amount) FROM account_transactions WHERE account_id = a.id AND type = 'credit'), 0) -
      COALESCE((SELECT sum(amount) FROM account_transactions WHERE account_id = a.id AND type = 'debit'), 0) AS balance
    FROM accounts a ORDER BY a.id`);
}

// Per-account total income (all money ever credited in — rent payments plus
// any credit-side corrections), for the Accounts page's summary list. This is
// deliberately different from the running "balance" shown on each account's
// card (opening balance + credits − debits): "income" here is the credit side
// only, matching the "Collection" column the owner's own spreadsheet tracks
// per account, so the two numbers can legitimately differ (a balance drops
// when the account pays an expense; its income total doesn't).
export async function accountsIncomeSummary() {
  const rows = await query(`
    SELECT a.id, a.name, a.type, a.is_active,
      COALESCE((SELECT sum(amount) FROM account_transactions WHERE account_id = a.id AND type = 'credit'), 0) AS income
    FROM accounts a
    ORDER BY income DESC, a.id`);
  const total = rows.reduce((sum, r) => sum + Number(r.income), 0);
  return { rows, total };
}

export async function createAccount({ name, type, openingBalance }) {
  return one(`INSERT INTO accounts(name, type, opening_balance) VALUES (${lit(name)}, ${lit(type)}, ${Number(openingBalance) || 0}) RETURNING *`);
}

export async function updateAccount(id, { name, type, openingBalance }) {
  id = Number(id);
  const acc = await one(`SELECT * FROM accounts WHERE id = ${id}`);
  if (!acc) throw new Error("Account not found.");
  return one(`UPDATE accounts SET name = ${lit(name)}, type = ${lit(type)}, opening_balance = ${Number(openingBalance) || 0}
    WHERE id = ${id} RETURNING *`);
}

// "Delete" an account follows the same waive/void-not-delete philosophy as
// rooms: zero transactions ever (added by mistake) → hard DELETE; any
// transaction history at all → deactivate instead (hidden from every
// payment/expense account picker, balance and history kept).
export async function deleteAccount(id) {
  id = Number(id);
  const acc = await one(`SELECT * FROM accounts WHERE id = ${id}`);
  if (!acc) throw new Error("Account not found.");
  const counts = await one(`SELECT count(*) AS txn_count FROM account_transactions WHERE account_id = ${id}`);
  if (Number(counts.txn_count) > 0) {
    await query(`UPDATE accounts SET is_active = false WHERE id = ${id}`);
    return { deactivated: true, account: acc };
  }
  await query(`DELETE FROM accounts WHERE id = ${id}`);
  return { deactivated: false, account: acc };
}

export async function reactivateAccount(id) {
  return one(`UPDATE accounts SET is_active = true WHERE id = ${Number(id)} RETURNING *`);
}

export async function accountTransactions(accountId, { type } = {}) {
  const typeFilter = type === "credit" || type === "debit" ? `AND type = ${lit(type)}` : "";
  return query(`SELECT * FROM account_transactions WHERE account_id = ${Number(accountId)} ${typeFilter} ORDER BY txn_date DESC, id DESC LIMIT 100`);
}

// ---------- Expenses ----------

export async function listExpenses({ accountId } = {}) {
  const acctFilter = accountId ? `AND e.account_id = ${Number(accountId)}` : "";
  return query(`SELECT e.*, a.name AS account_name FROM expenses e JOIN accounts a ON a.id = e.account_id WHERE e.status = 'active' ${acctFilter} ORDER BY e.expense_date DESC, e.id DESC LIMIT 200`);
}

export async function createExpense({ accountId, category, amount, expenseDate, floorId, note }) {
  const rows = await query(`
    WITH ins AS (
      INSERT INTO expenses(account_id, category, amount, expense_date, floor_id, note)
      VALUES (${Number(accountId)}, ${lit(category)}, ${Number(amount)}, ${lit(expenseDate)}, ${floorId ? Number(floorId) : "NULL"}, ${lit(note)})
      RETURNING id, account_id, amount, category
    )
    INSERT INTO account_transactions(account_id, type, amount, source, source_id, note)
    SELECT account_id, 'debit', amount, 'expense', id, category FROM ins
    RETURNING source_id AS expense_id;
  `);
  return Number(rows[0].expense_id);
}

// Same reverse-then-reapply pattern as editPayment — keeps the expense's own
// id/date, but the account ledger shows exactly what changed and why.
export async function updateExpense(id, { category, amount, expenseDate, accountId, note }) {
  id = Number(id);
  const e = await one(`SELECT * FROM expenses WHERE id = ${id}`);
  if (!e || e.status !== "active") throw new Error("Expense not found.");
  amount = Number(amount);
  accountId = Number(accountId);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a valid amount.");
  await query(`INSERT INTO account_transactions(account_id, type, amount, source, source_id, note)
    VALUES (${Number(e.account_id)}, 'credit', ${Number(e.amount)}, 'expense_edit', ${id}, 'Expense corrected')`);
  await query(`UPDATE expenses SET category = ${lit(category)}, amount = ${amount}, expense_date = ${lit(expenseDate)},
      account_id = ${accountId}, note = ${lit(note)}
    WHERE id = ${id}`);
  await query(`INSERT INTO account_transactions(account_id, type, amount, source, source_id, note)
    VALUES (${accountId}, 'debit', ${amount}, 'expense', ${id}, ${lit(category)})`);
  return one(`SELECT * FROM expenses WHERE id = ${id}`);
}

// "Delete" an expense = void it (status = 'voided') and reverse its debit
// with a credit — the row stays for the record, the account balance goes
// back up. Never a hard delete: an expense already moved real money.
export async function deleteExpense(id, reason) {
  id = Number(id);
  const e = await one(`SELECT * FROM expenses WHERE id = ${id}`);
  if (!e || e.status !== "active") return e;
  await query(`UPDATE expenses SET status = 'voided' WHERE id = ${id}`);
  await query(`INSERT INTO account_transactions(account_id, type, amount, source, source_id, note)
    VALUES (${Number(e.account_id)}, 'credit', ${Number(e.amount)}, 'expense_void', ${id}, ${lit(reason || "Expense deleted")})`);
  return { ...e, status: "voided" };
}

// ---------- Dashboard ----------

export async function dashboardKpis(year, month) {
  const collected = await one(`
    SELECT COALESCE(sum(rc.expected_amount), 0) AS expected,
      COALESCE((SELECT sum(p.amount) FROM payments p JOIN rent_charges rc2 ON rc2.id = p.rent_charge_id
        WHERE rc2.period_year = ${Number(year)} AND rc2.period_month = ${Number(month)} AND p.status = 'active'), 0) AS collected
    FROM rent_charges rc WHERE rc.period_year = ${Number(year)} AND rc.period_month = ${Number(month)} AND rc.status = 'active'`);

  const outstandingRow = await one(`
    SELECT COALESCE(sum(GREATEST(rc.expected_amount - COALESCE(paid.amt, 0), 0)), 0) AS outstanding,
      count(*) FILTER (WHERE rc.expected_amount - COALESCE(paid.amt, 0) > 0) AS overdue_count
    FROM rent_charges rc
    LEFT JOIN LATERAL (SELECT sum(amount) AS amt FROM payments p WHERE p.rent_charge_id = rc.id AND p.status = 'active') paid ON true
    WHERE rc.period_year = ${Number(year)} AND rc.period_month = ${Number(month)} AND rc.status = 'active'`);

  const occ = await one(`
    SELECT (SELECT count(*) FROM tenants WHERE status = 'active') AS occupied,
      (SELECT COALESCE(sum(sharing_type), 0) FROM rooms) AS total_beds`);

  const accountsTotal = await one(`
    SELECT COALESCE(sum(a.opening_balance +
      COALESCE((SELECT sum(amount) FROM account_transactions WHERE account_id = a.id AND type = 'credit'), 0) -
      COALESCE((SELECT sum(amount) FROM account_transactions WHERE account_id = a.id AND type = 'debit'), 0)), 0) AS total
    FROM accounts a WHERE a.is_active`);

  return {
    expected: Number(collected.expected),
    collected: Number(collected.collected),
    outstanding: Number(outstandingRow.outstanding),
    overdueCount: Number(outstandingRow.overdue_count),
    occupied: Number(occ.occupied),
    totalBeds: Number(occ.total_beds),
    accountsTotal: Number(accountsTotal.total),
  };
}

export async function floorPerformance(year, month) {
  return query(`
    SELECT f.id, f.name,
      COALESCE(sum(rc.expected_amount), 0) AS expected,
      COALESCE(sum(paid.amt), 0) AS actual
    FROM floors f
    LEFT JOIN rooms r ON r.floor_id = f.id
    LEFT JOIN tenants t ON t.room_id = r.id
    LEFT JOIN rent_charges rc ON rc.tenant_id = t.id AND rc.period_year = ${Number(year)} AND rc.period_month = ${Number(month)} AND rc.status = 'active'
    LEFT JOIN LATERAL (SELECT sum(amount) AS amt FROM payments p WHERE p.rent_charge_id = rc.id AND p.status = 'active') paid ON true
    GROUP BY f.id, f.name, f.sort_order
    ORDER BY f.sort_order, f.id`);
}

export async function recentPayments(limit = 8) {
  return query(`
    SELECT p.*, t.full_name, r.room_no, a.name AS account_name
    FROM payments p JOIN tenants t ON t.id = p.tenant_id JOIN rooms r ON r.id = t.room_id JOIN accounts a ON a.id = p.account_id
    WHERE p.status = 'active'
    ORDER BY p.created_at DESC LIMIT ${Number(limit)}`);
}

// The Dashboard's "Coming up" card — dues about to become due, and tenants
// who've already said they're leaving. Both were previously invisible: the
// dashboard only ever showed THIS month's already-known collected/outstanding
// figures, nothing forward-looking.

// Tenants who don't have a rent_charges row for the current month YET, but
// will within `days` days. This relies on dashboardPage() already having
// called ensureChargesForMonth() before this runs: that call auto-creates a
// charge the moment a tenant's own due day arrives, so anyone still missing
// one here is guaranteed to have a due day that hasn't arrived yet — never
// one that's merely overdue and unnoticed. Due days are always 1–28 (the
// Add/Edit Tenant form enforces that specifically so every month has that
// date), so `new Date(thisYear, thisMonth, dueDay)` never spills into a
// different month — no wraparound handling needed.
export async function upcomingDues(days = 3) {
  const today = new Date();
  const missing = await query(`
    SELECT t.id AS tenant_id, t.full_name, t.monthly_rent, t.rent_due_day, r.room_no, f.name AS floor_name
    FROM tenants t JOIN rooms r ON r.id = t.room_id JOIN floors f ON f.id = r.floor_id
    WHERE t.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM rent_charges rc
        WHERE rc.tenant_id = t.id AND rc.period_year = ${today.getFullYear()} AND rc.period_month = ${today.getMonth() + 1}
      )
    ORDER BY t.rent_due_day`);
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return missing
    .map((t) => {
      const dueDay = Number(t.rent_due_day) || 5;
      const dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);
      const daysUntil = Math.round((dueDate - todayMidnight) / 86400000);
      return { ...t, due_date: dueDate.toISOString().slice(0, 10), days_until: daysUntil };
    })
    .filter((t) => t.days_until >= 0 && t.days_until <= days)
    .sort((a, b) => a.days_until - b.days_until);
}

// Active tenants currently on notice (see the schema.sql comment on
// notice_date), most-soon-leaving first. `vacating_this_month` flags anyone
// whose stated expected_vacate_date falls in the current calendar month —
// what "2 tenants on notice, vacating this month" on the Dashboard means.
export async function tenantsOnNotice() {
  const today = new Date();
  const rows = await query(`
    SELECT t.id, t.full_name, t.notice_date, t.expected_vacate_date, r.room_no, f.name AS floor_name
    FROM tenants t JOIN rooms r ON r.id = t.room_id JOIN floors f ON f.id = r.floor_id
    WHERE t.status = 'active' AND t.notice_date IS NOT NULL
    ORDER BY t.expected_vacate_date NULLS LAST, t.notice_date`);
  return rows.map((t) => {
    let vacatingThisMonth = false;
    if (hasValue(t.expected_vacate_date)) {
      const d = new Date(t.expected_vacate_date);
      vacatingThisMonth = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth();
    }
    return { ...t, vacating_this_month: vacatingThisMonth };
  });
}

// ---------- Users (owner/staff logins) ----------
// No public sign-up route anywhere in this app — a new login can only ever
// be created by someone already signed in, from the Users page.

export async function listUsers() {
  return query(`SELECT id, email, name, created_at FROM users ORDER BY id`);
}

export async function createUser({ name, email, passwordHash }) {
  const dup = await one(`SELECT id FROM users WHERE email = ${lit(email)}`);
  if (dup) throw new Error(`A login for ${email} already exists.`);
  return one(`INSERT INTO users(email, password_hash, name) VALUES (${lit(email)}, ${lit(passwordHash)}, ${lit(name)})
    RETURNING id, email, name, created_at`);
}

// Two guards, same reasoning as the last-account-standing checks elsewhere in
// this app: you can't delete the login you're currently signed in as (no
// "log out from under yourself" surprise), and the very last login can never
// be removed (there'd be no way back into the app at all — no password-reset
// flow exists here, so that would be a real lockout, not just an inconvenience).
export async function deleteUser(id, currentUserId) {
  id = Number(id);
  if (id === Number(currentUserId)) throw new Error("You can't remove the login you're currently signed in as.");
  const count = await one(`SELECT count(*) AS c FROM users`);
  if (Number(count.c) <= 1) throw new Error("Can't remove the only remaining login.");
  await query(`DELETE FROM sessions WHERE user_id = ${id}`);
  await query(`DELETE FROM users WHERE id = ${id}`);
}

export async function getPaymentStatusForTenant(tenantId, year, month) {
  const charge = await one(`
    SELECT rc.id, rc.expected_amount,
      COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.rent_charge_id = rc.id AND p.status = 'active'), 0) AS paid_amount
    FROM rent_charges rc
    WHERE rc.tenant_id = ${Number(tenantId)} 
      AND rc.period_year = ${Number(year)} 
      AND rc.period_month = ${Number(month)}
      AND rc.status = 'active'
  `);
  
  if (!charge) return "No due yet";
  
  const expected = Number(charge.expected_amount);
  const paid = Number(charge.paid_amount);
  
  if (paid >= expected) return "Paid";
  if (paid > 0) return "Partial";
  return "Overdue";
}

export async function getDaysOverdue(chargeId) {
  const charge = await one(`
    SELECT rc.period_year, rc.period_month, rc.status, t.rent_due_day,
      COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.rent_charge_id = rc.id AND p.status = 'active'), 0) AS paid_amount
    FROM rent_charges rc
    JOIN tenants t ON t.id = rc.tenant_id
    WHERE rc.id = ${Number(chargeId)}
  `);
  
  if (!charge || charge.status !== 'active' || Number(charge.paid_amount) > 0) return 0;
  
  // Calculate days since the actual due day of the month
  const dueDay = Number(charge.rent_due_day) || 1;
  const dueDate = new Date(Number(charge.period_year), Number(charge.period_month) - 1, dueDay);
  const today = new Date();
  const daysOverdue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
  
  return Math.max(0, daysOverdue);
}

export async function getAccountMonthlyStats(accountId) {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  
  const result = await one(`
    SELECT 
      COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END), 0) AS expenses
    FROM account_transactions
    WHERE account_id = ${Number(accountId)}
      AND EXTRACT(YEAR FROM txn_date) = ${year}
      AND EXTRACT(MONTH FROM txn_date) = ${month}
  `);
  
  return {
    income: Number(result?.income || 0),
    expenses: Number(result?.expenses || 0)
  };
}

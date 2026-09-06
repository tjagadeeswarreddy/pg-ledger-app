import { money, pill, escapeHtml, ordinal, icon, ICON, voidPaymentCell, editPaymentCell } from "../render.js";
import * as repo from "../repo.js";
import { hasValue } from "../db.js";

export async function rentPage({ year, month, floorId, accountId }) {
  const now = new Date();
  year = Number(year) || now.getFullYear();
  month = Number(month) || now.getMonth() + 1;

  // The idempotent generator: safe to call every time this page loads.
  // A tenant who already has a row for this month (active OR waived) is skipped —
  // and, for the current real-world month, a tenant is skipped entirely until
  // today's date reaches THEIR OWN rent_due_day. See repo.ensureChargesForMonth.
  const createdCount = await repo.ensureChargesForMonth(year, month);

  const floors = await repo.listFloors();
  const accounts = await repo.listAccountsWithBalance();
  const charges = await repo.listChargesForMonth({ year, month, floorId });
  const notDueYet = await repo.listTenantsMissingCharge({ year, month, floorId });
  const breakdownRows = await repo.paymentBreakdownForMonth({ year, month, floorId, accountId });

  const breakdownByCharge = {};
  for (const b of breakdownRows) { (breakdownByCharge[b.rent_charge_id] ||= []).push(b); }

  // Fetch days overdue for each charge to display in the status indicator
  const daysOverdueMap = {};
  for (const c of charges) {
    daysOverdueMap[c.id] = await repo.getDaysOverdue(c.id);
  }

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  const floorQS = floorId ? `&floorId=${floorId}` : "";
  const accountQS = accountId ? `&accountId=${accountId}` : "";
  const allQS = floorQS + accountQS;
  const accountOptions = accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");
  const modeOptions = `<option value="upi">UPI</option><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="cheque">Cheque</option>`;

  let expTotal = 0, paidTotal = 0;

  // Record payment / Waive / Edit are icon-triggered, right on the row — a
  // hidden checkbox + a <label for> is what opens each one (the "checkbox
  // hack"), and Cancel is just a second label pointing at the same checkbox
  // id, so all of this works with zero JavaScript. Editing the amount swaps
  // the Expected cell's own display for an input in place, rather than
  // opening a separate form elsewhere on the page. A "view full history"
  // icon still links to the fuller /rent/charge/:id page for void-a-payment
  // and the complete payment log for this charge.
  const rows = charges.map((c) => {
    const exp = Number(c.expected_amount);
    const paid = Number(c.paid_amount);
    const outstanding = c.status === "waived" ? 0 : Math.max(exp - paid, 0);
    if (c.status !== "waived") { expTotal += exp; paidTotal += paid; }

    let statusPill;
    if (c.status === "waived") statusPill = pill("Waived", "neutral");
    else if (outstanding === 0) statusPill = pill("Paid", "good");
    else if (paid > 0) statusPill = pill("Partial", "warn");
    else {
      // outstanding > 0 and paid === 0 - show status based on due date
      const daysOverdue = daysOverdueMap[c.id] || 0;
      if (daysOverdue > 0) {
        // Past due date
        const label = `Overdue ${daysOverdue}d`;
        statusPill = pill(label, "bad");
      } else if (daysOverdue === 0) {
        // Due today
        statusPill = pill("Due", "warn");
      } else {
        // Due in future
        statusPill = pill("Not due", "neutral");
      }
    }

    const adjustedNote = hasValue(c.original_amount) && Number(c.original_amount) !== exp
      ? `<div style="font-size:11px;color:var(--ink-faint);margin-top:2px;" title="${escapeHtml(c.adjusted_reason || "")}">was ${money(c.original_amount)}</div>`
      : "";

    const historyLink = `<a class="icon-btn ghost" href="/rent/charge/${c.id}?year=${year}&month=${month}${floorQS}" title="View full payment history">${icon(ICON.history, 14)}</a>`;
    const rowRedirect = `/rent?year=${year}&month=${month}${allQS}`;

    // Expected cell: plain text for a waived charge (nothing to edit), otherwise
    // an inline pencil -> input -> checkmark/cancel edit-in-place.
    let expectedCell;
    if (c.status === "waived") {
      expectedCell = `<td class="num" data-label="Expected">${money(exp)}</td>`;
    } else {
      const cb = `ed-${c.id}`;
      expectedCell = `<td class="num" data-label="Expected">
        <div class="inline-edit">
          <input type="checkbox" id="${cb}" class="ie-toggle">
          <div class="ie-view">
            <span>${money(exp)}${adjustedNote}</span>
            <label for="${cb}" class="icon-btn ghost" title="Edit amount" style="padding:6px;min-width:28px;min-height:28px;display:inline-flex;align-items:center;justify-content:center;">${icon(ICON.pencil, 16)}</label>
          </div>
          <form method="post" action="/rent/${c.id}/edit-amount" class="ie-form">
            <input type="hidden" name="year" value="${year}"><input type="hidden" name="month" value="${month}">
            <input type="hidden" name="redirectTo" value="${rowRedirect}">
            <input type="number" name="amount" value="${exp}" class="ie-input" required>
            <button type="submit" class="icon-btn good" title="Save">${icon(ICON.check, 13)}</button>
            <label for="${cb}" class="icon-btn bad" title="Cancel">${icon(ICON.x, 13)}</label>
          </form>
        </div>
      </td>`;
    }

    // Paid cell: plain figure normally; if the month was split across more than
    // one account, a small dropdown breaks down how much went where.
    const acctRows = breakdownByCharge[c.id] || [];
    let paidCell;
    if (acctRows.length <= 1) {
      const viaNote = acctRows.length === 1 ? `<div class="lbl" style="margin-top:2px;">via ${escapeHtml(acctRows[0].account_name)}</div>` : "";
      paidCell = `<td class="num" data-label="Paid">${money(paid)}${viaNote}</td>`;
    } else {
      const lines = acctRows.map((a) => `<div class="acct-row"><span>${escapeHtml(a.account_name)}</span><span class="mono">${money(a.amount)}</span></div>`).join("");
      paidCell = `<td class="num" data-label="Paid">
        <details class="acct-dropdown">
          <summary>${money(paid)} <span class="lbl">${acctRows.length} accounts</span> ${icon(ICON.chevron, 11)}</summary>
          <div class="acct-breakdown">${lines}</div>
        </details>
      </td>`;
    }

    // Actions cell: icon-triggered Pay / Waive popovers (waived charges get a
    // one-click Reinstate icon instead), plus the history link.
    let actionsCell;
    if (c.status === "waived") {
      actionsCell = `<td data-label="">
        <div class="row-actions">
          <form method="post" action="/rent/${c.id}/reinstate" style="display:inline;">
            <input type="hidden" name="year" value="${year}"><input type="hidden" name="month" value="${month}">
            <input type="hidden" name="redirectTo" value="${rowRedirect}">
            <button type="submit" class="icon-btn" title="Reinstate this due">${icon(ICON.undo, 14)}</button>
          </form>
          ${historyLink}
        </div>
      </td>`;
    } else {
      const payCb = `pay-${c.id}`, waiveCb = `wv-${c.id}`;
      actionsCell = `<td data-label="">
        <div class="row-actions">
          <div class="inline-edit">
            <input type="checkbox" id="${payCb}" class="ie-toggle">
            <label for="${payCb}" class="icon-btn" title="Record a payment">${icon(ICON.pay, 14)}</label>
            <form method="post" action="/rent/${c.id}/pay" class="ie-form popover">
              <input type="hidden" name="year" value="${year}"><input type="hidden" name="month" value="${month}">
              <input type="hidden" name="redirectTo" value="${rowRedirect}">
              <label class="field"><span>Amount</span><input type="number" name="amount" value="${outstanding || exp}" required></label>
              <label class="field"><span>Account</span><select name="accountId">${accountOptions}</select></label>
              <label class="field"><span>Mode</span><select name="mode">${modeOptions}</select></label>
              <div class="popover-actions">
                <button type="submit" class="icon-btn good" title="Save payment">${icon(ICON.check, 13)}</button>
                <label for="${payCb}" class="icon-btn bad" title="Cancel">${icon(ICON.x, 13)}</label>
              </div>
            </form>
          </div>
          <div class="inline-edit">
            <input type="checkbox" id="${waiveCb}" class="ie-toggle">
            <label for="${waiveCb}" class="icon-btn" title="Waive this due">${icon(ICON.waive, 14)}</label>
            <form method="post" action="/rent/${c.id}/waive" class="ie-form popover">
              <input type="hidden" name="year" value="${year}"><input type="hidden" name="month" value="${month}">
              <input type="hidden" name="redirectTo" value="${rowRedirect}">
              <label class="field"><span>Reason</span><input name="reason" placeholder="e.g. travelling, discount"></label>
              <div class="popover-actions">
                <button type="submit" class="icon-btn good" title="Confirm waive">${icon(ICON.check, 13)}</button>
                <label for="${waiveCb}" class="icon-btn bad" title="Cancel">${icon(ICON.x, 13)}</label>
              </div>
            </form>
          </div>
          ${historyLink}
        </div>
      </td>`;
    }

    return `<tr>
      <td data-label="Tenant" class="card-id-cell">
        <a href="/tenants/${c.tenant_id}" class="card-id" style="text-decoration:none;color:inherit;">${escapeHtml(c.full_name)}</a>
        <div class="card-id-sub">Room ${escapeHtml(c.room_no)}</div>
      </td>
      <td class="mono hide-mobile" data-label="Room">${escapeHtml(c.room_no)}</td>
      ${expectedCell}
      ${paidCell}
      <td class="num" data-label="Outstanding" style="color:${outstanding > 0 ? "var(--bad)" : "var(--ink-faint)"};">${money(outstanding)}</td>
      <td data-label="Status">${statusPill}</td>
      ${actionsCell}
    </tr>`;
  }).join("");

  const outstandingTotal = Math.max(expTotal - paidTotal, 0);

  const floorTabs = [`<a href="/rent?year=${year}&month=${month}" class="${!floorId ? "active" : ""}">All floors</a>`]
    .concat(floors.map((f) => `<a href="/rent?year=${year}&month=${month}&floorId=${f.id}" class="${String(floorId) === String(f.id) ? "active" : ""}">${escapeHtml(f.name)}</a>`))
    .join("");

  const notDueRows = notDueYet.map((t) => `
    <tr>
      <td data-label="Tenant" class="card-id-cell">
        <a href="/tenants/${t.tenant_id}" class="card-id" style="text-decoration:none;color:inherit;">${escapeHtml(t.full_name)}</a>
        <div class="card-id-sub">Room ${escapeHtml(t.room_no)}</div>
      </td>
      <td class="mono hide-mobile" data-label="Room">${escapeHtml(t.room_no)}</td>
      <td class="num" data-label="Monthly rent">${money(t.monthly_rent)}</td>
      <td data-label="Due date">
        ${(() => {
          const dueDay = t.rent_due_day || 5;
          const today = new Date().getDate();
          const currentMonth = new Date().getMonth();
          const currentYear = new Date().getFullYear();
          let dueDate = new Date(currentYear, currentMonth, dueDay);
          
          // If due date is in the past (this month), it's for next month
          if (dueDay < today) {
            dueDate = new Date(currentYear, currentMonth + 1, dueDay);
          }
          
          const daysUntilDue = Math.floor((dueDate - new Date(currentYear, currentMonth, today)) / (1000 * 60 * 60 * 24));
          
          if (daysUntilDue === 0) {
            return `Due today`;
          } else if (daysUntilDue === 1) {
            return `Due tomorrow`;
          } else if (daysUntilDue > 0) {
            return `Due in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"}`;
          } else {
            return `Due on the ${ordinal(dueDay)}`;
          }
        })()}
      </td>
      <td data-label="">
        <form method="post" action="/rent/tenant/${t.tenant_id}/add-due" style="display:inline;">
          <input type="hidden" name="year" value="${year}"><input type="hidden" name="month" value="${month}">
          <button class="btn small" type="submit">Add due now</button>
        </form>
      </td>
    </tr>`).join("");

  return `
    <div class="toolbar">
      <div>
        <h1 class="hide-mobile">Rent Collection</h1><h1 style="display:none;font-size:18px;" class="show-mobile">Rent</h1>
        <div class="lbl" style="margin-top:3px;">${monthLabel}${createdCount ? ` · added ${createdCount} new due${createdCount === 1 ? "" : "s"} today` : ""}${notDueYet.length ? ` · ${notDueYet.length} tenant${notDueYet.length === 1 ? "" : "s"} not due yet` : ""}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <a class="btn" href="/rent?year=${prev.y}&month=${prev.m}${allQS}">&larr; Prev</a>
        <a class="btn" href="/rent?year=${next.y}&month=${next.m}${allQS}">Next &rarr;</a>
      </div>
    </div>
    <div class="tabs">${floorTabs}</div>
    <div class="card" style="padding:6px 20px;">
      <table class="responsive">
        <thead><tr><th>Tenant</th><th>Room</th><th class="num">Expected</th><th class="num">Paid</th><th class="num">Outstanding</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7" style="color:var(--ink-faint);padding:14px 0;">No active tenants on this floor.</td></tr>`}</tbody>
        ${charges.length ? `<tfoot><tr style="font-weight:700;"><td colspan="2" data-label="">Total</td><td class="num" data-label="Expected">${money(expTotal)}</td><td class="num" data-label="Paid">${money(paidTotal)}</td><td class="num" data-label="Outstanding" style="color:${outstandingTotal ? "var(--bad)" : "var(--ink-faint)"};">${money(outstandingTotal)}</td><td colspan="2" data-label=""></td></tr></tfoot>` : ""}
      </table>
    </div>
    ${notDueYet.length ? `
    <div style="margin-top:18px;">
      <h2 style="font-size:14px;margin-bottom:8px;">Not due yet this month</h2>
      <div class="card" style="padding:6px 20px;">
        <table class="responsive">
          <thead><tr><th>Tenant</th><th>Room</th><th class="num">Monthly rent</th><th>Due date</th><th>Actions</th></tr></thead>
          <tbody>${notDueRows}</tbody>
        </table>
      </div>
    </div>` : ""}
  `;
}

// The focused "Manage this due" page — everything about one tenant's one month
// of rent in one place, with room for each action to be a full, clearly labeled
// form instead of three inline mini-forms fighting for space in a table cell.
export async function chargeDetailPage(id, { floorId } = {}) {
  const c = await repo.getChargeDetail(id);
  if (!c) return null;

  const accounts = await repo.listAccountsWithBalance();
  const payments = await repo.paymentsForCharge(id);

  const exp = Number(c.expected_amount);
  const paid = Number(c.paid_amount);
  const outstanding = c.status === "waived" ? 0 : Math.max(exp - paid, 0);
  const monthLabel = new Date(c.period_year, c.period_month - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  let statusPill;
  if (c.status === "waived") statusPill = pill("Waived", "neutral");
  else if (outstanding === 0) statusPill = pill("Paid", "good");
  else if (paid > 0) statusPill = pill("Partial", "warn");
  else statusPill = pill("Overdue", "bad");

  const floorQS = floorId ? `&floorId=${floorId}` : "";
  const accountQS = accountId ? `&accountId=${accountId}` : "";
  const allQS = floorQS + accountQS;
  const backHref = `/rent?year=${c.period_year}&month=${c.period_month}${floorQS}`;
  const redirectTo = `/rent/charge/${c.id}${floorId ? `?floorId=${floorId}` : ""}`;
  const accountOptions = accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");

  const adjustedNote = hasValue(c.original_amount) && Number(c.original_amount) !== exp
    ? `<div style="font-size:12.5px;color:var(--ink-soft);margin-top:10px;">Originally ${money(c.original_amount)}${c.adjusted_reason ? ` — ${escapeHtml(c.adjusted_reason)}` : ""}</div>`
    : "";

  const paymentRows = payments.map((p) => `
    <tr>
      <td data-label="Date">${p.pay_date}</td>
      <td class="num" data-label="Amount">${money(p.amount)}</td>
      <td data-label="Via">${escapeHtml(p.mode)} · ${escapeHtml(p.account_name)}</td>
      <td data-label="Status">${p.status === "voided" ? pill("Voided", "bad") : pill("Active", "good")}</td>
      <td data-label="">
        <div class="row-actions">
          ${editPaymentCell(p, accounts, { tenantId: c.tenant_id, redirectTo })}
          ${voidPaymentCell(p, { tenantId: c.tenant_id, redirectTo })}
        </div>
      </td>
    </tr>`).join("");

  const actionSections = c.status === "waived"
    ? `
    <div class="card" style="padding:18px 20px;">
      <h2>This due is waived</h2>
      <p style="font-size:13.5px;color:var(--ink-soft);margin:0 0 10px;">${escapeHtml(c.waived_reason || "No reason given.")}</p>
      <div class="lbl">${c.waived_at ? new Date(c.waived_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : ""}</div>
      <form method="post" action="/rent/${c.id}/reinstate" style="margin-top:16px;">
        <input type="hidden" name="year" value="${c.period_year}"><input type="hidden" name="month" value="${c.period_month}">
        <input type="hidden" name="redirectTo" value="${redirectTo}">
        <button class="btn primary" type="submit">${icon(ICON.check, 14)} Reinstate this due</button>
      </form>
    </div>`
    : `
    <div class="card" style="padding:18px 20px;">
      <h2>Record a payment</h2>
      <form method="post" action="/rent/${c.id}/pay" style="display:flex;flex-direction:column;gap:14px;">
        <input type="hidden" name="year" value="${c.period_year}"><input type="hidden" name="month" value="${c.period_month}">
        <input type="hidden" name="redirectTo" value="${redirectTo}">
        <div class="grid2">
          <label class="field"><span>Amount</span><input type="number" name="amount" value="${outstanding || exp}" required></label>
          <label class="field"><span>Via account</span><select name="accountId">${accountOptions}</select></label>
        </div>
        <label class="field"><span>Mode</span>
          <select name="mode"><option value="upi">UPI</option><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="cheque">Cheque</option></select>
        </label>
        <div><button class="btn primary" type="submit">${icon(ICON.check, 14)} Save payment</button></div>
      </form>
    </div>

    <div class="card" style="padding:18px 20px;">
      <h2>Edit the amount due</h2>
      <p style="font-size:12.5px;color:var(--ink-faint);margin:-6px 0 14px;">Correct a wrong figure, prorate a partial month, or add a late fee — the due stays active, just for a different amount.</p>
      <form method="post" action="/rent/${c.id}/edit-amount" style="display:flex;flex-direction:column;gap:14px;">
        <input type="hidden" name="year" value="${c.period_year}"><input type="hidden" name="month" value="${c.period_month}">
        <input type="hidden" name="redirectTo" value="${redirectTo}">
        <label class="field"><span>New amount due</span><input type="number" name="amount" value="${exp}" required></label>
        <label class="field"><span>Reason</span><input name="reason" placeholder="e.g. prorated for partial month"></label>
        <div><button class="btn" type="submit">${icon(ICON.check, 14)} Save amount</button></div>
      </form>
    </div>

    <div class="card" style="padding:18px 20px;">
      <h2>Waive this due</h2>
      <p style="font-size:12.5px;color:var(--ink-faint);margin:-6px 0 14px;">Sets this month's due to ₹0 without deleting it — it stays in the record, and reloading won't bring it back.</p>
      <form method="post" action="/rent/${c.id}/waive" style="display:flex;flex-direction:column;gap:14px;">
        <input type="hidden" name="year" value="${c.period_year}"><input type="hidden" name="month" value="${c.period_month}">
        <input type="hidden" name="redirectTo" value="${redirectTo}">
        <label class="field"><span>Reason</span><input name="reason" placeholder="e.g. travelling, discount"></label>
        <div><button class="btn danger" type="submit">${icon(ICON.check, 14)} Confirm waive</button></div>
      </form>
    </div>`;

  return `
    <div class="toolbar">
      <div>
        <h1>${escapeHtml(c.full_name)}</h1>
        <div class="lbl" style="margin-top:3px;">${escapeHtml(c.floor_name)} · Room ${escapeHtml(c.room_no)} · ${monthLabel}</div>
      </div>
      <a class="btn" href="${backHref}">&larr; Back to Rent Collection</a>
    </div>

    <div class="card" style="padding:18px 20px;margin-bottom:18px;">
      <div style="display:flex;flex-wrap:wrap;gap:26px;align-items:flex-start;">
        <div><div class="lbl">Expected</div><div class="mono" style="font-size:19px;font-weight:600;margin-top:4px;">${money(exp)}</div></div>
        <div><div class="lbl">Paid</div><div class="mono" style="font-size:19px;font-weight:600;margin-top:4px;">${money(paid)}</div></div>
        <div><div class="lbl">Outstanding</div><div class="mono" style="font-size:19px;font-weight:600;margin-top:4px;color:${outstanding > 0 ? "var(--bad)" : "var(--ink-faint)"};">${money(outstanding)}</div></div>
        <div><div class="lbl">Status</div><div style="margin-top:7px;">${statusPill}</div></div>
      </div>
      ${adjustedNote}
    </div>

    <div style="display:flex;flex-direction:column;gap:16px;max-width:560px;">
      ${actionSections}
    </div>

    <div style="margin-top:22px;max-width:760px;">
      <h2 style="font-size:14px;margin-bottom:8px;">Payments against this due</h2>
      <div class="card" style="padding:6px 20px;">
        <table class="responsive">
          <thead><tr><th>Date</th><th class="num">Amount</th><th>Via</th><th>Status</th><th></th></tr></thead>
          <tbody>${paymentRows || `<tr><td colspan="5" style="color:var(--ink-faint);padding:14px 0;">No payments recorded yet.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  
    <div style="position:fixed;bottom:20px;right:20px;z-index:100;" class="show-mobile">
      <label class="field" style="display:flex;flex-direction:column;gap:6px;background:var(--surface);padding:12px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
        <span style="font-size:12px;font-weight:500;">View by Account</span>
        <select style="padding:6px;border:1px solid var(--border);border-radius:4px;font-size:14px;" onchange="const id = this.value; window.location.href='/rent?year=${year}&month=${month}${floorQS}' + (id ? '&accountId='+id : ''); this.value='';" data-default="${accountId || ""}">
          <option value="">All accounts</option>
          ${accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name.length > 15 ? a.name.substring(0, 12) + '...' : a.name)}</option>`).join("")}
        </select>
      </label>
    </div>
    
  `;
}

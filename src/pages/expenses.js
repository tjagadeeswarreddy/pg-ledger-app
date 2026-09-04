import { money, escapeHtml, icon, ICON } from "../render.js";
import * as repo from "../repo.js";

export async function expensesPage({ accountId } = {}) {
  const expenses = await repo.listExpenses({ accountId });
  const accounts = await repo.listAccountsWithBalance();

  const accountOptions = accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");
  const redirectTo = `/expenses${accountId ? `?accountId=${accountId}` : ""}`;

  const rows = expenses.map((e) => {
    const cb = `exp-edit-${e.id}`;
    const acctOptionsForRow = accounts.map((a) => `<option value="${a.id}" ${Number(a.id) === Number(e.account_id) ? "selected" : ""}>${escapeHtml(a.name)}</option>`).join("");
    return `
    <tr>
      <td data-label="Date">${e.expense_date}</td>
      <td data-label="Category">${escapeHtml(e.category)}</td>
      <td class="num" data-label="Amount">${money(e.amount)}</td>
      <td data-label="Account"><a href="/expenses?accountId=${e.account_id}">${escapeHtml(e.account_name)}</a></td>
      <td data-label="Note">${escapeHtml(e.note || "")}</td>
      <td data-label="">
        <div class="inline-edit">
          <input type="checkbox" id="${cb}" class="ie-toggle">
          <span class="ie-view row-actions">
            <label for="${cb}" class="icon-btn ghost" title="Edit expense">${icon(ICON.pencil, 13)}</label>
            <form method="post" action="/expenses/${e.id}/delete" onsubmit="return confirm('Delete this expense? The account balance will be credited back.');" style="display:inline;">
              <input type="hidden" name="reason" value="Deleted by owner">
              <input type="hidden" name="redirectTo" value="${redirectTo}">
              <button type="submit" class="icon-btn bad" title="Delete expense">${icon(ICON.x, 13)}</button>
            </form>
          </span>
          <form method="post" action="/expenses/${e.id}/edit" class="ie-form popover">
            <input type="hidden" name="redirectTo" value="${redirectTo}">
            <label class="field"><span>Date</span><input type="date" name="expenseDate" value="${e.expense_date}" required></label>
            <label class="field"><span>Category</span><input name="category" value="${escapeHtml(e.category)}" required></label>
            <label class="field"><span>Amount</span><input type="number" name="amount" value="${e.amount}" required></label>
            <label class="field"><span>Account</span><select name="accountId">${acctOptionsForRow}</select></label>
            <label class="field"><span>Note</span><input name="note" value="${escapeHtml(e.note || "")}"></label>
            <div class="popover-actions">
              <button type="submit" class="icon-btn good" title="Save">${icon(ICON.check, 13)}</button>
              <label for="${cb}" class="icon-btn bad" title="Cancel">${icon(ICON.x, 13)}</label>
            </div>
          </form>
        </div>
      </td>
    </tr>`;
  }).join("");

  const total = expenses.reduce((s, e) => s + Number(e.amount), 0);

  // Account filter tabs — same visual/composition pattern as the floor tabs on
  // Tenants/Rent Collection: "All accounts" plus one tab per account, current
  // selection highlighted. Filtering doesn't change the "+ Log an expense"
  // form — a new expense can still be logged against any account regardless
  // of which one you're currently filtered to.
  const acctTabs = [`<a href="/expenses" class="${!accountId ? "active" : ""}">All accounts</a>`]
    .concat(accounts.map((a) => `<a href="/expenses?accountId=${a.id}" class="${String(accountId) === String(a.id) ? "active" : ""}">${escapeHtml(a.name)}</a>`))
    .join("");
  const filteredAccountName = accountId ? accounts.find((a) => String(a.id) === String(accountId))?.name : null;

  return `
    <div class="toolbar">
      <h1>Expenses</h1>
      <details>
        <summary class="btn primary" style="display:inline-flex;cursor:pointer;">+ Log an expense</summary>
        <form method="post" action="/expenses" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:flex-end;">
          <label class="field"><span>Date</span><input type="date" name="expenseDate" value="${new Date().toISOString().slice(0, 10)}" required></label>
          <label class="field"><span>Category</span><input name="category" placeholder="Electricity, WiFi, salary…" required style="width:180px;"></label>
          <label class="field"><span>Amount</span><input type="number" name="amount" required style="width:120px;"></label>
          <label class="field"><span>Paid from</span><select name="accountId">${accountOptions}</select></label>
          <label class="field"><span>Note</span><input name="note" style="width:220px;"></label>
          <button type="submit" class="btn primary">Save</button>
        </form>
      </details>
    </div>
    <div class="tabs">${acctTabs}</div>
    <div class="card" style="padding:6px 20px;">
      <table class="responsive">
        <thead><tr><th>Date</th><th>Category</th><th class="num">Amount</th><th>Account</th><th>Note</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" style="color:var(--ink-faint);padding:14px 0;">No expenses${filteredAccountName ? ` from ${escapeHtml(filteredAccountName)}` : ""} yet.</td></tr>`}</tbody>
        ${expenses.length ? `<tfoot><tr style="font-weight:700;"><td colspan="2" data-label="">Total</td><td class="num" data-label="Total">${money(total)}</td><td colspan="3" data-label=""></td></tr></tfoot>` : ""}
      </table>
    </div>
  `;
}

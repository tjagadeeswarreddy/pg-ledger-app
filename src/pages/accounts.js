import { money, pill, escapeHtml, icon, ICON } from "../render.js";
import * as repo from "../repo.js";

export async function accountsPage() {
  const accounts = await repo.listAllAccounts();
  const { rows: incomeRows, total: incomeTotal } = await repo.accountsIncomeSummary();

  const incomeTableRows = incomeRows.map((r) => {
    const active = r.is_active === "t" || r.is_active === true;
    return `<tr>
      <td data-label="Account"><a href="/accounts/${r.id}?type=credit">${escapeHtml(r.name)}</a>${active ? "" : " " + pill("Inactive", "neutral")}</td>
      <td data-label="Type" class="hide-mobile">${escapeHtml(r.type)}</td>
      <td class="num" data-label="Total income">${money(r.income)}</td>
    </tr>`;
  }).join("");

  const cards = accounts.map((a) => {
    // psql's --csv output hands back every value as a plain string, booleans
    // included ("t" / "f") — so a.is_active is truthy either way unless it's
    // explicitly compared against the string psql actually sends.
    const active = a.is_active === "t" || a.is_active === true;
    const cb = `acct-edit-${a.id}`;
    const typeOptions = ["bank", "cash", "upi"].map((v) => `<option value="${v}" ${a.type === v ? "selected" : ""}>${v[0].toUpperCase()}${v.slice(1)}</option>`).join("");
    const deleteOrReactivate = active
      ? `<form method="post" action="/accounts/${a.id}/delete" onsubmit="return confirm('Delete ${escapeHtml(a.name)}? If it has any transaction history it will be marked inactive instead of removed.');" style="display:inline;">
           <button type="submit" class="icon-btn bad" title="Delete account">${icon(ICON.x, 13)}</button>
         </form>`
      : `<form method="post" action="/accounts/${a.id}/reactivate" style="display:inline;">
           <button type="submit" class="icon-btn" title="Reactivate account">${icon(ICON.undo, 13)}</button>
         </form>`;
    return `
    <div class="card" style="padding:16px 18px;${active ? "" : "opacity:.6;"}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div class="lbl">${escapeHtml(a.type)}</div>
        ${active ? "" : pill("Inactive", "neutral")}
      </div>
      <div class="acct-name" style="font-size:14.5px;font-weight:600;margin-top:6px;">${escapeHtml(a.name)}</div>
      <div class="mono" style="font-size:20px;font-weight:600;margin-top:8px;">${money(a.balance)}</div>
      <div style="margin-top:10px;display:flex;justify-content:space-between;align-items:center;">
        <a href="/accounts/${a.id}" style="font-size:12.5px;">view transactions →</a>
        <div class="inline-edit">
          <input type="checkbox" id="${cb}" class="ie-toggle">
          <span class="ie-view row-actions">
            <label for="${cb}" class="icon-btn ghost" title="Edit account">${icon(ICON.pencil, 13)}</label>
            ${deleteOrReactivate}
          </span>
          <form method="post" action="/accounts/${a.id}/edit" class="ie-form popover">
            <label class="field"><span>Name</span><input name="name" value="${escapeHtml(a.name)}" required></label>
            <label class="field"><span>Type</span><select name="type">${typeOptions}</select></label>
            <label class="field"><span>Opening balance</span><input name="openingBalance" type="number" value="${a.opening_balance}" required></label>
            <div class="popover-actions">
              <button type="submit" class="icon-btn good" title="Save">${icon(ICON.check, 13)}</button>
              <label for="${cb}" class="icon-btn bad" title="Cancel">${icon(ICON.x, 13)}</label>
            </div>
          </form>
        </div>
      </div>
    </div>`;
  }).join("");

  return `
    <div class="toolbar">
      <h1>Accounts</h1>
      <details>
        <summary class="btn primary" style="display:inline-flex;cursor:pointer;">+ Add account</summary>
        <form method="post" action="/accounts" style="display:flex;gap:8px;margin-top:10px;align-items:flex-end;flex-wrap:wrap;">
          <label class="field"><span>Name</span><input name="name" required style="width:200px;"></label>
          <label class="field"><span>Type</span><select name="type"><option value="bank">Bank</option><option value="cash">Cash</option><option value="upi">UPI</option></select></label>
          <label class="field"><span>Opening balance</span><input name="openingBalance" type="number" value="0" style="width:140px;"></label>
          <button type="submit" class="btn primary">Add</button>
        </form>
      </details>
    </div>
    <div class="card" style="padding:6px 20px;margin-bottom:20px;">
      <h2 style="padding-top:12px;">Income by account</h2>
      <table class="responsive">
        <thead><tr><th>Account</th><th class="hide-mobile">Type</th><th class="num">Total income</th></tr></thead>
        <tbody>${incomeTableRows || `<tr><td colspan="3" style="color:var(--ink-faint);padding:14px 0;">No accounts yet.</td></tr>`}</tbody>
        ${incomeRows.length ? `<tfoot><tr style="font-weight:600;border-top:1px solid var(--line);">
          <td data-label="Total">Total</td><td class="hide-mobile"></td><td class="num" data-label="Total">${money(incomeTotal)}</td>
        </tr></tfoot>` : ""}
      </table>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;">
      ${cards || `<div style="color:var(--ink-faint);">No accounts yet.</div>`}
    </div>
  `;
}

export async function accountDetailPage(id, { type } = {}) {
  const accounts = await repo.listAllAccounts();
  const account = accounts.find((a) => String(a.id) === String(id));
  if (!account) return null;
  const accountActive = account.is_active === "t" || account.is_active === true;
  const typeFilter = type === "credit" || type === "debit" ? type : null;
  const txns = await repo.accountTransactions(id, { type: typeFilter });

  const rows = txns.map((t) => `
    <tr>
      <td data-label="Date">${t.txn_date}</td>
      <td data-label="Type">${t.type === "credit" ? pill("Credit", "good") : pill("Debit", "bad")}</td>
      <td class="num" data-label="Amount">${money(t.amount)}</td>
      <td data-label="Source">${escapeHtml(t.source)}</td>
      <td data-label="Note">${escapeHtml(t.note || "")}</td>
    </tr>`).join("");

  const tabs = [
    { key: null, label: "All" },
    { key: "credit", label: "Credit" },
    { key: "debit", label: "Debit" },
  ].map((tb) => `<a href="/accounts/${id}${tb.key ? `?type=${tb.key}` : ""}" class="${typeFilter === tb.key ? "active" : ""}">${tb.label}</a>`).join("");

  return `
    <div class="toolbar">
      <div>
        <h1>${escapeHtml(account.name)}</h1>
        <div class="lbl" style="margin-top:3px;">Balance: <span class="mono">${money(account.balance)}</span>${accountActive ? "" : " · " + pill("Inactive", "neutral")}</div>
      </div>
      <a class="btn" href="/accounts">Back</a>
    </div>
    <div class="tabs">${tabs}</div>
    <div class="card" style="padding:6px 20px;">
      <table class="responsive">
        <thead><tr><th>Date</th><th>Type</th><th class="num">Amount</th><th>Source</th><th>Note</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" style="color:var(--ink-faint);padding:14px 0;">No transactions yet.</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

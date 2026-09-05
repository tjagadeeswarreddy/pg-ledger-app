import { money, escapeHtml, pill } from "../render.js";
import * as repo from "../repo.js";
import { query } from "../db.js";

export async function financialSummaryPage({ year, month } = {}) {
  const now = new Date();
  year = Number(year) || now.getFullYear();
  month = Number(month) || now.getMonth() + 1;

  // Get current month expected rent
  const expectedRent = await query(`
    SELECT COALESCE(sum(expected_amount), 0) AS total
    FROM rent_charges
    WHERE period_year = ${year} AND period_month = ${month} AND status = 'active'
  `);
  const totalExpected = Number(expectedRent[0]?.total || 0);

  // Get current month collected rent
  const collectedRent = await query(`
    SELECT COALESCE(sum(p.amount), 0) AS total
    FROM payments p
    JOIN rent_charges rc ON rc.id = p.rent_charge_id
    WHERE rc.period_year = ${year}
      AND rc.period_month = ${month}
      AND p.status = 'active'
  `);
  const totalCollected = Number(collectedRent[0]?.total || 0);

  // Get outstanding receivables
  const outstanding = await query(`
    SELECT COALESCE(sum(
      CASE
        WHEN rc.status = 'waived' THEN 0
        ELSE GREATEST(rc.expected_amount - COALESCE((
          SELECT sum(p.amount) FROM payments p WHERE p.rent_charge_id = rc.id AND p.status = 'active'
        ), 0), 0)
      END
    ), 0) AS total
    FROM rent_charges rc
    WHERE rc.period_year = ${year} AND rc.period_month = ${month} AND rc.status = 'active'
  `);
  const outstandingAmount = Number(outstanding[0]?.total || 0);

  // Get expenses by category
  const expenses = await query(`
    SELECT category, COALESCE(sum(amount), 0) AS total
    FROM expenses
    WHERE EXTRACT(YEAR FROM expense_date) = ${year}
      AND EXTRACT(MONTH FROM expense_date) = ${month}
      AND status = 'active'
    GROUP BY category
    ORDER BY total DESC
  `);

  // Calculate totals
  const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.total), 0);
  const collectionRate = totalExpected > 0 ? Math.round((totalCollected / totalExpected) * 100) : 0;
  const netIncome = totalCollected - totalExpenses;

  // Build expense rows
  const expenseRows = expenses.map(e => `
    <tr>
      <td data-label="Category">${escapeHtml(e.category)}</td>
      <td class="num" data-label="Amount">${money(e.total)}</td>
    </tr>
  `).join("");

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };

  return `
    <div class="toolbar">
      <div>
        <h1>Financial Summary</h1>
        <div class="lbl" style="margin-top:3px;">${monthLabel}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <a class="btn" href="/financial-summary?year=${prev.y}&month=${prev.m}">&larr; Prev</a>
        <a class="btn" href="/financial-summary?year=${next.y}&month=${next.m}">Next &rarr;</a>
      </div>
    </div>

    <!-- Revenue Section -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:16px;padding:0 20px 20px;">
      <div class="card" style="padding:20px;">
        <div class="lbl">Expected Revenue</div>
        <div style="font-size:28px;font-weight:700;margin:8px 0;">${money(totalExpected)}</div>
        <div style="font-size:13px;color:var(--ink-faint);">total rent due</div>
      </div>
      <div class="card" style="padding:20px;">
        <div class="lbl">Collected Revenue</div>
        <div style="font-size:28px;font-weight:700;margin:8px 0;color:var(--good);">${money(totalCollected)}</div>
        <div style="font-size:13px;color:var(--ink-faint);">payments received</div>
      </div>
      <div class="card" style="padding:20px;">
        <div class="lbl">Collection Rate</div>
        <div style="font-size:28px;font-weight:700;margin:8px 0;color:${collectionRate >= 80 ? 'var(--good)' : collectionRate >= 50 ? '#FF9800' : 'var(--bad)'};">${collectionRate}%</div>
        <div style="font-size:13px;color:var(--ink-faint);">efficiency metric</div>
      </div>
      <div class="card" style="padding:20px;">
        <div class="lbl">Outstanding Amount</div>
        <div style="font-size:28px;font-weight:700;margin:8px 0;color:var(--bad);">${money(outstandingAmount)}</div>
        <div style="font-size:13px;color:var(--ink-faint);">yet to be collected</div>
      </div>
    </div>

    <!-- Expenses Section -->
    <div class="card" style="padding:18px 20px;margin:0 20px 20px;">
      <h2 style="margin:0 0 12px;font-size:16px;">Expense Breakdown</h2>
      <div class="card" style="padding:6px 20px;margin:0;border:none;">
        <table class="responsive" style="margin:0;">
          <thead><tr><th>Category</th><th class="num">Amount</th></tr></thead>
          <tbody>${expenseRows || '<tr><td colspan="2" style="color:var(--ink-faint);padding:14px 0;">No expenses recorded.</td></tr>'}</tbody>
          ${expenses.length ? `<tfoot><tr style="font-weight:600;border-top:1px solid var(--line);">
            <td data-label="Total">Total Expenses</td><td class="num" data-label="Amount">${money(totalExpenses)}</td>
          </tr></tfoot>` : ""}
        </table>
      </div>
    </div>

    <!-- Net Income Section -->
    <div class="card" style="padding:20px;margin:0 20px 20px;background:${netIncome > 0 ? '#E8F5E9' : '#FFEBEE'};border-color:${netIncome > 0 ? '#C8E6C9' : '#FFCDD2'};">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        <div>
          <div class="lbl">Total Revenue</div>
          <div style="font-size:24px;font-weight:700;margin:8px 0;color:var(--good);">${money(totalCollected)}</div>
        </div>
        <div>
          <div class="lbl">Total Expenses</div>
          <div style="font-size:24px;font-weight:700;margin:8px 0;color:var(--bad);">${money(totalExpenses)}</div>
        </div>
      </div>
      <div style="border-top:2px solid var(--line);margin-top:16px;padding-top:16px;">
        <div class="lbl">Net Income</div>
        <div style="font-size:32px;font-weight:700;margin:8px 0;color:${netIncome > 0 ? 'var(--good)' : 'var(--bad)'};">${money(netIncome)}</div>
        <div style="font-size:13px;color:var(--ink-faint);">profit after expenses</div>
      </div>
    </div>
  `;
}

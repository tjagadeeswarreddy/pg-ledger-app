import { money, pill, escapeHtml } from "../render.js";
import * as repo from "../repo.js";

export async function dashboardPage() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const monthName = now.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  await repo.ensureChargesForMonth(year, month);

  const kpis = await repo.dashboardKpis(year, month);
  const floors = await repo.floorPerformance(year, month);
  const payments = await repo.recentPayments(6);
  const upcoming = await repo.upcomingDues(3);
  const onNotice = await repo.tenantsOnNotice();

  const pct = kpis.expected ? Math.round((kpis.collected / kpis.expected) * 100) : 0;

  let totalExpected = 0, totalActual = 0;
  const floorRows = floors.map((f) => {
    const exp = Number(f.expected), act = Number(f.actual);
    const out = Math.max(exp - act, 0);
    const diff = act - exp;
    totalExpected += exp;
    totalActual += act;
    const barPct = exp ? Math.min(100, Math.round((act / exp) * 100)) : 0;
    const barColor = out === 0 ? "var(--good)" : (act / (exp || 1) > 0.75 ? "var(--warn)" : "var(--bad)");
    return `<tr>
      <td data-label="Floor">${f.name}</td>
      <td data-label="Collected"><div class="barbg"><div class="barfill" style="width:${barPct}%;background:${barColor};"></div></div></td>
      <td class="num" data-label="Expected">${money(exp)}</td>
      <td class="num" data-label="Actual">${money(act)}</td>
      <td class="num" data-label="Difference" style="color:${diff < 0 ? "var(--bad)" : diff > 0 ? "var(--good)" : "var(--ink-faint)"};">${diff > 0 ? "+" : ""}${money(diff)}</td>
    </tr>`;
  }).join("");
  const totalDiff = totalActual - totalExpected;
  const totalsRow = floors.length ? `
    <tr style="font-weight:600;border-top:1px solid var(--line);">
      <td data-label="Total">Total</td>
      <td data-label=""></td>
      <td class="num" data-label="Expected">${money(totalExpected)}</td>
      <td class="num" data-label="Actual">${money(totalActual)}</td>
      <td class="num" data-label="Difference" style="color:${totalDiff < 0 ? "var(--bad)" : totalDiff > 0 ? "var(--good)" : "var(--ink-faint)"};">${totalDiff > 0 ? "+" : ""}${money(totalDiff)}</td>
    </tr>
    <tr>
      <td data-label="Outstanding">Outstanding</td>
      <td data-label=""></td>
      <td data-label=""></td>
      <td data-label=""></td>
      <td class="num" data-label="Outstanding" style="color:${kpis.outstanding === 0 ? "var(--ink-faint)" : "var(--bad)"};">${money(kpis.outstanding)}</td>
    </tr>` : "";

  // "Coming up" — the two things the dashboard used to say nothing about:
  // dues about to become due (not yet overdue, just approaching), and
  // tenants who've already said they're leaving. Both link straight to the
  // tenant's profile, same as Recent payments does.
  const upcomingRows = upcoming.length ? upcoming.map((u) => `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px;">
      <div><a href="/tenants/${u.tenant_id}" style="color:inherit;">${escapeHtml(u.full_name)}</a> <span class="lbl">· ${escapeHtml(u.room_no)}</span></div>
      <div style="text-align:right;flex-shrink:0;">
        <span class="mono">${money(u.monthly_rent)}</span>
        <span class="lbl" style="margin-left:6px;">${u.days_until === 0 ? "today" : u.days_until === 1 ? "tomorrow" : `in ${u.days_until}d`}</span>
      </div>
    </div>`).join("") : `<div style="color:var(--ink-faint);font-size:13px;padding:6px 0;">Nothing due in the next 3 days.</div>`;

  const noticeRows = onNotice.length ? onNotice.map((t) => `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px;">
      <div><a href="/tenants/${t.id}" style="color:inherit;">${escapeHtml(t.full_name)}</a> <span class="lbl">· ${escapeHtml(t.room_no)}</span></div>
      <div style="text-align:right;flex-shrink:0;font-size:12px;color:${t.vacating_this_month ? "var(--warn)" : "var(--ink-soft)"};">${t.expected_vacate_date ? `leaving ${t.expected_vacate_date}` : "no date given"}</div>
    </div>`).join("") : `<div style="color:var(--ink-faint);font-size:13px;padding:6px 0;">No one on notice right now.</div>`;

  const vacatingThisMonthCount = onNotice.filter((t) => t.vacating_this_month).length;

  const paymentRows = payments.length ? payments.map((p) => `
    <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--line);">
      <div><div style="font-size:13px;font-weight:500;">${p.full_name}</div><div class="lbl">Room ${p.room_no} · ${p.account_name}</div></div>
      <div style="text-align:right;"><div class="mono" style="font-size:13px;">${money(p.amount)}</div><div class="lbl">${p.pay_date}</div></div>
    </div>`).join("") : `<div style="color:var(--ink-faint);font-size:13px;padding:8px 0;">No payments recorded yet this month.</div>`;

  const body = `
    <div class="toolbar">
      <div>
        <h1>Dashboard</h1>
        <div class="lbl" style="margin-top:3px;">${monthName}</div>
      </div>
      <a class="btn primary" href="/rent">Go to Rent Collection</a>
    </div>

    <div class="grid4" style="margin-bottom:20px;">
      <div class="card" style="padding:16px 18px;">
        <div class="lbl">Collected — this month</div>
        <div class="mono" style="font-size:23px;font-weight:600;margin-top:8px;">${money(kpis.collected)}</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-top:4px;">of ${money(kpis.expected)} · ${pct}%</div>
      </div>
      <div class="card" style="padding:16px 18px;">
        <div class="lbl">Outstanding</div>
        <div class="mono" style="font-size:23px;font-weight:600;margin-top:8px;color:var(--bad);">${money(kpis.outstanding)}</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-top:4px;">${kpis.overdueCount} tenants overdue</div>
      </div>
      <div class="card" style="padding:16px 18px;">
        <div class="lbl">Occupancy</div>
        <div class="mono" style="font-size:23px;font-weight:600;margin-top:8px;">${kpis.occupied} / ${kpis.totalBeds}</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-top:4px;">${kpis.totalBeds - kpis.occupied} beds vacant</div>
      </div>
      <div class="card" style="padding:16px 18px;">
        <div class="lbl">Across accounts</div>
        <div class="mono" style="font-size:23px;font-weight:600;margin-top:8px;">${money(kpis.accountsTotal)}</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-top:4px;"><a href="/accounts">view accounts</a></div>
      </div>
    </div>

    <div class="card" style="padding:18px 20px;margin-bottom:20px;">
      <h2>Coming up</h2>
      <div class="grid2">
        <div>
          <div class="lbl" style="margin-bottom:6px;">Dues in the next 3 days (${upcoming.length})</div>
          ${upcomingRows}
        </div>
        <div>
          <div class="lbl" style="margin-bottom:6px;">On notice (${onNotice.length})${vacatingThisMonthCount ? ` <span style="color:var(--warn);text-transform:none;">— ${vacatingThisMonthCount} vacating this month</span>` : ""}</div>
          ${noticeRows}
        </div>
      </div>
    </div>

    <div class="stack-row">
      <div class="card" style="flex:1.5;padding:18px 20px;">
        <h2>Floor performance</h2>
        <table class="responsive">
          <thead><tr><th>Floor</th><th>Collected</th><th class="num">Expected</th><th class="num">Actual</th><th class="num">Difference</th></tr></thead>
          <tbody>${floorRows}${totalsRow}</tbody>
        </table>
      </div>
      <div class="card" style="flex:1;padding:18px 20px;">
        <h2>Recent payments</h2>
        ${paymentRows}
      </div>
    </div>
  `;
  return body;
}

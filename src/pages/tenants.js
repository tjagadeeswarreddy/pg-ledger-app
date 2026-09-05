import { money, pill, escapeHtml, ordinal, voidPaymentCell, editPaymentCell, whatsappLink, icon, ICON } from "../render.js";
import * as repo from "../repo.js";
import { query, hasValue } from "../db.js";

// One place for the Active/Notice/Vacated pill logic — a tenant "on notice"
// is still status='active' in the DB (see schema.sql's comment on
// notice_date), so the pill has to look at notice_date too, not just status.
function tenantStatusPill(t) {
  if (t.status === "vacated") return pill("Vacated", "neutral");
  if (hasValue(t.notice_date)) return pill("Notice", "warn");
  return pill("Active", "good");
}

export async function tenantsListPage({ status = "active", floorId, roomId, search = "", sort = "name", dir = "asc" } = {}) {
  const floors = await repo.listFloors();
  let tenants = await repo.listTenants({ status, floorId, roomId, search });
  const room = roomId ? await repo.getRoom(roomId) : null;
  const emptyRooms = await repo.getEmptyRooms();

  // Fetch payment status for active tenants (for current month)
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const paymentStatus = {};
  const daysOverdueMap = {}; // Track days overdue for each tenant
  for (const t of tenants) {
    if (t.status === "active" || t.status === "vacated") {
      const status = await repo.getPaymentStatusForTenant(t.id, year, month);
      paymentStatus[t.id] = status;
      
      // Fetch the charge to get days overdue information
      const charge = await repo.getChargeForTenant(t.id, year, month);
      if (charge) {
        daysOverdueMap[t.id] = await repo.getDaysOverdue(charge.id);
      }
    }
  }

  // Sort tenants based on the sort column and direction
  const sortComparators = {
    name: (a, b) => a.full_name.localeCompare(b.full_name),
    room: (a, b) => {
      const aRoom = `${a.floor_name}${a.room_no}`;
      const bRoom = `${b.floor_name}${b.room_no}`;
      return aRoom.localeCompare(bRoom);
    },
    rent: (a, b) => Number(a.monthly_rent) - Number(b.monthly_rent),
    payment: (a, b) => {
      const statusOrder = { "Paid": 0, "No due yet": 1, "Overdue": 2, "—": 3 };
      const aStatus = paymentStatus[a.id] || "—";
      const bStatus = paymentStatus[b.id] || "—";
      return (statusOrder[aStatus] || 3) - (statusOrder[bStatus] || 3);
    }
  };

  if (sortComparators[sort]) {
    tenants.sort(sortComparators[sort]);
    if (dir === "desc") tenants.reverse();
  }

  // The Name cell doubles as the mobile card's identity header: the tenant's
  // name in bold with the room folded in underneath as a subtitle, so a
  // glance at a stacked mobile card says whose card it is. The separate Room
  // column is then hidden on mobile only (card-id-cell/card-id-sub, hide-mobile
  // — see BASE_CSS) to avoid showing the room twice; desktop is unaffected.
  const rows = tenants.map((t) => {
    const payStatus = paymentStatus[t.id] || "—";
    const daysOverdue = daysOverdueMap[t.id];
    let payStatusClass = "";
    let displayPayStatus = payStatus;
    
    if (payStatus === "Paid") {
      payStatusClass = "good";
    } else if (payStatus === "Partial") {
      payStatusClass = "warn";
      displayPayStatus = "Partial";
    } else if (payStatus.startsWith("Overdue") || (daysOverdue !== undefined && daysOverdue > 0)) {
      payStatusClass = "bad";
      const days = daysOverdue || 0;
      displayPayStatus = `Overdue ${days}d`;
    } else if (daysOverdue === 0) {
      payStatusClass = "warn";
      displayPayStatus = "Due";
    } else if (daysOverdue !== undefined && daysOverdue < 0) {
      payStatusClass = "neutral";
      displayPayStatus = "Not due";
    }
    return `
    <tr>
      <td data-label="Name" class="card-id-cell">
        <a href="/tenants/${t.id}" class="card-id" style="text-decoration:none;color:inherit;">${escapeHtml(t.full_name)}</a>
        <div class="card-id-sub">${escapeHtml(t.floor_name)} · ${escapeHtml(t.room_no)}-${t.bed_no}</div>
      </td>
      <td data-label="Room" class="hide-mobile">${escapeHtml(t.floor_name)} · ${escapeHtml(t.room_no)}-${t.bed_no}</td>
      <td data-label="Phone" class="hide-mobile">${escapeHtml(t.phone || "")}${whatsappLink(t.phone)}</td>
      <td class="num" data-label="Rent">${money(t.monthly_rent)}</td>
      <td data-label="Payment" class="hide-mobile" ${payStatusClass ? `style="color:var(--${payStatusClass})"` : ""}>${payStatus}</td>
      <td data-label="Status">${tenantStatusPill(t)}</td>
      <td data-label="">${t.status === "vacated" ? `
        <form method="post" action="/tenants/${t.id}/delete" onsubmit="return confirm('Permanently delete ${escapeHtml(t.full_name)}? This removes their profile and full billing history — it cannot be undone.');" style="display:inline;">
          <input type="hidden" name="redirectTo" value="/tenants?status=${status}${floorId ? `&floorId=${floorId}` : ""}${roomId ? `&roomId=${roomId}` : ""}${search ? `&q=${encodeURIComponent(search)}` : ""}">
          <button type="submit" class="icon-btn bad" title="Delete tenant">${icon(ICON.x, 13)}</button>
        </form>` : ""}</td>
    </tr>`;
  }).join("");

  // A dense, two-line-per-tenant list shown only on mobile in place of the
  // table above (see .tenant-cards in BASE_CSS) — a phone screen fits many
  // of these at once, where the full 6-field stacked card only fit one or
  // two. Name + status up top, room/bed + rent underneath; both link to the
  // full profile for anything not shown here (phone, joined date, etc).
  const tenantCards = tenants.map((t) => {
    const deleteBtn = t.status === "vacated" ? `
      <form method="post" action="/tenants/${t.id}/delete" onsubmit="return confirm('Permanently delete ${escapeHtml(t.full_name)}? This removes their profile and full billing history — it cannot be undone.');" style="display:inline;">
        <input type="hidden" name="redirectTo" value="/tenants?status=${status}${floorId ? `&floorId=${floorId}` : ""}${roomId ? `&roomId=${roomId}` : ""}${search ? `&q=${encodeURIComponent(search)}` : ""}">
        <button type="submit" class="icon-btn bad" title="Delete tenant">${icon(ICON.x, 11)}</button>
      </form>` : "";
    return `
      <div class="tcard">
        <div class="tcard-row1">
          <a href="/tenants/${t.id}" class="tcard-name">${escapeHtml(t.full_name)}</a>
          <span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">${(() => {
          const status = paymentStatus[t.id];
          const daysOverdue = daysOverdueMap[t.id];
          let color = "neutral";
          let label = "—";
          
          if (status === "Paid") {
            color = "good";
            label = "Paid";
          } else if (status === "Partial") {
            color = "warn";
            label = "Partial";
          } else if (status.startsWith("Overdue") || (daysOverdue !== undefined && daysOverdue > 0)) {
            color = "bad";
            const days = daysOverdue || 0;
            label = `Overdue ${days}d`;
          } else if (daysOverdue === 0) {
            color = "warn";
            label = "Due";
          } else if (daysOverdue !== undefined && daysOverdue < 0) {
            color = "neutral";
            label = "Not due";
          }
          
          return label !== "—" ? pill(label, color) : "—";
        })()}${whatsappLink(t.phone)}${deleteBtn}</span>
        </div>
        <a href="/tenants/${t.id}" class="tcard-row2">
          <span>${escapeHtml(t.floor_name)} · ${escapeHtml(t.room_no)}-${t.bed_no}</span>
          <span class="mono">${money(t.monthly_rent)}</span>
        </a>
      </div>`;
  }).join("");

  // Helper to create sortable header links
  function sortHeader(label, sortKey) {
    const isCurrent = sort === sortKey;
    const newDir = isCurrent && dir === "asc" ? "desc" : "asc";
    const arrow = isCurrent ? (dir === "asc" ? " ↑" : " ↓") : "";
    const qs = `?status=${status}${floorId ? `&floorId=${floorId}` : ""}${roomId ? `&roomId=${roomId}` : ""}${search ? `&q=${encodeURIComponent(search)}` : ""}&sort=${sortKey}&dir=${newDir}`;
    return `<a href="/tenants${qs}" style="text-decoration:none;color:inherit;display:flex;align-items:center;gap:4px;cursor:pointer;">${label}${arrow}</a>`;
  }

  // Each tab/filter set preserves the others — switching floor, status, or
  // room keeps whatever search text was typed too (same query-string-
  // composition pattern used throughout this page), so filtering doesn't
  // silently throw away a search the owner already typed.
  const roomQS = roomId ? `&roomId=${roomId}` : "";
  const searchQS = search ? `&q=${encodeURIComponent(search)}` : "";
  const floorQS = (floorId ? `&floorId=${floorId}` : "") + roomQS + searchQS;
  const floorTabs = [`<a href="/tenants?status=${status}${roomQS}${searchQS}" class="${!floorId ? "active" : ""}">All floors</a>`]
    .concat(floors.map((f) => `<a href="/tenants?status=${status}&floorId=${f.id}${roomQS}${searchQS}" class="${String(floorId) === String(f.id) ? "active" : ""}">${escapeHtml(f.name)}</a>`))
    .join("");

  // Arrived here via a room click on Floors & Rooms — a small banner says so
  // and offers a one-click way back to the unfiltered list (keeping whatever
  // floor/status tab was already selected).
  const roomBanner = room ? `
    <div class="card" style="padding:10px 16px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;">
      <div style="font-size:13px;">Showing tenants in <strong>${escapeHtml(room.floor_name)} · Room ${escapeHtml(room.room_no)}</strong></div>
      <a href="/tenants?status=${status}${floorId ? `&floorId=${floorId}` : ""}${searchQS}" style="font-size:12.5px;">✕ Clear room filter</a>
    </div>` : "";

  // Plain GET form — no JavaScript needed, the browser's own navigation does
  // the filtering by reloading the page with ?q=. Hidden fields carry the
  // status/floor/room tabs already selected so searching doesn't reset them.
  const searchBar = `
    <form method="get" action="/tenants" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">
      <input type="hidden" name="status" value="${status}">
      ${floorId ? `<input type="hidden" name="floorId" value="${floorId}">` : ""}
      ${roomId ? `<input type="hidden" name="roomId" value="${roomId}">` : ""}
      <input type="search" name="q" value="${escapeHtml(search)}" placeholder="Search by name or phone…"
        style="flex:1;min-width:180px;max-width:320px;padding:8px 10px;border:1px solid var(--line);border-radius:7px;font-family:inherit;font-size:13.5px;color:var(--ink);background:var(--surface);">
      <button type="submit" class="btn small">Search</button>
      ${search ? `<a class="btn small" href="/tenants?status=${status}${floorId ? `&floorId=${floorId}` : ""}${roomQS}">✕ Clear search</a>` : ""}
    </form>`;

  return `
    <div class="toolbar">
      <h1>Tenants</h1>
      <a class="btn primary" href="/tenants/new">+ Add tenant</a>
    </div>
    <div class="tabs">
      <a href="/tenants?status=active${floorQS}" class="${status === "active" ? "active" : ""}">Active</a>
      <a href="/tenants?status=notice${floorQS}" class="${status === "notice" ? "active" : ""}">Notice</a>
      <a href="/tenants?status=vacated${floorQS}" class="${status === "vacated" ? "active" : ""}">Vacated</a>
      <a href="/tenants?status=all${floorQS}" class="${status === "all" ? "active" : ""}">All</a>
    </div>
    <div class="tabs">${floorTabs}</div>
    ${roomBanner}
    ${searchBar}
    <div class="card" style="padding:6px 20px;">
      <div class="tenant-table-wrap">
        <table class="responsive">
          <thead><tr><th>${sortHeader("Name", "name")}</th><th>${sortHeader("Room", "room")}</th><th>Phone</th><th class="num">${sortHeader("Rent", "rent")}</th><th>${sortHeader("Payment", "payment")}</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="7" style="color:var(--ink-faint);padding:14px 0;">${search ? `No tenants match “${escapeHtml(search)}” in this view.` : "No tenants in this view."}</td></tr>`}</tbody>
        </table>
      </div>
      <div class="tenant-cards">
        ${tenantCards || `<div style="color:var(--ink-faint);padding:14px 4px;">${search ? `No tenants match “${escapeHtml(search)}” in this view.` : "No tenants in this view."}</div>`}
      </div>
    </div>
 
    `
}

export async function tenantNewPage() {
  const rooms = await repo.listRoomsWithOccupancy({ activeOnly: true });
  const occRows = await query(`SELECT room_id, bed_no FROM tenants WHERE status = 'active'`);
  const occByRoom = {};
  for (const r of occRows) { (occByRoom[r.room_id] ||= []).push(Number(r.bed_no)); }

  const roomOptions = rooms.map((r) => `<option value="${r.id}" data-sharing="${r.sharing_type}" data-rent="${r.default_rent}">${escapeHtml(r.floor_name)} · ${escapeHtml(r.room_no)} (${r.sharing_type}-sharing)</option>`).join("");
  const roomBedsJson = JSON.stringify(Object.fromEntries(rooms.map((r) => [r.id, { sharing: r.sharing_type, occupied: occByRoom[r.id] || [] }])));

  return `
    <div class="toolbar"><h1>Add a tenant</h1><a class="btn" href="/tenants">Cancel</a></div>
    <form method="post" action="/tenants" class="card" style="padding:22px 24px;display:flex;flex-direction:column;gap:16px;max-width:720px;">
      <div class="grid2">
        <label class="field"><span>Room</span>
          <select name="roomId" id="roomSel" required><option value="">Select a room…</option>${roomOptions}</select>
        </label>
        <label class="field"><span>Bed</span>
          <select name="bedNo" id="bedSel" required><option value="">Select a room first</option></select>
        </label>
      </div>
      <div class="grid2">
        <label class="field"><span>Full name</span><input name="fullName" required></label>
        <label class="field"><span>Phone</span><input name="phone"></label>
      </div>
      <div class="grid2">
        <label class="field"><span>Occupation</span><input name="occupation"></label>
        <label class="field"><span>ID proof (Aadhaar / PAN / …)</span><input name="idProofNumber"></label>
      </div>
      <div class="grid3">
        <label class="field"><span>Emergency contact name</span><input name="emergencyName"></label>
        <label class="field"><span>Emergency contact phone</span><input name="emergencyPhone"></label>
        <label class="field"><span>Relation</span><input name="emergencyRelation" placeholder="Father, mother…"></label>
      </div>
      <div class="grid3">
        <label class="field"><span>Joining date</span><input type="date" name="joiningDate" required value="${new Date().toISOString().slice(0, 10)}"></label>
        <label class="field"><span>Monthly rent</span><input type="number" name="monthlyRent" id="rentInput" required></label>
        <label class="field"><span>Deposit paid</span><input type="number" name="depositAmount" id="depositInput"></label>
      </div>
      <div class="grid3">
        <label class="field"><span>Rent due day of month</span><input type="number" name="rentDueDay" min="1" max="28" value="5" required></label>
      </div>
      <div class="hint" style="font-size:12.5px;color:var(--ink-faint);margin-top:-8px;">The month's due is added automatically once this day arrives. Pick 1–28 so it lands every month, including February.</div>
      <div><button type="submit" class="btn primary">Add tenant</button></div>
    </form>
    <script>
      const roomBeds = ${roomBedsJson};
      const roomSel = document.getElementById('roomSel');
      const bedSel = document.getElementById('bedSel');
      const rentInput = document.getElementById('rentInput');
      const depositInput = document.getElementById('depositInput');
      roomSel.addEventListener('change', () => {
        const info = roomBeds[roomSel.value];
        bedSel.innerHTML = '';
        if (!info) { bedSel.innerHTML = '<option value="">Select a room first</option>'; return; }
        for (let b = 1; b <= info.sharing; b++) {
          const opt = document.createElement('option');
          opt.value = b;
          const taken = info.occupied.includes(b);
          opt.textContent = 'Bed ' + b + (taken ? ' (occupied)' : '');
          if (taken) opt.disabled = true;
          bedSel.appendChild(opt);
        }
        const sel = roomSel.selectedOptions[0];
        if (sel) {
          rentInput.value = sel.dataset.rent;
          depositInput.value = 2000;
        }
      });
    </script>
  `;
}

export async function tenantEditPage(id) {
  const t = await repo.getTenant(id);
  if (!t) return null;
  // Only active rooms are offered for reassignment — except the tenant's own
  // current room, kept in the list even if it was deactivated since, so this
  // form doesn't silently drop their existing room from the picker.
  const rooms = await repo.listRoomsWithOccupancy({ activeOnly: true, includeRoomId: t.room_id });
  // Exclude this tenant's own bed from the "occupied" set, so their current
  // bed doesn't show up as taken-by-someone-else in their own edit form.
  const occRows = await query(`SELECT room_id, bed_no FROM tenants WHERE status = 'active' AND id != ${Number(id)}`);
  const occByRoom = {};
  for (const r of occRows) { (occByRoom[r.room_id] ||= []).push(Number(r.bed_no)); }

  const roomOptions = rooms.map((r) => `<option value="${r.id}" data-sharing="${r.sharing_type}" data-rent="${r.default_rent}" ${String(r.id) === String(t.room_id) ? "selected" : ""}>${escapeHtml(r.floor_name)} · ${escapeHtml(r.room_no)} (${r.sharing_type}-sharing)</option>`).join("");
  const roomBedsJson = JSON.stringify(Object.fromEntries(rooms.map((r) => [r.id, { sharing: r.sharing_type, occupied: occByRoom[r.id] || [] }])));

  return `
    <div class="toolbar"><h1>Edit tenant</h1><a class="btn" href="/tenants/${t.id}">Cancel</a></div>
    <form method="post" action="/tenants/${t.id}/edit" class="card" style="padding:22px 24px;display:flex;flex-direction:column;gap:16px;max-width:720px;">
      <div class="grid2">
        <label class="field"><span>Room</span>
          <select name="roomId" id="roomSel" required>${roomOptions}</select>
        </label>
        <label class="field"><span>Bed</span>
          <select name="bedNo" id="bedSel" required></select>
        </label>
      </div>
      <div class="grid2">
        <label class="field"><span>Full name</span><input name="fullName" required value="${escapeHtml(t.full_name)}"></label>
        <label class="field"><span>Phone</span><input name="phone" value="${escapeHtml(t.phone || "")}"></label>
      </div>
      <div class="grid2">
        <label class="field"><span>Occupation</span><input name="occupation" value="${escapeHtml(t.occupation || "")}"></label>
        <label class="field"><span>ID proof (Aadhaar / PAN / …)</span><input name="idProofNumber" value="${escapeHtml(t.id_proof_number || "")}"></label>
      </div>
      <div class="grid3">
        <label class="field"><span>Emergency contact name</span><input name="emergencyName" value="${escapeHtml(t.emergency_name || "")}"></label>
        <label class="field"><span>Emergency contact phone</span><input name="emergencyPhone" value="${escapeHtml(t.emergency_phone || "")}"></label>
        <label class="field"><span>Relation</span><input name="emergencyRelation" placeholder="Father, mother…" value="${escapeHtml(t.emergency_relation || "")}"></label>
      </div>
      <div class="grid3">
        <label class="field"><span>Joining date</span><input type="date" name="joiningDate" required value="${t.joining_date}"></label>
        <label class="field"><span>Monthly rent</span><input type="number" name="monthlyRent" id="rentInput" required value="${t.monthly_rent}"></label>
        <label class="field"><span>Deposit paid</span><input type="number" name="depositAmount" id="depositInput" value="${t.deposit_amount}"></label>
      </div>
      <div class="grid3">
        <label class="field"><span>Rent due day of month</span><input type="number" name="rentDueDay" min="1" max="28" required value="${t.rent_due_day || 5}"></label>
      </div>
      <div style="font-size:12.5px;color:var(--ink-faint);margin-top:-8px;">The month's due is added automatically once this day arrives. Pick 1–28 so it lands every month, including February.</div>
      <div><button type="submit" class="btn primary">Save changes</button></div>
    </form>
    <script>
      const roomBeds = ${roomBedsJson};
      const roomSel = document.getElementById('roomSel');
      const bedSel = document.getElementById('bedSel');
      const rentInput = document.getElementById('rentInput');
      const depositInput = document.getElementById('depositInput');
      const currentBed = ${Number(t.bed_no)};

      function populateBeds(autofillRent) {
        const info = roomBeds[roomSel.value];
        bedSel.innerHTML = '';
        if (!info) { bedSel.innerHTML = '<option value="">Select a room first</option>'; return; }
        for (let b = 1; b <= info.sharing; b++) {
          const opt = document.createElement('option');
          opt.value = b;
          const taken = info.occupied.includes(b);
          opt.textContent = 'Bed ' + b + (taken ? ' (occupied)' : '');
          if (taken) opt.disabled = true;
          if (String(roomSel.value) === '${t.room_id}' && b === currentBed) opt.selected = true;
          bedSel.appendChild(opt);
        }
        if (autofillRent) {
          const sel = roomSel.selectedOptions[0];
          if (sel) {
            rentInput.value = sel.dataset.rent;
            depositInput.value = Number(sel.dataset.rent) * 2;
          }
        }
      }
      // Initial load: populate beds for the tenant's current room, keep their existing rent/deposit as-is.
      populateBeds(false);
      // Only re-fill rent/deposit from the room's default when the owner actively picks a different room.
      roomSel.addEventListener('change', () => populateBeds(true));
    </script>
  `;
}

export async function tenantProfilePage(id) {
  const t = await repo.getTenant(id);
  if (!t) return null;
  const charges = await repo.listChargesForTenant(id);
  const payments = await query(`SELECT p.*, a.name AS account_name FROM payments p JOIN accounts a ON a.id = p.account_id WHERE p.tenant_id = ${Number(id)} ORDER BY p.pay_date DESC LIMIT 20`);
  const accounts = await repo.listAccountsWithBalance();
  const redirectTo = `/tenants/${id}`;
  const acctOptions = accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");
  const modeOptions = `<option value="upi">UPI</option><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="cheque">Cheque</option>`;

  // Same Paid/Partial/Overdue/Waived logic as Rent Collection and "Manage this
  // due" — the raw rent_charges.status column is only ever 'active' or
  // 'waived', which on its own says nothing about whether the due was
  // actually collected, so every unpaid row used to show a flat "Active" pill.
  const chargeRows = charges.map((c) => {
    const exp = Number(c.expected_amount);
    const paid = Number(c.paid_amount);
    const outstanding = c.status === "waived" ? 0 : Math.max(exp - paid, 0);
    const adjusted = hasValue(c.original_amount) && Number(c.original_amount) !== exp;

    let statusPill;
    if (c.status === "waived") statusPill = pill("Waived", "neutral");
    else if (outstanding === 0) statusPill = pill("Paid", "good");
    else if (paid > 0) statusPill = pill("Partial", "warn");
    else statusPill = pill("Overdue", "bad");

    let actionsCell;
    if (c.status === "waived") {
      actionsCell = `<form method="post" action="/rent/${c.id}/reinstate" style="display:inline;">
        <input type="hidden" name="redirectTo" value="${redirectTo}">
        <button type="submit" class="icon-btn" title="Reinstate this due">${icon(ICON.undo, 13)}</button>
      </form>`;
    } else {
      const payCb = `dc-pay-${c.id}`, editCb = `dc-ed-${c.id}`, waiveCb = `dc-wv-${c.id}`;
      actionsCell = `
        <div class="inline-edit">
          <input type="checkbox" id="${payCb}" class="ie-toggle">
          <label for="${payCb}" class="icon-btn ghost" title="Record a payment">${icon(ICON.pay, 13)}</label>
          <form method="post" action="/rent/${c.id}/pay" class="ie-form popover">
            <input type="hidden" name="redirectTo" value="${redirectTo}">
            <label class="field"><span>Amount</span><input type="number" name="amount" value="${outstanding || exp}" required></label>
            <label class="field"><span>Account</span><select name="accountId">${acctOptions}</select></label>
            <label class="field"><span>Mode</span><select name="mode">${modeOptions}</select></label>
            <div class="popover-actions">
              <button type="submit" class="icon-btn good" title="Save payment">${icon(ICON.check, 13)}</button>
              <label for="${payCb}" class="icon-btn bad" title="Cancel">${icon(ICON.x, 13)}</label>
            </div>
          </form>
        </div>
        <div class="inline-edit">
          <input type="checkbox" id="${editCb}" class="ie-toggle">
          <label for="${editCb}" class="icon-btn ghost" title="Edit amount">${icon(ICON.pencil, 13)}</label>
          <form method="post" action="/rent/${c.id}/edit-amount" class="ie-form popover">
            <input type="hidden" name="redirectTo" value="${redirectTo}">
            <label class="field"><span>New amount due</span><input type="number" name="amount" value="${exp}" required></label>
            <label class="field"><span>Reason</span><input name="reason" placeholder="e.g. prorated"></label>
            <div class="popover-actions">
              <button type="submit" class="icon-btn good" title="Save">${icon(ICON.check, 13)}</button>
              <label for="${editCb}" class="icon-btn bad" title="Cancel">${icon(ICON.x, 13)}</label>
            </div>
          </form>
        </div>
        <div class="inline-edit">
          <input type="checkbox" id="${waiveCb}" class="ie-toggle">
          <label for="${waiveCb}" class="icon-btn ghost" title="Waive this due">${icon(ICON.waive, 13)}</label>
          <form method="post" action="/rent/${c.id}/waive" class="ie-form popover">
            <input type="hidden" name="redirectTo" value="${redirectTo}">
            <label class="field"><span>Reason</span><input name="reason" placeholder="e.g. travelling, discount"></label>
            <div class="popover-actions">
              <button type="submit" class="icon-btn good" title="Confirm waive">${icon(ICON.check, 13)}</button>
              <label for="${waiveCb}" class="icon-btn bad" title="Cancel">${icon(ICON.x, 13)}</label>
            </div>
          </form>
        </div>
        <a class="icon-btn ghost" href="/rent/charge/${c.id}" title="View full payment history">${icon(ICON.history, 13)}</a>`;
    }

    return `
    <tr>
      <td data-label="Month">${c.period_year}-${String(c.period_month).padStart(2, "0")}</td>
      <td class="num" data-label="Expected">${money(exp)}${adjusted ? `<div style="font-size:11px;color:var(--ink-faint);margin-top:2px;" title="${escapeHtml(c.adjusted_reason || "")}">was ${money(c.original_amount)}</div>` : ""}</td>
      <td class="num" data-label="Outstanding" style="color:${outstanding > 0 ? "var(--bad)" : "var(--ink-faint)"};">${money(outstanding)}</td>
      <td data-label="Status">${statusPill}</td>
      <td data-label=""><div class="row-actions">${actionsCell}</div></td>
    </tr>`;
  }).join("");

  const now = new Date();
  const monthOptions = Array.from({ length: 12 }, (_, i) => i + 1)
    .map((m) => `<option value="${m}" ${m === now.getMonth() + 1 ? "selected" : ""}>${new Date(2000, m - 1, 1).toLocaleDateString("en-IN", { month: "long" })}</option>`).join("");
  const addDueForm = t.status === "active" ? `
    <details style="margin-bottom:10px;">
      <summary class="btn small" style="display:inline-flex;cursor:pointer;">+ Add due</summary>
      <form method="post" action="/rent/tenant/${t.id}/add-due" style="display:flex;gap:8px;margin-top:10px;align-items:flex-end;flex-wrap:wrap;">
        <input type="hidden" name="redirectTo" value="${redirectTo}">
        <label class="field"><span>Month</span><select name="month">${monthOptions}</select></label>
        <label class="field"><span>Year</span><input type="number" name="year" value="${now.getFullYear()}" style="width:90px;"></label>
        <button type="submit" class="btn small primary">Add due</button>
      </form>
    </details>` : "";

  const paymentRows = payments.map((p) => `
    <tr>
      <td data-label="Date">${p.pay_date}</td>
      <td class="num" data-label="Amount">${money(p.amount)}</td>
      <td data-label="Via">${escapeHtml(p.mode)} · ${escapeHtml(p.account_name)}</td>
      <td data-label="Status">${p.status === "voided" ? pill("Voided", "bad") : pill("Active", "good")}</td>
      <td data-label="">
        <div class="row-actions">
          ${editPaymentCell(p, accounts, { tenantId: id, redirectTo: `/tenants/${id}` })}
          ${voidPaymentCell(p, { tenantId: id, redirectTo: `/tenants/${id}` })}
        </div>
      </td>
    </tr>`).join("");

  const today = new Date().toISOString().slice(0, 10);
  const onNotice = t.status === "active" && hasValue(t.notice_date);

  // "Vacate" is now a popover instead of an instant submit, since it also
  // captures the deposit refund right there (a real gap this used to have —
  // the deposit paid in was tracked, but nothing about it going back out).
  // Refund amount defaults to the full deposit; the owner can lower it for
  // damages, or leave it as 0/blank and fill it in later from the Details
  // card's own Refund edit popover.
  const vacatePopover = `
    <div class="inline-edit">
      <input type="checkbox" id="vacate-toggle" class="ie-toggle">
      <span class="ie-view"><label for="vacate-toggle" class="btn danger" style="cursor:pointer;">Vacate</label></span>
      <form method="post" action="/tenants/${t.id}/vacate" class="ie-form popover" style="width:240px;">
        <label class="field"><span>Vacate date</span><input type="date" name="vacateDate" value="${today}" required></label>
        <label class="field"><span>Deposit refund amount</span><input type="number" name="refundAmount" value="${t.deposit_amount}"></label>
        <label class="field"><span>Refund date</span><input type="date" name="refundDate" value="${today}"></label>
        <div style="font-size:11px;color:var(--ink-faint);">Leave the refund at 0 if it isn't settled yet — it can be entered later from the Details card.</div>
        <div class="popover-actions">
          <button type="submit" class="icon-btn bad" title="Confirm vacate">${icon(ICON.check, 13)}</button>
          <label for="vacate-toggle" class="icon-btn ghost" title="Cancel">${icon(ICON.x, 13)}</label>
        </div>
      </form>
    </div>`;

  // "Give notice" only asks for an (optional) expected leaving date. It
  // never changes t.status — see repo.giveNotice's comment — so Edit/Vacate
  // stay available exactly as they were for a plain active tenant.
  const giveNoticePopover = `
    <div class="inline-edit">
      <input type="checkbox" id="notice-toggle" class="ie-toggle">
      <span class="ie-view"><label for="notice-toggle" class="btn" style="cursor:pointer;">Give notice</label></span>
      <form method="post" action="/tenants/${t.id}/give-notice" class="ie-form popover" style="width:220px;">
        <label class="field"><span>Expected vacate date (optional)</span><input type="date" name="expectedVacateDate"></label>
        <div class="popover-actions">
          <button type="submit" class="icon-btn good" title="Save">${icon(ICON.check, 13)}</button>
          <label for="notice-toggle" class="icon-btn ghost" title="Cancel">${icon(ICON.x, 13)}</label>
        </div>
      </form>
    </div>`;

  return `
    <div class="toolbar">
      <div>
        <h1>${escapeHtml(t.full_name)}</h1>
        <div class="lbl" style="margin-top:3px;">${escapeHtml(t.floor_name)} · Room ${escapeHtml(t.room_no)}, Bed ${t.bed_no}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:flex-start;">
        <a class="btn" href="/tenants">Back</a>
        ${t.status === "active" ? `<a class="btn" href="/tenants/${t.id}/edit">Edit</a>` : ""}
        ${t.status === "active" && !onNotice ? giveNoticePopover : ""}
        ${onNotice ? `<form method="post" action="/tenants/${t.id}/cancel-notice" onsubmit="return confirm('Cancel this notice? The tenant goes back to a plain Active status.');"><button class="btn" type="submit">Cancel notice</button></form>` : ""}
        ${t.status === "active" ? vacatePopover : ""}
        ${t.status === "vacated" ? `<form method="post" action="/tenants/${t.id}/delete" onsubmit="return confirm('Permanently delete ${escapeHtml(t.full_name)}? This removes their profile and full billing history — it cannot be undone.');"><button class="btn danger" type="submit">Delete</button></form>` : ""}
      </div>
    </div>

    <div class="stack-row" style="margin-bottom:18px;">
      <div class="card" style="flex:1;padding:18px 20px;">
        <h2>Details</h2>
        <div style="display:flex;flex-direction:column;gap:8px;font-size:13.5px;">
          <div><span class="lbl">Phone</span><br>${escapeHtml(t.phone || "—")}${whatsappLink(t.phone)}</div>
          <div><span class="lbl">Occupation</span><br>${escapeHtml(t.occupation || "—")}</div>
          <div><span class="lbl">ID proof</span><br>${escapeHtml(t.id_proof_type || "")} ${escapeHtml(t.id_proof_number || "—")}</div>
          <div><span class="lbl">Emergency contact</span><br>${escapeHtml(t.emergency_name || "—")} (${escapeHtml(t.emergency_relation || "—")}) · ${escapeHtml(t.emergency_phone || "—")}</div>
          <div><span class="lbl">Joining date</span><br>${t.joining_date}</div>
          <div><span class="lbl">Monthly rent</span><br>
            ${t.status === "active" ? `
            <div class="inline-edit" style="display:inline-flex;align-items:center;gap:6px;">
              <input type="checkbox" id="rent-ed" class="ie-toggle">
              <span class="ie-view" style="display:inline-flex;align-items:center;gap:6px;">
                <span class="mono">${money(t.monthly_rent)}</span>
                <label for="rent-ed" class="icon-btn ghost" title="Edit monthly rent">${icon(ICON.pencil, 12)}</label>
              </span>
              <form method="post" action="/tenants/${t.id}/edit-rent" class="ie-form popover">
                <label class="field"><span>New monthly rent</span><input type="number" name="monthlyRent" value="${t.monthly_rent}" required></label>
                <div style="font-size:11px;color:var(--ink-faint);margin:-4px 0 2px;">Only applies to future months — this month's due (if already created) isn't changed by this.</div>
                <div class="popover-actions">
                  <button type="submit" class="icon-btn good" title="Save">${icon(ICON.check, 13)}</button>
                  <label for="rent-ed" class="icon-btn bad" title="Cancel">${icon(ICON.x, 13)}</label>
                </div>
              </form>
            </div>` : `<span class="mono">${money(t.monthly_rent)}</span>`}
          </div>
          <div><span class="lbl">Rent due day</span><br>${ordinal(t.rent_due_day || 5)} of every month</div>
          <div>
            <span class="lbl">Deposit</span><br>
            <span class="mono">${money(t.deposit_amount)}</span> ${t.deposit_paid_date ? `paid ${t.deposit_paid_date}` : ""}
            ${t.status === "vacated" ? `
            <div style="margin-top:4px;">
              <span class="lbl">Refund</span><br>
              <div class="inline-edit" style="display:inline-flex;align-items:center;gap:6px;">
                <input type="checkbox" id="refund-ed" class="ie-toggle">
                <span class="ie-view" style="display:inline-flex;align-items:center;gap:6px;">
                  <span class="mono">${hasValue(t.deposit_refund_amount) ? money(t.deposit_refund_amount) : "₹0"}</span>${hasValue(t.deposit_refund_date) ? ` <span style="color:var(--ink-faint);">on ${t.deposit_refund_date}</span>` : ""}
                  <label for="refund-ed" class="icon-btn ghost" title="Edit deposit refund">${icon(ICON.pencil, 12)}</label>
                </span>
                <form method="post" action="/tenants/${t.id}/edit-deposit-refund" class="ie-form popover">
                  <label class="field"><span>Refund amount</span><input type="number" name="refundAmount" value="${hasValue(t.deposit_refund_amount) ? t.deposit_refund_amount : t.deposit_amount}" required></label>
                  <label class="field"><span>Refund date</span><input type="date" name="refundDate" value="${hasValue(t.deposit_refund_date) ? t.deposit_refund_date : today}"></label>
                  <div class="popover-actions">
                    <button type="submit" class="icon-btn good" title="Save">${icon(ICON.check, 13)}</button>
                    <label for="refund-ed" class="icon-btn bad" title="Cancel">${icon(ICON.x, 13)}</label>
                  </div>
                </form>
              </div>
            </div>` : ""}
          </div>
          <div><span class="lbl">Status</span><br>${tenantStatusPill(t)}${onNotice ? `<div style="font-size:12px;color:var(--ink-faint);margin-top:3px;">Given ${t.notice_date}${hasValue(t.expected_vacate_date) ? ` · expected to leave ${t.expected_vacate_date}` : ""}</div>` : ""}</div>
        </div>
      </div>
      <div class="card" style="flex:1;padding:18px 20px;">
        <h2>Rent charge history</h2>
        ${addDueForm}
        <table class="responsive"><thead><tr><th>Month</th><th class="num">Expected</th><th class="num">Outstanding</th><th>Status</th><th></th></tr></thead><tbody>${chargeRows || `<tr><td colspan="5" style="color:var(--ink-faint);">No charges yet.</td></tr>`}</tbody></table>
      </div>
      <div class="card" style="flex:1;padding:18px 20px;">
        <h2>Payments</h2>
        <table class="responsive"><thead><tr><th>Date</th><th class="num">Amount</th><th>Via</th><th></th><th></th></tr></thead><tbody>${paymentRows || `<tr><td colspan="5" style="color:var(--ink-faint);">No payments yet.</td></tr>`}</tbody></table>
      </div>
    </div>
  `;
}

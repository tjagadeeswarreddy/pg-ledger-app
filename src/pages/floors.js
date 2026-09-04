import { money, escapeHtml, icon, ICON } from "../render.js";
import * as repo from "../repo.js";

export async function floorsPage() {
  const floors = await repo.listFloors();
  const rooms = await repo.listRoomsWithOccupancy();

  const roomsByFloor = {};
  for (const r of rooms) { (roomsByFloor[r.floor_id] ||= []).push(r); }

  const floorBlocks = floors.map((f) => {
    const frooms = roomsByFloor[f.id] || [];
    const roomRows = frooms.map((r) => {
      const cb = `room-edit-${r.id}`;
      const shareOptions = [1, 2, 3, 4].map((n) => `<option value="${n}" ${Number(r.sharing_type) === n ? "selected" : ""}>${n}</option>`).join("");
      const deleteOrReactivate = r.status === "active"
        ? `<form method="post" action="/floors/rooms/${r.id}/delete" onsubmit="return confirm('Delete room ${escapeHtml(r.room_no)}? If it has any tenant history it will be marked inactive instead of removed.');" style="display:inline;">
             <button type="submit" class="icon-btn bad" title="Delete room">${icon(ICON.x, 13)}</button>
           </form>`
        : `<form method="post" action="/floors/rooms/${r.id}/reactivate" style="display:inline;">
             <button type="submit" class="icon-btn" title="Reactivate room">${icon(ICON.undo, 13)}</button>
           </form>`;
      return `
      <tr>
        <td class="mono" data-label="Room"><a href="/tenants?status=all&roomId=${r.id}" title="View tenants in this room" style="color:inherit;">${escapeHtml(r.room_no)}</a></td>
        <td data-label="Sharing">${r.sharing_type}-sharing</td>
        <td class="num" data-label="Rent / bed">${money(r.default_rent)}</td>
        <td class="num" data-label="Occupied">${r.occupied} / ${r.sharing_type}</td>
        <td data-label="">${r.status === "active" ? "" : `<span class="pill" style="background:var(--warn-tint);color:var(--warn);">${escapeHtml(r.status)}</span>`}</td>
        <td data-label="">
          <div class="inline-edit">
            <input type="checkbox" id="${cb}" class="ie-toggle">
            <span class="ie-view row-actions">
              <label for="${cb}" class="icon-btn ghost" title="Edit room">${icon(ICON.pencil, 13)}</label>
              ${deleteOrReactivate}
            </span>
            <form method="post" action="/floors/rooms/${r.id}/edit" class="ie-form popover">
              <label class="field"><span>Room no.</span><input name="roomNo" value="${escapeHtml(r.room_no)}" required></label>
              <label class="field"><span>Sharing</span><select name="sharingType">${shareOptions}</select></label>
              <label class="field"><span>Rent / bed</span><input name="defaultRent" type="number" value="${r.default_rent}" required></label>
              <div class="popover-actions">
                <button type="submit" class="icon-btn good" title="Save">${icon(ICON.check, 13)}</button>
                <label for="${cb}" class="icon-btn bad" title="Cancel">${icon(ICON.x, 13)}</label>
              </div>
            </form>
          </div>
        </td>
      </tr>`;
    }).join("");

    return `
      <div class="card" style="padding:18px 20px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <h2 style="margin:0;">${escapeHtml(f.name)}</h2>
          <details>
            <summary class="btn small" style="display:inline-flex;cursor:pointer;">+ Add room</summary>
            <form method="post" action="/floors/rooms" style="display:flex;gap:8px;align-items:flex-end;margin-top:10px;flex-wrap:wrap;">
              <input type="hidden" name="floorId" value="${f.id}">
              <label class="field"><span>Room no.</span><input name="roomNo" required style="width:90px;"></label>
              <label class="field"><span>Sharing</span>
                <select name="sharingType">
                  <option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4" selected>4</option>
                </select>
              </label>
              <label class="field"><span>Rent / bed</span><input name="defaultRent" type="number" required style="width:110px;"></label>
              <button type="submit" class="btn primary small">Add</button>
            </form>
          </details>
        </div>
        <table class="responsive">
          <thead><tr><th>Room</th><th>Sharing</th><th class="num">Rent / bed</th><th class="num">Occupied</th><th></th><th></th></tr></thead>
          <tbody>${roomRows || `<tr><td colspan="6" style="color:var(--ink-faint);">No rooms yet on this floor.</td></tr>`}</tbody>
        </table>
      </div>`;
  }).join("");

  return `
    <div class="toolbar">
      <h1>Floors &amp; Rooms</h1>
      <details>
        <summary class="btn primary" style="display:inline-flex;cursor:pointer;">+ Add floor</summary>
        <form method="post" action="/floors" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
          <input class="field" name="name" placeholder="e.g. 5th Floor" required style="padding:8px 10px;border:1px solid var(--line);border-radius:7px;min-width:0;flex:1 1 180px;">
          <button type="submit" class="btn primary">Add</button>
        </form>
      </details>
    </div>
    ${floorBlocks}
  `;
}

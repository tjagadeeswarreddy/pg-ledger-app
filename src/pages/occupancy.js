import { money, pill, escapeHtml } from "../render.js";
import * as repo from "../repo.js";

export async function occupancyPage() {
  const floors = await repo.listFloors();
  const rooms = await repo.listRoomsWithOccupancy({ activeOnly: false });

  // Group rooms by floor
  const roomsByFloor = {};
  for (const r of rooms) {
    if (!roomsByFloor[r.floor_id]) {
      roomsByFloor[r.floor_id] = [];
    }
    roomsByFloor[r.floor_id].push(r);
  }

  // Calculate occupancy stats
  let totalRooms = 0;
  let totalOccupied = 0;

  const floorRows = floors.map(f => {
    const floorRooms = roomsByFloor[f.id] || [];
    const totalInFloor = floorRooms.length;
    const occupiedInFloor = floorRooms.filter(r => r.current_occupancy > 0).length;
    const vacantInFloor = totalInFloor - occupiedInFloor;
    const occupancyRate = totalInFloor > 0 ? Math.round((occupiedInFloor / totalInFloor) * 100) : 0;

    totalRooms += totalInFloor;
    totalOccupied += occupiedInFloor;

    return `
    <tr>
      <td data-label="Floor"><a href="/tenants?floorId=${f.id}" style="text-decoration:none;color:inherit;">${escapeHtml(f.name)}</a></td>
      <td class="num" data-label="Total rooms">${totalInFloor}</td>
      <td class="num" data-label="Occupied">${occupiedInFloor}</td>
      <td class="num" data-label="Vacant">${vacantInFloor}</td>
      <td class="num" data-label="Occupancy rate" style="font-weight:600;color:${occupancyRate >= 80 ? 'var(--good)' : occupancyRate >= 50 ? '#FF9800' : 'var(--bad)'};">${occupancyRate}%</td>
    </tr>`;
  }).join("");

  const overallOccupancyRate = totalRooms > 0 ? Math.round((totalOccupied / totalRooms) * 100) : 0;
  const overallStatus = overallOccupancyRate >= 80 ? 'good' : overallOccupancyRate >= 50 ? 'warn' : 'bad';

  return `
    <div class="toolbar">
      <h1>Occupancy Dashboard</h1>
      <a class="btn" href="/tenants">Manage tenants</a>
    </div>

    <!-- Overall Summary -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:16px;padding:0 20px 20px;">
      <div class="card" style="padding:20px;">
        <div class="lbl">Total Rooms</div>
        <div style="font-size:28px;font-weight:700;margin:8px 0;">${totalRooms}</div>
        <div style="font-size:13px;color:var(--ink-faint);">across all floors</div>
      </div>
      <div class="card" style="padding:20px;">
        <div class="lbl">Occupied</div>
        <div style="font-size:28px;font-weight:700;margin:8px 0;color:var(--good);">${totalOccupied}</div>
        <div style="font-size:13px;color:var(--ink-faint);">active tenants</div>
      </div>
      <div class="card" style="padding:20px;">
        <div class="lbl">Vacant</div>
        <div style="font-size:28px;font-weight:700;margin:8px 0;color:var(--bad);">${totalRooms - totalOccupied}</div>
        <div style="font-size:13px;color:var(--ink-faint);">available rooms</div>
      </div>
      <div class="card" style="padding:20px;">
        <div class="lbl">Overall Occupancy Rate</div>
        <div style="font-size:28px;font-weight:700;margin:8px 0;color:${overallStatus === 'good' ? 'var(--good)' : overallStatus === 'warn' ? '#FF9800' : 'var(--bad)'};">${overallOccupancyRate}%</div>
        <div style="font-size:13px;color:var(--ink-faint);">efficiency metric</div>
      </div>
    </div>

    <!-- Floor-wise Breakdown -->
    <div class="card" style="padding:18px 20px;margin:0 20px 20px;">
      <h2 style="margin:0 0 12px;font-size:16px;">Floor-wise Occupancy</h2>
      <div class="card" style="padding:6px 20px;margin:0;border:none;">
        <table class="responsive" style="margin:0;">
          <thead><tr><th>Floor</th><th class="num">Total rooms</th><th class="num">Occupied</th><th class="num">Vacant</th><th class="num">Occupancy rate</th></tr></thead>
          <tbody>${floorRows || '<tr><td colspan="5" style="color:var(--ink-faint);padding:14px 0;">No floors configured.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `;
}

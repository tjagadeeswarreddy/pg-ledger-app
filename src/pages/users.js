import { escapeHtml, icon, ICON } from "../render.js";
import * as repo from "../repo.js";

export async function usersPage(currentUserId) {
  const users = await repo.listUsers();

  const rows = users.map((u) => `
    <tr>
      <td data-label="Name">${escapeHtml(u.name)}</td>
      <td data-label="Email">${escapeHtml(u.email)}</td>
      <td data-label="Added">${String(u.created_at).slice(0, 10)}</td>
      <td data-label="">${Number(u.id) === Number(currentUserId) ? `<span class="lbl">(you)</span>` : `
        <form method="post" action="/users/${u.id}/delete" onsubmit="return confirm('Remove this login? ${escapeHtml(u.name)} (${escapeHtml(u.email)}) will no longer be able to sign in.');" style="display:inline;">
          <button type="submit" class="icon-btn bad" title="Remove login">${icon(ICON.x, 13)}</button>
        </form>`}</td>
    </tr>`).join("");

  return `
    <div class="toolbar">
      <h1>Users</h1>
    </div>

    <div class="card" style="padding:18px 20px;margin-bottom:18px;max-width:560px;">
      <h2>Add a login</h2>
      <form method="post" action="/users" style="display:flex;flex-direction:column;gap:14px;">
        <div class="grid2">
          <label class="field"><span>Name</span><input name="name" required></label>
          <label class="field"><span>Email</span><input type="email" name="email" required></label>
        </div>
        <label class="field"><span>Password</span><input type="password" name="password" minlength="6" required></label>
        <div style="font-size:12px;color:var(--ink-faint);">
          Give this to whoever should have their own sign-in — a manager or a
          family member helping run the place. There's no public sign-up
          page anywhere in this app; a new login can only ever be created
          from right here, by someone who's already signed in.
        </div>
        <div><button type="submit" class="btn primary">Add login</button></div>
      </form>
    </div>

    <div class="card" style="padding:6px 20px;">
      <table class="responsive">
        <thead><tr><th>Name</th><th>Email</th><th>Added</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" style="color:var(--ink-faint);padding:14px 0;">No logins found.</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

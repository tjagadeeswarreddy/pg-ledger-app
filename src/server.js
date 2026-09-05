import http from "node:http";
import { URL } from "node:url";
import { layout, loginPage } from "./render.js";
import { login, logout, currentUser, parseCookies, hashPassword } from "./auth.js";
import * as repo from "./repo.js";
import { dashboardPage } from "./pages/dashboard.js";
import { floorsPage } from "./pages/floors.js";
import { tenantsListPage, tenantNewPage, tenantProfilePage, tenantEditPage } from "./pages/tenants.js";
import { rentPage, chargeDetailPage } from "./pages/rent.js";
import { accountsPage, accountDetailPage } from "./pages/accounts.js";
import { expensesPage } from "./pages/expenses.js";
import { usersPage } from "./pages/users.js";

const PORT = Number(process.env.PORT) || 3000;
const COOKIE_NAME = "pgl_session";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; if (data.length > 2_000_000) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function parseForm(req) {
  const raw = await readBody(req);
  return Object.fromEntries(new URLSearchParams(raw));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function redirect(res, location, cookie) {
  const headers = { Location: location };
  if (cookie) headers["Set-Cookie"] = cookie;
  res.writeHead(302, headers);
  res.end();
}

// The session cookie gets a `Secure` attribute (browser refuses to ever send
// it over plain HTTP) whenever the request itself arrived over HTTPS — either
// directly (req.socket.encrypted, if this process is ever given a TLS cert
// itself) or via a reverse proxy that terminates TLS and says so with the
// standard X-Forwarded-Proto header (the Oracle Cloud deployment plan is
// Caddy in front of this app for TLS, which sets that header). Checking the
// request rather than hardcoding `; Secure` matters because a hardcoded
// Secure flag would make login silently impossible over plain
// http://localhost during local development — the browser drops such
// cookies outright instead of erroring, which is a confusing thing to debug.
function isHttps(req) {
  return (req.socket && req.socket.encrypted === true) || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
}
function setSessionCookie(token, req) {
  const maxAge = 60 * 60 * 24 * 30;
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
}
function clearSessionCookie(req) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? "; Secure" : ""}`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const cookies = parseCookies(req);
    const user = await currentUser(cookies[COOKIE_NAME]);

    // ---- Public route ----
    if (path === "/login" && req.method === "GET") {
      if (user) return redirect(res, "/dashboard");
      return sendHtml(res, 200, loginPage());
    }
    if (path === "/login" && req.method === "POST") {
      const form = await parseForm(req);
      try {
        const result = await login(form.email || "", form.password || "");
        if (!result) return sendHtml(res, 401, loginPage({ error: "Incorrect email or password." }));
        return redirect(res, "/dashboard", setSessionCookie(result.token, req));
      } catch (e) {
        // login() throws only for the rate-limit lockout — everything else
        // (wrong password, unknown email) is a plain `null` handled above.
        return sendHtml(res, 429, loginPage({ error: e.message }));
      }
    }
    if (path === "/logout" && req.method === "POST") {
      await logout(cookies[COOKIE_NAME]);
      return redirect(res, "/login", clearSessionCookie(req));
    }
    // ---- Everything else requires a signed-in owner ----
    if (!user) return redirect(res, "/login");

    if (path === "/" && req.method === "GET") return redirect(res, "/dashboard");

    if (path === "/dashboard" && req.method === "GET") {
      const body = await dashboardPage();
      return sendHtml(res, 200, layout({ title: "Dashboard", active: "/dashboard", user, body }));
    }

    if (path === "/floors" && req.method === "GET") {
      const body = await floorsPage();
      return sendHtml(res, 200, layout({ title: "Floors & Rooms", active: "/floors", user, body }));
    }
    if (path === "/floors" && req.method === "POST") {
      const form = await parseForm(req);
      await repo.createFloor({ name: form.name, sortOrder: 99 });
      return redirect(res, "/floors");
    }
    const floorEditMatch = path.match(/^\/floors\/(\d+)\/edit$/);
    if (floorEditMatch && req.method === "POST") {
      const form = await parseForm(req);
      try {
        await repo.updateFloor(floorEditMatch[1], { name: form.name });
        return redirect(res, "/floors");
      } catch (e) {
        const body = await floorsPage();
        return sendHtml(res, 200, layout({ title: "Floors & Rooms", active: "/floors", user, body, flash: { kind: "bad", text: e.message } }));
      }
    }
    const floorDeleteMatch = path.match(/^\/floors\/(\d+)\/delete$/);
    if (floorDeleteMatch && req.method === "POST") {
      try {
        const result = await repo.deleteFloor(floorDeleteMatch[1]);
        const body = await floorsPage();
        return sendHtml(res, 200, layout({ title: "Floors & Rooms", active: "/floors", user, body, flash: { kind: "good", text: `${result.floor.name} deleted.` } }));
      } catch (e) {
        const body = await floorsPage();
        return sendHtml(res, 200, layout({ title: "Floors & Rooms", active: "/floors", user, body, flash: { kind: "bad", text: e.message } }));
      }
    }
    if (path === "/floors/rooms" && req.method === "POST") {
      const form = await parseForm(req);
      await repo.createRoom({ floorId: form.floorId, roomNo: form.roomNo, sharingType: form.sharingType, defaultRent: form.defaultRent });
      return redirect(res, "/floors");
    }
    const roomEditMatch = path.match(/^\/floors\/rooms\/(\d+)\/edit$/);
    if (roomEditMatch && req.method === "POST") {
      const form = await parseForm(req);
      try {
        await repo.updateRoom(roomEditMatch[1], { roomNo: form.roomNo, sharingType: form.sharingType, defaultRent: form.defaultRent });
        return redirect(res, "/floors");
      } catch (e) {
        const body = await floorsPage();
        return sendHtml(res, 200, layout({ title: "Floors & Rooms", active: "/floors", user, body, flash: { kind: "bad", text: e.message } }));
      }
    }
    const roomDeleteMatch = path.match(/^\/floors\/rooms\/(\d+)\/delete$/);
    if (roomDeleteMatch && req.method === "POST") {
      try {
        const result = await repo.deleteRoom(roomDeleteMatch[1]);
        const body = await floorsPage();
        const text = result.deactivated
          ? `Room ${result.room.room_no} has past tenant history, so it was marked inactive rather than deleted — hidden from new tenant assignment, but its records are kept.`
          : `Room ${result.room.room_no} deleted.`;
        return sendHtml(res, 200, layout({ title: "Floors & Rooms", active: "/floors", user, body, flash: { kind: "good", text } }));
      } catch (e) {
        const body = await floorsPage();
        return sendHtml(res, 200, layout({ title: "Floors & Rooms", active: "/floors", user, body, flash: { kind: "bad", text: e.message } }));
      }
    }
    const roomReactivateMatch = path.match(/^\/floors\/rooms\/(\d+)\/reactivate$/);
    if (roomReactivateMatch && req.method === "POST") {
      await repo.reactivateRoom(roomReactivateMatch[1]);
      return redirect(res, "/floors");
    }

    if (path === "/tenants" && req.method === "GET") {
      const status = url.searchParams.get("status") || "active";
      const floorId = url.searchParams.get("floorId");
      const roomId = url.searchParams.get("roomId");
      const search = url.searchParams.get("q") || "";
      const body = await tenantsListPage({ status, floorId, roomId, search });
      return sendHtml(res, 200, layout({ title: "Tenants", active: "/tenants", user, body }));
    }
    if (path === "/tenants/new" && req.method === "GET") {
      const body = await tenantNewPage();
      return sendHtml(res, 200, layout({ title: "Add tenant", active: "/tenants", user, body }));
    }
    if (path === "/tenants" && req.method === "POST") {
      const form = await parseForm(req);
      try {
        const t = await repo.createTenant({
          roomId: form.roomId, bedNo: form.bedNo, fullName: form.fullName, phone: form.phone,
          emergencyName: form.emergencyName, emergencyPhone: form.emergencyPhone, emergencyRelation: form.emergencyRelation,
          occupation: form.occupation, idProofType: "Aadhaar", idProofNumber: form.idProofNumber,
          joiningDate: form.joiningDate, monthlyRent: form.monthlyRent, depositAmount: form.depositAmount,
          depositPaidDate: form.joiningDate, rentDueDay: form.rentDueDay,
        });
        return redirect(res, `/tenants/${t.id}`);
      } catch (e) {
        const body = await tenantNewPage();
        return sendHtml(res, 200, layout({ title: "Add tenant", active: "/tenants", user, body, flash: { kind: "bad", text: e.message } }));
      }
    }
    const tenantIdMatch = path.match(/^\/tenants\/(\d+)$/);
    if (tenantIdMatch && req.method === "GET") {
      const body = await tenantProfilePage(tenantIdMatch[1]);
      if (!body) { res.writeHead(404); return res.end("Not found"); }
      return sendHtml(res, 200, layout({ title: "Tenant", active: "/tenants", user, body }));
    }
    const vacateMatch = path.match(/^\/tenants\/(\d+)\/vacate$/);
    if (vacateMatch && req.method === "POST") {
      const form = await parseForm(req);
      const today = new Date().toISOString().slice(0, 10);
      await repo.vacateTenant(vacateMatch[1], {
        vacateDate: form.vacateDate || today,
        // Deposit refund is captured right here at vacate time (most PGs settle
        // it the same day), but isn't required — leaving it blank/0 is fine,
        // and it can be filled in or corrected afterward from the profile
        // page's own "Refund" edit popover (edit-deposit-refund, below).
        refundAmount: form.refundAmount,
        refundDate: form.refundDate || form.vacateDate || today,
      });
      return redirect(res, `/tenants/${vacateMatch[1]}`);
    }
    // "Give notice" deliberately does NOT touch tenants.status — see the
    // schema.sql comment on notice_date/expected_vacate_date. The tenant
    // stays fully 'active' (bed occupied, still billed) right up until an
    // actual Vacate; this just records that they said they're leaving, and
    // when, so the profile page can show a "Notice" pill instead of "Active".
    const giveNoticeMatch = path.match(/^\/tenants\/(\d+)\/give-notice$/);
    if (giveNoticeMatch && req.method === "POST") {
      const form = await parseForm(req);
      try {
        await repo.giveNotice(giveNoticeMatch[1], form.expectedVacateDate || null);
      } catch (e) {
        console.error("give-notice:", e.message);
      }
      return redirect(res, `/tenants/${giveNoticeMatch[1]}`);
    }
    const cancelNoticeMatch = path.match(/^\/tenants\/(\d+)\/cancel-notice$/);
    if (cancelNoticeMatch && req.method === "POST") {
      await repo.cancelNotice(cancelNoticeMatch[1]);
      return redirect(res, `/tenants/${cancelNoticeMatch[1]}`);
    }
    // Editing the deposit refund after the fact — e.g. the amount wasn't
    // finalized until a move-out inspection turned up damage, or it's simply
    // being corrected. Works the same popover-edit pattern as everything else.
    const editRefundMatch = path.match(/^\/tenants\/(\d+)\/edit-deposit-refund$/);
    if (editRefundMatch && req.method === "POST") {
      const form = await parseForm(req);
      try {
        await repo.updateDepositRefund(editRefundMatch[1], { refundAmount: form.refundAmount, refundDate: form.refundDate });
      } catch (e) {
        console.error("edit-deposit-refund:", e.message);
      }
      return redirect(res, `/tenants/${editRefundMatch[1]}`);
    }
    // Quick inline edit of just the monthly rent, from the tenant profile page's
    // Details card — a lighter-weight sibling to the full Edit Tenant form for
    // when only this one figure needs changing. Only affects future auto-
    // generated charges; anything already billed is untouched (same behavior
    // as changing it via the full edit form).
    const tenantRentMatch = path.match(/^\/tenants\/(\d+)\/edit-rent$/);
    if (tenantRentMatch && req.method === "POST") {
      const form = await parseForm(req);
      try {
        await repo.updateMonthlyRent(tenantRentMatch[1], form.monthlyRent);
      } catch (e) {
        console.error("edit-rent:", e.message);
      }
      return redirect(res, `/tenants/${tenantRentMatch[1]}`);
    }
    const tenantDeleteMatch = path.match(/^\/tenants\/(\d+)\/delete$/);
    if (tenantDeleteMatch && req.method === "POST") {
      const form = await parseForm(req);
      // Preserve whichever status/floor filter the owner was looking at (from the
      // list page's hidden redirectTo) — deleting from a tenant's own profile has
      // no such filter to preserve, so this just falls back to the Vacated tab.
      let listArgs = { status: "vacated", floorId: null };
      if (form.redirectTo) {
        try {
          const u = new URL(form.redirectTo, "http://x");
          listArgs = { status: u.searchParams.get("status") || "vacated", floorId: u.searchParams.get("floorId") };
        } catch { /* keep the default */ }
      }
      try {
        const t = await repo.deleteTenant(tenantDeleteMatch[1]);
        const body = await tenantsListPage(listArgs);
        return sendHtml(res, 200, layout({ title: "Tenants", active: "/tenants", user, body, flash: { kind: "good", text: `${t.full_name} deleted — their profile and billing history are permanently removed.` } }));
      } catch (e) {
        // Most likely to fail if it wasn't vacated first — re-render wherever the
        // tenant still exists (their own profile) so the error is visible right there,
        // falling back to the Vacated list if the tenant record is somehow already gone.
        const profileBody = await tenantProfilePage(tenantDeleteMatch[1]);
        if (profileBody) {
          return sendHtml(res, 200, layout({ title: "Tenant", active: "/tenants", user, body: profileBody, flash: { kind: "bad", text: e.message } }));
        }
        const listBody = await tenantsListPage(listArgs);
        return sendHtml(res, 200, layout({ title: "Tenants", active: "/tenants", user, body: listBody, flash: { kind: "bad", text: e.message } }));
      }
    }
    const tenantEditMatch = path.match(/^\/tenants\/(\d+)\/edit$/);
    if (tenantEditMatch && req.method === "GET") {
      const body = await tenantEditPage(tenantEditMatch[1]);
      if (!body) { res.writeHead(404); return res.end("Not found"); }
      return sendHtml(res, 200, layout({ title: "Edit tenant", active: "/tenants", user, body }));
    }
    if (tenantEditMatch && req.method === "POST") {
      const form = await parseForm(req);
      try {
        await repo.updateTenant(tenantEditMatch[1], {
          roomId: form.roomId, bedNo: form.bedNo, fullName: form.fullName, phone: form.phone,
          emergencyName: form.emergencyName, emergencyPhone: form.emergencyPhone, emergencyRelation: form.emergencyRelation,
          occupation: form.occupation, idProofType: "Aadhaar", idProofNumber: form.idProofNumber,
          joiningDate: form.joiningDate, monthlyRent: form.monthlyRent, depositAmount: form.depositAmount,
          rentDueDay: form.rentDueDay,
        });
        return redirect(res, `/tenants/${tenantEditMatch[1]}`);
      } catch (e) {
        const body = await tenantEditPage(tenantEditMatch[1]);
        return sendHtml(res, 200, layout({ title: "Edit tenant", active: "/tenants", user, body, flash: { kind: "bad", text: e.message } }));
      }
    }

    const voidPayMatch = path.match(/^\/payments\/(\d+)\/void$/);
    if (voidPayMatch && req.method === "POST") {
      const form = await parseForm(req);
      await repo.voidPayment(voidPayMatch[1], form.reason || "Voided by owner");
      return redirect(res, form.redirectTo || `/tenants/${form.tenantId}`);
    }
    const editPayMatch = path.match(/^\/payments\/(\d+)\/edit$/);
    if (editPayMatch && req.method === "POST") {
      const form = await parseForm(req);
      try {
        await repo.editPayment(editPayMatch[1], { amount: form.amount, accountId: form.accountId, mode: form.mode, reason: form.reason });
      } catch (e) {
        console.error("edit-payment:", e.message);
      }
      return redirect(res, form.redirectTo || `/tenants/${form.tenantId}`);
    }

    if (path === "/rent" && req.method === "GET") {
      const body = await rentPage({ year: url.searchParams.get("year"), month: url.searchParams.get("month"), floorId: url.searchParams.get("floorId") });
      return sendHtml(res, 200, layout({ title: "Rent Collection", active: "/rent", user, body }));
    }
    // The "Manage this due" page — Record payment / Edit amount / Waive all live
    // here now instead of as inline forms in the Rent Collection table row.
    const chargeDetailMatch = path.match(/^\/rent\/charge\/(\d+)$/);
    if (chargeDetailMatch && req.method === "GET") {
      const body = await chargeDetailPage(chargeDetailMatch[1], { floorId: url.searchParams.get("floorId") });
      if (!body) { res.writeHead(404); return res.end("Not found"); }
      return sendHtml(res, 200, layout({ title: "Manage due", active: "/rent", user, body }));
    }
    const addDueMatch = path.match(/^\/rent\/tenant\/(\d+)\/add-due$/);
    if (addDueMatch && req.method === "POST") {
      const form = await parseForm(req);
      try {
        await repo.addManualDue(addDueMatch[1], form.year, form.month);
      } catch (e) {
        // A due already existing (someone double-clicked, or auto-generation beat us to
        // it) isn't worth a hard error page — just fall through to the redirect, where
        // the tenant will now show up in the normal charge list either way.
        console.error("add-due:", e.message);
      }
      return redirect(res, form.redirectTo || `/rent?year=${form.year}&month=${form.month}`);
    }
    const payMatch = path.match(/^\/rent\/(\d+)\/pay$/);
    if (payMatch && req.method === "POST") {
      const form = await parseForm(req);
      // Look the charge up directly by id for its tenant_id, rather than
      // re-deriving it from a year/month charge list — simpler, and works
      // regardless of whether the caller even has a year/month in hand (the
      // tenant profile page's own "Record payment" popover doesn't).
      const charge = await repo.getChargeDetail(payMatch[1]);
      await repo.recordPayment({ rentChargeId: payMatch[1], tenantId: charge ? charge.tenant_id : null, accountId: form.accountId, amount: form.amount, mode: form.mode, payDate: new Date().toISOString().slice(0, 10) });
      return redirect(res, form.redirectTo || `/rent?year=${form.year}&month=${form.month}`);
    }
    const waiveMatch = path.match(/^\/rent\/(\d+)\/waive$/);
    if (waiveMatch && req.method === "POST") {
      const form = await parseForm(req);
      await repo.waiveCharge(waiveMatch[1], form.reason || "Waived by owner");
      return redirect(res, form.redirectTo || `/rent?year=${form.year}&month=${form.month}`);
    }
    const editAmountMatch = path.match(/^\/rent\/(\d+)\/edit-amount$/);
    if (editAmountMatch && req.method === "POST") {
      const form = await parseForm(req);
      try {
        await repo.editChargeAmount(editAmountMatch[1], form.amount, form.reason || "Amount corrected by owner");
      } catch (e) {
        console.error("edit-amount:", e.message);
      }
      return redirect(res, form.redirectTo || `/rent?year=${form.year}&month=${form.month}`);
    }
    const reinstateMatch = path.match(/^\/rent\/(\d+)\/reinstate$/);
    if (reinstateMatch && req.method === "POST") {
      const form = await parseForm(req);
      await repo.reinstateCharge(reinstateMatch[1]);
      return redirect(res, form.redirectTo || `/rent?year=${form.year}&month=${form.month}`);
    }

    if (path === "/accounts" && req.method === "GET") {
      const body = await accountsPage();
      return sendHtml(res, 200, layout({ title: "Accounts", active: "/accounts", user, body }));
    }
    if (path === "/accounts" && req.method === "POST") {
      const form = await parseForm(req);
      await repo.createAccount({ name: form.name, type: form.type, openingBalance: form.openingBalance });
      return redirect(res, "/accounts");
    }
    const acctEditMatch = path.match(/^\/accounts\/(\d+)\/edit$/);
    if (acctEditMatch && req.method === "POST") {
      const form = await parseForm(req);
      try {
        await repo.updateAccount(acctEditMatch[1], { name: form.name, type: form.type, openingBalance: form.openingBalance });
      } catch (e) {
        const body = await accountsPage();
        return sendHtml(res, 200, layout({ title: "Accounts", active: "/accounts", user, body, flash: { kind: "bad", text: e.message } }));
      }
      return redirect(res, "/accounts");
    }
    const acctDeleteMatch = path.match(/^\/accounts\/(\d+)\/delete$/);
    if (acctDeleteMatch && req.method === "POST") {
      try {
        const result = await repo.deleteAccount(acctDeleteMatch[1]);
        const body = await accountsPage();
        const text = result.deactivated
          ? `Account "${result.account.name}" has transaction history, so it was marked inactive rather than deleted — hidden from new payments/expenses, but its records are kept.`
          : `Account "${result.account.name}" deleted.`;
        return sendHtml(res, 200, layout({ title: "Accounts", active: "/accounts", user, body, flash: { kind: "good", text } }));
      } catch (e) {
        const body = await accountsPage();
        return sendHtml(res, 200, layout({ title: "Accounts", active: "/accounts", user, body, flash: { kind: "bad", text: e.message } }));
      }
    }
    const acctReactivateMatch = path.match(/^\/accounts\/(\d+)\/reactivate$/);
    if (acctReactivateMatch && req.method === "POST") {
      await repo.reactivateAccount(acctReactivateMatch[1]);
      return redirect(res, "/accounts");
    }
    const acctMatch = path.match(/^\/accounts\/(\d+)$/);
    if (acctMatch && req.method === "GET") {
      const body = await accountDetailPage(acctMatch[1], { type: url.searchParams.get("type") });
      if (!body) { res.writeHead(404); return res.end("Not found"); }
      return sendHtml(res, 200, layout({ title: "Account", active: "/accounts", user, body }));
    }

    if (path === "/expenses" && req.method === "GET") {
      const body = await expensesPage({ accountId: url.searchParams.get("accountId") });
      return sendHtml(res, 200, layout({ title: "Expenses", active: "/expenses", user, body }));
    }
    if (path === "/expenses" && req.method === "POST") {
      const form = await parseForm(req);
      await repo.createExpense({ accountId: form.accountId, category: form.category, amount: form.amount, expenseDate: form.expenseDate, note: form.note });
      return redirect(res, "/expenses");
    }
    const expEditMatch = path.match(/^\/expenses\/(\d+)\/edit$/);
    if (expEditMatch && req.method === "POST") {
      const form = await parseForm(req);
      try {
        await repo.updateExpense(expEditMatch[1], { category: form.category, amount: form.amount, expenseDate: form.expenseDate, accountId: form.accountId, note: form.note });
      } catch (e) {
        const body = await expensesPage({ accountId: url.searchParams.get("accountId") });
        return sendHtml(res, 200, layout({ title: "Expenses", active: "/expenses", user, body, flash: { kind: "bad", text: e.message } }));
      }
      return redirect(res, form.redirectTo || "/expenses");
    }
    const expDeleteMatch = path.match(/^\/expenses\/(\d+)\/delete$/);
    if (expDeleteMatch && req.method === "POST") {
      const form = await parseForm(req);
      await repo.deleteExpense(expDeleteMatch[1], form.reason || "Deleted by owner");
      return redirect(res, form.redirectTo || "/expenses");
    }

    // Adding/removing owner or staff logins. Deliberately no public sign-up
    // route anywhere in this app — every route here is already behind the
    // "signed-in owner" gate above, so a new login can only ever be created
    // by someone who already has one.
    if (path === "/users" && req.method === "GET") {
      const body = await usersPage(user.id);
      return sendHtml(res, 200, layout({ title: "Users", active: "/users", user, body }));
    }
    if (path === "/users" && req.method === "POST") {
      const form = await parseForm(req);
      try {
        if (String(form.password || "").length < 6) throw new Error("Password needs to be at least 6 characters.");
        await repo.createUser({ name: form.name, email: form.email, passwordHash: hashPassword(form.password) });
        return redirect(res, "/users");
      } catch (e) {
        const body = await usersPage(user.id);
        return sendHtml(res, 200, layout({ title: "Users", active: "/users", user, body, flash: { kind: "bad", text: e.message } }));
      }
    }
    const userDeleteMatch = path.match(/^\/users\/(\d+)\/delete$/);
    if (userDeleteMatch && req.method === "POST") {
      try {
        await repo.deleteUser(userDeleteMatch[1], user.id);
        return redirect(res, "/users");
      } catch (e) {
        const body = await usersPage(user.id);
        return sendHtml(res, 200, layout({ title: "Users", active: "/users", user, body, flash: { kind: "bad", text: e.message } }));
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error: " + err.message);
  }
});

server.listen(PORT, () => console.log(`PG Ledger listening on http://localhost:${PORT}`));

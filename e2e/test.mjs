import pw from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const { chromium } = pw;
import path from "node:path";

const BASE = "http://localhost:3000";
const SHOTS = "/tmp/pg-ledger-app/e2e/shots";
const results = [];

function check(name, cond, detail = "") {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? "PASS" : "FAIL") + " - " + name + (detail ? ` (${detail})` : ""));
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
}

// True if the page never grows wider than its own viewport — i.e. nothing is
// forcing a horizontal scrollbar (an overflowing table, a fixed-width form
// field, an un-wrapped toolbar, etc). +1px tolerance for sub-pixel rounding.
async function noHOverflow(page) {
  return await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', "owner@pgledger.local");
  await page.fill('input[name="password"]', "change-me-123");
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/dashboard`);
}

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });

  // ============================= DESKTOP PASS =============================
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // 1. Login page loads
  await page.goto(`${BASE}/login`);
  await shot(page, "01-login.png");
  check("Login page loads", await page.locator("text=PG Ledger").count() > 0 || await page.locator("input[name=email]").count() > 0);

  // 2. Wrong password rejected
  await page.fill('input[name="email"]', "owner@pgledger.local");
  await page.fill('input[name="password"]', "wrong-pass");
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
  check("Wrong password rejected", (await page.content()).includes("Incorrect"));

  // 2b. Login rate-limiting — 5 wrong passwords in a row for one email locks
  // that email out; a 6th attempt is refused outright (429) rather than even
  // checking the password. Uses a bogus email deliberately, never the real
  // owner account — this must not touch the counter the very next step (and
  // the mobile pass further down) needs clean to actually log in.
  for (let i = 0; i < 5; i++) {
    await page.fill('input[name="email"]', "ratelimit-test@pgledger.local");
    await page.fill('input[name="password"]', `wrong-${i}`);
    await page.click('button[type="submit"]');
    await page.waitForLoadState("networkidle");
  }
  await page.fill('input[name="email"]', "ratelimit-test@pgledger.local");
  await page.fill('input[name="password"]', "irrelevant");
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
  check("After 5 failed attempts, a 6th login for the same email is locked out", (await page.content()).includes("Too many failed attempts"));

  // 3. Correct login
  await page.fill('input[name="email"]', "owner@pgledger.local");
  await page.fill('input[name="password"]', "change-me-123");
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/dashboard`);
  await shot(page, "02-dashboard.png");
  check("Login succeeds, lands on dashboard", page.url() === `${BASE}/dashboard`);
  check("Desktop: sidebar visible, bottom tab bar hidden", await page.locator(".sidebar").isVisible() && !(await page.locator(".bottombar").isVisible()));

  // The session cookie is HttpOnly + SameSite=Lax always, but only gets the
  // Secure attribute when the request itself arrived over HTTPS — this test
  // suite talks to plain http://localhost, so Secure must be OFF here (a
  // hardcoded Secure flag would silently break login over plain HTTP).
  const sessionCookie = (await ctx.cookies()).find((c) => c.name === "pgl_session");
  check("Session cookie is HttpOnly and NOT Secure over plain HTTP", !!sessionCookie && sessionCookie.httpOnly === true && sessionCookie.secure === false);

  const dashHtml = await page.content();
  check("Dashboard shows KPI tiles", dashHtml.includes("Expected") && dashHtml.includes("Collected") && dashHtml.includes("Outstanding"));

  check("Desktop: dashboard has no horizontal overflow", await noHOverflow(page));

  // Floor performance table: Expected/Actual/Difference per floor, plus Total and
  // Outstanding summary rows underneath (mirrors the owner's own spreadsheet).
  const perfCard = page.locator('.card', { has: page.locator('h2', { hasText: "Floor performance" }) });
  check("Floor performance table has a Difference column", (await perfCard.locator('thead').innerText()).toLowerCase().includes("difference"));
  const perfRows = perfCard.locator('tbody tr');
  const perfRowTexts = await perfRows.allInnerTexts();
  check("Floor performance table ends with Total and Outstanding summary rows", perfRowTexts.length >= 2 && perfRowTexts[perfRowTexts.length - 2].includes("Total") && perfRowTexts[perfRowTexts.length - 1].includes("Outstanding"));

  // 4. Floors page
  await page.goto(`${BASE}/floors`);
  await shot(page, "03-floors.png");
  check("Floors page loads", (await page.content()).includes("Floors &amp; Rooms"));
  check("Desktop: floors page has no horizontal overflow", await noHOverflow(page));

  // 4a. Clicking a room number navigates to the Tenants page filtered to just
  // that room's occupants, with a banner confirming the filter and a way to
  // clear it.
  const g01Link = page.locator('td.mono a', { hasText: "G01" }).first();
  await g01Link.click();
  await page.waitForLoadState("networkidle");
  check("Clicking a room on Floors & Rooms opens the Tenants page filtered to that room", page.url().includes("/tenants") && page.url().includes("roomId="));
  check("Tenants page shows a banner naming the room being filtered to", (await page.content()).includes("Showing tenants in"));
  const roomFilteredRows = await page.locator(".card table tbody tr").allInnerTexts();
  check("Every row shown belongs to room G01", roomFilteredRows.length > 0 && roomFilteredRows.every((t) => t.includes("G01")), roomFilteredRows.join(" | "));
  await page.locator('a:has-text("Clear room filter")').click();
  await page.waitForLoadState("networkidle");
  check("Clearing the room filter returns to the full Tenants list", !page.url().includes("roomId") && (await page.locator(".card table tbody tr").count()) > roomFilteredRows.length);

  await page.goto(`${BASE}/floors`);
  await page.waitForLoadState("networkidle");

  // 4b. Room edit / delete / deactivate-reactivate on the Floors page.
  // Add a throwaway room with no tenant history — editing it, then hard-deleting it.
  // Scoped to form[action="/floors/rooms"] specifically — every existing room
  // row also has an (initially hidden) edit popover with its own same-named
  // roomNo/sharingType/defaultRent fields, so an unscoped locator would be
  // ambiguous across all of them plus the "+ Add room" form itself.
  const groundFloorCard = page.locator(".card", { has: page.locator("h2", { hasText: "Ground Floor" }) });
  const addRoomForm = groundFloorCard.locator('form[action="/floors/rooms"]');
  await groundFloorCard.locator("summary", { hasText: "Add room" }).click();
  await addRoomForm.locator('input[name="roomNo"]').fill("T1");
  await addRoomForm.locator('select[name="sharingType"]').selectOption("2");
  await addRoomForm.locator('input[name="defaultRent"]').fill("5000");
  await addRoomForm.locator('button:has-text("Add")').click();
  await page.waitForLoadState("networkidle");
  const t1Row = page.locator("table.responsive tbody tr", { has: page.locator("td.mono", { hasText: "T1" }) }).first();
  check("New room T1 appears in the table", (await t1Row.count()) === 1);

  await t1Row.locator('label[title="Edit room"]').click();
  await shot(page, "34-room-edit-popover.png");
  await t1Row.locator('.ie-form.popover input[name="roomNo"]').fill("T1-edit");
  await t1Row.locator('.ie-form.popover select[name="sharingType"]').selectOption("3");
  await t1Row.locator('.ie-form.popover input[name="defaultRent"]').fill("5500");
  await t1Row.locator('.ie-form.popover button[title="Save"]').click();
  await page.waitForLoadState("networkidle");
  const t1EditedRow = page.locator("table.responsive tbody tr", { has: page.locator("td.mono", { hasText: "T1-edit" }) }).first();
  const t1EditedText = await t1EditedRow.innerText();
  check("Editing a room updates its room no., sharing, and rent", t1EditedText.includes("T1-edit") && t1EditedText.includes("3-sharing") && t1EditedText.includes("5,500"));

  page.once("dialog", (d) => d.accept());
  await t1EditedRow.locator('button[title="Delete room"]').click();
  await page.waitForLoadState("networkidle");
  check("Deleting a room with no tenant history removes it outright (hard delete)", (await page.content()).includes("T1-edit deleted") && (await page.locator("table.responsive tbody tr", { has: page.locator("td.mono", { hasText: "T1-edit" }) }).count()) === 0);

  // Add a second room, assign + vacate a tenant in it, then delete it: this time
  // it should be DEACTIVATED (not removed), since it has tenant history to keep.
  await groundFloorCard.locator("summary", { hasText: "Add room" }).click();
  await addRoomForm.locator('input[name="roomNo"]').fill("T2");
  await addRoomForm.locator('select[name="sharingType"]').selectOption("1");
  await addRoomForm.locator('input[name="defaultRent"]').fill("9000");
  await addRoomForm.locator('button:has-text("Add")').click();
  await page.waitForLoadState("networkidle");

  await page.goto(`${BASE}/tenants/new`);
  const t2Value = await page.locator("#roomSel option", { hasText: "T2" }).getAttribute("value");
  await page.selectOption("#roomSel", t2Value);
  await page.waitForTimeout(200);
  await page.selectOption("#bedSel", "1");
  await page.fill('input[name="fullName"]', "Room Delete Test Tenant");
  await page.fill('input[name="phone"]', "9999900002");
  await page.locator('button:has-text("Add tenant")').click();
  await page.waitForLoadState("networkidle");
  // Vacate is now a popover (it also captures the deposit refund), not an
  // instant-submit button — open it and hit its own Confirm icon.
  await page.locator('.ie-view label[for="vacate-toggle"]').click();
  await page.locator('form[action$="/vacate"] button[title="Confirm vacate"]').click();
  await page.waitForLoadState("networkidle");

  await page.goto(`${BASE}/floors`);
  const t2Row = page.locator("table.responsive tbody tr", { has: page.locator("td.mono", { hasText: "T2" }) }).first();
  page.once("dialog", (d) => d.accept());
  await t2Row.locator('button[title="Delete room"]').click();
  await page.waitForLoadState("networkidle");
  const flashText = await page.locator(".flash").innerText().catch(() => "");
  check("Deleting a room with past (vacated) tenant history deactivates it instead of removing it", flashText.includes("marked inactive"));
  const t2InactiveRow = page.locator("table.responsive tbody tr", { has: page.locator("td.mono", { hasText: "T2" }) }).first();
  check("Deactivated room shows an 'inactive' pill and a Reactivate icon", (await t2InactiveRow.innerText()).includes("inactive") && (await t2InactiveRow.locator('button[title="Reactivate room"]').count()) === 1);

  await t2InactiveRow.locator('button[title="Reactivate room"]').click();
  await page.waitForLoadState("networkidle");
  const t2ReactivatedRow = page.locator("table.responsive tbody tr", { has: page.locator("td.mono", { hasText: "T2" }) }).first();
  check("Reactivating a room clears the inactive pill and restores the Delete icon", !(await t2ReactivatedRow.innerText()).includes("inactive") && (await t2ReactivatedRow.locator('button[title="Delete room"]').count()) === 1);

  // A room that's currently occupied refuses to delete at all.
  const g01Row = page.locator("table.responsive tbody tr", { has: page.locator("td.mono", { hasText: "G01" }) }).first();
  page.once("dialog", (d) => d.accept());
  await g01Row.locator('button[title="Delete room"]').click();
  await page.waitForLoadState("networkidle");
  const g01FlashText = await page.locator(".flash").innerText().catch(() => "");
  check("Deleting an occupied room is refused with a clear error", g01FlashText.includes("active tenant") && (await page.locator("table.responsive tbody tr", { has: page.locator("td.mono", { hasText: "G01" }) }).count()) === 1);

  // 5. Tenants list
  await page.goto(`${BASE}/tenants`);
  await shot(page, "04-tenants.png");
  check("Tenants list loads", (await page.content()).includes("Tenants"));
  check("Desktop: tenants list has no horizontal overflow", await noHOverflow(page));

  // 5b. Floor filter on the Tenants list — same tabs pattern as Rent Collection.
  const allFloorsRowCount = await page.locator("table.responsive tbody tr").count();
  check("Tenants list shows an 'All floors' tab plus one per floor", await page.locator(".tabs a", { hasText: "All floors" }).count() === 1 && await page.locator(".tabs a", { hasText: "Ground Floor" }).count() === 1);

  await page.locator(".tabs a", { hasText: "Ground Floor" }).click();
  await page.waitForLoadState("networkidle");
  await shot(page, "04b-tenants-floor-filtered.png");
  const groundFloorRows = page.locator("table.responsive tbody tr");
  const groundFloorRowCount = await groundFloorRows.count();
  const groundFloorText = await groundFloorRows.allInnerTexts();
  check("Filtering by Ground Floor shows fewer rows than 'All floors', all on that floor", groundFloorRowCount > 0 && groundFloorRowCount < allFloorsRowCount && groundFloorText.every((t) => t.includes("Ground Floor")));
  check("Ground Floor tab is marked active and the URL carries floorId", page.url().includes("floorId") && (await page.locator(".tabs a.active", { hasText: "Ground Floor" }).count()) === 1);

  // The floor filter composes with the status tabs, preserving whichever is active.
  // Exact-text match for "All" — "All floors" also contains the substring "All",
  // so a plain hasText:"All" would ambiguously match both tab rows.
  await page.locator(".tabs a", { hasText: /^All$/ }).click();
  await page.waitForLoadState("networkidle");
  check("Switching status tab while floor-filtered keeps the floor filter applied", page.url().includes("status=all") && page.url().includes("floorId") && (await page.locator(".tabs a.active", { hasText: "Ground Floor" }).count()) === 1);

  await page.locator(".tabs a", { hasText: "All floors" }).click();
  await page.waitForLoadState("networkidle");
  check("'All floors' clears the floor filter but keeps the status tab", !page.url().includes("floorId") && page.url().includes("status=all"));

  // 5c. Free-text search box — plain GET form, no JavaScript, just a page
  // reload with ?q=. Pick a real tenant's name off the current (unfiltered,
  // status=all) list rather than hardcoding one, so this doesn't depend on
  // exact seed data — and capture this page's own row count as the baseline,
  // since allFloorsRowCount above was measured back on the status=active tab.
  const unfilteredRowCount = await page.locator("table.responsive tbody tr").count();
  const someTenantName = await page.locator(".card-id").first().innerText();
  const firstWord = someTenantName.split(" ")[0];
  await page.fill('input[name="q"]', firstWord);
  await page.locator('form[action="/tenants"] button:has-text("Search")').click();
  await page.waitForLoadState("networkidle");
  check("Searching by name filters the tenant list to matches", page.url().includes(`q=${firstWord}`) && (await page.locator(".card-id", { hasText: firstWord }).count()) >= 1);
  const searchedRowCount = await page.locator("table.responsive tbody tr").count();
  check("Search results are a subset of the unfiltered list", searchedRowCount > 0 && searchedRowCount <= unfilteredRowCount);

  await page.fill('input[name="q"]', "zzz-no-such-tenant-zzz");
  await page.locator('form[action="/tenants"] button:has-text("Search")').click();
  await page.waitForLoadState("networkidle");
  check("A search with no matches shows the empty state naming the search term", (await page.content()).includes("No tenants match"));

  await page.locator("a", { hasText: "✕ Clear search" }).click();
  await page.waitForLoadState("networkidle");
  check("Clearing the search restores the full list", !page.url().includes("q=") && (await page.locator("table.responsive tbody tr").count()) === unfilteredRowCount);

  // 6. Add a new tenant (free bed: room G02, bed 3)
  await page.goto(`${BASE}/tenants/new`);
  const g02Value = await page.locator("#roomSel option", { hasText: "G02" }).getAttribute("value");
  await page.selectOption("#roomSel", g02Value);
  await page.waitForTimeout(200);
  await page.selectOption("#bedSel", "3");
  await page.fill('input[name="fullName"]', "Test Tenant E2E");
  await page.fill('input[name="phone"]', "9999900000");
  await page.fill('input[name="occupation"]', "QA Engineer");
  await page.fill('input[name="idProofNumber"]', "TEST1234E2E");
  await page.fill('input[name="emergencyName"]', "Emergency Contact");
  await page.fill('input[name="emergencyPhone"]', "9999900001");
  await page.fill('input[name="emergencyRelation"]', "Friend");
  await page.locator('button:has-text("Add tenant")').click();
  await page.waitForLoadState("networkidle");
  const afterAddUrl = page.url();
  check("New tenant created, redirected to profile", /\/tenants\/\d+$/.test(afterAddUrl), afterAddUrl);
  await shot(page, "05-tenant-profile-new.png");
  check("New tenant profile shows name", (await page.content()).includes("Test Tenant E2E"));
  const waHref = await page.locator('a.icon-btn.wa').first().getAttribute("href");
  check("Tenant profile phone shows a WhatsApp icon linking to wa.me/91<number>", waHref === "https://wa.me/919999900000", waHref);

  // 6b2. Quick inline edit of Monthly rent from the Details card (a lighter-weight
  // sibling to the full Edit Tenant form) — only future auto-generated charges
  // should ever pick this up, never anything already billed.
  const detailsCard = page.locator('.card', { has: page.locator('h2', { hasText: "Details" }) });
  await detailsCard.locator('label[title="Edit monthly rent"]').click();
  await detailsCard.locator('form[action$="/edit-rent"] input[name="monthlyRent"]').fill("8888");
  await detailsCard.locator('form[action$="/edit-rent"] button[title="Save"]').click();
  await page.waitForLoadState("networkidle");
  const detailsCardAfter = page.locator('.card', { has: page.locator('h2', { hasText: "Details" }) });
  check("Editing monthly rent from the tenant profile's Details card updates the figure shown", (await detailsCardAfter.innerText()).includes("8,888"));

  // 6c. Add / edit / waive / reinstate a due, directly from the tenant profile page
  const chargeCard = page.locator('.card', { has: page.locator('h2', { hasText: "Rent charge history" }) });
  await chargeCard.locator('summary', { hasText: "+ Add due" }).click();
  await chargeCard.locator('select[name="month"]').selectOption("3");
  await chargeCard.locator('input[name="year"]').fill("2027");
  await chargeCard.locator('button:has-text("Add due")').click();
  await page.waitForLoadState("networkidle");
  await shot(page, "05b-tenant-add-due.png");
  const dueRow = page.locator('.card table tbody tr', { hasText: "2027-03" });
  check("Add due (from the tenant page) creates a new rent charge row for that month", await dueRow.count() === 1);
  check("A freshly added, unpaid due shows as Overdue (not a bare 'Active' status)", (await dueRow.innerText()).includes("Overdue"));

  // Both the Edit-amount and Waive popovers live in the same row's DOM (just
  // hidden by the checkbox hack until opened), and both happen to have a
  // name="reason" input — scope by the form's action, not just .ie-form.popover.
  await dueRow.locator('label[title="Edit amount"]').click();
  await dueRow.locator('form[action$="/edit-amount"] input[name="amount"]').fill("12345");
  await dueRow.locator('form[action$="/edit-amount"] input[name="reason"]').fill("E2E test: manual correction");
  await dueRow.locator('form[action$="/edit-amount"] button[title="Save"]').click();
  await page.waitForLoadState("networkidle");
  const editedDueRow = page.locator('.card table tbody tr', { hasText: "2027-03" });
  check("Editing a due's amount from the tenant page updates the Expected figure", (await editedDueRow.innerText()).includes("12,345"));

  // Record a payment against this due, directly from the tenant page (not
  // just Rent Collection) — a partial payment should flip the row to
  // Partial and drop Outstanding by the paid amount.
  await editedDueRow.locator('label[title="Record a payment"]').click();
  await editedDueRow.locator('form[action$="/pay"] input[name="amount"]').fill("5000");
  await editedDueRow.locator('form[action$="/pay"] select[name="mode"]').selectOption("cash");
  await editedDueRow.locator('form[action$="/pay"] button[title="Save payment"]').click();
  await page.waitForLoadState("networkidle");
  const paidDueRow = page.locator('.card table tbody tr', { hasText: "2027-03" });
  const paidDueRowText = await paidDueRow.innerText();
  check("Recording a payment from the tenant page shows Partial with the reduced Outstanding figure", paidDueRowText.includes("Partial") && paidDueRowText.includes("7,345"), paidDueRowText);
  const paymentsCard = page.locator('.card', { has: page.locator('h2', { hasText: "Payments" }) });
  check("The payment recorded from the due row appears in the tenant's Payments list", (await paymentsCard.innerText()).includes("5,000"));

  await paidDueRow.locator('label[title="Waive this due"]').click();
  await paidDueRow.locator('form[action$="/waive"] input[name="reason"]').fill("E2E test: waived");
  await paidDueRow.locator('form[action$="/waive"] button[title="Confirm waive"]').click();
  await page.waitForLoadState("networkidle");
  const waivedDueRow = page.locator('.card table tbody tr', { hasText: "2027-03" });
  check("Waiving a due from the tenant page marks it Waived", (await waivedDueRow.innerText()).includes("Waived"));
  check("A waived due offers Reinstate instead of Edit/Waive", await waivedDueRow.locator('button[title="Reinstate this due"]').count() === 1 && await waivedDueRow.locator('label[title="Edit amount"]').count() === 0);

  await waivedDueRow.locator('button[title="Reinstate this due"]').click();
  await page.waitForLoadState("networkidle");
  const reinstatedDueRow = page.locator('.card table tbody tr', { hasText: "2027-03" });
  // Partial, not Overdue — the ₹5,000 payment recorded earlier against this
  // due is still there (waiving/reinstating a charge never touches its
  // payments), so its real status is back to reflecting that.
  check("Reinstating a due from the tenant page brings back its real Paid/Due/Overdue status", (await reinstatedDueRow.innerText()).includes("Partial") && await reinstatedDueRow.locator('label[title="Edit amount"]').count() === 1);

  // 6b. Duplicate bed should fail (bed 3 in room G02 now occupied)
  await page.goto(`${BASE}/tenants/new`);
  await page.selectOption("#roomSel", g02Value);
  await page.waitForTimeout(200);
  const bed3Disabled = await page.locator("#bedSel option[value='3']").getAttribute("disabled");
  check("Occupied bed shown disabled in Add Tenant form", bed3Disabled !== null);

  // 7. Rent Collection page — icon-based row actions
  await page.goto(`${BASE}/rent?year=2026&month=9`);
  await shot(page, "06-rent-before.png");
  let rentHtml = await page.content();
  check("Rent Collection page loads with charges", rentHtml.includes("Rent Collection") && rentHtml.includes("Overdue"));

  const mainTable = page.locator(".card table").first();
  const overdueRows = mainTable.locator("tbody tr", { hasText: "Overdue" });
  const overdueCount = await overdueRows.count();
  check("At least 2 overdue charges exist in the main table to test with", overdueCount >= 2, `overdue=${overdueCount}`);
  check("Rows use icon actions (Pay/Waive/history), not a text 'Manage' button", await overdueRows.first().locator("a.btn.primary", { hasText: "Manage" }).count() === 0 && await overdueRows.first().locator('label[title="Record a payment"]').count() === 1 && await overdueRows.first().locator('label[title="Waive this due"]').count() === 1);
  check("Expected amount has an inline pencil edit icon", await overdueRows.first().locator('label[title="Edit amount"]').count() === 1);

  // 8. Waive via the icon popover, right on the row
  const waiveTargetRow = overdueRows.first();
  const waiveTargetName = (await waiveTargetRow.locator("a").first().innerText()).trim();
  check(`Overdue tenant found to waive (${waiveTargetName})`, waiveTargetName.length > 0);
  await waiveTargetRow.locator('label[title="Waive this due"]').click();
  await waiveTargetRow.locator('.ie-form.popover input[name="reason"]').fill("E2E test: owner waived this month's rent");
  await shot(page, "07-waive-popover-open.png");
  await waiveTargetRow.locator('.ie-form.popover button[title="Confirm waive"]').click();
  await page.waitForLoadState("networkidle");
  await shot(page, "08-rent-after-waive.png");
  const waivedRow = page.locator(".card table").first().locator("tr", { has: page.locator("a", { hasText: waiveTargetName }) });
  check(`${waiveTargetName}'s row now shows Waived, ₹0 outstanding, and a Reinstate icon (no Pay/Waive/Edit icons)`,
    (await waivedRow.innerText()).includes("Waived") &&
    (await waivedRow.innerText()).includes("₹0") &&
    (await waivedRow.locator('button[title="Reinstate this due"]').count()) === 1 &&
    (await waivedRow.locator('label[title="Edit amount"]').count()) === 0);

  // 9. THE CORE REGRESSION TEST: reload twice, confirm the charge did NOT regenerate
  await page.goto(`${BASE}/rent?year=2026&month=9`);
  await page.waitForLoadState("networkidle");
  let reRow = page.locator(".card table").first().locator("tr", { has: page.locator("a", { hasText: waiveTargetName }) });
  check(`BUG-FIX REGRESSION: exactly one row for ${waiveTargetName} after reload, still Waived`, (await reRow.count()) === 1 && (await reRow.innerText()).includes("Waived"));
  await page.goto(`${BASE}/rent?year=2026&month=9`);
  await page.waitForLoadState("networkidle");
  reRow = page.locator(".card table").first().locator("tr", { has: page.locator("a", { hasText: waiveTargetName }) });
  check(`Still exactly one row for ${waiveTargetName} after a second reload`, (await reRow.count()) === 1);

  // 10. Reinstate via the one-click icon (no popover needed)
  await reRow.locator('button[title="Reinstate this due"]').click();
  await page.waitForLoadState("networkidle");
  await shot(page, "09-rent-after-reinstate.png");
  const reinstatedRow = page.locator(".card table").first().locator("tr", { has: page.locator("a", { hasText: waiveTargetName }) });
  check(`Reinstate: ${waiveTargetName}'s row back to Overdue with Pay/Waive/Edit icons restored`,
    (await reinstatedRow.innerText()).includes("Overdue") &&
    (await reinstatedRow.locator('label[title="Record a payment"]').count()) === 1 &&
    (await reinstatedRow.locator('label[title="Edit amount"]').count()) === 1);

  // 11. Edit the amount directly in the Expected cell (inline, not a separate page).
  // Scoped to the .inline-edit that HAS the Edit-amount pencil specifically — the
  // Pay popover in the Actions cell is also an .inline-edit with its own
  // input[name="amount"], so an unscoped selector on the row would be ambiguous.
  const expectedInlineEdit = reinstatedRow.locator('.inline-edit', { has: page.locator('label[title="Edit amount"]') });
  await expectedInlineEdit.locator('label[title="Edit amount"]').click();
  await shot(page, "10-edit-inline-open.png");
  const editInput = expectedInlineEdit.locator('.ie-form input[name="amount"]');
  await editInput.fill("7200");
  await expectedInlineEdit.locator('.ie-form button[title="Save"]').click();
  await page.waitForLoadState("networkidle");
  await shot(page, "11-rent-after-edit.png");
  const editedRow = page.locator(".card table").first().locator("tr", { has: page.locator("a", { hasText: waiveTargetName }) });
  const editedText = await editedRow.innerText();
  check("Edited amount shows ₹7,200 with a 'was' note, right in the Expected cell", editedText.includes("7,200") && editedText.includes("was"));

  // 11b. Survives a reload
  await page.goto(`${BASE}/rent?year=2026&month=9`);
  await page.waitForLoadState("networkidle");
  const editedRow2 = page.locator(".card table").first().locator("tr", { has: page.locator("a", { hasText: waiveTargetName }) });
  check("Edited amount (₹7,200) still shown after reloading the list", (await editedRow2.innerText()).includes("7,200"));

  // 11c. A waived row loses its Edit pencil (already checked above at step 8); re-confirm on this row too
  await editedRow2.locator('label[title="Waive this due"]').click();
  await editedRow2.locator('.ie-form.popover input[name="reason"]').fill("re-waiving to check Edit pencil disappears");
  await editedRow2.locator('.ie-form.popover button[title="Confirm waive"]').click();
  await page.waitForLoadState("networkidle");
  const rewaivedRow = page.locator(".card table").first().locator("tr", { has: page.locator("a", { hasText: waiveTargetName }) });
  check("Waived row has no Edit-amount pencil", (await rewaivedRow.locator('label[title="Edit amount"]').count()) === 0);
  await rewaivedRow.locator('button[title="Reinstate this due"]').click();
  await page.waitForLoadState("networkidle");

  // 12. Record a payment for a second, different overdue tenant via its Pay icon popover
  await page.goto(`${BASE}/rent?year=2026&month=9`);
  await page.waitForLoadState("networkidle");
  const payTargetRow = page.locator(".card table").first().locator("tbody tr", { hasText: "Overdue" }).filter({ hasNotText: waiveTargetName }).first();
  const payTargetName = (await payTargetRow.locator("a").first().innerText()).trim();
  check(`A second, different overdue tenant found to pay (${payTargetName})`, payTargetName.length > 0 && payTargetName !== waiveTargetName);
  await payTargetRow.locator('label[title="Record a payment"]').click();
  await shot(page, "12-pay-popover-open.png");
  await payTargetRow.locator('.ie-form.popover select[name="accountId"]').selectOption({ label: "Cash" });
  await payTargetRow.locator('.ie-form.popover select[name="mode"]').selectOption("cash");
  await payTargetRow.locator('.ie-form.popover button[title="Save payment"]').click();
  await page.waitForLoadState("networkidle");
  await shot(page, "13-rent-after-payment.png");
  const payRowAfter = page.locator(".card table").first().locator("tr", { has: page.locator("a", { hasText: payTargetName }) });
  // .lbl (the "via ..." note) is upper-cased by CSS (text-transform), so compare
  // case-insensitively — the rendered text is "VIA CASH", not "via Cash".
  const payText = await payRowAfter.innerText();
  check(`Payment recorded: ${payTargetName} now shows Paid, ₹0 outstanding, and "via Cash"`, payText.includes("Paid") && !payText.includes("Overdue") && payText.toLowerCase().includes("cash"));

  // 13. Record a SECOND payment for the same tenant from a DIFFERENT account (e.g. a
  // top-up / correction) and confirm the Paid cell turns into a multi-account dropdown.
  await payRowAfter.locator('label[title="Record a payment"]').click();
  await payRowAfter.locator('.ie-form.popover input[name="amount"]').fill("500");
  await payRowAfter.locator('.ie-form.popover select[name="accountId"]').selectOption({ label: "UPI Collect" });
  await payRowAfter.locator('.ie-form.popover select[name="mode"]').selectOption("upi");
  await payRowAfter.locator('.ie-form.popover button[title="Save payment"]').click();
  await page.waitForLoadState("networkidle");
  const splitRow = page.locator(".card table").first().locator("tr", { has: page.locator("a", { hasText: payTargetName }) });
  await shot(page, "14-rent-split-payment.png");
  check(`${payTargetName}'s Paid cell now shows a "2 accounts" dropdown instead of a single "via" note`, (await splitRow.locator(".acct-dropdown").count()) === 1);
  await splitRow.locator(".acct-dropdown summary").click();
  const breakdownText = await splitRow.locator(".acct-breakdown").innerText();
  check("Dropdown breaks down the amount paid into each account", breakdownText.includes("Cash") && breakdownText.includes("UPI Collect"));
  await shot(page, "15-rent-split-payment-open.png");

  // 14. Void one of those payments via the "view full history" icon (still the fuller
  // Manage page, since a table row has no room for a full void-with-reason flow) —
  // this now uses the same icon-based Void popover (voidPaymentCell) as everywhere
  // else, not a plain text "Void" button.
  const tenantProfileHref = await splitRow.locator("a").first().getAttribute("href");
  await splitRow.locator('a[title="View full payment history"]').click();
  await page.waitForLoadState("networkidle");
  check("History icon opens the /rent/charge/:id page with the full payment log", /\/rent\/charge\/\d+/.test(page.url()) && (await page.content()).includes("Payments against this due"));
  await shot(page, "16-charge-detail-from-icon.png");

  // 13b. Edit one leg of the split payment via its Edit-payment popover — should only
  // change that ONE row (amount + account), leaving the other account's payment on
  // this same charge completely untouched.
  const editableRows = page.locator("table.responsive tbody tr", { has: page.locator('label[title="Edit this payment"]') });
  check("Charge detail payment table shows an Edit icon on each active payment", (await editableRows.count()) === 2);
  const otherRowAmountBefore = (await editableRows.nth(1).locator('td[data-label="Amount"]').innerText()).trim();
  await editableRows.first().locator('label[title="Edit this payment"]').click();
  await shot(page, "16c-edit-payment-popover.png");
  await editableRows.first().locator('.ie-form.popover input[name="amount"]').fill("350");
  await editableRows.first().locator('.ie-form.popover select[name="accountId"]').selectOption({ label: "Cash" });
  await editableRows.first().locator('.ie-form.popover button[title="Save"]').click();
  await page.waitForLoadState("networkidle");
  const rowsAfterEdit = page.locator("table.responsive tbody tr", { has: page.locator('label[title="Edit this payment"]') });
  const firstAmountAfter = (await rowsAfterEdit.first().locator('td[data-label="Amount"]').innerText()).trim();
  const otherAmountAfter = (await rowsAfterEdit.nth(1).locator('td[data-label="Amount"]').innerText()).trim();
  check("Editing one payment leg updates only that row's amount, leaving the other leg untouched", firstAmountAfter.includes("350") && otherAmountAfter === otherRowAmountBefore, `first=${firstAmountAfter} other=${otherAmountAfter}/${otherRowAmountBefore}`);

  const voidRow = page.locator("table.responsive tbody tr", { has: page.locator('label[title="Void this payment"]') }).first();
  await voidRow.locator('label[title="Void this payment"]').click();
  // Scoped to the form whose action ends in /void specifically — each row now also
  // carries an Edit-payment popover (its own reason field) sitting right alongside.
  await voidRow.locator('form[action$="/void"] input[name="reason"]').fill("E2E test: correcting a duplicate entry");
  await voidRow.locator('form[action$="/void"] button[title="Confirm void"]').click();
  await page.waitForLoadState("networkidle");
  check("Voiding one payment on the history page (icon popover) shows a Voided pill", (await page.content()).includes("Voided"));

  // 14b. Void the same tenant's remaining active payment from their Tenant Profile
  // page instead — the second place voidPaymentCell is used, confirming both call
  // sites share one consistent icon-based interaction (not a copy that drifted).
  await page.goto(`${BASE}${tenantProfileHref}`);
  await page.waitForLoadState("networkidle");
  const profileVoidRow = page.locator("table.responsive tbody tr", { has: page.locator('label[title="Void this payment"]') }).first();
  const hasProfileVoidRow = (await profileVoidRow.count()) > 0;
  check("Tenant profile shows the remaining active payment with a Void icon", hasProfileVoidRow);
  if (hasProfileVoidRow) {
    await profileVoidRow.locator('label[title="Void this payment"]').click();
    await shot(page, "16b-tenant-profile-void-popover.png");
    await profileVoidRow.locator('form[action$="/void"] input[name="reason"]').fill("E2E test: voided from tenant profile");
    await profileVoidRow.locator('form[action$="/void"] button[title="Confirm void"]').click();
    await page.waitForLoadState("networkidle");
    check("Voiding from the tenant profile page shows a Voided pill and redirects back to the profile", page.url().includes(tenantProfileHref) && (await page.content()).includes("Voided"));
  }
  check("Desktop: tenant profile has no horizontal overflow", await noHOverflow(page));

  // 15. Due-date gating: a "Not due yet this month" section exists with a working "Add due now"
  await page.goto(`${BASE}/rent?year=2026&month=9`);
  await page.waitForLoadState("networkidle");
  const notDueSection = page.locator("text=Not due yet this month");
  const hasNotDueSection = await notDueSection.count() > 0;
  check("Rent Collection shows a 'Not due yet this month' section for tenants whose due day hasn't arrived", hasNotDueSection);
  if (hasNotDueSection) {
    const notDueTable = page.locator(".card table").nth(1);
    const notDueRow = notDueTable.locator("tbody tr").first();
    const notDueName = (await notDueRow.locator("a").innerText()).trim();
    const mainRowsBefore = await mainTable.locator("tbody tr").count();
    await notDueRow.locator('button:has-text("Add due now")').click();
    await page.waitForLoadState("networkidle");
    await shot(page, "17-after-add-due-now.png");
    const mainTableAfter = page.locator(".card table").first();
    const mainRowsAfter = await mainTableAfter.locator("tbody tr").count();
    check(`"Add due now" moves ${notDueName} into the main Rent Collection table`, mainRowsAfter === mainRowsBefore + 1 && (await mainTableAfter.innerText()).includes(notDueName));
  }

  // 16. Accounts page
  await page.goto(`${BASE}/accounts`);
  await shot(page, "18-accounts.png");
  const acctHtml = await page.content();
  check("Accounts page shows account cards with balances", acctHtml.includes("Owner - SBI") || acctHtml.includes("Cash") || acctHtml.includes("UPI"));
  check("Desktop: accounts page has no horizontal overflow", await noHOverflow(page));

  // Income-by-account summary table (mirrors the owner's spreadsheet's Accounts
  // table: each account's total income, plus a grand Total row) sits above the
  // account cards, and is separate from the per-account balance shown on a card.
  const incomeCard = page.locator('.card', { has: page.locator('h2', { hasText: "Income by account" }) });
  check("Accounts page shows an Income by account summary table", await incomeCard.count() === 1);
  check("Income by account table has a Total row summing every account's income", (await incomeCard.locator('tfoot').innerText()).includes("Total"));
  const incomeRowCount = await incomeCard.locator('tbody tr').count();
  const acctCardCount = await page.locator('.card .acct-name').count();
  check("Income by account table lists every account (same count as the cards below)", incomeRowCount === acctCardCount, `income rows=${incomeRowCount} cards=${acctCardCount}`);

  await page.locator("a:has-text('view transactions')").first().click();
  await page.waitForLoadState("networkidle");
  await shot(page, "19-account-detail.png");
  check("Account detail/ledger page loads", (await page.content()).includes("Credit") || (await page.content()).includes("Debit"));
  check("Desktop: account detail page has no horizontal overflow", await noHOverflow(page));

  // Credit/Debit filter tabs on the account detail/ledger page.
  check("Account detail page shows Credit/Debit filter tabs", (await page.locator(".tabs a", { hasText: "Credit" }).count()) === 1 && (await page.locator(".tabs a", { hasText: "Debit" }).count()) === 1);
  await page.locator(".tabs a", { hasText: "Credit" }).click();
  await page.waitForLoadState("networkidle");
  const creditTypeCells = await page.locator('td[data-label="Type"]').allInnerTexts();
  check("Filtering by Credit shows only Credit rows", creditTypeCells.length > 0 && creditTypeCells.every((t) => t.includes("Credit")), creditTypeCells.join(","));
  await page.locator(".tabs a", { hasText: "Debit" }).click();
  await page.waitForLoadState("networkidle");
  const debitTypeCells = await page.locator('td[data-label="Type"]').allInnerTexts();
  check("Filtering by Debit shows only Debit rows", debitTypeCells.length > 0 && debitTypeCells.every((t) => t.includes("Debit")), debitTypeCells.join(","));

  // 16b. Accounts: create a throwaway account with no transaction history, edit it,
  // then hard-delete it (removed outright — zero transactions ever). Then delete an
  // account WITH transaction history (Cash) — that one should deactivate instead.
  await page.goto(`${BASE}/accounts`);
  await page.locator("summary:has-text('Add account')").click();
  await page.fill('form[action="/accounts"] input[name="name"]', "E2E Throwaway Account");
  await page.locator('form[action="/accounts"] select[name="type"]').selectOption("cash");
  await page.click('form[action="/accounts"] button:has-text("Add")');
  await page.waitForLoadState("networkidle");
  check("New account appears on the Accounts page", (await page.content()).includes("E2E Throwaway Account"));

  // Scoped by the .acct-name div with an EXACT text match — a plain hasText:"Cash"
  // substring search would also match every OTHER account's card, because each
  // card's (hidden, unopened) type <select> always carries a "Cash" <option>
  // regardless of that account's own type, and Playwright's hasText matches
  // textContent, hidden elements included.
  function acctCard(name) {
    return page.locator(".card").filter({ has: page.locator(".acct-name", { hasText: new RegExp(`^${name}$`) }) });
  }

  const newAcctCard = acctCard("E2E Throwaway Account");
  await newAcctCard.locator('label[title="Edit account"]').click();
  await shot(page, "18b-account-edit-popover.png");
  await newAcctCard.locator('.ie-form.popover input[name="name"]').fill("E2E Renamed Account");
  await newAcctCard.locator('.ie-form.popover button[title="Save"]').click();
  await page.waitForLoadState("networkidle");
  check("Editing an account renames it", (await page.content()).includes("E2E Renamed Account") && !(await page.content()).includes("E2E Throwaway Account"));

  const renamedCard = acctCard("E2E Renamed Account");
  page.once("dialog", (d) => d.accept());
  await renamedCard.locator('button[title="Delete account"]').click();
  await page.waitForLoadState("networkidle");
  check("Deleting an account with zero transaction history removes it outright (hard delete)", (await page.content()).includes("deleted") && (await acctCard("E2E Renamed Account").count()) === 0);

  const cashCard = acctCard("Cash");
  page.once("dialog", (d) => d.accept());
  await cashCard.locator('button[title="Delete account"]').click();
  await page.waitForLoadState("networkidle");
  const afterDeactivateHtml = await page.content();
  check("Deleting an account WITH transaction history deactivates it instead of removing it", afterDeactivateHtml.includes("marked inactive"));
  await shot(page, "18c-account-deactivated.png");

  const deactivatedCashCard = acctCard("Cash");
  check("Deactivated account shows an Inactive pill and a Reactivate icon", (await deactivatedCashCard.locator('button[title="Reactivate account"]').count()) === 1);
  await deactivatedCashCard.locator('button[title="Reactivate account"]').click();
  await page.waitForLoadState("networkidle");
  const reactivatedCashCard = acctCard("Cash");
  check("Reactivating an account clears the inactive pill and restores the Delete icon", (await reactivatedCashCard.locator('button[title="Delete account"]').count()) === 1);

  // 17. Expenses - add one
  await page.goto(`${BASE}/expenses`);
  await page.locator("summary:has-text('Log an expense')").click();
  await page.fill('input[name="category"]', "E2E Test Expense");
  await page.fill('input[name="amount"]', "500");
  await page.fill('input[name="note"]', "Automated test entry");
  await page.click('button:has-text("Save")');
  await page.waitForLoadState("networkidle");
  await shot(page, "20-expenses-after.png");
  const expensesAfter = await page.content();
  check("New expense appears in list", expensesAfter.includes("E2E Test Expense") && expensesAfter.includes("Automated test entry"));
  check("Desktop: expenses page has no horizontal overflow", await noHOverflow(page));

  // 17a. Filter expenses by account — the new expense was logged against
  // whichever account is first in the picker; read its name off the row
  // itself rather than assuming which one that is.
  const newExpenseRow = page.locator("table.responsive tbody tr", { hasText: "E2E Test Expense" });
  const newExpenseAccountName = (await newExpenseRow.locator('td[data-label="Account"] a').innerText()).trim();
  await newExpenseRow.locator('td[data-label="Account"] a').click();
  await page.waitForLoadState("networkidle");
  check("Clicking an expense's account filters the list to that account", page.url().includes("accountId="));
  const filteredExpenseRows = await page.locator("table.responsive tbody tr").allInnerTexts();
  check(`Filtered expenses list only shows ${newExpenseAccountName} expenses`, filteredExpenseRows.length > 0 && filteredExpenseRows.every((t) => t.includes(newExpenseAccountName)), filteredExpenseRows.join(" | "));
  check("Filtered account tab is marked active", (await page.locator(".tabs a.active", { hasText: newExpenseAccountName }).count()) === 1);
  await page.locator(".tabs a", { hasText: "All accounts" }).click();
  await page.waitForLoadState("networkidle");
  check("'All accounts' clears the filter and still shows the new expense", !page.url().includes("accountId") && (await page.locator("table.responsive tbody tr", { hasText: "E2E Test Expense" }).count()) === 1);

  // 17b. Edit that expense's category/amount, then delete it (voided, not hard-deleted
  // — the account balance is credited back).
  const expenseRow = page.locator("table.responsive tbody tr", { hasText: "E2E Test Expense" });
  await expenseRow.locator('label[title="Edit expense"]').click();
  await shot(page, "20b-expense-edit-popover.png");
  await expenseRow.locator('.ie-form.popover input[name="category"]').fill("E2E Test Expense (edited)");
  await expenseRow.locator('.ie-form.popover input[name="amount"]').fill("650");
  await expenseRow.locator('.ie-form.popover button[title="Save"]').click();
  await page.waitForLoadState("networkidle");
  const expensesAfterEdit = await page.content();
  check("Editing an expense updates its category and amount", expensesAfterEdit.includes("E2E Test Expense (edited)") && expensesAfterEdit.includes("650"));

  const editedExpenseRow = page.locator("table.responsive tbody tr", { hasText: "E2E Test Expense (edited)" });
  page.once("dialog", (d) => d.accept());
  await editedExpenseRow.locator('button[title="Delete expense"]').click();
  await page.waitForLoadState("networkidle");
  check("Deleting an expense removes it from the active list", !(await page.content()).includes("E2E Test Expense (edited)"));

  // 18. Give notice, cancel it, then vacate (with a deposit refund) the test
  // tenant we created — cleanup, and coverage for all three new actions.
  await page.goto(`${BASE}/tenants?status=active`);
  const testTenantLink = page.locator("a", { hasText: "Test Tenant E2E" });
  if (await testTenantLink.count() > 0) {
    await testTenantLink.click();
    await page.waitForLoadState("networkidle");
    const testTenantProfileUrl = page.url();

    // 18a. Give notice — this must NOT remove the tenant from the Active tab
    // (they're still fully active, just flagged) and must show the expected
    // vacate date on the profile.
    await page.locator('.ie-view label[for="notice-toggle"]').click();
    await page.locator('form[action$="/give-notice"] input[name="expectedVacateDate"]').fill("2026-09-30");
    await page.locator('form[action$="/give-notice"] button[title="Save"]').click();
    await page.waitForLoadState("networkidle");
    check("Giving notice shows a Notice pill with the expected vacate date", (await page.content()).includes("Notice") && (await page.content()).includes("2026-09-30"));
    await page.goto(`${BASE}/tenants?status=active`);
    await page.waitForLoadState("networkidle");
    check("A tenant on notice still appears under the Active tab (they haven't left yet)", (await page.locator(".card table tbody tr", { hasText: "Test Tenant E2E" }).count()) === 1);

    // The Dashboard's "Coming up" card should now list this tenant under On
    // notice, flagged as vacating this month (2026-09-30 is this test's "today").
    await page.goto(`${BASE}/dashboard`);
    await page.waitForLoadState("networkidle");
    const comingUpWithNotice = page.locator(".card", { has: page.locator("h2", { hasText: "Coming up" }) });
    const comingUpWithNoticeText = await comingUpWithNotice.innerText();
    check("Dashboard 'Coming up' card shows the on-notice tenant, flagged as vacating this month", comingUpWithNoticeText.includes("Test Tenant E2E") && comingUpWithNoticeText.includes("vacating this month"), comingUpWithNoticeText);

    // 18b. Cancel the notice — back to a plain Active tenant, Give notice
    // available again.
    await page.goto(testTenantProfileUrl);
    await page.waitForLoadState("networkidle");
    page.once("dialog", (d) => d.accept());
    await page.click('button:has-text("Cancel notice")');
    await page.waitForLoadState("networkidle");
    const afterCancelText = await page.content();
    check("Cancelling notice removes the Notice pill and restores the Give notice button", !afterCancelText.includes(">Notice<") && (await page.locator('.ie-view label[for="notice-toggle"]').count()) === 1);

    // 18c. Vacate — now a popover (instead of an instant submit) since it also
    // captures the deposit refund right there. Test Tenant E2E was created
    // with no deposit, so this also exercises entering a refund figure from
    // scratch rather than accepting a prefilled default.
    await page.locator('.ie-view label[for="vacate-toggle"]').click();
    await page.locator('form[action$="/vacate"] input[name="refundAmount"]').fill("5000");
    await page.locator('form[action$="/vacate"] button[title="Confirm vacate"]').click();
    await page.waitForLoadState("networkidle");
    await shot(page, "21-tenant-vacated.png");
    const vacatedProfileText = await page.content();
    check("Test tenant vacate action works", vacatedProfileText.includes("Vacated"));
    check("The deposit refund entered at vacate time shows on the Details card", vacatedProfileText.includes("5,000"));

    // 18d. Correct the refund after the fact from the Details card's own edit
    // popover — the other real gap this fixes (a refund figure decided later,
    // e.g. after a move-out inspection, previously had nowhere to go).
    const depositCard = page.locator('.card', { has: page.locator('h2', { hasText: "Details" }) });
    await depositCard.locator('label[title="Edit deposit refund"]').click();
    await depositCard.locator('form[action$="/edit-deposit-refund"] input[name="refundAmount"]').fill("4500");
    await depositCard.locator('form[action$="/edit-deposit-refund"] button[title="Save"]').click();
    await page.waitForLoadState("networkidle");
    check("Editing the deposit refund after vacating updates the figure shown", (await page.locator('.card', { has: page.locator('h2', { hasText: "Details" }) }).innerText()).includes("4,500"));

    // 18e. Once vacated, Edit/Vacate/Give notice are replaced by a Delete option
    // (both on the profile page and as an icon on the Tenants list row) —
    // deleting permanently removes the tenant's profile and billing history.
    check("A vacated tenant's profile shows a Delete button instead of Edit/Vacate/Give notice",
      (await page.locator('button:has-text("Delete")').count()) === 1 &&
      (await page.locator('a:has-text("Edit")').count()) === 0 &&
      (await page.locator('label[for="vacate-toggle"]').count()) === 0 &&
      (await page.locator('label[for="notice-toggle"]').count()) === 0);

    await page.goto(`${BASE}/tenants?status=vacated`);
    await page.waitForLoadState("networkidle");
    const vacatedRow = page.locator(".card table tbody tr", { hasText: "Test Tenant E2E" });
    check("Tenants list shows a Delete icon on a vacated tenant's row", (await vacatedRow.locator('button[title="Delete tenant"]').count()) === 1);

    await page.goto(testTenantProfileUrl);
    await page.waitForLoadState("networkidle");
    page.once("dialog", (d) => d.accept());
    await page.click('button:has-text("Delete")');
    await page.waitForLoadState("networkidle");
    // No HTTP redirect here — the delete route renders the Vacated list directly in
    // its response — so check the rendered page, not the URL (which stays at the
    // POST target). And the flash banner itself names the tenant ("<name> deleted —
    // …"), so "no longer appears" has to be scoped to an actual table row, not a
    // whole-page text search that would always find it in that banner.
    check("Deleting a vacated tenant shows a permanent-removal confirmation", (await page.content()).includes("permanently removed"));
    check("The deleted tenant no longer appears as a row in the Vacated list", (await page.locator(".card table tbody tr", { hasText: "Test Tenant E2E" }).count()) === 0);

    await page.goto(testTenantProfileUrl);
    await page.waitForLoadState("networkidle");
    check("Visiting the deleted tenant's old profile URL now 404s", (await page.content()).includes("Not found"));
    // The 404 above is a bare text response with no layout/sign-out form — back to
    // a normal page before the Logout step below, which needs the real page chrome.
    await page.goto(`${BASE}/dashboard`);
    await page.waitForLoadState("networkidle");
  }

  // 19. Logout
  await page.click('button:has-text("Sign out")').catch(async () => {
    await page.evaluate(() => {
      const f = document.querySelector('form[action="/logout"]');
      if (f) f.submit();
    });
  });
  await page.waitForLoadState("networkidle");
  check("Logout redirects to login page", page.url().includes("/login"));

  // 20. Auth guard
  await page.goto(`${BASE}/dashboard`);
  await page.waitForLoadState("networkidle");
  check("Unauthenticated access to /dashboard redirects to /login", page.url().includes("/login"));

  // 20b. "Remember me" auto-login: log in with the box checked, confirm the
  // credentials land in localStorage, then confirm a fresh visit to /login
  // auto-submits and lands on the dashboard with no typing at all.
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', "owner@pgledger.local");
  await page.fill('input[name="password"]', "change-me-123");
  await page.check("#rememberMe");
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/dashboard`);
  const stored = await page.evaluate(() => localStorage.getItem("pgledger_remember"));
  check("Remember me stores the credentials in localStorage on login", !!stored && JSON.parse(stored).email === "owner@pgledger.local");

  // Explicit sign-out revokes the remembered login (standard "remember me" convention).
  await page.click('button:has-text("Sign out")').catch(async () => {
    await page.evaluate(() => { const f = document.querySelector('form[action="/logout"]'); if (f) f.submit(); });
  });
  await page.waitForLoadState("networkidle");
  const storedAfterLogout = await page.evaluate(() => localStorage.getItem("pgledger_remember"));
  check("Signing out clears the remembered credential", storedAfterLogout === null);

  // Re-seed the stored credential manually (simulating a still-remembered device)
  // and confirm a fresh visit to /login auto-submits straight to the dashboard.
  await page.evaluate(() => localStorage.setItem("pgledger_remember", JSON.stringify({ email: "owner@pgledger.local", password: "change-me-123" })));
  await page.goto(`${BASE}/login`);
  await page.waitForURL(`${BASE}/dashboard`, { timeout: 5000 }).catch(() => {});
  check("A stored 'remember me' credential auto-submits the login form on next visit", page.url() === `${BASE}/dashboard`, page.url());

  // A failed auto-login (stale/wrong stored password) must clear localStorage
  // rather than looping forever retrying the same bad credentials.
  await page.click('button:has-text("Sign out")').catch(async () => {
    await page.evaluate(() => { const f = document.querySelector('form[action="/logout"]'); if (f) f.submit(); });
  });
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => localStorage.setItem("pgledger_remember", JSON.stringify({ email: "owner@pgledger.local", password: "wrong-password" })));
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  check("A failed auto-login attempt lands back on the login page with an error", (await page.content()).includes("Incorrect"));
  const storedAfterFail = await page.evaluate(() => localStorage.getItem("pgledger_remember"));
  check("A failed login attempt clears the stored credential (no infinite retry loop)", storedAfterFail === null);

  // Log back in — the block above this one deliberately ended on a failed login.
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  await page.fill('input[name="email"]', "owner@pgledger.local");
  await page.fill('input[name="password"]', "change-me-123");
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE}/dashboard`);

  check("Sidebar links to Users", await page.locator('.sidebar a[href="/users"]').count() === 1);

  // 21. Users — adding, listing, and removing additional owner/staff logins.
  await page.goto(`${BASE}/users`);
  await page.waitForLoadState("networkidle");
  await shot(page, "38-users-list.png");
  check("Users page loads and shows the current owner login", (await page.content()).includes("owner@pgledger.local"));

  await page.fill('form[action="/users"] input[name="name"]', "E2E Test Manager");
  await page.fill('form[action="/users"] input[name="email"]', "e2e-manager@pgledger.local");
  await page.fill('form[action="/users"] input[name="password"]', "manager123");
  await page.click('form[action="/users"] button[type="submit"]');
  await page.waitForLoadState("networkidle");
  await shot(page, "39-users-added.png");
  check("Adding a login shows it in the Users list", (await page.content()).includes("e2e-manager@pgledger.local"));

  // Duplicate email is rejected with a clear message, not a raw DB error.
  await page.fill('form[action="/users"] input[name="name"]', "Duplicate Attempt");
  await page.fill('form[action="/users"] input[name="email"]', "e2e-manager@pgledger.local");
  await page.fill('form[action="/users"] input[name="password"]', "whatever1");
  await page.click('form[action="/users"] button[type="submit"]');
  await page.waitForLoadState("networkidle");
  check("Adding a login with a duplicate email is rejected with a clear error", (await page.content()).includes("already exists"));

  // The row for the signed-in owner shows "(you)" instead of a delete icon —
  // there's no route that lets you remove the login you're currently using.
  // "(you)" renders inside a .lbl span, which CSS uppercases — compare
  // lower-cased innerText rather than the literal mixed-case string.
  const ownerRow = page.locator("table.responsive tbody tr", { hasText: "owner@pgledger.local" });
  check("The currently signed-in user's own row has no delete icon", await ownerRow.locator('button[title="Remove login"]').count() === 0 && (await ownerRow.innerText()).toLowerCase().includes("(you)"));

  const managerRow = page.locator("table.responsive tbody tr", { hasText: "e2e-manager@pgledger.local" });
  page.once("dialog", (d) => d.accept());
  await managerRow.locator('button[title="Remove login"]').click();
  await page.waitForLoadState("networkidle");
  await shot(page, "40-users-after-delete.png");
  check("Removing a login takes it out of the list", !(await page.content()).includes("e2e-manager@pgledger.local"));

  // 22. Dashboard "Coming up" — the card itself, and its two panels' labels.
  // The "vacating this month" case is already covered back in step 18a,
  // against the disposable Test Tenant E2E the notice/vacate tests create
  // and clean up there — not against real tenant data.
  await page.goto(`${BASE}/dashboard`);
  await page.waitForLoadState("networkidle");
  await shot(page, "41-dashboard-coming-up.png");
  // The panel labels render inside .lbl spans, which CSS uppercases — compare
  // lower-cased innerText rather than the literal mixed-case string.
  const comingUpCard = page.locator(".card", { has: page.locator("h2", { hasText: "Coming up" }) });
  check("Dashboard shows a 'Coming up' card", await comingUpCard.count() === 1);
  const comingUpLabelText = (await comingUpCard.innerText()).toLowerCase();
  check("'Coming up' card labels the upcoming-dues panel", comingUpLabelText.includes("dues in the next 3 days"));
  check("'Coming up' card labels the on-notice panel", comingUpLabelText.includes("on notice"));

  await ctx.close();

  // ============================== MOBILE PASS ==============================
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mpage = await mctx.newPage();
  await mpage.goto(`${BASE}/login`);
  check("Mobile: login page has no horizontal overflow", await noHOverflow(mpage));
  await login(mpage);
  await shot(mpage, "22-mobile-dashboard.png");

  check("Mobile: sidebar is hidden", !(await mpage.locator(".sidebar").isVisible()));
  check("Mobile: bottom tab bar is visible", await mpage.locator(".bottombar").isVisible());
  check("Mobile: dashboard has no horizontal overflow", await noHOverflow(mpage));

  await mpage.locator(".bbfab").click();
  await mpage.waitForLoadState("networkidle");
  await shot(mpage, "23-mobile-rent.png");
  check("Mobile: bottom-bar FAB opens Rent Collection", mpage.url().startsWith(`${BASE}/rent`));
  check("Mobile: rent table rows render as stacked cards (table head hidden)", !(await mpage.locator(".card table thead").first().isVisible()));
  check("Mobile: rent collection has no horizontal overflow", await noHOverflow(mpage));

  // Mobile card-identity treatment: the tenant name renders as a bold header at
  // the top of the card, and the now-redundant separate Room column is hidden.
  const mRentFirstRow = mpage.locator(".card table").first().locator("tbody tr").first();
  check("Mobile: rent collection card shows the tenant name as a bold header with Room hidden separately", await mRentFirstRow.locator(".card-id").isVisible() && !(await mRentFirstRow.locator("td.hide-mobile").isVisible()));

  const mOverdueRow = mpage.locator(".card table").first().locator("tbody tr", { hasText: "Overdue" }).first();
  check("Mobile: an overdue row shows Pay/Waive icons and an Edit pencil", await mOverdueRow.locator('label[title="Record a payment"]').isVisible() && await mOverdueRow.locator('label[title="Edit amount"]').isVisible());

  const mExpectedInlineEdit = mOverdueRow.locator('.inline-edit', { has: mpage.locator('label[title="Edit amount"]') });
  await mExpectedInlineEdit.locator('label[title="Edit amount"]').click();
  await shot(mpage, "24-mobile-edit-inline.png");
  check("Mobile: inline edit input appears in place on tap", await mExpectedInlineEdit.locator('.ie-form input[name="amount"]').isVisible());

  await mOverdueRow.locator('label[title="Cancel"]').first().click();
  await mOverdueRow.locator('label[title="Record a payment"]').click();
  await shot(mpage, "25-mobile-pay-popover.png");
  check("Mobile: Pay popover opens without breaking the layout", await mOverdueRow.locator('.ie-form.popover select[name="mode"]').isVisible());
  // Scoped to .ie-form.popover specifically — the Expected cell's Edit-amount
  // inline-edit also has a (currently hidden) "Cancel" label with the same
  // title, and an unscoped locator would resolve to that invisible one instead.
  await mOverdueRow.locator('.ie-form.popover label[title="Cancel"]').first().click();

  // Floors & Rooms — the "+ Add room" / "+ Add floor" details-popovers reflow
  // inline (not absolutely positioned), so they should never cause overflow.
  await mpage.goto(`${BASE}/floors`);
  await mpage.waitForLoadState("networkidle");
  await shot(mpage, "27-mobile-floors.png");
  check("Mobile: floors page has no horizontal overflow", await noHOverflow(mpage));
  check("Mobile: floor room tables render as stacked cards", !(await mpage.locator(".card table thead").first().isVisible()));
  await mpage.locator("summary", { hasText: "Add room" }).first().click();
  await shot(mpage, "28-mobile-add-room-open.png");
  check("Mobile: 'Add room' form opens without causing overflow", await noHOverflow(mpage));

  // Tenants list + a tenant profile (with the new icon-based Void action)
  await mpage.goto(`${BASE}/tenants`);
  await mpage.waitForLoadState("networkidle");
  await shot(mpage, "29-mobile-tenants.png");
  check("Mobile: tenants list has no horizontal overflow", await noHOverflow(mpage));
  check("Mobile: tenants list renders as stacked cards", !(await mpage.locator(".card table thead").first().isVisible()));
  const mTenantFirstRow = mpage.locator(".card table").first().locator("tbody tr").first();
  check("Mobile: tenants list card shows the tenant name as a bold header with Room hidden separately", await mTenantFirstRow.locator(".card-id").isVisible() && !(await mTenantFirstRow.locator("td.hide-mobile").isVisible()));

  await mpage.goto(`${BASE}${tenantProfileHref}`);
  await mpage.waitForLoadState("networkidle");
  await shot(mpage, "30-mobile-tenant-profile.png");
  check("Mobile: tenant profile has no horizontal overflow", await noHOverflow(mpage));
  const mVoidRow = mpage.locator("table.responsive tbody tr", { has: mpage.locator('label[title="Void this payment"]') }).first();
  if (await mVoidRow.count() > 0) {
    await mVoidRow.locator('label[title="Void this payment"]').click();
    await shot(mpage, "31-mobile-void-popover.png");
    check("Mobile: Void popover opens in place without overflow", await mVoidRow.locator('form[action$="/void"] input[name="reason"]').isVisible() && await noHOverflow(mpage));
    await mVoidRow.locator('form[action$="/void"] label[title="Cancel"]').first().click();
  }

  // Accounts + account detail
  await mpage.goto(`${BASE}/accounts`);
  await mpage.waitForLoadState("networkidle");
  await shot(mpage, "32-mobile-accounts.png");
  check("Mobile: accounts page has no horizontal overflow", await noHOverflow(mpage));
  await mpage.locator("a:has-text('view transactions')").first().click();
  await mpage.waitForLoadState("networkidle");
  check("Mobile: account detail page has no horizontal overflow", await noHOverflow(mpage));
  check("Mobile: account transactions render as stacked cards", !(await mpage.locator(".card table thead").first().isVisible()));

  // Expenses — including opening the "Log an expense" form
  await mpage.goto(`${BASE}/expenses`);
  await mpage.waitForLoadState("networkidle");
  check("Mobile: expenses page has no horizontal overflow", await noHOverflow(mpage));
  await mpage.locator("summary", { hasText: "Log an expense" }).click();
  await shot(mpage, "33-mobile-log-expense-open.png");
  check("Mobile: 'Log an expense' form opens without causing overflow", await noHOverflow(mpage));

  // Pages side drawer: opened from the bottom bar's "More" item — a full
  // slide-in panel listing every page, not just a small popover.
  await mpage.goto(`${BASE}/dashboard`);
  await mpage.waitForLoadState("networkidle");
  check("Mobile: drawer is closed by default", !(await mpage.locator("#pages-drawer").isChecked()));
  await mpage.locator('label[for="pages-drawer"].bbitem').click();
  // Wait out the CSS slide-in transition (or a short timeout) before asserting position.
  await mpage.locator(".drawer-panel").evaluate((el) => new Promise((res) => {
    el.addEventListener("transitionend", res, { once: true });
    setTimeout(res, 500);
  }));
  await shot(mpage, "26-mobile-drawer-open.png");
  check("Mobile: 'More' opens the full pages drawer listing all 6 pages", await mpage.locator(".drawer-item").count() === 6 && await mpage.locator(".drawer-panel").isVisible());
  check("Mobile: drawer highlights the current page (Dashboard)", (await mpage.locator(".drawer-item.active").innerText()).includes("Dashboard"));

  await mpage.locator(".drawer-item", { hasText: "Expenses" }).click();
  await mpage.waitForLoadState("networkidle");
  check("Mobile: clicking a drawer item navigates to that page", mpage.url().includes("/expenses"));

  // The dark overlay behind the drawer also closes it (a label pointing at
  // the same checkbox) — verify tapping it lands back on a closed drawer.
  await mpage.locator('label[for="pages-drawer"].bbitem').click();
  await mpage.locator(".drawer-panel").evaluate((el) => new Promise((res) => {
    el.addEventListener("transitionend", res, { once: true });
    setTimeout(res, 500);
  }));
  await mpage.locator(".drawer-overlay").click({ position: { x: 10, y: 10 }, force: true });
  await mpage.locator(".drawer-panel").evaluate((el) => new Promise((res) => {
    el.addEventListener("transitionend", res, { once: true });
    setTimeout(res, 500);
  }));
  check("Mobile: tapping the dark overlay closes the drawer again", !(await mpage.locator("#pages-drawer").isChecked()));

  // The new Users link lives in the drawer footer, not the drawer-item list
  // itself (kept the 6-page drawer test above untouched) — confirm it's
  // there, then a quick overflow pass on the Users page itself.
  await mpage.locator('label[for="pages-drawer"].bbitem').click();
  await mpage.locator(".drawer-panel").evaluate((el) => new Promise((res) => {
    el.addEventListener("transitionend", res, { once: true });
    setTimeout(res, 500);
  }));
  check("Mobile: drawer footer links to Users", await mpage.locator('.drawer-foot a[href="/users"]').count() === 1);
  await mpage.locator(".drawer-overlay").click({ position: { x: 10, y: 10 }, force: true });

  await mpage.goto(`${BASE}/users`);
  await mpage.waitForLoadState("networkidle");
  await shot(mpage, "43-mobile-users.png");
  check("Mobile: Users page has no horizontal overflow", await noHOverflow(mpage));

  await mctx.close();
  await browser.close();

  console.log("\n===== SUMMARY =====");
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} checks passed`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.log("FAILED CHECKS:");
    for (const f of failed) console.log(" - " + f.name + (f.detail ? ` :: ${f.detail}` : ""));
    process.exitCode = 1;
  }
})();

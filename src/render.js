export function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 5 -> "5th", 1 -> "1st", 22 -> "22nd" — used for a tenant's rent due day.
export function ordinal(n) {
  n = Number(n);
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Indian digit grouping: 1,23,456
export function money(n) {
  const num = Math.round(Number(n) || 0);
  const neg = num < 0;
  let s = String(Math.abs(num));
  let last3 = s.slice(-3);
  let rest = s.slice(0, -3);
  if (rest !== "") last3 = "," + last3;
  rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return (neg ? "-₹" : "₹") + rest + last3;
}

export function pill(label, kind) {
  const map = { good: ["var(--good-tint)", "var(--good)"], warn: ["var(--warn-tint)", "var(--warn)"], bad: ["var(--bad-tint)", "var(--bad)"], neutral: ["var(--surface-2)", "var(--ink-soft)"] };
  const [bg, fg] = map[kind] || map.neutral;
  return `<span class="pill" style="background:${bg};color:${fg};">${escapeHtml(label)}</span>`;
}

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/floors", label: "Floors & Rooms" },
  { href: "/tenants", label: "Tenants" },
  { href: "/rent", label: "Rent Collection" },
  { href: "/accounts", label: "Accounts" },
  { href: "/expenses", label: "Expenses" },
];

const ICONS = {
  "/dashboard": '<rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.2"/>',
  "/floors": '<path d="M3 21V9l9-6 9 6v12"/><path d="M9 21v-8h6v8"/>',
  "/tenants": '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17.3" cy="9" r="2.3"/><path d="M15.6 14.2c2.4.5 4.1 2.5 4.6 5.8"/>',
  "/rent": '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/>',
  "/accounts": '<path d="M4 7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v2h-3a3 3 0 0 0 0 6h3v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="16.3" cy="12" r="0.9" fill="currentColor" stroke="none"/>',
  "/expenses": '<path d="M6 3h12v18l-2.5-1.6L13 21l-2.5-1.6L8 21l-2-18Z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
};

const MORE_ICON = '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>';

function svgIcon(path, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

// Small line-icon set for the row-level action buttons on Rent Collection
// (Record payment, Waive, Edit amount, Reinstate, Cancel, Save, view history).
export const ICON = {
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>',
  pay: '<rect x="2.5" y="6" width="19" height="13" rx="2.2"/><path d="M2.5 10.5h19"/><path d="M6.5 15h3.5"/>',
  waive: '<circle cx="12" cy="12" r="9"/><path d="M5.5 5.5l13 13"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5l3.2 2"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
};

export function icon(path, size = 15) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

// A payment row's "Void" action — the icon-btn + checkbox-hack popover used
// on the Rent Collection pages (chargeDetailPage) and the tenant profile's
// payment history table, so both places share one consistent, icon-based
// interaction instead of a plain text button. `redirectTo` sends the owner
// back to whichever page they voided from.
export function voidPaymentCell(p, { tenantId, redirectTo }) {
  if (p.status === "voided") return "";
  const cb = `void-${p.id}`;
  return `
    <div class="inline-edit">
      <input type="checkbox" id="${cb}" class="ie-toggle">
      <span class="ie-view"><label for="${cb}" class="icon-btn bad" title="Void this payment">${icon(ICON.x, 13)}</label></span>
      <form method="post" action="/payments/${p.id}/void" class="ie-form popover">
        <input type="hidden" name="tenantId" value="${tenantId}">
        <input type="hidden" name="redirectTo" value="${redirectTo}">
        <label class="field"><span>Reason</span><input name="reason" placeholder="e.g. cheque bounced"></label>
        <div class="popover-actions">
          <button type="submit" class="icon-btn bad" title="Confirm void">${icon(ICON.check, 13)}</button>
          <label for="${cb}" class="icon-btn ghost" title="Cancel">${icon(ICON.x, 13)}</label>
        </div>
      </form>
    </div>`;
}

// An "Edit this payment" action — mirrors voidPaymentCell's checkbox-hack
// popover, but the form lets the owner correct the amount, account or mode.
// Since editPayment() only ever touches the one payment row passed in, this
// only affects that single leg — if the tenant paid across two accounts,
// the other payment (a separate row) is left completely alone.
export function editPaymentCell(p, accounts, { tenantId, redirectTo }) {
  if (p.status === "voided") return "";
  const cb = `editpay-${p.id}`;
  const acctOptions = accounts.map((a) => `<option value="${a.id}"${Number(a.id) === Number(p.account_id) ? " selected" : ""}>${escapeHtml(a.name)}</option>`).join("");
  const modes = [["upi", "UPI"], ["cash", "Cash"], ["bank_transfer", "Bank transfer"], ["cheque", "Cheque"]]
    .map(([v, label]) => `<option value="${v}"${v === p.mode ? " selected" : ""}>${label}</option>`).join("");
  return `
    <div class="inline-edit">
      <input type="checkbox" id="${cb}" class="ie-toggle">
      <span class="ie-view"><label for="${cb}" class="icon-btn" title="Edit this payment">${icon(ICON.pencil, 13)}</label></span>
      <form method="post" action="/payments/${p.id}/edit" class="ie-form popover">
        <input type="hidden" name="tenantId" value="${tenantId}">
        <input type="hidden" name="redirectTo" value="${redirectTo}">
        <label class="field"><span>Amount</span><input type="number" name="amount" value="${p.amount}" required></label>
        <label class="field"><span>Account</span><select name="accountId">${acctOptions}</select></label>
        <label class="field"><span>Mode</span><select name="mode">${modes}</select></label>
        <label class="field"><span>Reason (optional)</span><input name="reason" placeholder="e.g. wrong account picked"></label>
        <div class="popover-actions">
          <button type="submit" class="icon-btn good" title="Save">${icon(ICON.check, 13)}</button>
          <label for="${cb}" class="icon-btn ghost" title="Cancel">${icon(ICON.x, 13)}</label>
        </div>
      </form>
    </div>`;
}

// Builds a wa.me deep link from a stored phone number — strips everything
// but digits, and assumes a bare 10-digit number is Indian (every phone
// number in this app is) by prefixing the 91 country code.
export function waLink(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits.length === 10 ? "91" + digits : digits}`;
}

const WHATSAPP_ICON_PATH = '<path d="M20.5 11.5c0 4.7-3.8 8.5-8.5 8.5-1.5 0-2.9-.4-4.1-1.1L3 20l1.2-4.7A8.5 8.5 0 1 1 20.5 11.5Z"/><path d="M8.5 9c.2-.5.4-.7.9-.7h.6c.3 0 .5.1.6.4.2.5.6 1.5.7 1.7.1.2.1.4 0 .6-.1.2-.2.3-.4.5-.2.2-.3.3-.1.6.3.5 1 1.4 1.9 2.1 1.1.9 2 1.2 2.4 1.4.3.1.5.1.7-.1.2-.2.6-.7.8-1 .2-.2.4-.2.6-.1l1.5.7c.2.1.4.2.4.4.1.4 0 1-.3 1.5-.4.6-1.4 1-2.1 1-.6 0-2-.2-3.9-1.7-2.2-1.8-2.9-3.7-3-4.2-.1-.3-.5-1.1-.5-1.7 0-.5.2-.9.4-1.1Z"/>';

// A small green WhatsApp icon next to a phone number — opens a wa.me chat
// in a new tab. Renders nothing if there's no usable phone number on file.
export function whatsappLink(phone) {
  const href = waLink(phone);
  if (!href) return "";
  return `<a href="${href}" target="_blank" rel="noopener" class="icon-btn wa" title="Message on WhatsApp" style="margin-left:6px;">${icon(WHATSAPP_ICON_PATH, 14)}</a>`;
}

// The mobile bottom tab bar — hidden on desktop (see BASE_CSS), shown in its
// place once the sidebar hides below the mobile breakpoint. Rent Collection
// (the action the owner uses most day-to-day) gets the raised center FAB.
// "More" no longer opens a small floating popover — it opens the full pages
// side drawer (see pagesDrawer below), the same list of pages the desktop
// sidebar shows.
function bottomBar(active) {
  const moreActive = active === "/floors" || active === "/expenses";
  return `
  <nav class="bottombar">
    <a class="bbitem${active === "/dashboard" ? " active" : ""}" href="/dashboard">${svgIcon(ICONS["/dashboard"])}<span>Home</span></a>
    <a class="bbitem${active === "/tenants" ? " active" : ""}" href="/tenants">${svgIcon(ICONS["/tenants"])}<span>Tenants</span></a>
    <a class="bbfab" href="/rent" aria-label="Rent Collection">${svgIcon(ICONS["/rent"], 22).replace('stroke="currentColor"', 'stroke="#fff"')}</a>
    <a class="bbitem${active === "/accounts" ? " active" : ""}" href="/accounts">${svgIcon(ICONS["/accounts"])}<span>Accounts</span></a>
    <label for="pages-drawer" class="bbitem${moreActive ? " active" : ""}">${svgIcon(MORE_ICON)}<span>More</span></label>
  </nav>`;
}

// The mobile "pages" side drawer — a full slide-in panel (from the right)
// listing every page, the same list the desktop sidebar shows, plus Sign
// out. Opened from the bottom bar's "More" item, or directly by checking
// the #pages-drawer checkbox. Built on the checkbox-hack (see BASE_CSS's
// .drawer-* rules): the hidden checkbox holds the open/closed state, a
// <label for="pages-drawer"> anywhere (the "More" tab, the dark overlay,
// the ✕ close icon) toggles it, and CSS transitions slide the panel in —
// no JavaScript. Hidden outright on desktop, where the sidebar is already
// always visible.
function pagesDrawer(active, user) {
  const items = NAV.map((item) => {
    const isActive = item.href === active;
    return `<a class="drawer-item${isActive ? " active" : ""}" href="${item.href}">${svgIcon(ICONS[item.href], 18)}${escapeHtml(item.label)}</a>`;
  }).join("\n");
  return `
  <input type="checkbox" id="pages-drawer" class="drawer-toggle">
  <label for="pages-drawer" class="drawer-overlay" aria-hidden="true"></label>
  <div class="drawer-panel">
    <div class="drawer-head">
      <span style="font-weight:700;font-size:14.5px;">Pages</span>
      <label for="pages-drawer" class="icon-btn ghost" title="Close">${icon(ICON.x, 16)}</label>
    </div>
    <div class="drawer-items">${items}</div>
    <div class="drawer-foot">
      <div style="font-size:12px;font-weight:600;color:var(--ink-soft);margin-bottom:8px;">${escapeHtml(user ? user.name : "")}</div>
      <div style="display:flex;gap:14px;margin-bottom:10px;">
        <a href="/users" style="font-size:12.5px;color:var(--ink-soft);">Users</a>
      </div>
      <form method="post" action="/logout" onsubmit="try{localStorage.removeItem('pgledger_remember');}catch(e){}"><button type="submit" class="linkbtn">Sign out</button></form>
    </div>
  </div>`;
}

export function layout({ title, active, user, body, flash }) {
  const navHtml = NAV.map((item) => {
    const isActive = item.href === active;
    return `<a class="navitem${isActive ? " active" : ""}" href="${item.href}">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[item.href]}</svg>
      ${escapeHtml(item.label)}
    </a>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · PG Ledger</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>${BASE_CSS}</style>
</head>
<body class="ledger-root">
<div style="display:flex;min-height:100vh;">
  <div class="sidebar">
    <div style="display:flex;align-items:center;gap:9px;padding:0 6px;">
      <div style="width:26px;height:26px;border-radius:6px;background:var(--accent);display:flex;align-items:center;justify-content:center;">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9"/></svg>
      </div>
      <span style="font-weight:700;font-size:14.5px;">PG Ledger</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:2px;margin-top:22px;">${navHtml}</div>
    <div style="margin-top:auto;padding:10px 6px;border-top:1px solid var(--line);">
      <div style="font-size:12px;font-weight:600;">${escapeHtml(user ? user.name : "")}</div>
      <div style="display:flex;gap:10px;margin-top:6px;">
        <a href="/users" style="font-size:11.5px;color:var(--ink-soft);text-decoration:none;">Users</a>
      </div>
      <form method="post" action="/logout" style="margin-top:6px;" onsubmit="try{localStorage.removeItem('pgledger_remember');}catch(e){}">
        <button type="submit" class="linkbtn">Sign out</button>
      </form>
    </div>
  </div>
  <div class="main">
    ${flash ? `<div class="flash ${flash.kind || "good"}">${escapeHtml(flash.text)}</div>` : ""}
    ${body}
  </div>
</div>
${bottomBar(active)}
${pagesDrawer(active, user)}
</body>
</html>`;
}

export function loginPage({ error } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · PG Ledger</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>${BASE_CSS}
  .loginwrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
  .loginbox{width:340px;max-width:100%;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:32px 28px;}
  @media (max-width:400px) { .loginbox{padding:26px 20px;} }
</style>
</head>
<body class="ledger-root">
  <div class="loginwrap">
    <div class="loginbox">
      <div style="display:flex;align-items:center;gap:9px;margin-bottom:22px;">
        <div style="width:28px;height:28px;border-radius:7px;background:var(--accent);display:flex;align-items:center;justify-content:center;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9"/></svg>
        </div>
        <span style="font-weight:700;font-size:16px;">PG Ledger</span>
      </div>
      ${error ? `<div class="flash bad" style="margin-bottom:14px;">${escapeHtml(error)}</div>` : ""}
      <form method="post" action="/login" id="loginForm" style="display:flex;flex-direction:column;gap:12px;">
        <label class="field"><span>Email</span><input type="email" name="email" id="loginEmail" required autofocus></label>
        <label class="field"><span>Password</span><input type="password" name="password" id="loginPassword" required></label>
        <label style="display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;color:var(--ink-soft);">
          <input type="checkbox" name="remember" id="rememberMe" style="width:auto;"> Remember me on this device
        </label>
        <button type="submit" class="btn primary" style="margin-top:6px;">Sign in</button>
      </form>
    </div>
  </div>
  <script>
    (function () {
      var KEY = 'pgledger_remember';
      var hadError = ${error ? "true" : "false"};
      var form = document.getElementById('loginForm');
      var emailEl = document.getElementById('loginEmail');
      var passEl = document.getElementById('loginPassword');
      var rememberEl = document.getElementById('rememberMe');
      try {
        if (hadError) {
          // A login attempt (auto or manual) just failed — clear whatever's
          // stored so we don't loop retrying the same bad credentials.
          localStorage.removeItem(KEY);
        } else {
          var saved = localStorage.getItem(KEY);
          if (saved) {
            var creds = JSON.parse(saved);
            if (creds && creds.email && creds.password) {
              emailEl.value = creds.email;
              passEl.value = creds.password;
              rememberEl.checked = true;
              form.submit();
            }
          }
        }
      } catch (e) {}
      form.addEventListener('submit', function () {
        try {
          if (rememberEl.checked) {
            localStorage.setItem(KEY, JSON.stringify({ email: emailEl.value, password: passEl.value }));
          } else {
            localStorage.removeItem(KEY);
          }
        } catch (e) {}
      });
    })();
  </script>
</body>
</html>`;
}

export const BASE_CSS = `
  * { box-sizing: border-box; }
  html, body { margin:0; }
  .ledger-root { --bg:#F1EFE6; --surface:#FFFFFF; --surface-2:#E9E5D7; --line:#DBD5C3;
    --ink:#20261F; --ink-soft:#5B6259; --ink-faint:#8A9088;
    --accent:#12664D; --accent-tint:#DEEAE1;
    --good:#1F7A4C; --good-tint:#E1F0E6; --warn:#96650E; --warn-tint:#F2E7CF; --bad:#A6402F; --bad-tint:#F5E1DD;
    font-family:'IBM Plex Sans',system-ui,sans-serif; color:var(--ink); background:var(--bg); }
  .mono { font-family:'IBM Plex Mono',ui-monospace,monospace; font-variant-numeric:tabular-nums; }
  a { color: var(--accent); }
  .sidebar { width:224px; flex-shrink:0; background:var(--surface); border-right:1px solid var(--line); display:flex; flex-direction:column; padding:22px 16px; position:sticky; top:0; height:100vh; }
  .main { flex:1; padding:30px 36px; min-width:0; }
  .navitem { display:flex; align-items:center; gap:10px; padding:9px 12px; border-radius:8px; color:var(--ink-soft); font-size:13.5px; font-weight:500; text-decoration:none; }
  .navitem.active { background:var(--accent-tint); color:var(--accent); font-weight:600; }
  .navitem svg { flex-shrink:0; }
  .card { background:var(--surface); border:1px solid var(--line); border-radius:10px; }
  .lbl { font-family:'IBM Plex Mono'; font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-faint); }
  .pill { display:inline-flex; align-items:center; padding:2px 9px; border-radius:99px; font-size:11px; font-weight:600; white-space:nowrap; }
  .barbg { height:5px; border-radius:3px; background:var(--surface-2); overflow:hidden; }
  .barfill { height:100%; border-radius:3px; }
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:9px 14px; border-radius:8px; border:1px solid var(--line); background:var(--surface); color:var(--ink); font-size:13px; font-weight:600; cursor:pointer; text-decoration:none; font-family:inherit; }
  .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .btn.small { padding:5px 10px; font-size:12px; }
  .btn.danger { color:var(--bad); border-color:var(--bad); background:var(--bad-tint); }
  .linkbtn { background:none; border:none; padding:0; color:var(--ink-soft); font-size:12px; text-decoration:underline; cursor:pointer; font-family:inherit; }
  table { border-collapse:collapse; width:100%; font-size:13.5px; }
  th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:middle; }
  th { font-family:'IBM Plex Mono'; font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint); font-weight:600; }
  td.num, th.num { text-align:right; font-family:'IBM Plex Mono'; }
  tbody tr:hover { background:var(--surface-2); }
  .field { display:flex; flex-direction:column; gap:5px; font-size:12.5px; font-weight:600; color:var(--ink-soft); }
  .field input, .field select, .field textarea { font-family:inherit; font-size:14px; padding:8px 10px; border:1px solid var(--line); border-radius:7px; background:var(--surface); color:var(--ink); }
  .field textarea { resize:vertical; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px; }
  .grid4 { display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:14px; }
  .stack-row { display:flex; gap:18px; align-items:flex-start; }
  .flash { padding:10px 14px; border-radius:8px; margin-bottom:16px; font-size:13px; font-weight:600; }
  .flash.good { background:var(--good-tint); color:var(--good); }
  .flash.bad { background:var(--bad-tint); color:var(--bad); }
  h1 { font-size:21px; font-weight:700; margin:0; }
  h2 { font-size:15px; font-weight:600; margin:0 0 12px; }
  .toolbar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:22px; }
  .tabs { display:flex; gap:4px; margin-bottom:16px; flex-wrap:wrap; }
  .tabs a { padding:7px 13px; border-radius:7px; font-size:13px; font-weight:600; text-decoration:none; color:var(--ink-soft); border:1px solid var(--line); background:var(--surface); }
  .tabs a.active { background:var(--accent); border-color:var(--accent); color:#fff; }

  /* ---- Mobile bottom tab bar (hidden on desktop; see the media query below) ---- */
  .bottombar { display:none; position:fixed; left:0; right:0; bottom:0; height:64px; background:var(--surface);
    border-top:1px solid var(--line); align-items:center; justify-content:space-around; padding:0 4px;
    padding-bottom:env(safe-area-inset-bottom); z-index:40; }
  .bbitem { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
    color:var(--ink-faint); font-size:10.5px; font-weight:600; text-decoration:none; flex:1; height:100%;
    padding:6px 2px; cursor:pointer; list-style:none; }
  .bbitem::-webkit-details-marker { display:none; }
  .bbitem.active { color:var(--accent); }
  .bbfab { display:flex; align-items:center; justify-content:center; width:52px; height:52px; border-radius:50%;
    background:var(--accent); box-shadow:0 4px 10px rgba(18,102,77,.35); margin-top:-30px; flex-shrink:0; }
  /* ---- Mobile "pages" side drawer — a full slide-in panel, opened from the
     bottom bar's "More" item. Checkbox-hack again: #pages-drawer holds the
     open/closed state, and any <label for="pages-drawer"> toggles it. Both
     the overlay and the panel are display:none by default (including on
     desktop, where the sidebar already covers this) and only switch to
     flex/block under the mobile breakpoint below. ---- */
  .drawer-toggle { display:none; }
  .drawer-overlay { display:none; position:fixed; inset:0; background:rgba(20,24,19,.45); z-index:50;
    opacity:0; pointer-events:none; transition:opacity .2s ease; }
  .drawer-panel { display:none; position:fixed; top:0; right:0; bottom:0; width:80%; max-width:300px;
    background:var(--surface); z-index:51; flex-direction:column; padding:18px 16px;
    padding-bottom:calc(18px + env(safe-area-inset-bottom)); box-shadow:-8px 0 24px rgba(0,0,0,.18);
    transform:translateX(100%); transition:transform .25s ease; overflow-y:auto; }
  .drawer-toggle:checked ~ .drawer-overlay { opacity:1; pointer-events:auto; }
  .drawer-toggle:checked ~ .drawer-panel { transform:translateX(0); }
  .drawer-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:18px; }
  .drawer-items { display:flex; flex-direction:column; gap:2px; }
  .drawer-item { display:flex; align-items:center; gap:12px; padding:11px 12px; border-radius:8px;
    color:var(--ink-soft); font-size:14px; font-weight:500; text-decoration:none; }
  .drawer-item.active { background:var(--accent-tint); color:var(--accent); font-weight:600; }
  .drawer-foot { margin-top:auto; padding-top:14px; border-top:1px solid var(--line); }

  /* ---- Row-level icon actions + true inline field editing, zero JavaScript.
     Built on the "checkbox hack": a hidden checkbox + a <label for> that toggles
     it is how the pencil/pay/waive icons open their form, and the Cancel button
     is just a second <label> pointing at the same checkbox id, which closes it
     again. ---- */
  .icon-btn { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px;
    border-radius:6px; border:1px solid var(--line); background:var(--surface); color:var(--ink-soft);
    cursor:pointer; flex-shrink:0; font-family:inherit; }
  .icon-btn:hover { background:var(--surface-2); }
  .icon-btn.good { color:var(--good); border-color:var(--good); background:var(--good-tint); }
  .icon-btn.bad { color:var(--bad); border-color:var(--bad); background:var(--bad-tint); }
  .icon-btn.ghost { border-color:transparent; background:transparent; }
  .icon-btn.wa { color:#1DA851; border-color:#BFE6CC; background:#EAF9EF; }
  .row-actions { display:flex; align-items:center; gap:6px; }

  /* ---- Mobile card "identity" treatment: on the Tenants and Rent Collection
     tables, the tenant name is the field that most needs to jump out on a
     stacked mobile card, with the room folded in underneath as a subtitle —
     so a glance at the top of a card says whose card it is, at a size and
     weight the other fields don't compete with. .hide-mobile then drops the
     now-redundant separate Room column on narrow screens only. ---- */
  .card-id { font-weight:700; font-size:14.5px; color:var(--ink); }
  .card-id-sub { display:none; font-size:11.5px; font-weight:500; color:var(--ink-faint); margin-top:1px; }

  .inline-edit { position:relative; display:inline-block; }
  .inline-edit .ie-toggle { display:none; }
  .ie-view { display:flex; align-items:center; gap:6px; }
  .ie-form { display:none; align-items:center; gap:6px; }
  .ie-toggle:checked ~ .ie-view { display:none; }
  .ie-toggle:checked ~ .ie-form { display:flex; }
  .ie-input { width:88px; padding:5px 7px; border:1px solid var(--line); border-radius:6px; font-family:inherit; font-size:13px; }
  .ie-form.popover { display:none; position:absolute; top:calc(100% + 6px); right:0; z-index:30;
    flex-direction:column; align-items:stretch; gap:10px; background:var(--surface); border:1px solid var(--line);
    border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.15); padding:14px; width:225px; }
  .ie-toggle:checked ~ .ie-form.popover { display:flex; }
  .ie-form.popover .field { gap:4px; }
  .ie-form.popover .field span { font-size:11px; }
  .ie-form.popover .field input, .ie-form.popover .field select { font-size:13px; padding:6px 8px; }
  .popover-actions { display:flex; gap:8px; justify-content:flex-end; }

  .acct-dropdown summary { cursor:pointer; list-style:none; display:inline-flex; align-items:center; gap:3px; }
  .acct-dropdown summary::-webkit-details-marker { display:none; }
  .acct-breakdown { margin-top:6px; padding:8px 10px; background:var(--surface-2); border-radius:7px;
    display:flex; flex-direction:column; gap:4px; font-size:12px; text-align:left; }
  .acct-breakdown .acct-row { display:flex; justify-content:space-between; gap:14px; }

  .tenant-cards { display:none; }
  /* ---- Responsive tables: data-label + display:block turns rows into stacked
     cards on narrow screens, no JavaScript involved. ---- */
  @media (max-width: 700px) {
    table.responsive thead { display:none; }
    table.responsive, table.responsive tbody, table.responsive tfoot, table.responsive tr, table.responsive td { display:block; width:100%; }
    table.responsive tr { border:1px solid var(--line); border-radius:8px; margin:10px 0; }
    table.responsive td { display:flex; justify-content:space-between; align-items:center; gap:12px;
      padding:9px 12px; border-bottom:1px solid var(--surface-2); text-align:right; }
    table.responsive td:last-child { border-bottom:none; }
    table.responsive td::before { content: attr(data-label); font-family:'IBM Plex Mono'; font-size:10.5px;
      letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint); font-weight:600; text-align:left; }
    table.responsive td[data-label=""]::before { content:none; }
    table.responsive td.hide-mobile { display:none !important; }
    table.responsive td.card-id-cell { display:block; text-align:left; padding-bottom:6px; }
    table.responsive td.card-id-cell::before { content:none; }
    table.responsive .card-id { display:block; font-size:15.5px; }
    table.responsive .card-id-sub { display:block; }
    table.responsive td .barbg { flex:1; min-width:90px; margin-left:14px; }
    /* Bigger tap targets once we're on a touch-sized viewport — 26px icon
       buttons are fine for a mouse pointer but tight for a fingertip. */
    .icon-btn { width:32px; height:32px; }
    .row-actions { gap:8px; }

    /* ---- Edit/pay/waive/vacate popovers become a centered modal sheet on
       phones instead of a small anchored popover. Anchored to the trigger's
       position, the popover used to render off to the side of (or below) a
       card — on a short viewport like a phone that regularly pushed its Save/
       Cancel buttons past the bottom of the screen or under the fixed bottom
       tab bar, making it look like editing silently did nothing. Centering it
       as a fixed-position sheet, above the tab bar and side drawer (z-index),
       with its own scroll for a tall form, keeps every field and both action
       buttons reachable regardless of where on the page it was opened from. */
    .ie-form.popover { position:fixed !important; top:50% !important; left:50% !important; right:auto !important;
      transform:translate(-50%,-50%) !important; width:calc(100% - 40px) !important; max-width:340px !important;
      max-height:80vh; overflow-y:auto; z-index:120; box-shadow:0 12px 40px rgba(0,0,0,.28); }
    /* Dimmed backdrop behind the open sheet — CSS-only (:has, no JS): the
       pseudo-element covers the viewport so the sheet reads as a modal, not
       another in-page element. Browsers without :has() just skip the dimming;
       the sheet itself still centers and scrolls correctly. */
    .inline-edit:has(.ie-toggle:checked)::before { content:""; position:fixed; inset:0;
      background:rgba(20,24,19,.45); z-index:119; }

    /* ---- Compact tenant list for mobile: the regular responsive table
       turns each tenant into a 6-line stacked card (name, room, phone, rent,
       joined, status), so only one or two tenants fit on screen at once.
       .tenant-cards replaces that with a dense two-line-per-tenant list —
       name + status on one line, room/rent on the next — so a phone screen
       shows many tenants at a glance, same as scanning a desktop table; a
       tap still opens the full profile for anything not shown here. ---- */
    .tenant-table-wrap { display:none; }
    .tenant-cards { display:flex; flex-direction:column; }
    .tcard { display:flex; flex-direction:column; gap:3px; padding:11px 2px; border-bottom:1px solid var(--surface-2); }
    .tcard:last-child { border-bottom:none; }
    .tcard-row1 { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .tcard-name { font-weight:700; font-size:14.5px; color:var(--ink); text-decoration:none; }
    .tcard-row2 { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px;
      color:var(--ink-soft); text-decoration:none; }
  }

  @media (max-width: 860px) {
    .sidebar { display:none; }
    .main { padding:16px 14px 96px; }
    .bottombar { display:flex; }
    .drawer-overlay { display:block; }
    .drawer-panel { display:flex; }
    .grid2, .grid3 { grid-template-columns: 1fr; }
    .grid4 { grid-template-columns: repeat(2, 1fr); }
    .stack-row { flex-direction:column; }
    .stack-row > * { width:100%; }

    /* ---- Filter chip rows (status tabs, floor tabs): on desktop these wrap
       to a second/third row when there are many floors, which is fine with
       room to spare. On a phone that wrapping ate a huge chunk of the
       screen before a single tenant was visible — scrolling the row
       horizontally instead keeps every filter one tap away in a single
       compact line. ---- */
    .tabs { flex-wrap:nowrap; overflow-x:auto; -webkit-overflow-scrolling:touch; scrollbar-width:none; margin-bottom:10px; padding-bottom:2px; }
    .tabs::-webkit-scrollbar { display:none; }
    .tabs a { flex-shrink:0; }
  }
  @media (min-width: 861px) and (max-width: 1080px) {
    .grid3, .grid4 { grid-template-columns: repeat(2, 1fr); }
  }
`;

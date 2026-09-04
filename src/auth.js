import crypto from "node:crypto";
import { query, one, lit } from "./db.js";

const SCRYPT_KEYLEN = 64;
const SESSION_DAYS = 30;

// ---------- Login rate-limiting ----------
// A single-owner app still shouldn't allow unlimited password guesses once
// it's reachable from the internet (the Oracle Cloud move). This is
// deliberately simple: an in-memory map, keyed by the email being attempted
// (case-insensitive) — after MAX_ATTEMPTS wrong passwords in a row for one
// email, that email is locked out for LOCKOUT_MS. A correct login clears its
// counter. Guessing against emails that don't exist never locks anything
// (each gets its own near-empty counter), which is fine — the real target is
// brute-forcing the password once the owner's one real email is known.
// In-memory means this resets on every server restart; acceptable for a
// single-process app with no hot reload anyway, and avoids adding a table
// (and DB round-trips on every keystroke of a guess) for something this small.
const FAILED_LOGINS = new Map(); // normalized email -> { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function loginLockStatus(email) {
  const rec = FAILED_LOGINS.get(normEmail(email));
  if (rec && rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return { locked: true, retryAfterSeconds: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
  }
  return { locked: false };
}

function recordFailedLogin(email) {
  const key = normEmail(email);
  const rec = FAILED_LOGINS.get(key) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    rec.count = 0; // the next window starts fresh once the lockout itself expires
  }
  FAILED_LOGINS.set(key, rec);
}

function clearFailedLogins(email) {
  FAILED_LOGINS.delete(normEmail(email));
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (check.length !== expected.length) return false;
  return crypto.timingSafeEqual(check, expected);
}

export async function login(email, password) {
  const lock = loginLockStatus(email);
  if (lock.locked) {
    const mins = Math.ceil(lock.retryAfterSeconds / 60);
    throw new Error(`Too many failed attempts. Try again in about ${mins} minute${mins === 1 ? "" : "s"}.`);
  }
  const user = await one(`SELECT id, name, password_hash FROM users WHERE email = ${lit(email)}`);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordFailedLogin(email);
    return null;
  }
  clearFailedLogins(email);
  const token = crypto.randomBytes(32).toString("hex");
  await query(
    `INSERT INTO sessions(token, user_id, expires_at) VALUES (${lit(token)}, ${user.id}, now() + interval '${SESSION_DAYS} days')`
  );
  return { token, name: user.name };
}

export async function logout(token) {
  if (!token) return;
  await query(`DELETE FROM sessions WHERE token = ${lit(token)}`);
}

export async function currentUser(token) {
  if (!token) return null;
  const row = await one(
    `SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ${lit(token)} AND s.expires_at > now()`
  );
  return row;
}

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

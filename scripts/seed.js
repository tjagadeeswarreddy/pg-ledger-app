import { query, one } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import * as repo from "../src/repo.js";

async function wipe() {
  const tables = ["account_transactions", "payments", "rent_charges", "expenses", "tenants", "rooms", "floors", "accounts", "sessions", "users"];
  for (const t of tables) await query(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`);
}

async function main() {
  await wipe();

  await query(`INSERT INTO users(email, password_hash, name) VALUES
    ('owner@pgledger.local', '${hashPassword("change-me-123")}', 'Owner')`);

  const floorDefs = ["Ground Floor", "1st Floor", "2nd Floor", "3rd Floor", "4th Floor"];
  const floors = [];
  for (let i = 0; i < floorDefs.length; i++) {
    floors.push(await repo.createFloor({ name: floorDefs[i], sortOrder: i }));
  }
  const [ground, f1, f2, f3, f4] = floors;

  const roomDefs = [
    [ground, "G01", 4, 6500], [ground, "G02", 3, 7000], [ground, "G03", 2, 8000],
    [f1, "101", 4, 6500], [f1, "102", 3, 7000], [f1, "103", 1, 12500],
    [f2, "201", 4, 6500], [f2, "202", 4, 6500],
    [f3, "301", 3, 7000], [f3, "302", 2, 8000],
    [f4, "401", 4, 6500], [f4, "402", 3, 7000],
  ];
  const rooms = [];
  for (const [floor, roomNo, sharingType, rent] of roomDefs) {
    rooms.push(await repo.createRoom({ floorId: floor.id, roomNo, sharingType, defaultRent: rent }));
  }

  const names = [
    "Arjun Mehta", "Kiran Rao", "Vikram Shah", "Sandeep Kumar", "Ravi Teja", "Manoj Pillai",
    "Praveen Reddy", "Suresh Nair", "Deepak Iyer", "Naveen Gowda", "Ashok Menon", "Vinay Kulkarni",
    "Harish Chandra", "Rakesh Verma", "Sunil Joshi", "Gopal Krishnan", "Anil Kapoor", "Rajesh Babu",
    "Mahesh Patil", "Srinivas Rao", "Yogesh Patel", "Karthik Subramaniam", "Nitin Deshmukh", "Prasad Rao",
    "Abhishek Sharma", "Girish Kumar", "Chetan Singh", "Rohit Bose", "Sameer Khan", "Vijay Anand",
    "Faizan Ali", "Dinesh Prabhu",
  ];
  const occupations = ["Software Engineer", "Sales Executive", "Bank Employee", "Student", "Accountant", "Marketing Exec", "Teacher", "Nurse", "Mechanic", "Analyst"];

  let nameIdx = 0;
  const tenants = [];
  const today = new Date();
  const skipBeds = new Set(["101:2", "202:3", "302:1", "402:2", "G02:3"]); // leave a few beds vacant
  // Spread due days across the month so the demo shows both "already due" and
  // "not due yet" tenants on the Rent Collection page, not just one or the other.
  const dueDays = [1, 2, 3, 4, 6, 10, 15, 22];

  for (const room of rooms) {
    for (let bed = 1; bed <= room.sharing_type; bed++) {
      if (skipBeds.has(`${room.room_no}:${bed}`)) continue;
      const name = names[nameIdx % names.length];
      nameIdx++;
      const joining = new Date(today.getFullYear(), today.getMonth() - (3 + (nameIdx % 20)), 1 + (nameIdx % 25));
      const t = await repo.createTenant({
        roomId: room.id, bedNo: bed, fullName: name,
        phone: `9${String(700000000 + nameIdx * 137).slice(0, 9)}`,
        emergencyName: name.split(" ")[0] + "'s father",
        emergencyPhone: `9${String(800000000 + nameIdx * 91).slice(0, 9)}`,
        emergencyRelation: "Father",
        occupation: occupations[nameIdx % occupations.length],
        idProofType: "Aadhaar", idProofNumber: `XXXX-XXXX-${1000 + nameIdx}`,
        joiningDate: joining.toISOString().slice(0, 10),
        rentDueDay: dueDays[nameIdx % dueDays.length],
        monthlyRent: room.default_rent,
        depositAmount: room.default_rent * 2,
        depositPaidDate: joining.toISOString().slice(0, 10),
      });
      tenants.push(t);
    }
  }

  const accounts = [];
  accounts.push(await repo.createAccount({ name: "Owner - SBI", type: "bank", openingBalance: 50000 }));
  accounts.push(await repo.createAccount({ name: "Manager - SBI", type: "bank", openingBalance: 20000 }));
  accounts.push(await repo.createAccount({ name: "Cash", type: "cash", openingBalance: 5000 }));
  accounts.push(await repo.createAccount({ name: "UPI Collect", type: "upi", openingBalance: 0 }));
  const [ownerAcc, mgrAcc, cashAcc, upiAcc] = accounts;

  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  await repo.ensureChargesForMonth(year, month);

  const charges = await repo.listChargesForMonth({ year, month });
  const modes = ["upi", "cash", "bank_transfer"];
  const accByMode = { upi: upiAcc, cash: cashAcc, bank_transfer: ownerAcc };

  // Bucket out of 5 (not 10) now that due-day gating means fewer charges exist at
  // seed time — this keeps a reliable mix of paid/partial/waived/overdue no matter
  // how many tenants have already reached their due day.
  for (let i = 0; i < charges.length; i++) {
    const c = charges[i];
    const bucket = i % 5;
    if (bucket < 2) {
      // fully paid
      const mode = modes[i % modes.length];
      await repo.recordPayment({ rentChargeId: c.id, tenantId: c.tenant_id, accountId: accByMode[mode].id, amount: Number(c.expected_amount), mode, payDate: `${year}-${String(month).padStart(2, "0")}-0${(i % 8) + 1}` });
    } else if (bucket === 2) {
      // partially paid
      const mode = modes[i % modes.length];
      const partial = Math.round(Number(c.expected_amount) * 0.45 / 100) * 100;
      await repo.recordPayment({ rentChargeId: c.id, tenantId: c.tenant_id, accountId: accByMode[mode].id, amount: partial, mode, payDate: `${year}-${String(month).padStart(2, "0")}-10` });
    } else if (bucket === 3) {
      // waived — the "manually deleted the due" scenario, done correctly
      await repo.waiveCharge(c.id, "Tenant travelling for work this month — rent waived by owner");
    }
    // bucket === 4: left unpaid/overdue on purpose
  }

  // A couple of expenses
  await repo.createExpense({ accountId: ownerAcc.id, category: "Electricity", amount: 18400, expenseDate: `${year}-${String(month).padStart(2, "0")}-03`, note: "EB bill — all floors" });
  await repo.createExpense({ accountId: cashAcc.id, category: "WiFi", amount: 4500, expenseDate: `${year}-${String(month).padStart(2, "0")}-02`, note: "Broadband — 2 routers" });
  await repo.createExpense({ accountId: ownerAcc.id, category: "Staff salary", amount: 12000, expenseDate: `${year}-${String(month).padStart(2, "0")}-01`, note: "Housekeeping" });

  console.log(`Seeded: ${floors.length} floors, ${rooms.length} rooms, ${tenants.length} tenants, ${accounts.length} accounts, ${charges.length} rent charges for ${year}-${month}.`);
  console.log(`Login: owner@pgledger.local / change-me-123`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

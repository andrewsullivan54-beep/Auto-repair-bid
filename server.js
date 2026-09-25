/*
 * Auto Repair Bids — server
 * -------------------------
 * Node.js + Express + SQLite (built-in node:sqlite — no native modules,
 * so `npm install` works anywhere Node 24+ runs).
 * Serves the mobile-first web app from /public and exposes a JSON API
 * under /api/*. Sessions are cookie-based (express-session).
 *
 * Run:  npm install && npm start   →  http://localhost:3000
 */
'use strict';

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------ */
/* Platform economics — ANDREW: set this number.                        */
/* ------------------------------------------------------------------ */
// Flat $ fee the platform keeps on every won job. Taken out of the
// customer's escrowed payment when funds are released to the shop.
// Example: $600 job → shop gets $575, platform keeps $25.
const PLATFORM_FEE = 25;

// Auto-release: if the shop marks the repair complete and the customer
// neither confirms nor reports a problem within this many hours, the held
// payout releases automatically. Placeholder — exact period is TBD.
const AUTO_RELEASE_HOURS = 72;

// Terms shown at Book & Pay. Bumped whenever the wording changes; the version
// the customer agreed to is stored on the job for the audit trail.
const TERMS_VERSION = '2026-09-25 v1';

// Flat $ cut the platform earns on every completed TOW. Placeholder — the
// real tow-partner revenue split is still TBD (see README open questions).
// Tow money is simulated like everything else: no real payments.
const TOW_FEE = 15;

// How long a tow partner has to accept an offered tow before the offer
// expires and the job rolls to the next partner. Placeholder — Andrew
// sets the real window (see README open questions).
const TOW_ACCEPT_WINDOW_MINUTES = 10;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */
const db = new DatabaseSync(path.join(ROOT, 'data.sqlite'));
db.exec('PRAGMA foreign_keys = ON;');

// Small helper: run fn() inside a transaction (node:sqlite has no
// db.transaction() wrapper like better-sqlite3 does).
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  role          TEXT NOT NULL CHECK(role IN ('customer','shop')),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shops (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  shop_name        TEXT NOT NULL,
  phone            TEXT,
  address          TEXT,
  zip              TEXT,
  service_radius_mi INTEGER NOT NULL DEFAULT 15,
  verified         INTEGER NOT NULL DEFAULT 0,
  rating           REAL NOT NULL DEFAULT 5.0,
  review_count     INTEGER NOT NULL DEFAULT 0,
  about            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shop_services (
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  PRIMARY KEY (shop_id, service)
);

CREATE TABLE IF NOT EXISTS shop_docs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id    INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  doc_type   TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year            TEXT,
  make            TEXT,
  model           TEXT,
  mileage         TEXT,
  issue_category  TEXT NOT NULL,
  issue_detail    TEXT,
  description     TEXT,
  zip             TEXT NOT NULL,
  radius_mi       INTEGER NOT NULL DEFAULT 10,
  status          TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','assigned','closed',
                  'disputed','cancelled_customer','cancelled_shop','no_show')),
  selected_bid_id INTEGER REFERENCES bids(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS request_photos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  file_path  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bids (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id     INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  shop_id        INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  parts_cost     REAL NOT NULL DEFAULT 0,
  labor_cost     REAL NOT NULL DEFAULT 0,
  other_cost     REAL NOT NULL DEFAULT 0,
  total          REAL NOT NULL,
  preferred_date TEXT,
  warranty       TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','won','lost','expired')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id, shop_id)
);

CREATE TABLE IF NOT EXISTS fees (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id    INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  amount     REAL NOT NULL DEFAULT 25,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','waived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/* ------------------------------------------------------------------ */
/* Escrow model (added for Andrew's payment flow):                      */
/*  - customer pays in-app when booking → payment_status 'held'         */
/*  - shop marks complete + customer confirms → 'released'             */
/*    (shop gets amount_held minus the flat PLATFORM_FEE)               */
/*  - customer reports a problem → status 'disputed', payout held      */
/*  - no customer response within AUTO_RELEASE_HOURS → auto-released   */
/*  - either side cancels → 'cancelled_*' (+ full refund if held)      */
/*  - shop flags no-show → 'no_show' (placeholder, policy TBD)         */
/*  - extra work goes through addons on the same job                   */
/*  - every step is logged to job_events (audit trail)                */
/* ------------------------------------------------------------------ */
db.exec(`
CREATE TABLE IF NOT EXISTS addons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  shop_id     INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount      REAL NOT NULL CHECK(amount > 0),
  status      TEXT NOT NULL DEFAULT 'proposed'
              CHECK(status IN ('proposed','paid','rejected')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);`);

// Add escrow columns to requests if they don't exist yet (safe for old DBs)
function ensureColumn(table, name, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}
ensureColumn('requests', 'payment_status', "TEXT NOT NULL DEFAULT 'unpaid'");
ensureColumn('requests', 'amount_held', 'REAL NOT NULL DEFAULT 0');
ensureColumn('requests', 'shop_confirmed_done', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('requests', 'customer_confirmed_done', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('requests', 'platform_earning', 'REAL NOT NULL DEFAULT 0');
ensureColumn('requests', 'shop_payout', 'REAL NOT NULL DEFAULT 0');
// Lifecycle / audit columns
ensureColumn('requests', 'terms_version', 'TEXT');
ensureColumn('requests', 'terms_accepted_at', 'TEXT');
ensureColumn('requests', 'completed_at', 'TEXT');
ensureColumn('requests', 'auto_released', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('requests', 'dispute_reason', 'TEXT');
ensureColumn('requests', 'disputed_at', 'TEXT');
ensureColumn('requests', 'refunded_amount', 'REAL NOT NULL DEFAULT 0');
ensureColumn('requests', 'cancelled_by', 'TEXT');
ensureColumn('requests', 'cancelled_at', 'TEXT');
ensureColumn('requests', 'no_show_at', 'TEXT');
ensureColumn('requests', 'no_show_by', 'TEXT');

// SQLite can't ALTER a CHECK constraint, so rebuild the table once to allow
// the new lifecycle statuses (disputed / cancelled_* / no_show) on old DBs.
const reqSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'requests'").get().sql;
if (!reqSql.includes("'disputed'")) {
  const newCols = ['id', 'customer_id', 'year', 'make', 'model', 'mileage',
    'issue_category', 'issue_detail', 'description', 'zip', 'radius_mi',
    'status', 'selected_bid_id', 'created_at', 'payment_status', 'amount_held',
    'shop_confirmed_done', 'customer_confirmed_done', 'platform_earning',
    'shop_payout', 'terms_version', 'terms_accepted_at', 'completed_at',
    'auto_released', 'dispute_reason', 'disputed_at', 'refunded_amount',
    'cancelled_by', 'cancelled_at', 'no_show_at', 'no_show_by'];
  // FKs must be off while the referenced table is swapped; restored after.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(() => {
    db.exec(`CREATE TABLE requests_new (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      year            TEXT,
      make            TEXT,
      model           TEXT,
      mileage         TEXT,
      issue_category  TEXT NOT NULL,
      issue_detail    TEXT,
      description     TEXT,
      zip             TEXT NOT NULL,
      radius_mi       INTEGER NOT NULL DEFAULT 10,
      status          TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','assigned','closed',
                      'disputed','cancelled_customer','cancelled_shop','no_show')),
      selected_bid_id INTEGER REFERENCES bids(id),
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      payment_status  TEXT NOT NULL DEFAULT 'unpaid',
      amount_held     REAL NOT NULL DEFAULT 0,
      shop_confirmed_done     INTEGER NOT NULL DEFAULT 0,
      customer_confirmed_done INTEGER NOT NULL DEFAULT 0,
      platform_earning REAL NOT NULL DEFAULT 0,
      shop_payout      REAL NOT NULL DEFAULT 0,
      terms_version    TEXT,
      terms_accepted_at TEXT,
      completed_at     TEXT,
      auto_released    INTEGER NOT NULL DEFAULT 0,
      dispute_reason   TEXT,
      disputed_at      TEXT,
      refunded_amount  REAL NOT NULL DEFAULT 0,
      cancelled_by     TEXT,
      cancelled_at     TEXT,
      no_show_at       TEXT,
      no_show_by       TEXT
    )`);
    const oldCols = db.prepare('PRAGMA table_info(requests)').all().map(c => c.name);
    const shared = newCols.filter(c => oldCols.includes(c)).join(', ');
    db.exec(`INSERT INTO requests_new (${shared}) SELECT ${shared} FROM requests`);
    db.exec('DROP TABLE requests');
    db.exec('ALTER TABLE requests_new RENAME TO requests');
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Audit trail: every meaningful job event, queryable per request.
db.exec(`CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  actor_role TEXT,
  actor_id INTEGER,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_req ON job_events(request_id)`);

function logEvent(requestId, event, actorRole, actorId, detail) {
  db.prepare(`INSERT INTO job_events (request_id, event, actor_role, actor_id, detail)
              VALUES (?,?,?,?,?)`)
    .run(requestId, event, actorRole || null, actorId || null,
         detail == null ? null : String(detail));
}

/* ------------------------------------------------------------------ */
/* Tow service (added for Andrew's post-payment tow upsell):            */
/*  - tow_partners: tow companies that take our tow jobs. Each partner */
/*    has a login (users.role = 'tow'), a city, and a priority rank     */
/*    (1 = first to be offered new jobs).                               */
/*  - tow_jobs: customer tow requests, optionally linked to a repair   */
/*    job. requested → accepted → completed (+ cancelled, unassigned).  */
/*    partner_id is set when a partner ACCEPTS, not at creation.        */
/*  - tow_offers: timed dispatch — each tow is offered to partners in  */
/*    priority order, one at a time, with an accept window.            */
/*    pending → accepted / expired / passed.                            */
/*  - notifications: in-app notification log for tow partners (offer,  */
/*    expiry, pass, accept…). Real push/SMS (e.g. Twilio) plugs in     */
/*    later — see README.                                              */
/*  On completion the platform records its flat TOW_FEE cut.           */
/*  Money is SIMULATED — no real payments (see README).                */
/* ------------------------------------------------------------------ */

// users.role gains a third value: 'tow'. SQLite can't ALTER a CHECK
// constraint, so rebuild the table once on old DBs (same pattern as the
// requests rebuild above).
const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get().sql;
if (!usersSql.includes("'tow'")) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(() => {
      db.exec(`CREATE TABLE users_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        role          TEXT NOT NULL CHECK(role IN ('customer','shop','tow')),
        name          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        phone         TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec(`INSERT INTO users_new (id, role, name, email, password_hash, phone, created_at)
               SELECT id, role, name, email, password_hash, phone, created_at FROM users`);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS tow_partners (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  phone        TEXT,
  service_area TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tow_jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id       INTEGER REFERENCES requests(id) ON DELETE SET NULL,
  partner_id       INTEGER REFERENCES tow_partners(id),
  pickup           TEXT NOT NULL,
  dropoff          TEXT NOT NULL,
  year             TEXT,
  make             TEXT,
  model            TEXT,
  preferred_window TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'requested'
                   CHECK(status IN ('requested','accepted','completed','cancelled','unassigned')),
  customer_price   TEXT,   -- v1: TBD — the tow partner confirms the price directly
  platform_cut     REAL NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at      TEXT,
  completed_at     TEXT
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tow_req ON tow_jobs(request_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tow_cust ON tow_jobs(customer_id)`);

// Partner accounts + priority dispatch rank (safe for old DBs).
// NOTE: SQLite can't ADD COLUMN with UNIQUE, so user_id gets a plain
// column plus a separate UNIQUE index below.
ensureColumn('tow_partners', 'user_id', 'INTEGER REFERENCES users(id)');
ensureColumn('tow_partners', 'priority', 'INTEGER NOT NULL DEFAULT 99');
ensureColumn('tow_partners', 'city', 'TEXT');
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tow_partner_user ON tow_partners(user_id)`);

// Timed dispatch offers: one row per partner the tow was offered to.
db.exec(`CREATE TABLE IF NOT EXISTS tow_offers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tow_job_id INTEGER NOT NULL REFERENCES tow_jobs(id) ON DELETE CASCADE,
  partner_id INTEGER NOT NULL REFERENCES tow_partners(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK(status IN ('pending','accepted','expired','passed')),
  offered_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  decided_at TEXT
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_offers_job ON tow_offers(tow_job_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_offers_pending ON tow_offers(status, expires_at)`);

// In-app notification log for tow partners (offer / expiry / pass /
// accept / completion). Real push/SMS plugs in later — see README.
db.exec(`CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id INTEGER NOT NULL REFERENCES tow_partners(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  tow_job_id INTEGER REFERENCES tow_jobs(id) ON DELETE SET NULL,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_notif_partner ON notifications(partner_id, read)`);

// tow_jobs.status gains 'unassigned' (all partners passed/timed out) —
// rebuild once on old DBs, same pattern as the requests rebuild above.
const towSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'tow_jobs'").get().sql;
if (!towSql.includes("'unassigned'")) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(() => {
      db.exec(`CREATE TABLE tow_jobs_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        request_id       INTEGER REFERENCES requests(id) ON DELETE SET NULL,
        partner_id       INTEGER REFERENCES tow_partners(id),
        pickup           TEXT NOT NULL,
        dropoff          TEXT NOT NULL,
        year             TEXT,
        make             TEXT,
        model            TEXT,
        preferred_window TEXT,
        notes            TEXT,
        status           TEXT NOT NULL DEFAULT 'requested'
                         CHECK(status IN ('requested','accepted','completed','cancelled','unassigned')),
        customer_price   TEXT,
        platform_cut     REAL NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        accepted_at      TEXT,
        completed_at     TEXT
      )`);
      db.exec(`INSERT INTO tow_jobs_new (id, customer_id, request_id, partner_id,
                pickup, dropoff, year, make, model, preferred_window, notes,
                status, customer_price, platform_cut, created_at, accepted_at, completed_at)
               SELECT id, customer_id, request_id, partner_id,
                pickup, dropoff, year, make, model, preferred_window, notes,
                status, customer_price, platform_cut, created_at, accepted_at, completed_at
               FROM tow_jobs`);
      db.exec('DROP TABLE tow_jobs');
      db.exec('ALTER TABLE tow_jobs_new RENAME TO tow_jobs');
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tow_req ON tow_jobs(request_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tow_cust ON tow_jobs(customer_id)`);
}

// Seed the launch tow partners with logins (idempotent — runs on every
// start; links the legacy Tri-State row seeded before logins existed).
function seedTowPartners() {
  const hash = bcrypt.hashSync('password123', 10);
  const defs = [
    { name: 'Tri-State Tow & Recovery', email: 'tow1@example.com', phone: '(513) 555-0199',
      city: 'Cincinnati', area: 'Greater Cincinnati (OH/KY/IN)', priority: 1 },
    { name: 'NKY Rapid Tow', email: 'tow2@example.com', phone: '(859) 555-0134',
      city: 'Covington', area: 'Northern Kentucky', priority: 2 },
    { name: 'Queen City Towing', email: 'tow3@example.com', phone: '(513) 555-0177',
      city: 'Norwood', area: 'Cincinnati metro', priority: 3 }
  ];
  for (const d of defs) {
    let user = db.prepare('SELECT id FROM users WHERE email = ?').get(d.email);
    if (!user) {
      const r = db.prepare(
        `INSERT INTO users (role, name, email, password_hash, phone)
         VALUES ('tow',?,?,?,?)`).run(d.name, d.email, hash, d.phone);
      user = { id: r.lastInsertRowid };
      console.log('Seeded tow login:', d.email);
    }
    const p = db.prepare('SELECT * FROM tow_partners WHERE name = ?').get(d.name);
    if (!p) {
      db.prepare(`INSERT INTO tow_partners (name, phone, service_area, active, user_id, priority, city)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(d.name, d.phone, d.area, 1, user.id, d.priority, d.city);
      console.log('Seeded tow partner:', d.name, '(priority ' + d.priority + ')');
    } else {
      db.prepare(`UPDATE tow_partners
                  SET user_id = COALESCE(user_id, ?), priority = ?, city = COALESCE(city, ?)
                  WHERE id = ?`).run(user.id, d.priority, d.city, p.id);
    }
  }
}
seedTowPartners();

/* ------------------------------------------------------------------ */
/* Seed data — runs once, the first time the app starts with an empty  */
/* users table. Gives Andrew demo logins that work immediately.        */
/* ------------------------------------------------------------------ */
const ISSUE_TO_SERVICE = {
  'Brakes': 'Brakes',
  'Engine': 'Engine Repair',
  'Transmission': 'Transmission',
  'Tires': 'Tires',
  'Battery': 'Electrical',
  'Electrical': 'Electrical',
  'AC/Heat': 'AC/Heat',
  'Suspension': 'Suspension',
  'Oil/Fluids': 'Oil/Fluids',
  'Check Engine Light': 'Diagnostics',
  "I don't know - need diagnostic": 'Diagnostics',
  'Tow': 'Other',
  'Other': 'Other'
};

function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const hash = bcrypt.hashSync('password123', 10);
  const addUser = db.prepare(
    'INSERT INTO users (role, name, email, password_hash, phone) VALUES (?,?,?,?,?)');
  const addShop = db.prepare(
    `INSERT INTO shops (user_id, shop_name, phone, address, zip, service_radius_mi,
                        verified, rating, review_count, about)
     VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const addService = db.prepare('INSERT INTO shop_services (shop_id, service) VALUES (?,?)');

  // Demo customer
  const cust = addUser.run('customer', 'Demo Customer', 'customer@example.com', hash, '(513) 555-0100');

  // Demo shops (match the mockups)
  const demoShops = [
    { name: 'Riverside Auto Care', email: 'shop1@example.com', phone: '(513) 555-0123',
      address: '123 Main St, Cincinnati, OH 45202', zip: '45202', radius: 15,
      rating: 4.8, reviews: 124, verified: 1,
      about: 'Full-service auto repair in downtown Cincinnati. ASE-certified techs.',
      services: ['Brakes','Engine Repair','Transmission','Electrical','AC/Heat','Tires','Suspension','Oil/Fluids','Diagnostics'] },
    { name: 'Cincinnati Auto Pros', email: 'shop2@example.com', phone: '(513) 555-0145',
      address: '456 Oak Ave, Cincinnati, OH 45202', zip: '45202', radius: 20,
      rating: 4.6, reviews: 89, verified: 1,
      about: 'Honest pricing, fast turnaround. Family owned since 2008.',
      services: ['Brakes','Engine Repair','Electrical','AC/Heat','Tires','Oil/Fluids','Diagnostics'] },
    { name: "Miller's Garage", email: 'shop3@example.com', phone: '(513) 555-0167',
      address: '789 Elm St, Covington, KY 41011', zip: '41011', radius: 10,
      rating: 4.9, reviews: 110, verified: 1,
      about: 'Boutique garage specializing in brakes, suspension and diagnostics.',
      services: ['Brakes','Suspension','Diagnostics','Oil/Fluids','Tires'] },
    { name: 'Riverside Performance', email: 'shop4@example.com', phone: '(513) 555-0189',
      address: '321 River Rd, Newport, KY 41071', zip: '41071', radius: 25,
      rating: 4.7, reviews: 96, verified: 1,
      about: 'Performance and daily-driver repair. Transmission specialists.',
      services: ['Engine Repair','Transmission','Electrical','Diagnostics','Brakes'] }
  ];
  const shopIds = [];
  for (const s of demoShops) {
    const u = addUser.run('shop', s.name, s.email, hash, s.phone);
    const sh = addShop.run(u.lastInsertRowid, s.name, s.phone, s.address, s.zip,
      s.radius, s.verified, s.rating, s.reviews, s.about);
    for (const svc of s.services) addService.run(sh.lastInsertRowid, svc);
    shopIds.push(sh.lastInsertRowid);
  }

  // Demo repair requests
  const addReq = db.prepare(
    `INSERT INTO requests (customer_id, year, make, model, mileage, issue_category,
                           issue_detail, description, zip, radius_mi, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const addBid = db.prepare(
    `INSERT INTO bids (request_id, shop_id, parts_cost, labor_cost, other_cost,
                       total, preferred_date, warranty, status)
     VALUES (?,?,?,?,?,?,?,?,?)`);

  const r1 = addReq.run(cust.lastInsertRowid, '2020', 'Ford', 'F-150', '82,000',
    'Brakes', 'Grinding noise',
    'Front brakes are making a grinding noise when stopping. Would like the best price and quality work.',
    '45202', 10, 'open').lastInsertRowid;
  // Sample bids on the F-150 request (matches mockup prices)
  addBid.run(r1, shopIds[0], 220, 180, 25, 425, 'Thursday, Apr 24', '24 mo / 24k mi warranty', 'active');
  addBid.run(r1, shopIds[1], 180, 170, 49, 399, 'Friday, Apr 25', '12 mo / 12k mi warranty', 'active');
  addBid.run(r1, shopIds[2], 240, 200, 35, 475, 'Thursday, Apr 24', '24 mo / 24k mi warranty', 'active');

  addReq.run(cust.lastInsertRowid, '2019', 'Chevrolet', 'Silverado', '95,000',
    'Transmission', 'Slipping between gears',
    'Transmission slips between 2nd and 3rd gear, worse when cold.', '45202', 25, 'open');
  addReq.run(cust.lastInsertRowid, '2018', 'Honda', 'Accord', '76,000',
    'AC/Heat', 'AC not working',
    'AC blows warm air. Worked fine last summer.', '45202', 10, 'open');
  addReq.run(cust.lastInsertRowid, '2021', 'Jeep', 'Grand Cherokee', '54,000',
    'Check Engine Light', 'Light is on',
    'Check engine light came on yesterday. Car still drives fine.', '45202', 10, 'open');

  // One completed job so the shop "Won" tab has content
  const r5 = addReq.run(cust.lastInsertRowid, '2017', 'Toyota', 'Camry', '110,000',
    'Oil/Fluids', 'Full synthetic oil change',
    'Full synthetic oil change and tire rotation.', '45202', 10, 'assigned').lastInsertRowid;
  const wonBid = addBid.run(r5, shopIds[0], 45, 40, 0, 85, 'Done', 'N/A', 'won').lastInsertRowid;
  db.prepare('UPDATE requests SET selected_bid_id = ? WHERE id = ?').run(wonBid, r5);
  db.prepare('INSERT INTO fees (shop_id, request_id, amount, status) VALUES (?,?,25,?)')
    .run(shopIds[0], r5, 'pending');

  console.log('Seeded demo data: customer@example.com + 4 shops (password123 for all).');
}
seedIfEmpty();

/* ------------------------------------------------------------------ */
/* Middleware                                                          */
/* ------------------------------------------------------------------ */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'auto-repair-bids-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 3600 * 1000 } // 1 week
}));

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please log in.' });
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (req.session.role !== role) return res.status(403).json({ error: 'Wrong account type.' });
    next();
  };
}
// Logged-in shop's shop row id (shops are created at signup, updated in onboarding)
function shopIdFor(userId) {
  const row = db.prepare('SELECT id FROM shops WHERE user_id = ?').get(userId);
  return row ? row.id : null;
}

// Escrow split for a held amount: flat platform fee, rest to the shop
function escrowSplit(amountHeld) {
  const held = +Number(amountHeld || 0).toFixed(2);
  const platformFee = Math.min(PLATFORM_FEE, held); // never take more than held
  return {
    amountHeld: held,
    platformFee: +platformFee.toFixed(2),
    shopPayout: +(held - platformFee).toFixed(2)
  };
}

// Release escrow when BOTH sides confirmed and funds are held — or when the
// auto-release timer expired. Returns the release record, or null if the
// conditions aren't met yet.
function tryRelease(requestId, opts = {}) {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
  if (!r || r.payment_status !== 'held') return null;
  const confirmed = r.shop_confirmed_done && r.customer_confirmed_done;
  const auto = !!opts.auto;
  if (!confirmed && !auto) return null;
  if (auto && !(r.shop_confirmed_done && !r.customer_confirmed_done)) return null;
  const split = escrowSplit(r.amount_held);
  transaction(() => {
    db.prepare(`UPDATE requests
                SET payment_status = 'released', platform_earning = ?,
                    shop_payout = ?, status = 'closed',
                    auto_released = ?
                WHERE id = ?`)
      .run(split.platformFee, split.shopPayout, auto ? 1 : 0, requestId);
    // The $25 acquisition fee is settled out of the released funds
    db.prepare("UPDATE fees SET status = 'paid' WHERE request_id = ? AND status = 'pending'")
      .run(requestId);
    logEvent(requestId, auto ? 'auto_released' : 'payout_released', 'system', null,
      `Held $${split.amountHeld} → shop $${split.shopPayout}, platform $${split.platformFee}` +
      (auto ? ` (no customer response within ${AUTO_RELEASE_HOURS}h)` : ''));
  });
  return { released: true, auto, ...split };
}

// Lazy auto-release: called on reads. If the shop marked the repair complete
// and the customer hasn't confirmed or reported a problem within
// AUTO_RELEASE_HOURS, release the payout automatically.
function checkAutoRelease(r) {
  if (!r || r.payment_status !== 'held' || r.status !== 'assigned') return null;
  if (!(r.shop_confirmed_done && !r.customer_confirmed_done)) return null;
  if (!r.completed_at) return null;
  const elapsedHrs = (Date.now() - new Date(r.completed_at + 'Z').getTime()) / 36e5;
  if (elapsedHrs >= AUTO_RELEASE_HOURS) return tryRelease(r.id, { auto: true });
  return null;
}

/* ------------------------------------------------------------------ */
/* File uploads (photos + verification documents), stored in /uploads  */
/* ------------------------------------------------------------------ */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + (ext || '.bin'));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB per file
  fileFilter: (req, file, cb) => {
    const ok = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(file.mimetype);
    cb(ok ? null : new Error('Only images and PDFs are allowed.'), ok);
  }
});
app.use('/uploads', express.static(UPLOAD_DIR));

/* ------------------------------------------------------------------ */
/* Auth API                                                            */
/* ------------------------------------------------------------------ */
// Sign up — creates a customer account, or a shop account + empty shop row
// (the shop fills in the row during onboarding).
app.post('/api/signup', (req, res) => {
  const { role, name, email, password, phone } = req.body || {};
  if (!['customer', 'shop'].includes(role)) return res.status(400).json({ error: 'Pick customer or shop.' });
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  try {
    const hash = bcrypt.hashSync(String(password), 10);
    const r = db.prepare(
      'INSERT INTO users (role, name, email, password_hash, phone) VALUES (?,?,?,?,?)'
    ).run(role, String(name).trim(), String(email).trim().toLowerCase(),
           hash, phone ? String(phone).trim() : null);
    if (role === 'shop') {
      db.prepare('INSERT INTO shops (user_id, shop_name) VALUES (?,?)')
        .run(r.lastInsertRowid, String(name).trim());
    }
    req.session.userId = r.lastInsertRowid;
    req.session.role = role;
    res.json({ ok: true, role });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That email is already registered. Try logging in.' });
    throw e;
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?')
    .get(String(email || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Email or password is wrong.' });
  }
  req.session.userId = user.id;
  req.session.role = user.role;
  res.json({ ok: true, role: user.role });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  const user = db.prepare('SELECT id, role, name, email, phone FROM users WHERE id = ?')
    .get(req.session.userId);
  res.json({ loggedIn: true, ...user, shopId: user.role === 'shop' ? shopIdFor(user.id) : null });
});

/* ------------------------------------------------------------------ */
/* Customer API                                                        */
/* ------------------------------------------------------------------ */
// Create a repair request (multipart: fields + up to 5 photos)
app.post('/api/requests', requireLogin, requireRole('customer'),
  upload.array('photos', 5), (req, res) => {
    const b = req.body || {};
    if (!b.issue_category || !b.zip) {
      return res.status(400).json({ error: 'Tell us what\'s wrong and your ZIP code.' });
    }
    const r = db.prepare(
      `INSERT INTO requests (customer_id, year, make, model, mileage, issue_category,
                              issue_detail, description, zip, radius_mi)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(req.session.userId,
      (b.year || '').trim(), (b.make || '').trim(), (b.model || '').trim(), (b.mileage || '').trim(),
      b.issue_category, (b.issue_detail || '').trim(), (b.description || '').trim(),
      String(b.zip).trim(), parseInt(b.radius_mi, 10) || 10);
    const addPhoto = db.prepare('INSERT INTO request_photos (request_id, file_path) VALUES (?,?)');
    for (const f of (req.files || [])) addPhoto.run(r.lastInsertRowid, '/uploads/' + f.filename);
    logEvent(r.lastInsertRowid, 'request_created', 'customer', req.session.userId,
      `${b.year || ''} ${b.make || ''} ${b.model || ''} — ${b.issue_category} (${b.zip})`.trim());
    res.json({ ok: true, id: r.lastInsertRowid });
  }
);

// My requests (with bid counts + latest tow status)
app.get('/api/requests/mine', requireLogin, requireRole('customer'), (req, res) => {
  const rows = db.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM bids b WHERE b.request_id = r.id) AS bid_count,
            (SELECT status FROM tow_jobs t WHERE t.request_id = r.id ORDER BY t.id DESC LIMIT 1) AS tow_status
     FROM requests r WHERE r.customer_id = ? ORDER BY r.id DESC`
  ).all(req.session.userId);
  res.json(rows);
});

// One request with bids + shop cards (for the customer compare screen)
app.get('/api/requests/:id', requireLogin, (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found.' });
  const isOwner = r.customer_id === req.session.userId;
  if (!isOwner && req.session.role !== 'shop') return res.status(403).json({ error: 'Not yours.' });
  const photos = db.prepare('SELECT id, file_path FROM request_photos WHERE request_id = ?').all(r.id);
  const bids = db.prepare(
    `SELECT b.*, s.shop_name, s.rating, s.review_count, s.phone, s.address, s.verified
     FROM bids b JOIN shops s ON s.id = b.shop_id
     WHERE b.request_id = ? ORDER BY b.total ASC`
  ).all(r.id);
  // Shops only see full customer contact after they win the job
  let customer = null;
  let isWinningShop = false;
  if (isOwner) {
    customer = db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(r.customer_id);
  } else {
    const won = bids.find(b => b.shop_id === shopIdFor(req.session.userId) && b.status === 'won');
    if (won) {
      isWinningShop = true;
      customer = db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(r.customer_id);
    }
  }
  // Escrow + add-ons are visible to the two parties on the job
  let escrow = null, addons = [];
  let tow = null;
  if (isOwner || isWinningShop) {
    // Lazy auto-release: customer ignored the completion request too long
    const auto = checkAutoRelease(r);
    if (auto) Object.assign(r, db.prepare('SELECT * FROM requests WHERE id = ?').get(r.id));
    addons = db.prepare('SELECT * FROM addons WHERE request_id = ? ORDER BY id').all(r.id);
    tow = db.prepare(
      `SELECT t.id, t.status, t.pickup, t.dropoff, t.preferred_window, t.created_at,
              p.name AS partner_name, p.phone AS partner_phone
       FROM tow_jobs t LEFT JOIN tow_partners p ON p.id = t.partner_id
       WHERE t.request_id = ? ORDER BY t.id DESC LIMIT 1`
    ).get(r.id) || null;
    escrow = {
      payment_status: r.payment_status,
      shop_confirmed_done: !!r.shop_confirmed_done,
      customer_confirmed_done: !!r.customer_confirmed_done,
      autoReleased: !!r.auto_released,
      ...escrowSplit(r.amount_held || 0)
    };
  }
  res.json({ ...r, photos, bids, customer, isOwner, isWinningShop, escrow, addons, tow,
             termsVersion: TERMS_VERSION, autoReleaseHours: AUTO_RELEASE_HOURS });
});

// Choose a shop: marks bid won, others lost, request assigned, $25 fee logged
app.post('/api/requests/:id/select', requireLogin, requireRole('customer'), (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!r || r.customer_id !== req.session.userId) return res.status(404).json({ error: 'Not found.' });
  if (r.status !== 'open') return res.status(400).json({ error: 'This request is already assigned.' });
  const bid = db.prepare('SELECT * FROM bids WHERE id = ? AND request_id = ?').get(req.body.bid_id, r.id);
  if (!bid) return res.status(400).json({ error: 'Pick one of the bids on this request.' });

  transaction(() => {
    db.prepare("UPDATE bids SET status = 'lost' WHERE request_id = ? AND status = 'active'").run(r.id);
    db.prepare("UPDATE bids SET status = 'won' WHERE id = ?").run(bid.id);
    db.prepare("UPDATE requests SET status = 'assigned', selected_bid_id = ? WHERE id = ?").run(bid.id, r.id);
    // Flat $25 acquisition fee, logged as pending — settled out of the
    // escrowed funds when the job is released (see tryRelease).
    db.prepare('INSERT INTO fees (shop_id, request_id, amount, status) VALUES (?,?,?,?)')
      .run(bid.shop_id, r.id, PLATFORM_FEE, 'pending');
    logEvent(r.id, 'bid_selected', 'customer', req.session.userId,
      `Chose bid #${bid.id} ($${bid.total}) from shop #${bid.shop_id}`);
  });
  const shop = db.prepare('SELECT shop_name, phone, address, rating, review_count FROM shops WHERE id = ?')
    .get(bid.shop_id);
  res.json({ ok: true, shop });
});

/* ------------------------------------------------------------------ */
/* Escrow API (payments are SIMULATED — no real money moves, see README) */
/* ------------------------------------------------------------------ */

// Customer pays the winning bid total in-app → funds HELD in escrow
app.post('/api/requests/:id/pay', requireLogin, requireRole('customer'), (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!r || r.customer_id !== req.session.userId) return res.status(404).json({ error: 'Not found.' });
  if (r.status !== 'assigned' || !r.selected_bid_id) return res.status(400).json({ error: 'Choose a shop first.' });
  if (r.payment_status !== 'unpaid') return res.status(400).json({ error: 'This job is already paid.' });
  const bid = db.prepare('SELECT total FROM bids WHERE id = ?').get(r.selected_bid_id);
  transaction(() => {
    db.prepare(`UPDATE requests SET payment_status = 'held', amount_held = ?,
                terms_version = ?, terms_accepted_at = datetime('now') WHERE id = ?`)
      .run(bid.total, TERMS_VERSION, r.id);
    logEvent(r.id, 'terms_accepted', 'customer', req.session.userId,
      `Agreed to terms ${TERMS_VERSION} at Book & Pay`);
    logEvent(r.id, 'payment_held', 'customer', req.session.userId,
      `$${bid.total} held in escrow (simulated — no real money moved)`);
  });
  res.json({ ok: true, held: true, ...escrowSplit(bid.total),
             note: 'Simulated payment — no real money moved.' });
});

// Winning shop marks the repair completed → customer gets CONFIRM or REPORT
app.post('/api/requests/:id/shop-complete', requireLogin, requireRole('shop'), (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  const sid = shopIdFor(req.session.userId);
  const won = r && db.prepare("SELECT id FROM bids WHERE request_id = ? AND shop_id = ? AND status = 'won'")
    .get(r.id, sid);
  if (!r || !won) return res.status(404).json({ error: 'Not found.' });
  if (r.status !== 'assigned') return res.status(400).json({ error: 'This job is not active.' });
  if (r.shop_confirmed_done) return res.status(400).json({ error: 'Already marked complete.' });
  transaction(() => {
    db.prepare("UPDATE requests SET shop_confirmed_done = 1, completed_at = datetime('now') WHERE id = ?")
      .run(r.id);
    logEvent(r.id, 'completion_marked', 'shop', req.session.userId,
      `Shop marked repair completed; customer has ${AUTO_RELEASE_HOURS}h to confirm or report a problem`);
  });
  const rel = tryRelease(r.id);
  res.json({ ok: true, shopConfirmed: true,
             ...(rel || { awaiting: 'customer confirmation' }) });
});

// Customer confirms the work is done → payout eligible
app.post('/api/requests/:id/customer-confirm', requireLogin, requireRole('customer'), (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!r || r.customer_id !== req.session.userId) return res.status(404).json({ error: 'Not found.' });
  if (r.status !== 'assigned') return res.status(400).json({ error: 'This job is not active.' });
  if (!r.shop_confirmed_done) return res.status(400).json({ error: 'The shop has not marked the repair complete yet.' });
  if (r.customer_confirmed_done) return res.status(400).json({ error: 'Already confirmed.' });
  transaction(() => {
    db.prepare('UPDATE requests SET customer_confirmed_done = 1 WHERE id = ?').run(r.id);
    logEvent(r.id, 'completion_confirmed', 'customer', req.session.userId,
      'Customer confirmed completion — payout eligible');
  });
  const rel = tryRelease(r.id);
  res.json({ ok: true, customerConfirmed: true,
             ...(rel || { awaiting: 'release' }) });
});

// Customer reports a problem instead of confirming → DISPUTED, payout held
app.post('/api/requests/:id/report-problem', requireLogin, requireRole('customer'), (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!r || r.customer_id !== req.session.userId) return res.status(404).json({ error: 'Not found.' });
  if (r.status !== 'assigned') return res.status(400).json({ error: 'This job is not active.' });
  if (!r.shop_confirmed_done) return res.status(400).json({ error: 'The shop has not marked the repair complete yet.' });
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Tell us what the problem is.' });
  transaction(() => {
    db.prepare(`UPDATE requests SET status = 'disputed', dispute_reason = ?,
                disputed_at = datetime('now') WHERE id = ?`).run(reason, r.id);
    logEvent(r.id, 'problem_reported', 'customer', req.session.userId,
      `Dispute opened — payout held. Reason: ${reason}`);
  });
  res.json({ ok: true, disputed: true,
             note: 'Payout is held while the dispute is reviewed. Resolution process TBD.' });
});

// Cancel a booking — customer or shop. If funds were held, full refund (simulated).
app.post('/api/requests/:id/cancel', requireLogin, (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found.' });
  const role = req.session.role;
  const isOwner = role === 'customer' && r.customer_id === req.session.userId;
  const sid = role === 'shop' ? shopIdFor(req.session.userId) : null;
  const isWinner = sid && db.prepare("SELECT id FROM bids WHERE request_id = ? AND shop_id = ? AND status = 'won'")
    .get(r.id, sid);
  if (!isOwner && !isWinner) return res.status(403).json({ error: 'Not your job.' });
  if (!['open', 'assigned'].includes(r.status)) {
    return res.status(400).json({ error: 'This job can no longer be cancelled.' });
  }
  const by = isOwner ? 'customer' : 'shop';
  const status = isOwner ? 'cancelled_customer' : 'cancelled_shop';
  transaction(() => {
    if (r.payment_status === 'held') {
      const refund = +Number(r.amount_held).toFixed(2);
      db.prepare(`UPDATE requests SET status = ?, payment_status = 'refunded',
                  refunded_amount = ?, cancelled_by = ?, cancelled_at = datetime('now')
                  WHERE id = ?`).run(status, refund, by, r.id);
      logEvent(r.id, 'refunded', 'system', null,
        `Full refund of $${refund} to customer (simulated — no real money moved). Cancelled by ${by}.`);
    } else {
      db.prepare(`UPDATE requests SET status = ?, cancelled_by = ?,
                  cancelled_at = datetime('now') WHERE id = ?`).run(status, by, r.id);
    }
    // No fee on a cancelled job
    db.prepare("UPDATE fees SET status = 'waived' WHERE request_id = ? AND status = 'pending'").run(r.id);
    logEvent(r.id, 'cancelled', by, req.session.userId,
      `Booking cancelled by ${by}${r.payment_status === 'held' ? ' — funds refunded' : ' — nothing was paid'}.`);
  });
  res.json({ ok: true, status,
             refunded: r.payment_status === 'held',
             note: r.payment_status === 'held' ? 'Simulated full refund — no real money moved.' : undefined });
});

// Shop flags a customer no-show (placeholder — compensation policy TBD)
app.post('/api/requests/:id/no-show', requireLogin, requireRole('shop'), (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  const sid = shopIdFor(req.session.userId);
  const won = r && db.prepare("SELECT id FROM bids WHERE request_id = ? AND shop_id = ? AND status = 'won'")
    .get(r.id, sid);
  if (!r || !won) return res.status(404).json({ error: 'Not found.' });
  if (r.status !== 'assigned') return res.status(400).json({ error: 'This job is not active.' });
  transaction(() => {
    db.prepare(`UPDATE requests SET status = 'no_show', no_show_at = datetime('now'),
                no_show_by = 'shop' WHERE id = ?`).run(r.id);
    logEvent(r.id, 'no_show_marked', 'shop', req.session.userId,
      'Shop reported customer no-show. Payout held — no-show policy TBD.');
  });
  res.json({ ok: true, noShow: true,
             note: 'No-show recorded. Refund/compensation policy is still TBD.' });
});

// Audit trail for one job — the two parties on the job can query it
app.get('/api/requests/:id/timeline', requireLogin, (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found.' });
  const isOwner = r.customer_id === req.session.userId;
  const sid = req.session.role === 'shop' ? shopIdFor(req.session.userId) : null;
  const isWinner = sid && db.prepare("SELECT id FROM bids WHERE request_id = ? AND shop_id = ? AND status = 'won'")
    .get(r.id, sid);
  if (!isOwner && !isWinner) return res.status(403).json({ error: 'Not your job.' });
  const events = db.prepare('SELECT * FROM job_events WHERE request_id = ? ORDER BY id').all(r.id);
  res.json({ request_id: r.id, events });
});

// Winning shop proposes an add-on charge for extra work on the job
app.post('/api/requests/:id/addons', requireLogin, requireRole('shop'), (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  const sid = shopIdFor(req.session.userId);
  const won = r && db.prepare("SELECT id FROM bids WHERE request_id = ? AND shop_id = ? AND status = 'won'")
    .get(r.id, sid);
  if (!r || !won) return res.status(404).json({ error: 'Not found.' });
  if (r.status !== 'assigned') return res.status(400).json({ error: 'Add-ons are only for active jobs.' });
  const amount = +req.body.amount || 0;
  if (!req.body.description || !String(req.body.description).trim() || amount <= 0) {
    return res.status(400).json({ error: 'Describe the extra work and enter an amount.' });
  }
  const a = db.prepare('INSERT INTO addons (request_id, shop_id, description, amount) VALUES (?,?,?,?)')
    .run(r.id, sid, String(req.body.description).trim(), +amount.toFixed(2));
  logEvent(r.id, 'addon_proposed', 'shop', req.session.userId,
    `Proposed add-on #${a.lastInsertRowid}: ${String(req.body.description).trim()} — $${(+amount).toFixed(2)} (awaiting customer approval)`);
  res.json({ ok: true, id: a.lastInsertRowid });
});

// Customer approves + pays an add-on in-app → amount joins the escrow hold
app.post('/api/addons/:id/approve-pay', requireLogin, requireRole('customer'), (req, res) => {
  const a = db.prepare(`SELECT a.*, r.customer_id FROM addons a
                        JOIN requests r ON r.id = a.request_id WHERE a.id = ?`).get(req.params.id);
  if (!a || a.customer_id !== req.session.userId) return res.status(404).json({ error: 'Not found.' });
  if (a.status !== 'proposed') return res.status(400).json({ error: 'This add-on was already handled.' });
  transaction(() => {
    db.prepare("UPDATE addons SET status = 'paid' WHERE id = ?").run(a.id);
    db.prepare('UPDATE requests SET amount_held = amount_held + ? WHERE id = ?')
      .run(a.amount, a.request_id);
    logEvent(a.request_id, 'addon_approved', 'customer', req.session.userId,
      `Approved add-on #${a.id} ($${(+a.amount).toFixed(2)}) — paid in-app, joined escrow hold (simulated)`);
  });
  res.json({ ok: true, paid: true, note: 'Simulated payment — no real money moved.' });
});

// Customer declines an add-on
app.post('/api/addons/:id/reject', requireLogin, requireRole('customer'), (req, res) => {
  const a = db.prepare(`SELECT a.*, r.customer_id FROM addons a
                        JOIN requests r ON r.id = a.request_id WHERE a.id = ?`).get(req.params.id);
  if (!a || a.customer_id !== req.session.userId) return res.status(404).json({ error: 'Not found.' });
  if (a.status !== 'proposed') return res.status(400).json({ error: 'This add-on was already handled.' });
  db.prepare("UPDATE addons SET status = 'rejected' WHERE id = ?").run(a.id);
  logEvent(a.request_id, 'addon_rejected', 'customer', req.session.userId,
    `Declined add-on #${a.id} ($${(+a.amount).toFixed(2)})`);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Tow dispatch engine — timed multi-partner offers                     */
/*                                                                     */
/* When a tow is created it's offered to the active partner with the   */
/* lowest priority number. That partner has TOW_ACCEPT_WINDOW_MINUTES   */
/* to accept. If the window expires (checked lazily on reads — no      */
/* background scheduler in v1, see README) or the partner passes, the  */
/* offer rolls to the next partner. If everyone passes/times out, the  */
/* tow becomes 'unassigned' and lands on the admin attention list.     */
/* ------------------------------------------------------------------ */

// Logged-in tow partner's tow_partners row id
function partnerIdFor(userId) {
  const row = db.prepare('SELECT id FROM tow_partners WHERE user_id = ?').get(userId);
  return row ? row.id : null;
}

// In-app notification for a tow partner (real push/SMS plugs in later)
function notifyPartner(partnerId, kind, title, body, towJobId) {
  db.prepare(`INSERT INTO notifications (partner_id, kind, title, body, tow_job_id)
              VALUES (?,?,?,?,?)`)
    .run(partnerId, kind, title, body || null, towJobId || null);
}

// Mirror tow events into the repair job's audit trail when linked
function logTowEvent(towJobId, event, detail) {
  const t = db.prepare('SELECT request_id FROM tow_jobs WHERE id = ?').get(towJobId);
  if (t && t.request_id) logEvent(t.request_id, event, 'system', null, detail);
}

function markTowUnassigned(towJobId, why) {
  db.prepare("UPDATE tow_jobs SET status = 'unassigned' WHERE id = ?").run(towJobId);
  logTowEvent(towJobId, 'tow_unassigned',
    `Tow #${towJobId} UNASSIGNED — ${why}. Needs admin attention.`);
}

// Offer the tow to the next partner in priority order that hasn't already
// been offered it. Returns the new offer, or null when nobody is left
// (the tow is then marked unassigned).
function dispatchTow(towJobId) {
  const t = db.prepare('SELECT * FROM tow_jobs WHERE id = ?').get(towJobId);
  if (!t || t.status !== 'requested') return null;
  const partners = db.prepare(
    'SELECT * FROM tow_partners WHERE active = 1 ORDER BY priority ASC, id ASC').all();
  const tried = db.prepare('SELECT partner_id FROM tow_offers WHERE tow_job_id = ?')
    .all(towJobId).map(o => o.partner_id);
  const next = partners.find(p => !tried.includes(p.id));
  if (!next) {
    markTowUnassigned(towJobId, 'every partner passed or let the offer expire');
    return null;
  }
  const exp = new Date(Date.now() + TOW_ACCEPT_WINDOW_MINUTES * 60e3);
  const expText = exp.toISOString().slice(0, 19).replace('T', ' ');
  const o = db.prepare(
    `INSERT INTO tow_offers (tow_job_id, partner_id, expires_at) VALUES (?,?,?)`)
    .run(towJobId, next.id, expText);
  notifyPartner(next.id, 'tow_offer', '🚨 New tow job offered',
    `Tow #${towJobId} — tap to accept within ${TOW_ACCEPT_WINDOW_MINUTES} minutes.`, towJobId);
  logTowEvent(towJobId, 'tow_offered',
    `Tow #${towJobId} offered to ${next.name} (accept within ${TOW_ACCEPT_WINDOW_MINUTES} min).`);
  return { offerId: o.lastInsertRowid, partnerId: next.id, partnerName: next.name, expiresAt: expText };
}

// Expire timed-out offers and roll each tow to the next partner.
// Called lazily on reads — v1 has no background scheduler (see README).
function sweepTowOffers() {
  const expired = db.prepare(
    `SELECT o.*, p.name AS partner_name FROM tow_offers o
     JOIN tow_partners p ON p.id = o.partner_id
     WHERE o.status = 'pending' AND o.expires_at <= datetime('now')`).all();
  for (const o of expired) {
    const t = db.prepare('SELECT status FROM tow_jobs WHERE id = ?').get(o.tow_job_id);
    if (!t || t.status !== 'requested') continue; // already handled another way
    transaction(() => {
      db.prepare("UPDATE tow_offers SET status = 'expired', decided_at = datetime('now') WHERE id = ?")
        .run(o.id);
      notifyPartner(o.partner_id, 'offer_expired', '⏱️ Tow offer expired',
        `Your window on tow #${o.tow_job_id} ran out — it was offered to the next partner.`, o.tow_job_id);
      logTowEvent(o.tow_job_id, 'tow_offer_expired',
        `${o.partner_name} didn't respond in time — offer expired, rolling to next partner.`);
    });
    dispatchTow(o.tow_job_id);
  }
  return expired.length;
}

/* ------------------------------------------------------------------ */
/* Tow API (v1: tow money is SIMULATED — no real payments)              */
/* ------------------------------------------------------------------ */

// Customer requests a tow. Can be linked to a repair job (request_id) or
// standalone (no request_id) from the home screen's "I Need a Tow" tile.
// The tow is DISPATCHED: offered to the priority-1 partner first, then
// rolls down the list on expiry/pass (see dispatch engine above).
app.post('/api/tow', requireLogin, requireRole('customer'), (req, res) => {
  const b = req.body || {};
  if (!b.pickup || !String(b.pickup).trim() || !b.dropoff || !String(b.dropoff).trim()) {
    return res.status(400).json({ error: 'Tell us the pickup and dropoff locations.' });
  }
  let requestId = null;
  if (b.request_id) {
    const r = db.prepare('SELECT id, customer_id FROM requests WHERE id = ?').get(b.request_id);
    if (!r || r.customer_id !== req.session.userId) {
      return res.status(404).json({ error: 'Repair job not found.' });
    }
    requestId = r.id;
  }
  const partners = db.prepare('SELECT COUNT(*) AS c FROM tow_partners WHERE active = 1').get().c;
  if (!partners) return res.status(400).json({ error: 'No tow partner is available right now.' });
  const j = db.prepare(
    `INSERT INTO tow_jobs (customer_id, request_id, pickup, dropoff,
                           year, make, model, preferred_window, notes)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(req.session.userId, requestId,
    String(b.pickup).trim(), String(b.dropoff).trim(),
    String(b.year || '').trim(), String(b.make || '').trim(), String(b.model || '').trim(),
    String(b.preferred_window || '').trim(), String(b.notes || '').trim());
  if (requestId) {
    logEvent(requestId, 'tow_requested', 'customer', req.session.userId,
      `Tow #${j.lastInsertRowid} requested: ` +
      `${String(b.pickup).trim()} → ${String(b.dropoff).trim()} — dispatching to tow partners.`);
  }
  const offer = dispatchTow(j.lastInsertRowid);
  res.json({ ok: true, id: j.lastInsertRowid,
             status: offer ? 'requested' : 'unassigned',
             offeredTo: offer ? offer.partnerName : null,
             note: offer
               ? `Offered to ${offer.partnerName} — they have ${TOW_ACCEPT_WINDOW_MINUTES} minutes to accept.`
               : 'No tow partner is available right now — we\'ll follow up with you directly.' });
});

// Customer's own tow jobs (with partner info once assigned + dispatch state)
app.get('/api/tow/mine', requireLogin, requireRole('customer'), (req, res) => {
  sweepTowOffers();
  const rows = db.prepare(
    `SELECT t.*, p.name AS partner_name, p.phone AS partner_phone,
            (SELECT COUNT(*) FROM tow_offers o WHERE o.tow_job_id = t.id AND o.status = 'pending') AS offers_pending
     FROM tow_jobs t LEFT JOIN tow_partners p ON p.id = t.partner_id
     WHERE t.customer_id = ? ORDER BY t.id DESC`
  ).all(req.session.userId);
  res.json(rows);
});

// Tow partner's board — requires a tow-partner login. Pending offers for
// THIS partner (with live countdowns), their accepted/active jobs, history.
app.get('/api/tow/partner/jobs', requireLogin, requireRole('tow'), (req, res) => {
  sweepTowOffers();
  const pid = partnerIdFor(req.session.userId);
  const partner = db.prepare('SELECT id, name, phone, city, priority FROM tow_partners WHERE id = ?').get(pid);
  const offers = db.prepare(
    `SELECT o.id AS offer_id, o.expires_at, o.offered_at,
            t.id, t.pickup, t.dropoff, t.year, t.make, t.model,
            t.preferred_window, t.notes, t.request_id, t.created_at,
            u.name AS customer_name, u.phone AS customer_phone
     FROM tow_offers o
     JOIN tow_jobs t ON t.id = o.tow_job_id
     JOIN users u ON u.id = t.customer_id
     WHERE o.partner_id = ? AND o.status = 'pending'
     ORDER BY o.offered_at DESC`
  ).all(pid);
  const mine = db.prepare(
    `SELECT t.*, u.name AS customer_name, u.phone AS customer_phone
     FROM tow_jobs t JOIN users u ON u.id = t.customer_id
     WHERE t.partner_id = ? AND t.status = 'accepted'
     ORDER BY t.id DESC`
  ).all(pid);
  const history = db.prepare(
    `SELECT t.id, t.status, t.pickup, t.dropoff, t.completed_at, t.platform_cut
     FROM tow_jobs t
     WHERE t.partner_id = ? AND t.status IN ('completed','cancelled')
     ORDER BY t.id DESC LIMIT 20`
  ).all(pid);
  const notif = db.prepare(
    'SELECT COUNT(*) AS c FROM notifications WHERE partner_id = ? AND read = 0').get(pid).c;
  res.json({ partner, offers, mine, history, unread: notif,
             acceptWindowMinutes: TOW_ACCEPT_WINDOW_MINUTES });
});

// Partner accepts THEIR pending offer on a tow
app.post('/api/tow/:id/accept', requireLogin, requireRole('tow'), (req, res) => {
  sweepTowOffers();
  const pid = partnerIdFor(req.session.userId);
  if (!pid) return res.status(403).json({ error: 'No tow partner account found.' });
  const t = db.prepare('SELECT * FROM tow_jobs WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found.' });
  if (t.status !== 'requested') return res.status(400).json({ error: 'This tow was already handled.' });
  const offer = db.prepare(
    `SELECT * FROM tow_offers WHERE tow_job_id = ? AND partner_id = ? AND status = 'pending'`)
    .get(t.id, pid);
  if (!offer) {
    return res.status(403).json({ error: 'This tow is not offered to you right now.' });
  }
  transaction(() => {
    db.prepare("UPDATE tow_offers SET status = 'accepted', decided_at = datetime('now') WHERE id = ?")
      .run(offer.id);
    db.prepare(`UPDATE tow_jobs SET status = 'accepted', partner_id = ?,
                accepted_at = datetime('now') WHERE id = ?`).run(pid, t.id);
    notifyPartner(pid, 'tow_accepted', '✅ You accepted the tow',
      `Tow #${t.id} is yours — head to ${t.pickup}.`, t.id);
    logTowEvent(t.id, 'tow_accepted', `Tow #${t.id} accepted by the tow partner — driver on the way.`);
  });
  res.json({ ok: true, status: 'accepted' });
});

// Partner passes — the offer rolls to the next partner in priority order
app.post('/api/tow/:id/pass', requireLogin, requireRole('tow'), (req, res) => {
  sweepTowOffers();
  const pid = partnerIdFor(req.session.userId);
  if (!pid) return res.status(403).json({ error: 'No tow partner account found.' });
  const t = db.prepare('SELECT * FROM tow_jobs WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found.' });
  if (t.status !== 'requested') return res.status(400).json({ error: 'This tow was already handled.' });
  const offer = db.prepare(
    `SELECT * FROM tow_offers WHERE tow_job_id = ? AND partner_id = ? AND status = 'pending'`)
    .get(t.id, pid);
  if (!offer) {
    return res.status(403).json({ error: 'This tow is not offered to you right now.' });
  }
  transaction(() => {
    db.prepare("UPDATE tow_offers SET status = 'passed', decided_at = datetime('now') WHERE id = ?")
      .run(offer.id);
    notifyPartner(pid, 'offer_passed', '⏭️ You passed on the tow',
      `Tow #${t.id} was offered to the next partner.`, t.id);
    logTowEvent(t.id, 'tow_offer_passed', 'Tow partner passed — rolling to the next partner.');
  });
  const next = dispatchTow(t.id);
  res.json({ ok: true, passed: true,
             rolledTo: next ? next.partnerName : null,
             unassigned: !next });
});

// Partner marks the tow complete → platform records its flat TOW_FEE cut
app.post('/api/tow/:id/complete', requireLogin, requireRole('tow'), (req, res) => {
  const pid = partnerIdFor(req.session.userId);
  const t = db.prepare('SELECT * FROM tow_jobs WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found.' });
  if (t.partner_id !== pid) return res.status(403).json({ error: 'This tow is not assigned to you.' });
  if (t.status !== 'accepted') return res.status(400).json({ error: 'The tow has to be accepted first.' });
  transaction(() => {
    db.prepare(`UPDATE tow_jobs SET status = 'completed',
                completed_at = datetime('now'), platform_cut = ? WHERE id = ?`)
      .run(TOW_FEE, t.id);
    notifyPartner(pid, 'tow_completed', '🏁 Tow completed',
      `Tow #${t.id} done — $${TOW_FEE} platform cut recorded (simulated).`, t.id);
    logTowEvent(t.id, 'tow_completed',
      `Tow #${t.id} completed — platform cut $${TOW_FEE} recorded (simulated).`);
  });
  res.json({ ok: true, status: 'completed', platformCut: TOW_FEE,
             note: 'Simulated — no real money moved.' });
});

// Customer cancels a tow that hasn't been completed
app.post('/api/tow/:id/cancel', requireLogin, requireRole('customer'), (req, res) => {
  const t = db.prepare('SELECT * FROM tow_jobs WHERE id = ?').get(req.params.id);
  if (!t || t.customer_id !== req.session.userId) return res.status(404).json({ error: 'Not found.' });
  if (t.status === 'completed') return res.status(400).json({ error: 'This tow is already completed.' });
  if (t.status === 'cancelled') return res.status(400).json({ error: 'Already cancelled.' });
  transaction(() => {
    db.prepare("UPDATE tow_jobs SET status = 'cancelled' WHERE id = ?").run(t.id);
    // Close out any live offers so they stop rolling
    db.prepare(`UPDATE tow_offers SET status = 'expired', decided_at = datetime('now')
                WHERE tow_job_id = ? AND status = 'pending'`).run(t.id);
    logTowEvent(t.id, 'tow_cancelled', `Tow #${t.id} cancelled by the customer.`);
  });
  res.json({ ok: true, status: 'cancelled' });
});

// Partner notification inbox (the bell on the partner board)
app.get('/api/tow/partner/notifications', requireLogin, requireRole('tow'), (req, res) => {
  const pid = partnerIdFor(req.session.userId);
  const rows = db.prepare(
    'SELECT * FROM notifications WHERE partner_id = ? ORDER BY id DESC LIMIT 30').all(pid);
  const unread = db.prepare(
    'SELECT COUNT(*) AS c FROM notifications WHERE partner_id = ? AND read = 0').get(pid).c;
  res.json({ notifications: rows, unread });
});

app.post('/api/tow/partner/notifications/read', requireLogin, requireRole('tow'), (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE partner_id = ?')
    .run(partnerIdFor(req.session.userId));
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Admin (stubbed v1 — read-only attention list, any logged-in user)    */
/* ------------------------------------------------------------------ */
// Tows nobody accepted: every partner passed or let the offer expire.
app.get('/api/admin/unassigned-tows', requireLogin, (req, res) => {
  sweepTowOffers();
  const rows = db.prepare(
    `SELECT t.*, u.name AS customer_name, u.phone AS customer_phone,
            (SELECT COUNT(*) FROM tow_offers o WHERE o.tow_job_id = t.id) AS offers_made
     FROM tow_jobs t JOIN users u ON u.id = t.customer_id
     WHERE t.status = 'unassigned' ORDER BY t.id DESC`
  ).all();
  res.json(rows);
});

/* ------------------------------------------------------------------ */
/* Shop API                                                            */
/* ------------------------------------------------------------------ */
// Save / update the shop profile (called at the end of onboarding, or from settings)
app.post('/api/shop/profile', requireLogin, requireRole('shop'), (req, res) => {
  const b = req.body || {};
  const sid = shopIdFor(req.session.userId);
  if (!sid) return res.status(400).json({ error: 'No shop found.' });
  if (!b.shop_name) return res.status(400).json({ error: 'Shop name is required.' });
  db.prepare(
    `UPDATE shops SET shop_name = ?, phone = ?, address = ?, zip = ?,
                      service_radius_mi = ?, about = ? WHERE id = ?`
  ).run(String(b.shop_name).trim(), (b.phone || '').trim(), (b.address || '').trim(),
    (b.zip || '').trim(), parseInt(b.service_radius_mi, 10) || 15, (b.about || '').trim(), sid);
  if (Array.isArray(b.services)) {
    transaction(() => {
      db.prepare('DELETE FROM shop_services WHERE shop_id = ?').run(sid);
      const ins = db.prepare('INSERT INTO shop_services (shop_id, service) VALUES (?,?)');
      for (const s of b.services) ins.run(sid, String(s));
    });
  }
  res.json({ ok: true });
});

// Upload verification documents (business license, insurance, ASE cert, shop photos)
app.post('/api/shop/docs', requireLogin, requireRole('shop'), upload.array('docs', 8), (req, res) => {
  const sid = shopIdFor(req.session.userId);
  const docType = (req.body && req.body.doc_type) || 'document';
  const ins = db.prepare('INSERT INTO shop_docs (shop_id, doc_type, file_path) VALUES (?,?,?)');
  for (const f of (req.files || [])) ins.run(sid, String(docType), '/uploads/' + f.filename);
  res.json({ ok: true, count: (req.files || []).length });
});

// Dashboard: stats + recent activity + fees owed
app.get('/api/shop/dashboard', requireLogin, requireRole('shop'), (req, res) => {
  const sid = shopIdFor(req.session.userId);
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(sid);
  const services = db.prepare('SELECT service FROM shop_services WHERE shop_id = ?').all(sid)
    .map(r => r.service);
  const stats = {
    activeRequests: db.prepare("SELECT COUNT(*) AS c FROM requests WHERE status = 'open'").get().c,
    bidsSubmitted: db.prepare('SELECT COUNT(*) AS c FROM bids WHERE shop_id = ?').get(sid).c,
    customersWon: db.prepare("SELECT COUNT(*) AS c FROM bids WHERE shop_id = ? AND status = 'won'").get(sid).c,
    feesOwed: db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM fees WHERE shop_id = ? AND status = 'pending'")
      .get(sid).s,
    // Escrow: money held for this shop's jobs + lifetime released earnings
    escrowHeld: db.prepare(
      `SELECT COALESCE(SUM(r.amount_held),0) AS s FROM requests r
       JOIN bids b ON b.id = r.selected_bid_id
       WHERE b.shop_id = ? AND r.payment_status = 'held'`).get(sid).s,
    lifetimeEarnings: db.prepare(
      `SELECT COALESCE(SUM(r.shop_payout),0) AS s FROM requests r
       JOIN bids b ON b.id = r.selected_bid_id
       WHERE b.shop_id = ? AND r.payment_status = 'released'`).get(sid).s
  };
  const activity = db.prepare(
    `SELECT 'bid' AS kind, b.created_at AS at,
            r.year || ' ' || r.make || ' ' || r.model || ' — ' || r.issue_category AS text,
            '$' || CAST(b.total AS INT) AS extra
     FROM bids b JOIN requests r ON r.id = b.request_id
     WHERE b.shop_id = ? ORDER BY b.id DESC LIMIT 8`
  ).all(sid);
  const wins = db.prepare(
    `SELECT 'won' AS kind, b.created_at AS at,
            'You were selected — ' || r.year || ' ' || r.make || ' ' || r.model AS text,
            '$25 fee' AS extra
     FROM bids b JOIN requests r ON r.id = b.request_id
     WHERE b.shop_id = ? AND b.status = 'won' ORDER BY b.id DESC LIMIT 5`
  ).all(sid);
  res.json({ shop, services, stats, activity: [...wins, ...activity].slice(0, 10),
             platformFee: PLATFORM_FEE });
});

// Available repair requests. Tabs: all | nearby | myservices.
// NOTE: "distance" is a placeholder estimate for v1 (see README open questions).
function pseudoDistance(zipA, zipB) {
  const n = s => String(s || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return (Math.abs(n(zipA) - n(zipB)) % 90) / 10 + 1; // 1.0 – 10.0 mi
}
app.get('/api/shop/requests', requireLogin, requireRole('shop'), (req, res) => {
  const sid = shopIdFor(req.session.userId);
  const shop = db.prepare('SELECT zip FROM shops WHERE id = ?').get(sid);
  const tab = req.query.tab || 'all';
  let rows = db.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM bids b WHERE b.request_id = r.id) AS bid_count,
            (SELECT COUNT(*) FROM bids b WHERE b.request_id = r.id AND b.shop_id = ?) AS my_bid
     FROM requests r WHERE r.status = 'open' ORDER BY r.id DESC`
  ).all(sid);
  rows = rows.map(r => ({ ...r, distance_mi: +pseudoDistance(shop.zip, r.zip).toFixed(1) }));
  if (tab === 'nearby') rows = rows.filter(r => r.distance_mi <= 15).sort((a, b) => a.distance_mi - b.distance_mi);
  if (tab === 'myservices') {
    const mine = new Set(db.prepare('SELECT service FROM shop_services WHERE shop_id = ?').all(sid)
      .map(x => x.service));
    rows = rows.filter(r => mine.has(ISSUE_TO_SERVICE[r.issue_category] || 'Other'));
  }
  const photos = db.prepare('SELECT request_id, file_path FROM request_photos').all();
  const byReq = {};
  for (const p of photos) (byReq[p.request_id] = byReq[p.request_id] || []).push(p.file_path);
  res.json(rows.map(r => ({ ...r, thumb: (byReq[r.id] || [])[0] || null })));
});

// Submit (or update) a bid on a request
app.post('/api/requests/:id/bids', requireLogin, requireRole('shop'), (req, res) => {
  const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!r || r.status !== 'open') return res.status(404).json({ error: 'Request not available.' });
  const sid = shopIdFor(req.session.userId);
  const parts = +req.body.parts_cost || 0, labor = +req.body.labor_cost || 0, other = +req.body.other_cost || 0;
  const total = +(parts + labor + other).toFixed(2);
  if (total <= 0) return res.status(400).json({ error: 'Enter your costs — the total has to be more than $0.' });
  db.prepare(
    `INSERT INTO bids (request_id, shop_id, parts_cost, labor_cost, other_cost, total,
                       preferred_date, warranty, status)
     VALUES (?,?,?,?,?,?,?,?,'active')
     ON CONFLICT(request_id, shop_id)
     DO UPDATE SET parts_cost = excluded.parts_cost, labor_cost = excluded.labor_cost,
                   other_cost = excluded.other_cost, total = excluded.total,
                   preferred_date = excluded.preferred_date, warranty = excluded.warranty,
                   created_at = datetime('now')`
  ).run(r.id, sid, parts, labor, other, total,
    (req.body.preferred_date || '').trim(), (req.body.warranty || '').trim());
  logEvent(r.id, 'bid_submitted', 'shop', req.session.userId,
    `Bid $${total.toFixed(2)} (parts $${parts.toFixed(2)} + labor $${labor.toFixed(2)} + other $${other.toFixed(2)})`);
  res.json({ ok: true, total });
});

// My bids, split into tabs
app.get('/api/bids/mine', requireLogin, requireRole('shop'), (req, res) => {
  const sid = shopIdFor(req.session.userId);
  const tab = req.query.tab || 'active';
  const where = tab === 'won' ? "b.status = 'won'"
    : tab === 'history' ? "b.status IN ('lost','expired')"
    : "b.status = 'active'";
  const rows = db.prepare(
    `SELECT b.*, r.year, r.make, r.model, r.issue_category, r.issue_detail, r.zip,
            r.status AS request_status,
            (SELECT file_path FROM request_photos p WHERE p.request_id = r.id LIMIT 1) AS thumb
     FROM bids b JOIN requests r ON r.id = b.request_id
     WHERE b.shop_id = ? AND ${where} ORDER BY b.id DESC`
  ).all(sid);
  res.json(rows);
});

// Fees owed by this shop ($25 per won job — payment integration is stubbed, see README)
app.get('/api/shop/fees', requireLogin, requireRole('shop'), (req, res) => {
  const sid = shopIdFor(req.session.userId);
  const rows = db.prepare(
    `SELECT f.*, r.year || ' ' || r.make || ' ' || r.model AS vehicle
     FROM fees f JOIN requests r ON r.id = f.request_id
     WHERE f.shop_id = ? ORDER BY f.id DESC`
  ).all(sid);
  res.json(rows);
});

/* ------------------------------------------------------------------ */
/* Static frontend + start                                             */
/* ------------------------------------------------------------------ */
app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// Friendly error handler for upload problems
app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
  next();
});

app.listen(PORT, () => {
  console.log(`Auto Repair Bids running → http://localhost:${PORT}`);
  console.log('Demo logins — customer: customer@example.com / password123');
  console.log('               shop:     shop1@example.com (Riverside Auto Care) / password123');
});

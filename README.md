# Auto Repair Bids

A marketplace where car owners post repair requests and local repair shops bid
on them. Free for customers — the platform makes money on the payment flow:

**Escrow model:** the customer pays in-app when booking (the platform holds the
money) → funds stay **held** while the shop does the work → only when **both**
shop and customer confirm the work is done in-app are funds **released**: the
shop gets the full amount minus a flat **$25 platform fee** (e.g. $600 job →
shop $575, platform $25). Any extra work must go through the app as add-on
charges on the same job — the customer must explicitly approve each add-on
in-app before it's authorized (never auto-added); approved add-ons are paid
in-app and join the escrow hold.

Launch market: Greater Cincinnati.

## How to run it (Windows)

1. Install Node.js from https://nodejs.org — accept all defaults. You need
   **Node 24 or newer** (the current LTS): the app uses Node's built-in
   SQLite, so there are no native modules to compile and `npm install`
   just works.
2. Open the `auto-repair-bids` folder in VS Code, then open a terminal
   (Terminal → New Terminal) and run:

   ```powershell
   npm install
   npm start
   ```

3. Open your browser to **http://localhost:3000**

That's it. The database (`data.sqlite`) is created automatically on first
start, pre-loaded with demo data (see below). Uploaded photos go in `uploads/`.

## Demo logins (password for all: `password123`)

| Role     | Email                  | What you'll see                                    |
|----------|------------------------|----------------------------------------------------|
| Customer | `customer@example.com` | Home, 5-step request flow, open requests with bids |
| Shop     | `shop1@example.com`    | Riverside Auto Care dashboard, requests, bids      |
| Shop     | `shop2@example.com`    | Cincinnati Auto Pros                               |
| Shop     | `shop3@example.com`    | Miller's Garage                                    |
| Shop     | `shop4@example.com`    | Riverside Performance                              |

Try the full loop: log in as the customer, open the **2020 Ford F-150** request,
compare the 3 sample bids, choose one — then log in as that shop and see the
"🏆 You've Been Selected!" screen with the customer's contact info unlocked.

## What's in here

```
server.js            — Express server, SQLite schema, seed data, JSON API
public/
  index.html         — Splash screen (I'm a Repair Shop / I'm a Customer)
  signup.html        — Account creation (role-aware; Google button stubbed)
  login.html         — Login (+ demo login cheat-sheet)
  css/style.css      — Midnight navy + gold theme, mobile-first
  js/common.js       — API helper, auth guard, bottom nav, formatting
  customer/
    home.html        — "Don't settle for the first price" + quick services
    new-request.html — 5-step repair request wizard (vehicle → issue → details/photos → location → review)
    requests.html    — My repair requests (with tow status badges)
    bids.html        — Compare bids (Best Value / Lowest Price / Fastest), choose a shop, confirmation + post-payment tow upsell popup
    tow.html         — Request a tow (prefilled from the repair job after Book & Pay, or standalone from the home tile) + tow status tracking
  shop/
    onboarding.html  — 5-step shop profile (business info → services → verification docs → review)
    dashboard.html   — Stats (active requests / bids / wins), recent activity, fees owed
    requests.html    — Available requests (Nearby / All / My Services tabs)
    request-detail.html — Request details + bid form (parts/labor/other = total, date, warranty)
    bids.html        — My bids (Active / Won / History) + "You've Been Selected!" screen
  tow/
    partner.html     — Tow partner job board: partner login, incoming offers with
      live countdowns, Accept / Pass, my active jobs with Mark Completed,
      notification bell (unread badge), history — polls every 20s
data.sqlite          — Created on first run (SQLite, no setup needed)
uploads/             — Uploaded photos & documents (created on first run)
```

## API overview (all JSON, cookie-session auth)

- `POST /api/signup`, `POST /api/login`, `POST /api/logout`, `GET /api/me`
- Customer: `POST /api/requests` (multipart + photos), `GET /api/requests/mine`,
  `GET /api/requests/:id`, `POST /api/requests/:id/select` (body: `{bid_id}`),
  `POST /api/requests/:id/pay` (simulated — escrow held),
  `POST /api/requests/:id/customer-confirm`,
  `POST /api/addons/:id/approve-pay` (simulated), `POST /api/addons/:id/reject`
- Shop: `POST /api/shop/profile`, `POST /api/shop/docs` (multipart),
  `GET /api/shop/dashboard`, `GET /api/shop/requests?tab=nearby|all|myservices`,
  `POST /api/requests/:id/bids`, `GET /api/bids/mine?tab=active|won|history`,
  `GET /api/shop/fees`, `POST /api/requests/:id/shop-complete`,
  `POST /api/requests/:id/addons` (propose extra work)
- Tow: `POST /api/tow` (customer — standalone or linked via `request_id`),
  `GET /api/tow/mine` (customer's tows with dispatch status),
  `POST /api/tow/:id/cancel` (customer),
  `GET /api/tow/partner/jobs` (partner board — **requires tow login**),
  `POST /api/tow/:id/accept` + `POST /api/tow/:id/pass` + `POST /api/tow/:id/complete`
  (partner, only for offers assigned to them),
  `GET /api/tow/partner/notifications` + `POST /api/tow/partner/notifications/read`
  (in-app notifications), `GET /api/admin/unassigned-tows` (attention list — stubbed admin)

## How escrow works (v1)

Job payments move through states on each request (`payment_status`):
`unpaid` → `held` → `released`, plus `refunded` on cancellation.

1. **Book & Pay** — the customer reviews the bid + terms, checks "I agree,"
   and pays in-app → funds **held**. Requesting/comparing bids never creates
   a payment obligation. Booking is locked.
2. **Shop marks REPAIR COMPLETED** → the customer sees **CONFIRM COMPLETION**
   or **REPORT A PROBLEM**.
3. **Customer confirms** → funds **released**: shop gets `amount_held − $25`
   flat platform fee (e.g. $600 job → shop $575, platform $25). Job closed.
   The $25 acquisition fee is settled out of the release — no separate charge.
4. **Customer reports a problem** → job becomes **disputed**, payout stays
   held during review.
5. **Auto-release** — if the customer ignores the completion request for
   `AUTO_RELEASE_HOURS` (72, configurable in `server.js`), the payout releases
   automatically. A customer can't block a legitimate payout forever.
6. **Cancellation** — customer or shop can cancel an active booking. If funds
   were held, the customer gets a **full refund** (simulated); nothing paid →
   nothing moves. The $25 fee is waived on cancelled jobs.
7. **No-show** — the shop can flag a customer no-show; payout stays held.
   Refund/compensation policy TBD.

**Add-ons:** the shop proposes extra work (description + $) in the app. The
customer must explicitly approve it in-app before it's authorized — never
auto-added. Approved add-ons are paid in-app and join the escrow hold; the
flat $25 fee still applies only once per job.

**Audit trail:** every step is logged to the `job_events` table — request,
bid, selection, terms version + acceptance timestamp, payment, add-on
approvals with timestamps, completion, confirmation/dispute, release/refund.
Queryable per job at `GET /api/requests/:id/timeline` (the two parties on the
job), and shown as "Job history" in the app.

**Configurable constants** near the top of `server.js` (Andrew sets these):

```js
const PLATFORM_FEE = 25;               // ← flat $ the platform keeps per won job
const AUTO_RELEASE_HOURS = 72;         // ← auto-release if customer goes quiet
const TERMS_VERSION = '2026-09-25 v1'; // ← terms shown at Book & Pay
const TOW_FEE = 15;                    // ← flat $ platform cut per completed tow (placeholder — partner terms TBD)
const TOW_ACCEPT_WINDOW_MINUTES = 10;  // ← minutes a tow partner has to accept before the offer rolls to the next partner
```

Change them in that one spot and every payout preview, dashboard stat,
release calculation, countdown, and terms label follows.

## How tow service works (v1) — timed partner dispatch

Right after a customer completes Book & Pay, a popup asks **"Need a tow?"**
— "Request a Tow" opens the tow form with the pickup ZIP, vehicle, and
dropoff shop pre-filled; "No Thanks" dismisses it (never blocks anything).
The home screen's "I Need a Tow" tile opens the same flow standalone, with
no repair booking required.

**Dispatch flow** (no background scheduler in v1 — offer expiry is checked
lazily whenever partner/customer/admin data is read, which is when the
board polls every 20s):

1. A new tow is offered to the **priority-1** partner first — seeded order:
   **Tri-State Tow & Recovery** (Cincinnati) → **NKY Rapid Tow**
   (Covington) → **Queen City Towing** (Norwood).
2. That partner has **10 minutes** (`TOW_ACCEPT_WINDOW_MINUTES`) to accept —
   they see a live countdown on the board and get an in-app notification.
3. If they **pass** or the window **expires**, the offer rolls to the next
   partner in priority order.
4. If **every partner** passes or times out, the tow becomes `unassigned`
   and appears on the **admin attention list** at `/admin/` (stubbed v1 —
   any logged-in user can view; call the customer and arrange a tow manually).
5. While dispatching, the customer sees **"🛻 Finding an available tow
   partner…"** until someone accepts; only then is a driver name/phone shown.

Tow jobs move `requested` → `accepted` → `completed`, plus `cancelled` and
`unassigned`. Every step (offered, expired, passed, accepted, completed,
unassigned) is logged to the repair job's audit trail when linked, and into
the partner's **notification inbox** (🔔 bell with unread badge on the
partner board). Real SMS/push notifications are deferred — the inbox is the
v1 stand-in.

**Partner logins** (password `password123` for all demo accounts):

| Partner | Login | Priority |
|---|---|---|
| Tri-State Tow & Recovery | tow1@example.com | 1 |
| NKY Rapid Tow | tow2@example.com | 2 |
| Queen City Towing | tow3@example.com | 3 |

The partner board at `/tow/partner.html` requires a tow-partner login
(`guard('tow')`) — each partner sees only their own offers, jobs, and
notifications.

**Money:** simulated like everything else. On completion the platform
records its flat `TOW_FEE` ($15 placeholder) cut per tow. The customer-facing
tow price is TBD — the tow partner confirms it directly for now.

**Open decisions:** actual partner revenue terms, who sets/displays the
customer-facing tow price, real SMS/push (Twilio, etc.), and whether to add a
background worker instead of lazy expiry sweeps.

## Phone app (Capacitor) — native iOS/Android wrapper

The mobile-first web UI is wrapped as real native projects with Capacitor
(the phone app and this web app share one codebase — `public/`):

- **`capacitor.config.json`** — appId `com.autorepairbids.app`, appName
  "Auto Repair Bids", webDir `public`. ⚠️ The appId must match the bundle ID
  Andrew registers in Apple Developer — it's one line in this file and easy
  to change before the first TestFlight/App Store submission.
- **`public/js/config.js`** (new, loaded on every page before `common.js`) —
  sets `window.API_BASE` (`""` = same-origin, so local `npm start` dev on
  Windows works exactly as before) and `window.NATIVE_API_BASE`
  (`https://api.autorepairbids.com` — **placeholder**; the real hosted API
  URL goes here once backend hosting is chosen).
- **`public/js/common.js`** — the single `api()` helper now prefixes every
  fetch with `apiBase()`: inside a Capacitor webview calls go to the hosted
  API; in a desktop/mobile browser everything is same-origin as before. It
  also sends `credentials: 'include'` so the cookie login session survives
  cross-origin in the native app (harmless locally).
- **`ios/` and `android/`** — native project shells from `npx cap add ios` /
  `npx cap add android`.
- **Icon + splash** — gold "AB" monogram on midnight navy installed in the
  iOS asset catalog and all Android mipmap densities (incl. round +
  adaptive); navy/gold "AUTO REPAIR BIDS" splash on both. Sources live in
  `app-assets/`.

Workflow commands:

```powershell
npx cap sync          # copy the latest web build into ios/ + android/
npx cap open ios      # open the project in Xcode (needs a Mac)
npx cap open android   # open the project in Android Studio
```

After any change to `public/`, run `npx cap sync` again before building.

**Three blockers only Andrew can clear** (nothing technical left on my side):

a) **Apple Developer Program enrollment** — $99/year on his Apple ID.
   Required before TestFlight or the App Store; nothing can be submitted
   without it.
b) **Backend hosting** — the phone app reaches the API over the internet, so
   `server.js` needs a public home. Options: Render, Fly.io, Railway, or a
   VPS. His account, his call — then the real URL replaces the placeholder
   in `public/js/config.js` and the server gets real payments wired up.
c) **The iPhone build (.ipa) needs a Mac** — it cannot be built on Windows
   or this Linux VM because Xcode is Mac-only. Options: borrow a Mac,
   MacInCloud, Codemagic, or a GitHub Actions macOS runner. (The Android
   .apk CAN be built on Windows with Android Studio.)

## Stubbed for later (not real yet)

- **Real payments** — every "Pay" button in the app is **simulated**: it flips
  the escrow state but no money moves. Real escrow needs a payments provider
  that supports holding funds and split payouts (Stripe Connect is the usual
  choice) plus Andrew's verified business account — that setup needs his
  identity, bank info, and tax details, so it's on him when ready.
- **The $25 fee payment** — wins are recorded in the `fees` table as `pending`
  and marked `paid` automatically when escrow releases (the $25 comes out of
  the customer's held payment, not a separate charge). No real money moves.
- **Google sign-in** — button is on the signup page but shows "coming soon."
  Real OAuth needs a Google Cloud project + client ID.
- **Tow partner logins** — the partner board at `/tow/partner.html` is an open
  demo page; real partner accounts + auth come later.
- **SMS / push notifications** — shops aren't actually notified of new requests
  yet; they'd check the app. (Twilio for SMS is the usual next step.)
- **Native app wrapper** — ✅ done: the web UI is wrapped as native iOS/Android
  projects with Capacitor (see "Phone app (Capacitor)" above). The remaining
  native-app work is Andrew's three blockers: Apple Developer enrollment,
  backend hosting, and a Mac (or Mac cloud service) for the iOS build.

## Open questions (product decisions for Andrew)

From his business-model doc — still to finalize before production:

1. **Payment provider** — exact marketplace payment provider and account
   structure (needs to support holding funds + split payouts).
2. **Payout timing** — when the shop's payout becomes eligible for release
   after completion.
3. **Cancellation & refund policy** — what happens when a job is cancelled
   mid-way or the customer wants a refund.
4. **Disputes** — how disagreements between customers and shops are handled
   and who decides.
5. **No-shows vs the $25 fee** — how no-shows / cancelled appointments affect
   the fee.
6. **Fee permanence** — whether $25 stays or changes with growth
   (`PLATFORM_FEE` in `server.js`).
7. **Add-on charge process** — the exact process for approving and charging
   additional work (the app already requires explicit in-app approval).
8. **Legal terms** — the final terms between Auto Repair Bids, customers,
   and shops (the app's Book & Pay screen shows a summary for now).

From his refunds/disputes/payouts doc — 10 decisions needed before live payments:

9. **Payout waiting period** after completion — how long after confirmation
   before the shop can actually withdraw.
10. **Automatic payout rule** — the app auto-releases after
    `AUTO_RELEASE_HOURS` (72, placeholder); confirm the real period.
11. **Customer cancellation deadline** — how long after booking for a full refund.
12. **Cancellation fees** — whether any apply, and to whom.
13. **Customer no-show policy** — full or partial refund to the customer?
14. **Shop compensation after no-show** — does the shop get anything for a
    wasted appointment slot?
15. **Special-order parts treatment** — who eats the cost if parts were
    ordered and the job cancels.
16. **Dispute filing deadline** — how long after completion a customer can
    report a problem.
17. **Dispute hold duration** — how long a payout can stay held during review,
    and who resolves it.
18. **When the platform fee becomes nonrefundable** — at booking, at
    completion, or never.

Plus a few technical ones:

19. **Distances** are placeholder estimates on the shop side — real
    distance filtering needs geocoding (ZIP → lat/lng) via an API.
20. **Shop verification** is currently honor-system + document upload; decide
    who reviews documents (Andrew? an admin screen?) before launch.
21. **Customer pricing display** — should customers see the platform fee the
    shop pays, or keep it shop-side only?

Tow service (new — decisions needed before launch):

22. **Tow partner terms** — the real revenue split with the tow company
    (the app's `TOW_FEE` is a $15 flat placeholder).
23. **Tow fee amount** — confirm the platform's per-tow cut (currently
    `TOW_FEE = 15` in `server.js`).
24. **Customer-facing tow pricing** — who sets the tow price the customer
    pays (partner quote in-app vs. confirmed by phone)?
25. **Partner logins** — tow partners need real accounts before the board
    at `/tow/partner.html` can go live; right now it's an open demo page.

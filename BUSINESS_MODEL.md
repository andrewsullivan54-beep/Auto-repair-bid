# AUTO REPAIR BIDS — Business Model, Fees & App Flow
*(Pasted from Andrew's ChatGPT working doc, 2026-09-25)*

## THE BASIC IDEA

Auto Repair Bids is a marketplace connecting customers who need vehicle repairs with local repair shops. Instead of a customer calling multiple shops for estimates individually, the customer submits their repair request once. Local repair shops compete by submitting bids.

"Let local shops compete for your business."

Initial launch/testing market: Greater Cincinnati. Start local, expand later.

## CUSTOMER PRICING

100% free for customers to request and compare bids. No membership fee, no account fee, no request fee, no bid fee, no comparison fee. Customer only pays when they choose a shop and book the repair.

## HOW AUTO REPAIR BIDS MAKES MONEY

Flat customer-acquisition fee charged to the winning repair shop. Working amount: **$25 per acquired customer/job**. No monthly shop fees. Losing bidders pay $0. "Only pay when you get a customer."

Example: $600 bid accepted → customer pays $600 → shop gets $575, Auto Repair Bids keeps $25 (plus processor costs depending on final payment setup). $25 is the working fee, can change before launch.

## CUSTOMER FLOW

1. Describe the repair (vehicle info, problem description, location, details) → submit request.
2. Local shops submit bids (parts cost, labor cost, taxes/supplies/other, total, preferred date/availability, warranty).
3. Customer compares bids (price, value, availability, warranty, shop info).
4. Customer chooses a shop. Requesting bids creates NO payment obligation.
5. BOOK & PAY: customer reviews bid, price, terms, policies → agrees → pays agreed amount through Auto Repair Bids → booking confirmed and locked.

## MARKETPLACE PAYMENT MODEL

Use a marketplace-style payment processor (not manual money movement):

CUSTOMER → chooses winning bid → reviews terms → BOOK & PAY → payment secured through marketplace → shop performs work → repair completed/confirmed → shop receives payout → Auto Repair Bids retains acquisition/platform fee.

Provider should handle: connected shop accounts, card processing, shop payouts, refunds, disputes, identity/business verification, marketplace compliance. Prototype does not process real money — live payments integrate before production launch.

## ADDITIONAL REPAIRS

Shop cannot just increase the bill after bid acceptance. Additional repairs discovered after inspection require separate customer approval (e.g., original $600 + newly found $175 → customer approves extra before it becomes authorized). Protects both sides with a clear authorization record.

## REPAIR SHOP VALUE PROP

"Get new customers without paying monthly advertising fees." Bid on jobs you want. Lose: $0. Win: flat $25 acquisition fee. "No Monthly Fees. Only Pay When You Get a Customer."

## CUSTOMER VALUE PROP

"Multiple bids. One request." Compare, choose, then "Book. Pay. Get Back on the Road."

## BRAND

Name: AUTO REPAIR BIDS. Positioning: "Let local shops compete for your business." Also: "DON'T SETTLE FOR THE FIRST PRICE." / "Local Shops. Real Customers. Better Prices." / "Free for Customers." / "No fees. No hassle." / "No Monthly Fees." / "Only pay when you get a customer." / "Book. Pay. Get Back on the Road."

Visual: midnight navy / graphite / black with metallic gold accents. Premium automotive-tech feel, not a classifieds site. Same identity on customer and shop sides.

## INITIAL MARKET

Greater Cincinnati tri-state area (OH/KY/IN) for launch and testing. Start local. Prove the marketplace. Then expand — goal is nationwide, eventually worldwide.

## CORE MODEL IN ONE SENTENCE

Customers use Auto Repair Bids for free to request and compare repair bids; when a customer selects a shop, they Book & Pay the agreed repair price through the app, and the winning repair shop pays Auto Repair Bids a flat customer-acquisition fee.

## CURRENT WORKING NUMBERS

- Customer account: Free; submit request: Free; receive bids: Free; compare bids: Free
- Losing shop: $0; winning shop acquisition fee: $25 (working amount)
- Customer repair payment: full accepted bid amount
- Platform revenue: flat acquisition/platform fee per winning transaction

## STILL TO FINALIZE BEFORE PRODUCTION

- Exact marketplace payment provider and account structure
- When shop payout becomes eligible for release after completion
- Cancellation and refund policy
- Dispute handling between customers and shops
- How no-shows/cancelled appointments affect the $25 fee
- Whether $25 stays permanent or changes with growth
- Exact process for approving/charging additional work
- Legal terms between Auto Repair Bids, customers, shops

## THE SIMPLE VERSION

CUSTOMER POSTS REPAIR FOR FREE → LOCAL SHOPS COMPETE WITH BIDS → CUSTOMER COMPARES → CUSTOMER PICKS A SHOP → CUSTOMER AGREES TO TERMS → BOOK & PAY THROUGH AUTO REPAIR BIDS → BOOKING CONFIRMED → SHOP COMPLETES REPAIR → SHOP GETS PAID → AUTO REPAIR BIDS EARNS ITS FEE

## TOW SERVICE UPSELL (added 2026-09-25)

After the customer completes Book & Pay, the app pops up a tow-service offer in case the vehicle needs towing to the shop. Plan: partner with one tow service to handle all Auto Repair Bids towing, and take a cut on every tow. Also keep the standalone "I Need a Tow" entry point on the customer home screen (per mockups) for tow-only requests. Tow partner terms and the platform's cut per tow are still TBD — make the tow cut a configurable constant.

## TOW DISPATCH SYSTEM (added 2026-09-25)

Tow companies get app access with notifications. When a tow job comes in, the first partner gets an acceptance window — if they don't accept in time, the job automatically passes to the next tow company. Repeat until someone accepts. Acceptance window length TBD (configurable). Real push/SMS notifications to be integrated later; v1 uses in-app notifications + a notification log.

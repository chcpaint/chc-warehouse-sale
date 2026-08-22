# Insurance billing — the plan, and why it is not what Skyline sells

**Status: not built. Wired as a module that refuses to turn on.**
Internal. Written 22 August 2026.

You said insurance may not be worth our while but that being prepared for it is,
and that it should toggle on per customer like Ordering and Inventory. Agreed on
all three. This is what the shape looks like, what it would cost, and — the part
worth reading — why the obvious version of it is the wrong product for us.

The toggle exists today. `utils/modules.js` declares `insurance`, it depends on
Inventory and Kits, and `canSetModule` refuses to switch it on with *"not
available yet — the switch is here so it can be turned on the day it ships."*
Nothing is stubbed or half-wired. The shape is settled so that the day we build
it, a customer asking for it is a configuration change.

---

## The thing to understand first

Shops almost universally bill paint and materials to insurers as

> **refinish labour hours × a material rate**

Not what they used. A number derived from a labour guide. The industry press has
been blunt about this for years: the formula has *"little accuracy or legitimacy
relative to true costs"*, and it typically covers refinish materials only — the
body materials that go into preparing a panel are argued to be included, and are
often simply not paid.
([BodyShop Business](https://www.bodyshopbusiness.com/how-to-get-paid-for-body-repair-materials/))

So the shop is not short of an invoicing tool. **The shop is short of evidence.**

That is the whole opportunity, and it is one refinishAI is already sitting on.
Every consume is stamped with a repair order, a technician, a timestamp, a
quantity and a price. After the kit work, a job's materials are captured as a
single deliberate act rather than reconstructed later. We are the only party in
the chain that knows what a job actually cost in materials — because we are the
supplier and the system of record at the same time.

---

## Two products, and we should be clear which one we mean

### A. "Insurance invoicing" — what Skyline sells at $100/mo

Submit an invoice to a third-party carrier and manage it through payment.
This is an accounts-receivable workflow: carrier profiles, claim and policy
numbers, submission, rejection handling, ageing, reconciliation.

**Recommendation: do not build this.** Reasons, in order of weight:

1. It is not our business. We sell paint and materials. This is billing software,
   and billing software drags in support obligations we have no appetite for —
   when a carrier short-pays, the shop calls whoever built the invoicing.
2. Carriers do not integrate with suppliers. They integrate with estimating
   platforms. We would be building against a door that is not ours to knock on.
3. Skyline already does it and shops that need it have it. Competing there is
   expensive and wins little.
4. It is out of scope in a way that risks the thing we are good at.

### B. **Materials substantiation** — what we should build

Not an invoice to a carrier. A **defensible materials statement per repair
order**, produced from the ledger, that the shop uses however it needs to:
attach to a supplement, hand to an appraiser, support a negotiation, or bill
their own customer.

This is a report, not a workflow. It is perhaps a fifth of the build. It uses
data we already have. And it is genuinely differentiated: nobody else in the
chain can produce it, because nobody else is both the supplier and the system of
record.

The pitch to a shop is one sentence:

> *"When the appraiser says your materials number is high, this is the page that
> settles it."*

**This is the recommendation.** Everything below assumes B.

---

## What B actually is

### The document

One page per repair order:

- Every material consumed, with quantity, unit and price, technician and time
- Kit lines shown as the job they came from, so the story reads as work rather
  than as a list of parts
- Subtotal, an optional configured markup, tax
- The comparison that does the work: **actual cost** against **the allowance the
  formula would have produced** (refinish hours × rate) — the gap, in dollars,
  on the page
- A note that every line traces to a timestamped scan, and cannot have been
  edited after the fact

That last point is not marketing. The ledger refuses UPDATE at the database
level and kit consumptions are append-only. A materials statement out of
refinishAI is evidence in a way a spreadsheet is not, and that is worth stating
plainly on the document itself.

### What has to be built

| | |
|---|---|
| Refinish hours per RO | The one input we do not have — see below |
| Materials rate per company | Config. Trivial. |
| The statement itself | HTML and PDF, from data we hold |
| Batch export | Month of ROs to CSV, for the office |
| Module gate | **Already done** |

**The gap: we do not know refinish hours.** Without them there is no allowance
to compare against, and the comparison is most of the value. Three ways to get
it, cheapest first:

1. **Type it in.** One number on the RO when the statement is produced. Zero
   integration. Should ship first regardless of what follows it, because it
   makes the feature work on day one for every shop.
2. **Import an estimate file.** The industry standard is CIECA **BMS** — modern
   XML, selective, and Mitchell and Audatex both committed to free exports;
   CCC brokers theirs through Secure Share at about $0.50 per repair order. The
   older **EMS** format is dBase IV and unsupported since 2003, so read it if a
   shop hands us one but do not build toward it.
   ([Repairer Driven News](https://www.repairerdrivennews.com/2017/11/01/mitchell-audatex-pledge-to-offer-shops-free-bms-exports/),
   [CCC Secure Share](https://www.cccsecureshare.com/))
3. **PPG PaintManager XI.** See below.

Estimate ~3 weeks for the statement plus manual hours entry; ~2–3 more for a BMS
importer. Not now — but worth knowing it is that small.

---

## PPG PaintManager XI

You said our customers run PaintManager XI, which changes the mixing-system
question from "which one?" to "this one".

What is publicly known: PPG launched PaintManager XI as the successor to
PaintManager, and in July 2025 linked it to their own **AdjustRite** estimating
platform so estimate data transfers automatically *"eliminating duplicate data
entry when tracking paint material usage and job costs"* — which is precisely
the loop we are describing, built inside PPG's own walls, for shops using both
PPG products.
([CollisionWeek](https://collisionweek.com/2025/07/23/ppg-links-estimating-paint-management-software-commercial-repair-shops/),
[Collision Repair Mag](https://www.collisionrepairmag.com/news/collision-repair/article/15716630/ppg-ppg-launches-paintmanager-xi-software))

What is **not** publicly known, and I will not guess at: whether PaintManager XI
exposes an API, a file export, or a reachable local database for a third party.
The trade coverage does not say, and PPG publishes no integration documentation
I could find.

**This is a phone call, not a research task, and it is the highest-value next
action on this whole page.** CHC is a PPG distributor. Ask the PPG rep directly:

1. Does PaintManager XI export mix and job data — API, scheduled file, or a
   local database we may read?
2. Is there a partner or integration programme for distributors?
3. What does the AdjustRite ↔ PaintManager XI link actually move, and is that
   pipe open to anyone else?

The answer changes the plan more than anything else on this page. If mix data is
reachable, a paint mix booked in PaintManager XI can post its own consume rows
into refinishAI — which closes the single largest gap against Skyline **and**
makes the materials statement complete rather than nearly complete, because
mixed paint is the biggest line on most jobs and the hardest to capture by
scanning.

If it is closed, the fallback is fine and unchanged: technicians scan mixed
components off the shelf, which they can already do today.

### One engineering note for whenever this lands

Whatever the answer, an integration that fetches a URL a customer configured
needs an egress allowlist and pinned destinations before it ships. We should not
add a feature whose job is to make our server reach an address someone else
chose. It is a day of work if designed in, and a bad week if bolted on.

---

## How it turns on

Same as everything else now. `PUT /api/admin/companies/:id/modules/insurance`,
or the Modules button on the company row. Today it refuses with a reason. When
it ships, the refusal is deleted and one line in the registry changes:

```js
insurance: { ..., released: true }
```

Dependencies are declared and enforced on read, not just on write: insurance
requires Kits, which requires Inventory. Turning Inventory off turns both off
for as long as it is off, and turning it back on restores them — no settings,
stock, history or mappings are ever destroyed by a toggle. That property is
tested, because a customer who fears losing their data will never agree to trial
a module.

---

## Recommendation

1. **Do not build carrier invoicing.** Position it out: we are the supplier, our
   job is the shelf, the job cost and the evidence. If a shop needs claims
   submission they can keep the tool they have — the two do not conflict.
2. **Build materials substantiation when a customer asks twice.** Not before.
   It is ~3 weeks and it is a genuinely defensible differentiator.
3. **Make the PPG call this month**, independent of 1 and 2. It is free, it is
   the largest open question in the product, and the answer decides whether our
   biggest competitive gap closes or stays open.
4. **Ship manual refinish-hours entry with the statement** rather than waiting
   for an estimate integration. The comparison is the value; where the number
   comes from is not.

---

## Sources

- [How to Get Paid for Body Repair Materials — BodyShop Business](https://www.bodyshopbusiness.com/how-to-get-paid-for-body-repair-materials/)
- [Paint and Material Allowances — BodyShop Business](https://www.bodyshopbusiness.com/paint-and-material-allowances/)
- [Mitchell, Audatex pledge to offer shops free BMS exports — Repairer Driven News](https://www.repairerdrivennews.com/2017/11/01/mitchell-audatex-pledge-to-offer-shops-free-bms-exports/)
- [CCC Secure Share](https://www.cccsecureshare.com/)
- [PPG links estimating and paint management software — CollisionWeek](https://collisionweek.com/2025/07/23/ppg-links-estimating-paint-management-software-commercial-repair-shops/)
- [PPG launches PaintManager XI — Collision Repair Mag](https://www.collisionrepairmag.com/news/collision-repair/article/15716630/ppg-ppg-launches-paintmanager-xi-software)
- [PPG Integrates AdjustRite with PaintManager XI — BodyShop Business](https://www.bodyshopbusiness.com/ppg-integrates-adjustrite-estimating-platform-with-paintmanager-xi/)

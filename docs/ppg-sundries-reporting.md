# PPG paint lines vs sundries

Every item a shop buys is reported in one of two groups, by shop, by month and by item:

| Group | What is in it |
|---|---|
| **PPG paint lines** | Paint-based products from PPG lines: Envirobase / EHP, Shopline, OneChoice, Deltron, Delfleet (Essential and Evolution), Omni, Vibrance, Nexa Autocolor, and other PPG paint (industrial lines, epoxy primers, clears, hardeners, reducers). |
| **Sundries** | Everything else: every other brand, and PPG-branded general items that are not paint, such as paint suits, masking paper, mixing cups, sticks and lids, empty cans, spray-out cards, test panels, labels, and shop or mixing equipment. |

The rule lives in `utils/report-groups.js`, in this order:

1. A correction CHC made for the part number wins (`report_item_groups`).
2. An item that says nothing about PPG or a PPG line (brand, name, category) is a sundry.
3. A PPG item that is a general, non-paint item (category Masks/Suits, Equip/Filter/Booth or PPS/Cans, or a name such as "Paint Suit", "Masking Paper", "Mixing Cups") is a sundry.
4. Anything else from PPG is PPG paint, named by its line from the brand, name or part number (T4xx EHP, J… Shopline, SU/SX/SL OneChoice, ES…/F3… Delfleet, DT/DP/DX… Deltron, MC/MP/MR/MH Omni), otherwise "Other PPG".

## Where it shows

* **Shop console, Reports:** the "PPG paint lines vs sundries" card, using the screen's Shop and Period filters. Views: by shop, by month (per shop when All shops is chosen), by item, PPG by line. Each view downloads as a CSV. The same access rules as the rest of Reports apply: with "Reports for signed-in accounts only" the shared code gets nothing, and a person tied to one shop only ever sees that shop. A shop with pricing hidden sees units only.
* **CHC console, Reports > PPG vs sundries:** the same report for any customer, any shop.

Basis: item dollars before tax, delivery fee and fuel surcharge, by order date (Toronto time). Cancelled orders are not counted. A line still "price on request" counts its units, not dollars.

## Corrections

A super admin can move a part number to the other group: "Move to sundries" / "Move to PPG" on the By item view, or the Corrections form under it. A correction applies to every customer's reports and to rebates scoped to PPG paint or sundries, is written to the audit log, and "Back to the rule" removes it.

## Rebates

A rebate can now apply to **PPG paint lines only** or **Sundries only** (Companies > % > Applies to), using the same rule, so paint suits never earn a PPG rebate. Existing rebates (Assured: 5% of all items) are unchanged.

## Database

Migration `063_report_item_groups.sql`: creates `report_item_groups` (server-only, RLS on, no policies) and lets `company_rebate_rules.applies_to` take `ppg_paint` and `sundries`. It changes no data. Until it runs, the reports work (no corrections), and choosing a PPG or sundries rebate says to run it.

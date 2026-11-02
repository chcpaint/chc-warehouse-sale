# Insurance Kit Submissions

A standalone module (`kit_submissions`) that lets a shop pick a repair kit, add the
repair order and claim details, and get a **numbered PDF** itemizing the kit's
materials to attach in Mitchell, CCC ONE or Audatex. Each PDF is saved in the shop's
console under **Insurance Kits → Saved submissions**.

It does not need the Inventory module and never touches stock.

## Turning it on for a shop

1. Run `migrations/051_kit_submissions.sql` in the Supabase SQL editor (once).
2. Admin console → Companies → the shop → **Modules** → switch on
   *Insurance kit submissions*.
3. Admin console → Companies → the shop → **Repair kits** (the boxes icon):
   switch on the kits the shop may use, and map each kit line to the shop's own
   product (and set the "price they pay" where it differs from the catalogue). A kit
   with any unmapped or unpriced line shows as "not set up for your shop yet" and
   cannot be submitted. This is the same mapping the Inventory kits use, so a shop that
   already has kits set up needs nothing more.

The shop then sees **Insurance Kits** in its menu.

## What the shop does

Choose a kit, enter the repair order (required), claim, insurer, vehicle and VIN,
optionally change a quantity or untick a line, and press **Generate PDF**. The PDF opens
and is saved. From the saved list they can reopen or download it again, mark it **Paid**
when the insurer pays, or **Void** it (with a reason).

## Numbering

Numbers look like `AC-00007`: a short prefix for the shop (initials of its name; a digit
is added if another shop already has the same prefix) and a counter that only goes up.
The counter is incremented in the database under a row lock
(`next_kit_submission_no()`), so two people generating at the same moment cannot receive
the same number, and `submission_no` is also unique platform-wide. A number can be
skipped if a later step fails; it is never reused.

## The document

* The header logo is the **supplier's**. For every CHC customer it is the CHC logo
  uploaded in the admin console under **Branding** (the same file the sign-in page and
  portal show; it is re-read at most every minute, so a new upload appears quickly).
  If none has been uploaded it falls back to the CHC distributor's `logo_url`, then to
  the plain logo shipped with the app. A customer of another distributor gets that
  distributor's own `logo_url`, or its name if it has none; CHC's logo is never lent to
  another distributor. The uploaded logo must be a PNG or JPEG (GIF and WebP cannot be
  embedded in a PDF and are skipped), and it is checked for corruption before use,
  because a corrupt PNG would otherwise crash the server.
  The shop's name appears as the submitter.
* Brand, part number, description, quantity, unit price, extended price, total, a
  one-line note to paste into the estimate's attachment note, and the shop's notes.
* **Frozen at generation.** Lines, prices and names are copied into the row. A later
  catalogue or kit change does not alter a submission an insurer already holds, and the
  database refuses to update a submission's content or delete it (only status moves).

## Rules carried over from kit consumption

* Nothing is guessed: an unmatched kit line blocks generation and says so.
* A line with no price blocks generation, so a document never under-states a job.

## Files

| File | Role |
| --- | --- |
| `migrations/051_kit_submissions.sql` | tables, counter function, immutability guard |
| `utils/modules.js` | the `kit_submissions` module |
| `routes/kit-submissions-store.js` | shop API: kits, preview, create, list, PDF, status |
| `utils/kit-submission-pdf.js` | PDF builder (pdfkit) and supplier-logo loader |
| `public/kit-submissions.js` | the shop's screen, loaded only when the module is on |
| `tests/kit-submissions.test.js` | module gate, numbering, freezing, tenancy, PDF, logos |

## Kit mapping: off by default for shops without inventory

A shop that does **not** have the Inventory module turned on does not need to
map its kits to products. Its kit lines are resolved automatically:

1. the shop's own catalogue product with the same part number (its own price
   unless the item is price-on-request), otherwise
2. the CHC item library entry for that part number (list price).

A part found in neither is reported as "not in the CHC item library yet" and
blocks that submission until CHC adds it. An explicit mapping, when one exists,
always wins. The admin kit list shows "No mapping needed" and an optional
**Map** button for these shops.

To require mapping for a specific shop anyway, set
`settings.kit_submissions.require_mapping = true` on the company.

## API rate limits

The site-wide limiter is now per signed-in person instead of per IP: a verified
admin/user/company token gets its own bucket (`RATE_LIMIT_AUTH_MAX`, default
3000 per 15 minutes); anonymous traffic stays at `RATE_LIMIT_MAX` (default 100)
per IP. Tokens are verified, so a forged one only falls back to the IP bucket.
See `utils/rate-limit.js`.

## Add Kit (customers build their own kits)

Under **Insurance** in the main menu there are two links: *Insurance Kits* and
*Add Kit*. Add Kit opens a builder: name the kit, search for parts by part
number or name, set a quantity for each, save. The kit is private to that shop
(`repair_kits.company_id` set, `source = 'company'`) and appears in its kit list
straight away; lines are priced the same way as any other kit.

- Parts a shop can pick: its own catalogue, plus the CHC item library when the
  shop does not run inventory. A shop that does run inventory can only use its
  catalogue, because its kit lines must be mapped.
- Nothing is invented: every part number is checked server-side, duplicates and
  non-positive quantities are refused, and a repeated kit name is refused.
- A shop can remove its own kits (soft remove; saved submissions keep their
  record) but can never change or remove a CHC master kit.
- Turn it off for one shop with `settings.kit_submissions.allow_add_kit = false`.
- API (under `/api/store/:slug/kit-submissions`): `GET /parts?q=`,
  `POST /my-kits`, `DELETE /my-kits/:kitId`. `GET /kits` now returns `own` per
  kit and `allow_add_kit`.

## Edit Kits (change parts, quantities and prices)

Off by default. Switch it on for a shop with
`settings.kit_submissions.allow_edit_kits = true` (see
`chc-leons-allow-kit-editing.sql`). The shop then sees **Edit Kits** under
Insurance in the main menu and an **Edit kits** button on the Insurance Kits
screen.

- A CHC master kit is shared by every shop and is never edited. The shop first
  takes its own copy (**Make my copy to edit**), which carries across anything
  already changed for it (dropped lines, quantities, prices). The CHC original
  is hidden from that shop's list by default so there is one version of it.
- In the editor a shop changes quantities, removes parts, adds parts (same
  search as Add Kit) and sets a price per line, then saves. Part numbers of
  existing lines are fixed.
- A price is stored per shop against the line (`kit_product_map.unit_price_override`,
  with the line's own product kept so it keeps resolving). Leaving a price alone
  does not freeze it; clearing it returns the line to the catalogue or CHC
  library price. Previews, saved submissions and PDFs all use the shop price.
- Nothing is saved unless the whole kit validates: parts must be ones the shop
  can use, no repeats, quantities above zero, prices zero or more.
- API (under `/api/store/:slug/kit-submissions`): `GET /my-kits/:kitId`,
  `PUT /my-kits/:kitId`, `POST /kits/:kitId/customize`. `GET /kits` also returns
  `allow_edit_kits`.

## Tax on submissions (13% on every account)

Every kit submission carries tax. The rate comes from the same place an order's
tax does (`utils/tax.js`): exempt account 0%, the account's own rate, its region's
rate, the distributor's rate, otherwise **13% (Ontario HST)**. So every account is
charged 13% unless it has been set otherwise under Companies → Tax.

- The preview shows Subtotal, HST (13%) and Total; the PDF prints the same.
- Stored on the row and frozen with it (`migrations/052_kit_submission_tax.sql`):
  `subtotal_amount`, `tax_rate`, `tax_amount`, `tax_label`; `total_amount` is
  subtotal + tax (what is billed). A later rate change never alters a saved document.
- Submissions created before the migration have no tax columns and print exactly as
  they did (Total only); they are not recalculated.
- Run the migration **before** deploying the code that writes the new columns.

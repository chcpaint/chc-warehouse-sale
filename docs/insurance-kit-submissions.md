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

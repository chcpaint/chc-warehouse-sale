# Catalog import: any file layout

Suppliers each export their own layout. The importer (`utils/sheet-detect.js`, used by
`POST /api/admin/companies/:id/catalog-upload`) works out the columns itself instead of
expecting one fixed format.

## What it handles

- CSV with comma, semicolon, tab or pipe separators; UTF-8, UTF-16 and Windows-1252 text; XLSX/XLS with several tabs.
- A title block above the headings, or no headings at all.
- Different heading names ("Part Number", "Desc.", "Your Net", "List Price", French/German basics).
- Part numbers keep leading zeros (`05916`); prices like `$1,234.50` and `3,69` (decimal comma).
- Rows pushed right by unquoted commas in a description are realigned (checked against the price column).
- A heading row that sits offset from its data is matched up by content.
- Quantity, discount % and id columns are never taken for the price. A "price" column full of words is refused.
- Preference for the price: net/your/sell price, then list/MSRP, then cost. A list price also fills "was price" when a net price exists.

## When it cannot tell

It never invents a price. If no column holds prices (or product names) the API answers **422** with
`needs_mapping: true` and the columns plus the first lines of the file, and the admin screen shows them.

## Editing the reading (Preview screen)

After Preview the admin sees the first lines of the file with a dropdown above every column
(Part #, Product name, Price, List/was price, Brand, Category, Description, Unit, Case qty, Image URL, not used),
arrows / drag to move columns beside each other, and a "Headings are on line" box. **Preview again** re-reads with the
choices; Apply is disabled until the changed layout has been previewed.

API: `column_map` (JSON `{"sku":0,"name":1,"price":3,"previous_price":null}`, 0-based; `null` = not in this file) and
`header_row` (1-based line, `0` = no headings). The response carries `mapping_info` (mapping, where each choice came from:
`header` / `content` / `manual`, columns, preview lines, warnings, lines realigned). The mapping used is written to the audit log.

## Files with no prices (a new manufacturer catalog)

AccountEdge's new-items export has no headings and every price is `$0.00`. A column of zeros is never taken for the price.
When a file has no price heading and no price-like column (or a price column left blank), the parts are read by part number and name:

- A **new** part is added as **price on request** (`price = 0`, `price_on_request = true`): customers see "Contact for current
  pricing" and an employee sets the price in Customer Pricing, which clears the flag. Nothing reads as free.
- A part the company **already has** keeps its price untouched.
- Optional checkbox *Price new items from the master list*: new parts with no file price take `item_library.list_price` when the master has one (off by default).

A price heading over unusable values (e.g. "call") is not treated as "no prices": the screen asks the person to choose.

## Renamed items and possible duplicates (`utils/catalog-review.js`)

Identity is the **part number** (case and punctuation ignored: `MMM-06652` = `MMM06652`), never the name.

| Incoming line | What happens |
|---|---|
| Same part number, same wording | Normal update (price rules above). The part number stays as the company stores it. |
| Same part number, new wording | **Renamed.** Default: use the new name (price untouched). The person can choose *Keep the current name*. Old and new names go to the audit log. |
| New part number, wording matches something already there | **Possible duplicate. Held**: nothing is written until the person chooses *Add as a new item*, *Same item - new part number* (updates the existing product's part number and name, price untouched) or *Skip it*. |
| Size / grit / volume differs (P80 vs P120, 310mL vs 400mL) | Different items, never flagged. |
| Same part number twice in one file | First line counts; the rest are counted and ignored. |

API: `decisions` = JSON `{"<part number>": "add" | "update" | "replace_sku" | "skip"}`; the response carries `review`, `renamed`,
`held`, `file_duplicates`, `sku_replaced`, `added_unpriced`. In the admin Preview each flagged item has a dropdown; Apply is
disabled after a change until Preview is run again.

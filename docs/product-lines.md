# Product lines: EHP, OneChoice, Shopline

These are PPG lines. Catalogues file them under the brand "PPG", with the line in the
item's name, category or part number. A line is therefore a **filter**, not a brand:
the item belongs to it when any of the line's terms appears in its brand, category,
name or part number (case-insensitive). The terms live in one place, `utils/product-lines.js`.

Where a line is offered, and how it filters:

| Screen | Drop-down | Filter |
|---|---|---|
| Storefront | Brand | `orFilterFor(line)` |
| Admin > Products | Brand | server `applyBrandFilter`; client `productInBrand` |
| Admin > Customer Pricing | Brand | `applyBrandFilter` (list, preview and apply share it) |
| Admin > Item Library | Supplier > "Product lines" | `lines=` param to `search_item_library(p_lines)` |

Typing a line name in the Library search box also works (the word match covers brand and
category as well as name and part number).

Migration `057_product_lines_in_library.sql` copies each distinct line part that any
company sells into the master `item_library` (no list price, so "Needs pricing";
`source = 'catalogue_backfill_lines'`) and replaces `search_item_library` with a version that
takes `p_lines`. It touches nothing but `item_library`. To undo the copy:
`delete from public.item_library where source = 'catalogue_backfill_lines';`

The Library's "Hide items this shop already sells" box is ticked by default, so for a shop that
already carries a part (such as Assured) the part is hidden until that box is cleared.

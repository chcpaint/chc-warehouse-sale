/**
 * public/help-content.js -- every how-to answer in one place.
 *
 * Used by the Help page (/help) and by the help assistant (the round button,
 * bottom right). Edit an answer here and both change. Plain text only.
 */
window.RAI_HELP = {
    updated: '2026-11-11',
    support: { name: 'Adam Berube', email: 'adam@chcpaint.com' },
    areas: [
        {
            id: 'start', title: 'Getting started', audience: 'shop',
            items: [
                { q: 'How do I sign in to my shop\'s console?', k: 'login sign in access code password location start',
                  a: 'Go to your shop\'s address (for example chcsale.com/store/your-shop). Enter your access code, or your email and password if your shop uses individual logins, then pick your location and press Enter.' },
                { q: 'I forgot my password. How do I reset it?', k: 'forgot password reset locked out',
                  a: 'On the sign-in screen choose "Forgot password", enter your email and follow the link we send. The link expires, so use it soon. If your shop uses one shared access code, ask your manager or CHC for it.' },
                { q: 'How do I switch to another location?', k: 'switch location shop change branch',
                  a: 'Sign out from the menu and sign back in, then pick the other location. If your account is tied to one location, you will only ever see that one.' },
                { q: 'Where is the menu?', k: 'menu navigation sidebar hamburger find',
                  a: 'On a computer the menu is down the left side (or the tabs across the top in the classic look). On a phone or tablet, press the three-line button at the top left.' },
                { q: 'What is the Today screen?', k: 'today home dashboard what needs',
                  a: 'Today opens first in the new look. It shows what needs a person: items below their minimum, reorders waiting for approval, orders out for delivery or in progress, and your recent orders. It only reads your data; it never changes anything.' }
            ]
        },
        {
            id: 'ordering', title: 'Ordering from CHC', audience: 'shop',
            items: [
                { q: 'How do I place an order?', k: 'order place buy checkout submit products cart',
                  a: 'Open Products, add items to the Cart (search, filter by brand or category, or scan a barcode into the scan box), then open the Cart, check quantities, fill in the order details and press Place Order.' },
                { q: 'Can I scan a barcode to add an item to my cart?', k: 'scan barcode add cart scanner camera',
                  a: 'Yes. On Products, click into the scan box and scan the item\'s barcode or shelf label with a USB or Bluetooth scanner, or type the part number and press Enter. Scanning the same item again adds another.' },
                { q: 'When do I need a PO number?', k: 'po purchase order number required',
                  a: 'Your shop\'s PO rule is set by CHC. If the cart asks for a PO number, the order cannot be sent without one; some accounts only need it above a dollar amount.' },
                { q: 'Who else sees my cart?', k: 'cart shared team others',
                  a: 'The cart is shared by everyone signed in to your shop\'s account, so a teammate can add to it and one person can send it.' },
                { q: 'How do I see my past orders and invoices?', k: 'order history past invoices status track',
                  a: 'Open Order History. Each order shows its status (for example Processing, Out for delivery, Closed) and, once CHC uploads it, the invoice to download.' },
                { q: 'What does it mean when an order is partial or on backorder?', k: 'partial backorder missing short follow up invoice',
                  a: 'CHC shipped part of the order and the rest is on backorder. The order shows which items are still to come, and a follow-up invoice is added when they ship.' },
                { q: 'Where are promotions?', k: 'promotions deals sale specials discount',
                  a: 'Open Promotions to see current deals from CHC. Promotional prices apply in the cart automatically.' },
                { q: 'How do I contact CHC about an order?', k: 'contact chc message question order help branch',
                  a: 'Open Contact CHC to see your branch\'s contacts and send a note. For problems with the software itself, use the support email at the bottom of every page.' }
            ]
        },
        {
            id: 'inventory', title: 'Stock (refinishAI Inventory)', audience: 'shop',
            items: [
                { q: 'How do I see what is in stock?', k: 'stock on hand inventory levels see what we have',
                  a: 'Open Stock on Hand, then the Stock tab. Every item shows its on-hand quantity, its minimum and maximum, and whether it is OK, low or out.' },
                { q: 'How do I record that we used something?', k: 'use consume scan out took used take',
                  a: 'Open Stock on Hand, Scan tab, choose Use, put your name in "Working as", and scan each item (scan again to add another). Add a job or RO number if you like, then press Post. Nothing changes until you post.' },
                { q: 'How do I receive a delivery?', k: 'receive delivery arrived deliveries incoming shipment',
                  a: 'Open Stock on Hand, Deliveries. Pick the delivery, scan or tick each item as it comes off the truck, mark anything damaged, short or extra, then close it. Exceptions go to CHC automatically.' },
                { q: 'How do I count stock?', k: 'count cycle count stocktake physical inventory',
                  a: 'Open Stock on Hand, Count. Start a count for the shelf or area, scan each item and enter how many are there, then finish. Differences are shown before stock is changed.' },
                { q: 'How do reorders work?', k: 'reorder minimum maximum min max automatic draft approve',
                  a: 'When an item drops below its minimum, a draft reorder is built to bring it back to its maximum. A manager opens Reorder, checks or changes the lines, and presses Approve & send to CHC.' },
                { q: 'How do I set an item\'s minimum and maximum?', k: 'set minimum maximum min max level reorder point',
                  a: 'Open Stock on Hand, Stock, find the item and edit its minimum and maximum. Base them on how many you use in the time it takes CHC to deliver, plus a little extra.' },
                { q: 'How do I move stock to another location?', k: 'transfer move stock another location shop',
                  a: 'Open Stock on Hand, Transfer. Pick the item, the quantity and the location it is going to. The other location receives it when it arrives.' },
                { q: 'How do I print shelf labels?', k: 'print labels shelf barcode label sticker',
                  a: 'Open Stock on Hand, Stock, choose the items and press Print shelf labels. Each label has a barcode your scanners and the kiosk can read.' },
                { q: 'How do I see what we used and when?', k: 'usage history report consumption who used',
                  a: 'Usage shows what was used over time; History shows every stock movement, who made it and why, and can be exported.' },
                { q: 'Can I use my phone to scan?', k: 'phone camera scan iphone android',
                  a: 'Yes. On the Scan screen press Camera and point it at the barcode. A USB or Bluetooth scanner is faster for a lot of items.' }
            ]
        },
        {
            id: 'kiosk', title: 'Scan-out kiosk (tablet)', audience: 'shop',
            items: [
                { q: 'How do painters and techs scan out at the kiosk?', k: 'kiosk tablet scan out badge painter tech',
                  a: 'Scan your ID badge (if your shop uses badges), scan each item you take, adjust the quantity if needed, then press Confirm & Done. The screen clears by itself when left idle.' },
                { q: 'How do managers order from the kiosk?', k: 'kiosk place stock order passcode manager',
                  a: 'Press Place Stock Order at the bottom of the kiosk, enter the manager passcode, scan the items to order, and send. The tablet returns to scan-out mode afterwards.' },
                { q: 'A badge or item will not scan at the kiosk. What do I do?', k: 'kiosk badge not working wont scan unknown',
                  a: 'Type the code on the badge or item into the box instead. If the item is unknown, tell your manager so it can be added with its barcode; a lost badge can be replaced from the console.' }
            ]
        },
        {
            id: 'kits', title: 'Repair kits and insurance kits', audience: 'shop',
            items: [
                { q: 'What is a repair kit?', k: 'repair kit kits materials job',
                  a: 'A set list of materials for a type of job. Applying a kit to a repair order takes all its materials out of stock in one step.' },
                { q: 'How do I make an insurance kit PDF?', k: 'insurance kit pdf mitchell ccc audatex claim submission',
                  a: 'Open Insurance Kits, choose Add Kit, pick the kit, enter the repair order, claim and vehicle details, and save. You get a numbered PDF itemising the materials to load into your estimating system, and it is kept in your console.' },
                { q: 'Can I change a kit?', k: 'edit kit change kit lines',
                  a: 'If CHC has turned on Edit Kits for your shop, you can adjust kits there. Otherwise ask CHC.' }
            ]
        },
        {
            id: 'reports', title: 'Reports and Insights', audience: 'shop',
            items: [
                { q: 'Where are my reports?', k: 'reports spending report by location month',
                  a: 'Open Reports. Choose the shop and the period to see spending, orders and items, and export them.' },
                { q: 'What is Insights?', k: 'insights ai advice suggestions analysis claude',
                  a: 'Insights (on the Reports screen, where CHC has switched it on) reads a summary of your own numbers and suggests what is going well, what may be worth acting on, and what may be worth a closer look. It is advice only and changes nothing. You can see exactly what was sent.' },
                { q: 'How do I see PPG paint versus sundries?', k: 'ppg sundries split paint envirobase enviro ehp shopline onechoice deltron delfleet omni by shop compare',
                  a: 'Open Reports. The PPG paint lines vs sundries card splits your item dollars in two: PPG paint lines (Envirobase / EHP, Shopline, OneChoice, Deltron, Delfleet, Omni and other PPG paint) and sundries (everything else). Pick a shop or All shops and a period at the top, then view it by shop, by month, by item or PPG by line, and download any view as a CSV.' },
                { q: 'Are paint suits and other PPG general items counted as PPG?', k: 'paint suit masking paper cups cans general items ppg sundries excluded rebate',
                  a: 'No. PPG-branded general items that are not paint, such as paint suits, masking paper, mixing cups and sticks, cans and lids, spray-out cards and shop equipment, count as sundries, in reports and in PPG rebates. If an item looks to be in the wrong group, tell CHC and they can correct it.' },
                { q: 'Which dates and dollars do the reports use?', k: 'dates dollars before tax order date cancelled basis',
                  a: 'Reports use the order date and item dollars before tax, delivery fee and fuel surcharge. Cancelled orders are not counted. Items still to be priced count as units until they are priced.' },
                { q: 'How is our rebate worked out?', k: 'rebate earned percent monthly quarterly eligible spend',
                  a: 'Where CHC has set up a rebate, Reports shows it: the rate, what it covers (everything, PPG paint lines, sundries, or chosen brands and categories), and what you have earned each period on item dollars before tax. It is paid separately; nothing is taken off your orders.' },
                { q: 'Why can\'t I see Reports?', k: 'reports missing hidden cannot see',
                  a: 'Some shops limit Reports to people with their own login. Sign in with your own account, or ask your owner to invite you.' }
            ]
        },
        {
            id: 'account', title: 'Your team and account', audience: 'shop',
            items: [
                { q: 'How do I add people to my shop\'s account?', k: 'team invite user add person staff login',
                  a: 'If your shop uses individual logins, the owner opens Team and invites people by email. Each person sets their own password.' },
                { q: 'What is People & activity?', k: 'people activity who ordered signed in spend',
                  a: 'An owner view, where switched on, of who ordered, how much each person spent and who signed in.' },
                { q: 'Where do I manage our subscription?', k: 'billing plans subscription pay',
                  a: 'If your shop is on a paid plan, open Plans & billing. Many shops use the console at no charge.' }
            ]
        },
        {
            id: 'security', title: 'Security, privacy and AI', audience: 'shop',
            items: [
                { q: 'Is our data encrypted?', k: 'encrypted encryption secure https at rest transit data safe',
                  a: 'Yes. Every page and request uses HTTPS, browsers are told to use HTTPS only, and the database and stored files are encrypted on disk by our database host, Supabase.' },
                { q: 'Can another shop see our orders or prices?', k: 'other shop see our data separate isolation privacy customer',
                  a: 'No. Our server checks every request against the signed-in company and location, so one shop cannot read another shop\'s orders, stock or prices.' },
                { q: 'How are passwords protected?', k: 'password stored hashed bcrypt safe',
                  a: 'Passwords are never stored. Only a one-way hash (bcrypt) is kept, so nobody, CHC included, can read one. Reset links expire, sign-ins end after 12 to 24 hours, and repeated failed sign-ins are slowed down and then blocked.' },
                { q: 'Where is our data kept and is it backed up?', k: 'data location where stored backup backups country canada us',
                  a: 'In the United States (US West), with Supabase for the database and Railway for the app. The database is backed up automatically by Supabase. Scheduled restore drills are being put in place.' },
                { q: 'Is there a record of changes?', k: 'audit trail record changes history who changed',
                  a: 'Yes. Changes CHC staff make to customers, prices, users and settings are recorded with who, what and when, and every stock movement records who made it.' },
                { q: 'Where does the software use AI?', k: 'ai artificial intelligence where used llm claude anthropic',
                  a: 'In two places only: Insights on the Reports screen (where CHC has switched it on), and price-screenshot reading in CHC\'s own console. Each use is one call, is logged, and cannot change any data. The Help page lists exactly what each one sends.' },
                { q: 'What does Insights send to the AI?', k: 'insights send data privacy what is sent personal',
                  a: 'A summary of your own numbers: order counts and spend, top items and categories, stock levels and kit totals. No names, emails, phone numbers, addresses, PO, repair-order or claim numbers, VINs or notes, and no dollar figures if your shop has pricing hidden.' },
                { q: 'Is this help assistant AI?', k: 'assistant chatbot bot ai help button how does it work',
                  a: 'No. It searches this written guide on your own device and sends nothing anywhere. If it cannot find an answer it gives you the email for the CHC team.' },
                { q: 'Where is the full help guide?', k: 'help page guide security documentation link menu',
                  a: 'Press "Help, security & AI" at the foot of the left menu. It opens the full guide: how-to answers, security and data protection, and where AI is used.' },
                { q: 'Who do I contact for help?', k: 'contact support email help person phone',
                  a: 'For how-to questions, email info@chcpaint.com. For problems with the software itself, or security questions from your IT team, email Adam Berube at adam@chcpaint.com. The support link is at the bottom of every page.' }
            ]
        },
        {
            id: 'chc', title: 'CHC admin console', audience: 'chc',
            items: [
                { q: 'How do I add a new customer?', k: 'add company customer new shop create',
                  a: 'Open Companies and press Add Company. Set its name, contact and access code, then add its locations.' },
                { q: 'How do I switch features on or off for a customer?', k: 'modules switch on off features inventory kits new look insights',
                  a: 'In Companies, click the boxes icon on the customer\'s row ("Modules this customer has") and switch each module on or off. A customer who only orders keeps everything off and sees the plain ordering screens.' },
                { q: 'How do I move an order through its stages?', k: 'orders status processing out for delivery closed desk',
                  a: 'Open Orders, pick the order, and set its status as it moves (for example Processing, Out for delivery, Closed). The customer is emailed at the stages your settings call for.' },
                { q: 'How do I record a partial shipment or backorder?', k: 'partial backorder shipment follow up invoice',
                  a: 'On the order, tick Partial / backorder and choose the items still to come. The order then asks for a follow-up invoice when they ship.' },
                { q: 'How do I attach an invoice to an order?', k: 'upload invoice pdf attach',
                  a: 'Open the order and press Upload invoice. The customer can download it from Order History.' },
                { q: 'How do I set a customer\'s prices?', k: 'pricing customer price list discount',
                  a: 'Open Customer Pricing, choose the customer, and edit prices or apply a rule to a brand or category.' },
                { q: 'What are the Item Library and the Master Table?', k: 'item library master table catalogue barcodes',
                  a: 'The Item Library is CHC\'s reference catalogue that customer lists draw from. The Master Table is where the library is maintained and pushed to customers, barcodes included.' },
                { q: 'How do I give a customer a feature for free?', k: 'comp free billing entitlement',
                  a: 'Open Billing and comp the module for that customer, with a reason and, ideally, a review date.' },
                { q: 'How do I see a customer\'s PPG paint versus sundries by shop?', k: 'ppg sundries split report shop customer owner',
                  a: 'Open Reports, then the PPG vs sundries tab. Choose the company, a shop or All shops, and the period. View it by shop, month, item or PPG line and download a CSV. The customer\'s owner sees the same split on their own Reports screen.' },
                { q: 'An item is in the wrong group. How do I fix it?', k: 'ppg sundries wrong group correction override move item',
                  a: 'A super admin can fix it on Reports, PPG vs sundries: press "Move to sundries" or "Move to PPG" on the item, or enter the part number under Corrections. A correction applies to every customer and to PPG or sundries rebates, and is written to the audit log. "Back to the rule" undoes it.' },
                { q: 'How do I pay a rebate on PPG paint only?', k: 'rebate ppg paint only sundries scope set up',
                  a: 'Open Companies, press the % button on the customer, and add a rebate. Under Applies to choose PPG paint lines only (PPG general items such as paint suits are left out) or Sundries only.' },
                { q: 'How do I see what staff changed?', k: 'audit log changes who did',
                  a: 'Open Audit Log. Every staff change to customers, prices, users and settings is recorded.' },
                { q: 'How do I report on AI use?', k: 'ai usage report export log',
                  a: 'The AI usage log records every AI call. A super admin can download it as a spreadsheet from /api/admin/ai/usage?format=csv while signed in.' },
                { q: 'Can I go back to the classic look?', k: 'classic look old design switch',
                  a: 'Yes, for your own browser: press "Use classic look" at the foot of the menu. "Use new look" switches it back.' }
            ]
        }
    ]
};

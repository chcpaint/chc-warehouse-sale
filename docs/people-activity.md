# People & activity

Built for North Seven / York Mills (Louie's), who want to know who orders and who signs in, have every order tied to a named person, and address buying issues or overspending with individuals. It is an opt-in module: no other customer is affected unless it is switched on for them.

## What it does

- **Every order carries a person.** The name, email and group come from the signed-in account, never from the checkout form, and are frozen on the order. Deleting the account later does not erase who placed past orders.
- **Individual logins only.** With the module on, the shared access code is refused (the attempt is logged) and a shared-code session left open from before cannot place orders. A deactivated person is stopped on their next order, not when their 24-hour sign-in lapses.
- **Named groups** such as Painters, Estimators, Managers. One group per person. Deleting a group leaves its people in place, ungrouped.
- **Who orders** report: per person and per group, orders, units, spend, average and largest order, share of spend, last order, last sign-in. Filter by period, shop and group. Click a person for their orders and sign-ins. Export to CSV.
- **High spend flag**: a person is flagged when they spend at least twice the average ordering person, and only when three or more people ordered. Two people can never be "above average" in a meaningful way, so no flag is raised.
- **Sign-in log**: every sign-in, failed attempt, disabled-account attempt, password set/reset and blocked shared-code attempt, with device and address. No passwords or tokens are stored.
- **Hide-pricing accounts**: the customer's owner sees counts only, no dollars. CHC always sees dollars.

## Who sees it

- **CHC console**: Companies, the people icon (Customer users), then **People & activity**. Super admins, the company's own admin and order managers can read it; only super admins and company admins can create, rename or delete groups.
- **The customer**: their owner sees an **Activity** button in the store header and can manage groups too. Members never see it.

## Setting up a customer (North Seven / York Mills)

1. Apply `migrations/045_people_activity.sql` once (Supabase, SQL editor). The app keeps working without it, but groups and the report need it.
2. In the console: Companies, Modules, switch on **Customer users**, then **People & activity**.
3. Customer users: invite each person by name and email (Resend invite sends a set-password link).
4. People & activity, Groups tab: add the groups and put each person in one.
5. Tell the owner their button is **Activity** in the store header.

## Notes

- Orders placed with the shared code before the switch-on show as "shared login" in the report; they cannot be attributed after the fact.
- Existing customers' user lists keep working before the migration is applied (the list falls back to no groups).

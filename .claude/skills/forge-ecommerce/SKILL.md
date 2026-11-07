---
name: forge-ecommerce
description: "Playbook for web shops: checkout, Shopify, WooCommerce, Etsy (gebruik bij een webwinkel)."
# A10 original description (listing budget): "Playbook for web shops: cart, checkout, inventory, Shopify, WooCommerce, Etsy, Stripe (gebruik bij een webwinkel)."
# W2-BUDGET original description (listing budget): "Playbook for web shops: cart, checkout, Shopify, WooCommerce, Etsy (gebruik bij een webwinkel)."
---

# Forge playbook — E-commerce / store / digital products

## When to use
- Use for: stores and digital products: catalog, cart, inventory correctness, orders and store connectors.

Storefront UI defers to `forge-website`; anything that charges a card defers to **`forge-payments`** (this playbook never re-implements card handling). This file owns the commerce-specific concerns: catalog, cart, inventory correctness, orders, and connectors. Forge context: a cashflow or digital-goods shop / Etsy-style shops.

## Hard rules
- **Real product/listing data with honest empty states.**
- **Oversell-safe inventory.**
- **Idempotent order creation.**
- **Connectors gated until keys + approval.**
- **Money = integer minor units + currency**
- Secrets (store API keys, webhook secrets) in env + `.env.example` placeholders only.

Full text of every rule: `references/hard-rules.md`.

## Team (conditional)
Lead: `build-boss` (full store) or `integration-boss` (connector/sync-only). Specialists: `payment-integration` (checkout/charge — via `forge-payments`), `database-reviewer` (inventory + order schema, race-safety), `silent-failure-hunter` (a dropped inventory sync or swallowed order error looks like a clean sale), `typescript-reviewer` / `python-reviewer`. Storefront: `forge-website` team (a11y, responsive, real content). Optional: `codex-reviewer` on the checkout/order/inventory paths.

## Skills / commands / MCP
`forge-website` (storefront, product pages, cart UI), `forge-payments` (checkout + billing), `forge-integration` / `forge-n8n` (connector sync, order-notification automations). Store MCP/SDK docs via Context7 for exact connector APIs. Draft-only for any customer outreach (order emails staged, not blasted — shared with `forge-integration`).

## Fan-out & flow
L2 catalog + cart; L3 catalog + cart + checkout + inventory + orders + a connector; L4 multi-channel store with marketplace sync.
**Parallel:** catalog/product pages ∥ cart logic ∥ inventory service ∥ storefront UI (independent once the product + order schema/contract is fixed).
**Serial:** data model (products, SKUs, minor-units prices, inventory) → catalog → cart → checkout (`forge-payments`) → atomic inventory decrement → order record → fulfillment/notification.

## Domain gates
- Real catalog data or an honest empty state; no fabricated sales/inventory/metrics.
- Inventory decrement is atomic/reservation-based and proven oversell-safe under a concurrent-buyer test.
- Order creation is idempotent (unique idempotency key); a double-submit returns one order.
- Prices/tax/shipping in integer minor units; no float money math; totals reconcile.
- Cart → checkout → order → payment flow works end-to-end in test mode (an integration test, not just green units).
- Connectors inactive until keys + owner approval; no live publish/push/spend performed.
- Customer-facing emails/messages drafted, not auto-sent, without confirmation; idempotency before any order notification (no duplicate "order confirmed" mails on webhook retry).

## Ship-readiness (unique)
Evidence checklist before handoff: `references/ship-readiness.md`.

## Safety, approval and honesty
- Approval / safety: connectors stay disabled until real keys + owner approval; no live publish, store-push, listing update, price change or spend without explicit owner approval.
- Approval / safety: customer emails drafted, not auto-sent; store API keys and webhook secrets in env.
- Honest failure: no fabricated sales, inventory or metrics; an empty catalog shows an honest empty state.
- Shared gates for every playbook (honesty, owner approval, secrets, reviews): `.claude/docs/forge-reference/playbook-template.md`.

## References
- `references/hard-rules.md` — full text of every hard rule.
- `references/ship-readiness.md` — full ship-readiness evidence checklist.

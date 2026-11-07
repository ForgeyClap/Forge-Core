# forge-ecommerce — hard rules (full text)

## Hard rules
- **Real product/listing data with honest empty states.** No lorem/placeholder products passed off as a real catalog; an empty catalog renders a real empty state, never fake inventory or fabricated sales/metrics.
- **Oversell-safe inventory.** Stock decrement is an **atomic conditional update** ("first writer wins", `UPDATE ... SET stock = stock - qty WHERE stock >= qty`) or a reservation row — never a read-then-write that races. Concurrent buyers of the last unit → exactly one succeeds. Prefer soft-reserve at cart/checkout intake, hard-decrement at order confirmation.
- **Idempotent order creation.** `POST /order` (or checkout submit) carries an `Idempotency-Key` with a UNIQUE constraint, because mobile networks retry, users double-tap, and gateways time out — a duplicate submit must return the same order, not create two. (Same pattern as `forge-payments`; keep them consistent.)
- **Connectors gated until keys + approval.** Store/marketplace connectors (Shopify Admin, WooCommerce, Etsy, Stripe) stay disabled until real keys are present AND the owner approves. **No live publish, store-push, listing update, price change, or spend without explicit owner approval.**
- **Money = integer minor units + currency** (see `forge-payments`); no float math on prices, tax, shipping, or discounts.
- Secrets (store API keys, webhook secrets) in env + `.env.example` placeholders only.

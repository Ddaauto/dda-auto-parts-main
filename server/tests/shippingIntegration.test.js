import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";
import Database from "better-sqlite3";
import jwt from "jsonwebtoken";
import Stripe from "stripe";

test("isolated Shippo, tracking, payment, cancellation and inventory integration", { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "dda-shipping-"));
  const dbPath = join(dir, "test.sqlite");
  const fixture = join(dir, "shippo.mjs");
  writeFileSync(fixture, `
    import Stripe from ${JSON.stringify(import.meta.resolve("stripe"))};
    const stripeConfig = Stripe.prototype._getPropsFromConfig;
    const stripeProducts = {};
    let stripeSession;
    Stripe.prototype._getPropsFromConfig = function (config) {
      return { ...stripeConfig.call(this, config), httpClient: {
        getClientName: () => "fixture",
        async makeRequest(host, port, path, method, headers, body) {
          const url = new URL(path, "https://" + host);
          let result;
          if (method === "POST" && url.pathname === "/v1/checkout/sessions") {
            const params = new URLSearchParams(body);
            const lineItems = [0, 1, 2].map(index => {
              const prefix = "line_items[" + index + "]";
              const id = "prod_" + index;
              const sku = params.get(prefix + "[price_data][product_data][metadata][sku]");
              const checkoutFee = params.get(prefix + "[price_data][product_data][metadata][checkoutFee]");
              stripeProducts[id] = { metadata: { sku, checkoutFee } };
              return { description: params.get(prefix + "[price_data][product_data][name]"),
                quantity: Number(params.get(prefix + "[quantity]")),
                price: { product: id, unit_amount: Number(params.get(prefix + "[price_data][unit_amount]")) } };
            });
            stripeSession = { line_items: { data: lineItems } };
            if (lineItems.reduce((sum, item) => sum + item.quantity * item.price.unit_amount, 0) !== 5480) throw Error("Incorrect checkout total");
            result = { id: "cs_store", url: "https://checkout.stripe.com/test-fixture" };
          } else if (url.pathname === "/v1/checkout/sessions/cs_store") result = stripeSession;
          else if (url.pathname.startsWith("/v1/products/")) result = stripeProducts[url.pathname.split("/").at(-1)];
          else if (url.pathname === "/v1/payment_intents/pi_store") result = { id: "pi_store", status: "succeeded", currency: "usd", amount_received: 5480 };
          else if (method === "POST" && url.pathname === "/v1/refunds") {
            const params = new URLSearchParams(body);
            if (params.get("amount") !== "5480" || params.get("payment_intent") !== "pi_store") throw Error("Incorrect refund");
            result = { id: "re_store", status: "pending", amount: 5480 };
          }
          if (!result) throw Error("Unexpected Stripe request: " + method + " " + url.pathname);
          return { getStatusCode: () => 200, getRawResponse: () => ({}), getHeaders: () => ({}), toJSON: async () => result };
        }
      } };
    };
    let rates = 0;
    const fetchLocal = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith("http://127.0.0.1:")) return fetchLocal(url, options);
      if (options?.headers?.Authorization !== "ShippoToken shippo_test_fixture") throw Error("Unexpected outbound request");
      if (url === "https://api.goshippo.com/shipments/") {
        const shipment = JSON.parse(options.body);
        if (shipment.address_from.phone !== "3055550100" || shipment.address_from.email !== "sender@example.invalid") {
          throw Error("Sender contact missing from shipment");
        }
        return Response.json({
        rates: [{ object_id: "rate" + ++rates, provider: "USPS", servicelevel: { name: "Priority" },
          amount: "6.00", currency: "USD", test: true }]
        });
      }
      if (url === "https://api.goshippo.com/transactions/") {
        const { rate } = JSON.parse(options.body);
        return Response.json({ status: "SUCCESS", object_id: "txn-" + rate,
          tracking_number: "track-" + rate, label_url: "https://example.invalid/label.pdf", test: true });
      }
      throw Error("Unexpected Shippo URL");
    };
  `);
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  const secret = "integration-test-jwt";
  const server = spawn(process.execPath, ["--import", fixture, fileURLToPath(new URL("../index.js", import.meta.url))], {
    cwd: dir,
    env: { PATH: process.env.PATH, NODE_ENV: "test", PORT: String(port), DB_PATH: dbPath,
      JWT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      ADMIN_NOTIFY_EMAIL: "admin@example.invalid", SHIPPO_API_TOKEN: "shippo_test_fixture", SHIPPO_ALLOW_TEST_LABELS: "true", SHIPPO_WEBHOOK_TOKEN: "fixture-token" },
  });
  let logs = "";
  server.stdout.on("data", chunk => { logs += chunk; });
  server.stderr.on("data", chunk => { logs += chunk; });
  const stopped = once(server, "exit");
  let db;
  t.after(async () => {
    db?.close();
    server.kill();
    await stopped;
    rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  for (let n = 0; n < 100 && !logs.includes("Server running"); n++) {
    if (server.exitCode !== null) assert.fail(logs);
    await delay(30);
  }
  assert.match(logs, /Server running/);
  db = new Database(dbPath);
  const admin = jwt.sign({ id: "admin", role: "admin" }, secret);
  const customer = jwt.sign({ customerId: "customer", role: "customer" }, secret);
  const other = jwt.sign({ customerId: "other", role: "customer" }, secret);
  async function call(method, path, expected, body, token = admin, extraHeaders = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(error => { throw new Error(`${method} ${path}\n${logs}`, { cause: error }); });
    const content = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${content}\n${logs}`);
    return response.headers.get("content-type")?.includes("application/json") ? JSON.parse(content) : content;
  }
  const order = id => db.prepare("SELECT status, paymentStatus, deliveredAt FROM orders WHERE id = ?").get(id);
  const stock = () => db.prepare("SELECT stock FROM products WHERE sku = 'FIXTURE'").get().stock;
  const address = { firstName: "Test", lastName: "Customer", street: "1 Main St",
    city: "Hialeah", state: "FL", zip: "33010", email: "customer@example.invalid" };
  const items = [{ id: "1", sku: "FIXTURE", name: "Test part", qty: 2, price: 20, weightLb: 1 }];
  db.prepare(`INSERT INTO customers (id, firstName, lastName, email, createdAt, street, city, state, zip, freeDelivery)
    VALUES ('customer', @firstName, @lastName, @email, datetime('now'), @street, @city, @state, @zip, 1)`).run(address);
  db.exec("INSERT INTO products (sku, name, price_cents, stock) VALUES ('FIXTURE', 'Test part', 2000, 10)");
  const createZelle = async () => (await call("POST", "/orders", 200, { items, selectedShippingId: "free_delivery" }, customer)).id;

  assert.ok((await call("GET", "/admin/shipping-boxes", 200)).boxes.length);
  await call("PUT", "/admin/shipping-origin", 200, {
    name: "Sandbox sender", street1: "1 Main St", city: "Hialeah", state: "FL",
    zip: "33010", phone: "3055550100", email: "sender@example.invalid",
  });
  await call("GET", "/admin/shipping-boxes", 403, undefined, customer);
  const shipped = await createZelle();
  assert.equal(order(shipped).paymentStatus, "PENDING_ADMIN");
  assert.equal(stock(), 10);
  await call("POST", `/admin/orders/${shipped}/confirm-zelle`, 200, {});
  await call("POST", `/admin/orders/${shipped}/confirm-zelle`, 409, {});
  assert.equal(stock(), 8);

  const shippo = "/admin/shippo";
  const labelPath = `${shippo}/orders/${shipped}/purchase-label`;
  const ratesBody = { orderId: shipped, multiPackage: true, packageItems: [{ key: "1", qty: 1 }],
    box: { lengthIn: 8, widthIn: 4, heightIn: 4, weightOz: 25 } };
  const labels = [];
  for (let n = 0; n < 2; n++) {
    const { rates: [rate] } = await call("POST", shippo + "/rates", 200, ratesBody);
    assert.equal(rate.purchasable, true);
    assert.equal(rate.test, true);
    const confirmation = { rateId: rate.id, expectedAmount: rate.amount, expectedCurrency: "USD", confirm: true, multiPackage: true };
    await call("POST", labelPath, 409, { ...confirmation, expectedAmount: "1.00" });
    await call("POST", labelPath, 200, confirmation);
    await call("POST", labelPath, 409, confirmation);
    labels.push(rate.id);
    assert.equal(order(shipped).status, "LABEL_CREATED");
  }
  await call("POST", shippo + "/rates", 409, ratesBody);
  const trackingPath = `/shipping/orders/${shipped}/tracking`;
  await call("GET", trackingPath, 404, undefined, other);
  assert.equal((await call("GET", trackingPath, 200, undefined, customer)).packageCount, 2);

  const webhook = (id, status, day, expected = 204, token = "fixture-token", mode = true) =>
    call("POST", `/shipping/shippo/webhook?token=${token}`, expected, { event: "track_updated", test: mode,
      data: { transaction: "txn-" + id, carrier: "usps", tracking_number: "track-" + id,
        tracking_status: { status, status_date: `2026-11-${day}T12:00:00Z` } } }, null);
  await webhook(labels[0], "TRANSIT", "02", 401, "invalid");
  await webhook(labels[0], "TRANSIT", "02", 204, "fixture-token", false);
  assert.equal((await call("GET", trackingPath, 200, undefined, customer)).pickedUpCount, 0);
  await call("POST", "/shipping/shippo/webhook?token=fixture-token", 204, {
    event: "track_updated", test: true,
    data: { carrier: "usps", tracking_number: "track-" + labels[0],
      tracking_status: { status: "TRANSIT", status_date: "2026-11-02T12:00:00Z" } },
  }, null);
  assert.equal((await call("GET", trackingPath, 200, undefined, customer)).shippingStatus, "PARTIALLY_SHIPPED");
  assert.equal(order(shipped).status, "LABEL_CREATED");
  await call("PUT", `/admin/orders/${shipped}/cancel`, 409);
  await webhook(labels[1], "TRANSIT", "03");
  assert.equal(order(shipped).status, "SHIPPED");
  await webhook(labels[0], "DELIVERED", "04");
  assert.equal(order(shipped).status, "SHIPPED");
  await webhook(labels[1], "DELIVERED", "05");
  await webhook(labels[1], "PRE_TRANSIT", "01");
  await webhook(labels[1], "DELIVERED", "05");
  assert.equal(order(shipped).status, "DELIVERED");
  assert.equal(order(shipped).deliveredAt, "2026-11-05T12:00:00.000Z");
  assert.equal((await call("GET", trackingPath, 200, undefined, customer)).shippingStatus, "DELIVERED");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shipping_notifications WHERE sentAt IS NOT NULL").get().count, 2);

  const cancelled = await createZelle();
  await call("POST", `/admin/orders/${cancelled}/confirm-zelle`, 200, {});
  assert.equal(stock(), 6);
  await call("PUT", `/admin/orders/${cancelled}/cancel`, 200);
  await call("PUT", `/admin/orders/${cancelled}/cancel`, 409);
  assert.equal(stock(), 8);
  await call("PUT", `/admin/orders/${cancelled}/refund`, 400, {});
  await call("PUT", `/admin/orders/${cancelled}/refund`, 200, { refundSentConfirmed: true });
  assert.equal(order(cancelled).paymentStatus, "REFUNDED");
  const late = await createZelle();
  await call("PUT", `/admin/orders/${late}/cancel`, 200);
  assert.equal(order(late).paymentStatus, "PAYMENT_VERIFICATION_PENDING");
  await call("POST", `/admin/orders/${late}/confirm-zelle`, 200, {});
  assert.equal(order(late).paymentStatus, "REFUND_PENDING");
  assert.equal(stock(), 8);

  const labeled = await createZelle();
  await call("POST", `/admin/orders/${labeled}/confirm-zelle`, 200, {});
  const { rates: [labelRate] } = await call("POST", shippo + "/rates", 200,
    { orderId: labeled, box: ratesBody.box });
  await call("POST", `${shippo}/orders/${labeled}/purchase-label`, 200,
    { rateId: labelRate.id, expectedAmount: "6.00", expectedCurrency: "USD", confirm: true });
  const adminOrder = `/admin/orders/${labeled}`;
  const settlement = adminOrder + "/label-cancellation-settlement";
  const beforePickup = { carrierNotPickedUpConfirmed: true };
  await call("POST", adminOrder + "/label-cancellation-review", 201, beforePickup);
  await call("PUT", adminOrder + "/label-cancellation-review/decision", 200, { ...beforePickup, decision: "APPROVED" });
  const prepared = await call("POST", settlement + "/prepare", 201, { confirmPrepare: true });
  assert.equal(prepared.initialRefundCents, 3180);
  const partialRefund = { refundSentConfirmed: true, amountCents: 3180 };
  await call("POST", settlement + "/confirm-zelle-refund", 409, partialRefund);
  await call("POST", settlement + "/cancel-order", 200, { ...beforePickup, confirmCancellation: true });
  assert.equal(stock(), 8);
  await call("POST", settlement + "/confirm-zelle-refund", 200, partialRefund);
  await call("POST", settlement + "/confirm-zelle-refund", 409, partialRefund);
  const evidence = { fundsReceivedConfirmed: true, shippoTransactionId: "txn-" + labelRate.id,
    evidenceReference: "fixture statement", verifiedAmountCents: 600 };
  await call("POST", adminOrder + "/shippo-refund-verification", 409, { ...evidence, verifiedAmountCents: 601 });
  await call("POST", adminOrder + "/shippo-refund-verification", 201, evidence);
  await call("POST", adminOrder + "/shippo-refund-verification", 409, evidence);
  await call("POST", adminOrder + "/shippo-additional-refund/prepare", 201, { confirmPrepare: true });
  const additional = await call("POST", adminOrder + "/shippo-additional-refund/confirm-zelle", 200,
    { refundSentConfirmed: true, transferReference: "fixture transfer", amountCents: 600 });
  assert.equal(additional.processingFeeRetainedCents, 500);

  const stripe = new Stripe("sk_test_fixture");
  async function stripeEvent(event, status) {
    const signature = stripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(event), secret: "whsec_fixture" });
    await call("POST", "/stripe/webhook", status, event, null, { "Stripe-Signature": signature });
  }
  const checkoutBody = { items: [{ ...items[0], price: 0.01 }], selectedShippingId: "usps" };
  await call("POST", "/stripe/create-checkout-session", 401, checkoutBody, null);
  assert.match((await call("POST", "/stripe/create-checkout-session", 200, checkoutBody, customer)).url, /test-fixture/);
  const storeCheckout = { type: "checkout.session.completed", data: { object: { id: "cs_store",
    payment_status: "paid", amount_total: 5480, currency: "usd", payment_intent: "pi_store",
    metadata: { checkoutPricing: "server-v1", customerEmail: address.email, selectedShippingId: "usps" } } } };
  await stripeEvent(storeCheckout, 200);
  await stripeEvent(storeCheckout, 200);
  const storeOrder = db.prepare("SELECT id, grandTotal FROM orders WHERE stripeSessionId = 'cs_store'").get();
  assert.equal(storeOrder.grandTotal, 54.8);
  assert.equal(stock(), 6);
  await call("PUT", `/admin/orders/${storeOrder.id}/cancel`, 200);
  assert.equal(stock(), 8);
  await stripeEvent({ type: "refund.updated", data: { object: { id: "re_store", payment_intent: "pi_store", amount: 5480, status: "succeeded" } } }, 200);
  assert.equal(order(storeOrder.id).paymentStatus, "REFUNDED");

  const checkout = await createZelle();
  db.prepare(`UPDATE orders SET paymentStatus = 'PENDING', paymentMethod = 'Card',
    quoteId = 1, stripeSessionId = 'cs_fixture' WHERE id = ?`).run(checkout);
  const completed = { type: "checkout.session.completed", data: { object: { id: "cs_fixture",
    payment_status: "paid", amount_total: 4280, currency: "usd", payment_intent: "pi_checkout",
    metadata: { quoteId: "1", quoteOrderId: checkout } } } };
  await stripeEvent(completed, 200);
  await stripeEvent(completed, 200);
  assert.equal(order(checkout).paymentStatus, "PAID");
  assert.equal(stock(), 6);

  const card = await createZelle();
  db.prepare("UPDATE orders SET status = 'CANCELLED', paymentStatus = 'REFUND_PENDING', paymentMethod = 'Card' WHERE id = ?").run(card);
  db.prepare(`INSERT INTO stripe_cancellation_refunds (orderId, stripeRefundId, stripePaymentIntentId, amountCents, refundStatus)
    VALUES (?, 're_fixture', 'pi_fixture', 4280, 'pending')`).run(card);
  async function stripeRefund(amount, state, status) {
    const event = { type: "refund.updated", data: { object: { id: "re_fixture", payment_intent: "pi_fixture", amount, status: state } } };
    await stripeEvent(event, status);
  }
  await stripeRefund(100, "succeeded", 409);
  assert.equal(order(card).paymentStatus, "REFUND_PENDING");
  await stripeRefund(4280, "succeeded", 200);
  await stripeRefund(4280, "pending", 200);
  assert.equal(order(card).paymentStatus, "REFUNDED");
  assert.match(logs, /\[PREVIEW\] Email delivery disabled: Zelle Pending/);
  assert.doesNotMatch(logs, /fixture-token|Admin Zelle pending email failed/);
  assert.match(logs, /\[PREVIEW\] Email delivery disabled: Shipped/);
  assert.match(logs, /\[PREVIEW\] Email delivery disabled: Delivered/);
  assert.match(logs, /\[PREVIEW\] Email delivery disabled: Payment confirmed/);
});

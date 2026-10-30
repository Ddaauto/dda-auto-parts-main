import test from "node:test";
import assert from "node:assert/strict";
import { requestFullStripeRefund } from "../services/stripeCancellationRefund.js";

const order = {
  id: "ord_test_1", status: "CANCELLED", paymentStatus: "REFUND_PENDING",
  paymentMethod: "Card", grandTotal: 25.50, stripePaymentIntentId: "pi_test_1"
};
function mockStripe({ status = "succeeded", amount = 2550, refundStatus = "pending" } = {}) {
  const calls = [];
  return {
    calls,
    paymentIntents: { retrieve: async id => {
      calls.push(["retrieve", id]);
      return { id, status, currency: "usd", amount_received: amount };
    }},
    refunds: { create: async (params, options) => {
      calls.push(["refund", params, options]);
      return { id: "re_test_1", status: refundStatus, amount: params.amount };
    }}
  };
}

test("refund only cancelled orders with refund pending", async () => {
  const stripe = mockStripe();
  await assert.rejects(requestFullStripeRefund({ stripe, order: { ...order, status: "PAID" } }), /cancelled/);
  await assert.rejects(requestFullStripeRefund({ stripe, order: { ...order, paymentStatus: "REFUNDED" } }), /refund pending/);
  assert.equal(stripe.calls.length, 0);
});

test("never automatically refund Zelle", async () => {
  const stripe = mockStripe();
  await assert.rejects(requestFullStripeRefund({ stripe, order: { ...order, paymentMethod: "Zelle" } }), /manual/);
  assert.equal(stripe.calls.length, 0);
});

test("reject mismatched or unsettled Stripe payments", async () => {
  for (const config of [{ amount: 2500 }, { status: "processing" }]) {
    const stripe = mockStripe(config);
    await assert.rejects(requestFullStripeRefund({ stripe, order }), /does not match/);
    assert.equal(stripe.calls.filter(c => c[0] === "refund").length, 0);
  }
});

test("request full amount with deterministic idempotency key", async () => {
  const stripe = mockStripe();
  const result = await requestFullStripeRefund({ stripe, order });
  assert.deepEqual(result, { refundId: "re_test_1", status: "pending", amount: 2550, paymentIntentId: "pi_test_1" });
  const request = stripe.calls.find(c => c[0] === "refund");
  assert.equal(request[1].amount, 2550);
  assert.equal(request[2].idempotencyKey, "dda-cancel-v1-ord_test_1-full");
});

test("resolve checkout session payment intent when missing on order", async () => {
  const stripe = mockStripe();
  stripe.checkout = { sessions: { retrieve: async () => ({ payment_status: "paid", payment_intent: "pi_test_1" }) } };
  const result = await requestFullStripeRefund({ stripe, order: { ...order, stripePaymentIntentId: null, stripeSessionId: "cs_test_1" } });
  assert.equal(result.paymentIntentId, "pi_test_1");
});

// Stripe refunds for cancelled orders. Not invoked until the order-level
// cancellation and refund-state workflow is connected and tested.
export async function requestFullStripeRefund({ stripe, order, idempotencyPrefix = "dda-cancel-v1" }) {
  if (!stripe || !order?.id) throw new Error("Missing Stripe client or order");
  if (String(order.status || "").toUpperCase() !== "CANCELLED" ||
      String(order.paymentStatus || "").toUpperCase() !== "REFUND_PENDING") {
    throw new Error("Order must be cancelled with refund pending");
  }
  if (String(order.paymentMethod || "").toLowerCase() === "zelle") {
    throw new Error("Zelle refunds are manual");
  }
  const expectedCents = Math.round(Number(order.grandTotal) * 100);
  if (!Number.isSafeInteger(expectedCents) || expectedCents <= 0) {
    throw new Error("Invalid order refund amount");
  }
  let intentId = String(order.stripePaymentIntentId || "").trim();
  if (!intentId && order.stripeSessionId) {
    const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
    if (session.payment_status !== "paid") throw new Error("Checkout payment not settled");
    intentId = typeof session.payment_intent === "string"
      ? session.payment_intent : session.payment_intent?.id || "";
  }
  if (!intentId) throw new Error("No verified Stripe payment intent on order");
  const intent = await stripe.paymentIntents.retrieve(intentId);
  if (intent.status !== "succeeded" || intent.currency !== "usd" ||
      intent.amount_received !== expectedCents) {
    throw new Error("Stripe payment does not match order amount or is not settled");
  }
  // Stripe idempotency prevents a repeated request from issuing a second refund.
  // Persist the returned refund ID/status before exposing this to customers.
  const refund = await stripe.refunds.create(
    { payment_intent: intent.id, amount: expectedCents, reason: "requested_by_customer",
      metadata: { orderId: String(order.id) } },
    { idempotencyKey: `${idempotencyPrefix}-${order.id}-full` }
  );
  return { refundId: refund.id, status: refund.status, amount: refund.amount,
    paymentIntentId: intent.id };
}

// server/mailer.js
import sgMail from "@sendgrid/mail";
import "dotenv/config";

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM_EMAIL = process.env.FROM_EMAIL || "no-reply@ddaautoparts.com";
const FROM_NAME = process.env.FROM_NAME || "DDA Auto Parts";

export async function sendEmail({ to, subject, html, text, attachments = [] }) {
  const msg = {
    to,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    text,
    html,
  };

  // ✅ Solo agrega attachments si vienen
  if (attachments && attachments.length) {
    msg.attachments = attachments;
  }

  await sgMail.send(msg);
}
export async function sendAdminZellePendingEmail(order) {
  const to = process.env.ADMIN_NOTIFY_EMAIL;
  if (!to) return;

  const orderLabel = `${order.orderNumber}${order.orderSeq ? "-" + order.orderSeq : ""}`;

  const subject = `🟡 Zelle Pending — Order ${orderLabel}`;

  const text =
`Tienes un pago Zelle pendiente por confirmar.

Order: ${orderLabel}
Customer: ${order.customerEmail || "N/A"}
Total: $${Number(order.grandTotal || 0).toFixed(2)}

Entra al Admin → Zelle Pending para confirmarla.`;

  await sendEmail({
    to,
    subject,
    text,
  });
}
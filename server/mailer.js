// server/mailer.js
import { Resend } from "resend";
import "dotenv/config";

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_EMAIL = process.env.FROM_EMAIL || "no-reply@ddaautoparts.com";
const FROM_NAME = process.env.FROM_NAME || "DDA Auto Parts";

export async function sendEmail({ to, subject, html, text, attachments = [] }) {
  const msg = {
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to,
    subject,
    html: html || `<p>${text}</p>`,
    text,
  };

  if (attachments && attachments.length) {
    msg.attachments = attachments;
  }

  await resend.emails.send(msg);
}

export async function sendAdminZellePendingEmail(order) {
  const to = process.env.ADMIN_NOTIFY_EMAIL;
  if (!to) return;

  const orderLabel = `${order.orderNumber}${order.orderSeq ? "-" + order.orderSeq : ""}`;

  const subject = `Zelle Pending ${orderLabel}`;

  const text =
`Tienes un pago Zelle pendiente por confirmar.

Order: ${orderLabel}
Customer: ${order.customerEmail || "N/A"}
Total: $${Number(order.grandTotal || 0).toFixed(2)}

Entra al Admin para confirmarla.`;

  await sendEmail({
    to,
    subject,
    text,
  });
}
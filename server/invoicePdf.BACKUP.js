// server/invoicePdf.js
import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";

/**
 * PDF Invoice - estable (no corrupto), sin variables duplicadas
 * - Bill To + Ship To completos
 * - Ship To mismo formato que Bill To
 * - Part # en vez de SKU
 * - Payment method + payment status
 * - Footer abajo sin espacios extra
 */
export async function generateInvoicePDF(order) {
  const invoicesDir = path.join(process.cwd(), "invoices");
  if (!fs.existsSync(invoicesDir)) fs.mkdirSync(invoicesDir, { recursive: true });

  const invoiceId = String(order.invoiceId || order.invoice || order.orderNumber || order.id || "INV").trim();
  const pdfPath = path.join(invoicesDir, `${invoiceId}.pdf`);

  // Logo: server/assets/logo.jpg
  const logoPath = path.join(process.cwd(), "assets", "logo.jpg");

  // ---------- helpers ----------
  const safe = (v) => String(v ?? "").trim();
  const money = (v) => {
    const n = Number(v || 0);
    return `$${n.toFixed(2)}`;
  };
  const parseJSON = (v, fallback) => {
    try {
      if (v == null) return fallback;
      if (typeof v === "object") return v;
      const s = String(v);
      if (!s) return fallback;
      return JSON.parse(s);
    } catch {
      return fallback;
    }
  };

  // items
  const itemsRaw = order.itemsJson ?? order.items ?? [];
  const items = Array.isArray(itemsRaw) ? itemsRaw : parseJSON(itemsRaw, []);

  // customer snapshot
  const customer = parseJSON(order.customerSnapshot, {});
  const customerEmail = safe(customer.email || order.email || "");

  // Bill address from customer fields (lo que tú guardas)
  const billStreet = safe(customer.street || "");
  const billApt = safe(customer.apt || "");
  const billCity = safe(customer.city || "");
  const billState = safe(customer.state || "");
  const billZip = safe(customer.zip || "");
  const billAddr1 = safe([billStreet, billApt].filter(Boolean).join(", "));
  const billAddr2 = safe([billCity, billState, billZip].filter(Boolean).join(", "));

  // Shipping can be object or string (a veces customer.address viene string)
  const shipRaw = customer.shippingAddress || customer.shipping || customer.shipTo || customer.address || {};
  const shipObj = typeof shipRaw === "string" ? {} : (shipRaw || {});
  const shipText = typeof shipRaw === "string" ? safe(shipRaw) : "";

  // Ship fields (si falta, usa Bill)
  const shipName = safe(shipObj.name || customer.name || customer.fullName || customerEmail || "Customer");
  const shipPhone = safe(shipObj.phone || customer.phone || "");
  const shipEmail = safe(shipObj.email || customerEmail);

  const shipLine1 = safe(shipObj.line1 || shipObj.address1 || shipObj.address || shipText || billStreet);
  const shipLine2 = safe(shipObj.line2 || shipObj.address2 || billApt);
  const shipCity = safe(shipObj.city || billCity);
  const shipState = safe(shipObj.state || billState);
  const shipZip = safe(shipObj.zip || shipObj.postalCode || billZip);
  const shipCountry = safe(shipObj.country || "USA");

  const shipAddr1 = safe([shipLine1, shipLine2].filter(Boolean).join(", "));
  const shipAddr2 = safe([shipCity, shipState, shipZip].filter(Boolean).join(", "));

  // Payment
  const paymentMethod = safe(order.paymentMethod || "—");
  const paymentStatus = safe(order.paymentStatus || order.status || "—");

  // Totals
  const subtotal =
    Number(order.subTotal ?? order.subtotal ?? 0) ||
    items.reduce((s, it) => s + Number(it.price || 0) * Number(it.qty || it.quantity || 1), 0);

  const shipping = Number(order.shipping ?? order.shippingCost ?? 0);
  const tax = Number(order.tax ?? order.salesTax ?? 0);
  const discounts = Number(order.discounts ?? order.discount ?? 0);
  const grandTotal = Number(order.grandTotal ?? order.total ?? (subtotal + shipping + tax - discounts));

  const createdAt = order.createdAt ? new Date(order.createdAt) : new Date();
  const dateStr = createdAt.toLocaleString();

  // ---------- PDF ----------
  const doc = new PDFDocument({ size: "LETTER", margin: 50 });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const top = doc.page.margins.top;

  const dark = "#111827";
  const gray = "#6b7280";
  const line = "#e5e7eb";

  // Header
  const logoW = 70;
  if (fs.existsSync(logoPath)) {
    try {
      doc.image(logoPath, left, top, { fit: [logoW, logoW] });
    } catch {}
  }

  doc.fillColor(dark).font("Helvetica-Bold").fontSize(18).text("DDA Auto Parts", left + 90, top + 6);
  doc.fillColor(gray).font("Helvetica").fontSize(10).text("www.ddaautoparts.com", left + 90, top + 30);

  // Invoice box
  const boxW = 230;
  const boxX = right - boxW;
  const boxY = top;
  const boxH = 70;

  doc.rect(boxX, boxY, boxW, boxH).strokeColor(line).lineWidth(1).stroke();
  doc.fillColor(dark).font("Helvetica-Bold").fontSize(12).text("INVOICE", boxX + 14, boxY + 10);
  doc.font("Helvetica").fontSize(10).text(`Invoice: ${invoiceId}`, boxX + 14, boxY + 30);
  doc.fillColor(gray).text(`Order #: ${safe(order.orderNumber || order.id || "")}`, boxX + 14, boxY + 45);
  doc.fillColor(gray).text(`Date: ${dateStr}`, boxX + 14, boxY + 58);

  // Divider
  doc.moveTo(left, top + 90).lineTo(right, top + 90).strokeColor(line).lineWidth(1).stroke();

  // Bill / Ship columns (wrap para que NO se monten)
  let y = top + 105;
  const colGap = 18;
  const colW = (right - left - colGap) / 2;
  const shipX = left + colW + colGap;

  // BILL TO
  doc.fillColor(dark).font("Helvetica-Bold").fontSize(11).text("BILL TO", left, y);
  doc.fillColor(dark).font("Helvetica").fontSize(10).text(shipName, left, y + 16, { width: colW });

  doc.fillColor(gray).font("Helvetica").fontSize(10);
  const billLines = [
    customerEmail,
    shipPhone,
    billAddr1,
    billAddr2,
  ].filter(Boolean);

  let billY = y + 30;
  for (const ln of billLines) {
    doc.text(ln, left, billY, { width: colW, lineGap: 0 });
    billY += doc.heightOfString(ln, { width: colW }) + 2;
  }

  // SHIP TO (MISMO FORMATO)
  doc.fillColor(dark).font("Helvetica-Bold").fontSize(11).text("SHIP TO", shipX, y);
  doc.fillColor(dark).font("Helvetica").fontSize(10).text(shipName, shipX, y + 16, { width: colW });

  doc.fillColor(gray).font("Helvetica").fontSize(10);

  // ✅ IMPORTANTE: no repetir addr2 si addr1 ya contiene ciudad/zip
  const addr1Lower = shipAddr1.toLowerCase();
  const hasZipInAddr1 = shipZip && addr1Lower.includes(String(shipZip).toLowerCase());
  const hasCityInAddr1 = shipCity && addr1Lower.includes(String(shipCity).toLowerCase());
  const shipAddr2Final = (!hasZipInAddr1 && !hasCityInAddr1) ? shipAddr2 : "";

  const shipLines = [
    shipEmail,
    shipPhone,
    shipAddr1,
    shipAddr2Final,
    shipCountry,
  ].filter(Boolean);

  let shipY = y + 30;
  for (const ln of shipLines) {
    doc.text(ln, shipX, shipY, { width: colW, lineGap: 0 });
    shipY += doc.heightOfString(ln, { width: colW }) + 2;
  }

  y = Math.max(billY, shipY) + 10;

  // PAYMENT
  doc.fillColor(dark).font("Helvetica-Bold").fontSize(10).text("PAYMENT", left, y);
  doc.fillColor(gray).font("Helvetica").fontSize(10);
  doc.text(`Method: ${paymentMethod}`, left, y + 16, { lineGap: 0 });
  doc.text(`Status: ${paymentStatus}`, left, y + 30, { lineGap: 0 });
  y += 52;

  // Items table header
  const tableTop = y;
  const headerH = 22;
  doc.rect(left, tableTop, right - left, headerH).fillAndStroke("#f3f4f6", line);

  doc.fillColor(dark).font("Helvetica-Bold").fontSize(9);

  const cw = { part: 95, brand: 70, qty: 35, price: 65, total: 70 };
  const fixedW = cw.part + cw.brand + cw.qty + cw.price + cw.total;
  const descW = (right - left) - fixedW - 16;

  const cx = {
    part: left + 8,
    brand: left + 8 + cw.part,
    desc: left + 8 + cw.part + cw.brand,
    qty: left + 8 + cw.part + cw.brand + descW,
    price: left + 8 + cw.part + cw.brand + descW + cw.qty,
    total: left + 8 + cw.part + cw.brand + descW + cw.qty + cw.price,
  };

  doc.text("Part #", cx.part, tableTop + 6);
  doc.text("Brand", cx.brand, tableTop + 6);
  doc.text("Description", cx.desc, tableTop + 6);
  doc.text("QTY", cx.qty, tableTop + 6, { width: cw.qty, align: "right" });
  doc.text("Price", cx.price, tableTop + 6, { width: cw.price, align: "right" });
  doc.text("Total", cx.total, tableTop + 6, { width: cw.total, align: "right" });

  let rowY = tableTop + headerH + 8;
  doc.font("Helvetica").fontSize(9).fillColor(dark);

  const ensurePage = () => {
    if (rowY > doc.page.height - 200) {
      doc.addPage();
      rowY = doc.page.margins.top;
    }
  };

  for (const it of items) {
    ensurePage();

    const part = safe(it.mpn || it.partNumber || it.part || it.sku || it.SKU || "-");
    const brand = safe(it.brand || it.make || "-");
    const desc = safe(it.name || it.title || it.description || "-");
    const qty = Number(it.qty ?? it.quantity ?? 1);
    const price = Number(it.price ?? it.unitPrice ?? 0);
    const lineTotal = Number(it.lineTotal ?? (price * qty));

    doc.text(part, cx.part, rowY, { width: cw.part - 4 });
    doc.text(brand, cx.brand, rowY, { width: cw.brand - 4 });
    doc.text(desc, cx.desc, rowY, { width: descW - 4 });

    doc.text(String(qty), cx.qty, rowY, { width: cw.qty - 6, align: "right" });
    doc.text(money(price), cx.price, rowY, { width: cw.price - 6, align: "right" });
    doc.text(money(lineTotal), cx.total, rowY, { width: cw.total - 6, align: "right" });

    const h = Math.max(
      18,
      doc.heightOfString(desc, { width: descW - 4 }) + 2
    );
    rowY += h + 6;

    doc.moveTo(left, rowY - 2).lineTo(right, rowY - 2).strokeColor(line).lineWidth(1).stroke();
  }

  // Totals box
  ensurePage();
  const totalsW = 260;
  const totalsX = right - totalsW;
  const totalsY = rowY + 10;

  doc.rect(totalsX, totalsY, totalsW, 110).strokeColor(line).lineWidth(1).stroke();

  let ty = totalsY + 14;
  const labelX = totalsX + 14;

  const lineItem = (label, value, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10);
    doc.fillColor(bold ? dark : gray).text(label, labelX, ty);
    doc.fillColor(dark).text(value, labelX, ty, { width: totalsW - 28, align: "right" });
    ty += 18;
  };

  lineItem("Subtotal", money(subtotal));
  lineItem("Shipping", money(shipping));
  lineItem("Tax", money(tax));
  if (discounts) lineItem("Discount", `- ${money(Math.abs(discounts))}`);

  doc.moveTo(totalsX + 14, ty + 2).lineTo(totalsX + totalsW - 14, ty + 2).strokeColor(line).lineWidth(1).stroke();
  ty += 10;
  lineItem("Grand Total", money(grandTotal), true);

  // Terms / footer (abajo, sin espacios extra)
  const preferredTermsY = doc.page.height - 200;
  const termsY = Math.max(totalsY + 130, preferredTermsY);

  doc.fillColor(dark).font("Helvetica-Bold").fontSize(11).text("Comments / Notes / Terms & Conditions", left, termsY);
  doc.fillColor(gray).font("Helvetica").fontSize(10);

  const termsLines = [
    "For any concerns regarding this invoice, please contact us by phone or email using the information listed above.",
    "Electronic parts are non-returnable. Returns are only accepted within the first 10 days after purchase.",
    "Cancellations may be subject to a cancellation and returning fee.",
    "I have read and fully understand the terms and conditions of this invoice.",
  ];

  let tY = termsY + 18;
  for (const ln of termsLines) {
    doc.text(ln, left, tY, { width: right - left, lineGap: 0 });
    tY += 14;
  }

  doc.fillColor(dark).font("Helvetica-Bold").fontSize(12);
  doc.text("Thanks for your business.", left, doc.page.height - 80, { width: right - left, align: "center" });

  // Finalize (CRÍTICO para que no salga corrupto)
  doc.end();

  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  return pdfPath;
}

import { PDFDocument } from "pdfkit";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatMoneyDisplay, formatMoneyNumberDisplay, formatSignedBalanceNumberDisplay } from "./money-format.mjs";

const PAGE = Object.freeze({ size: "A4", margin: 46, footer: 28 });
const COLORS = Object.freeze({ text: "#172126", muted: "#5b6870", line: "#d6dde1", blue: "#006aa7", yellow: "#fecc00", pale: "#f3f6f7" });
const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REGULAR_FONT = path.join(DIRECTORY, "fonts", "NotoSans-Regular.ttf");
const BOLD_FONT = path.join(DIRECTORY, "fonts", "NotoSans-Bold.ttf");

export async function renderReviewPdf(model) {
  const chunks = [];
  const recorded = deterministicDate(model.run.recordedAt);
  const document = new PDFDocument({
    size: PAGE.size,
    margins: { top: PAGE.margin, right: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin },
    bufferPages: true,
    compress: true,
    info: {
      Title: model.title,
      Author: "Bergbok",
      Subject: `${model.statusDisplay}; ${model.run.digest}`,
      Creator: "Bergbok Artifacts",
      Producer: "Bergbok Artifacts",
      CreationDate: recorded,
      ModDate: recorded,
    },
  });
  document.registerFont("Report", REGULAR_FONT);
  document.registerFont("ReportBold", BOLD_FONT);
  document.font("Report").fillColor(COLORS.text);
  document.on("data", (chunk) => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });

  drawReport(document, model);
  addFooters(document, model);
  document.end();
  return completed;
}

function drawReport(doc, model) {
  doc.font("Report").fontSize(8.5).fillColor(COLORS.muted).text(model.header.identity);
  doc.moveDown(1.25);
  doc.font("ReportBold").fontSize(20).fillColor(COLORS.text).text(model.title);
  doc.moveDown(0.55);
  doc.font("Report").fontSize(9).fillColor(COLORS.blue).text(model.header.context);
  doc.fillColor(COLORS.text);
  if (model.previewNotice) {
    doc.moveDown(0.6);
    const y = doc.y;
    doc.rect(PAGE.margin, y, contentWidth(doc), doc.heightOfString(model.previewNotice, { width: contentWidth(doc) - 20 }) + 16).fill("#fffaf0");
    doc.rect(PAGE.margin, y, 4, doc.heightOfString(model.previewNotice, { width: contentWidth(doc) - 20 }) + 16).fill(COLORS.yellow);
    doc.fillColor(COLORS.text).font("Report").fontSize(9).text(model.previewNotice, PAGE.margin + 12, y + 8, { width: contentWidth(doc) - 20 });
    doc.y = y + doc.heightOfString(model.previewNotice, { width: contentWidth(doc) - 20 }) + 20;
  }
  for (const section of model.sections) drawSection(doc, section, model);
}

function drawSection(doc, section, model) {
  const l = model.labels;
  if (["evidence", "verification", "provenance"].includes(section.id)) return;
  if (section.id === "core" && !section.rows.length) return;
  if (section.id === "summary") return introParagraph(doc, section.value);
  if (section.kind === "preformatted") {
    doc.font("Report").fontSize(7);
    const estimated = doc.heightOfString(String(section.value).trimEnd(), { width: contentWidth(doc), lineGap: 1 }) + 54;
    ensureSpace(doc, Math.min(estimated, pageBottom(doc) - PAGE.margin));
  }
  heading(doc, section.id === "core" ? l.coreChanges : section.title);
  if (section.kind === "paragraph") return paragraph(doc, section.value);
  if (section.kind === "notices") {
    if (!section.groups.length) return empty(doc, section.emptyText);
    for (const group of section.groups) {
      subheading(doc, group.title);
      for (const item of group.items) bullet(doc, item.display);
    }
    return;
  }
  if (section.kind === "key_values") return drawKeyValueRows(doc, section.rows, l, section.emptyText);
  if (section.kind === "transactions") {
    if (!section.items.length) return empty(doc, section.emptyText);
    paragraph(doc, verificationSummary(model, section.items.length), { muted: true });
    for (const transaction of section.items) drawTransaction(doc, transaction, l, model.language);
    return;
  }
  if (section.kind === "open_items") return drawOpenItems(doc, section, l, model.language);
  if (section.kind === "balances") {
    if (!section.items.length) return empty(doc, section.emptyText);
    return drawTable(doc,
      [l.account, l.accountName, l.opening, l.movementDebit, l.movementCredit, l.closing],
      section.items.map((item) => [
        item.account,
        item.accountName,
        formatSignedBalanceNumberDisplay(item.opening, model.language),
        formatMoneyNumberDisplay(item.movementDebit, model.language),
        formatMoneyNumberDisplay(item.movementCredit, model.language),
        formatSignedBalanceNumberDisplay(item.closing, model.language),
      ]),
      [45, 128, 82, 82, 82, 84],
      ["left", "left", "right", "right", "right", "right"],
      7,
    );
  }
  if (section.kind === "verification") {
    if (!section.value) return empty(doc, section.emptyText);
    return drawKeyValues(doc, [[l.series, section.value.series], [l.lastNumberOpening, section.value.openingLastNumber], [l.lastNumberClosing, section.value.closingLastNumber]]);
  }
  if (section.kind === "reconciliations") {
    if (!section.items.length) return empty(doc, section.emptyText);
    return drawTable(
      doc,
      [l.account, l.status, l.ledger, l.external, l.evidenceIds],
      section.items.map((item) => [
        item.account,
        item.status,
        formatMoneyDisplay(item.ledger_closing_balance, model.language),
        formatMoneyDisplay(item.external_closing_balance, model.language),
        (item.evidence_document_ids ?? []).join(", "),
      ]),
      [55, 90, 105, 105, 148],
      ["left", "left", "right", "right", "left"],
      7,
    );
  }
  if (section.kind === "vat") {
    if (!section.value) return empty(doc, section.emptyText);
    if (!section.value.hasActivity && !section.value.due_in_period && !section.value.closing_transaction_source_id) {
      return paragraph(doc, `${l.noVatActivity} ${l.vatPeriodMembership} ${section.value.reportingPeriodDisplay}; ${l.noVatReturnDue} ${section.value.reportMonthDisplay}.`);
    }
    drawKeyValues(doc, [
      [l.reportingFrequency, section.value.frequencyDisplay],
      [l.reportingPeriod, section.value.reportingPeriod],
      [l.dueInPeriod, section.value.dueDisplay],
      [l.status, section.value.status],
      [l.inputVatAccounts, section.value.inputAccountsDisplay],
      [l.outputVatAccounts, section.value.outputAccountsDisplay],
      [l.vatSettlementAccount, section.value.settlement_account],
      [l.vatClosingTransaction, section.value.closingTransactionDisplay],
    ]);
    subheading(doc, l.declarationBoxes);
    if (section.value.declaration_boxes) return drawTable(doc, ["Box", l.total], Object.entries(section.value.declaration_boxes).map(([box, amount]) => [box, formatMoneyDisplay(amount, model.language)]), [200, 303], ["left", "right"]);
    return empty(doc, section.emptyText);
  }
  if (section.kind === "simple_rows") {
    if (!section.rows.length) return empty(doc, section.emptyText);
    return drawTable(doc, [l.kind, l.value], section.rows.map((item) => [item.label, item.value]), [150, 353]);
  }
  if (section.kind === "preformatted") return preformatted(doc, section.value);
  throw new TypeError(`Unsupported ReviewModel section kind ${section.kind}`);
}

function drawOpenItems(doc, section, l, language) {
  const changes = section.groups.find((group) => group.id === "changes");
  const closing = section.groups.find((group) => group.id === "closing");
  if (!changes.items.length && !closing.items.length) {
    return paragraph(doc, l.noOpenItemsAtPeriodEnd);
  }
  subheading(doc, changes.title);
  if (changes.items.length) {
    drawTable(
      doc,
      [l.action, l.itemId, l.kind, l.party, l.total, l.dueDate, l.evidenceIds],
      changes.items.map((item) => [item.action, item.itemId, item.kind ?? "", item.party ?? "", formatMoneyDisplay(item.amount, language), item.dueDate ?? "", item.evidenceDocumentIds.join(", ")]),
      [55, 105, 70, 80, 76, 67, 50],
      ["left", "left", "left", "left", "right", "left", "left"],
      6.8,
    );
  } else empty(doc, section.emptyText);
  subheading(doc, closing.title);
  if (closing.items.length) {
    drawTable(
      doc,
      [l.itemId, l.kind, l.party, l.remaining, l.dueDate, l.evidenceIds],
      closing.items.map((item) => [item.itemId, item.kind, item.party, formatMoneyDisplay(item.remaining, language), item.dueDate ?? "", item.evidenceDocumentIds.join(", ")]),
      [105, 75, 90, 80, 70, 83],
      ["left", "left", "left", "right", "left", "left"],
      6.8,
    );
  } else empty(doc, section.emptyText);
}

function drawTransaction(doc, transaction, l, language) {
  const estimated = 76 + transaction.lines.length * 22;
  ensureSpace(doc, Math.min(estimated, 340));
  doc.moveDown(0.35);
  doc.font("ReportBold").fontSize(10).fillColor(COLORS.blue).text(`${transaction.verificationId}  ·  ${transaction.date}  ·  ${formatMoneyDisplay(transaction.total, language)}`);
  paragraph(doc, transaction.summary, { bold: true });
  drawKeyValues(doc, [[l.sourceId, transaction.sourceId], [l.description, transaction.description], [l.evidenceIds, transaction.evidenceDocumentIds.join(", ") || l.none]], 8);
  drawTable(doc, [l.account, l.accountName, l.debit, l.credit], transaction.lines.map((line) => [line.account, line.accountName, formatMoneyNumberDisplay(line.debit, language), formatMoneyNumberDisplay(line.credit, language)]), [65, 238, 100, 100], ["left", "left", "right", "right"], 8);
}

function verificationSummary(model, count) {
  const { labels: l, verification } = model;
  const first = verification.openingLastNumber + 1;
  const last = verification.closingLastNumber;
  const range = first === last ? `${verification.series}${first}` : `${verification.series}${first}–${verification.series}${last}`;
  const countLabel = count === 1 ? l.verificationSingular : l.verificationPlural;
  return `${l.verification} ${verification.series} · ${range} · ${count} ${countLabel}`;
}

function heading(doc, value) {
  ensureSpace(doc, 54);
  doc.x = PAGE.margin;
  doc.moveDown(0.9);
  doc.font("ReportBold").fontSize(13).fillColor(COLORS.text).text(value, PAGE.margin, doc.y, { width: contentWidth(doc) });
  const y = doc.y + 3;
  doc.moveTo(PAGE.margin, y).lineTo(PAGE.margin + contentWidth(doc), y).lineWidth(1.5).strokeColor(COLORS.blue).stroke();
  doc.y = y + 8;
}

function subheading(doc, value) {
  ensureSpace(doc, 32);
  doc.x = PAGE.margin;
  doc.moveDown(0.35).font("ReportBold").fontSize(9).fillColor(COLORS.text).text(value, PAGE.margin, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.15);
}

function paragraph(doc, value, { bold = false, muted = false } = {}) {
  ensureSpace(doc, 28);
  doc.x = PAGE.margin;
  doc.font(bold ? "ReportBold" : "Report").fontSize(9).fillColor(muted ? COLORS.muted : COLORS.text).text(String(value), PAGE.margin, doc.y, { width: contentWidth(doc), lineGap: 2 });
  doc.fillColor(COLORS.text);
  doc.moveDown(0.35);
}

function introParagraph(doc, value) {
  doc.moveDown(1.25);
  paragraph(doc, value);
}

function bullet(doc, value) {
  ensureSpace(doc, 24);
  doc.font("Report").fontSize(8.5).fillColor(COLORS.text).text(`•  ${value}`, PAGE.margin + 8, doc.y, { width: contentWidth(doc) - 8, indent: 0, lineGap: 2 });
  doc.x = PAGE.margin;
  doc.moveDown(0.25);
}

function empty(doc, value) {
  doc.x = PAGE.margin;
  doc.font("Report").fontSize(8.5).fillColor(COLORS.muted).text(value, PAGE.margin, doc.y, { width: contentWidth(doc) });
  doc.fillColor(COLORS.text).moveDown(0.25);
}

function preformatted(doc, value) {
  const options = { width: contentWidth(doc), lineGap: 1 };
  doc.font("Report").fontSize(7).fillColor(COLORS.text);
  for (const line of String(value).trimEnd().split("\n")) {
    const display = line || " ";
    ensureSpace(doc, doc.heightOfString(display, options));
    doc.text(display, PAGE.margin, doc.y, options);
  }
  doc.x = PAGE.margin;
  doc.moveDown(0.35);
}

function drawKeyValueRows(doc, rows, labels, emptyText) {
  if (!rows.length) return empty(doc, emptyText);
  drawTable(doc, [labels.path, labels.value], rows.map((item) => [item.path, item.value]), [170, 333]);
}

function drawKeyValues(doc, rows, fontSize = 8.5) {
  const widths = [105, contentWidth(doc) - 105];
  for (const [label, value] of rows) {
    const height = Math.max(doc.heightOfString(String(label), { width: widths[0] - 8 }), doc.heightOfString(String(value ?? ""), { width: widths[1] - 8 })) + 5;
    ensureSpace(doc, height);
    const y = doc.y;
    doc.font("Report").fontSize(fontSize).fillColor(COLORS.muted).text(String(label), PAGE.margin, y, { width: widths[0] - 8 });
    doc.fillColor(COLORS.text).text(String(value ?? ""), PAGE.margin + widths[0], y, { width: widths[1] - 8 });
    doc.y = y + height;
  }
  doc.x = PAGE.margin;
  doc.moveDown(0.25);
}

function drawTable(doc, headers, rows, widths, aligns = [], fontSize = 8) {
  const header = () => {
    const height = rowHeight(doc, headers, widths, fontSize, true);
    doc.rect(PAGE.margin, doc.y, widths.reduce((sum, value) => sum + value, 0), height).fill(COLORS.pale);
    drawRowText(doc, headers, widths, aligns, height, fontSize, true);
  };
  ensureSpace(doc, 42);
  header();
  for (const row of rows) {
    const height = rowHeight(doc, row, widths, fontSize, false);
    if (doc.y + height > pageBottom(doc)) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    drawRowText(doc, row, widths, aligns, height, fontSize, false);
    doc.moveTo(PAGE.margin, y + height).lineTo(PAGE.margin + widths.reduce((sum, value) => sum + value, 0), y + height).lineWidth(0.4).strokeColor(COLORS.line).stroke();
  }
  doc.x = PAGE.margin;
  doc.moveDown(0.35);
}

function drawRowText(doc, row, widths, aligns, height, fontSize, bold) {
  const y = doc.y;
  let x = PAGE.margin;
  doc.font(bold ? "ReportBold" : "Report").fontSize(fontSize).fillColor(COLORS.text);
  row.forEach((value, index) => {
    doc.text(String(value ?? ""), x + 4, y + 4, { width: widths[index] - 8, align: aligns[index] ?? "left", lineGap: 1 });
    x += widths[index];
  });
  doc.y = y + height;
}

function rowHeight(doc, row, widths, fontSize, bold) {
  doc.font(bold ? "ReportBold" : "Report").fontSize(fontSize);
  return Math.max(18, ...row.map((value, index) => doc.heightOfString(String(value ?? ""), { width: widths[index] - 8, lineGap: 1 }) + 8));
}

function addFooters(doc, model) {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const y = pageBottom(doc) + 18;
    doc.font("Report").fontSize(7).fillColor(COLORS.muted)
      .text(model.run.digest.slice(0, 16), PAGE.margin, y, { width: 240, lineBreak: false })
      .text(`${index - range.start + 1} / ${range.count}`, doc.page.width - PAGE.margin - 80, y, { width: 80, align: "right", lineBreak: false });
  }
}

function ensureSpace(doc, height) { if (doc.y + height > pageBottom(doc)) doc.addPage(); }
function pageBottom(doc) { return doc.page.height - PAGE.margin - PAGE.footer; }
function contentWidth(doc) { return doc.page.width - PAGE.margin * 2; }
function deterministicDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return new Date("2000-01-01T00:00:00.000Z");
  return date;
}

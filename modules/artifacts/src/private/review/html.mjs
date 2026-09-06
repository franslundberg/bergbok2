import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(DIRECTORY, "review.css"), "utf8");

export function renderReviewHtml(model) {
  const l = model.labels;
  return `<!doctype html>
<html lang="${escape(model.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escape(model.title)}</title>
<style>${CSS}</style>
</head>
<body><main>
<header>
  <h1>${escape(model.title)}</h1>
  <span class="status">${escape(model.outcomeLabel)}</span><span class="status ${model.approvalStatus === "preliminary" ? "preview" : ""}">${escape(model.approvalLabel)}</span>
  ${model.previewNotice ? `<p class="notice">${escape(model.previewNotice)}</p>` : ""}
  <dl class="meta">
    ${meta(l.company, model.company.display)}
    ${meta(l.period, model.period.display)}
    ${meta(l.run, model.run.digest)}
    ${meta(l.recorded, model.run.recordedAt)}
  </dl>
</header>
${model.sections.map((item) => renderSection(item, model)).join("")}
<footer class="footer"><code>OutputSnapshot ${escape(model.sourceDigest)}</code></footer>
</main></body></html>`;
}

function renderSection(item, model) {
  let body;
  if (item.kind === "paragraph") body = `<p>${escape(item.value)}</p>`;
  else if (item.kind === "notices") body = notices(item);
  else if (item.kind === "key_values") body = keyValueTable(item.rows, model.labels, item.emptyText);
  else if (item.kind === "transactions") body = transactions(item, model);
  else if (item.kind === "open_items") body = openItems(item, model);
  else if (item.kind === "balances") body = balances(item, model);
  else if (item.kind === "verification") body = verification(item, model);
  else if (item.kind === "reconciliations") body = reconciliations(item, model);
  else if (item.kind === "vat") body = vat(item, model);
  else if (item.kind === "simple_rows") body = simpleRows(item.rows, model.labels, item.emptyText);
  else throw new TypeError(`Unsupported ReviewModel section kind ${item.kind}`);
  return section(item.title, body);
}

function notices(section) {
  if (!section.groups.length) return empty(section.emptyText);
  return section.groups.map((group) => `<h3>${escape(group.title)}</h3><ul class="list">${group.items.map((item) => `<li>${escape(item.display)}</li>`).join("")}</ul>`).join("");
}

function transactions(section, model) {
  const l = model.labels;
  if (!section.items.length) return empty(section.emptyText);
  return section.items.map((item) => `<details>
<summary><strong>${escape(item.verificationId)}</strong><span>${escape(item.date)}</span><span>${escape(item.summary)}</span><span class="amount money">${escape(item.total)}</span></summary>
<div class="detail">
<dl class="meta">${meta(l.sourceId, item.sourceId)}${meta(l.description, item.description)}${meta(l.evidenceIds, item.evidenceDocumentIds.join(", ") || l.none)}</dl>
<div class="table-wrap"><table><thead><tr><th>${escape(l.account)}</th><th>${escape(l.accountName)}</th><th class="money">${escape(l.debit)}</th><th class="money">${escape(l.credit)}</th></tr></thead><tbody>
${item.lines.map((line) => `<tr><td><code>${escape(line.account)}</code></td><td>${escape(line.accountName)}</td><td class="money">${escape(line.debit)}</td><td class="money">${escape(line.credit)}</td></tr>`).join("")}
</tbody></table></div></div></details>`).join("");
}

function openItems(section, model) {
  const l = model.labels;
  const changesGroup = section.groups.find((group) => group.id === "changes");
  const closingGroup = section.groups.find((group) => group.id === "closing");
  const changes = changesGroup.items.length ? `<h3>${escape(changesGroup.title)}</h3>${table(
    [l.action, l.itemId, l.kind, l.party, l.total, l.dueDate, l.evidenceIds],
    changesGroup.items.map((item) => [item.action, item.itemId, item.kind, item.party, item.amount, item.dueDate, item.evidenceDocumentIds.join(", ")]),
    [false, false, false, false, true, false, false],
  )}` : `<h3>${escape(changesGroup.title)}</h3>${empty(section.emptyText)}`;
  const closing = closingGroup.items.length ? `<h3>${escape(closingGroup.title)}</h3>${table(
    [l.itemId, l.kind, l.party, l.remaining, l.dueDate, l.evidenceIds],
    closingGroup.items.map((item) => [item.itemId, item.kind, item.party, item.remaining, item.dueDate, item.evidenceDocumentIds.join(", ")]),
    [false, false, false, true, false, false],
  )}` : `<h3>${escape(closingGroup.title)}</h3>${empty(section.emptyText)}`;
  return `${changes}${closing}`;
}

function balances(section, model) {
  const l = model.labels;
  if (!section.items.length) return empty(section.emptyText);
  return table(
    [l.account, l.accountName, l.opening, l.movementDebit, l.movementCredit, l.closing],
    section.items.map((item) => [item.account, item.accountName, item.openingDisplay, item.movementDebit, item.movementCredit, item.closingDisplay]),
    [false, false, true, true, true, true],
  );
}

function verification(section, model) {
  if (!section.value) return empty(section.emptyText);
  const l = model.labels;
  return `<dl class="meta">${meta(l.series, section.value.series)}${meta(l.lastNumberOpening, section.value.openingLastNumber)}${meta(l.lastNumberClosing, section.value.closingLastNumber)}</dl>`;
}

function reconciliations(section, model) {
  const l = model.labels;
  if (!section.items.length) return empty(section.emptyText);
  return table(
    [l.account, l.status, l.ledger, l.external, l.evidenceIds],
    section.items.map((item) => [item.account, item.status, item.ledger_closing_balance, item.external_closing_balance, (item.evidence_document_ids ?? []).join(", ")]),
    [false, false, true, true, false],
  );
}

function vat(section, model) {
  if (!section.value) return empty(section.emptyText);
  const l = model.labels;
  const boxes = section.value.declaration_boxes
    ? table(["Box", l.total], Object.entries(section.value.declaration_boxes), [false, true]) : empty(section.emptyText);
  return `<dl class="meta">${meta(l.reportingFrequency, section.value.frequencyDisplay)}${meta(l.reportingPeriod, section.value.reportingPeriod)}${meta(l.dueInPeriod, section.value.dueDisplay)}${meta(l.status, section.value.status)}${meta(l.inputVatAccounts, section.value.inputAccountsDisplay)}${meta(l.outputVatAccounts, section.value.outputAccountsDisplay)}${meta(l.vatSettlementAccount, section.value.settlement_account)}${meta(l.vatClosingTransaction, section.value.closingTransactionDisplay)}</dl><h3>${escape(l.declarationBoxes)}</h3>${boxes}`;
}

function keyValueTable(rows, labels, emptyText) {
  return rows.length ? table([labels.path, labels.value], rows.map((item) => [item.path, item.value])) : empty(emptyText);
}

function simpleRows(rows, labels, emptyText) {
  return rows.length ? table([labels.kind, labels.value], rows.map((item) => [item.label, item.value])) : empty(emptyText);
}

function table(headers, rows, moneyColumns = []) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header, index) => `<th${moneyColumns[index] ? ' class="money"' : ""}>${escape(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value, index) => `<td${moneyColumns[index] ? ' class="money"' : ""}>${escape(value ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function section(title, body) { return `<section><h2>${escape(title)}</h2>${body}</section>`; }
function meta(label, value) { return `<dt>${escape(label)}</dt><dd>${escape(value ?? "")}</dd>`; }
function empty(value) { return `<p class="empty">${escape(value)}</p>`; }
function escape(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }

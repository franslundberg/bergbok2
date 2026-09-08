import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatMoneyDisplay, formatMoneyNumberDisplay, formatSignedBalanceNumberDisplay } from "./money-format.mjs";

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(DIRECTORY, "report.css"), "utf8");

export function renderReportHtml(model) {
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
  <p class="document-meta">${escape(model.header.identity)}</p>
  <h1>${escape(model.title)}</h1>
  <p class="report-context">${escape(model.header.context)}</p>
  ${model.previewNotice ? `<p class="notice">${escape(model.previewNotice)}</p>` : ""}
</header>
${model.sections.map((item) => renderSection(item, model)).join("")}
<footer class="footer"><code>Run ${escape(model.run.digest)}</code><br><code>OutputSnapshot ${escape(model.sourceDigest)}</code></footer>
</main></body></html>`;
}

function renderSection(item, model) {
  if (item.id === "core" && !item.groups.length) return "";
  if (item.id === "evidence") return "";
  if (item.id === "verification") return "";
  if (item.id === "summary") return `<section class="report-summary"><p>${escape(item.value)}</p></section>`;
  if (item.id === "provenance") {
    return section(item.title, `<details class="debug-details"><summary>${escape(model.labels.showDebug)}</summary><pre class="debug">${escape(item.value)}</pre></details>`);
  }
  let body;
  if (item.kind === "paragraph") body = `<p>${escape(item.value)}</p>`;
  else if (item.kind === "notices") body = notices(item);
  else if (item.kind === "field_groups") body = fieldGroups(item);
  else if (item.kind === "transactions") body = transactions(item, model);
  else if (item.kind === "open_items") body = openItems(item, model);
  else if (item.kind === "balances") body = balances(item, model);
  else if (item.kind === "verification") body = verification(item, model);
  else if (item.kind === "reconciliations") body = reconciliations(item, model);
  else if (item.kind === "vat") body = vat(item, model);
  else if (item.kind === "simple_rows") body = simpleRows(item.rows, model.labels, item.emptyText);
  else if (item.kind === "preformatted") body = `<pre class="debug">${escape(item.value)}</pre>`;
  else throw new TypeError(`Unsupported ReportModel section kind ${item.kind}`);
  return section(item.title, body);
}

function notices(section) {
  if (!section.groups.length) return empty(section.emptyText);
  return section.groups.map((group) => `<h3>${escape(group.title)}</h3><ul class="list">${group.items.map((item) => `<li>${escape(item.display)}</li>`).join("")}</ul>`).join("");
}

function transactions(section, model) {
  const l = model.labels;
  if (!section.items.length) return empty(section.emptyText);
  const verification = model.verification;
  const first = verification.openingLastNumber + 1;
  const last = verification.closingLastNumber;
  const range = first === last ? `${verification.series}${first}` : `${verification.series}${first}–${verification.series}${last}`;
  const countLabel = section.items.length === 1 ? l.verificationSingular : l.verificationPlural;
  const series = `<p class="section-meta">${escape(l.verification)} ${escape(verification.series)} · ${escape(range)} · ${section.items.length} ${escape(countLabel)}</p>`;
  return series + section.items.map((item) => `<details>
<summary><strong>${escape(item.verificationId)}</strong><span>${escape(item.date)}</span><span>${escape(item.summary)}</span><span class="amount money">${escape(formatMoneyDisplay(item.total, model.language))}</span></summary>
<div class="detail">
<dl class="meta">${meta(l.sourceId, item.sourceId)}${meta(l.evidenceIds, item.evidenceDocumentIds.join(", ") || l.none)}</dl>
<div class="table-wrap"><table><thead><tr><th>${escape(l.account)}</th><th>${escape(l.accountName)}</th><th class="money">${escape(l.debit)}</th><th class="money">${escape(l.credit)}</th></tr></thead><tbody>
${item.lines.map((line) => `<tr><td><code>${escape(line.account)}</code></td><td>${escape(line.accountName)}</td><td class="money">${escape(formatMoneyNumberDisplay(line.debit, model.language))}</td><td class="money">${escape(formatMoneyNumberDisplay(line.credit, model.language))}</td></tr>`).join("")}
</tbody></table></div></div></details>`).join("");
}

function openItems(section, model) {
  const l = model.labels;
  const changesGroup = section.groups.find((group) => group.id === "changes");
  const closingGroup = section.groups.find((group) => group.id === "closing");
  if (!changesGroup.items.length && !closingGroup.items.length) {
    return `<p>${escape(l.noOpenItemsAtPeriodEnd)}</p>`;
  }
  const changes = changesGroup.items.length ? `<h3>${escape(changesGroup.title)}</h3>${table(
    [l.date, l.action, l.itemId, l.kind, l.party, l.total, l.dueDate, l.evidenceIds],
    changesGroup.items.map((item) => [item.date, item.action, item.itemId, item.kind, item.party, item.amount, item.dueDate, item.evidenceDocumentIds.join(", ")]),
    [false, false, false, false, false, true, false, false], model.language,
  )}` : `<h3>${escape(changesGroup.title)}</h3>${empty(section.emptyText)}`;
  const closing = closingGroup.items.length ? `<h3>${escape(closingGroup.title)}</h3>${table(
    [l.itemId, l.kind, l.party, l.remaining, l.openedDate, l.dueDate, l.evidenceIds],
    closingGroup.items.map((item) => [item.itemId, item.kind, item.party, item.remaining, item.openedDate, item.dueDate, item.evidenceDocumentIds.join(", ")]),
    [false, false, false, true, false, false, false], model.language,
  )}` : `<h3>${escape(closingGroup.title)}</h3>${empty(section.emptyText)}`;
  return `${changes}${closing}`;
}

function balances(section, model) {
  const l = model.labels;
  if (!section.items.length) return empty(section.emptyText);
  return table(
    [l.account, l.accountName, l.opening, l.movementDebit, l.movementCredit, l.closing],
    section.items.map((item) => [
      item.account,
      item.accountName,
      formatSignedBalanceNumberDisplay(item.opening, model.language),
      formatMoneyNumberDisplay(item.movementDebit, model.language),
      formatMoneyNumberDisplay(item.movementCredit, model.language),
      formatSignedBalanceNumberDisplay(item.closing, model.language),
    ]),
    [false, false, true, true, true, true], model.language,
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
    [false, false, true, true, false], model.language,
  );
}

function vat(section, model) {
  if (!section.value) return empty(section.emptyText);
  const l = model.labels;
  if (!section.value.hasActivity && !section.value.due_in_period && !section.value.closing_transaction_source_id) {
    return `<p>${escape(l.noVatActivity)} ${escape(l.vatPeriodMembership)} ${escape(section.value.reportingPeriodDisplay)}; ${escape(l.noVatReturnDue)} ${escape(section.value.reportMonthDisplay)}.</p>`;
  }
  const boxes = section.value.declaration_boxes
    ? table(["Box", l.total], Object.entries(section.value.declaration_boxes), [false, true], model.language) : empty(section.emptyText);
  return `<dl class="meta">${meta(l.reportingFrequency, section.value.frequencyDisplay)}${meta(l.reportingPeriod, section.value.reportingPeriod)}${meta(l.dueInPeriod, section.value.dueDisplay)}${meta(l.status, section.value.status)}${meta(l.inputVatAccounts, section.value.inputAccountsDisplay)}${meta(l.outputVatAccounts, section.value.outputAccountsDisplay)}${meta(l.vatSettlementAccount, section.value.settlement_account)}${meta(l.vatClosingTransaction, section.value.closingTransactionDisplay)}</dl><h3>${escape(l.declarationBoxes)}</h3>${boxes}`;
}

function fieldGroups(section) {
  if (!section.groups.length) return empty(section.emptyText);
  const lead = section.lead ? `<p class="section-meta">${escape(section.lead)}</p>` : "";
  return lead + section.groups.map((group) => `<h3>${escape(group.title)}</h3><dl class="meta">${group.rows.map((row) => meta(row.label, row.value)).join("")}</dl>`).join("");
}

function simpleRows(rows, labels, emptyText) {
  return rows.length ? table([labels.kind, labels.value], rows.map((item) => [item.label, item.value])) : empty(emptyText);
}

function table(headers, rows, moneyColumns = [], language = null) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header, index) => `<th${moneyColumns[index] ? ' class="money"' : ""}>${escape(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value, index) => `<td${moneyColumns[index] ? ' class="money"' : ""}>${escape(moneyColumns[index] && language ? formatMoneyDisplay(value, language) : value ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function section(title, body) { return `<section><h2>${escape(title)}</h2>${body}</section>`; }
function meta(label, value) { return `<dt>${escape(label)}</dt><dd>${escape(value ?? "").replaceAll("\n", "<br>")}</dd>`; }
function empty(value) { return `<p class="empty">${escape(value)}</p>`; }
function escape(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }

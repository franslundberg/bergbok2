import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatMoneyDisplay, formatMoneyNumberDisplay, formatSignedBalanceNumberDisplay } from "./money-format.mjs";

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(DIRECTORY, "report.css"), "utf8");
const FONT_DIRECTORY = path.join(DIRECTORY, "fonts");
const FONT_CSS = [
  fontFace("Source Serif 4", "SourceSerif4-Latin.woff2", "400 600"),
  fontFace("IBM Plex Sans", "IBMPlexSans-Latin.woff2", "400 600"),
  fontFace("IBM Plex Mono", "IBMPlexMono-Regular-Latin.woff2", "400"),
  fontFace("IBM Plex Mono", "IBMPlexMono-Medium-Latin.woff2", "500"),
].join("\n");

export function renderReportHtml(model) {
  const l = model.labels;
  return `<!doctype html>
<html lang="${escape(model.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:">
<title>${escape(model.title)}</title>
<style>${FONT_CSS}\n${CSS}</style>
</head>
<body><main>
<header class="report-header">
  <p class="eyebrow">${escape(model.header.eyebrow)}</p>
  <h1>${escape(model.header.displayTitle)}</h1>
  <p class="lede">${escape(model.summary)}</p>
  <div class="idline">
    ${model.header.organizationNumber ? `<span>${escape(l.organizationNumber)} <b>${escape(model.header.organizationNumber)}</b></span>` : ""}
    <span>${escape(l.period)} <b>${escape(model.header.coverage)}</b></span>
    <span>${escape(l.status)} <span class="pill ${escape(model.header.statusTone)}">${escape(model.header.status)}</span></span>
    <span>${escape(l.created)} <b>${escape(model.header.created)}</b></span>
  </div>
</header>
${model.sections.map((item) => renderSection(item, model)).join("")}
<footer class="footer"><code>Run ${escape(model.run.digest)}</code><br><code>OutputSnapshot ${escape(model.sourceDigest)}</code></footer>
</main></body></html>`;
}

function renderSection(item, model) {
  if (item.id === "core" && !item.groups.length) return "";
  if (item.id === "evidence") return "";
  if (item.id === "verification") return "";
  if (item.id === "summary") return "";
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
  return section(item.htmlTitle ?? item.title, body);
}

function notices(section) {
  if (!section.groups.length) return empty(section.emptyText);
  if (!section.hasQuestions) {
    return `<ul class="list notes-list">${section.groups.flatMap((group) => group.items).map((item) => `<li>${escape(item.text)}</li>`).join("")}</ul>`;
  }
  return `<div class="attention-panel">${section.groups.map((group) => `<h3>${escape(group.htmlTitle ?? group.title)}</h3><ul class="list notes-list">${group.items.map((item) => `<li>${escape(item.text)}</li>`).join("")}</ul>`).join("")}</div>`;
}

function transactions(section, model) {
  const l = model.labels;
  if (!section.items.length) return empty(section.emptyText);
  const verification = model.verification;
  const first = verification.openingLastNumber + 1;
  const last = verification.closingLastNumber;
  const range = first === last ? `${verification.series}${first}` : `${verification.series}${first}–${verification.series}${last}`;
  const countLabel = section.items.length === 1 ? l.verificationSingular : l.verificationPlural;
  const series = `<p class="section-meta">${section.items.length} ${escape(countLabel)} · ${escape(range)}</p>`;
  return `${series}<div class="transaction-list">${section.items.map((item) => `<details class="transaction" id="${escape(verificationAnchor(item.verificationId))}">
<summary><strong>${escape(item.verificationId)}</strong><span>${escape(item.date)}</span><span>${escape(item.summary)}</span><span class="amount money">${escape(formatMoneyDisplay(item.total, model.language))}</span></summary>
<div class="detail">
<dl class="meta">${meta(l.sourceId, item.sourceId)}${meta(l.evidenceIds, item.evidenceDocumentIds.join(", ") || l.none)}</dl>
<div class="table-wrap"><table><thead><tr><th>${escape(l.account)}</th><th>${escape(l.accountName)}</th><th class="money">${escape(l.debit)}</th><th class="money">${escape(l.credit)}</th></tr></thead><tbody>
${item.lines.map((line) => `<tr><td><code>${escape(line.account)}</code></td><td>${escape(line.accountName)}</td><td class="money">${escape(formatMoneyNumberDisplay(line.debit, model.language))}</td><td class="money">${escape(formatMoneyNumberDisplay(line.credit, model.language))}</td></tr>`).join("")}
</tbody></table></div></div></details>`).join("")}</div>`;
}

function openItems(section, model) {
  const l = model.labels;
  const changesGroup = section.groups.find((group) => group.id === "changes");
  const closingGroup = section.groups.find((group) => group.id === "closing");
  if (!changesGroup.items.length && !closingGroup.items.length) {
    return `<p>${escape(l.noOpenItemsAtPeriodEnd)}</p>`;
  }
  const knownVerifications = new Set(model.transactions.map((item) => item.verificationId));
  const closing = closingGroup.items.length
    ? `<p class="section-meta">${escape(closingGroup.title)}</p><ul class="list">${closingGroup.items.map((item) => `<li>${escape(openItemSentence(item, l, model.language))}${openItemReference(item.openedVerificationId, knownVerifications, l)}</li>`).join("")}</ul>`
    : `<p class="section-meta">${escape(closingGroup.title)}</p>${empty(section.emptyText)}`;
  const changes = changesGroup.items.length ? `<details class="history-details"><summary>${escape(l.openItemHistory)} (${changesGroup.items.length})</summary><div class="detail">${table(
    [l.date, l.action, l.itemId, l.kind, l.party, l.total, l.dueDate, l.evidenceIds],
    changesGroup.items.map((item) => [item.date, item.action, item.itemId, item.kind, item.party, item.amount, item.dueDate, item.evidenceDocumentIds.join(", ")]),
    [false, false, false, false, false, true, false, false], model.language,
  )}</div></details>` : "";
  return `${closing}${changes}`;
}

// A verification is only worth linking when it appears in this same report; a period earlier
// than the one being rendered carries no anchor to jump to.
// "Skuld på 9 295,00 kr till Bolagsstiftarna AB. Förfallodatum: 2026-06-01." The "Se A1"
// reference is appended separately by the caller, since only it knows whether the
// verification can be linked in this document.
function openItemSentence(item, labels, language) {
  const noun = item.isPayable ? labels.openItemPayable : labels.openItemReceivable;
  const preposition = item.isPayable ? labels.openItemPayableParty : labels.openItemReceivableParty;
  const parts = [`${noun} ${labels.openItemAmountPrefix} ${formatMoneyDisplay(item.remaining, language)} ${preposition} ${item.party}.`];
  if (item.dueDate) parts.push(`${labels.dueDate}: ${item.dueDate}.`);
  return parts.join(" ");
}

function openItemReference(verificationId, knownVerifications, labels) {
  if (!verificationId) return "";
  const target = knownVerifications.has(verificationId)
    ? `<a href="#${escape(verificationAnchor(verificationId))}">${escape(verificationId)}</a>`
    : escape(verificationId);
  return ` ${escape(labels.openItemSeePrefix)} ${target}.`;
}

function verificationAnchor(verificationId) {
  return `verifikation-${verificationId}`;
}

function balances(section, model) {
  const l = model.labels;
  if (!section.items.length) return empty(section.emptyText);
  const used = section.items.filter((item) => item.usedInPeriod);
  const other = section.items.filter((item) => !item.usedInPeriod);
  const usedSummary = countPhrase(used.length, l.balanceAccountUsedOne, l.balanceAccountsUsedMany);
  const totalSummary = countPhrase(section.items.length, l.balanceAccountIncludedOne, l.balanceAccountsIncludedMany);
  const visible = used.length ? balanceTable(used, model) : "";
  const remaining = other.length
    ? `<details class="history-details balance-details"><summary>${escape(l.show)} ${escape(countPhrase(other.length, l.balanceOtherAccountOne, l.balanceOtherAccountsMany))}</summary><div class="detail">${balanceTable(other, model)}</div></details>`
    : "";
  return `<p class="section-meta">${escape(usedSummary)} · ${escape(totalSummary)}</p>${visible}${remaining}`;
}

function balanceTable(items, model) {
  const l = model.labels;
  return table(
    [l.account, l.accountName, l.opening, l.movementDebit, l.movementCredit, l.closing],
    items.map((item) => [
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

function countPhrase(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function verification(section, model) {
  if (!section.value) return empty(section.emptyText);
  const l = model.labels;
  return `<dl class="meta">${meta(l.series, section.value.series)}${meta(l.lastNumberOpening, section.value.openingLastNumber)}${meta(l.lastNumberClosing, section.value.closingLastNumber)}</dl>`;
}

function reconciliations(section, model) {
  const l = model.labels;
  if (!section.items.length) return empty(section.emptyText);
  const rows = section.items.map((item) => {
    const tone = item.status === "reconciled" ? "ok" : "attention";
    return `<tr><td>${escape(item.account)}</td><td><span class="pill ${tone}">${escape(item.statusDisplay)}</span></td><td class="money">${escape(formatMoneyDisplay(item.ledger_closing_balance, model.language))}</td><td class="money">${escape(formatMoneyDisplay(item.external_closing_balance, model.language))}</td><td>${escape((item.evidence_document_ids ?? []).join(", "))}</td></tr>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr><th>${escape(l.account)}</th><th>${escape(l.status)}</th><th class="money">${escape(l.ledger)}</th><th class="money">${escape(l.external)}</th><th>${escape(l.evidenceIds)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function vat(section, model) {
  if (!section.value) return empty(section.emptyText);
  const l = model.labels;
  if (!section.value.hasActivity && !section.value.due_in_period && !section.value.closing_transaction_source_id) {
    return `<p>${escape(l.noVatActivity)} ${escape(l.vatPeriodMembership)} ${escape(section.value.reportingPeriodDisplay)}; ${escape(l.noVatReturnDue)} ${escape(section.value.reportMonthDisplay)}.</p>`;
  }
  const cycle = `${meta(l.reportingFrequency, section.value.frequencyDisplay)}${meta(l.reportingPeriod, section.value.reportingPeriod)}${meta(l.dueInPeriod, section.value.dueDisplay)}`;
  if (!section.value.due_in_period) return `<dl class="meta">${cycle}</dl>`;
  const rows = section.value.htmlDeclarationBoxRows;
  const result = section.value.htmlVatResult;
  if (!rows.length) {
    return `<dl class="meta">${cycle}</dl><p><strong>${escape(result.label)}: ${escape(formatMoneyDisplay(result.amount, model.language))}</strong></p>`;
  }
  const header = `<thead><tr><th>${escape(l.declarationBox)}</th><th class="money">${escape(l.total)}</th></tr></thead>`;
  const body = `${rows.map((item) => `<tr><td>${escape(item.label)}</td><td class="money">${escape(formatMoneyDisplay(item.amount, model.language))}</td></tr>`).join("")}<tr class="total"><td>${escape(result.label)}</td><td class="money">${escape(formatMoneyDisplay(result.amount, model.language))}</td></tr>`;
  return `<dl class="meta">${cycle}</dl><h3>${escape(l.declarationBoxes)}</h3><div class="table-wrap"><table>${header}<tbody>${body}</tbody></table></div>`;
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

function fontFace(family, filename, weight) {
  const data = readFileSync(path.join(FONT_DIRECTORY, filename)).toString("base64");
  return `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${weight}; font-display: swap; src: url("data:font/woff2;base64,${data}") format("woff2"); }`;
}

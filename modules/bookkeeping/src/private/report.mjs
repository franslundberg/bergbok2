import { formatMoney, parseMoney } from "../../../../contracts/src/index.mjs";

const SWEDISH_MESSAGES = Object.freeze({
  ACCOUNT_INVALID: "Ange ett giltigt fyrsiffrigt BAS-konto.",
  ACCOUNT_UNKNOWN: "Kontot kunde inte identifieras.",
  BOOKKEEPING_MONEY_INVALID: "Bokföringsbeloppet är ogiltigt.",
  EVIDENCE_NOT_IN_DOCSET: "Hänvisningen måste avse ett dokument i periodens underlag.",
  OPEN_ITEM_CHANGES_INVALID: "Öppna betalningsposter måste anges som en lista.",
  OPEN_ITEM_CHANGES_NOT_ALLOWED: "Den här periodtypen får inte innehålla ändringar av öppna betalningsposter.",
  PERIOD_IMBALANCE: "Periodens fullständiga förändring är inte balanserad.",
  PREVIOUS_BOOKKEEPING_MONEY_INVALID: "Det tidigare bokföringsunderlagets belopp är ogiltigt.",
  PAYROLL_POSTINGS_NOT_ALLOWED: "Den här periodtypen får inte innehålla löneposteringar.",
  PAYROLL_TRANSACTION_OUTSIDE_PERIOD: "En lönetransaktion ligger utanför bokföringsperioden.",
  RECONCILIATION_DUPLICATE: "Kontot har redan stämts av en gång.",
  RECONCILIATION_MISMATCH: "Bokfört saldo stämmer inte med det externa underlaget.",
  RECONCILIATIONS_INVALID: "Avstämningar måste anges som en lista.",
  START_RECONCILIATIONS_NOT_ALLOWED: "Start får inte innehålla avstämningar.",
  START_VAT_NOT_ALLOWED: "Start får inte fastställa moms.",
  TRANSACTIONS_NOT_ALLOWED: "Den här periodtypen får inte innehålla transaktioner.",
  TRANSACTION_IMBALANCE: "Transaktionens debet och kredit balanserar inte.",
  UNSUPPORTED_ACCOUNTING_METHOD: "Endast faktureringsmetoden stöds.",
  UNSUPPORTED_COUNTRY: "Endast Sverige stöds.",
  UNSUPPORTED_CURRENCY: "Endast SEK stöds.",
  UNSUPPORTED_FISCAL_YEAR: "Endast kalenderår stöds.",
  UNSUPPORTED_MODE: "De stödda lägena är start, import och ordinary.",
  UNSUPPORTED_PROFILE: "Den angivna bokföringsprofilen stöds inte.",
  UNSUPPORTED_VERIFICATION_SERIES: "Prototypen stöder verifikationsserie A.",
  VAT_INVALID: "Momsuppgifterna är ogiltiga.",
  VAT_OUTPUT_REQUIRED: "Momsuppgifter krävs vid den konfigurerade rapportperiodens slut.",
});

export function localizeBookkeepingItems(items, language, textKey) {
  if (language !== "sv") return items;
  return items.map((item) => {
    const replacement = SWEDISH_MESSAGES[item.code];
    return replacement ? { ...item, [textKey]: replacement } : item;
  });
}

export function proposalReport({ caseBundle, output, warnings, payrollCount, language = "sv" }) {
  if (language === "sv") return swedishProposal({ caseBundle, output, warnings, payrollCount });
  const rows = output.ledger.transactions.map((transaction) =>
    `| ${transaction.verification_id} | ${transaction.date} | ${escapeCell(transaction.description)} | ${sumMoney(transaction.lines.map((line) => line.debit), output.ledger.currency)} |`);
  return [
    `# Bookkeeping proposal — ${caseBundle.payload.period.id}`,
    "",
    "> Proposal only. Nothing has been persisted, approved, posted, filed, or submitted.",
    "",
    "## Result",
    "",
    `- Company: ${output.organization.name} (${output.organization.organization_number})`,
    `- Transactions: ${output.ledger.transactions.length}`,
    `- Payroll transactions accepted from authoritative upstream results: ${payrollCount}`,
    `- Total debit and credit: ${output.ledger.totals.debit}`,
    `- Closing open items: ${output.open_items.totals.count}`,
    `- VAT status: ${output.vat_period.status}`,
    "",
    "## Transactions",
    "",
    "| Verification | Date | Description | Debit |",
    "| --- | --- | --- | ---: |",
    ...(rows.length ? rows : ["| — | — | No period transactions | 0.00 SEK |"]),
    "",
    "## Reconciliation",
    "",
    ...(output.reconciliations.length
      ? output.reconciliations.map((item) => `- ${item.account}: ${item.status}`)
      : ["- No reconciliation accounts supplied."]),
    "",
    "## Warnings",
    "",
    ...(warnings.length ? warnings.map((item) => `- ${item.code}: ${item.message}`) : ["- None."]),
    "",
  ].join("\n");
}

function swedishProposal({ caseBundle, output, warnings, payrollCount }) {
  const rows = output.ledger.transactions.map((transaction) =>
    `| ${transaction.verification_id} | ${transaction.date} | ${escapeCell(transaction.description)} | ${sumMoney(transaction.lines.map((line) => line.debit), output.ledger.currency)} |`);
  return [
    `# Bokföringsförslag – ${caseBundle.payload.period.id}`,
    "",
    "> Endast förslag. Ingenting har godkänts, bokförts, betalats, deklarerats eller skickats in.",
    "",
    "## Resultat",
    "",
    `- Företag: ${output.organization.name} (${output.organization.organization_number})`,
    `- Transaktioner: ${output.ledger.transactions.length}`,
    `- Lönetransaktioner från godkänt underlag: ${payrollCount}`,
    `- Debet och kredit: ${output.ledger.totals.debit}`,
    `- Öppna betalningsposter: ${output.open_items.totals.count}`,
    `- Momsstatus: ${output.vat_period.status}`,
    "",
    "## Föreslagna transaktioner",
    "",
    "| Verifikation | Datum | Beskrivning | Debet |",
    "| --- | --- | --- | ---: |",
    ...(rows.length ? rows : ["| — | — | Inga transaktioner för perioden | 0.00 SEK |"]),
    "",
    "## Avstämning",
    "",
    ...(output.reconciliations.length
      ? output.reconciliations.map((item) => `- ${item.account}: ${item.status}`)
      : ["- Inga avstämningskonton angivna."]),
    "",
    "## Varningar",
    "",
    ...(warnings.length ? warnings.map((item) => `- ${item.code}: ${item.message}`) : ["- Inga."]),
    "",
  ].join("\n");
}

export function needsInputReport(caseBundle, questions, language = "sv") {
  if (language === "sv") {
    return [
      `# Bokföring behöver svar – ${caseBundle.payload.period.id}`,
      "",
      "> Inget förslag eller auktoritativt State skapades.",
      "",
      "## Frågor",
      "",
      ...questions.map((item) => `${item.question_id}. **${item.code}** – ${item.prompt}`),
      "",
    ].join("\n");
  }
  return [
    `# Bookkeeping needs input — ${caseBundle.payload.period.id}`,
    "",
    "> No proposal or authoritative State was created.",
    "",
    "## Questions",
    "",
    ...questions.map((item) => `${item.question_id}. **${item.code}** — ${item.prompt}`),
    "",
  ].join("\n");
}

export function outOfScopeReport(caseBundle, reasons, language = "sv") {
  if (language === "sv") {
    return [
      `# Bokföring ligger utanför profilen – ${caseBundle.payload.period.id}`,
      "",
      "> Ärendet ligger utanför den avsiktligt begränsade bokföringsprofilen.",
      "",
      ...reasons.map((item) => `- **${item.code}** – ${item.message}`),
      "",
    ].join("\n");
  }
  return [
    `# Bookkeeping out of scope — ${caseBundle.payload.period.id}`,
    "",
    "> The case is outside this deliberately narrow Bookkeeping profile.",
    "",
    ...reasons.map((item) => `- **${item.code}** — ${item.message}`),
    "",
  ].join("\n");
}

function sumMoney(values, currency) {
  return formatMoney(values.reduce((sum, value) => sum + parseMoney(value, { expectedCurrency: currency }).minorUnits, 0n), currency);
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

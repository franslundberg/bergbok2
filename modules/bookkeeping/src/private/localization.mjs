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
  TRANSACTIONS_NOT_ALLOWED: "Den här periodtypen får inte innehålla transaktioner.",
  TRANSACTION_IMBALANCE: "Transaktionens debet och kredit balanserar inte.",
  UNSUPPORTED_ACCOUNTING_METHOD: "Endast faktureringsmetoden stöds.",
  UNSUPPORTED_CHART_OF_ACCOUNTS: "Endast BAS-kontoplanen stöds.",
  UNSUPPORTED_COUNTRY: "Endast Sverige stöds.",
  UNSUPPORTED_CURRENCY: "Endast SEK stöds.",
  UNSUPPORTED_FISCAL_YEAR: "Endast kalenderår stöds.",
  UNSUPPORTED_MODE: "De stödda lägena är start, import och ordinary.",
  UNSUPPORTED_PROFILE: "Den angivna bokföringsprofilen stöds inte.",
  UNSUPPORTED_VERIFICATION_SERIES: "Prototypen stöder verifikationsserie A.",
  UNSUPPORTED_VAT_FREQUENCY: "Prototypen stöder kvartalsvis momsredovisning.",
  INVALID_VAT_ACCOUNT_POLICY: "Momsprincipen måste ange konton för ingående moms, utgående moms och momsredovisning.",
  VAT_ACCOUNT_NOT_CONFIGURED: "En momstransaktion använder ett konto som inte ingår i bolagets momsprincip.",
  VAT_CLOSING_SOURCE_ID_RESERVED: "Käll-id:t vat-closing är reserverat för den automatiska momsombokningen.",
  VAT_INPUT_ACCOUNT_SIDE_INVALID: "Ett konto för ingående moms har kreditsaldo före momsombokningen.",
  VAT_NOT_CANDIDATE_SUPPLIED: "Moms bestäms av bolagets redovisningscykel och kontosaldon och får inte anges av kandidaten.",
  VAT_OUTPUT_ACCOUNT_SIDE_INVALID: "Ett konto för utgående moms har debetsaldo före momsombokningen.",
  VAT_OUTPUT_SPLIT_UNSUPPORTED: "Automatisk fördelning av utgående moms på flera rutor stöds inte med fler än ett konfigurerat konto.",
  VAT_PERIOD_SPANS_MULTIPLE_DEADLINES: "En bokföringsperiod får inte omfatta mer än ett kvartalsslut för moms.",
});

export function localizeBookkeepingItems(items, language, textKey) {
  if (language !== "sv") return items;
  return items.map((item) => {
    const replacement = SWEDISH_MESSAGES[item.code];
    return replacement ? { ...item, [textKey]: replacement } : item;
  });
}

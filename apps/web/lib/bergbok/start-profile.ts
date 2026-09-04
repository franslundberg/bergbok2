import {
  PILOT_CHART_OF_ACCOUNTS,
  PILOT_ORGANIZATION_TYPE,
  PILOT_VAT_FREQUENCY,
} from "./pilot-policy.ts";
import type { StartProfile, StartProfileFact } from "./types.ts";

type EvidenceDocument = {
  id: string;
  filename: string;
  contentUrl: string;
  text: string;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const displayValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const humanAccountingMethod = (value: unknown) =>
  value === "invoice" ? "Faktureringsmetoden" : value === "cash" ? "Kontantmetoden" : null;

const humanVatFrequency = (value: string) =>
  value === "quarterly" ? "Kvartalsvis" : value === "monthly" ? "Månadsvis" : value;

const addressValue = (value: unknown) => {
  const address = asRecord(value);
  const cityLine = [displayValue(address.postal_code), displayValue(address.city)]
    .filter(Boolean)
    .join(" ");
  return [displayValue(address.street), cityLine || null, displayValue(address.country)]
    .filter(Boolean)
    .join(", ");
};

const withoutPersonalNumber = (value: string) =>
  value.replace(/,?\s*personnummer\s*:\s*\d{6,8}-\d{4}\.?/gi, "").trim();

const evidenceFact = (
  label: string,
  value: string,
  document: EvidenceDocument,
): StartProfileFact => ({
  label,
  value: withoutPersonalNumber(value.replace(/[.。]\s*$/, "").trim()),
  source: "evidence",
  documentId: document.id,
  filename: document.filename,
  contentUrl: document.contentUrl,
});

function evidenceFacts(documents: EvidenceDocument[]) {
  const facts: StartProfileFact[] = [];
  const labels = new Set<string>();
  const add = (fact: StartProfileFact) => {
    if (!fact.value || labels.has(fact.label)) return;
    labels.add(fact.label);
    facts.push(fact);
  };

  for (const document of documents) {
    for (const sourceLine of document.text.split(/\r?\n/)) {
      const line = sourceLine.replace(/^\s*[-*]\s*/, "").trim();
      if (!line) continue;
      const pair = /^([^:]{2,60}):\s*(.+)$/.exec(line);
      const key = pair?.[1].trim().toLocaleLowerCase("sv") ?? "";
      const value = pair?.[2].trim() ?? line;

      if (key === "aktier") add(evidenceFact("Ägare och aktiekapital", value, document));
      else if (key === "styrelseledamot") add(evidenceFact("Styrelseledamot", value, document));
      else if (key === "styrelsesuppleant") add(evidenceFact("Styrelsesuppleant", value, document));
      else if (key === "e-post") add(evidenceFact("E-post", value, document));
      else if (key === "telefon") add(evidenceFact("Telefon", value, document));
      else if (key === "kontotyp") add(evidenceFact("Bankkonto", value, document));
      else if (key === "kontonummer") add(evidenceFact("Kontonummer", value, document));
      else if (key === "iban") add(evidenceFact("IBAN", value, document));
      else if (key === "bic") add(evidenceFact("BIC", value, document));
      else if (key === "bankgironummer") add(evidenceFact("Bankgiro", value, document));
      else if (key.startsWith("betalkort") && !key.includes("privat"))
        add(evidenceFact("Betalkort", value, document));
      else if (/första bokföringsdagen/i.test(line))
        add(evidenceFact("Första bokföringsdag", line, document));
      else if (/vanlig BAS-kontoplan/i.test(line))
        add(evidenceFact("Kontoplan enligt underlaget", line, document));
      else if (/anläggningstillgångar/i.test(line))
        add(evidenceFact("Anläggningstillgångar", line, document));
      else if (/direktavskrivningar/i.test(line))
        add(evidenceFact("Direktavskrivningar", line, document));
    }
  }
  return facts;
}

export function buildStartProfile(
  outcome: Record<string, unknown>,
  documents: EvidenceDocument[],
): StartProfile | null {
  const changes = Array.isArray(outcome.proposed_changes) ? outcome.proposed_changes : [];
  const initialization = changes
    .map(asRecord)
    .find((change) => change.action === "initialize_core_state");
  if (!initialization) return null;
  const core = asRecord(initialization.core);
  const organization = asRecord(core.organization);
  const registrations = asRecord(core.registrations);
  const policies = asRecord(core.policies);
  const fiscalYear = asRecord(policies.fiscal_year);
  const identity: StartProfileFact[] = [];
  const accounting: StartProfileFact[] = [];
  const add = (
    target: StartProfileFact[],
    label: string,
    value: string | null,
    source: "proposal" | "policy",
  ) => {
    if (value) target.push({ label, value, source });
  };

  add(identity, "Företagsform", PILOT_ORGANIZATION_TYPE, "policy");
  add(identity, "Företag", displayValue(organization.name), "proposal");
  add(identity, "Organisationsnummer", displayValue(organization.organization_number), "proposal");
  add(identity, "Adress", addressValue(core.address) || null, "proposal");
  add(identity, "Momsregistreringsnummer", displayValue(registrations.vat_number), "proposal");
  add(identity, "EORI-nummer", displayValue(registrations.eori_number), "proposal");

  add(accounting, "Bokföringsmetod", humanAccountingMethod(policies.accounting_method), "policy");
  const fiscalStart = displayValue(fiscalYear.start);
  const fiscalEnd = displayValue(fiscalYear.end);
  add(
    accounting,
    "Räkenskapsår",
    fiscalStart && fiscalEnd ? `${fiscalStart}–${fiscalEnd}` : null,
    "policy",
  );
  add(accounting, "Momsperiod", humanVatFrequency(PILOT_VAT_FREQUENCY), "policy");
  add(accounting, "Kontoplan", PILOT_CHART_OF_ACCOUNTS, "policy");
  add(accounting, "Bokföringsstart", displayValue(core.bookkeeping_start_date), "proposal");

  return { identity, accounting, evidence: evidenceFacts(documents) };
}

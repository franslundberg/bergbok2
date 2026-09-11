export const PILOT_ORGANIZATION_TYPE = "Privat svenskt aktiebolag";
export const PILOT_CHART_OF_ACCOUNTS = "BAS";
// The account-to-box mapping is the published BAS standard, so the policy names
// a chart rather than listing accounts. box_overrides carries the deviations a
// company actually has, and no pilot company has any.
export const PILOT_VAT_POLICY = Object.freeze({
  frequency: "quarterly",
  chart: "BAS-2026",
  settlement_account: "2650",
  box_overrides: Object.freeze([]),
});
// Which BAS accounts each open-item kind must sum to, and the side it stands on. This is
// controller configuration: it is always injected here, never read from the approved core
// State and never supplied by the assessment, so the model cannot alter the check it is
// measured against.
export const PILOT_OPEN_ITEM_POLICY = Object.freeze({
  supplier_payable: Object.freeze({ accounts: Object.freeze(["2440"]), side: "credit" }),
  customer_receivable: Object.freeze({ accounts: Object.freeze(["1510"]), side: "debit" }),
  related_party_payable: Object.freeze({ accounts: Object.freeze(["2893"]), side: "credit" }),
  other_current_payable: Object.freeze({ accounts: Object.freeze(["2890"]), side: "credit" }),
  other_current_receivable: Object.freeze({ accounts: Object.freeze(["1680"]), side: "debit" }),
});

type VatReportingPolicy = {
  frequency: string;
  chart: string;
  settlement_account: string;
  box_overrides: readonly unknown[];
};

type CoreState = {
  policies?: {
    bookkeeping?: {
      chart_of_accounts?: string;
      vat_reporting?: VatReportingPolicy;
    };
  };
};

export const effectivePoliciesForYear = (
  year: string,
  core: CoreState = {},
  { onboarding = false } = {},
) => {
  const trusted = core.policies?.bookkeeping;
  if (!onboarding && !trusted?.vat_reporting) {
    throw new Error("Approved company State is missing its VAT reporting policy");
  }
  const chartOfAccounts = trusted?.chart_of_accounts ?? PILOT_CHART_OF_ACCOUNTS;
  const vatReporting = trusted?.vat_reporting ?? PILOT_VAT_POLICY;
  assertPilotPolicy(chartOfAccounts, vatReporting);
  return {
    core: {
      country: "SE",
      currency: "SEK",
      fiscal_year: { start: `${year}-01-01`, end: `${year}-12-31` },
      accounting_method: "invoice",
    },
    bookkeeping: {
      profile: "se-private-ab-invoice-calendar-demo-v1",
      verification_series: "A",
      chart_of_accounts: chartOfAccounts,
      vat_reporting: structuredClone(vatReporting),
      open_items: structuredClone(PILOT_OPEN_ITEM_POLICY),
    },
  };
};

function assertPilotPolicy(chartOfAccounts: string, vat: VatReportingPolicy) {
  if (
    chartOfAccounts !== PILOT_CHART_OF_ACCOUNTS ||
    vat.frequency !== PILOT_VAT_POLICY.frequency ||
    vat.chart !== PILOT_VAT_POLICY.chart ||
    JSON.stringify(vat.box_overrides ?? []) !== JSON.stringify(PILOT_VAT_POLICY.box_overrides) ||
    vat.settlement_account !== PILOT_VAT_POLICY.settlement_account
  ) {
    throw new Error("Approved company VAT policy is outside the Fiktiv AB Pilot profile");
  }
}

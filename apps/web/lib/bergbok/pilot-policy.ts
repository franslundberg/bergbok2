export const PILOT_ORGANIZATION_TYPE = "Privat svenskt aktiebolag";
export const PILOT_CHART_OF_ACCOUNTS = "BAS";
export const PILOT_VAT_POLICY = Object.freeze({
  frequency: "quarterly",
  input_accounts: Object.freeze(["2641"]),
  output_accounts: Object.freeze(["2611"]),
  settlement_account: "2650",
});

type VatReportingPolicy = {
  frequency: string;
  input_accounts: readonly string[];
  output_accounts: readonly string[];
  settlement_account: string;
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
    },
  };
};

function assertPilotPolicy(chartOfAccounts: string, vat: VatReportingPolicy) {
  if (
    chartOfAccounts !== PILOT_CHART_OF_ACCOUNTS ||
    vat.frequency !== PILOT_VAT_POLICY.frequency ||
    JSON.stringify(vat.input_accounts) !== JSON.stringify(PILOT_VAT_POLICY.input_accounts) ||
    JSON.stringify(vat.output_accounts) !== JSON.stringify(PILOT_VAT_POLICY.output_accounts) ||
    vat.settlement_account !== PILOT_VAT_POLICY.settlement_account
  ) {
    throw new Error("Approved company VAT policy is outside the Fiktiv AB Pilot profile");
  }
}

export const PILOT_ORGANIZATION_TYPE = "Privat svenskt aktiebolag";
export const PILOT_CHART_OF_ACCOUNTS = "BAS";
export const PILOT_VAT_FREQUENCY = "quarterly";

export const effectivePoliciesForYear = (year: string) => ({
  core: {
    country: "SE",
    currency: "SEK",
    fiscal_year: { start: `${year}-01-01`, end: `${year}-12-31` },
    accounting_method: "invoice",
  },
  bookkeeping: {
    profile: "se-private-ab-invoice-calendar-demo-v1",
    verification_series: "A",
    vat_reporting: { frequency: PILOT_VAT_FREQUENCY },
  },
});

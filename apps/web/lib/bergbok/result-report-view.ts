export const CANONICAL_MONEY = /^(-?)(\d+)(?:\.(\d+))? ([A-Z]{3})$/;

export function formatResultReportMoney(value: string | null | undefined, currency: string) {
  if (value === null || value === undefined) return "—";
  const match = CANONICAL_MONEY.exec(value);
  if (!match || match[4] !== currency) return "—";
  const [, sign, major, fraction = ""] = match;
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  return `${sign ? "−" : ""}${grouped}${fraction ? `,${fraction}` : ""}`;
}

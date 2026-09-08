export function formatMoneyDisplay(value, language) {
  return format(value, language, true);
}

export function formatMoneyNumberDisplay(value, language) {
  return format(value, language, false);
}

function format(value, language, includeCurrency) {
  if (value === null || value === undefined) return "";
  const source = String(value);
  const match = /^(-?)(\d+)\.(\d{2}) ([A-Z]{3})(?: (.+))?$/.exec(source);
  if (!match) return source;
  const [, sign, integer, fraction, currency, suffix] = match;
  const grouped = language === "sv"
    ? integer.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0")
    : integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const number = language === "sv" ? `${sign}${grouped},${fraction}` : `${sign}${grouped}.${fraction}`;
  const amount = includeCurrency
    ? language === "sv" ? `${number}\u00a0${currency === "SEK" ? "kr" : currency}` : `${currency}\u00a0${number}`
    : number;
  return suffix ? `${amount} ${suffix}` : amount;
}

export function formatSignedBalanceDisplay(value, language) {
  if (!value || typeof value.amount !== "string") return "";
  const amount = value.side === "credit" ? `-${value.amount}` : value.amount;
  return formatMoneyDisplay(amount, language);
}

export function formatSignedBalanceNumberDisplay(value, language) {
  if (!value || typeof value.amount !== "string") return "";
  const amount = value.side === "credit" ? `-${value.amount}` : value.amount;
  return formatMoneyNumberDisplay(amount, language);
}

export const ISO_4217_SOURCE = Object.freeze({
  authority: "SIX Financial Information AG, ISO 4217 Maintenance Agency",
  url: "https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml",
  published: "2026-01-01",
  sha256: "838dfb991648cf36df939edd5fe3811737962b75a32252847d239cedd1e291c9",
});

// Current List One codes whose CcyMnrUnts value is numeric. Entries marked
// N.A. by the maintenance agency are deliberately absent because they do not
// define the fixed scale required by canonical Money.
export const ISO_4217_MINOR_UNITS = Object.freeze({
  AED: 2, AFN: 2, ALL: 2, AMD: 2, AOA: 2, ARS: 2, AUD: 2, AWG: 2, AZN: 2,
  BAM: 2, BBD: 2, BDT: 2, BHD: 3, BIF: 0, BMD: 2, BND: 2, BOB: 2, BOV: 2,
  BRL: 2, BSD: 2, BTN: 2, BWP: 2, BYN: 2, BZD: 2, CAD: 2, CDF: 2, CHE: 2,
  CHF: 2, CHW: 2, CLF: 4, CLP: 0, CNY: 2, COP: 2, COU: 2, CRC: 2, CUP: 2,
  CVE: 2, CZK: 2, DJF: 0, DKK: 2, DOP: 2, DZD: 2, EGP: 2, ERN: 2, ETB: 2,
  EUR: 2, FJD: 2, FKP: 2, GBP: 2, GEL: 2, GHS: 2, GIP: 2, GMD: 2, GNF: 0,
  GTQ: 2, GYD: 2, HKD: 2, HNL: 2, HTG: 2, HUF: 2, IDR: 2, ILS: 2, INR: 2,
  IQD: 3, IRR: 2, ISK: 0, JMD: 2, JOD: 3, JPY: 0, KES: 2, KGS: 2, KHR: 2,
  KMF: 0, KPW: 2, KRW: 0, KWD: 3, KYD: 2, KZT: 2, LAK: 2, LBP: 2, LKR: 2,
  LRD: 2, LSL: 2, LYD: 3, MAD: 2, MDL: 2, MGA: 2, MKD: 2, MMK: 2, MNT: 2,
  MOP: 2, MRU: 2, MUR: 2, MVR: 2, MWK: 2, MXN: 2, MXV: 2, MYR: 2, MZN: 2,
  NAD: 2, NGN: 2, NIO: 2, NOK: 2, NPR: 2, NZD: 2, OMR: 3, PAB: 2, PEN: 2,
  PGK: 2, PHP: 2, PKR: 2, PLN: 2, PYG: 0, QAR: 2, RON: 2, RSD: 2, RUB: 2,
  RWF: 0, SAR: 2, SBD: 2, SCR: 2, SDG: 2, SEK: 2, SGD: 2, SHP: 2, SLE: 2,
  SOS: 2, SRD: 2, SSP: 2, STN: 2, SVC: 2, SYP: 2, SZL: 2, THB: 2, TJS: 2,
  TMT: 2, TND: 3, TOP: 2, TRY: 2, TTD: 2, TWD: 2, TZS: 2, UAH: 2, UGX: 0,
  USD: 2, USN: 2, UYI: 0, UYU: 2, UYW: 4, UZS: 2, VED: 2, VES: 2, VND: 0,
  VUV: 0, WST: 2, XAD: 2, XAF: 0, XCD: 2, XCG: 2, XOF: 0, XPF: 0, YER: 2,
  ZAR: 2, ZMW: 2, ZWG: 2,
});

const MONEY_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))? ([A-Z]{3})$/;

export function currencyMinorUnits(currency) {
  if (typeof currency !== "string" || !Object.hasOwn(ISO_4217_MINOR_UNITS, currency)) {
    throw new RangeError(`Unsupported ISO 4217 currency: ${String(currency)}`);
  }
  return ISO_4217_MINOR_UNITS[currency];
}

export function parseMoney(value, { expectedCurrency } = {}) {
  if (typeof value !== "string") throw new TypeError("Money must be a string");
  const match = MONEY_PATTERN.exec(value);
  if (!match) throw new TypeError(`Invalid canonical Money: ${value}`);

  const [, sign, major, fraction, currency] = match;
  const exponent = currencyMinorUnits(currency);
  if (expectedCurrency !== undefined && currency !== expectedCurrency) {
    throw new RangeError(`Expected Money in ${expectedCurrency}, received ${currency}`);
  }
  if (exponent === 0 && fraction !== undefined) {
    throw new TypeError(`${currency} Money must not contain decimal places`);
  }
  if (exponent > 0 && (fraction === undefined || fraction.length !== exponent)) {
    throw new TypeError(`${currency} Money must contain exactly ${exponent} decimal places`);
  }

  const fractionalDigits = fraction ?? "";
  if (sign === "-" && major === "0" && /^0*$/.test(fractionalDigits)) {
    throw new TypeError("Canonical Money must not contain negative zero");
  }
  const factor = 10n ** BigInt(exponent);
  let minorUnits = BigInt(major) * factor + BigInt(fractionalDigits || "0");
  if (sign === "-") minorUnits = -minorUnits;
  return Object.freeze({ currency, exponent, minorUnits });
}

export function assertMoney(value, options) {
  parseMoney(value, options);
  return true;
}

export function formatMoney(minorUnits, currency) {
  const exponent = currencyMinorUnits(currency);
  const exact = toBigInt(minorUnits);
  const negative = exact < 0n;
  const absolute = negative ? -exact : exact;
  const factor = 10n ** BigInt(exponent);
  const major = absolute / factor;
  const sign = negative ? "-" : "";
  if (exponent === 0) return `${sign}${major} ${currency}`;
  const fraction = String(absolute % factor).padStart(exponent, "0");
  return `${sign}${major}.${fraction} ${currency}`;
}

function toBigInt(value) {
  if (typeof value === "bigint") return value;
  if (Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError("minorUnits must be a bigint or safe integer");
}

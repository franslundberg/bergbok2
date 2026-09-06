import { formatMoney as formatCanonicalMoney, parseMoney } from "../../../../contracts/src/index.mjs";
import { renderTextPdf } from "./pdf.mjs";

export function renderSie(outputs, { preview }) {
  const bookkeeping = outputs.bookkeeping ?? outputs;
  const transactions = bookkeeping.ledger?.transactions ?? bookkeeping.transactions;
  if (!Array.isArray(transactions)) throw new Error("SIE profile requires canonical bookkeeping transactions");
  const organization = bookkeeping.organization ?? outputs.organization ?? {};
  const lines = [
    "#FLAGGA 0",
    '#PROGRAM "Bergbok" "0.1.0"',
    "#FORMAT UTF-8",
    `#GEN ${compactDate(bookkeeping.generated_date ?? "1970-01-01")}`,
    `#SIETYP 4`,
    `#ORGNR ${quote(organization.organization_number ?? "UNKNOWN")}`,
    `#FNAMN ${quote(organization.name ?? "Unknown company")}`,
  ];
  if (preview) lines.push("#PROSA \"PREVIEW - NOT APPROVED\"");

  const accounts = new Map();
  for (const transaction of transactions) {
    for (const entry of transaction.lines ?? []) {
      accounts.set(String(entry.account), entry.account_name ?? `Account ${entry.account}`);
    }
  }
  for (const [account, name] of [...accounts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`#KONTO ${account} ${quote(name)}`);
  }

  transactions.forEach((transaction, index) => {
    const verification = transaction.verification_id ?? transaction.verification_number ?? index + 1;
    const series = String(transaction.series ?? "A").replace(/[^A-Za-z0-9]/g, "") || "A";
    lines.push(`#VER ${quote(series)} ${numericVerification(verification, index + 1)} ${compactDate(transaction.date)} ${quote(transaction.description ?? "")}`);
    lines.push("{");
    for (const entry of transaction.lines ?? []) {
      const debit = moneyField(entry, "debit", "debit_ore", bookkeeping.ledger?.currency ?? "SEK");
      const credit = moneyField(entry, "credit", "credit_ore", bookkeeping.ledger?.currency ?? "SEK");
      const amountOre = debit - credit;
      lines.push(`#TRANS ${entry.account} {} ${formatSek(amountOre)}`);
    }
    lines.push("}");
  });
  return { filename: "bookkeeping.sie", mediaType: "application/x-sie; charset=utf-8", bytes: Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8") };
}

export function renderVatXml(outputs, { preview }) {
  const bookkeeping = outputs.bookkeeping ?? outputs;
  const vat = bookkeeping.vat_period ?? bookkeeping.vat;
  const organization = bookkeeping.organization ?? outputs.organization ?? {};
  const boxes = vatBoxes(vat);
  if (!/^\d{6}-\d{4}$/.test(organization.organization_number ?? "")) {
    throw new Error("VAT XML profile requires organization_number as xxxxxx-xxxx");
  }
  if (vat.status !== "due" || vat.due_in_period !== true) throw new Error("VAT XML profile requires VAT due in the rendered period");
  const end = vat.cycle_end;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end ?? "")) throw new Error("VAT XML profile requires cycle_end");
  for (const box of ["10", "11", "12", "48", "49"]) wholeSek(boxes[box] ?? 0, `VAT box ${box}`);
  const wholeBoxes = Object.fromEntries(Object.entries(boxes).map(([box, value]) => [box, wholeSek(value, `VAT box ${box}`)]));
  const body = [
    '<?xml version="1.0" encoding="ISO-8859-1"?>',
    ...(preview ? ["<!-- PREVIEW - NOT APPROVED -->"] : []),
    '<eSKDUpload Version="6.0">',
    `  <OrgNr>${organization.organization_number}</OrgNr>`,
    "  <Moms>",
    `    <Period>${end.slice(0, 7).replace("-", "")}</Period>`,
    ...(wholeBoxes["10"] ? [`    <MomsUtgHog>${wholeBoxes["10"]}</MomsUtgHog>`] : []),
    ...(wholeBoxes["11"] ? [`    <MomsUtgMedel>${wholeBoxes["11"]}</MomsUtgMedel>`] : []),
    ...(wholeBoxes["12"] ? [`    <MomsUtgLag>${wholeBoxes["12"]}</MomsUtgLag>`] : []),
    ...(wholeBoxes["48"] ? [`    <MomsIngAvdr>${wholeBoxes["48"]}</MomsIngAvdr>`] : []),
    `    <MomsBetala>${wholeBoxes["49"]}</MomsBetala>`,
    "  </Moms>",
    "</eSKDUpload>",
    "",
  ].join("\n");
  for (const character of body) {
    if (character.codePointAt(0) > 255) throw new Error("VAT XML is not representable as ISO-8859-1");
  }
  return { filename: `moms-${end.slice(0, 7)}.eskd`, mediaType: "application/xml; charset=iso-8859-1", bytes: Buffer.from(body, "latin1") };
}

export function renderVatPdf(outputs, { preview }) {
  const bookkeeping = outputs.bookkeeping ?? outputs;
  const vat = bookkeeping.vat_period ?? bookkeeping.vat;
  const boxes = vatBoxes(vat);
  const organization = bookkeeping.organization ?? outputs.organization ?? {};
  const lines = [
    `${organization.name ?? "Unknown company"} (${organization.organization_number ?? "unknown organization number"})`,
    `Reporting frequency: ${vat.frequency ?? "?"}`,
    `Reporting period: ${vat.cycle_start ?? "?"} - ${vat.cycle_end ?? "?"}`,
    `VAT closing transaction: ${vat.closing_transaction_source_id ?? "?"}`,
    "",
    ...["10", "11", "12", "48", "49"].map((box) => `VAT box ${box}: ${wholeSek(boxes[box] ?? 0, `VAT box ${box}`)} SEK`),
    "",
    "Generated deterministically from canonical Bergbok output data.",
  ];
  return {
    filename: "vat-verification.pdf",
    mediaType: "application/pdf",
    bytes: renderTextPdf({ title: "VAT verification", lines, preview }),
  };
}

export function renderPayslips(outputs, { preview, language = "sv" }) {
  const payroll = outputs.payroll ?? outputs;
  const payslips = payroll.payslips;
  if (!Array.isArray(payslips) || payslips.length === 0) throw new Error("Payslip profile requires canonical payslips");
  const labels = language === "sv"
    ? {
        title: "Lönespecifikation",
        employee: "Anställd",
        period: "Period",
        gross: "Bruttolön",
        tax: "Avdragen skatt",
        net: "Nettolön",
        generated: "Skapad deterministiskt från Bergboks kanoniska utdata.",
        preview: "FÖRHANDSVISNING – EJ GODKÄND",
      }
    : {
        title: "Payslip",
        employee: "Employee",
        period: "Period",
        gross: "Gross pay",
        tax: "Tax withheld",
        net: "Net pay",
        generated: "Generated deterministically from canonical Bergbok output data.",
        preview: "PREVIEW - NOT APPROVED",
      };
  return payslips.map((payslip, index) => ({
    filename: `payslip-${safeFilename(payslip.employee_id ?? index + 1)}.pdf`,
    mediaType: "application/pdf",
    bytes: renderTextPdf({
      title: labels.title,
      preview,
      previewLabel: labels.preview,
      lines: [
        `${labels.employee}: ${payslip.employee_name ?? payslip.employee_id ?? "Unknown"}`,
        `${labels.period}: ${payslip.period_id ?? payroll.period_id ?? "Unknown"}`,
        `${labels.gross}: ${displayMoney(payslip, "gross_pay", ["gross_pay_ore", "gross_ore"])}`,
        `${labels.tax}: ${displayMoney(payslip, "tax_withheld", ["tax_withheld_ore", "tax_ore"])}`,
        `${labels.net}: ${displayMoney(payslip, "net_pay", ["net_pay_ore", "net_ore"])}`,
        "",
        labels.generated,
      ],
    }),
  }));
}

function quote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function compactDate(value) {
  const date = String(value ?? "").replaceAll("-", "");
  if (!/^\d{8}$/.test(date)) throw new Error(`Invalid date: ${value}`);
  return date;
}

function numericVerification(value, fallback) {
  const match = String(value).match(/(\d+)$/);
  return match ? Number(match[1]) : fallback;
}

function formatSek(ore) {
  const sign = ore < 0n ? "-" : "";
  const absolute = ore < 0n ? -ore : ore;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function moneyField(value, canonicalKey, legacyKey, currency = "SEK") {
  if (value?.[canonicalKey] !== undefined && value?.[legacyKey] !== undefined) {
    throw new Error(`Cannot mix ${canonicalKey} and ${legacyKey}`);
  }
  if (value?.[canonicalKey] !== undefined) return parseMoney(value[canonicalKey], { expectedCurrency: currency }).minorUnits;
  const legacy = value?.[legacyKey] ?? 0;
  if (!Number.isSafeInteger(legacy)) throw new Error(`${legacyKey} must be a safe integer`);
  return BigInt(legacy);
}

function vatBoxes(vat) {
  if (!vat || (vat.declaration_boxes === undefined && vat.declaration_boxes_sek === undefined)) {
    throw new Error("VAT profile requires declaration_boxes");
  }
  if (vat.declaration_boxes !== undefined && vat.declaration_boxes_sek !== undefined) {
    throw new Error("VAT payload cannot mix declaration_boxes and declaration_boxes_sek");
  }
  return vat.declaration_boxes ?? vat.declaration_boxes_sek;
}

function wholeSek(value, label) {
  const minor = typeof value === "string"
    ? parseMoney(value, { expectedCurrency: "SEK" }).minorUnits
    : Number.isSafeInteger(value) ? BigInt(value) * 100n : null;
  if (minor === null || minor % 100n !== 0n) throw new Error(`${label} must be whole SEK`);
  return minor / 100n;
}

function displayMoney(value, canonicalKey, legacyKeys) {
  if (value?.[canonicalKey] !== undefined && legacyKeys.some((key) => value?.[key] !== undefined)) {
    throw new Error(`Cannot mix ${canonicalKey} with legacy money fields`);
  }
  if (value?.[canonicalKey] !== undefined) return formatCanonicalMoney(parseMoney(value[canonicalKey], { expectedCurrency: "SEK" }).minorUnits, "SEK");
  for (const key of legacyKeys) {
    if (value?.[key] !== undefined) return formatCanonicalMoney(moneyField(value, "__absent", key), "SEK");
  }
  return "0.00 SEK";
}

function safeFilename(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "_");
}

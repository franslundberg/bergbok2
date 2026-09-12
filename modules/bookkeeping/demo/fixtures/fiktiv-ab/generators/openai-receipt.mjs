// Generates the two OpenAI receipt fixtures for Fiktiv AB.
//
// The originals were captured PDFs whose text is drawn one glyph at a time,
// which made an in-place name change impractical. This script rebuilds them so
// the customer identity is a parameter rather than a byte pattern.
//
//   node openai-receipt.mjs [outputDir]
//
// Default output is ../2026-08, the fixture month the receipts belong to.

import PDFDocument from 'pdfkit';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, 'assets');

// Fiktiv AB, the synthetic company these fixtures belong to. The receipts name
// the company in both Bill to and Ship to; see the fixture README.
const CUSTOMER = {
  name: 'FIKTIV AB',
  street: 'Karl Gerhards väg 27',
  city: 'SE-133 35 Saltsjöbaden',
  country: 'Sweden',
  email: 'filippa.stark@example.com',
  vat: 'SE559999000801',
};

const SELLER = {
  name: 'OpenAI OpCo, LLC',
  street: '1455 3rd Street',
  city: 'San Francisco, California 94158',
  country: 'United States',
  email: 'ar@openai.com',
  vatLabel: 'EU OSS VAT',
  vat: 'EU372041333',
};

const RECEIPTS = [
  {
    file: '260819-1-ai-from-openai.pdf',
    invoiceNumber: 'DEBE821A-0001',
    receiptNumber: '2398-2561-5736',
    datePaid: 'August 19, 2026',
    amount: '$20.00',
    // Matches the captured original, and keeps regeneration byte-stable.
    created: '2026-08-19T07:00:31+02:00',
  },
  {
    file: '260821-1-ai-from-openai.pdf',
    invoiceNumber: 'DEBE821A-0002',
    receiptNumber: '2160-9565-9099',
    datePaid: 'August 21, 2026',
    amount: '$50.00',
    created: '2026-08-21T20:14:15+02:00',
  },
];

const INK = '#0d0d0d';
const MUTED = '#6e6e80';
const RULE = '#e5e5e5';

const LEFT = 30;
const RIGHT = 582;
const BILL_X = 250;
const SHIP_X = 416;
const VALUE_X = 104;

function render(receipt, outPath) {
  // CreationDate must be passed here, not assigned afterwards: pdfkit derives
  // the trailer file id from the info dictionary while constructing, so a late
  // assignment leaves a random id behind and regeneration stops being stable.
  const doc = new PDFDocument({
    size: 'letter',
    margin: 0,
    info: { CreationDate: new Date(receipt.created) },
  });
  doc.pipe(createWriteStream(outPath));

  doc.registerFont('r', join(ASSETS, 'Inter-Regular.ttf'));
  // The originals use Inter SemiBold, which is not in the family shipped here.
  // Medium is the closer of the two available weights; Bold reads too heavy.
  doc.registerFont('m', join(ASSETS, 'Inter-Medium.ttf'));

  // pdfkit places the top of the line box at y; the captured coordinates are
  // glyph tops. This shifts our text up to match the original measurements.
  const put = (text, x, y, { font = 'r', size = 9, color = INK } = {}) => {
    doc.font(font).fontSize(size).fillColor(color);
    doc.text(text, x, y - size * 0.22, { lineBreak: false });
  };
  const rule = (x1, y, x2, color = RULE) => {
    doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(0.7).strokeColor(color).stroke().restore();
  };

  doc.rect(0, 0, 612, 4).fill('#000000');
  doc.image(join(ASSETS, 'openai-logo.png'), 546, 32, { width: 36 });

  put('Receipt', LEFT, 30.6, { font: 'm', size: 22 });

  const meta = [
    ['Invoice number', receipt.invoiceNumber, 69.3],
    ['Receipt number', receipt.receiptNumber, 82.8],
    ['Date paid', receipt.datePaid, 96.3],
    ['OpenAI VAT', SELLER.vat, 109.8],
  ];
  for (const [label, value, y] of meta) {
    put(label, LEFT, y, { font: 'm', size: 9 });
    put(value, VALUE_X, y, { size: 9 });
  }

  put(SELLER.name, LEFT, 138.3, { font: 'm' });
  put(SELLER.street, LEFT, 154.8);
  put(SELLER.city, LEFT, 168.3);
  put(SELLER.country, LEFT, 181.8);
  put(SELLER.email, LEFT, 195.3);
  put(SELLER.vatLabel, LEFT, 212.5);
  put(SELLER.vat, LEFT + 56, 212.5);

  for (const [heading, x] of [['Bill to', BILL_X], ['Ship to', SHIP_X]]) {
    put(heading, x + 0.8, 138.3, { font: 'm' });
    put(CUSTOMER.name, x, 157.4);
    put(CUSTOMER.street, x, 170.5);
    put(CUSTOMER.city, x, 184.3);
    put(CUSTOMER.country, x, 197.6);
  }
  put(CUSTOMER.email, BILL_X, 210.9);
  put('SE VAT', BILL_X, 224.2);
  put(CUSTOMER.vat, BILL_X + 34, 224.2);

  put(`${receipt.amount} paid on ${receipt.datePaid}`, LEFT, 257.7, { font: 'm', size: 17 });
  put('Manual purchase', LEFT, 283.8);

  // Line items.
  put('Description', LEFT, 321.2, { size: 7.5, color: MUTED });
  putRight(doc, put, 'Qty', 404, 321.2);
  putRight(doc, put, 'Unit price', 470, 321.2);
  putRight(doc, put, 'Tax', 520, 321.2);
  putRight(doc, put, 'Amount', RIGHT, 321.2);
  rule(LEFT, 334, RIGHT);

  put('OpenAI API usage credit - Manual purchase', LEFT, 341.5);
  putRight(doc, put, '1', 404, 341.5);
  putRight(doc, put, receipt.amount, 470, 341.5);
  putRight(doc, put, '0%', 513, 341.5);
  put('[1]', 513.2, 339.8, { size: 6 });
  putRight(doc, put, receipt.amount, RIGHT, 341.5);
  rule(306, 363, RIGHT);

  // Amount paid is the last row and carries no rule beneath it.
  const totals = [['Subtotal', 370.8, 'r', true], ['Total', 385.0, 'r', true], ['Amount paid', 399.3, 'm', false]];
  for (const [label, y, font, underline] of totals) {
    put(label, 306, y, { font });
    putRight(doc, put, receipt.amount, RIGHT, y, { font });
    if (underline) rule(306, y + 10.5, RIGHT);
  }

  put('Payment history', LEFT, 434.7, { font: 'm', size: 17 });

  put('Payment method', LEFT, 476.5, { size: 7.5, color: MUTED });
  put('Date', 315.6, 476.5, { size: 7.5, color: MUTED });
  put('Amount paid', 414.9, 476.5, { size: 7.5, color: MUTED });
  putRight(doc, put, 'Receipt number', RIGHT, 476.5, { size: 7.5, color: MUTED });
  rule(LEFT, 489, RIGHT);

  put('Mastercard - 4444', LEFT, 496.8);
  put(receipt.datePaid, 315.0, 496.8);
  put(receipt.amount, 414.8, 496.8);
  const [head, tail] = splitReceiptNumber(receipt.receiptNumber);
  putRight(doc, put, head, RIGHT, 496.8);
  putRight(doc, put, tail, RIGHT, 510.3);
  rule(LEFT, 524, RIGHT);

  put('[1] Tax to be paid on reverse charge basis', LEFT, 559.0, { size: 7.5 });

  rule(LEFT, 727, RIGHT);
  putRight(doc, put, 'Page 1 of 1', RIGHT, 746.7, { size: 7.5, color: MUTED });

  doc.end();
}

// The captured receipts wrap the receipt number after the second group.
function splitReceiptNumber(value) {
  const parts = value.split('-');
  return [`${parts[0]}-${parts[1]}-`, parts[2]];
}

function putRight(doc, put, text, xRight, y, opts = {}) {
  const size = opts.size ?? 9;
  const font = opts.font ?? 'r';
  const width = doc.font(font).fontSize(size).widthOfString(text);
  put(text, xRight - width, y, opts);
}

const outDir = resolve(process.argv[2] ?? join(HERE, '..', '2026-08'));
for (const receipt of RECEIPTS) {
  const outPath = join(outDir, receipt.file);
  render(receipt, outPath);
  console.log(`wrote ${outPath}`);
}

// The mapping from BAS accounts to the boxes of Skatteverket's momsdeklaration,
// as published in Bokföringsboken 2026 by BAS-intressenternas Förening.
//
// Page numbers in the comments are the book's own printed numbers, so they match
// what you see when you open it.  The book carries the same mapping twice, once
// sorted by account on printed pages 743-745 and once sorted by box on 746-748,
// and the two agree; the tests check that this file agrees with both.
//
// Roles decide how a box takes part in the arithmetic:
//
//   output   utgående moms, adds to ruta 49
//   input    ingående moms, ruta 48, subtracts from ruta 49
//   base     a beskattningsunderlag, reported but outside the arithmetic
//   manual   not derivable from accounts at all
//
// The side says which way round a balance counts.  "credit" reports a credit
// balance as a positive number, "debit" reports a debit balance that way.
//
// Some entries name account prefixes rather than accounts.  Matching is
// most-specific-wins: an exact account always beats a prefix.  That is load
// bearing, because ruta 05 claims the whole 31xx range while 3105 belongs to
// ruta 36 and 3106 to ruta 38.

export const BAS_2026 = Object.freeze([
  // A. Momspliktig försäljning eller uttag exkl. moms, printed page 741.
  {
    box: "05",
    role: "base",
    side: "credit",
    label: "Momspliktig försäljning som inte ingår i ruta 06, 07 eller 08",
    prefixes: ["30", "31", "33", "38"],
    // The book's last source for this box is "del av 39xx", a part it does not
    // specify, so the derived figure can be short by whatever sits there.
    partial: "39xx bidrar delvis till ruta 05 och den delen går inte att härleda",
  },
  {
    box: "06",
    role: "manual",
    label: "Momspliktiga uttag",
    // Printed page 742, note A: "Antal konton som kan bli berörda är så
    // omfattande att det inte är meningsfullt att specificera dem."
    reason: "uttagsbeskattning kan beröra för många konton för att specificeras",
  },
  {
    box: "07",
    role: "base",
    side: "credit",
    label: "Beskattningsunderlag vid vinstmarginalbeskattning",
    // 321x is the sale and 421x the matching cost, so summing both on the
    // credit side yields the margin, which is what this box reports.
    prefixes: ["321", "421"],
  },
  {
    box: "08",
    role: "base",
    side: "credit",
    label: "Hyresinkomster vid frivillig beskattning",
    accounts: ["3913"],
  },

  // B. Utgående moms på försäljning eller uttag i ruta 05-08.
  //
  // Not in the book's tables, because the rate digit settles it: 261x is 25 %,
  // 262x is 12 %, 263x is 6 %.  Within each rate, 2614 and 2615 belong to the
  // reverse-charge and import boxes instead, and the vilande account holds VAT
  // on an invoiced advance that moves to the ordinary account on payment, so it
  // is not declared yet.
  {
    box: "10",
    role: "output",
    side: "credit",
    label: "Utgående moms 25 %",
    accounts: ["2610", "2611", "2612", "2613", "2616"],
  },
  {
    box: "11",
    role: "output",
    side: "credit",
    label: "Utgående moms 12 %",
    accounts: ["2620", "2621", "2622", "2623", "2626"],
  },
  {
    box: "12",
    role: "output",
    side: "credit",
    label: "Utgående moms 6 %",
    accounts: ["2630", "2631", "2632", "2633", "2636"],
  },

  // C. Momspliktiga inköp vid omvänd betalningsskyldighet, printed 743-747.
  {
    box: "20",
    role: "base",
    side: "debit",
    label: "Inköp av varor från ett annat EU-land",
    accounts: ["4070", "4075", "4076", "4077", "4510", "4515", "4516", "4517"],
  },
  {
    box: "21",
    role: "base",
    side: "debit",
    label: "Inköp av tjänster från ett annat EU-land enligt huvudregeln",
    accounts: ["4535", "4536", "4537"],
  },
  {
    box: "22",
    role: "base",
    side: "debit",
    label: "Inköp av tjänster från land utanför EU",
    accounts: ["4531", "4532", "4533"],
  },
  {
    box: "23",
    role: "base",
    side: "debit",
    label: "Inköp av varor i Sverige som köparen är betalningsskyldig för",
    accounts: ["4060", "4065", "4066", "4067", "4410", "4415", "4416", "4417"],
  },
  {
    box: "24",
    role: "base",
    side: "debit",
    label: "Övriga inköp av tjänster i Sverige som köparen är betalningsskyldig för",
    accounts: ["4420", "4425", "4426", "4427"],
  },

  // D. Utgående moms på inköpen i ruta 20-24, printed 743 and 747.
  { box: "30", role: "output", side: "credit", label: "Utgående moms 25 %", accounts: ["2614"] },
  { box: "31", role: "output", side: "credit", label: "Utgående moms 12 %", accounts: ["2624"] },
  { box: "32", role: "output", side: "credit", label: "Utgående moms 6 %", accounts: ["2634"] },

  // E. Försäljning m.m. som är undantagen från moms, printed 741 and 743.
  {
    box: "35",
    role: "base",
    side: "credit",
    label: "Försäljning av varor till annat EU-land",
    accounts: ["3108"],
  },
  {
    box: "36",
    role: "base",
    side: "credit",
    label: "Försäljning av varor utanför EU",
    accounts: ["3105"],
  },
  {
    box: "37",
    role: "base",
    side: "debit",
    label: "Mellanmans inköp av varor vid trepartshandel",
    // The book marks 4512 as a proposal rather than an established account.
    accounts: ["4512"],
    proposed: true,
  },
  {
    box: "38",
    role: "base",
    side: "credit",
    label: "Mellanmans försäljning av varor vid trepartshandel",
    accounts: ["3106"],
    // Printed 743: 3106 may also hold sales that are not trepartsförsäljning.
    note: "3106 kan även innehålla annan försäljning än trepartsförsäljning",
  },
  {
    box: "39",
    role: "base",
    side: "credit",
    label: "Försäljning av tjänster till en beskattningsbar person i annat EU-land enligt huvudregeln",
    accounts: ["3308"],
  },
  {
    box: "40",
    role: "base",
    side: "credit",
    label: "Övrig försäljning av tjänster tillhandahållna utanför Sverige",
    accounts: ["3305"],
  },
  {
    box: "41",
    role: "base",
    side: "credit",
    label: "Försäljning när köparen är betalningsskyldig i Sverige",
    accounts: ["3231", "3232", "3233"],
  },
  {
    box: "42",
    role: "manual",
    label: "Övrig försäljning m.m.",
    // Printed page 742, note B: flygbensin, skepp för yrkesmässig sjöfart,
    // försäkringsersättningar, EU-bidrag and more.  Same reason as ruta 06.
    reason: "berör för många konton för att specificeras, se bokens not B",
  },

  // F. Ingående moms.  Printed 743 notes that 2640 with its sub-accounts is
  // reported in ruta 48.  2648 is excluded for the same reason as 2618.
  {
    box: "48",
    role: "input",
    side: "debit",
    label: "Avdragsgill ingående moms",
    accounts: ["2640", "2641", "2642", "2645", "2646", "2647", "2649"],
  },

  // G. Ruta 49 is arithmetic, see computeDeclarationBoxes.

  // H. Import, printed 744-745 and 748.
  {
    box: "50",
    role: "base",
    side: "debit",
    label: "Beskattningsunderlag vid import",
    accounts: ["4080", "4085", "4086", "4087", "4540", "4545", "4546", "4547"],
  },
  { box: "60", role: "output", side: "credit", label: "Utgående moms på import 25 %", accounts: ["2615"] },
  { box: "61", role: "output", side: "credit", label: "Utgående moms på import 12 %", accounts: ["2625"] },
  { box: "62", role: "output", side: "credit", label: "Utgående moms på import 6 %", accounts: ["2635"] },
]);

// Accounts that look like VAT or foreign-trade accounts but deliberately reach
// no box.  Listing them keeps them out of the unmapped report, where they would
// read as gaps in the mapping rather than as decisions.
export const BAS_2026_EXCLUDED = Object.freeze({
  2618: "vilande utgående moms, deklareras när förskottet betalas",
  2628: "vilande utgående moms, deklareras när förskottet betalas",
  2638: "vilande utgående moms, deklareras när förskottet betalas",
  2648: "vilande ingående moms, dras av när fakturan betalas",
  2650: "redovisningskonto för moms, avräkning mot skattekontot",
  2670: "avstämningskonto för OSS, redovisas i en egen deklaration",
});

// Which underlag boxes feed which output-VAT boxes, from the book's table on
// printed page 741, where each ruta names both its base accounts and the
// account its output VAT lands on.
//
// Only the groups with a one-to-one pairing are listed. Rutorna 05 to 08 all
// feed 10, 11 and 12, so a zero in any one of them says nothing about the
// others, and rutorna 35 to 42 are exempt sales that carry no output VAT at
// all. Reverse charge and import are the cases where a missing base is a real
// defect, and they are the cases the model gets wrong.
export const BAS_2026_BOX_PAIRS = Object.freeze([
  {
    label: "omvänd betalningsskyldighet",
    bases: ["20", "21", "22", "23", "24"],
    outputs: ["30", "31", "32"],
  },
  {
    label: "import av varor",
    bases: ["50"],
    outputs: ["60", "61", "62"],
  },
]);

import { canonicalStringify } from "../../../../contracts/src/canonical.mjs";
import { formatMoney, parseMoney } from "../../../../contracts/src/index.mjs";

export function deterministicChecks(candidate) {
  const checks = [];
  if (candidate?.kind === "needs_input") {
    checks.push(check("questions-present", Array.isArray(candidate.questions) && candidate.questions.length > 0, "NeedsInput explains what the user must answer"));
    return { checks, transactions: [] };
  }
  if (candidate?.kind === "out_of_scope") {
    checks.push(check("reasons-present", Array.isArray(candidate.reasons) && candidate.reasons.length > 0, "OutOfScope explains the unsupported boundary"));
    return { checks, transactions: [] };
  }
  const transactions = extractTransactions(candidate);
  const currency = outcomeCurrency(candidate);
  const moneyVersion = outcomeMoneyVersion(candidate);
  checks.push(check("transactions-present", Array.isArray(transactions), "Canonical transactions are present"));
  if (!Array.isArray(transactions)) return { checks, transactions: [] };

  const ids = new Set();
  for (const [index, transaction] of transactions.entries()) {
    const id = String(transaction.verification_id ?? transaction.id ?? `index-${index}`);
    const duplicate = ids.has(id);
    ids.add(id);
    checks.push(check(`transaction-${index}-unique-id`, !duplicate, `${id} has a unique identity`));
    let debit = 0n;
    let credit = 0n;
    let canonicalAmounts = true;
    if (!Array.isArray(transaction.lines) || transaction.lines.length < 2) {
      checks.push(check(`transaction-${index}-lines`, false, `${id} must have at least two lines`));
      continue;
    }
    for (const line of transaction.lines) {
      try {
        debit += lineMinorUnits(line, "debit", "debit_ore", currency, moneyVersion);
        credit += lineMinorUnits(line, "credit", "credit_ore", currency, moneyVersion);
      } catch {
        canonicalAmounts = false;
      }
    }
    checks.push(check(`transaction-${index}-canonical-money`, canonicalAmounts, `${id} uses canonical Money or accepted v1 integer ore`));
    checks.push(check(`transaction-${index}-balanced`, canonicalAmounts && debit === credit, `${id} debit ${formatMoney(debit, currency)}, credit ${formatMoney(credit, currency)}`));
  }
  return { checks, transactions };
}

export function semanticComparison(reference, candidate, gradingProfile = {}) {
  const findings = [];
  if (reference?.kind !== candidate?.kind) {
    findings.push(finding("outcome-kind", "error", `Expected ${reference?.kind ?? "an outcome"}, received ${candidate?.kind ?? "invalid output"}`));
    return { findings, accountComparison: [] };
  }
  if (reference.kind !== "proposal") return { findings, accountComparison: [] };

  const referenceCurrency = outcomeCurrency(reference);
  const candidateCurrency = outcomeCurrency(candidate);
  if (referenceCurrency !== candidateCurrency) {
    findings.push(finding("currency", "error", `Expected ${referenceCurrency}, received ${candidateCurrency}`));
    return { findings, accountComparison: [] };
  }

  const referenceTransactions = extractTransactions(reference) ?? [];
  const candidateTransactions = extractTransactions(candidate) ?? [];
  const referenceMoneyVersion = outcomeMoneyVersion(reference);
  const candidateMoneyVersion = outcomeMoneyVersion(candidate);
  if (!["1.0", "2.0"].includes(referenceMoneyVersion) || !["1.0", "2.0"].includes(candidateMoneyVersion)) {
    findings.push(finding("money-schema", "error", "A payload mixes schema-v1 and schema-v2 monetary fields"));
    return { findings, accountComparison: [] };
  }
  if (!gradingProfile.allow_transaction_count_difference && referenceTransactions.length !== candidateTransactions.length) {
    findings.push(finding(
      "transaction-count",
      "error",
      `Expected ${referenceTransactions.length} transactions, received ${candidateTransactions.length}; an invented or missing transaction is possible`,
    ));
  }

  const canonicalAccount = accountCanonicalizer(gradingProfile.account_equivalence_groups ?? []);
  let expected;
  let actual;
  try {
    expected = accountVector(referenceTransactions, canonicalAccount, referenceCurrency, referenceMoneyVersion);
    actual = accountVector(candidateTransactions, canonicalAccount, referenceCurrency, candidateMoneyVersion);
  } catch (error) {
    findings.push(finding("money-schema", "error", error instanceof Error ? error.message : String(error)));
    return { findings, accountComparison: [] };
  }
  const accounts = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  const internalComparison = accounts.map((account) => ({
    account,
    expected_net: expected.get(account) ?? 0n,
    candidate_net: actual.get(account) ?? 0n,
    difference: (actual.get(account) ?? 0n) - (expected.get(account) ?? 0n),
  }));
  const tolerance = gradingTolerance(gradingProfile, referenceCurrency);
  for (const row of internalComparison) {
    if (absolute(row.difference) > tolerance) {
      findings.push(finding(
        `account-${row.account}`,
        "error",
        `Account group ${row.account} differs by ${formatMoney(row.difference, referenceCurrency)}`,
      ));
    }
  }
  const accountComparison = internalComparison.map((row) => ({
    account: row.account,
    expected_net: formatMoney(row.expected_net, referenceCurrency),
    candidate_net: formatMoney(row.candidate_net, referenceCurrency),
    difference: formatMoney(row.difference, referenceCurrency),
  }));

  for (const path of gradingProfile.exact_paths ?? []) {
    const expectedValue = valueAtPath(reference, path);
    const actualValue = valueAtPath(candidate, path);
    if (canonicalStringify(expectedValue) !== canonicalStringify(actualValue)) {
      findings.push(finding(`exact-${path}`, "error", `${path} differs from the reference`));
    }
  }

  const referenceEvidence = evidenceIds(referenceTransactions);
  const candidateEvidence = evidenceIds(candidateTransactions);
  if (referenceEvidence.size > 0) {
    for (const evidenceId of candidateEvidence) {
      if (!referenceEvidence.has(evidenceId) && !(gradingProfile.allowed_extra_evidence_ids ?? []).includes(evidenceId)) {
        findings.push(finding("invented-evidence", "error", `Candidate uses evidence not in the reference: ${evidenceId}`));
      }
    }
  }
  return { findings, accountComparison };
}

export function extractTransactions(outcome) {
  const outputs = outcome?.canonical_outputs ?? {};
  const candidates = [
    outputs.bookkeeping?.ledger?.transactions,
    outputs.bookkeeping?.transactions,
    outputs.ledger?.transactions,
    outputs.transactions,
    outputs.payroll_accounting_facts?.payload?.transactions,
    outputs.payroll_accounting_facts?.transactions,
  ];
  return candidates.find(Array.isArray) ?? null;
}

function accountVector(transactions, canonicalAccount, currency, moneyVersion) {
  const vector = new Map();
  for (const transaction of transactions) {
    for (const line of transaction.lines ?? []) {
      const account = canonicalAccount(String(line.account));
      const amount = lineMinorUnits(line, "debit", "debit_ore", currency, moneyVersion)
        - lineMinorUnits(line, "credit", "credit_ore", currency, moneyVersion);
      vector.set(account, (vector.get(account) ?? 0n) + amount);
    }
  }
  return vector;
}

function outcomeCurrency(outcome) {
  const outputs = outcome?.canonical_outputs ?? {};
  return outputs.bookkeeping?.ledger?.currency
    ?? outputs.bookkeeping?.currency
    ?? outputs.ledger?.currency
    ?? outputs.currency
    ?? "SEK";
}

function lineMinorUnits(line, canonicalKey, legacyKey, currency, moneyVersion) {
  if (moneyVersion === "2.0") {
    if (line?.[legacyKey] !== undefined) throw new Error(`Schema 2.0 cannot contain ${legacyKey}`);
    if (line?.[canonicalKey] === undefined) throw new Error(`Schema 2.0 requires ${canonicalKey}`);
    return parseMoney(line[canonicalKey], { expectedCurrency: currency }).minorUnits;
  }
  if (moneyVersion !== "1.0") throw new Error("Payload mixes schema-v1 and schema-v2 money fields");
  if (line?.[canonicalKey] !== undefined) throw new Error(`Schema 1.0 cannot contain ${canonicalKey}`);
  const legacy = line?.[legacyKey];
  if (!Number.isSafeInteger(legacy)) throw new Error(`${legacyKey} must be a safe integer`);
  return BigInt(legacy);
}

function outcomeMoneyVersion(outcome) {
  const outputs = outcome?.canonical_outputs ?? {};
  const declared = outputs.bookkeeping?.schema_version
    ?? outputs.ledger?.schema_version
    ?? outputs.schema_version;
  if (declared !== undefined) return declared;
  let canonical = false;
  let legacy = false;
  for (const transaction of extractTransactions(outcome) ?? []) {
    for (const line of transaction.lines ?? []) {
      canonical ||= line.debit !== undefined || line.credit !== undefined;
      legacy ||= line.debit_ore !== undefined || line.credit_ore !== undefined;
    }
  }
  if (canonical && legacy) return "mixed";
  return canonical ? "2.0" : "1.0";
}

function gradingTolerance(profile, currency) {
  if (profile.account_tolerance !== undefined && profile.account_tolerance_ore !== undefined) {
    throw new Error("Grading profile cannot mix account_tolerance and account_tolerance_ore");
  }
  if (profile.account_tolerance !== undefined) {
    const value = parseMoney(profile.account_tolerance, { expectedCurrency: currency }).minorUnits;
    if (value < 0n) throw new Error("account_tolerance must be non-negative");
    return value;
  }
  const legacy = profile.account_tolerance_ore ?? 0;
  if (!Number.isSafeInteger(legacy) || legacy < 0) throw new Error("account_tolerance_ore must be a non-negative safe integer");
  return BigInt(legacy);
}

function absolute(value) {
  return value < 0n ? -value : value;
}

function accountCanonicalizer(groups) {
  const aliases = new Map();
  for (const rawGroup of groups) {
    const group = rawGroup.map(String).sort();
    if (group.length < 2) throw new Error("An account equivalence group must contain at least two accounts");
    for (const account of group) aliases.set(account, group[0]);
  }
  return (account) => aliases.get(account) ?? account;
}

function evidenceIds(transactions) {
  const result = new Set();
  for (const transaction of transactions) {
    for (const id of transaction.evidence_ids ?? transaction.source_ids ?? []) result.add(String(id));
  }
  return result;
}

function valueAtPath(value, path) {
  return String(path).split(".").reduce((current, key) => current?.[key], value);
}

function check(id, passed, detail) {
  return { id, passed: Boolean(passed), detail };
}

function finding(id, severity, detail) {
  return { id, severity, detail };
}

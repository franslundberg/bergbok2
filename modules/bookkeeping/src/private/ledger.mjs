export function issue(code, message, path = null, details = {}) {
  return { code, message, ...(path ? { path } : {}), ...details };
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeAccount(value) {
  const account = typeof value === "number" ? String(value) : value;
  return typeof account === "string" && /^\d{4}$/.test(account) ? account : null;
}

export function validIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function normalizeTransactions(rows, {
  label = "transactions",
  periodStart = null,
  periodEnd = null,
  origin = "bookkeeping_input",
  evidenceFallback = [],
  sourcePrefix = "transaction",
  startingOrder = 0,
} = {}) {
  const issues = [];
  if (!Array.isArray(rows)) {
    return { transactions: [], issues: [issue("TRANSACTIONS_REQUIRED", `${label} must be an array`, label)] };
  }

  const transactions = [];
  const sourceIds = new Set();
  rows.forEach((row, index) => {
    const path = `${label}[${index}]`;
    if (!isPlainObject(row)) {
      issues.push(issue("TRANSACTION_INVALID", `${path} must be an object`, path));
      return;
    }
    const local = [];
    const date = row.date;
    if (!validIsoDate(date)) local.push(issue("TRANSACTION_DATE_INVALID", `${path}.date must be an ISO calendar date`, `${path}.date`));
    if (validIsoDate(date) && periodStart && date < periodStart) {
      local.push(issue("TRANSACTION_OUTSIDE_PERIOD", `${path}.date is before the period`, `${path}.date`));
    }
    if (validIsoDate(date) && periodEnd && date > periodEnd) {
      local.push(issue("TRANSACTION_OUTSIDE_PERIOD", `${path}.date is after the period`, `${path}.date`));
    }
    const description = typeof row.description === "string" ? row.description.trim() : "";
    if (!description) local.push(issue("TRANSACTION_DESCRIPTION_REQUIRED", `${path}.description is required`, `${path}.description`));

    const sourceId = typeof row.source_id === "string" && row.source_id.trim()
      ? row.source_id.trim()
      : `${sourcePrefix}:${index + 1}`;
    if (sourceIds.has(sourceId)) local.push(issue("DUPLICATE_SOURCE_ID", `${path}.source_id is duplicated`, `${path}.source_id`));
    sourceIds.add(sourceId);

    const evidence = row.evidence_document_ids === undefined
      ? [...evidenceFallback]
      : normalizeTextArray(row.evidence_document_ids, `${path}.evidence_document_ids`, local);

    if (!Array.isArray(row.lines) || row.lines.length < 2) {
      local.push(issue("TRANSACTION_LINES_REQUIRED", `${path}.lines must contain at least two lines`, `${path}.lines`));
    }
    const lines = [];
    let debit = 0n;
    let credit = 0n;
    for (const [lineIndex, line] of (Array.isArray(row.lines) ? row.lines : []).entries()) {
      const linePath = `${path}.lines[${lineIndex}]`;
      if (!isPlainObject(line)) {
        local.push(issue("LINE_INVALID", `${linePath} must be an object`, linePath));
        continue;
      }
      const account = normalizeAccount(line.account);
      if (!account) local.push(issue("ACCOUNT_INVALID", `${linePath}.account must be a four-digit BAS account`, `${linePath}.account`));
      const accountName = typeof line.account_name === "string" && line.account_name.trim()
        ? line.account_name.trim()
        : account ? `Account ${account}` : "Unknown account";
      const debitOre = line.debit_ore ?? 0n;
      const creditOre = line.credit_ore ?? 0n;
      if (typeof debitOre !== "bigint" || debitOre < 0n) {
        local.push(issue("MONEY_INVALID", `${linePath}.debit must be canonical non-negative Money`, `${linePath}.debit`));
      }
      if (typeof creditOre !== "bigint" || creditOre < 0n) {
        local.push(issue("MONEY_INVALID", `${linePath}.credit must be canonical non-negative Money`, `${linePath}.credit`));
      }
      if (typeof debitOre === "bigint" && typeof creditOre === "bigint"
          && ((debitOre > 0n) === (creditOre > 0n))) {
        local.push(issue("LINE_SIDE_INVALID", `${linePath} must have exactly one positive debit or credit amount`, linePath));
      }
      if (typeof debitOre === "bigint") debit += debitOre;
      if (typeof creditOre === "bigint") credit += creditOre;
      lines.push({
        account: account ?? String(line.account ?? ""),
        account_name: accountName,
        debit_ore: typeof debitOre === "bigint" && debitOre >= 0n ? debitOre : 0n,
        credit_ore: typeof creditOre === "bigint" && creditOre >= 0n ? creditOre : 0n,
      });
    }
    if (debit !== credit) {
      local.push(issue("TRANSACTION_IMBALANCE", `${path} debits and credits do not balance`, path));
    }
    issues.push(...local);
    transactions.push({
      source_id: sourceId,
      date,
      description,
      lines,
      evidence_document_ids: evidence,
      origin,
      _source_order: startingOrder + index,
    });
  });
  return { transactions, issues };
}

export function normalizeBalances(rows, label = "balances") {
  const issues = [];
  if (rows === undefined || rows === null) return { balances: [], issues };
  if (!Array.isArray(rows)) return { balances: [], issues: [issue("BALANCES_INVALID", `${label} must be an array`, label)] };
  const map = new Map();
  for (const [index, row] of rows.entries()) {
    const path = `${label}[${index}]`;
    if (!isPlainObject(row)) {
      issues.push(issue("BALANCE_INVALID", `${path} must be an object`, path));
      continue;
    }
    const account = normalizeAccount(row.account);
    if (!account) {
      issues.push(issue("ACCOUNT_INVALID", `${path}.account must be a four-digit BAS account`, `${path}.account`));
      continue;
    }
    let net;
    if (row.amount_ore !== undefined) {
      if (typeof row.amount_ore !== "bigint") {
        issues.push(issue("MONEY_INVALID", `${path}.amount must be canonical Money`, `${path}.amount`));
        continue;
      }
      net = row.amount_ore;
    } else {
      const debit = row.debit_ore ?? 0n;
      const credit = row.credit_ore ?? 0n;
      if (typeof debit !== "bigint" || debit < 0n || typeof credit !== "bigint" || credit < 0n) {
        issues.push(issue("MONEY_INVALID", `${path} must contain non-negative canonical debit and credit Money`, path));
        continue;
      }
      if (debit > 0n && credit > 0n) {
        issues.push(issue("BALANCE_SIDE_INVALID", `${path} cannot contain both debit and credit`, path));
        continue;
      }
      net = debit - credit;
    }
    if (map.has(account)) {
      issues.push(issue("DUPLICATE_BALANCE_ACCOUNT", `${label} contains account ${account} more than once`, path));
      continue;
    }
    map.set(account, { account_name: cleanText(row.account_name) ?? `Account ${account}`, net_ore: net });
  }
  const balances = balancesFromMap(map);
  const net = balances.reduce((sum, row) => sum + row.debit_ore - row.credit_ore, 0n);
  if (net !== 0n) issues.push(issue("BALANCES_IMBALANCED", `${label} is not balanced`, label));
  return { balances, issues };
}

export function assignVerificationNumbers(transactions, { series = "A", previousLastNumber = 0 } = {}) {
  const sorted = [...transactions].sort((left, right) =>
    String(left.date).localeCompare(String(right.date))
      || left._source_order - right._source_order
      || left.source_id.localeCompare(right.source_id));
  return sorted.map((transaction, index) => {
    const number = previousLastNumber + index + 1;
    const { _source_order: ignored, ...value } = transaction;
    return { ...value, verification_id: `${series}${number}`, series, verification_number: number };
  });
}

export function movementsFromTransactions(transactions) {
  const map = new Map();
  for (const transaction of transactions) {
    for (const line of transaction.lines) {
      const current = map.get(line.account) ?? { account_name: line.account_name, net_ore: 0n };
      current.account_name = line.account_name;
      current.net_ore += line.debit_ore - line.credit_ore;
      map.set(line.account, current);
    }
  }
  return balancesFromMap(map);
}

export function combineBalances(openingBalances, movements) {
  const map = new Map();
  for (const row of openingBalances) map.set(row.account, { account_name: row.account_name, net_ore: row.debit_ore - row.credit_ore });
  for (const row of movements) {
    const current = map.get(row.account) ?? { account_name: row.account_name, net_ore: 0n };
    current.account_name = row.account_name;
    current.net_ore += row.debit_ore - row.credit_ore;
    map.set(row.account, current);
  }
  return balancesFromMap(map);
}

export function totalsForTransactions(transactions) {
  let debitOre = 0n;
  let creditOre = 0n;
  for (const transaction of transactions) {
    for (const line of transaction.lines) {
      debitOre += line.debit_ore;
      creditOre += line.credit_ore;
    }
  }
  return { debit_ore: debitOre, credit_ore: creditOre };
}

// Declaration boxes are whole SEK on Skatteverket's form while ledger balances
// are öre-precise, so the declared figure is rounded even though the settlement
// booked against the ledger keeps the exact remainder.
export function roundToWholeKrona(ore) {
  const negative = ore < 0n;
  const magnitude = negative ? -ore : ore;
  const whole = (magnitude + 50n) / 100n;
  return negative ? -whole : whole;
}

export function netBalanceForAccount(balances, account) {
  const row = balances.find((item) => item.account === account);
  return row ? row.debit_ore - row.credit_ore : 0n;
}

function balancesFromMap(map) {
  return [...map.entries()]
    .filter(([, value]) => value.net_ore !== 0n)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([account, value]) => ({
      account,
      account_name: value.account_name,
      debit_ore: value.net_ore > 0n ? value.net_ore : 0n,
      credit_ore: value.net_ore < 0n ? -value.net_ore : 0n,
    }));
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTextArray(value, path, issues) {
  if (!Array.isArray(value)) {
    issues.push(issue("TEXT_ARRAY_INVALID", `${path} must be an array of non-empty strings`, path));
    return [];
  }
  const result = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      issues.push(issue("TEXT_ARRAY_INVALID", `${path}[${index}] must be a non-empty string`, `${path}[${index}]`));
    } else {
      result.push(item.trim());
    }
  });
  return result;
}

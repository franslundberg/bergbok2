import { Readable, Transform } from "node:stream";
import { spec } from "node:test/reporters";

const ansiPrefix = "(?:\\u001b\\[[0-9;]*m)*";
const testDurationPattern = new RegExp(
  `^(${ansiPrefix}[✔✖][^\\r\\n]*?\\()(\\d+(?:\\.\\d+)?)(ms\\)[^\\r\\n]*)$`,
  "gm",
);
const summaryDurationPattern = new RegExp(
  `^(${ansiPrefix}ℹ duration_ms )(\\d+(?:\\.\\d+)?)(\\r?)$`,
  "gm",
);

export default async function* roundedSpecReporter(source) {
  const rendered = Readable.from(source).pipe(spec());
  let pending = "";

  for await (const chunk of rendered) {
    pending += typeof chunk === "string" ? chunk : chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    if (lines.length > 0) yield `${lines.map(formatLine).join("\n")}\n`;
  }

  if (pending.length > 0) yield formatLine(pending);
}

export function createDurationFormatter() {
  let pending = "";
  return new Transform({
    decodeStrings: false,
    transform(chunk, encoding, callback) {
      pending += typeof chunk === "string" ? chunk : chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      callback(null, lines.map(formatLine).join("\n") + (lines.length > 0 ? "\n" : ""));
    },
    flush(callback) {
      callback(null, pending.length > 0 ? formatLine(pending) : null);
    },
  });
}

function formatLine(line) {
  return line
    .replace(testDurationPattern, (_match, prefix, duration, suffix) => `${prefix}${Number(duration).toFixed(1)}${suffix}`)
    .replace(summaryDurationPattern, (_match, prefix, duration, suffix) => `${prefix}${Number(duration).toFixed(1)}${suffix}`);
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;

export function renderTextPdf({ title, lines, preview = false, previewLabel = "PREVIEW - NOT APPROVED" }) {
  const printable = [
    ...(preview ? [previewLabel, ""] : []),
    title,
    "",
    ...lines,
  ].flatMap((line) => wrapLine(toLatin1(String(line)), 88));

  const pages = chunk(printable, 49);
  const objects = new Map();
  const pageObjectIds = [];
  const firstPageObjectId = 4;

  objects.set(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"));
  objects.set(3, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "ascii"));

  pages.forEach((pageLines, index) => {
    const pageId = firstPageObjectId + index * 2;
    const streamId = pageId + 1;
    pageObjectIds.push(pageId);
    const commands = [
      "BT",
      "/F1 10 Tf",
      "50 790 Td",
      "14 TL",
      ...pageLines.flatMap((line) => [`(${escapePdfText(line)}) Tj`, "T*"]),
      "ET",
    ].join("\n");
    const streamBytes = Buffer.from(commands, "latin1");
    objects.set(
      pageId,
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,
        "ascii",
      ),
    );
    objects.set(
      streamId,
      Buffer.concat([
        Buffer.from(`<< /Length ${streamBytes.length} >>\nstream\n`, "ascii"),
        streamBytes,
        Buffer.from("\nendstream", "ascii"),
      ]),
    );
  });

  objects.set(
    2,
    Buffer.from(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`, "ascii"),
  );

  const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const bodyParts = [header];
  const offsets = [0];
  let position = header.length;
  const maxObjectId = Math.max(...objects.keys());
  for (let id = 1; id <= maxObjectId; id += 1) {
    const objectBytes = objects.get(id);
    if (!objectBytes) throw new Error(`Missing PDF object ${id}`);
    offsets[id] = position;
    const wrapped = Buffer.concat([
      Buffer.from(`${id} 0 obj\n`, "ascii"),
      objectBytes,
      Buffer.from("\nendobj\n", "ascii"),
    ]);
    bodyParts.push(wrapped);
    position += wrapped.length;
  }
  const xrefPosition = position;
  const xref = [
    `xref\n0 ${maxObjectId + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF\n`,
  ].join("");
  bodyParts.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(bodyParts);
}

function escapePdfText(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function toLatin1(value) {
  return [...value].map((character) => (character.codePointAt(0) <= 255 ? character : "?")).join("");
}

function wrapLine(line, width) {
  if (line.length <= width) return [line];
  const result = [];
  let rest = line;
  while (rest.length > width) {
    let breakAt = rest.lastIndexOf(" ", width);
    if (breakAt < width / 2) breakAt = width;
    result.push(rest.slice(0, breakAt));
    rest = rest.slice(breakAt).trimStart();
  }
  result.push(rest);
  return result;
}

function chunk(values, size) {
  if (values.length === 0) return [[]];
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

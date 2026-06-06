const LINES_PER_PAGE = 44;
const LINE_HEIGHT = 16;
const START_Y = 780;

function escapePdfText(line) {
  return String(line || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function buildPageStream(pageLines) {
  let y = START_Y;
  const contentParts = ['BT', '/F1 11 Tf'];
  for (const line of pageLines) {
    contentParts.push(`50 ${y} Td (${escapePdfText(line)}) Tj`);
    contentParts.push(`0 -${LINE_HEIGHT} Td`);
    y -= LINE_HEIGHT;
  }
  contentParts.push('ET');
  return contentParts.join('\n');
}

/** Minimal multi-page text PDF (no external dependencies). */
export function buildSimpleTextPdf(lines) {
  const safeLines = (lines || []).map((line) => String(line ?? ''));
  const pageChunks = [];
  for (let i = 0; i < safeLines.length; i += LINES_PER_PAGE) {
    pageChunks.push(safeLines.slice(i, i + LINES_PER_PAGE));
  }
  if (!pageChunks.length) pageChunks.push(['']);

  const objects = [];
  objects.push('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj');

  const pageIds = [];
  const contentIds = [];
  let nextId = 3;
  for (let i = 0; i < pageChunks.length; i += 1) {
    pageIds.push(nextId);
    contentIds.push(nextId + 1);
    nextId += 2;
  }
  const fontId = nextId;

  const kids = pageIds.map((id) => `${id} 0 R`).join(' ');
  objects.push(`2 0 obj<< /Type /Pages /Kids [${kids}] /Count ${pageChunks.length} >>endobj`);

  for (let i = 0; i < pageChunks.length; i += 1) {
    const stream = buildPageStream(pageChunks[i]);
    const streamLen = Buffer.byteLength(stream, 'utf8');
    objects.push(
      `${pageIds[i]} 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentIds[i]} 0 R /Resources<< /Font<< /F1 ${fontId} 0 R >> >> >>endobj`,
    );
    objects.push(`${contentIds[i]} 0 obj<< /Length ${streamLen} >>stream\n${stream}\nendstream\nendobj`);
  }

  objects.push(`${fontId} 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${obj}\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

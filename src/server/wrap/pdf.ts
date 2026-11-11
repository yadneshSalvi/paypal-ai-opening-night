import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { DomainError } from "@/domain/contracts";
import type { WrapReport } from "@/domain/wrap/contracts";

const ink = rgb(.09, .13, .16), muted = rgb(.36, .41, .44), paper = rgb(.97, .97, .94), green = rgb(.10, .40, .31), amber = rgb(.72, .39, .07), rule = rgb(.84, .86, .83);
const money = (minor: number | null) => minor === null ? "Unknown / n.a." : `${minor < 0 ? "-" : ""}$${(Math.abs(minor) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
let fonts: Promise<[Buffer, Buffer]> | undefined;
const fontBytes = () => fonts ??= Promise.all([readFile(path.join(process.cwd(), "public/fonts/NotoSans-Regular.ttf")), readFile(path.join(process.cwd(), "public/fonts/NotoSans-Bold.ttf"))]);
export async function renderWrapPdf(report: WrapReport): Promise<{ bytes: Uint8Array; pages: number; escapedCharacters: number }> {
  const doc = await PDFDocument.create(); doc.registerFontkit(fontkit); const bytes = await fontBytes(), normal = await doc.embedFont(bytes[0], { subset: true }), bold = await doc.embedFont(bytes[1], { subset: true }), supported = new Set(normal.getCharacterSet());
  doc.setTitle(report.title); doc.setAuthor("Opening Night · private producer account"); doc.setCreator("Opening Night wrap renderer v1 / pdf-lib 1.17.1"); doc.setSubject(`Immutable report ${report.contentDigest}`); doc.setCreationDate(new Date(report.asOf)); doc.setModificationDate(new Date(report.asOf)); doc.setKeywords(["opening-night", "account", "USD minor units", report.boundary]);
  let page!: PDFPage, y = 0, section = "Production account", escapedCharacters = 0;
  const width = 612, height = 792, left = 44, right = 568, bodyWidth = right - left, bottom = 55;
  function safe(text: string) { return [...text].map(char => { const point = char.codePointAt(0)!; if (char === "\n") return char; if (char === "\t") return "    "; if (!supported.has(point) || /[\p{Cc}\p{Cf}]/u.test(char)) { escapedCharacters++; return `[U+${point.toString(16).toUpperCase()}]`; } return char; }).join(""); }
  function wrapped(text: string, available: number, size: number, font: PDFFont = normal): string[] {
    const result: string[] = [];
    for (const paragraph of safe(text).split("\n")) {
      if (!paragraph) { result.push(""); continue; }
      let line = "";
      for (const word of paragraph.split(/\s+/u)) {
        if (font.widthOfTextAtSize((line ? line + " " : "") + word, size) <= available) { line += (line ? " " : "") + word; continue; }
        if (line) { result.push(line); line = ""; }
        for (const character of word) { if (line && font.widthOfTextAtSize(line + character, size) > available) { result.push(line); line = ""; } line += character; }
      }
      if (line) result.push(line);
    }
    return result;
  }
  function newPage(name = section) {
    if (doc.getPageCount() >= 2000) throw new DomainError("WRAP_PDF_PAGE_LIMIT", "The complete report exceeds the supported 2,000-page edition. Its sources are retained; no truncated export is produced.", 413);
    section = name; page = doc.addPage([width, height]); page.drawRectangle({ x: 0, y: height - 69, width, height: 69, color: ink }); page.drawText("OPENING NIGHT", { x: left, y: height - 28, size: 13, font: bold, color: rgb(.94, .85, .57) });
    page.drawText(safe(name), { x: left, y: height - 49, size: 9, font: normal, color: rgb(.87, .89, .86) });
    const badge = report.boundary === "controlled_fixture" ? "CONTROLLED FIXTURE" : "SANDBOX ACCOUNT"; page.drawText(badge, { x: right - bold.widthOfTextAtSize(badge, 8), y: height - 28, size: 8, font: bold, color: rgb(.94, .85, .57) }); y = height - 93;
  }
  function ensure(needed: number) { if (y - needed < bottom) newPage(); }
  function text(value: string, options: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number; gap?: number } = {}) {
    const size = options.size ?? 9, font = options.bold ? bold : normal, lineHeight = size * 1.48, indent = options.indent ?? 0;
    for (const line of wrapped(value, bodyWidth - indent, size, font)) { ensure(lineHeight); if (line) page.drawText(line, { x: left + indent, y, size, font, color: options.color ?? ink }); y -= lineHeight; } y -= options.gap ?? 5;
  }
  function heading(title: string, fresh = false) { if (fresh) newPage(title); else { ensure(48); y -= 9; text(title, { size: 16, bold: true, gap: 9 }); } }
  function table(headers: string[], rows: string[][], widths: number[], alignRight = new Set<number>()) {
    const size = 8, lineHeight = 11.4, padding = 6;
    const drawHeader = () => { ensure(33); page.drawRectangle({ x: left, y: y - 21, width: bodyWidth, height: 27, color: ink }); let x = left; headers.forEach((value, i) => { page.drawText(safe(value), { x: x + padding, y: y - 10, font: bold, size: 7.3, color: rgb(1, 1, 1) }); x += widths[i]!; }); y -= 29; };
    drawHeader();
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const cells = rows[rowIndex]!.map((value, i) => wrapped(value, widths[i]! - padding * 2, size)), count = Math.max(...cells.map(cell => cell.length)); let offset = 0;
      while (offset < count) {
        if (y - bottom < lineHeight + padding * 2) { newPage(); drawHeader(); }
        const availableLines = Math.max(1, Math.floor((y - bottom - padding * 2) / lineHeight)), take = Math.min(count - offset, availableLines), rowHeight = take * lineHeight + padding * 2;
        if (rowIndex % 2 === 0) page.drawRectangle({ x: left, y: y - rowHeight, width: bodyWidth, height: rowHeight, color: paper });
        let x = left;
        cells.forEach((cell, index) => { cell.slice(offset, offset + take).forEach((line, n) => { if (line) page.drawText(line, { x: alignRight.has(index) ? x + widths[index]! - padding - normal.widthOfTextAtSize(line, size) : x + padding, y: y - padding - size - n * lineHeight, size, font: normal, color: ink }); }); x += widths[index]!; });
        page.drawLine({ start: { x: left, y: y - rowHeight }, end: { x: right, y: y - rowHeight }, thickness: .5, color: rule }); y -= rowHeight; offset += take;
        if (offset < count) { newPage(); drawHeader(); }
      }
    }
    y -= 14;
  }
  newPage();
  text(report.title, { size: 24, bold: true, gap: 10 }); text(`Edition ${report.edition ?? "preview"} · as of ${report.asOf}`, { size: 10, color: muted }); text(`One production · ${report.period.from} through ${report.period.through} · ${report.zone}`, { size: 9, color: muted });
  text(`Report definition: ${report.definition}\nAll monetary data is USD, stored as integer minor units. The account includes ${report.denominator.ledgerLines} ledger lines, ${report.denominator.entries} current producer entries, ${report.denominator.ticketCaptures} ticket captures, ${report.denominator.invoiceDrafts} original invoices and ${report.denominator.payoutItems} payout items.`, { size: 9 });
  if (report.boundary === "controlled_fixture") text("CONTROLLED EVIDENCE: This report qualifies no actual PayPal money movement or physical work.", { bold: true, color: amber });
  const totals = report.totals;
  heading("01  Account at this source revision");
  table(["Measure", "USD", "Meaning"], [
    ["Approved cost", money(totals.approvedCostMinor), "Current approved expense entries, crew liability adjustments and supplier commitments. Fees shown separately."],
    ["Approved revenue", money(totals.approvedRevenueMinor), "Approved revenue entries and captured ticket revenue net of recorded refunds; an invoice is not counted twice."],
    ["Current net movement", money(totals.currentNetMovementMinor), "Current corroborated principal, net of refunds and the known fee subtotal. An incomplete measure where evidence or fees are missing."],
    ["Historical net movement", money(totals.historicalNetMovementMinor), "Retained historical receipts and known historical fees; adverse current reads do not erase them."],
    ["Known processor fees", money(totals.currentFeeMinor), `${totals.unknownFeeCount} ledger lines have incomplete fee evidence. Unknown is not zero.`],
    ["Outstanding obligations", money(totals.outstandingCostMinor), `${money(totals.reservedMinor)} is reserved by unresolved original transfers; reservations are part of the outstanding balance, not an added cost.`],
    ["Reported external cash", `${money(totals.reportedCashInMinor)} in\n${money(totals.reportedCashOutMinor)} out`, "Attributed producer reports, separate from processor observations."],
    ["Authorization holds", money(totals.holdsMinor), `${money(totals.releasedHoldsMinor)} released. Holds are separate from expense and cash.`],
    ["Invoice claims", money(totals.invoiceClaimsMinor), "Outstanding issued claims, not additional earned revenue or settled cash."],
    ["Credit / overpayment review", money(totals.creditMinor), "Approved liability below current paid or reported principal. No automatic clawback is authorized."],
  ], [144, 88, 292], new Set([1]));
  heading("02  Baseline, approved and observed costs", true);
  text("The comparison uses the same complete source manifest as the ledger. Baseline estimates are separate rows; observed principal and reported external cash remain separate series. Fees are a distinct subtotal.");
  const max = Math.max(1, ...report.categories.flatMap(category => [category.baselineMinor, category.approvedMinor, category.currentCashMinor]));
  for (const category of report.categories) {
    ensure(73); text(category.label, { bold: true, size: 10, gap: 1 });
    const values = [{ name: "Baseline", value: category.baselineMinor, color: muted }, { name: "Approved", value: category.approvedMinor, color: amber }, { name: "Observed", value: category.currentCashMinor, color: green }];
    for (const item of values) { page.drawText(item.name, { x: left, y, font: normal, size: 8, color: muted }); page.drawRectangle({ x: left + 70, y: y - 2, width: Math.max(0, item.value) / max * 330, height: 8, color: item.color }); page.drawText(money(item.value), { x: right - normal.widthOfTextAtSize(money(item.value), 8), y, font: normal, size: 8, color: ink }); y -= 15; } y -= 7;
  }
  table(["Category", "Baseline", "Approved", "Observed", "Reported", "Outstanding"], report.categories.map(category => [category.label, money(category.baselineMinor), money(category.approvedMinor), money(category.currentCashMinor), money(category.reportedCashMinor), money(category.outstandingMinor)]), [118, 77, 77, 77, 77, 98], new Set([1, 2, 3, 4, 5]));
  if (report.rescueComparison) { heading("Selected recovery comparison"); const rescue = report.rescueComparison; text(`${money(rescue.rentalMinor)} rental + ${money(rescue.projectedOvertimeMinor)} projected incremental overtime + ${money(rescue.remedyMinor)} VIP remedies = ${money(rescue.totalMinor)}.\n${rescue.meaning}`, { size: 10 }); }
  heading("03  Complete ledger", true);
  if (!report.lines.length) text("No approved entries or corroborated processor receipts are retained for this production yet. Empty does not assert a zero-cost show.");
  for (const line of report.lines) {
    ensure(82); text(line.label, { size: 12, bold: true, gap: 2 }); text(`${line.id} · ${line.direction} / ${line.category} · ${line.status}\n${line.source}${line.serviceDay ? ` · service ${line.serviceDay}` : ""}`, { size: 8, color: muted, gap: 3 });
    table(["Baseline", "Approved", "Historical", "Current", "Reported", "Outstanding"], [[money(line.baselineMinor), money(line.approvedMinor), money(line.historicalCashMinor), money(line.currentCashMinor), money(line.reportedCashMinor), money(line.outstandingMinor)]], [84, 88, 88, 88, 88, 88], new Set([0, 1, 2, 3, 4, 5]));
    text(`Fees: ${money(line.currentFeeMinor)} current / ${money(line.historicalFeeMinor)} historical (${line.feesComplete ? "complete for this scope" : "incomplete evidence"}); reserved ${money(line.reservedMinor)}; observed returns ${money(line.returnedMinor)}; credit review ${money(line.creditMinor)}; invoice claim ${money(line.claimMinor)}; held ${money(line.holdMinor)}; released ${money(line.releasedHoldMinor)}.`, { size: 8 });
    for (const issue of line.issues) text(`Review: ${issue}`, { size: 8, color: amber });
  }
  heading("04  Reconciliation and definitions", true);
  text(`${totals.unresolvedCount} ledger lines have reconciliation issues. ${totals.unknownFeeCount} have incomplete fee evidence.`, { bold: true });
  for (const item of report.unresolved) text(`${item.lineId}\n${item.reason}`, { size: 9 });
  for (let i = 0; i < report.limitations.length; i++) text(`${i + 1}. ${report.limitations[i]}`, { size: 9 });
  text(`Ticket gross receipts ${money(totals.ticketGrossCollectedMinor)}; historical ticket refunds ${money(totals.ticketRefundedMinor)}. Invoice gross collection ${money(totals.invoiceGrossCollectedMinor)}; historical invoice refunds ${money(totals.invoiceRefundedMinor)}. Refunds reduce the corresponding income line; they are not added again as an operating expense.`, { size: 9 });
  text("Unsupported font glyphs are printed as explicit Unicode code points. The machine-readable JSON retains the exact original text. Every row and evidence reference is included; no clipped browser capture is used.", { size: 8, color: muted });
  heading("05  Immutable source manifest", true);
  text(`Report ID: ${report.id}\nContent SHA-256: ${report.contentDigest}\nTenant scope: ${report.tenantId}\nDefinition: ${report.definition}\nAs of: ${report.asOf}\nProduction lifetime period: ${report.period.from} through ${report.period.through}\nTimezone: ${report.zone}\nCurrency: USD / integer minor units`, { size: 9 });
  for (const [label, revision, hash] of [["Production", report.manifest.productionRevision, report.manifest.productionDigest], ["Settlement", report.manifest.settlementRevision, report.manifest.settlementDigest], ["Payouts", report.manifest.payoutRevision, report.manifest.payoutDigest], ["Wrap account", report.manifest.wrapRevision, report.manifest.wrapDigest]] as const) text(`${label} revision ${revision}\n${hash}`, { size: 9 });
  text(`Plan version ${report.manifest.planVersion}. Scope denominator: ${JSON.stringify(report.denominator)}`, { size: 9 });
  for (const source of report.manifest.sourceRefs) text(`${source.title}\nSource ${source.id} · ${source.provenance}\nSHA-256 ${source.digest}`, { size: 8 });
  heading("06  Full instruction and receipt register", true);
  text("This deliberate evidence appendix retains complete local instruction IDs, original provider IDs, parent identities, receipt hashes and attribution. It is private to the current producer capability.");
  for (const line of report.lines) {
    ensure(46); text(`${line.label} · ${line.id}`, { size: 11, bold: true });
    if (!line.evidence.length) text("No observed instruction or receipt is retained for this line.", { size: 8, color: muted });
    for (const evidence of line.evidence) {
      ensure(68); text(`${evidence.kind} · ${evidence.source}`, { size: 9, bold: true, gap: 2 });
      text(`Receipt: ${evidence.id}\nProvider: ${evidence.providerId ?? "Not a provider receipt"}\nParent: ${evidence.parentId ?? "None"}\nActor: ${evidence.actorId ?? "System observation"}\nRecorded: ${evidence.recordedAt}\nSHA-256: ${evidence.digest}`, { size: 8, gap: 3 }); text(evidence.note, { size: 8, color: muted, gap: 11 });
    }
  }
  const pages = doc.getPages(); for (let i = 0; i < pages.length; i++) { const p = pages[i]!; p.drawLine({ start: { x: left, y: 41 }, end: { x: right, y: 41 }, thickness: .5, color: rule }); p.drawText(`Opening Night · private edition ${report.edition ?? "preview"} · ${report.contentDigest.slice(0, 16)}`, { x: left, y: 27, font: normal, size: 7, color: muted }); const count = `${i + 1} / ${pages.length}`; p.drawText(count, { x: right - normal.widthOfTextAtSize(count, 8), y: 27, font: normal, size: 8, color: muted }); }
  return { bytes: await doc.save({ useObjectStreams: false }), pages: pages.length, escapedCharacters };
}

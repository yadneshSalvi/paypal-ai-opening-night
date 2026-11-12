/** Presentation only. Raw prompts, provider responses, citations and request identities stay unchanged. */
export const escapeMessageText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("\0", "\\u0000");
const plain = (text: string) => escapeMessageText(text).replaceAll("\n", "<br>");
function safeLink(value: string) {
  if (value.length > 2000 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function inline(text: string, depth = 0): string {
  if (depth > 4 || text.length > 8000) return plain(text);
  let result = "", literal = "", index = 0;
  const flush = () => { if (literal) { result += plain(literal); literal = ""; } };
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\" && /[\\`*_[\]{}()#+.!|~-]/.test(text[index + 1] ?? "")) { literal += text[index + 1]; index += 2; continue; }
    if (char === "`") {
      let count = 1; while (text[index + count] === "`") count++;
      const marker = "`".repeat(count), end = text.indexOf(marker, index + count);
      if (end >= index + count) { flush(); result += "<code>" + escapeMessageText(text.slice(index + count, end)) + "</code>"; index = end + count; continue; }
    }
    const image = char === "!" && text[index + 1] === "[", start = image ? index + 1 : index;
    if (text[start] === "[") {
      const middle = text.indexOf("](", start + 1), end = middle >= 0 ? text.indexOf(")", middle + 2) : -1;
      if (middle >= 0 && end >= 0 && !text.slice(start, end).includes("\n")) {
        const original = text.slice(index, end + 1), label = text.slice(start + 1, middle), href = image ? null : safeLink(text.slice(middle + 2, end));
        flush(); result += href ? '<a href="' + escapeMessageText(href) + '" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">' + inline(label, depth + 1) + "</a>" : plain(original); index = end + 1; continue;
      }
    }
    const marker = text.startsWith("**", index) ? "**" : text.startsWith("__", index) ? "__" : char === "*" ? "*" : char === "_" && !/[\p{L}\p{N}]/u.test(text[index - 1] ?? "") ? "_" : null;
    if (marker) { const end = text.indexOf(marker, index + marker.length); if (end > index + marker.length) { flush(); const tag = marker.length === 2 ? "strong" : "em"; result += "<" + tag + ">" + inline(text.slice(index + marker.length, end), depth + 1) + "</" + tag + ">"; index = end + marker.length; continue; } }
    literal += char; index++;
  }
  flush(); return result;
}
function cells(line: string) {
  let value = line.trim(); if (value.startsWith("|")) value = value.slice(1); if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  const result: string[] = []; let cell = "", code = false;
  for (let index = 0; index < value.length; index++) { const char = value[index]!; if (char === "\\" && value[index + 1] === "|") { cell += "|"; index++; } else if (char === "`") { code = !code; cell += char; } else if (char === "|" && !code) { result.push(cell.trim()); cell = ""; } else cell += char; }
  result.push(cell.trim()); return result;
}
const separator = (line: string) => { const values = cells(line); return values.length > 1 && values.every(value => /^:?-{3,}:?$/.test(value)); };
const list = (line: string) => /^ {0,3}(?:([-+*]) |(\d{1,4})[.)] )(.*)$/.exec(line);
const fence = (line: string) => /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line);
function startsBlock(lines: string[], index: number) { const line = lines[index] ?? ""; return !line.trim() || /^ {0,3}#{1,6} /.test(line) || Boolean(list(line) || fence(line)) || index + 1 < lines.length && line.includes("|") && separator(lines[index + 1]!); }

/** Small bounded Markdown subset, with untrusted HTML, images and unsafe URLs rendered as text. */
export function safePlanningMessageHtml(input: string) {
  if (typeof input !== "string") return '<div class="opening-safe-message"></div>';
  if (input.length > 200000) return '<div class="opening-safe-message"><pre class="opening-message-plain">' + escapeMessageText(input) + "</pre></div>";
  const lines = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n"), output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index++; continue; }
    const code = fence(line);
    if (code) {
      const marker = code[1]!, body: string[] = []; index++;
      while (index < lines.length && !new RegExp("^ {0,3}" + (marker[0] === "`" ? "`" : "~") + "{" + marker.length + ",}\\s*$").test(lines[index]!)) body.push(lines[index++]!);
      if (index < lines.length) index++; output.push("<pre><code>" + escapeMessageText(body.join("\n")) + "</code></pre>"); continue;
    }
    if (line.includes("|") && index + 1 < lines.length && separator(lines[index + 1]!)) {
      const header = cells(line), rows: string[][] = [], raw = [line, lines[index + 1]!]; index += 2;
      while (index < lines.length && lines[index]!.trim() && lines[index]!.includes("|")) { raw.push(lines[index]!); rows.push(cells(lines[index++]!)); }
      if (header.length > 20 || rows.length > 200 || rows.some(row => row.length !== header.length)) { output.push('<pre class="opening-message-plain">' + escapeMessageText(raw.join("\n")) + "</pre>"); continue; }
      output.push('<div class="opening-message-table" role="region" aria-label="Planning response table" tabindex="0"><table><thead><tr>' + header.map(value => '<th scope="col">' + inline(value) + "</th>").join("") + "</tr></thead><tbody>" + rows.map(row => "<tr>" + row.map(value => "<td>" + inline(value) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>"); continue;
    }
    const heading = /^ {0,3}(#{1,6}) (.*)$/.exec(line);
    if (heading) { const tag = "h" + Math.min(6, heading[1]!.length + 2); output.push("<" + tag + ">" + inline(heading[2]!) + "</" + tag + ">"); index++; continue; }
    const item = list(line);
    if (item) {
      const ordered = Boolean(item[2]), items: string[] = [], start = item[2] ? Number(item[2]) : null;
      while (index < lines.length) { const next = list(lines[index]!); if (!next || Boolean(next[2]) !== ordered) break; items.push("<li>" + inline(next[3]!) + "</li>"); index++; }
      output.push(ordered ? '<ol start="' + start + '">' + items.join("") + "</ol>" : "<ul>" + items.join("") + "</ul>"); continue;
    }
    const paragraph = [line]; index++; while (index < lines.length && !startsBlock(lines, index)) paragraph.push(lines[index++]!);
    output.push("<p>" + inline(paragraph.join("\n")) + "</p>");
  }
  return '<div class="opening-safe-message">' + output.join("") + "</div>";
}

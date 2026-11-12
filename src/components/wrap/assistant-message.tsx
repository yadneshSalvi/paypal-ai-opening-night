import React, { Fragment, type ReactNode } from "react";
import type { WrapAssistantView } from "../../domain/wrap/assistant";

type Block = { kind: "paragraph"; text: string } | { kind: "heading"; text: string } | { kind: "list"; ordered: boolean; items: { text: string; number?: number }[] };

function blocks(text: string): Block[] {
  const result: Block[] = [];
  let paragraph: string[] = [];
  let list: Extract<Block, { kind: "list" }> | null = null;
  const flush = () => {
    if (paragraph.length) result.push({ kind: "paragraph", text: paragraph.join("\n") });
    if (list) result.push(list);
    paragraph = []; list = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) { flush(); continue; }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) { flush(); result.push({ kind: "heading", text: heading[1] }); continue; }
    const item = /^\s{0,3}(?:([-*])|([0-9]{1,4})[.)])\s+(.+)$/.exec(line);
    if (item) {
      const ordered = Boolean(item[2]);
      if (paragraph.length || (list && list.ordered !== ordered)) flush();
      list ??= { kind: "list", ordered, items: [] };
      list.items.push({ text: item[3], ...(ordered ? { number: Number(item[2]) } : {}) });
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1].text += "\n" + line.trimStart();
    } else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  return result;
}

/** Model text stays text: no HTML, images, URLs or provider-supplied actions are interpreted. */
export function AssistantMessage({ text, bindings, onSources }: {
  text: string;
  bindings: WrapAssistantView["bindings"];
  onSources: (lineIds: string[]) => void;
}) {
  const references = new Map(bindings.map(binding => [binding.ref, binding.lineIds]));
  const inline = (value: string): ReactNode[] => {
    const result: ReactNode[] = [];
    const tokens = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[(L[0-9]{1,3})\]/g;
    let cursor = 0;
    for (const match of value.matchAll(tokens)) {
      result.push(value.slice(cursor, match.index));
      const key = match.index;
      if (match[1]) result.push(<strong key={key}>{match[1]}</strong>);
      else if (match[2]) result.push(<code key={key}>{match[2]}</code>);
      else {
        const lines = references.get(match[3]);
        result.push(lines?.length && value[match.index + match[0].length] !== "("
          ? <button key={key} type="button" className="wrap-inline-source" aria-label={`Inspect account source ${match[3]}`} onClick={() => onSources([...lines])}>{match[3]}</button>
          : <Fragment key={key}>{match[0]}</Fragment>);
      }
      cursor = match.index + match[0].length;
    }
    result.push(value.slice(cursor));
    return result;
  };
  return <div className="wrap-assistant-message">{blocks(text).map((block, index) => {
    if (block.kind === "heading") return <h4 key={index}>{inline(block.text)}</h4>;
    if (block.kind === "paragraph") return <p key={index}>{inline(block.text)}</p>;
    const items = block.items.map((item, position) => <li key={position} value={block.ordered ? item.number : undefined}>{inline(item.text)}</li>);
    return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
  })}</div>;
}

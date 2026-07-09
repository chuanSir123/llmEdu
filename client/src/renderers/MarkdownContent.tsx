import { Fragment, ReactNode } from "react";

type MarkdownContentProps = {
  content: string;
  className?: string;
  inverse?: boolean;
};

function normalizeMarkdown(content: string) {
  return (content || "")
    .replace(/\\n/g, "\n")
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, "$1");
}

function inlineMarkdown(text: string, inverse = false): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${match.index}-${token}`;
    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className={`rounded px-1 py-0.5 text-[0.92em] ${inverse ? "bg-white/20 text-white" : "bg-[#eef2f7] text-[#1f2a3a]"}`}>
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{inlineMarkdown(token.slice(2, -2), inverse)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{inlineMarkdown(token.slice(1, -1), inverse)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) {
        nodes.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer" className={`underline underline-offset-2 ${inverse ? "text-white" : "text-[#2f80ed]"}`}>
            {link[1]}
          </a>
        );
      } else {
        nodes.push(token);
      }
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function parseTable(lines: string[], start: number, inverse: boolean): { node: ReactNode; next: number } | null {
  if (start + 1 >= lines.length || !lines[start].includes("|") || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[start + 1])) return null;
  const split = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const headers = split(lines[start]);
  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    rows.push(split(lines[index]));
    index += 1;
  }
  return {
    next: index,
    node: (
      <div key={`table-${start}`} className="my-2 max-w-full overflow-auto">
        <table className={`min-w-full border-collapse text-left text-xs ${inverse ? "border-white/30" : "border-[#dbe3ee]"}`}>
          <thead>
            <tr>{headers.map((cell, idx) => <th key={idx} className={`border px-2 py-1 font-semibold ${inverse ? "border-white/30" : "border-[#dbe3ee] bg-[#f6f8fb]"}`}>{inlineMarkdown(cell, inverse)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx}>{headers.map((_, cellIdx) => <td key={cellIdx} className={`border px-2 py-1 align-top ${inverse ? "border-white/30" : "border-[#dbe3ee]"}`}>{inlineMarkdown(row[cellIdx] ?? "", inverse)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
  };
}

export function MarkdownContent({ content, className = "", inverse = false }: MarkdownContentProps) {
  const lines = normalizeMarkdown(content).split(/\r?\n/);
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      if (i < lines.length) i += 1;
      nodes.push(
        <pre key={`code-${i}`} className={`my-2 max-w-full overflow-auto rounded-md p-3 text-xs leading-5 ${inverse ? "bg-white/15 text-white" : "bg-[#1f2937] text-[#f8fafc]"}`}>
          {language && <div className="mb-2 text-[10px] uppercase opacity-70">{language}</div>}
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }
    const table = parseTable(lines, i, inverse);
    if (table) {
      nodes.push(table.node);
      i = table.next;
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const className = "mb-1 mt-3 font-semibold first:mt-0";
      const content = inlineMarkdown(heading[2], inverse);
      if (heading[1].length === 1) nodes.push(<h3 key={`h-${i}`} className={className}>{content}</h3>);
      else if (heading[1].length === 2) nodes.push(<h4 key={`h-${i}`} className={className}>{content}</h4>);
      else if (heading[1].length === 3) nodes.push(<h5 key={`h-${i}`} className={className}>{content}</h5>);
      else nodes.push(<h6 key={`h-${i}`} className={className}>{content}</h6>);
      i += 1;
      continue;
    }
    const listMatch = /^(\s*)([-*]|\d+\.)\s+(.+)$/.exec(line);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const item = /^(\s*)([-*]|\d+\.)\s+(.+)$/.exec(lines[i]);
        if (!item) break;
        items.push(item[3]);
        i += 1;
      }
      const ListTag = ordered ? "ol" : "ul";
      nodes.push(<ListTag key={`list-${i}`} className={`my-2 space-y-1 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>{items.map((item, idx) => <li key={idx}>{inlineMarkdown(item, inverse)}</li>)}</ListTag>);
      continue;
    }
    if (/^>\s+/.test(line)) {
      const quotes: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quotes.push(lines[i++].replace(/^>\s?/, ""));
      nodes.push(<blockquote key={`quote-${i}`} className={`my-2 border-l-4 pl-3 ${inverse ? "border-white/50 text-white/90" : "border-[#b7c7dc] text-[#526075]"}`}>{quotes.map((quote, idx) => <Fragment key={idx}>{inlineMarkdown(quote, inverse)}{idx < quotes.length - 1 && <br />}</Fragment>)}</blockquote>);
      continue;
    }
    const paragraph: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s+/.test(lines[i]) && !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i]) && !lines[i].startsWith("```") && !/^>\s?/.test(lines[i])) paragraph.push(lines[i++]);
    nodes.push(<p key={`p-${i}`} className="my-2 first:mt-0 last:mb-0">{inlineMarkdown(paragraph.join("\n"), inverse)}</p>);
  }
  return <div className={`break-words ${className}`}>{nodes.length ? nodes : null}</div>;
}

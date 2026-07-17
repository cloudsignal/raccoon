import type { ReactNode } from 'react';

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE);
  return parts.filter((p) => p !== '').map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={key} className="rounded bg-surface-dim px-[5px] py-px font-mono text-[12px]">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link && /^https?:/.test(link[2])) {
      return (
        <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener" className="text-primary underline">
          {link[1]}
        </a>
      );
    }
    // If it looks like a link but has unsafe protocol, render the link text only (discard the URL)
    if (link) {
      return <span key={key}>{link[1]}</span>;
    }
    // React auto-escapes text content
    return part;
  });
}

/**
 * Flatten markdown to a single line of plain text for one-line previews (the
 * channel-list last-message subtitle). Strips emphasis/code markers, keeps
 * link text and drops the URL, removes bullet markers, and collapses all
 * whitespace (including newlines) to single spaces.
 */
export function toPlainText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [label](url) -> label
    .replace(/`([^`]+)`/g, '$1')             // `code` -> code
    .replace(/\*\*([^*]+)\*\*/g, '$1')       // **bold** -> bold
    .replace(/\*([^*]+)\*/g, '$1')           // *italic* -> italic
    .replace(/^\s*[-*]\s+/gm, '')            // bullet markers
    .replace(/\s+/g, ' ')                    // collapse whitespace + newlines
    .trim();
}

export function renderMarkdown(text: string): ReactNode {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let list: string[] = [];

  const flushList = (key: string): void => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={key} className="mt-1 flex list-disc flex-col gap-0.5 pl-[18px]">
        {list.map((item, i) => <li key={i}>{renderInline(item, `${key}-${i}`)}</li>)}
      </ul>,
    );
    list = [];
  };

  lines.forEach((line, i) => {
    if (line.startsWith('- ')) {
      list.push(line.slice(2));
      return;
    }
    flushList(`ul-${i}`);
    if (line.trim() === '') return;
    blocks.push(<span key={`p-${i}`}>{i > 0 && blocks.length > 0 ? <br /> : null}{renderInline(line, `l-${i}`)}</span>);
  });
  flushList('ul-end');
  return blocks;
}

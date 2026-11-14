import React, { useMemo } from 'react';

interface MarkdownMessageProps {
  content: string;
}

/** Parses inline markdown like **bold**, *italic*, and `code` */
function renderInlineMarkdown(text: string): React.ReactNode {
  // Regex to split by **bold**, *italic*, and `code`
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(<strong key={match.index}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push(<em key={match.index}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(<code key={match.index} className="ai-inline-code">{token.slice(1, -1)}</code>);
    } else if (token.startsWith('[') && token.includes('](') && token.endsWith(')')) {
      const labelMatch = token.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (labelMatch) {
        parts.push(
          <a
            key={match.index}
            href={labelMatch[2]}
            target="_blank"
            rel="noreferrer"
            className="ai-link"
          >
            {labelMatch[1]}
          </a>,
        );
      } else {
        parts.push(token);
      }
    } else {
      parts.push(token);
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}

/** Determines if a line is a markdown table row (e.g. | col1 | col2 |) */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2;
}

/** Determines if a line is a markdown table separator (e.g. |---|:---:|---|) */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|[\s\-:|]+\|$/.test(trimmed);
}

/** Parses markdown table blocks into structured HTML table elements */
function parseTableBlock(lines: string[], keyPrefix: string): React.ReactNode {
  if (lines.length < 2) return null;
  const headerLine = lines[0];
  const separatorLine = lines[1];
  if (!isTableSeparator(separatorLine)) return null;

  const headerCells = headerLine
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());

  const dataRows = lines.slice(2).filter((l) => isTableRow(l));

  return (
    <div key={keyPrefix} className="ai-table-container">
      <table className="ai-markdown-table">
        <thead>
          <tr>
            {headerCells.map((cell, idx) => (
              <th key={idx}>{renderInlineMarkdown(cell)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataRows.map((rowLine, rowIdx) => {
            const cells = rowLine
              .split('|')
              .slice(1, -1)
              .map((c) => c.trim());
            return (
              <tr key={rowIdx}>
                {cells.map((cell, cIdx) => (
                  <td key={cIdx}>{renderInlineMarkdown(cell)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Renders a complete AI assistant or user message with rich Markdown formatting */
export function MarkdownMessage({ content }: MarkdownMessageProps) {
  const elements = useMemo(() => {
    if (!content) return null;

    const rawLines = content.split('\n');
    const nodes: React.ReactNode[] = [];
    let i = 0;

    while (i < rawLines.length) {
      const line = rawLines[i];
      const trimmed = line.trim();

      // 1. Markdown Table detection
      if (isTableRow(trimmed) && i + 1 < rawLines.length && isTableSeparator(rawLines[i + 1])) {
        const tableLines: string[] = [trimmed];
        i++;
        while (i < rawLines.length && isTableRow(rawLines[i].trim())) {
          tableLines.push(rawLines[i].trim());
          i++;
        }
        nodes.push(parseTableBlock(tableLines, `table-${i}`));
        continue;
      }

      // 2. Code blocks (```)
      if (trimmed.startsWith('```')) {
        const codeLines: string[] = [];
        i++;
        while (i < rawLines.length && !rawLines[i].trim().startsWith('```')) {
          codeLines.push(rawLines[i]);
          i++;
        }
        i++; // skip closing ```
        nodes.push(
          <pre key={`code-${i}`} className="ai-code-block">
            <code>{codeLines.join('\n')}</code>
          </pre>,
        );
        continue;
      }

      // 3. Headings (#, ##, ###)
      if (trimmed.startsWith('### ')) {
        nodes.push(
          <h4 key={`h3-${i}`} className="ai-msg-h3">
            {renderInlineMarkdown(trimmed.slice(4))}
          </h4>,
        );
        i++;
        continue;
      }
      if (trimmed.startsWith('## ')) {
        nodes.push(
          <h3 key={`h2-${i}`} className="ai-msg-h2">
            {renderInlineMarkdown(trimmed.slice(3))}
          </h3>,
        );
        i++;
        continue;
      }
      if (trimmed.startsWith('# ')) {
        nodes.push(
          <h2 key={`h1-${i}`} className="ai-msg-h1">
            {renderInlineMarkdown(trimmed.slice(2))}
          </h2>,
        );
        i++;
        continue;
      }

      // 4. Blockquotes (> )
      if (trimmed.startsWith('> ')) {
        nodes.push(
          <blockquote key={`quote-${i}`} className="ai-blockquote">
            {renderInlineMarkdown(trimmed.slice(2))}
          </blockquote>,
        );
        i++;
        continue;
      }

      // 5. Bullet Lists (- or *)
      if (/^[-*]\s+/.test(trimmed)) {
        const listItems: string[] = [trimmed.replace(/^[-*]\s+/, '')];
        i++;
        while (i < rawLines.length && /^[-*]\s+/.test(rawLines[i].trim())) {
          listItems.push(rawLines[i].trim().replace(/^[-*]\s+/, ''));
          i++;
        }
        nodes.push(
          <ul key={`ul-${i}`} className="ai-msg-list">
            {listItems.map((item, idx) => (
              <li key={idx}>{renderInlineMarkdown(item)}</li>
            ))}
          </ul>,
        );
        continue;
      }

      // 6. Numbered Lists (1. 2. etc.)
      if (/^\d+\.\s+/.test(trimmed)) {
        const listItems: string[] = [trimmed.replace(/^\d+\.\s+/, '')];
        i++;
        while (i < rawLines.length && /^\d+\.\s+/.test(rawLines[i].trim())) {
          listItems.push(rawLines[i].trim().replace(/^\d+\.\s+/, ''));
          i++;
        }
        nodes.push(
          <ol key={`ol-${i}`} className="ai-msg-numbered-list">
            {listItems.map((item, idx) => (
              <li key={idx}>{renderInlineMarkdown(item)}</li>
            ))}
          </ol>,
        );
        continue;
      }

      // 7. Empty line spacer
      if (!trimmed) {
        nodes.push(<div key={`space-${i}`} className="ai-msg-gap" />);
        i++;
        continue;
      }

      // 8. Normal paragraph text
      nodes.push(
        <p key={`p-${i}`} className="ai-msg-p">
          {renderInlineMarkdown(line)}
        </p>,
      );
      i++;
    }

    return nodes;
  }, [content]);

  return <div className="ai-markdown-content">{elements}</div>;
}

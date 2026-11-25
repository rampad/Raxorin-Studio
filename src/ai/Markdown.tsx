// Markdown sencillo para las respuestas: títulos, listas, código, negrita, cursiva y enlaces.
import { Fragment, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Codicon } from "../components/Icon";
import { t } from "../i18n/index.ts";

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${m.index}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(m[2].slice(2, -2), key + 1)}</strong>);
    else if (m[3]) out.push(<em key={k}>{m[3].slice(1, -1)}</em>);
    else if (m[4]) {
      const label = m[4].slice(1, m[4].indexOf("]"));
      const url = m[5];
      out.push(<a key={k} href={url} onClick={(e) => { e.preventDefault(); void openUrl(url); }}>{label}</a>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <div className="ai-code">
      <div className="ai-code-head">
        <span>{lang}</span>
        <button className="icon-btn" title={t("Copiar")} onClick={() => void navigator.clipboard.writeText(code)}>
          <Codicon name="copy" />
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

export default function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<p key={`p${i}-${blocks.length}`}>{inline(para.join(" "))}</p>);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\S*)/);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push(<CodeBlock key={`c${i}`} code={code.join("\n")} lang={fence[1]} />);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      flush();
      blocks.push(<div key={`h${i}`} className={`ai-h ai-h${h[1].length}`}>{inline(h[2])}</div>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) item += " " + lines[i++].trim();
        items.push(item);
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={`l${i}`}>{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</List>);
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return <div className="ai-md">{blocks.map((b, k) => <Fragment key={k}>{b}</Fragment>)}</div>;
}

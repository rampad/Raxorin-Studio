import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../../api";
import { Codicon } from "../Icon";
import { useTheme, type Theme } from "../../theme";

// Estilos del README según el tema (el HTML lo entrega crates.io ya saneado).
const PALETTE: Record<Theme, Record<string, string>> = {
  dark: { text: "#cccccc", link: "#4daafc", strong: "#fff", rule: "#333", code: "#2d2d2d", pre: "#1a1a1a", cell: "#3c3c3c", quote: "#9d9d9d" },
  light: { text: "#3b3b3b", link: "#005fb8", strong: "#1f1f1f", rule: "#e0e0e0", code: "#efefef", pre: "#f5f5f5", cell: "#d4d4d4", quote: "#6e6e6e" },
};
const readmeCss = (t: Theme) => {
  const c = PALETTE[t];
  return `
  body { margin: 0; padding: 4px 2px 16px; background: transparent; color: ${c.text};
         font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow: hidden; }
  a { color: ${c.link}; }
  h1, h2, h3, h4 { color: ${c.strong}; font-weight: 600; margin: 1.2em 0 .5em; border-bottom: 1px solid ${c.rule}; padding-bottom: .2em; }
  h1 { font-size: 1.6em; } h2 { font-size: 1.3em; } h3 { font-size: 1.1em; border: none; }
  code { font-family: Menlo, Consolas, monospace; font-size: 12px; background: ${c.code}; padding: 1px 4px; border-radius: 3px; }
  pre { background: ${c.pre}; border: 1px solid ${c.rule}; padding: 10px; border-radius: 4px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  img { max-width: 100%; }
  table { border-collapse: collapse; } td, th { border: 1px solid ${c.cell}; padding: 4px 8px; }
  blockquote { margin: 0; padding-left: 12px; border-left: 3px solid ${c.cell}; color: ${c.quote}; }
`;
};

export default function Readme({ name, version }: { name: string; version: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const { theme } = useTheme();

  useEffect(() => {
    setHtml(null);
    setError("");
    api.crateReadme(name, version).then(setHtml).catch((e) => setError(String(e)));
  }, [name, version]);

  // El iframe no ejecuta scripts (sandbox). Ajustamos su altura y abrimos los enlaces en el navegador.
  const onLoad = () => {
    const doc = frame.current?.contentDocument;
    if (!doc || !frame.current) return;
    const resize = () => frame.current && (frame.current.style.height = doc.documentElement.scrollHeight + "px");
    resize();
    doc.querySelectorAll("img").forEach((img) => img.addEventListener("load", resize));
    doc.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("a");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) doc.getElementById(href.slice(1))?.scrollIntoView();
      else if (/^https:\/\//.test(a.href)) openUrl(a.href).catch(() => {});
    });
  };

  if (error) return <div className="muted pad">Este crate no tiene README disponible.</div>;
  if (html === null) return <div className="muted pad"><Codicon name="loading" spin /> Cargando README…</div>;
  return (
    <iframe
      ref={frame}
      className="readme-frame"
      sandbox="allow-same-origin"
      onLoad={onLoad}
      srcDoc={`<!doctype html><html><head><meta charset="utf-8"><style>${readmeCss(theme)}</style></head><body>${html}</body></html>`}
      title={`README de ${name}`}
    />
  );
}

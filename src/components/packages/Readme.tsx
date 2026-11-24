import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../../api";
import { Codicon } from "../Icon";

// Estilos oscuros para el README (el HTML lo entrega crates.io ya saneado).
const README_CSS = `
  body { margin: 0; padding: 4px 2px 16px; background: transparent; color: #cccccc;
         font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow: hidden; }
  a { color: #4daafc; }
  h1, h2, h3, h4 { color: #fff; font-weight: 600; margin: 1.2em 0 .5em; border-bottom: 1px solid #333; padding-bottom: .2em; }
  h1 { font-size: 1.6em; } h2 { font-size: 1.3em; } h3 { font-size: 1.1em; border: none; }
  code { font-family: Menlo, Consolas, monospace; font-size: 12px; background: #2d2d2d; padding: 1px 4px; border-radius: 3px; }
  pre { background: #1a1a1a; border: 1px solid #333; padding: 10px; border-radius: 4px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  img { max-width: 100%; }
  table { border-collapse: collapse; } td, th { border: 1px solid #3c3c3c; padding: 4px 8px; }
  blockquote { margin: 0; padding-left: 12px; border-left: 3px solid #3c3c3c; color: #9d9d9d; }
`;

export default function Readme({ name, version }: { name: string; version: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);

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
      srcDoc={`<!doctype html><html><head><meta charset="utf-8"><style>${README_CSS}</style></head><body>${html}</body></html>`}
      title={`README de ${name}`}
    />
  );
}

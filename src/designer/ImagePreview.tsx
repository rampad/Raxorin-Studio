// Muestra en el diseñador la imagen de un `Image` (source: @image-url("…")), relativa al .slint.
import { createContext, useContext, useEffect, useState, type CSSProperties } from "react";
import { api } from "../api";
import { Codicon } from "../components/Icon";
import { resolveImagePath } from "./imagePath";

/** Carpeta del archivo .slint que se está diseñando (las rutas de @image-url son relativas a ella). */
export const ImageBaseContext = createContext<string | null>(null);

/** Imágenes ya leídas (ruta → data URL). Se vacía al volver a importar o al cambiar archivos. */
const cache = new Map<string, string>();
export const clearImageCache = () => cache.clear();

/** object-fit de CSS equivalente a image-fit de Slint. */
const FIT: Record<string, CSSProperties["objectFit"]> = { fill: "fill", contain: "contain", cover: "cover", preserve: "none" };

export default function ImagePreview({ src, fit }: { src: string | null; fit?: string }) {
  const base = useContext(ImageBaseContext);
  const path = src ? resolveImagePath(base, src) : null;
  const [url, setUrl] = useState<string | null>(path ? cache.get(path) ?? null : null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setMissing(false);
    if (!path) return setUrl(null);
    const hit = cache.get(path);
    if (hit) return setUrl(hit);
    let alive = true;
    api
      .readImageDataUrl(path)
      .then((u) => {
        cache.set(path, u);
        if (alive) setUrl(u);
      })
      .catch(() => alive && (setUrl(null), setMissing(true)));
    return () => {
      alive = false;
    };
  }, [path]);

  if (url) {
    return <img className="w-image-img" src={url} alt="" draggable={false} style={{ objectFit: FIT[fit ?? "fill"] ?? "fill" }} />;
  }
  return (
    <div className="w-image">
      <Codicon name={missing ? "warning" : "file-media"} />
      <span>{src ? (missing ? `No se encontró ${src}` : src) : "sin imagen"}</span>
    </div>
  );
}

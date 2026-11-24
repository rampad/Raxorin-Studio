import { useState, type ReactNode } from "react";
import { Codicon } from "./Icon";
import { setThemePref, useTheme, type ThemePref } from "../theme";
import { resetSettings, updateSettings, useSettings, type Settings } from "../settings";
import { resetLayout } from "../layout";

type Section = "appearance" | "editor" | "save" | "run" | "updates";

const SECTIONS: { id: Section; icon: string; name: string }[] = [
  { id: "appearance", icon: "symbol-color", name: "Apariencia" },
  { id: "editor", icon: "code", name: "Editor" },
  { id: "save", icon: "save", name: "Guardar" },
  { id: "run", icon: "play-circle", name: "Inicio y ejecución" },
  { id: "updates", icon: "cloud-download", name: "Actualizaciones" },
];

interface Props {
  runExternal: boolean;
  onRunExternal: (v: boolean) => void;
  onCustomizeToolbar: () => void;
  onCheckUpdates: () => void;
  onClose: () => void;
}

function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">{title}</div>
        {desc && <div className="set-desc muted">{desc}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={"switch" + (on ? " on" : "")} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

/** Configuración general (Ctrl/⌘+,). Los cambios se aplican y guardan al momento. */
export default function SettingsDialog({ runExternal, onRunExternal, onCustomizeToolbar, onCheckUpdates, onClose }: Props) {
  const [section, setSection] = useState<Section>("appearance");
  const s = useSettings();
  const { pref } = useTheme();
  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => updateSettings({ [k]: v } as Partial<Settings>);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal settings" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>
          <Codicon name="settings-gear" /> Configuración
        </h2>
        <div className="settings-body">
          <nav className="settings-nav">
            {SECTIONS.map((x) => (
              <button key={x.id} className={section === x.id ? "active" : ""} onClick={() => setSection(x.id)}>
                <Codicon name={x.icon} /> {x.name}
              </button>
            ))}
          </nav>
          <div className="settings-page">
            {section === "appearance" && (
              <>
                <Row title="Tema" desc="Colores de toda la aplicación y del editor.">
                  <div className="segmented">
                    {(["dark", "light", "system"] as ThemePref[]).map((t) => (
                      <button key={t} type="button" className={pref === t ? "active" : ""} onClick={() => setThemePref(t)}>
                        <Codicon name={t === "dark" ? "color-mode" : t === "light" ? "lightbulb" : "device-desktop"} />
                        {t === "dark" ? "Oscuro" : t === "light" ? "Claro" : "Sistema"}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row title="Barra de herramientas" desc="Elegir qué botones se muestran y en qué orden.">
                  <button className="btn" onClick={onCustomizeToolbar}>
                    <Codicon name="settings" /> Personalizar…
                  </button>
                </Row>
                <Row title="Paneles" desc="Volver al tamaño original del explorador, el panel inferior y los demás.">
                  <button className="btn" onClick={resetLayout}>
                    <Codicon name="discard" /> Restablecer
                  </button>
                </Row>
              </>
            )}
            {section === "editor" && (
              <>
                <Row title="Tamaño de letra" desc="Del editor de código (8 a 32).">
                  <div className="stepper">
                    <button className="btn" onClick={() => set("fontSize")(s.fontSize - 1)} disabled={s.fontSize <= 8} aria-label="Más pequeña">
                      <Codicon name="remove" />
                    </button>
                    <span className="mono">{s.fontSize}</span>
                    <button className="btn" onClick={() => set("fontSize")(s.fontSize + 1)} disabled={s.fontSize >= 32} aria-label="Más grande">
                      <Codicon name="add" />
                    </button>
                  </div>
                </Row>
                <Row title="Tabulación" desc="Espacios por nivel de sangría (rustfmt usa 4).">
                  <div className="segmented">
                    {([2, 4, 8] as const).map((n) => (
                      <button key={n} type="button" className={s.tabSize === n ? "active" : ""} onClick={() => set("tabSize")(n)}>
                        {n}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row title="Ajuste de línea" desc="Partir las líneas largas para que quepan sin desplazar.">
                  <Toggle label="Ajuste de línea" on={s.wordWrap} onChange={set("wordWrap")} />
                </Row>
                <Row title="Minimapa" desc="Vista en miniatura del archivo a la derecha.">
                  <Toggle label="Minimapa" on={s.minimap} onChange={set("minimap")} />
                </Row>
                <Row title="Números de línea">
                  <Toggle label="Números de línea" on={s.lineNumbers} onChange={set("lineNumbers")} />
                </Row>
                <Row title="Mostrar espacios" desc="Dibujar puntos en los espacios y flechas en las tabulaciones.">
                  <Toggle label="Mostrar espacios" on={s.renderWhitespace} onChange={set("renderWhitespace")} />
                </Row>
              </>
            )}
            {section === "save" && (
              <>
                <Row title="Formatear al guardar" desc="Aplicar rustfmt a los archivos .rs cada vez que se guardan.">
                  <Toggle label="Formatear al guardar" on={s.formatOnSave} onChange={set("formatOnSave")} />
                </Row>
                <Row title="Guardado automático" desc="Guardar los cambios un segundo después de dejar de escribir.">
                  <Toggle label="Guardado automático" on={s.autoSave} onChange={set("autoSave")} />
                </Row>
                <Row title="Avisar al cerrar con cambios sin guardar">
                  <Toggle label="Avisar al cerrar" on={s.confirmUnsaved} onChange={set("confirmUnsaved")} />
                </Row>
              </>
            )}
            {section === "updates" && (
              <>
                <Row title="Buscar actualizaciones automáticamente" desc="Al abrir Raxorin Studio y cada 6 horas. Siempre te pregunta antes de instalar.">
                  <Toggle label="Buscar actualizaciones automáticamente" on={s.autoUpdate} onChange={set("autoUpdate")} />
                </Row>
                <Row title="Canal" desc="Beta recibe antes las funciones nuevas, que pueden tener errores.">
                  <div className="segmented">
                    <button type="button" className={s.updateChannel === "stable" ? "active" : ""} onClick={() => set("updateChannel")("stable")}>
                      <Codicon name="verified" /> Estable
                    </button>
                    <button type="button" className={s.updateChannel === "beta" ? "active" : ""} onClick={() => set("updateChannel")("beta")}>
                      <Codicon name="beaker" /> Beta
                    </button>
                  </div>
                </Row>
                <Row title="Buscar ahora" desc="Las actualizaciones están firmadas: solo se instalan versiones oficiales.">
                  <button className="btn" onClick={onCheckUpdates}>
                    <Codicon name="sync" /> Buscar actualizaciones
                  </button>
                </Row>
              </>
            )}
            {section === "run" && (
              <>
                <Row title="Abrir lo último al iniciar" desc="Volver a abrir la última carpeta o solución al abrir Raxorin Studio.">
                  <Toggle label="Abrir lo último al iniciar" on={s.reopenLast} onChange={set("reopenLast")} />
                </Row>
                <Row title="Ejecutar sin depurar en…" desc="Dónde se ve el programa al usar “Sin depurar”.">
                  <div className="segmented">
                    <button type="button" className={!runExternal ? "active" : ""} onClick={() => onRunExternal(false)}>
                      <Codicon name="output" /> Panel de salida
                    </button>
                    <button type="button" className={runExternal ? "active" : ""} onClick={() => onRunExternal(true)}>
                      <Codicon name="terminal" /> Terminal externa
                    </button>
                  </div>
                </Row>
              </>
            )}
          </div>
        </div>
        <div className="actions">
          <button className="btn" onClick={resetSettings}>
            <Codicon name="discard" /> Valores por defecto
          </button>
          <span className="muted small">Los cambios se guardan solos.</span>
          <span className="spacer" />
          <button className="btn primary" onClick={onClose} autoFocus>
            Listo
          </button>
        </div>
      </div>
    </div>
  );
}

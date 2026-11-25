import { useState, type ReactNode } from "react";
import { Codicon } from "./Icon";
import { setThemePref, useTheme, type ThemePref } from "../theme";
import { resetSettings, updateSettings, useSettings, type Settings } from "../settings";
import { resetLayout } from "../layout";
import { t, readLangPref, setLangPref, type LangPref } from "../i18n/index.ts";

type Section = "appearance" | "editor" | "save" | "run" | "updates";

const SECTIONS: { id: Section; icon: string; name: string }[] = [
  { id: "appearance", icon: "symbol-color", name: t("Apariencia") },
  { id: "editor", icon: "code", name: t("Editor") },
  { id: "save", icon: "save", name: t("Guardar") },
  { id: "run", icon: "play-circle", name: t("Inicio y ejecución") },
  { id: "updates", icon: "cloud-download", name: t("Actualizaciones") },
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
  const langPref = readLangPref();
  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => updateSettings({ [k]: v } as Partial<Settings>);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal settings" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>
          <Codicon name="settings-gear" /> {" "}{t("Configuración")}
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
                <Row title={t("Tema")} desc={t("Colores de toda la aplicación y del editor.")}>
                  <div className="segmented">
                    {(["dark", "light", "system"] as ThemePref[]).map((it) => (
                      <button key={it} type="button" className={pref === it ? "active" : ""} onClick={() => setThemePref(it)}>
                        <Codicon name={it === "dark" ? "color-mode" : it === "light" ? "lightbulb" : "device-desktop"} />
                        {it === "dark" ? t("Oscuro") : it === "light" ? t("Claro") : t("Sistema")}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row title={t("Idioma")} desc={t("El idioma de Raxorin Studio. Al cambiarlo, la ventana se recarga.")}>
                  <div className="segmented">
                    {(["system", "es", "en"] as LangPref[]).map((l) => (
                      <button key={l} type="button" className={langPref === l ? "active" : ""} onClick={() => l !== langPref && setLangPref(l)}>
                        {l === "system" ? t("Sistema") : l === "es" ? "Español" : "English"}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row title={t("Barra de herramientas")} desc={t("Elegir qué botones se muestran y en qué orden.")}>
                  <button className="btn" onClick={onCustomizeToolbar}>
                    <Codicon name="settings" /> {" "}{t("Personalizar…")}
                  </button>
                </Row>
                <Row title={t("Paneles")} desc={t("Volver al tamaño original del explorador, el panel inferior y los demás.")}>
                  <button className="btn" onClick={resetLayout}>
                    <Codicon name="discard" /> {" "}{t("Restablecer")}
                  </button>
                </Row>
              </>
            )}
            {section === "editor" && (
              <>
                <Row title={t("Tamaño de letra")} desc={t("Del editor de código (8 a 32).")}>
                  <div className="stepper">
                    <button className="btn" onClick={() => set("fontSize")(s.fontSize - 1)} disabled={s.fontSize <= 8} aria-label={t("Más pequeña")}>
                      <Codicon name="remove" />
                    </button>
                    <span className="mono">{s.fontSize}</span>
                    <button className="btn" onClick={() => set("fontSize")(s.fontSize + 1)} disabled={s.fontSize >= 32} aria-label={t("Más grande")}>
                      <Codicon name="add" />
                    </button>
                  </div>
                </Row>
                <Row title={t("Tabulación")} desc={t("Espacios por nivel de sangría (rustfmt usa 4).")}>
                  <div className="segmented">
                    {([2, 4, 8] as const).map((n) => (
                      <button key={n} type="button" className={s.tabSize === n ? "active" : ""} onClick={() => set("tabSize")(n)}>
                        {n}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row title={t("Ajuste de línea")} desc={t("Partir las líneas largas para que quepan sin desplazar.")}>
                  <Toggle label={t("Ajuste de línea")} on={s.wordWrap} onChange={set("wordWrap")} />
                </Row>
                <Row title={t("Minimapa")} desc={t("Vista en miniatura del archivo a la derecha.")}>
                  <Toggle label={t("Minimapa")} on={s.minimap} onChange={set("minimap")} />
                </Row>
                <Row title={t("Números de línea")}>
                  <Toggle label={t("Números de línea")} on={s.lineNumbers} onChange={set("lineNumbers")} />
                </Row>
                <Row title={t("Mostrar espacios")} desc={t("Dibujar puntos en los espacios y flechas en las tabulaciones.")}>
                  <Toggle label={t("Mostrar espacios")} on={s.renderWhitespace} onChange={set("renderWhitespace")} />
                </Row>
              </>
            )}
            {section === "save" && (
              <>
                <Row title={t("Formatear al guardar")} desc={t("Aplicar rustfmt a los archivos .rs cada vez que se guardan.")}>
                  <Toggle label={t("Formatear al guardar")} on={s.formatOnSave} onChange={set("formatOnSave")} />
                </Row>
                <Row title={t("Guardado automático")} desc={t("Guardar los cambios un segundo después de dejar de escribir.")}>
                  <Toggle label={t("Guardado automático")} on={s.autoSave} onChange={set("autoSave")} />
                </Row>
                <Row title={t("Avisar al cerrar con cambios sin guardar")}>
                  <Toggle label={t("Avisar al cerrar")} on={s.confirmUnsaved} onChange={set("confirmUnsaved")} />
                </Row>
              </>
            )}
            {section === "updates" && (
              <>
                <Row title={t("Buscar actualizaciones automáticamente")} desc={t("Al abrir Raxorin Studio y cada 6 horas. Siempre te pregunta antes de instalar.")}>
                  <Toggle label={t("Buscar actualizaciones automáticamente")} on={s.autoUpdate} onChange={set("autoUpdate")} />
                </Row>
                <Row title={t("Canal")} desc={t("Beta recibe antes las funciones nuevas, que pueden tener errores.")}>
                  <div className="segmented">
                    <button type="button" className={s.updateChannel === "stable" ? "active" : ""} onClick={() => set("updateChannel")("stable")}>
                      <Codicon name="verified" /> {" "}{t("Estable")}
                    </button>
                    <button type="button" className={s.updateChannel === "beta" ? "active" : ""} onClick={() => set("updateChannel")("beta")}>
                      <Codicon name="beaker" /> {" "}{t("Beta")}
                    </button>
                  </div>
                </Row>
                <Row title={t("Buscar ahora")} desc={t("Las actualizaciones están firmadas: solo se instalan versiones oficiales.")}>
                  <button className="btn" onClick={onCheckUpdates}>
                    <Codicon name="sync" /> {" "}{t("Buscar actualizaciones")}
                  </button>
                </Row>
              </>
            )}
            {section === "run" && (
              <>
                <Row title={t("Abrir lo último al iniciar")} desc={t("Volver a abrir la última carpeta o solución al abrir Raxorin Studio.")}>
                  <Toggle label={t("Abrir lo último al iniciar")} on={s.reopenLast} onChange={set("reopenLast")} />
                </Row>
                <Row title={t("Ejecutar sin depurar en…")} desc={t("Dónde se ve el programa al usar “Sin depurar”.")}>
                  <div className="segmented">
                    <button type="button" className={!runExternal ? "active" : ""} onClick={() => onRunExternal(false)}>
                      <Codicon name="output" /> {" "}{t("Panel de salida")}
                    </button>
                    <button type="button" className={runExternal ? "active" : ""} onClick={() => onRunExternal(true)}>
                      <Codicon name="terminal" /> {" "}{t("Terminal externa")}
                    </button>
                  </div>
                </Row>
              </>
            )}
          </div>
        </div>
        <div className="actions">
          <button className="btn" onClick={resetSettings}>
            <Codicon name="discard" /> {" "}{t("Valores por defecto")}
          </button>
          <span className="muted small">{t("Los cambios se guardan solos.")}</span>
          <span className="spacer" />
          <button className="btn primary" onClick={onClose} autoFocus>
            
            {t("Listo")}
          </button>
        </div>
      </div>
    </div>
  );
}

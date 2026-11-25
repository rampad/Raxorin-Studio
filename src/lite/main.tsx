// Entrada de Raxorin Studio Lite (la versión de navegador; ver LiteApp.tsx).
import "./install-shim"; // primero: antes de cualquier módulo que use el "backend"
import "../monaco-setup";
import "@vscode/codicons/dist/codicon.css";
import "../styles.css";
import "./lite.css";
import "../theme";
import { createRoot } from "react-dom/client";
import { lang } from "../i18n/index.ts";
import LiteApp from "./LiteApp";

document.documentElement.lang = lang;
// Solo en desarrollo: acceso para la prueba en Chrome (tests/lite/navegador.mjs).
if (import.meta.env.DEV) void import("monaco-editor").then((m) => Object.assign(window, { monaco: m }));
createRoot(document.getElementById("root")!).render(<LiteApp />);

import "./monaco-setup";
import "@vscode/codicons/dist/codicon.css";
import "./styles.css";
import "./theme"; // aplica el tema guardado antes del primer render
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);

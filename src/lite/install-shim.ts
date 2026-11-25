// Se importa primero en main.tsx: algunos módulos del IDE usan el "backend" de Tauri al cargarse.
import { installShim } from "./shim";

installShim();

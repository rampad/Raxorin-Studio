// Monaco empaquetado localmente (sin CDN) para que la IDE funcione sin internet.
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { loader } from "@monaco-editor/react";

self.MonacoEnvironment = { getWorker: () => new editorWorker() };
loader.config({ monaco });

import { registerSlintLanguage } from "./designer/slintLanguage";
registerSlintLanguage();

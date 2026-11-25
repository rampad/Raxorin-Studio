## Chat con IA
- **Un chat en el panel derecho** (Ver → Chat con IA, Ctrl/⌘+Shift+I) que conversa sobre tu proyecto y trabaja en él: lee el código, compila, ejecuta las pruebas, explica los errores y propone cambios.
- **Elige la IA:** Claude con tu clave de API, Claude Code con tu suscripción, Gemini con tu clave de API, Gemini CLI con tu cuenta de Google o GitHub Copilot con su CLI. Las claves se guardan en el llavero del sistema.
- **Inicia sesión desde el chat:** Claude Code, Copilot y Gemini CLI se instalan y conectan con un botón (el terminal integrado abre el navegador para autorizar), y el chat muestra con qué cuenta estás conectado.
- **Tú apruebas cada cambio:** los archivos se ven como diferencias (rojo y verde) y los comandos tal como se van a ejecutar. Si rechazas, puedes decir por qué.
- La IA ve el archivo abierto, el texto seleccionado y los errores actuales.
- Los archivos que cambian fuera del editor (la IA, Git u otra app) se recargan solos si no tienen cambios sin guardar.
- El servidor MCP suma `edit_file`, para cambiar un fragmento de un archivo sin reescribirlo.
- Guía: [raxorin.dev/guias/chat-ia](https://raxorin.dev/guias/chat-ia/).

---

<!-- English -->
## AI chat
- **A chat in the right panel** (View → AI chat, Ctrl/⌘+Shift+I) that talks about your project and works on it: it reads the code, builds, runs the tests, explains errors and proposes changes.
- **Choose the AI:** Claude with your API key, Claude Code with your subscription, Gemini with your API key, Gemini CLI with your Google account or GitHub Copilot with its CLI. Keys are saved in the system keychain.
- **Sign in from the chat:** Claude Code, Copilot and Gemini CLI install and connect with a button (the integrated terminal opens the browser to authorize), and the chat shows which account you're signed in with.
- **You approve every change:** files are shown as differences (red and green) and commands exactly as they'll run. If you decline, you can say why.
- The AI sees the open file, the selected text and the current errors.
- Files changed outside the editor (the AI, Git or another app) reload by themselves if they have no unsaved changes.
- The MCP server adds `edit_file`, to change part of a file without rewriting it.
- Guide: [raxorin.dev/en/guias/chat-ia](https://raxorin.dev/en/guias/chat-ia/).

// Catálogo de controles de la caja de herramientas: propiedades, eventos
// y qué propiedad se puede leer/escribir desde Rust.

export type PropKind =
  | "length" | "string" | "text" | "bool" | "color" | "number" | "int"
  | "percent" | "enum" | "strings" | "image";

export interface PropDef {
  name: string;
  label: string;
  kind: PropKind;
  group: "Diseño" | "Contenido" | "Apariencia" | "Comportamiento";
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  /** Valor por defecto de Slint (solo para mostrar). */
  fallback?: string;
}

export interface EventParam { name: string; slint: "string" | "float" | "int" }
export interface EventDef { name: string; label: string; params: EventParam[] }

export interface Bindable { prop: string; slint: "string" | "bool" | "float" | "int" }

export interface WidgetDef {
  type: string;
  label: string;
  icon: string; // codicon
  /** Prefijo para nombres automáticos (boton1, texto2…). */
  idBase: string;
  size: [number, number];
  defaults: Record<string, string>;
  props: PropDef[];
  events: EventDef[];
  bindable?: Bindable[];
  container?: boolean;
}

const LAYOUT: PropDef[] = [
  { name: "x", label: "X", kind: "length", group: "Diseño" },
  { name: "y", label: "Y", kind: "length", group: "Diseño" },
  { name: "width", label: "Ancho", kind: "length", group: "Diseño" },
  { name: "height", label: "Alto", kind: "length", group: "Diseño" },
];
const VISIBLE: PropDef = { name: "visible", label: "Visible", kind: "bool", group: "Comportamiento", fallback: "true" };
const ENABLED: PropDef = { name: "enabled", label: "Habilitado", kind: "bool", group: "Comportamiento", fallback: "true" };

export const WIDGETS: WidgetDef[] = [
  {
    type: "Text", label: "Etiqueta (Text)", icon: "text-size", idBase: "texto", size: [160, 24],
    defaults: { text: '"Texto"' },
    props: [
      ...LAYOUT,
      { name: "text", label: "Texto", kind: "text", group: "Contenido" },
      { name: "font-size", label: "Tamaño de letra", kind: "length", group: "Apariencia", fallback: "14px" },
      { name: "font-weight", label: "Grosor", kind: "enum", group: "Apariencia", options: ["400", "600", "700", "900"], fallback: "400" },
      { name: "color", label: "Color", kind: "color", group: "Apariencia" },
      { name: "horizontal-alignment", label: "Alineación horizontal", kind: "enum", group: "Apariencia", options: ["left", "center", "right"], fallback: "left" },
      { name: "vertical-alignment", label: "Alineación vertical", kind: "enum", group: "Apariencia", options: ["top", "center", "bottom"], fallback: "top" },
      { name: "wrap", label: "Ajuste de línea", kind: "enum", group: "Apariencia", options: ["no-wrap", "word-wrap"], fallback: "no-wrap" },
      VISIBLE,
    ],
    events: [],
    bindable: [{ prop: "text", slint: "string" }],
  },
  {
    type: "Button", label: "Botón (Button)", icon: "record", idBase: "boton", size: [110, 32],
    defaults: { text: '"Botón"' },
    props: [
      ...LAYOUT,
      { name: "text", label: "Texto", kind: "string", group: "Contenido" },
      { name: "primary", label: "Principal (color de acento)", kind: "bool", group: "Apariencia", fallback: "false" },
      { name: "checkable", label: "Se puede mantener presionado", kind: "bool", group: "Comportamiento", fallback: "false" },
      ENABLED, VISIBLE,
    ],
    events: [{ name: "clicked", label: "Al hacer clic", params: [] }],
    bindable: [{ prop: "text", slint: "string" }, { prop: "enabled", slint: "bool" }],
  },
  {
    type: "LineEdit", label: "Cuadro de texto (LineEdit)", icon: "symbol-string", idBase: "entrada", size: [200, 32],
    defaults: { "placeholder-text": '"Escribe aquí"' },
    props: [
      ...LAYOUT,
      { name: "text", label: "Texto", kind: "string", group: "Contenido" },
      { name: "placeholder-text", label: "Texto de ayuda", kind: "string", group: "Contenido" },
      { name: "input-type", label: "Tipo de entrada", kind: "enum", group: "Comportamiento", options: ["text", "password", "number", "decimal"], fallback: "text" },
      { name: "read-only", label: "Solo lectura", kind: "bool", group: "Comportamiento", fallback: "false" },
      { name: "font-size", label: "Tamaño de letra", kind: "length", group: "Apariencia" },
      ENABLED, VISIBLE,
    ],
    events: [
      { name: "accepted", label: "Al presionar Enter", params: [{ name: "text", slint: "string" }] },
      { name: "edited", label: "Al cambiar el texto", params: [{ name: "text", slint: "string" }] },
    ],
    bindable: [{ prop: "text", slint: "string" }],
  },
  {
    type: "TextEdit", label: "Área de texto (TextEdit)", icon: "note", idBase: "area_texto", size: [260, 120],
    defaults: {},
    props: [
      ...LAYOUT,
      { name: "text", label: "Texto", kind: "text", group: "Contenido" },
      { name: "placeholder-text", label: "Texto de ayuda", kind: "string", group: "Contenido" },
      { name: "wrap", label: "Ajuste de línea", kind: "enum", group: "Apariencia", options: ["word-wrap", "no-wrap"], fallback: "word-wrap" },
      { name: "read-only", label: "Solo lectura", kind: "bool", group: "Comportamiento", fallback: "false" },
      { name: "font-size", label: "Tamaño de letra", kind: "length", group: "Apariencia" },
      ENABLED, VISIBLE,
    ],
    events: [{ name: "edited", label: "Al cambiar el texto", params: [{ name: "text", slint: "string" }] }],
    bindable: [{ prop: "text", slint: "string" }],
  },
  {
    type: "CheckBox", label: "Casilla (CheckBox)", icon: "pass", idBase: "casilla", size: [160, 24],
    defaults: { text: '"Opción"' },
    props: [
      ...LAYOUT,
      { name: "text", label: "Texto", kind: "string", group: "Contenido" },
      { name: "checked", label: "Marcada", kind: "bool", group: "Contenido", fallback: "false" },
      ENABLED, VISIBLE,
    ],
    events: [{ name: "toggled", label: "Al marcar o desmarcar", params: [] }],
    bindable: [{ prop: "checked", slint: "bool" }],
  },
  {
    type: "Switch", label: "Interruptor (Switch)", icon: "settings", idBase: "interruptor", size: [160, 24],
    defaults: { text: '"Activar"' },
    props: [
      ...LAYOUT,
      { name: "text", label: "Texto", kind: "string", group: "Contenido" },
      { name: "checked", label: "Encendido", kind: "bool", group: "Contenido", fallback: "false" },
      ENABLED, VISIBLE,
    ],
    events: [{ name: "toggled", label: "Al encender o apagar", params: [] }],
    bindable: [{ prop: "checked", slint: "bool" }],
  },
  {
    type: "Slider", label: "Deslizador (Slider)", icon: "settings-gear", idBase: "deslizador", size: [200, 24],
    defaults: { minimum: "0", maximum: "100", value: "50" },
    props: [
      ...LAYOUT,
      { name: "value", label: "Valor", kind: "number", group: "Contenido" },
      { name: "minimum", label: "Mínimo", kind: "number", group: "Contenido", fallback: "0" },
      { name: "maximum", label: "Máximo", kind: "number", group: "Contenido", fallback: "100" },
      { name: "step", label: "Paso", kind: "number", group: "Comportamiento", fallback: "1" },
      ENABLED, VISIBLE,
    ],
    events: [{ name: "changed", label: "Al mover", params: [{ name: "value", slint: "float" }] }],
    bindable: [{ prop: "value", slint: "float" }],
  },
  {
    type: "SpinBox", label: "Número (SpinBox)", icon: "symbol-numeric", idBase: "numero", size: [120, 32],
    defaults: { minimum: "0", maximum: "100", value: "0" },
    props: [
      ...LAYOUT,
      { name: "value", label: "Valor", kind: "int", group: "Contenido" },
      { name: "minimum", label: "Mínimo", kind: "int", group: "Contenido", fallback: "0" },
      { name: "maximum", label: "Máximo", kind: "int", group: "Contenido", fallback: "100" },
      ENABLED, VISIBLE,
    ],
    events: [{ name: "edited", label: "Al cambiar el valor", params: [{ name: "value", slint: "int" }] }],
    bindable: [{ prop: "value", slint: "int" }],
  },
  {
    type: "ComboBox", label: "Lista desplegable (ComboBox)", icon: "list-selection", idBase: "lista", size: [180, 32],
    defaults: { model: '["Opción 1", "Opción 2", "Opción 3"]' },
    props: [
      ...LAYOUT,
      { name: "model", label: "Opciones", kind: "strings", group: "Contenido" },
      { name: "current-index", label: "Índice seleccionado", kind: "int", group: "Contenido", fallback: "0" },
      ENABLED, VISIBLE,
    ],
    events: [{ name: "selected", label: "Al elegir una opción", params: [{ name: "value", slint: "string" }] }],
    bindable: [{ prop: "current-index", slint: "int" }, { prop: "current-value", slint: "string" }],
  },
  {
    type: "ProgressIndicator", label: "Barra de progreso", icon: "loading", idBase: "progreso", size: [200, 6],
    defaults: { progress: "0.4" },
    props: [
      ...LAYOUT,
      { name: "progress", label: "Progreso", kind: "percent", group: "Contenido" },
      { name: "indeterminate", label: "Indeterminado (animado)", kind: "bool", group: "Apariencia", fallback: "false" },
      VISIBLE,
    ],
    events: [],
    bindable: [{ prop: "progress", slint: "float" }],
  },
  {
    type: "Rectangle", label: "Panel (Rectangle)", icon: "primitive-square", idBase: "panel", size: [200, 120],
    defaults: { background: "#e6e6e6", "border-radius": "6px" },
    container: true,
    props: [
      ...LAYOUT,
      { name: "background", label: "Fondo", kind: "color", group: "Apariencia" },
      { name: "border-radius", label: "Radio de esquinas", kind: "length", group: "Apariencia", fallback: "0px" },
      { name: "border-width", label: "Grosor del borde", kind: "length", group: "Apariencia", fallback: "0px" },
      { name: "border-color", label: "Color del borde", kind: "color", group: "Apariencia" },
      VISIBLE,
    ],
    events: [],
  },
  {
    type: "Image", label: "Imagen (Image)", icon: "file-media", idBase: "imagen", size: [120, 120],
    defaults: {},
    props: [
      ...LAYOUT,
      { name: "source", label: "Archivo", kind: "image", group: "Contenido" },
      { name: "image-fit", label: "Ajuste", kind: "enum", group: "Apariencia", options: ["fill", "contain", "cover", "preserve"], fallback: "fill" },
      VISIBLE,
    ],
    events: [],
  },
];

export const WINDOW_DEF: WidgetDef = {
  type: "Window", label: "Ventana", icon: "window", idBase: "root", size: [400, 300],
  defaults: {},
  container: true,
  props: [
    { name: "title", label: "Título", kind: "string", group: "Contenido" },
    { name: "width", label: "Ancho", kind: "length", group: "Diseño" },
    { name: "height", label: "Alto", kind: "length", group: "Diseño" },
    { name: "background", label: "Fondo", kind: "color", group: "Apariencia" },
    { name: "default-font-size", label: "Tamaño de letra por defecto", kind: "length", group: "Apariencia" },
  ],
  events: [],
};

export const widgetDef = (type: string): WidgetDef | undefined =>
  type === "Window" ? WINDOW_DEF : WIDGETS.find((w) => w.type === type);

/** Tipo de Rust que corresponde a un tipo de Slint. */
export const RUST_TYPE: Record<string, string> = {
  string: "SharedString",
  bool: "bool",
  float: "f32",
  int: "i32",
};

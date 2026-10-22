export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point {
  width: number;
  height: number;
}
export interface Adjustments {
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  exposure: number;
  temperature: number;
  tint: number;
  shadows: number;
  highlights: number;
  blur: number;
  grayscale: boolean;
  invert: boolean;
  sepia: number;
  gamma: number;
  blackPoint: number;
  whitePoint: number;
}
export interface LayerEffects {
  shadow: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowX: number;
  shadowY: number;
  stroke: boolean;
  strokeColor: string;
  strokeWidth: number;
}
export interface TextSpec {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  color: string;
  align: CanvasTextAlign;
  lineHeight: number;
}
export interface ShapeSpec {
  kind: "rectangle" | "ellipse" | "line";
  fill: string;
  stroke: string;
  strokeWidth: number;
  radius: number;
}
export interface Layer {
  id: string;
  name: string;
  type: "raster" | "text" | "shape" | "group" | "adjustment";
  width: number;
  height: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: string;
  clip: boolean;
  canvas?: HTMLCanvasElement;
  mask?: HTMLCanvasElement;
  maskEnabled: boolean;
  text?: TextSpec;
  shape?: ShapeSpec;
  children?: Layer[];
  adjustments: Adjustments;
  effects: LayerEffects;
}
export interface EditorDocument {
  id: string;
  name: string;
  width: number;
  height: number;
  layers: Layer[];
  activeId: string;
  dirty: boolean;
  filePath?: string;
}
export type Tool =
  | "move"
  | "transform"
  | "rect-select"
  | "ellipse-select"
  | "lasso"
  | "wand"
  | "crop"
  | "brush"
  | "eraser"
  | "clone"
  | "heal"
  | "blur"
  | "fill"
  | "gradient"
  | "text"
  | "rectangle"
  | "ellipse"
  | "line"
  | "eyedropper"
  | "hand"
  | "zoom";
export interface NativeFile {
  name: string;
  path?: string;
  bytes: Uint8Array;
  files?: Record<string, Uint8Array>;
}
export interface CodexSetupStatus {
  configured: boolean;
  codex: { available: boolean; executable?: string | null; home: string };
  skill: { installed: boolean; path: string };
  mcp: { registered: boolean; name: string };
  reloadRequired: boolean;
  message: string;
  backupDirectory?: string;
  errorCode?: string;
}
export interface CodexConnectionResult {
  ok: boolean;
  message: string;
  toolCount?: number;
  documentName?: string;
}
export interface DesktopBridge {
  getCodexStatus(): Promise<CodexSetupStatus>;
  setupCodex(): Promise<CodexSetupStatus>;
  chooseCodexExecutable(): Promise<CodexSetupStatus | null>;
  checkCodexConnection(): Promise<CodexConnectionResult>;
  openFiles(): Promise<NativeFile[] | null>;
  openProjectFolder(): Promise<NativeFile | null>;
  saveFile(args: {
    name: string;
    bytes: Uint8Array;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string | null>;
  saveProjectFolder(args: {
    name: string;
    files: Record<string, Uint8Array>;
  }): Promise<string | null>;
  onMenu(callback: (action: string) => void): () => void;
  setDirty(dirty: boolean): void;
  confirmClose(): Promise<boolean>;
  onAutomation(
    callback: (request: {
      action: string;
      args: Record<string, unknown>;
    }) => Promise<unknown>,
  ): () => void;
}
declare global {
  interface Window {
    desktop?: DesktopBridge;
    __editor?: unknown;
  }
}

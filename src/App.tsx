import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowDown,
  ArrowUp,
  Blend,
  Brush,
  Check,
  ChevronDown,
  Circle,
  Copy,
  Crop,
  Download,
  Eraser,
  Eye,
  EyeOff,
  FilePlus2,
  FlipHorizontal,
  FlipVertical,
  Folder,
  FolderOpen,
  Hand,
  History,
  ImagePlus,
  Layers,
  Lasso,
  Lock,
  Maximize,
  Minus,
  MousePointer2,
  Move,
  PaintBucket,
  PenLine,
  Pipette,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Scan,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Stamp,
  Trash2,
  Type,
  Undo2,
  Unlock,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
  Droplets,
  CircleDashed,
  ScanLine,
  Terminal,
  Feather,
} from "lucide-react";
import { editor as e, toolNames, blendModes } from "./editor";
import { Stage } from "./Stage";
import {
  createCanvas,
  makeLayer,
  sourceCanvas,
  defaultAdjustments,
  featherMask,
} from "./engine";
import type { Layer, Tool, Point, Adjustments } from "./types";

const toolList: [Tool, typeof Move, string][] = [
  ["move", Move, "V"],
  ["transform", Maximize, "Ctrl+T"],
  ["rect-select", Square, "M"],
  ["ellipse-select", CircleDashed, "Shift+M"],
  ["lasso", Lasso, "L"],
  ["wand", WandSparkles, "W"],
  ["crop", Crop, "C"],
  ["eyedropper", Pipette, "I"],
  ["brush", Brush, "B"],
  ["eraser", Eraser, "E"],
  ["clone", Stamp, "S"],
  ["blur", Droplets, ""],
  ["fill", PaintBucket, "G"],
  ["gradient", Blend, "Shift+G"],
  ["text", Type, "T"],
  ["rectangle", Square, "U"],
  ["ellipse", Circle, "Shift+U"],
  ["line", Minus, ""],
  ["hand", Hand, "H"],
  ["zoom", ZoomIn, "Z"],
];
const toolKeys: Record<string, Tool> = {
  v: "move",
  m: "rect-select",
  l: "lasso",
  w: "wand",
  c: "crop",
  i: "eyedropper",
  b: "brush",
  e: "eraser",
  s: "clone",
  g: "fill",
  t: "text",
  u: "rectangle",
  h: "hand",
  z: "zoom",
};
const filterList = [
  ["gaussian", "高斯模糊", 5],
  ["motion", "动感模糊", 16],
  ["sharpen", "锐化", 35],
  ["noise", "添加噪点", 15],
  ["pixelate", "像素化", 12],
  ["emboss", "浮雕", 50],
  ["edges", "边缘", 50],
  ["vignette", "暗角", 40],
  ["bloom", "辉光", 25],
] as const;
const adjustmentControls: [
  keyof Adjustments,
  string,
  number,
  number,
  number,
][] = [
  ["brightness", "亮度", -100, 100, 1],
  ["contrast", "对比度", -100, 100, 1],
  ["exposure", "曝光", -4, 4, 0.1],
  ["saturation", "饱和度", -100, 100, 1],
  ["hue", "色相", -180, 180, 1],
  ["temperature", "色温", -100, 100, 1],
  ["tint", "色调", -100, 100, 1],
  ["shadows", "阴影", -100, 100, 1],
  ["highlights", "高光", -100, 100, 1],
  ["gamma", "伽马", 0.1, 3, 0.05],
  ["blackPoint", "黑场", 0, 254, 1],
  ["whitePoint", "白场", 1, 255, 1],
  ["blur", "模糊", 0, 40, 0.5],
  ["sepia", "棕褐色", 0, 100, 1],
];

function IconButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  disabled = false,
}: {
  icon: typeof Move;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={"icon-button " + (active ? "active" : "")}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={16} strokeWidth={1.7} />
    </button>
  );
}
function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <input
        type="number"
        value={Number(value.toFixed(2))}
        step={step}
        min={min}
        max={max}
        onChange={(ev) => {
          const n = Number(ev.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </label>
  );
}
function Thumbnail({ layer }: { layer: Layer }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const c = ref.current;
    c.width = 38;
    c.height = 30;
    const source = sourceCanvas(layer),
      scale = Math.min(38 / source.width, 30 / source.height);
    c.getContext("2d")!.drawImage(
      source,
      (38 - source.width * scale) / 2,
      (30 - source.height * scale) / 2,
      source.width * scale,
      source.height * scale,
    );
  }, [e.revision, layer]);
  return <canvas ref={ref} className="thumbnail" />;
}
export function App() {
  const revision = useSyncExternalStore(e.subscribe, () => e.revision);
  const [menu, setMenu] = useState<string | null>(null),
    [panel, setPanel] = useState("properties"),
    [bottomPanel, setBottomPanel] = useState("layers"),
    [modal, setModal] = useState<string | null>(null),
    [textPoint, setTextPoint] = useState<Point>({ x: 120, y: 120 }),
    [text, setText] = useState("在这里写下你的文字"),
    [newName, setNewName] = useState("未命名"),
    [newWidth, setNewWidth] = useState(1600),
    [newHeight, setNewHeight] = useState(1000),
    [newBg, setNewBg] = useState("transparent"),
    [filterKind, setFilterKind] = useState("gaussian"),
    [filterAmount, setFilterAmount] = useState(5),
    [command, setCommand] = useState(
      '{\n  "action": "adjust",\n  "args": { "brightness": 12, "saturation": 15 }\n}',
    );
  const fileInput = useRef<HTMLInputElement>(null);
  const l = e.layer;
  const safe = (fn: () => unknown) => {
    try {
      const p = fn();
      if (p instanceof Promise)
        p.catch((err) =>
          e.message(err instanceof Error ? err.message : String(err)),
        );
    } catch (err) {
      e.message(err instanceof Error ? err.message : String(err));
    }
  };
  const act = (action: string) => {
    setMenu(null);
    if (action === "new") {
      setModal("new");
      return;
    }
    if (action === "open" && !window.desktop) {
      fileInput.current?.click();
      return;
    }
    if (action === "fit") {
      window.dispatchEvent(new CustomEvent("editor-view", { detail: "fit" }));
      return;
    }
    if (action === "image-size" || action === "canvas-size") {
      setNewWidth(e.doc.width);
      setNewHeight(e.doc.height);
      setModal(action);
      return;
    }
    if (action === "shortcuts" || action === "about") {
      setModal(action);
      return;
    }
    if (action === "ai") {
      setPanel("ai");
      return;
    }
    if (action === "filter") {
      setModal("filter");
      return;
    }
    if (action === "feather") {
      if (e.selection) {
        e.selection = featherMask(e.selection, 5);
        e.touch();
      }
      return;
    }
    safe(() => e.action(action));
  };
  useEffect(() => {
    const remove = window.desktop?.onMenu((action) => {
      if (
        /INPUT|TEXTAREA/.test(document.activeElement?.tagName || "") &&
        ["copy", "cut", "paste", "undo", "redo", "select-all"].includes(action)
      ) {
        document.execCommand(action === "select-all" ? "selectAll" : action);
        return;
      }
      act(action);
    });
    let queue: Promise<unknown> = Promise.resolve();
    const automation = window.desktop?.onAutomation((req) => {
      const job = queue.then(async () => {
        try {
          return await e.automate(req.action, req.args);
        } catch (err) {
          e.message(
            "AI 操作失败：" +
              (err instanceof Error ? err.message : String(err)),
          );
          throw err;
        }
      });
      queue = job.catch(() => {});
      return job;
    });
    window.__editor = e;
    const onKey = (ev: KeyboardEvent) => {
      if (/INPUT|TEXTAREA|SELECT/.test((ev.target as HTMLElement).tagName))
        return;
      const k = ev.key.toLowerCase(),
        ctrl = ev.ctrlKey || ev.metaKey;
      let action = "";
      if (ctrl) {
        const map: Record<string, string> = {
          n: "new",
          o: "open",
          s: "save",
          z: ev.shiftKey ? "redo" : "undo",
          y: "redo",
          a: "select-all",
          d: "deselect",
          e: ev.shiftKey ? "export-png" : "merge",
          j: "duplicate",
          g: "group",
          c: "copy",
          x: "cut",
          v: "paste",
          "0": "fit",
          "1": "actual",
        };
        action = map[k];
        if (k === "t") {
          e.tool = "transform";
          e.touch();
          ev.preventDefault();
          return;
        }
      } else {
        if (toolKeys[k]) {
          e.tool =
            ev.shiftKey && k === "m"
              ? "ellipse-select"
              : ev.shiftKey && k === "g"
                ? "gradient"
                : ev.shiftKey && k === "u"
                  ? "ellipse"
                  : toolKeys[k];
          e.touch();
        }
        if (k === "delete" || k === "backspace")
          action = e.selection ? "clear" : "delete-layer";
        if (k === "escape") {
          setModal(null);
          setMenu(null);
          action = "deselect";
        }
        if (k === "[") {
          e.brushSize = Math.max(1, e.brushSize - 5);
          e.touch();
        }
        if (k === "]") {
          e.brushSize = Math.min(500, e.brushSize + 5);
          e.touch();
        }
        if (k === "x") {
          [e.color, e.background] = [e.background, e.color];
          e.touch();
        }
        if (k === "d") {
          e.color = "#000000";
          e.background = "#ffffff";
          e.touch();
        }
        if (k === "+" || k === "=") action = "zoom-in";
        if (k === "-") action = "zoom-out";
        if (
          ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(k) &&
          e.layer &&
          !e.layer.locked
        ) {
          ev.preventDefault();
          const s = ev.shiftKey ? 10 : 1;
          e.updateLayer(
            {
              x:
                e.layer.x +
                (k === "arrowleft" ? -s : k === "arrowright" ? s : 0),
              y: e.layer.y + (k === "arrowup" ? -s : k === "arrowdown" ? s : 0),
            },
            "移动图层",
          );
        }
      }
      if (action) {
        ev.preventDefault();
        act(action);
      }
    };
    const close = (ev: BeforeUnloadEvent) => {
      if (e.documents.some((d) => d.dirty) && !window.desktop) {
        ev.preventDefault();
        ev.returnValue = "";
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", close);
    return () => {
      remove?.();
      automation?.();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", close);
    };
  }, []);
  const menus: Record<string, [string, string, string?][]> = {
    文件: [
      ["new", "新建画布", "Ctrl N"],
      ["open", "打开图像 / 工程", "Ctrl O"],
      ["open-comp", "打开原版 .comp 文件夹"],
      ["save", "保存工程", "Ctrl S"],
      ["export-png", "导出 PNG", "Ctrl Shift E"],
      ["export-jpeg", "导出 JPEG"],
      ["export-psd", "导出 PSD"],
      ["export-comp", "导出原版 .comp"],
    ],
    编辑: [
      ["undo", "撤销", "Ctrl Z"],
      ["redo", "重做", "Ctrl Shift Z"],
      ["copy", "复制图层", "Ctrl C"],
      ["paste", "粘贴图层", "Ctrl V"],
      ["clear", "清除选区像素", "Delete"],
    ],
    图像: [
      ["image-size", "图像大小"],
      ["canvas-size", "画布大小"],
      ["remove-background", "去除边缘纯色背景"],
      ["flatten", "合并可见图层"],
    ],
    图层: [
      ["new-layer", "新建图层"],
      ["duplicate", "复制图层", "Ctrl J"],
      ["group", "创建图层组", "Ctrl G"],
      ["ungroup", "取消编组"],
      ["mask", "添加图层蒙版"],
      ["invert-mask", "反相蒙版"],
      ["rasterize", "栅格化图层"],
      ["merge", "向下合并", "Ctrl E"],
      ["delete-layer", "删除图层"],
    ],
    选择: [
      ["select-all", "全部选择", "Ctrl A"],
      ["deselect", "取消选择", "Ctrl D"],
      ["invert-selection", "反向选择"],
      ["feather", "羽化 5 像素"],
    ],
    滤镜: filterList.map(([kind, name]) => ["filter:" + kind, name]),
    视图: [
      ["fit", "适合窗口", "Ctrl 0"],
      ["actual", "实际像素", "Ctrl 1"],
      ["zoom-in", "放大", "+"],
      ["zoom-out", "缩小", "−"],
      ["grid", "切换网格"],
      ["rulers", "切换标尺"],
      ["ai", "AI 操作面板"],
    ],
    帮助: [
      ["shortcuts", "快捷键"],
      ["about", "关于与功能边界"],
    ],
  };
  const demo = () => {
    e.newDocument("光的形状 · 示例", 1400, 1000);
    const c = e.layer!.canvas!,
      ctx = c.getContext("2d")!,
      g = ctx.createLinearGradient(0, 0, 1400, 1000);
    g.addColorStop(0, "#132b35");
    g.addColorStop(0.6, "#31534b");
    g.addColorStop(1, "#cf967b");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    e.color = "#e2b798";
    e.addShape("ellipse", { x: 790, y: 140, width: 420, height: 420 });
    e.color = "#12302f";
    e.addShape("ellipse", { x: -320, y: 570, width: 1600, height: 950 });
    e.addText("THE SHAPE\nOF LIGHT", 100, 180, {
      fontFamily: "Georgia",
      fontSize: 116,
      color: "#f7eee4",
      lineHeight: 1.1,
    });
    e.addText("光 的 形 状   /   2026", 108, 75, {
      fontSize: 20,
      color: "#cad8d0",
    });
    e.addText("A study in color, texture and quiet moments.", 110, 850, {
      fontFamily: "Georgia",
      fontSize: 25,
      color: "#d8dfd5",
    });
    e.doc.dirty = true;
    e.color = "#7dd3c1";
    e.touch();
    act("fit");
  };
  const renderLayers = (layers: Layer[], depth = 0): React.ReactNode =>
    [...layers].reverse().map((layer) => (
      <div key={layer.id}>
        <div
          className={
            "layer-row " + (e.doc.activeId === layer.id ? "selected" : "")
          }
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => e.selectLayer(layer.id)}
          onDoubleClick={() => {
            const name = window.prompt("图层名称", layer.name);
            if (name) e.updateLayer({ name }, "重命名图层");
          }}
        >
          <button
            className="eye"
            title={layer.visible ? "隐藏图层" : "显示图层"}
            onClick={(ev) => {
              ev.stopPropagation();
              e.selectLayer(layer.id);
              e.updateLayer({ visible: !layer.visible }, "切换可见性");
            }}
          >
            {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          <Thumbnail layer={layer} />
          <span className="layer-name">
            {layer.name}
            <small>
              {layer.type === "text"
                ? "文字"
                : layer.type === "shape"
                  ? "形状"
                  : layer.type === "group"
                    ? "图层组"
                    : layer.type === "adjustment"
                      ? "调整图层"
                      : "像素图层"}
            </small>
          </span>
          {layer.mask && (
            <button
              className={
                "mask-chip " +
                (e.doc.activeId === layer.id && e.editMask ? "chosen" : "")
              }
              title="编辑图层蒙版"
              onClick={(ev) => {
                ev.stopPropagation();
                e.selectLayer(layer.id);
                e.editMask = true;
                e.touch();
              }}
            >
              ◐
            </button>
          )}
          {layer.locked ? (
            <Lock size={12} />
          ) : layer.type === "group" ? (
            <Folder size={13} />
          ) : null}
        </div>
        {layer.children && renderLayers(layer.children, depth + 1)}
      </div>
    ));
  return (
    <div className="application" onClick={() => menu && setMenu(null)}>
      <input
        ref={fileInput}
        type="file"
        className="hidden"
        multiple
        accept="image/*,.psd,.psb,.cwdoc,.zip"
        onChange={async (ev) => {
          for (const file of ev.target.files || [])
            safe(async () =>
              e.load({
                name: file.name,
                bytes: new Uint8Array(await file.arrayBuffer()),
              }),
            );
          ev.target.value = "";
        }}
      />
      <header className="topbar">
        <div className="brand">
          <Layers size={22} />
          <strong>Compositor</strong>
          <span>WINDOWS</span>
        </div>
        <nav>
          {Object.keys(menus).map((name) => (
            <div className="menu-host" key={name}>
              <button
                className={menu === name ? "open" : ""}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setMenu(menu === name ? null : name);
                }}
              >
                {name}
              </button>
              {menu === name && (
                <div
                  className="dropdown"
                  onClick={(ev) => ev.stopPropagation()}
                >
                  {menus[name].map(([action, label, key]) => (
                    <button
                      key={action}
                      onClick={() => {
                        if (action.startsWith("filter:")) {
                          const f = filterList.find(
                            (x) => x[0] === action.slice(7),
                          )!;
                          setFilterKind(f[0]);
                          setFilterAmount(f[2]);
                          setModal("filter");
                          setMenu(null);
                        } else act(action);
                      }}
                    >
                      <span>{label}</span>
                      <kbd>{key}</kbd>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="header-actions">
          <button className="ai-pill" onClick={() => setPanel("ai")}>
            <span className="status-dot" />
            {window.desktop ? "AI 接口就绪" : "浏览器预览"}
          </button>
          <button className="save-button" onClick={() => act("save")}>
            <Save size={14} />
            保存工程
          </button>
          <button className="primary" onClick={() => setModal("export")}>
            <Download size={14} />
            导出
          </button>
        </div>
      </header>
      <div className="optionsbar">
        <span className="current-tool">{toolNames[e.tool]}</span>
        <div className="divider" />
        {["brush", "eraser", "clone", "heal", "blur"].includes(e.tool) ? (
          <>
            <NumberField
              label="大小"
              value={e.brushSize}
              min={1}
              max={500}
              onChange={(n) => {
                e.brushSize = Math.max(1, Math.min(500, n));
                e.touch();
              }}
            />
            <label>
              硬度{" "}
              <input
                type="range"
                min={0}
                max={100}
                value={e.hardness * 100}
                onChange={(ev) => {
                  e.hardness = +ev.target.value / 100;
                  e.touch();
                }}
              />
            </label>
            <NumberField
              label="不透明度 %"
              value={e.brushOpacity * 100}
              min={1}
              max={100}
              onChange={(n) => {
                e.brushOpacity = Math.max(0.01, Math.min(1, n / 100));
                e.touch();
              }}
            />
            {e.editMask && <span className="accent-text">正在编辑蒙版</span>}
          </>
        ) : ["rect-select", "ellipse-select", "lasso", "wand"].includes(
            e.tool,
          ) ? (
          <>
            <label>
              选区模式{" "}
              <select
                value={e.selectionMode}
                onChange={(ev) => {
                  e.selectionMode = ev.target.value as typeof e.selectionMode;
                  e.touch();
                }}
              >
                <option value="replace">新选区</option>
                <option value="add">添加</option>
                <option value="subtract">减去</option>
                <option value="intersect">交集</option>
              </select>
            </label>
            <NumberField
              label="容差"
              value={e.tolerance}
              min={0}
              max={255}
              onChange={(n) => {
                e.tolerance = n;
                e.touch();
              }}
            />
            <button onClick={() => act("deselect")}>取消选择</button>
          </>
        ) : e.tool === "text" ? (
          <>
            <select
              value={e.fontFamily}
              onChange={(ev) => {
                e.fontFamily = ev.target.value;
                e.touch();
              }}
            >
              {[
                "Microsoft YaHei",
                "Arial",
                "Georgia",
                "Times New Roman",
                "SimHei",
                "SimSun",
                "Segoe UI",
              ].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
            <NumberField
              label="字号"
              value={e.fontSize}
              onChange={(n) => {
                e.fontSize = Math.max(1, n);
                e.touch();
              }}
            />
            <span className="muted">点击画布添加文字</span>
          </>
        ) : ["rectangle", "ellipse", "line"].includes(e.tool) ? (
          <>
            <label>
              <input
                type="checkbox"
                checked={e.shapeFill}
                onChange={(ev) => {
                  e.shapeFill = ev.target.checked;
                  e.touch();
                }}
              />
              填充
            </label>
            <NumberField
              label="描边"
              value={e.shapeStroke}
              min={0}
              onChange={(n) => {
                e.shapeStroke = n;
                e.touch();
              }}
            />
          </>
        ) : (
          <>
            <label>
              <input
                type="checkbox"
                checked={e.snap}
                onChange={(ev) => {
                  e.snap = ev.target.checked;
                  e.touch();
                }}
              />
              吸附画布边缘与中心
            </label>
            <button onClick={() => act("fit")}>
              <Scan size={14} />
              适合窗口
            </button>
            <span className="muted">
              {e.tool === "crop"
                ? "拖动后松开以裁剪画布"
                : "图层保持可编辑 · 支持撤销"}
            </span>
          </>
        )}
        <div className="options-right">
          <IconButton
            icon={Undo2}
            label="撤销 (Ctrl+Z)"
            onClick={() => e.undo()}
            disabled={!e.history.length}
          />
          <IconButton
            icon={Redo2}
            label="重做 (Ctrl+Shift+Z)"
            onClick={() => e.redo()}
          />
        </div>
      </div>
      <main className="workspace">
        <aside className="toolbar">
          <div className="tools-grid">
            {toolList.map(([id, Icon, key]) => (
              <button
                key={id}
                aria-label={toolNames[id]}
                title={`${toolNames[id]} ${key}`}
                className={e.tool === id ? "selected" : ""}
                onClick={() => {
                  e.tool = id;
                  e.touch();
                }}
              >
                <Icon size={19} strokeWidth={1.65} />
              </button>
            ))}
          </div>
          <div className="tool-colors">
            <input
              title="前景色"
              aria-label="前景色"
              type="color"
              value={e.color}
              onChange={(ev) => {
                e.color = ev.target.value;
                e.touch();
              }}
            />
            <input
              title="背景色"
              type="color"
              value={e.background}
              onChange={(ev) => {
                e.background = ev.target.value;
                e.touch();
              }}
            />
          </div>
          <button
            className="swap"
            title="交换前景和背景 (X)"
            onClick={() => {
              [e.color, e.background] = [e.background, e.color];
              e.touch();
            }}
          >
            ⇄
          </button>
          <div className="toolbar-bottom">
            <IconButton
              icon={Sparkles}
              label="AI 操作"
              onClick={() => setPanel("ai")}
              active={panel === "ai"}
            />
            <IconButton
              icon={Search}
              label="快捷键"
              onClick={() => setModal("shortcuts")}
            />
          </div>
        </aside>
        <section className="center">
          <div className="document-tabs">
            {e.documents.map((d, i) => (
              <div
                className={"document-tab " + (i === e.index ? "selected" : "")}
                key={d.id}
                onClick={() => e.switchDocument(i)}
              >
                <span>
                  {d.name}
                  {d.dirty ? " ·" : ""}
                </span>
                <small>{Math.round(e.zoom * 100)}%</small>
                <button
                  title="关闭文档"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    safe(() => e.closeDocument(i));
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <IconButton
              icon={Plus}
              label="新建画布"
              onClick={() => setModal("new")}
            />
          </div>
          <Stage
            revision={revision}
            onText={(p) => {
              setTextPoint(p);
              setText("在这里写下你的文字");
              setModal("text");
            }}
          />
          {e.documents.length === 1 &&
            !e.doc.dirty &&
            e.doc.name === "未命名" && (
              <div className="welcome">
                <div className="welcome-icon">
                  <ImagePlus size={27} />
                </div>
                <h1>让想法，落在画布上。</h1>
                <p>拖入图片开始编辑，或让 Codex 帮你完成。</p>
                <div>
                  <button className="primary" onClick={() => act("open")}>
                    <FolderOpen size={15} />
                    打开图片
                  </button>
                  <button onClick={demo}>试用示例</button>
                </div>
                <span>PNG · JPEG · WebP · PSD · Compositor 工程</span>
              </div>
            )}
        </section>
        <aside className="right-panel">
          <div className="panel-tabs">
            {[
              ["properties", "属性"],
              ["adjustments", "调色"],
              ["effects", "效果"],
              ["ai", "AI"],
            ].map(([key, name]) => (
              <button
                className={panel === key ? "selected" : ""}
                key={key}
                onClick={() => setPanel(key)}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="inspector">
            <fieldset
              disabled={!!l && e.isLocked(l) && panel !== "ai"}
              className="inspector-fields"
            >
              {panel === "properties" &&
                (l ? (
                  <>
                    <div className="section-label">
                      变换{" "}
                      <span>
                        {l.type === "raster"
                          ? "像素图层"
                          : l.type === "text"
                            ? "可编辑文字"
                            : l.type === "shape"
                              ? "可编辑形状"
                              : "图层组"}
                      </span>
                    </div>
                    <div className="number-grid">
                      <NumberField
                        label="X"
                        value={l.x}
                        onChange={(n) => e.updateLayer({ x: n })}
                      />
                      <NumberField
                        label="Y"
                        value={l.y}
                        onChange={(n) => e.updateLayer({ y: n })}
                      />
                      <NumberField
                        label="宽"
                        value={l.width * Math.abs(l.scaleX)}
                        min={1}
                        onChange={(n) =>
                          e.updateLayer({ scaleX: Math.max(1, n) / l.width })
                        }
                      />
                      <NumberField
                        label="高"
                        value={l.height * Math.abs(l.scaleY)}
                        min={1}
                        onChange={(n) =>
                          e.updateLayer({ scaleY: Math.max(1, n) / l.height })
                        }
                      />
                      <NumberField
                        label="旋转 °"
                        value={l.rotation}
                        onChange={(n) => e.updateLayer({ rotation: n })}
                      />
                      <div className="inline-buttons">
                        <IconButton
                          icon={FlipHorizontal}
                          label="水平翻转"
                          onClick={() => e.updateLayer({ scaleX: -l.scaleX })}
                        />
                        <IconButton
                          icon={FlipVertical}
                          label="垂直翻转"
                          onClick={() => e.updateLayer({ scaleY: -l.scaleY })}
                        />
                      </div>
                    </div>
                    {l.text && (
                      <div className="text-settings">
                        <div className="section-label">文字内容</div>
                        <textarea
                          aria-label="文字内容"
                          value={l.text.content}
                          onChange={(ev) =>
                            safe(() =>
                              e.updateText({ content: ev.target.value }),
                            )
                          }
                        />
                        <div className="number-grid">
                          <NumberField
                            label="字号"
                            value={l.text.fontSize}
                            onChange={(n) =>
                              safe(() =>
                                e.updateText({ fontSize: Math.max(1, n) }),
                              )
                            }
                          />
                          <input
                            type="color"
                            aria-label="文字颜色"
                            value={l.text.color}
                            onChange={(ev) =>
                              safe(() =>
                                e.updateText({ color: ev.target.value }),
                              )
                            }
                          />
                        </div>
                        <select
                          value={l.text.fontFamily}
                          onChange={(ev) =>
                            safe(() =>
                              e.updateText({ fontFamily: ev.target.value }),
                            )
                          }
                        >
                          {[
                            "Microsoft YaHei",
                            "Arial",
                            "Georgia",
                            "Times New Roman",
                            "SimHei",
                            "SimSun",
                            "Segoe UI",
                          ].map((f) => (
                            <option key={f}>{f}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    {l.shape && (
                      <div className="number-grid">
                        <label>
                          填充{" "}
                          <input
                            type="color"
                            value={
                              l.shape.fill === "transparent"
                                ? "#ffffff"
                                : l.shape.fill
                            }
                            onChange={(ev) =>
                              e.run("形状颜色", () => {
                                l.shape!.fill = ev.target.value;
                              })
                            }
                          />
                        </label>
                        <NumberField
                          label="圆角"
                          value={l.shape.radius}
                          min={0}
                          onChange={(n) =>
                            e.run("圆角", () => {
                              l.shape!.radius = n;
                            })
                          }
                        />
                        <NumberField
                          label="描边"
                          value={l.shape.strokeWidth}
                          min={0}
                          onChange={(n) =>
                            e.run("描边", () => {
                              l.shape!.strokeWidth = n;
                            })
                          }
                        />
                      </div>
                    )}
                    <div className="section-label">图层蒙版</div>
                    <div className="button-row">
                      <button onClick={() => safe(() => e.addMask())}>
                        <CircleDashed size={14} />
                        {l.mask ? "重建蒙版" : "添加蒙版"}
                      </button>
                      {l.mask && (
                        <button
                          className={e.editMask ? "selected" : ""}
                          onClick={() => {
                            e.editMask = !e.editMask;
                            e.touch();
                          }}
                        >
                          {e.editMask ? "返回图像" : "编辑蒙版"}
                        </button>
                      )}
                    </div>
                    {l.mask && (
                      <div className="button-row">
                        <button onClick={() => e.invertMask()}>反相</button>
                        <button
                          onClick={() =>
                            e.updateLayer({ maskEnabled: !l.maskEnabled })
                          }
                        >
                          {l.maskEnabled ? "禁用" : "启用"}
                        </button>
                        <button
                          onClick={() => e.updateLayer({ mask: undefined })}
                        >
                          移除
                        </button>
                      </div>
                    )}
                    <button
                      className="wide subtle"
                      onClick={() => safe(() => e.removeBackground())}
                    >
                      <WandSparkles size={14} />
                      去除边缘纯色背景
                    </button>
                  </>
                ) : (
                  <p className="muted">选择图层以编辑属性。</p>
                ))}
              {panel === "adjustments" &&
                (l ? (
                  <>
                    <div className="section-label">
                      非破坏调色{" "}
                      <button
                        title="重置调色"
                        onClick={() =>
                          e.run("重置调色", () => {
                            l.adjustments = defaultAdjustments();
                          })
                        }
                      >
                        <RotateCcw size={13} />
                      </button>
                    </div>
                    {adjustmentControls.map(([key, name, min, max, step]) => (
                      <label className="adjustment" key={key}>
                        <span>
                          {name}
                          <output>
                            {Number((l.adjustments[key] as number).toFixed(2))}
                          </output>
                        </span>
                        <input
                          type="range"
                          min={min}
                          max={max}
                          step={step}
                          value={l.adjustments[key] as number}
                          onPointerDown={() => e.begin("调整 " + name)}
                          onChange={(ev) => {
                            (l.adjustments[key] as number) = +ev.target.value;
                            e.commit();
                          }}
                          onKeyDown={(ev) => {
                            if (ev.key.startsWith("Arrow"))
                              e.begin("调整 " + name);
                          }}
                        />
                      </label>
                    ))}
                    <div className="button-row">
                      <button
                        className={l.adjustments.grayscale ? "selected" : ""}
                        onClick={() =>
                          e.run("黑白", () => {
                            l.adjustments.grayscale = !l.adjustments.grayscale;
                          })
                        }
                      >
                        黑白
                      </button>
                      <button
                        className={l.adjustments.invert ? "selected" : ""}
                        onClick={() =>
                          e.run("反相", () => {
                            l.adjustments.invert = !l.adjustments.invert;
                          })
                        }
                      >
                        反相
                      </button>
                    </div>
                  </>
                ) : (
                  <p>请选择图层。</p>
                ))}
              {panel === "effects" &&
                (l ? (
                  <>
                    <div className="section-label">图层效果</div>
                    <label className="check-line">
                      <input
                        type="checkbox"
                        checked={l.effects.shadow}
                        onChange={(ev) =>
                          e.run("投影", () => {
                            l.effects.shadow = ev.target.checked;
                          })
                        }
                      />
                      投影
                    </label>
                    {l.effects.shadow && (
                      <div className="number-grid">
                        <NumberField
                          label="模糊"
                          value={l.effects.shadowBlur}
                          min={0}
                          onChange={(n) =>
                            e.run("投影模糊", () => {
                              l.effects.shadowBlur = n;
                            })
                          }
                        />
                        <NumberField
                          label="X"
                          value={l.effects.shadowX}
                          onChange={(n) =>
                            e.run("投影位移", () => {
                              l.effects.shadowX = n;
                            })
                          }
                        />
                        <NumberField
                          label="Y"
                          value={l.effects.shadowY}
                          onChange={(n) =>
                            e.run("投影位移", () => {
                              l.effects.shadowY = n;
                            })
                          }
                        />
                      </div>
                    )}
                    <label className="check-line">
                      <input
                        type="checkbox"
                        checked={l.effects.stroke}
                        onChange={(ev) =>
                          e.run("描边效果", () => {
                            l.effects.stroke = ev.target.checked;
                          })
                        }
                      />
                      描边
                    </label>
                    {l.effects.stroke && (
                      <div className="number-grid">
                        <NumberField
                          label="宽度"
                          value={l.effects.strokeWidth}
                          min={1}
                          onChange={(n) =>
                            e.run("描边宽度", () => {
                              l.effects.strokeWidth = n;
                            })
                          }
                        />
                        <input
                          type="color"
                          value={l.effects.strokeColor}
                          onChange={(ev) =>
                            e.run("描边颜色", () => {
                              l.effects.strokeColor = ev.target.value;
                            })
                          }
                        />
                      </div>
                    )}
                    <div className="section-label">像素滤镜</div>
                    <div className="filter-grid">
                      {filterList.map(([kind, name, amount]) => (
                        <button
                          key={kind}
                          onClick={() => {
                            setFilterKind(kind);
                            setFilterAmount(amount);
                            setModal("filter");
                          }}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <p>请选择图层。</p>
                ))}
              {panel === "ai" && (
                <div className="ai-panel">
                  <div className="ai-symbol">
                    <Sparkles size={20} />
                    <span>让 Codex 帮你编辑</span>
                  </div>
                  <p>
                    通过本地 MCP 接口，AI
                    可以查看画布、调整图层、修图并导出。所有图像处理都在本机完成。
                  </p>
                  <div className="ai-examples">
                    <span>“把照片调暖，稍微提亮阴影”</span>
                    <span>“裁成 4:5，右下角加上标题”</span>
                    <span>“去除白底，导出透明 PNG”</span>
                  </div>
                  <div className="section-label">
                    结构化命令 <Terminal size={13} />
                  </div>
                  <textarea
                    className="command-input"
                    aria-label="AI 命令 JSON"
                    spellCheck={false}
                    value={command}
                    onChange={(ev) => setCommand(ev.target.value)}
                  />
                  <button
                    className="primary wide"
                    onClick={() =>
                      safe(async () => {
                        const req = JSON.parse(command);
                        await e.automate(req.action, req.args || {});
                        e.message("命令已执行，可通过 Ctrl+Z 撤销");
                      })
                    }
                  >
                    <Sparkles size={14} />
                    执行命令
                  </button>
                  <p className="tiny">
                    此处是命令调试框。自然语言修图请在连接 MCP 的 Codex 中提出。
                  </p>
                </div>
              )}
            </fieldset>
          </div>
          <div className="layer-panel">
            <div className="layer-heading">
              <div>
                <button
                  className={bottomPanel === "layers" ? "selected" : ""}
                  onClick={() => setBottomPanel("layers")}
                >
                  图层
                </button>
                <button
                  className={bottomPanel === "history" ? "selected" : ""}
                  onClick={() => setBottomPanel("history")}
                >
                  历史
                </button>
              </div>
              <span>{e.doc.layers.length} 层</span>
            </div>
            {bottomPanel === "layers" ? (
              <>
                <div className="layer-options">
                  <select
                    aria-label="混合模式"
                    value={
                      l?.blendMode === "normal"
                        ? "source-over"
                        : l?.blendMode || "source-over"
                    }
                    disabled={!l || e.isLocked(l)}
                    onChange={(ev) =>
                      e.updateLayer({ blendMode: ev.target.value }, "混合模式")
                    }
                  >
                    {blendModes.map(([key, name]) => (
                      <option key={key} value={key}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <NumberField
                    label="不透明度"
                    value={(l?.opacity ?? 1) * 100}
                    min={0}
                    max={100}
                    onChange={(n) =>
                      safe(() =>
                        e.updateLayer(
                          { opacity: Math.min(1, Math.max(0, n / 100)) },
                          "图层不透明度",
                        ),
                      )
                    }
                  />
                </div>
                <div className="layers-list">{renderLayers(e.doc.layers)}</div>
                <div className="layer-footer">
                  <IconButton
                    icon={Plus}
                    label="新建图层"
                    onClick={() => e.addLayer()}
                  />
                  <IconButton
                    icon={Folder}
                    label="编组"
                    onClick={() => safe(() => e.group())}
                  />
                  <IconButton
                    icon={CircleDashed}
                    label="添加蒙版"
                    onClick={() => safe(() => e.addMask())}
                  />
                  <IconButton
                    icon={l?.locked ? Unlock : Lock}
                    label={l?.locked ? "解锁图层" : "锁定图层"}
                    onClick={() => l && e.updateLayer({ locked: !l.locked })}
                  />
                  <IconButton
                    icon={ArrowUp}
                    label="上移图层"
                    onClick={() => safe(() => l && e.reorder(l.id, 1))}
                  />
                  <IconButton
                    icon={ArrowDown}
                    label="下移图层"
                    onClick={() => safe(() => l && e.reorder(l.id, -1))}
                  />
                  <IconButton
                    icon={Trash2}
                    label="删除图层"
                    onClick={() => safe(() => e.deleteLayer())}
                  />
                </div>
              </>
            ) : (
              <div className="history-list">
                <p className="tiny">历史按内存预算保留，点击撤销可逐步回退。</p>
                {[...e.history].reverse().map((name, i) => (
                  <div key={i}>
                    <History size={13} />
                    {name}
                  </div>
                ))}
                <button className="wide" onClick={() => e.undo()}>
                  <Undo2 size={14} />
                  撤销上一步
                </button>
              </div>
            )}
          </div>
        </aside>
      </main>
      <footer className="statusbar">
        <span>
          <span className="status-dot" />{" "}
          {e.busy ? "正在处理…" : e.notice || "就绪 · 文件保存在本机"}
        </span>
        <div>
          <span>
            {e.doc.width} × {e.doc.height} px
          </span>
          <span>RGB / 8 位</span>
          <button onClick={() => act("zoom-out")}>
            <Minus size={12} />
          </button>
          <button onClick={() => act("fit")}>
            {Math.round(e.zoom * 100)}%
          </button>
          <button onClick={() => act("zoom-in")}>
            <Plus size={12} />
          </button>
        </div>
      </footer>
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <section
            className={"modal " + (modal === "about" ? "large" : "")}
            role="dialog"
            aria-modal="true"
            aria-label={modal}
            onClick={(ev) => ev.stopPropagation()}
          >
            <button
              className="modal-close"
              aria-label="关闭"
              onClick={() => setModal(null)}
            >
              <X size={18} />
            </button>
            {(modal === "new" ||
              modal === "image-size" ||
              modal === "canvas-size") && (
              <>
                <h2>
                  {modal === "new"
                    ? "新建画布"
                    : modal === "image-size"
                      ? "图像大小"
                      : "画布大小"}
                </h2>
                <p className="muted">创建你的下一张作品。</p>
                {modal === "new" && (
                  <label className="form-field">
                    名称
                    <input
                      value={newName}
                      onChange={(ev) => setNewName(ev.target.value)}
                    />
                  </label>
                )}
                <div className="number-grid">
                  <NumberField
                    label="宽度"
                    value={newWidth}
                    min={1}
                    max={16384}
                    onChange={setNewWidth}
                  />
                  <NumberField
                    label="高度"
                    value={newHeight}
                    min={1}
                    max={16384}
                    onChange={setNewHeight}
                  />
                </div>
                {modal === "new" && (
                  <>
                    <div className="presets">
                      {[
                        ["横版", 1600, 1000],
                        ["正方形", 1080, 1080],
                        ["竖版", 1080, 1350],
                        ["故事", 1080, 1920],
                      ].map(([name, w, h]) => (
                        <button
                          key={name}
                          onClick={() => {
                            setNewWidth(Number(w));
                            setNewHeight(Number(h));
                          }}
                        >
                          {name}
                          <small>
                            {w} × {h}
                          </small>
                        </button>
                      ))}
                    </div>
                    <label className="form-field">
                      背景
                      <select
                        value={newBg}
                        onChange={(ev) => setNewBg(ev.target.value)}
                      >
                        <option value="transparent">透明</option>
                        <option value="#ffffff">白色</option>
                        <option value="#15191d">深色</option>
                      </select>
                    </label>
                  </>
                )}
                <button
                  className="primary wide"
                  onClick={() =>
                    safe(() => {
                      if (modal === "new")
                        e.newDocument(newName, newWidth, newHeight, newBg);
                      else
                        e.resize(newWidth, newHeight, modal === "image-size");
                      setModal(null);
                      act("fit");
                    })
                  }
                >
                  {modal === "new" ? "创建画布" : "应用"}
                </button>
              </>
            )}
            {modal === "text" && (
              <>
                <h2>添加文字</h2>
                <textarea
                  className="text-entry"
                  autoFocus
                  value={text}
                  onChange={(ev) => setText(ev.target.value)}
                />
                <NumberField
                  label="字号"
                  value={e.fontSize}
                  min={1}
                  max={1000}
                  onChange={(n) => {
                    e.fontSize = n;
                    e.touch();
                  }}
                />
                <button
                  className="primary wide"
                  onClick={() => {
                    e.addText(text, textPoint.x, textPoint.y);
                    setModal(null);
                  }}
                >
                  添加到画布
                </button>
              </>
            )}
            {modal === "filter" && (
              <>
                <h2>
                  {filterList.find((f) => f[0] === filterKind)?.[1] || "滤镜"}
                </h2>
                <p className="muted">
                  应用到当前像素图层{e.selection ? "的选区" : ""}，支持撤销。
                </p>
                <NumberField
                  label="强度"
                  value={filterAmount}
                  min={0}
                  max={100}
                  onChange={setFilterAmount}
                />
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={filterAmount}
                  onChange={(ev) => setFilterAmount(+ev.target.value)}
                />
                <button
                  className="primary wide"
                  onClick={() =>
                    safe(() => {
                      e.filter(filterKind, filterAmount);
                      setModal(null);
                    })
                  }
                >
                  应用滤镜
                </button>
              </>
            )}
            {modal === "export" && (
              <>
                <h2>导出作品</h2>
                <p className="muted">
                  {e.doc.width} × {e.doc.height} 像素
                </p>
                {[
                  ["png", "PNG", "无损图像，保留透明背景"],
                  ["jpeg", "JPEG", "适合照片，透明区域填白"],
                  ["psd", "PSD", "分层像素文件，文字与效果栅格化"],
                  ["comp", "Compositor .comp", "原版兼容工程，部分属性会烘焙"],
                ].map(([format, name, desc]) => (
                  <button
                    className="export-option"
                    key={format}
                    onClick={() =>
                      safe(async () => {
                        await e.export(format);
                        setModal(null);
                      })
                    }
                  >
                    <strong>{name}</strong>
                    <span>{desc}</span>
                    <Download size={17} />
                  </button>
                ))}
                <p className="tiny">
                  需要继续编辑文字、形状和调整时，请使用“保存工程”保存 .cwdoc。
                </p>
              </>
            )}
            {modal === "shortcuts" && (
              <>
                <h2>键盘快捷键</h2>
                <div className="shortcut-grid">
                  {[
                    ["打开", "Ctrl O"],
                    ["保存工程", "Ctrl S"],
                    ["撤销 / 重做", "Ctrl Z / Ctrl Shift Z"],
                    ["复制图层", "Ctrl J"],
                    ["自由变换", "Ctrl T"],
                    ["适合画布", "Ctrl 0"],
                    ["选择 / 取消选择", "Ctrl A / Ctrl D"],
                    ["画笔 / 橡皮擦", "B / E"],
                    ["文字 / 移动", "T / V"],
                    ["画笔大小", "[ / ]"],
                    ["仿制源点", "Alt + 点击"],
                    ["平移 / 缩放", "空格拖动 / Ctrl 滚轮"],
                  ].map(([a, b]) => (
                    <div key={a}>
                      <span>{a}</span>
                      <kbd>{b}</kbd>
                    </div>
                  ))}
                </div>
              </>
            )}
            {modal === "about" && (
              <>
                <h2>
                  Compositor Windows <small>0.1.0</small>
                </h2>
                <p>
                  受 Robbie Tilton / Wonder Assembly 的开源 Compositor
                  启发而重写的独立 Windows 版本。MIT 开源；非官方移植，非 Adobe
                  产品。
                </p>
                <p>
                  已实现图层、蒙版、剪贴、混合模式、变换、文字、形状、选区、画笔、仿制、调色、滤镜、PSD
                  / 工程读写，以及供 Codex 使用的本地 MCP 接口。
                </p>
                <p>
                  当前使用 8 位 RGB。原版的 Camera RAW、AI
                  主体分割、内容感知填充、液化、16/32 位工作流、ICC
                  印刷色彩及复杂 PSD
                  对象尚未完整移植。纯色背景去除基于颜色选区，不是语义抠图。
                </p>
                <p>
                  图像处理不需要云服务。使用 Codex 查看图片时，画布预览会作为 AI
                  工具结果交给 Codex。
                </p>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

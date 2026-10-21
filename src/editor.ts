import type {
  EditorDocument,
  Layer,
  Tool,
  Point,
  NativeFile,
  Adjustments,
  Rect,
} from "./types";
import {
  createCanvas,
  cloneCanvas,
  makeDocument,
  makeLayer,
  cloneDocument,
  cloneLayer,
  findLayer,
  flattenLayers,
  removeLayer,
  renderDocument,
  renderLayer,
  sourceCanvas,
  layerMatrix,
  layerBounds,
  applyFilter,
  floodMask,
  selectionBounds,
  combineMasks,
  featherMask,
  defaultAdjustments,
} from "./engine";
import {
  importFile,
  encodeProject,
  exportPSD,
  exportComp,
  importComp,
} from "./io";

type HistoryEntry = { label: string; doc: EditorDocument };
type TransactionSnapshot = {
  index: number;
  doc: EditorDocument;
  past: HistoryEntry[];
  future: HistoryEntry[];
  selection: HTMLCanvasElement | null;
  editMask: boolean;
  clonePoint: Point | null;
  tolerance: number;
  lastFilter: { kind: string; amount: number } | null;
  color: string;
  background: string;
};
export const toolNames: Record<Tool, string> = {
  move: "移动",
  transform: "自由变换",
  "rect-select": "矩形选框",
  "ellipse-select": "椭圆选框",
  lasso: "套索",
  wand: "魔棒",
  crop: "裁剪",
  brush: "画笔",
  eraser: "橡皮擦",
  clone: "仿制图章",
  heal: "局部修补",
  blur: "模糊画笔",
  fill: "油漆桶",
  gradient: "渐变",
  text: "文字",
  rectangle: "矩形",
  ellipse: "椭圆",
  line: "直线",
  eyedropper: "吸管",
  hand: "抓手",
  zoom: "缩放",
};
export const blendModes = [
  ["source-over", "正常"],
  ["dissolve", "溶解"],
  ["multiply", "正片叠底"],
  ["screen", "滤色"],
  ["overlay", "叠加"],
  ["darken", "变暗"],
  ["lighten", "变亮"],
  ["color-dodge", "颜色减淡"],
  ["color-burn", "颜色加深"],
  ["hard-light", "强光"],
  ["soft-light", "柔光"],
  ["difference", "差值"],
  ["exclusion", "排除"],
  ["hue", "色相"],
  ["saturation", "饱和度"],
  ["color", "颜色"],
  ["luminosity", "明度"],
  ["linear-burn", "线性加深"],
  ["linear-dodge", "线性减淡"],
  ["vivid-light", "亮光"],
  ["linear-light", "线性光"],
  ["pin-light", "点光"],
  ["hard-mix", "实色混合"],
  ["subtract", "减去"],
  ["divide", "划分"],
  ["darker-color", "深色"],
  ["lighter-color", "浅色"],
];
export class Editor {
  documents: EditorDocument[] = [];
  index = 0;
  tool: Tool = "move";
  color = "#7dd3c1";
  background = "#ffffff";
  brushSize = 32;
  hardness = 0.8;
  brushOpacity = 1;
  tolerance = 32;
  fontSize = 72;
  fontFamily = "Microsoft YaHei";
  shapeFill = true;
  shapeStroke = 0;
  zoom = 0.65;
  pan = { x: 0, y: 0 };
  grid = false;
  rulers = true;
  snap = true;
  selection: HTMLCanvasElement | null = null;
  selectionMode: "replace" | "add" | "subtract" | "intersect" = "replace";
  editMask = false;
  clonePoint: Point | null = null;
  notice = "";
  revision = 0;
  busy = false;
  lastFilter: { kind: string; amount: number } | null = null;
  private listeners = new Set<() => void>();
  private past = new Map<string, HistoryEntry[]>();
  private future = new Map<string, HistoryEntry[]>();
  private batching = false;
  private clipboard: Layer | null = null;
  constructor() {
    this.newDocument("未命名", 1280, 800);
    this.doc.dirty = false;
  }
  get doc() {
    return this.documents[this.index];
  }
  get layer() {
    return findLayer(this.doc.layers, this.doc.activeId);
  }
  get history() {
    return (this.past.get(this.doc.id) || []).map((h) => h.label);
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  touch = () => {
    if (this.batching) return;
    this.revision++;
    this.listeners.forEach((fn) => fn());
    window.desktop?.setDirty(this.documents.some((d) => d.dirty));
  };
  message(text: string) {
    this.notice = text;
    this.touch();
  }
  resetEditingState() {
    this.selection = null;
    this.editMask = false;
    this.clonePoint = null;
  }
  newDocument(
    name: string,
    width: number,
    height: number,
    background = "transparent",
  ) {
    this.validateSize(width, height);
    const doc = makeDocument(name, width, height);
    const canvas = createCanvas(width, height);
    if (background !== "transparent") {
      this.validateColor(background);
      const c = canvas.getContext("2d")!;
      c.fillStyle = background;
      c.fillRect(0, 0, width, height);
    }
    const l = makeLayer("背景", canvas);
    doc.layers.push(l);
    doc.activeId = l.id;
    this.documents.push(doc);
    this.index = this.documents.length - 1;
    this.resetEditingState();
    this.pan = { x: 0, y: 0 };
    this.touch();
    return doc;
  }
  validateSize(w: number, h: number) {
    if (
      !Number.isInteger(w) ||
      !Number.isInteger(h) ||
      w < 1 ||
      h < 1 ||
      w > 16384 ||
      h > 16384 ||
      w * h > 40_000_000
    )
      throw Error("画布需为 1–16384 像素，总像素不超过 4000 万。");
  }
  switchDocument(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= this.documents.length)
      throw Error("文档不存在");
    this.index = index;
    this.resetEditingState();
    this.touch();
  }
  async closeDocument(index: number) {
    const d = this.documents[index];
    if (!d) throw Error("文档不存在");
    if (d.dirty && !(await this.confirm("此文档有未保存的修改，确定关闭吗？")))
      return;
    const actual = this.documents.indexOf(d);
    if (actual < 0) return;
    this.documents.splice(actual, 1);
    this.past.delete(d.id);
    this.future.delete(d.id);
    if (actual < this.index) this.index--;
    if (!this.documents.length) this.newDocument("未命名", 1280, 800);
    this.index = Math.min(this.index, this.documents.length - 1);
    this.resetEditingState();
    this.touch();
  }
  async confirm(text: string) {
    return window.confirm(text);
  }
  begin(label: string, before?: EditorDocument) {
    if (this.batching) return;
    const h = this.past.get(this.doc.id) || [];
    h.push({ label, doc: before || cloneDocument(this.doc) });
    let bytes = h.reduce(
      (n, e) =>
        n +
        flattenLayers(e.doc.layers).reduce(
          (s, l) => s + l.width * l.height * 4 * (l.mask ? 2 : 1),
          0,
        ),
      0,
    );
    while (h.length > 1 && (h.length > 40 || bytes > 192 * 1024 * 1024)) {
      const old = h.shift()!;
      bytes -= flattenLayers(old.doc.layers).reduce(
        (s, l) => s + l.width * l.height * 4 * (l.mask ? 2 : 1),
        0,
      );
    }
    this.past.set(this.doc.id, h);
    this.future.set(this.doc.id, []);
  }
  commit() {
    this.doc.dirty = true;
    this.touch();
  }
  private snapshot(): TransactionSnapshot {
    return {
      index: this.index,
      doc: cloneDocument(this.doc),
      past: [...(this.past.get(this.doc.id) || [])],
      future: [...(this.future.get(this.doc.id) || [])],
      selection: this.selection ? cloneCanvas(this.selection) : null,
      editMask: this.editMask,
      clonePoint: this.clonePoint ? { ...this.clonePoint } : null,
      tolerance: this.tolerance,
      lastFilter: this.lastFilter ? { ...this.lastFilter } : null,
      color: this.color,
      background: this.background,
    };
  }
  private restore(s: TransactionSnapshot) {
    this.index = s.index;
    this.documents[s.index] = s.doc;
    this.past.set(s.doc.id, s.past);
    this.future.set(s.doc.id, s.future);
    this.selection = s.selection;
    this.editMask = s.editMask;
    this.clonePoint = s.clonePoint;
    this.tolerance = s.tolerance;
    this.lastFilter = s.lastFilter;
    this.color = s.color;
    this.background = s.background;
  }
  run(label: string, fn: () => void) {
    if (this.batching) {
      fn();
      this.doc.dirty = true;
      return;
    }
    const before = this.snapshot();
    this.begin(label, before.doc);
    try {
      fn();
      this.commit();
    } catch (error) {
      this.restore(before);
      this.touch();
      throw error;
    }
  }
  undo() {
    const h = this.past.get(this.doc.id);
    if (!h?.length) return;
    const e = h.pop()!;
    const f = this.future.get(this.doc.id) || [];
    f.push({ label: e.label, doc: cloneDocument(this.doc) });
    this.future.set(this.doc.id, f);
    this.documents[this.index] = e.doc;
    this.doc.dirty = true;
    this.resetEditingState();
    this.touch();
  }
  redo() {
    const f = this.future.get(this.doc.id);
    if (!f?.length) return;
    const e = f.pop()!;
    const h = this.past.get(this.doc.id) || [];
    h.push({ label: e.label, doc: cloneDocument(this.doc) });
    this.past.set(this.doc.id, h);
    this.documents[this.index] = e.doc;
    this.doc.dirty = true;
    this.resetEditingState();
    this.touch();
  }
  isLocked(layer: Layer) {
    const search = (
      layers: Layer[],
      inherited = false,
    ): boolean | undefined => {
      for (const item of layers) {
        const locked = inherited || item.locked;
        if (item.id === layer.id) return locked;
        if (item.children) {
          const result = search(item.children, locked);
          if (result !== undefined) return result;
        }
      }
    };
    return search(this.doc.layers) ?? layer.locked;
  }
  requireLayer(allowLocked = false) {
    const layer = this.layer;
    if (!layer) throw Error("请先选择一个图层");
    if (!allowLocked && this.isLocked(layer)) throw Error("图层已锁定");
    return layer;
  }
  validateColor(color: string) {
    if (!CSS.supports("color", color)) throw Error("颜色值无效");
  }
  private validateTransform(layer: Layer) {
    for (const k of ["x", "y", "scaleX", "scaleY", "rotation"] as const)
      if (!Number.isFinite(layer[k])) throw Error("变换值必须为有限数字");
    if (
      Math.abs(layer.x) > 1_000_000 ||
      Math.abs(layer.y) > 1_000_000 ||
      Math.abs(layer.rotation) > 360_000
    )
      throw Error("变换超出允许范围");
    if (
      Math.abs(layer.scaleX) < 0.0001 ||
      Math.abs(layer.scaleY) < 0.0001 ||
      Math.abs(layer.scaleX) > 1000 ||
      Math.abs(layer.scaleY) > 1000 ||
      Math.abs(layer.width * layer.scaleX) > 65536 ||
      Math.abs(layer.height * layer.scaleY) > 65536
    )
      throw Error("图层缩放超出允许范围");
  }
  private reId(layer: Layer) {
    layer.id = crypto.randomUUID();
    layer.children?.forEach((child) => this.reId(child));
  }
  selectLayer(id: string) {
    if (!findLayer(this.doc.layers, id)) throw Error("找不到图层");
    this.doc.activeId = id;
    this.editMask = false;
    this.touch();
  }
  addLayer(layer?: Layer) {
    const l =
      layer ||
      makeLayer(
        `图层 ${flattenLayers(this.doc.layers).length + 1}`,
        createCanvas(this.doc.width, this.doc.height),
      );
    this.validateSize(l.width, l.height);
    this.validateTransform(l);
    this.run("新建图层", () => {
      this.doc.layers.push(l);
      this.doc.activeId = l.id;
      this.editMask = false;
    });
    return l;
  }
  duplicate() {
    const l = cloneLayer(this.requireLayer(true));
    this.reId(l);
    l.name += " 副本";
    this.run("复制图层", () => {
      this.doc.layers.push(l);
      this.doc.activeId = l.id;
      this.editMask = false;
    });
  }
  deleteLayer() {
    const l = this.requireLayer();
    this.run("删除图层", () => {
      removeLayer(this.doc.layers, l.id);
      this.doc.activeId = this.doc.layers.at(-1)?.id || "";
      this.editMask = false;
    });
  }
  updateLayer(patch: Partial<Layer>, label = "修改图层") {
    const l = this.requireLayer(true);
    if (
      this.isLocked(l) &&
      Object.keys(patch).some((k) => !["locked", "visible", "name"].includes(k))
    )
      throw Error("图层已锁定");
    const updated = { ...l, ...patch };
    this.validateTransform(updated);
    if (
      !Number.isFinite(updated.opacity) ||
      updated.opacity < 0 ||
      updated.opacity > 1
    )
      throw Error("不透明度需在0到1之间");
    if (
      !["normal", ...blendModes.map(([mode]) => mode)].includes(
        updated.blendMode,
      )
    )
      throw Error("不支持的混合模式：" + updated.blendMode);
    this.run(label, () => {
      Object.assign(l, patch);
      if (!l.mask) this.editMask = false;
    });
  }
  reorder(id: string, delta: number) {
    const layer = findLayer(this.doc.layers, id);
    if (!layer) throw Error("图层不存在");
    if (this.isLocked(layer)) throw Error("图层已锁定");
    if (!Number.isInteger(delta)) throw Error("图层顺序偏移必须为整数");
    const search = (ls: Layer[]): boolean => {
      const i = ls.findIndex((l) => l.id === id);
      if (i >= 0) {
        const j = Math.max(0, Math.min(ls.length - 1, i + delta));
        [ls[i], ls[j]] = [ls[j], ls[i]];
        return true;
      }
      return ls.some((l) => l.children && search(l.children));
    };
    this.run("调整图层顺序", () => search(this.doc.layers));
  }
  group() {
    const l = this.requireLayer();
    this.run("编组", () => {
      const g = makeLayer(
        "图层组",
        createCanvas(this.doc.width, this.doc.height),
        "group",
      );
      g.blendMode = l.blendMode;
      g.clip = l.clip;
      l.blendMode = "normal";
      l.clip = false;
      g.children = [l];
      const replace = (ls: Layer[]): boolean => {
        const i = ls.indexOf(l);
        if (i >= 0) {
          ls[i] = g;
          return true;
        }
        return ls.some((n) => n.children && replace(n.children));
      };
      replace(this.doc.layers);
      this.doc.activeId = g.id;
      this.editMask = false;
    });
  }
  ungroup() {
    const l = this.requireLayer();
    if (l.type !== "group") throw Error("请选择图层组");
    const defaults = defaultAdjustments();
    if (
      l.x ||
      l.y ||
      l.rotation ||
      l.scaleX !== 1 ||
      l.scaleY !== 1 ||
      l.opacity !== 1 ||
      l.mask ||
      !l.visible ||
      l.clip ||
      !["normal", "source-over"].includes(l.blendMode) ||
      l.effects.shadow ||
      l.effects.stroke ||
      Object.keys(defaults).some(
        (k) =>
          l.adjustments[k as keyof Adjustments] !==
          defaults[k as keyof Adjustments],
      )
    )
      throw Error("带变换、调色、混合或效果的组请先栅格化，避免改变合成结果。");
    const i = this.doc.layers.indexOf(l);
    if (i < 0) throw Error("请先选择顶层组");
    this.run("取消编组", () => {
      this.doc.layers.splice(i, 1, ...(l.children || []));
      this.doc.activeId = l.children?.at(-1)?.id || "";
      this.editMask = false;
    });
  }
  rasterize(layer = this.layer) {
    if (!layer) throw Error("请选择图层");
    if (this.isLocked(layer)) throw Error("图层已锁定");
    if (layer.type === "adjustment")
      throw Error("调整图层依赖下方内容，请使用合并可见图层");
    const bounds = layerBounds(layer),
      scale = Math.max(Math.abs(layer.scaleX), Math.abs(layer.scaleY));
    const padding = Math.ceil(
      ((layer.effects.shadow
        ? layer.effects.shadowBlur * 3 +
          Math.abs(layer.effects.shadowX) +
          Math.abs(layer.effects.shadowY)
        : 0) +
        (layer.effects.stroke ? layer.effects.strokeWidth : 0)) *
        scale,
    );
    const x = Math.floor(bounds.x - padding),
      y = Math.floor(bounds.y - padding),
      width = Math.max(1, Math.ceil(bounds.x + bounds.width + padding) - x),
      height = Math.max(1, Math.ceil(bounds.y + bounds.height + padding) - y);
    this.validateSize(width, height);
    const c = renderLayer(
      { ...layer, visible: true, x: layer.x - x, y: layer.y - y },
      width,
      height,
    );
    const original = {
      id: layer.id,
      name: layer.name,
      x,
      y,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      visible: layer.visible,
      locked: layer.locked,
      clip: layer.clip,
    };
    Object.assign(layer, makeLayer(layer.name, c), original);
    delete layer.children;
    delete layer.text;
    delete layer.shape;
    delete layer.mask;
    this.editMask = false;
  }
  mergeDown() {
    const id = this.doc.activeId;
    const i = this.doc.layers.findIndex((l) => l.id === id);
    if (i < 1) throw Error("请选择有下方图层的顶层图层");
    const pairLayers = this.doc.layers.slice(i - 1, i + 1);
    if (pairLayers.some((l) => this.isLocked(l))) throw Error("图层已锁定");
    if (
      pairLayers.some(
        (l) =>
          !l.visible ||
          l.clip ||
          !["normal", "source-over"].includes(l.blendMode),
      )
    )
      throw Error(
        "含隐藏、剪贴或特殊混合模式的图层请使用合并可见图层，以保留合成外观",
      );
    this.run("向下合并", () => {
      const pair = { ...this.doc, layers: pairLayers };
      const l = makeLayer(this.doc.layers[i].name, renderDocument(pair));
      this.doc.layers.splice(i - 1, 2, l);
      this.doc.activeId = l.id;
      this.editMask = false;
    });
  }
  flatten() {
    if (!this.doc.layers.some((l) => l.visible)) throw Error("没有可见图层");
    if (
      flattenLayers(this.doc.layers).some((l) => l.visible && this.isLocked(l))
    )
      throw Error("图层已锁定");
    if (
      this.doc.layers.some(
        (l) =>
          l.visible &&
          l.children &&
          flattenLayers(l.children).some((child) => !child.visible),
      )
    )
      throw Error("组内有隐藏图层，请先将其移出可见组，以免合并时丢失内容");
    this.run("合并可见图层", () => {
      const l = makeLayer("合并图层", renderDocument(this.doc));
      this.doc.layers = [
        ...this.doc.layers.filter((layer) => !layer.visible),
        l,
      ];
      this.doc.activeId = l.id;
      this.editMask = false;
    });
  }
  addMask() {
    const l = this.requireLayer();
    this.validateSize(l.width, l.height);
    this.run("添加蒙版", () => {
      const mask = createCanvas(l.width, l.height);
      const c = mask.getContext("2d")!;
      if (this.selection) {
        const inv = layerMatrix(l).inverse();
        c.setTransform(inv);
        c.drawImage(this.selection, 0, 0);
      } else {
        c.fillStyle = "white";
        c.fillRect(0, 0, l.width, l.height);
      }
      l.mask = mask;
      l.maskEnabled = true;
      this.editMask = true;
    });
  }
  invertMask() {
    const l = this.requireLayer();
    if (!l.mask) throw Error("图层没有蒙版");
    this.run("反相蒙版", () => {
      const c = l.mask!.getContext("2d")!;
      const p = c.getImageData(0, 0, l.mask!.width, l.mask!.height);
      for (let i = 0; i < p.data.length; i += 4) {
        p.data[i] = p.data[i + 1] = p.data[i + 2] = 255;
        p.data[i + 3] = 255 - p.data[i + 3];
      }
      c.putImageData(p, 0, 0);
    });
  }
  selectRect(rect: Rect, ellipse = false) {
    if (
      Object.values(rect).some((v) => !Number.isFinite(v)) ||
      rect.width <= 0 ||
      rect.height <= 0
    )
      throw Error("选区尺寸必须是正数，坐标必须为有限数字");
    const c = createCanvas(this.doc.width, this.doc.height),
      ctx = c.getContext("2d")!;
    ctx.fillStyle = "white";
    if (ellipse) {
      ctx.beginPath();
      ctx.ellipse(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        rect.width / 2,
        rect.height / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    } else ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    this.setSelection(c);
  }
  setSelection(mask: HTMLCanvasElement | null) {
    this.selection = mask
      ? combineMasks(this.selection, mask, this.selectionMode)
      : null;
    this.touch();
  }
  invertSelection() {
    const c = createCanvas(this.doc.width, this.doc.height),
      ctx = c.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, c.width, c.height);
    if (this.selection) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(this.selection, 0, 0);
    }
    this.selection = c;
    this.touch();
  }
  magic(point: Point) {
    const merged = renderDocument(this.doc);
    this.setSelection(
      floodMask(
        merged,
        Math.floor(point.x),
        Math.floor(point.y),
        this.tolerance,
        true,
      ),
    );
  }
  localSelection(l: Layer) {
    if (!this.selection) return null;
    const c = createCanvas(l.width, l.height);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(layerMatrix(l).inverse());
    ctx.drawImage(this.selection, 0, 0);
    return c;
  }
  editableCanvas() {
    const l = this.requireLayer();
    if (this.editMask) {
      if (!l.mask) throw Error("当前图层没有可编辑蒙版");
      return l.mask;
    }
    if (l.type !== "raster" || !l.canvas)
      throw Error("请先将文字、形状或组栅格化，再进行像素编辑");
    return l.canvas;
  }
  applyPixels(effect: HTMLCanvasElement, erase = false) {
    const l = this.layer!;
    const target = this.editableCanvas();
    const selection = this.localSelection(l);
    if (selection) {
      const c = effect.getContext("2d")!;
      c.globalCompositeOperation = "destination-in";
      c.drawImage(selection, 0, 0);
      c.globalCompositeOperation = "source-over";
    }
    const ctx = target.getContext("2d")!;
    ctx.save();
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.drawImage(effect, 0, 0);
    ctx.restore();
  }
  fill(color = this.color, point?: Point) {
    const l = this.requireLayer();
    this.validateColor(color);
    const target = this.editableCanvas();
    if (point && (!Number.isFinite(point.x) || !Number.isFinite(point.y)))
      throw Error("填充坐标无效");
    this.run("填充", () => {
      const c = createCanvas(l.width, l.height),
        ctx = c.getContext("2d")!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, c.width, c.height);
      if (point) {
        const p = layerMatrix(l).inverse().transformPoint(point);
        const m = floodMask(
          target,
          Math.floor(p.x),
          Math.floor(p.y),
          this.tolerance,
          true,
        );
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(m, 0, 0);
      }
      this.applyPixels(c);
    });
  }
  clearPixels() {
    const l = this.requireLayer();
    this.editableCanvas();
    const c = createCanvas(l.width, l.height),
      ctx = c.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, c.width, c.height);
    this.run("清除像素", () => this.applyPixels(c, true));
  }
  filter(kind: string, amount = 20) {
    const l = this.requireLayer(),
      target = this.editableCanvas();
    this.run("滤镜：" + kind, () => {
      const result = applyFilter(target, kind, amount),
        selection = this.localSelection(l),
        ctx = target.getContext("2d")!;
      if (selection) {
        const original = ctx.getImageData(0, 0, target.width, target.height),
          changed = result
            .getContext("2d")!
            .getImageData(0, 0, target.width, target.height).data,
          mask = selection
            .getContext("2d")!
            .getImageData(0, 0, target.width, target.height).data;
        for (let i = 0; i < original.data.length; i += 4) {
          const t = mask[i + 3] / 255,
            oa = original.data[i + 3] / 255,
            fa = changed[i + 3] / 255,
            alpha = oa * (1 - t) + fa * t;
          for (let c = 0; c < 3; c++)
            original.data[i + c] = alpha
              ? (original.data[i + c] * oa * (1 - t) +
                  changed[i + c] * fa * t) /
                alpha
              : 0;
          original.data[i + 3] = alpha * 255;
        }
        ctx.putImageData(original, 0, 0);
      } else {
        ctx.clearRect(0, 0, target.width, target.height);
        ctx.drawImage(result, 0, 0);
      }
      this.lastFilter = { kind, amount };
    });
  }
  removeBackground(tolerance = this.tolerance) {
    const l = this.requireLayer();
    if (l.type === "adjustment") throw Error("调整图层没有可去除的背景");
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 255)
      throw Error("容差需在0到255之间");
    this.run("去除边缘纯色背景", () => {
      const source = sourceCanvas(l),
        mask = createCanvas(l.width, l.height),
        ctx = mask.getContext("2d")!;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, mask.width, mask.height);
      ctx.globalCompositeOperation = "destination-out";
      const pts = [
        [0, 0],
        [source.width - 1, 0],
        [0, source.height - 1],
        [source.width - 1, source.height - 1],
      ];
      for (const [x, y] of pts)
        ctx.drawImage(floodMask(source, x, y, tolerance, true), 0, 0);
      l.mask =
        l.mask && l.maskEnabled
          ? combineMasks(l.mask, mask, "intersect")
          : mask;
      l.maskEnabled = true;
    });
  }
  crop(rect?: Rect) {
    const r = rect || (this.selection && selectionBounds(this.selection));
    if (!r) throw Error("请拖出裁剪范围或创建选区");
    if (Object.values(r).some((v) => !Number.isFinite(v)))
      throw Error("裁剪范围必须为有限数字");
    const x = Math.max(0, Math.round(r.x)),
      y = Math.max(0, Math.round(r.y)),
      right = Math.min(this.doc.width, Math.round(r.x + r.width)),
      bottom = Math.min(this.doc.height, Math.round(r.y + r.height)),
      w = right - x,
      h = bottom - y;
    this.validateSize(w, h);
    this.run("裁剪画布", () => {
      this.doc.width = w;
      this.doc.height = h;
      for (const l of this.doc.layers) {
        l.x -= x;
        l.y -= y;
      }
      this.resetEditingState();
    });
  }
  resize(width: number, height: number, scaleContent = true) {
    this.validateSize(width, height);
    const sx = width / this.doc.width,
      sy = height / this.doc.height;
    if (scaleContent)
      for (const l of this.doc.layers)
        this.validateTransform({
          ...l,
          x: l.x * sx,
          y: l.y * sy,
          scaleX: l.scaleX * sx,
          scaleY: l.scaleY * sy,
        });
    this.run(scaleContent ? "图像大小" : "画布大小", () => {
      if (scaleContent)
        for (const l of this.doc.layers) {
          l.x *= sx;
          l.y *= sy;
          l.scaleX *= sx;
          l.scaleY *= sy;
        }
      this.doc.width = width;
      this.doc.height = height;
      this.resetEditingState();
    });
  }
  fitTextLayer(layer: Layer) {
    const text = layer.text;
    if (!text) throw Error("请选择文字图层");
    if (text.content.length > 100_000) throw Error("文字最多100000个字符");
    if (
      !Number.isFinite(text.fontSize) ||
      text.fontSize < 1 ||
      text.fontSize > 1000 ||
      !Number.isFinite(text.lineHeight) ||
      text.lineHeight < 0.1 ||
      text.lineHeight > 10
    )
      throw Error("字号或行高超出允许范围");
    if (!["left", "center", "right", "start", "end"].includes(text.align))
      throw Error("文字对齐方式无效");
    this.validateColor(text.color);
    const ctx = createCanvas(1, 1).getContext("2d")!;
    ctx.font = `${text.fontWeight} ${text.fontSize}px ${text.fontFamily}`;
    const lines = text.content.split(/\r?\n/),
      height = Math.max(
        32,
        Math.ceil(
          lines.length * text.fontSize * text.lineHeight + text.fontSize * 0.25,
        ),
      );
    this.validateSize(100, height);
    const width = Math.max(
      100,
      Math.ceil(
        lines.reduce((n, line) => Math.max(n, ctx.measureText(line).width), 0) +
          text.fontSize * 0.25,
      ),
    );
    this.validateSize(width, height);
    layer.width = width;
    layer.height = height;
    this.validateTransform(layer);
  }
  updateText(patch: Partial<NonNullable<Layer["text"]>>) {
    const l = this.requireLayer();
    if (!l.text) throw Error("请选择文字图层");
    this.run("编辑文字", () => {
      l.text = { ...l.text!, ...patch };
      this.fitTextLayer(l);
    });
  }
  addText(
    text: string,
    x: number,
    y: number,
    options: Partial<NonNullable<Layer["text"]>> = {},
  ) {
    const l = makeLayer("文字", createCanvas(1, 1), "text");
    l.x = x;
    l.y = y;
    l.text = {
      content: text,
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      fontWeight: "400",
      color: this.color,
      align: "left",
      lineHeight: 1.3,
      ...options,
    };
    this.fitTextLayer(l);
    l.name = text.slice(0, 28) || "文字";
    this.addLayer(l);
    return l;
  }
  addShape(kind: "rectangle" | "ellipse" | "line", rect: Rect) {
    const width = Math.ceil(rect.width),
      height = Math.ceil(rect.height);
    this.validateSize(width, height);
    this.validateColor(this.color);
    if (!["rectangle", "ellipse", "line"].includes(kind))
      throw Error("形状类型不支持");
    if (
      !Number.isFinite(this.shapeStroke) ||
      this.shapeStroke < 0 ||
      this.shapeStroke > 2048
    )
      throw Error("描边宽度超出允许范围");
    const l = makeLayer(
      kind === "ellipse" ? "椭圆" : kind === "line" ? "直线" : "矩形",
      createCanvas(width, height),
      "shape",
    );
    l.x = rect.x;
    l.y = rect.y;
    this.validateTransform(l);
    l.shape = {
      kind,
      fill: this.shapeFill ? this.color : "transparent",
      stroke: this.color,
      strokeWidth:
        kind === "line" ? Math.max(2, this.shapeStroke) : this.shapeStroke,
      radius: 0,
    };
    this.addLayer(l);
    return l;
  }
  copy() {
    if (this.layer) {
      this.clipboard = cloneLayer(this.layer);
      this.message("已复制图层");
    }
  }
  paste() {
    if (!this.clipboard) throw Error("请先复制一个图层");
    const l = cloneLayer(this.clipboard);
    this.reId(l);
    l.name += " 副本";
    this.addLayer(l);
    this.editMask = false;
  }
  async load(file: NativeFile) {
    this.busy = true;
    this.touch();
    try {
      const result = file.files
        ? await importComp(file.files, file.name)
        : await importFile(file);
      this.validateSize(result.document.width, result.document.height);
      result.document.id = crypto.randomUUID();
      this.documents.push(result.document);
      this.index = this.documents.length - 1;
      this.resetEditingState();
      this.pan = { x: 0, y: 0 };
      this.notice = result.warnings.length
        ? result.warnings.join("；")
        : "已打开 " + file.name;
    } finally {
      this.busy = false;
      this.touch();
    }
  }
  async open() {
    const files = await window.desktop?.openFiles();
    if (files) for (const file of files) await this.load(file);
  }
  async openComp() {
    const file = await window.desktop?.openProjectFolder();
    if (file) await this.load(file);
  }
  async save() {
    const doc = this.doc,
      snapshot = cloneDocument(doc),
      revision = this.revision,
      bytes = await encodeProject(snapshot);
    const path = await this.download(
      doc.name.replace(/\.[^.]+$/, "") + ".cwdoc",
      bytes,
      "Compositor 工程",
      ["cwdoc"],
    );
    if (path) {
      const current = this.documents.find((item) => item.id === doc.id);
      if (current) current.filePath = path;
      const unchanged = current === doc && this.revision === revision;
      if (unchanged) doc.dirty = false;
      this.message(
        unchanged ? "工程已保存" : "已保存操作开始时的版本；后续修改仍未保存",
      );
    }
  }
  async download(
    name: string,
    bytes: Uint8Array,
    label: string,
    extensions: string[],
  ) {
    if (window.desktop)
      return window.desktop.saveFile({
        name,
        bytes,
        filters: [{ name: label, extensions }],
      });
    const blob = new Blob([new Uint8Array(bytes).buffer]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return name;
  }
  async export(format: string) {
    const name = this.doc.name.replace(/\.[^.]+$/, "");
    if (format === "psd") {
      await this.download(
        name + ".psd",
        await exportPSD(this.doc),
        "Photoshop PSD",
        ["psd"],
      );
      this.message("PSD 已导出；文字、形状和调整以像素结果输出");
      return;
    }
    if (format === "comp") {
      const data = await exportComp(this.doc);
      const path = await window.desktop?.saveProjectFolder({
        name: name + ".comp",
        files: data.files,
      });
      if (path)
        this.message(data.warnings.join("；") || "原版 .comp 工程已导出");
      return;
    }
    const canvas = renderDocument(this.doc);
    if (format === "jpeg") {
      const c = canvas.getContext("2d")!;
      c.globalCompositeOperation = "destination-over";
      c.fillStyle = "white";
      c.fillRect(0, 0, canvas.width, canvas.height);
    }
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(Error("导出失败"))),
        format === "jpeg" ? "image/jpeg" : "image/png",
        0.94,
      ),
    );
    const path = await this.download(
      name + "." + (format === "jpeg" ? "jpg" : "png"),
      new Uint8Array(await blob.arrayBuffer()),
      "图像",
      [format === "jpeg" ? "jpg" : "png"],
    );
    if (path) this.message("已导出 " + path);
  }
  async action(action: string) {
    try {
      switch (action) {
        case "open":
          return await this.open();
        case "open-comp":
          return await this.openComp();
        case "save":
        case "save-as":
          return await this.save();
        case "export-png":
          return await this.export("png");
        case "export-jpeg":
          return await this.export("jpeg");
        case "export-psd":
          return await this.export("psd");
        case "export-comp":
          return await this.export("comp");
        case "undo":
          return this.undo();
        case "redo":
          return this.redo();
        case "copy":
          return this.copy();
        case "cut":
          this.copy();
          return this.deleteLayer();
        case "paste":
          return this.paste();
        case "select-all":
          return this.selectRect({
            x: 0,
            y: 0,
            width: this.doc.width,
            height: this.doc.height,
          });
        case "deselect":
          this.selection = null;
          return this.touch();
        case "invert-selection":
          return this.invertSelection();
        case "zoom-in":
          this.zoom = Math.min(8, this.zoom * 1.25);
          return this.touch();
        case "zoom-out":
          this.zoom = Math.max(0.05, this.zoom / 1.25);
          return this.touch();
        case "actual":
          this.zoom = 1;
          this.pan = { x: 0, y: 0 };
          return this.touch();
        case "grid":
          this.grid = !this.grid;
          return this.touch();
        case "rulers":
          this.rulers = !this.rulers;
          return this.touch();
        case "duplicate":
          return this.duplicate();
        case "delete-layer":
          return this.deleteLayer();
        case "new-layer":
          return this.addLayer();
        case "mask":
          return this.addMask();
        case "merge":
          return this.mergeDown();
        case "flatten":
          return this.flatten();
        case "rasterize":
          return this.run("栅格化", () => this.rasterize());
        case "group":
          return this.group();
        case "ungroup":
          return this.ungroup();
        case "invert-mask":
          return this.invertMask();
        case "remove-background":
          return this.removeBackground();
        case "clear":
          return this.clearPixels();
        default:
          throw Error("未知操作：" + action);
      }
    } catch (error) {
      this.message(error instanceof Error ? error.message : String(error));
    }
  }
  state() {
    const info = (l: Layer): unknown => ({
      id: l.id,
      name: l.name,
      type: l.type,
      x: l.x,
      y: l.y,
      width: l.width,
      height: l.height,
      scaleX: l.scaleX,
      scaleY: l.scaleY,
      rotation: l.rotation,
      opacity: l.opacity,
      visible: l.visible,
      locked: l.locked,
      blendMode: l.blendMode,
      mask: !!l.mask,
      clip: l.clip,
      text: l.text,
      shape: l.shape,
      adjustments: l.adjustments,
      children: l.children?.map(info),
    });
    return {
      document: {
        id: this.doc.id,
        name: this.doc.name,
        width: this.doc.width,
        height: this.doc.height,
        dirty: this.doc.dirty,
        layers: this.doc.layers.map(info),
      },
      activeLayerId: this.doc.activeId,
      editingTarget: this.editMask ? "mask" : "pixels",
      selection: this.selection ? selectionBounds(this.selection) : null,
      documents: this.documents.map((d) => ({ id: d.id, name: d.name })),
      history: this.history,
      notice: this.notice,
    };
  }
  async automate(
    action: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const num = (key: string, fallback = 0) => {
      const n = Number(args[key] ?? fallback);
      if (!Number.isFinite(n)) throw Error(key + " 必须为有限数字");
      return n;
    };
    const str = (key: string, fallback = "") => String(args[key] ?? fallback);
    if (action === "get_state") return this.state();
    if (action === "get_canvas") {
      const c = renderDocument(this.doc);
      const max = Math.min(2048, Math.max(64, num("maxSize", 1200)));
      const s = Math.min(1, max / Math.max(c.width, c.height));
      const out = createCanvas(
        Math.round(c.width * s),
        Math.round(c.height * s),
      );
      out.getContext("2d")!.drawImage(c, 0, 0, out.width, out.height);
      return {
        mimeType: "image/png",
        base64: out.toDataURL("image/png").split(",")[1],
        width: out.width,
        height: out.height,
      };
    }
    if (action === "export") {
      const format = str("format", "png");
      let bytes: Uint8Array;
      if (format === "cwdoc") bytes = await encodeProject(this.doc);
      else if (format === "psd") bytes = await exportPSD(this.doc);
      else if (format === "png" || format === "jpeg") {
        const c = renderDocument(this.doc);
        if (format === "jpeg") {
          const x = c.getContext("2d")!;
          x.globalCompositeOperation = "destination-over";
          x.fillStyle = "white";
          x.fillRect(0, 0, c.width, c.height);
        }
        const blob = await new Promise<Blob>((r, j) =>
          c.toBlob(
            (b) => (b ? r(b) : j(Error("导出失败"))),
            "image/" + format,
            0.94,
          ),
        );
        bytes = new Uint8Array(await blob.arrayBuffer());
      } else throw Error("导出格式仅 png/jpeg/psd/cwdoc");
      let binary = "";
      for (let i = 0; i < bytes.length; i += 32768)
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return { base64: btoa(binary), format };
    }
    if (action === "open_image") {
      const data = str("base64");
      if (!data || data.length > 64_000_000) throw Error("文件为空或过大");
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      await this.load({ name: str("name", "image.png"), bytes });
      return this.state();
    }
    if (action === "place_image") {
      const data = str("base64");
      if (!data || data.length > 64_000_000) throw Error("文件为空或过大");
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
        result = await importFile({ name: str("name", "image.png"), bytes }),
        imported = result.document;
      this.validateSize(imported.width, imported.height);
      const original =
        imported.layers.length === 1 ? imported.layers[0] : undefined;
      const plain =
        original?.type === "raster" &&
        original.visible &&
        !original.mask &&
        original.opacity === 1 &&
        ["normal", "source-over"].includes(original.blendMode) &&
        !original.clip &&
        original.x === 0 &&
        original.y === 0 &&
        original.scaleX === 1 &&
        original.scaleY === 1 &&
        original.rotation === 0 &&
        original.width === imported.width &&
        original.height === imported.height &&
        !original.effects.shadow &&
        !original.effects.stroke &&
        Object.keys(defaultAdjustments()).every(
          (k) =>
            original.adjustments[k as keyof Adjustments] ===
            defaultAdjustments()[k as keyof Adjustments],
        );
      const placed = plain
        ? cloneLayer(original!)
        : makeLayer(str("name", imported.name), renderDocument(imported));
      this.reId(placed);
      placed.name = str("name", imported.name);
      placed.locked = false;
      const scale =
        args.scaleToFit === false
          ? 1
          : Math.min(
              1,
              this.doc.width / placed.width,
              this.doc.height / placed.height,
            );
      placed.scaleX = placed.scaleY = scale;
      placed.x = num("x", 0);
      placed.y = num("y", 0);
      this.validateTransform(placed);
      this.addLayer(placed);
      this.notice =
        [
          ...result.warnings,
          ...(!plain ? ["置入的多层或复杂工程已按合成外观栅格化"] : []),
        ].join("；") || "已置入图像";
      this.touch();
      return this.state();
    }
    if (action === "batch") {
      const cmds = args.commands;
      if (!Array.isArray(cmds) || cmds.length < 1 || cmds.length > 100)
        throw Error("commands 应为1到100条命令的数组");
      if (this.batching) throw Error("不能嵌套批处理");
      for (const cmd of cmds) {
        if (
          !cmd ||
          typeof cmd !== "object" ||
          typeof cmd.action !== "string" ||
          [
            "batch",
            "open_image",
            "new_document",
            "undo",
            "redo",
            "export",
            "switch_document",
          ].includes(cmd.action) ||
          (cmd.args !== undefined &&
            (!cmd.args ||
              typeof cmd.args !== "object" ||
              Array.isArray(cmd.args)))
        )
          throw Error("批处理中含不支持的命令");
      }
      const before = this.snapshot();
      this.begin(str("label", "AI 批量编辑"), before.doc);
      this.batching = true;
      try {
        for (const cmd of cmds) await this.automate(cmd.action, cmd.args || {});
      } catch (e) {
        this.restore(before);
        throw e;
      } finally {
        this.batching = false;
        this.touch();
      }
      this.commit();
      return this.state();
    }
    if (args.layerId) this.selectLayer(str("layerId"));
    const l = this.layer;
    if (["paint", "fill", "filter"].includes(action)) {
      const target = str("target", "pixels");
      if (target !== "pixels" && target !== "mask")
        throw Error("target 仅支持 pixels 或 mask");
      if (target === "mask" && !l?.mask)
        throw Error("当前图层没有可编辑蒙版，请先添加蒙版");
      this.editMask = target === "mask";
    }
    switch (action) {
      case "new_document":
        this.newDocument(
          str("name", "AI 编辑"),
          num("width", 1280),
          num("height", 800),
          str("background", "transparent"),
        );
        break;
      case "switch_document": {
        const i = this.documents.findIndex((d) => d.id === str("id"));
        if (i < 0) throw Error("文档不存在");
        this.switchDocument(i);
        break;
      }
      case "select_layer":
        this.selectLayer(str("id"));
        break;
      case "add_layer":
        this.addLayer(
          makeLayer(
            str("name", "AI 图层"),
            createCanvas(this.doc.width, this.doc.height),
          ),
        );
        break;
      case "add_text": {
        this.addText(str("text"), num("x"), num("y"), {
          fontSize: num("fontSize", 72),
          fontFamily: str("fontFamily", "Microsoft YaHei"),
          color: str("color", "#ffffff"),
          fontWeight: str("fontWeight", "400"),
          align: str("align", "left") as CanvasTextAlign,
        });
        break;
      }
      case "add_shape": {
        const kind = str("kind", "rectangle");
        if (!["rectangle", "ellipse", "line"].includes(kind))
          throw Error("形状类型不支持");
        const prev = this.color;
        this.color = str("color", prev);
        try {
          this.addShape(kind as "rectangle" | "ellipse" | "line", {
            x: num("x"),
            y: num("y"),
            width: num("width", 100),
            height: num("height", 100),
          });
        } finally {
          this.color = prev;
        }
        break;
      }
      case "set_layer": {
        if (!l) throw Error("请选择图层");
        for (const key of Object.keys(args))
          if (
            ![
              "layerId",
              "name",
              "blendMode",
              "visible",
              "locked",
              "clip",
              "maskEnabled",
              "opacity",
            ].includes(key)
          )
            throw Error("不支持的图层属性：" + key);
        const patch: Partial<Layer> = {};
        for (const k of ["name", "blendMode"] as const)
          if (k in args) patch[k] = str(k);
        for (const k of ["visible", "locked", "clip", "maskEnabled"] as const)
          if (k in args) {
            if (typeof args[k] !== "boolean") throw Error(k + " 必须是布尔值");
            patch[k] = args[k] as boolean;
          }
        if ("opacity" in args) patch.opacity = num("opacity");
        this.updateLayer(patch, "AI 修改图层");
        break;
      }
      case "transform": {
        if (!l || l.locked) throw Error("未选图层或图层已锁定");
        const patch: Partial<Layer> = {};
        for (const k of ["x", "y", "scaleX", "scaleY", "rotation"] as const)
          if (k in args) patch[k] = num(k);
        if (patch.scaleX === 0 || patch.scaleY === 0)
          throw Error("缩放不能为0");
        this.updateLayer(patch, "AI 变换");
        break;
      }
      case "set_text": {
        this.requireLayer();
        if (!l?.text) throw Error("请选择文字图层");
        const patch: Partial<NonNullable<Layer["text"]>> = {};
        for (const k of [
          "content",
          "fontFamily",
          "color",
          "fontWeight",
        ] as const)
          if (k in args) patch[k] = str(k);
        if ("fontSize" in args) patch.fontSize = num("fontSize");
        if ("lineHeight" in args) patch.lineHeight = num("lineHeight");
        if ("align" in args) patch.align = str("align") as CanvasTextAlign;
        this.updateText(patch);
        break;
      }
      case "adjust": {
        const layer = this.requireLayer(),
          a = { ...layer.adjustments };
        const ranges: Record<string, [number, number]> = {
          brightness: [-100, 100],
          contrast: [-100, 100],
          saturation: [-100, 400],
          hue: [-360, 360],
          exposure: [-12, 12],
          temperature: [-100, 100],
          tint: [-100, 100],
          shadows: [-100, 100],
          highlights: [-100, 100],
          blur: [0, 256],
          sepia: [0, 100],
          gamma: [0.05, 10],
          blackPoint: [0, 254],
          whitePoint: [1, 255],
        };
        for (const key of Object.keys(args))
          if (key !== "layerId" && !(key in a))
            throw Error("不支持的调整：" + key);
        for (const k of Object.keys(a) as (keyof Adjustments)[])
          if (k in args) {
            if (k === "invert" || k === "grayscale") a[k] = Boolean(args[k]);
            else {
              const value = num(k),
                [min, max] = ranges[k];
              if (value < min || value > max) throw Error(k + " 超出允许范围");
              a[k] = value;
            }
          }
        this.run("AI 调色", () => {
          layer.adjustments = a;
        });
        break;
      }
      case "filter":
        this.filter(str("kind"), num("amount", 20));
        break;
      case "fill": {
        this.fill(
          str("color", this.color),
          "x" in args && "y" in args ? { x: num("x"), y: num("y") } : undefined,
        );
        break;
      }
      case "select_rect":
        this.selectRect(
          {
            x: num("x"),
            y: num("y"),
            width: num("width"),
            height: num("height"),
          },
          Boolean(args.ellipse),
        );
        break;
      case "select_color": {
        const tolerance = num("tolerance", 32);
        if (tolerance < 0 || tolerance > 255) throw Error("容差需在0到255之间");
        this.tolerance = tolerance;
        this.magic({ x: num("x"), y: num("y") });
        break;
      }
      case "feather_selection": {
        if (!this.selection) throw Error("请先创建选区");
        const radius = num("radius", 5);
        if (radius < 0 || radius > 256) throw Error("羽化半径需在0到256之间");
        this.selection = featherMask(this.selection, radius);
        break;
      }
      case "remove_background":
        this.removeBackground(num("tolerance", 32));
        break;
      case "crop":
        this.crop(
          "width" in args
            ? {
                x: num("x"),
                y: num("y"),
                width: num("width"),
                height: num("height"),
              }
            : undefined,
        );
        break;
      case "resize":
        this.resize(num("width"), num("height"), args.scaleContent !== false);
        break;
      case "paint": {
        if (!l) throw Error("请选择图层");
        const pts = args.points;
        if (!Array.isArray(pts) || pts.length < 1 || pts.length > 20000)
          throw Error("points 需要1到20000个{x,y}点");
        for (const p of pts)
          if (
            !p ||
            !Number.isFinite(p.x) ||
            !Number.isFinite(p.y) ||
            Math.abs(p.x) > 1_000_000 ||
            Math.abs(p.y) > 1_000_000
          )
            throw Error("点坐标无效");
        const color = str("color", this.color),
          size = num("size", 20),
          opacity = num("opacity", 1);
        this.validateColor(color);
        if (size < 0.1 || size > 2048 || opacity < 0 || opacity > 1)
          throw Error("画笔大小或不透明度超出允许范围");
        const target = this.editableCanvas();
        this.run("AI 画笔", () => {
          const c = createCanvas(target.width, target.height),
            ctx = c.getContext("2d")!,
            inv = layerMatrix(l).inverse();
          ctx.strokeStyle = color;
          ctx.fillStyle = ctx.strokeStyle;
          ctx.lineWidth = size;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.globalAlpha = opacity;
          ctx.beginPath();
          pts.forEach((p, i) => {
            const q = inv.transformPoint(p);
            i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
          });
          if (pts.length === 1) {
            const q = inv.transformPoint(pts[0]);
            ctx.arc(q.x, q.y, ctx.lineWidth / 2, 0, Math.PI * 2);
            ctx.fill();
          } else ctx.stroke();
          this.applyPixels(c, Boolean(args.erase));
        });
        break;
      }
      case "undo":
        this.undo();
        break;
      case "redo":
        this.redo();
        break;
      case "duplicate_layer":
        this.duplicate();
        break;
      case "delete_layer":
        this.deleteLayer();
        break;
      case "add_mask":
        this.addMask();
        break;
      case "invert_mask":
        this.invertMask();
        break;
      case "merge_down":
        this.mergeDown();
        break;
      case "flatten":
        this.flatten();
        break;
      case "group":
        this.group();
        break;
      case "rasterize":
        this.run("AI 栅格化", () => this.rasterize());
        break;
      case "deselect":
        this.selection = null;
        break;
      case "invert_selection":
        this.invertSelection();
        break;
      default:
        throw Error("不支持的命令：" + action);
    }
    this.touch();
    return this.state();
  }
}
export const editor = new Editor();

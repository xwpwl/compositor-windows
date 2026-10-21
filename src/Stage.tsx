import { useEffect, useRef, useState } from "react";
import { editor as e } from "./editor";
import {
  createCanvas,
  cloneCanvas,
  renderDocument,
  layerMatrix,
  layerBounds,
  sourceCanvas,
  selectionBounds,
} from "./engine";
import type { Point, Rect, Layer } from "./types";

const rectOf = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(b.x - a.x),
  height: Math.abs(b.y - a.y),
});
type Drag = {
  start: Point;
  last: Point;
  points: Point[];
  layer?: Layer;
  origin?: Point;
  scale?: Point;
  original?: HTMLCanvasElement;
  scratch?: HTMLCanvasElement;
  selection?: HTMLCanvasElement | null;
  pan?: Point;
  client?: Point;
  resize?: boolean;
  cloneOffset?: Point;
  changed?: boolean;
};
export function Stage({
  revision,
  onText,
}: {
  revision: number;
  onText: (p: Point) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    overlay = useRef<HTMLCanvasElement>(null),
    drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<Rect | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [space, setSpace] = useState(false);
  const [size, setSize] = useState({ width: 1000, height: 700 });
  useEffect(() => {
    if (!host.current) return;
    const obs = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    obs.observe(host.current);
    return () => obs.disconnect();
  }, []);
  const fit = () => {
    if (!host.current) return;
    const r = host.current.getBoundingClientRect();
    e.zoom = Math.min(
      1,
      (r.width - 110) / e.doc.width,
      (r.height - 100) / e.doc.height,
    );
    e.pan = { x: 0, y: 0 };
    e.touch();
  };
  useEffect(() => {
    fit();
    const fn = (ev: Event) => {
      if ((ev as CustomEvent).detail === "fit") fit();
    };
    window.addEventListener("editor-view", fn);
    return () => window.removeEventListener("editor-view", fn);
  }, [e.doc.id]);
  useEffect(() => {
    const down = (ev: KeyboardEvent) => {
      if (
        ev.code === "Space" &&
        !/INPUT|TEXTAREA|SELECT/.test((ev.target as HTMLElement).tagName)
      ) {
        ev.preventDefault();
        setSpace(true);
      }
    };
    const up = (ev: KeyboardEvent) => {
      if (ev.code === "Space") setSpace(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);
  useEffect(() => {
    if (!canvas.current) return;
    renderDocument(e.doc, canvas.current);
  }, [revision]);
  useEffect(() => {
    const c = overlay.current;
    if (!c) return;
    c.width = e.doc.width;
    c.height = e.doc.height;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineWidth = 1 / e.zoom;
    if (e.grid) {
      ctx.strokeStyle = "#ffffff25";
      ctx.beginPath();
      for (let x = 0; x < c.width; x += 100) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, c.height);
      }
      for (let y = 0; y < c.height; y += 100) {
        ctx.moveTo(0, y);
        ctx.lineTo(c.width, y);
      }
      ctx.stroke();
    }
    if (e.selection) {
      ctx.save();
      ctx.globalAlpha = 0.17;
      ctx.drawImage(e.selection, 0, 0);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = "#64d9c3";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.restore();
      const r = selectionBounds(e.selection);
      if (r) {
        ctx.strokeStyle = "#ffffff";
        ctx.setLineDash([5 / e.zoom, 5 / e.zoom]);
        ctx.strokeRect(r.x, r.y, r.width, r.height);
        ctx.lineDashOffset = 5 / e.zoom;
        ctx.strokeStyle = "#111111";
        ctx.strokeRect(r.x, r.y, r.width, r.height);
        ctx.setLineDash([]);
      }
    }
    const l = e.layer;
    if (l && ["move", "transform"].includes(e.tool)) {
      const r = layerBounds(l);
      ctx.strokeStyle = "#8bdcca";
      ctx.strokeRect(r.x, r.y, r.width, r.height);
      if (e.tool === "transform") {
        ctx.fillStyle = "#e9fff9";
        for (const p of [
          [r.x, r.y],
          [r.x + r.width, r.y],
          [r.x, r.y + r.height],
          [r.x + r.width, r.y + r.height],
        ]) {
          ctx.fillRect(
            p[0] - 3 / e.zoom,
            p[1] - 3 / e.zoom,
            6 / e.zoom,
            6 / e.zoom,
          );
        }
      }
    }
    if (preview) {
      ctx.setLineDash([6 / e.zoom, 4 / e.zoom]);
      ctx.strokeStyle = "#ffffff";
      ctx.fillStyle = "#7dd3c122";
      ctx.fillRect(preview.x, preview.y, preview.width, preview.height);
      if (e.tool === "ellipse-select" || e.tool === "ellipse") {
        ctx.beginPath();
        ctx.ellipse(
          preview.x + preview.width / 2,
          preview.y + preview.height / 2,
          Math.max(0.1, preview.width / 2),
          Math.max(0.1, preview.height / 2),
          0,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
      } else
        ctx.strokeRect(preview.x, preview.y, preview.width, preview.height);
      ctx.setLineDash([]);
    }
    if (drag.current && e.tool === "lasso") {
      ctx.strokeStyle = "#ffffff";
      ctx.beginPath();
      drag.current.points.forEach((p, i) =>
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
      );
      ctx.stroke();
    }
    if (
      cursor &&
      ["brush", "eraser", "clone", "heal", "blur"].includes(e.tool)
    ) {
      ctx.strokeStyle = "#fff";
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, e.brushSize / 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#0008";
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, e.brushSize / 2 + 1 / e.zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [revision, preview, cursor]);
  const point = (ev: React.PointerEvent | React.WheelEvent) => {
    const r = overlay.current!.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) / e.zoom,
      y: (ev.clientY - r.top) / e.zoom,
    };
  };
  const stamp = (d: Drag, p: Point, pressure = 1) => {
    const l = d.layer!;
    const q = layerMatrix(l).inverse().transformPoint(p),
      last = layerMatrix(l).inverse().transformPoint(d.last);
    const sc = d.scratch!,
      ctx = sc.getContext("2d")!;
    const distance = Math.hypot(q.x - last.x, q.y - last.y),
      radius = Math.max(
        0.5,
        ((e.brushSize / 2) * pressure) / Math.max(0.1, Math.abs(l.scaleX)),
      );
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * 0.25)));
    for (let i = 0; i <= steps; i++) {
      const x = last.x + ((q.x - last.x) * i) / steps,
        y = last.y + ((q.y - last.y) * i) / steps;
      ctx.save();
      ctx.globalAlpha = e.brushOpacity;
      const hard = Math.min(0.999, e.hardness);
      const gradient = ctx.createRadialGradient(
        x,
        y,
        radius * hard,
        x,
        y,
        radius,
      );
      const color = e.editMask ? "#ffffff" : e.color;
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, color + "00");
      ctx.fillStyle = gradient;
      if (e.tool === "clone" || e.tool === "heal") {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.clip();
        ctx.globalAlpha = e.tool === "heal" ? 0.5 : e.brushOpacity;
        const off = d.cloneOffset || { x: radius * 2, y: 0 };
        ctx.drawImage(d.original!, off.x, off.y);
      } else if (e.tool === "blur") {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.clip();
        ctx.filter = "blur(4px)";
        ctx.drawImage(d.original!, 0, 0);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    const painted = cloneCanvas(sc);
    if (d.selection) {
      const pc = painted.getContext("2d")!;
      pc.globalCompositeOperation = "destination-in";
      pc.drawImage(d.selection, 0, 0);
    }
    const target = e.editMask ? l.mask! : l.canvas!,
      tc = target.getContext("2d")!;
    tc.clearRect(0, 0, target.width, target.height);
    tc.drawImage(d.original!, 0, 0);
    tc.globalCompositeOperation =
      e.tool === "eraser" ? "destination-out" : "source-over";
    tc.drawImage(painted, 0, 0);
    tc.globalCompositeOperation = "source-over";
    d.last = p;
    d.changed = true;
    e.touch();
  };
  const down = (ev: React.PointerEvent) => {
    if (ev.button !== 0 && ev.button !== 1) return;
    ev.preventDefault();
    overlay.current!.setPointerCapture(ev.pointerId);
    const p = point(ev);
    const d: Drag = { start: p, last: p, points: [p] };
    drag.current = d;
    try {
      if (space || e.tool === "hand" || ev.button === 1) {
        d.pan = { ...e.pan };
        d.client = { x: ev.clientX, y: ev.clientY };
        return;
      }
      if (e.tool === "eyedropper") {
        const c = canvas.current!,
          x = Math.min(c.width - 1, Math.max(0, Math.floor(p.x))),
          y = Math.min(c.height - 1, Math.max(0, Math.floor(p.y))),
          data = c.getContext("2d")!.getImageData(x, y, 1, 1).data;
        e.color =
          "#" +
          Array.from(data.slice(0, 3))
            .map((v) => v.toString(16).padStart(2, "0"))
            .join("");
        e.touch();
        drag.current = null;
        return;
      }
      if (e.tool === "zoom") {
        e.zoom = Math.min(8, Math.max(0.05, e.zoom * (ev.altKey ? 0.8 : 1.25)));
        e.touch();
        drag.current = null;
        return;
      }
      if (e.tool === "text") {
        onText(p);
        drag.current = null;
        return;
      }
      if (e.tool === "wand") {
        e.magic(p);
        drag.current = null;
        return;
      }
      if (e.tool === "fill") {
        e.fill(e.color, p);
        drag.current = null;
        return;
      }
      if (e.tool === "move" || e.tool === "transform") {
        let l = e.layer;
        if (e.tool === "move") {
          for (const test of [...e.doc.layers].reverse()) {
            if (!test.visible || test.locked) continue;
            const q = layerMatrix(test).inverse().transformPoint(p);
            if (q.x >= 0 && q.y >= 0 && q.x < test.width && q.y < test.height) {
              const source = sourceCanvas(test);
              if (
                source
                  .getContext("2d")!
                  .getImageData(Math.floor(q.x), Math.floor(q.y), 1, 1)
                  .data[3] > 8
              ) {
                l = test;
                e.selectLayer(l.id);
                break;
              }
            }
          }
        }
        if (!l || l.locked) {
          drag.current = null;
          return;
        }
        d.layer = l;
        d.origin = { x: l.x, y: l.y };
        d.scale = { x: l.scaleX, y: l.scaleY };
        d.resize = e.tool === "transform";
        return;
      }
      if (["brush", "eraser", "clone", "heal", "blur"].includes(e.tool)) {
        if (ev.altKey && (e.tool === "clone" || e.tool === "heal")) {
          e.clonePoint = p;
          e.message("已设置仿制源点");
          drag.current = null;
          return;
        }
        const target = e.editableCanvas();
        d.layer = e.layer!;
        d.original = cloneCanvas(target);
        d.scratch = createCanvas(target.width, target.height);
        d.selection = e.localSelection(d.layer);
        if (e.tool === "clone" && !e.clonePoint)
          throw Error("按住 Alt 点击画布设置仿制源点");
        if (e.clonePoint) {
          const inv = layerMatrix(d.layer).inverse(),
            q = inv.transformPoint(p),
            s = inv.transformPoint(e.clonePoint);
          d.cloneOffset = { x: q.x - s.x, y: q.y - s.y };
        }
        e.begin(
          e.tool === "heal"
            ? "局部仿制修补"
            : e.tool === "blur"
              ? "模糊画笔"
              : e.tool === "eraser"
                ? "橡皮擦"
                : "画笔",
        );
        stamp(d, p, ev.pointerType === "pen" ? Math.max(0.1, ev.pressure) : 1);
        return;
      }
      setPreview(rectOf(p, p));
    } catch (error) {
      drag.current = null;
      e.message(error instanceof Error ? error.message : String(error));
    }
  };
  const move = (ev: React.PointerEvent) => {
    const p = point(ev);
    setCursor(p);
    const d = drag.current;
    if (!d) return;
    if (d.pan && d.client) {
      e.pan = {
        x: d.pan.x + ev.clientX - d.client.x,
        y: d.pan.y + ev.clientY - d.client.y,
      };
      e.touch();
      return;
    }
    if (d.layer && d.origin && d.scale) {
      if (!d.changed) e.begin("变换图层");
      const dx = p.x - d.start.x,
        dy = p.y - d.start.y;
      if (d.resize) {
        d.layer.scaleX = Math.max(0.01, d.scale.x + dx / d.layer.width);
        d.layer.scaleY = ev.shiftKey
          ? d.layer.scaleX
          : Math.max(0.01, d.scale.y + dy / d.layer.height);
      } else {
        d.layer.x = d.origin.x + dx;
        d.layer.y = d.origin.y + dy;
        if (e.snap && !ev.altKey) {
          const threshold = 6 / e.zoom;
          for (const x of [
            0,
            (e.doc.width - d.layer.width * d.layer.scaleX) / 2,
            e.doc.width - d.layer.width * d.layer.scaleX,
          ])
            if (Math.abs(d.layer.x - x) < threshold) d.layer.x = x;
          for (const y of [
            0,
            (e.doc.height - d.layer.height * d.layer.scaleY) / 2,
            e.doc.height - d.layer.height * d.layer.scaleY,
          ])
            if (Math.abs(d.layer.y - y) < threshold) d.layer.y = y;
        }
      }
      d.changed = true;
      e.touch();
      return;
    }
    if (d.scratch) {
      stamp(d, p, ev.pointerType === "pen" ? Math.max(0.1, ev.pressure) : 1);
      return;
    }
    d.last = p;
    d.points.push(p);
    let end = p;
    if (ev.shiftKey) {
      const size = Math.max(
        Math.abs(p.x - d.start.x),
        Math.abs(p.y - d.start.y),
      );
      end = {
        x: d.start.x + Math.sign(p.x - d.start.x) * size,
        y: d.start.y + Math.sign(p.y - d.start.y) * size,
      };
      d.last = end;
    }
    setPreview(rectOf(d.start, end));
  };
  const up = () => {
    const d = drag.current;
    if (!d) return;
    try {
      const rect = rectOf(d.start, d.last);
      if (d.changed) e.commit();
      else if (d.pan) {
      } else if (e.tool === "rect-select" || e.tool === "ellipse-select") {
        if (rect.width > 1 && rect.height > 1)
          e.selectRect(rect, e.tool === "ellipse-select");
      } else if (e.tool === "lasso") {
        const c = createCanvas(e.doc.width, e.doc.height),
          ctx = c.getContext("2d")!;
        ctx.fillStyle = "white";
        ctx.beginPath();
        d.points.forEach((p, i) =>
          i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
        );
        ctx.closePath();
        ctx.fill();
        e.setSelection(c);
      } else if (e.tool === "crop" && rect.width > 1 && rect.height > 1)
        e.crop(rect);
      else if (
        ["rectangle", "ellipse", "line"].includes(e.tool) &&
        rect.width > 1
      ) {
        const line = e.addShape(e.tool as "rectangle" | "ellipse" | "line", {
          ...rect,
          height: Math.max(2, rect.height),
        });
        if (
          e.tool === "line" &&
          (d.last.x - d.start.x) * (d.last.y - d.start.y) < 0
        ) {
          line.scaleY = -1;
          line.y += line.height;
          e.commit();
        }
      } else if (e.tool === "gradient") {
        const l = e.layer!;
        const target = e.editableCanvas(),
          c = createCanvas(target.width, target.height),
          ctx = c.getContext("2d")!,
          inv = layerMatrix(l).inverse(),
          a = inv.transformPoint(d.start),
          b = inv.transformPoint(d.last),
          g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        g.addColorStop(0, e.color);
        g.addColorStop(1, e.background);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, c.width, c.height);
        e.run("渐变", () => e.applyPixels(c));
      }
    } catch (error) {
      e.message(error instanceof Error ? error.message : String(error));
    }
    drag.current = null;
    setPreview(null);
  };
  const wheel = (ev: React.WheelEvent) => {
    ev.preventDefault();
    if (ev.ctrlKey || ev.altKey) {
      const p = point(ev),
        old = e.zoom;
      e.zoom = Math.min(
        8,
        Math.max(0.05, e.zoom * Math.exp(-ev.deltaY * 0.002)),
      );
      e.pan.x -= (p.x - e.doc.width / 2) * (e.zoom - old);
      e.pan.y -= (p.y - e.doc.height / 2) * (e.zoom - old);
    } else {
      e.pan.x -= ev.deltaX;
      e.pan.y -= ev.deltaY;
    }
    e.touch();
  };
  return (
    <div
      ref={host}
      className={"stage " + (space || e.tool === "hand" ? "grabbing" : "")}
      onWheel={wheel}
      onDragOver={(ev) => ev.preventDefault()}
      onDrop={async (ev) => {
        ev.preventDefault();
        for (const f of ev.dataTransfer.files)
          try {
            await e.load({
              name: f.name,
              bytes: new Uint8Array(await f.arrayBuffer()),
            });
          } catch (err) {
            e.message(String(err));
          }
      }}
    >
      {e.rulers && (
        <>
          <div className="ruler horizontal">
            {Array.from(
              { length: Math.ceil(e.doc.width / 100) + 1 },
              (_, i) => (
                <span
                  key={i}
                  style={{
                    position: "absolute",
                    left:
                      size.width / 2 +
                      e.pan.x -
                      (e.doc.width * e.zoom) / 2 +
                      i * 100 * e.zoom -
                      19,
                  }}
                >
                  {i * 100}
                </span>
              ),
            )}
          </div>
          <div className="ruler vertical">
            {Array.from(
              { length: Math.ceil(e.doc.height / 100) + 1 },
              (_, i) => (
                <span
                  key={i}
                  style={{
                    position: "absolute",
                    top:
                      size.height / 2 +
                      e.pan.y -
                      (e.doc.height * e.zoom) / 2 +
                      i * 100 * e.zoom -
                      19,
                  }}
                >
                  {i * 100}
                </span>
              ),
            )}
          </div>
        </>
      )}
      <div
        className="canvas-space"
        style={{
          width: e.doc.width,
          height: e.doc.height,
          transform: `translate(-50%, -50%) translate(${e.pan.x}px, ${e.pan.y}px) scale(${e.zoom})`,
        }}
      >
        <canvas ref={canvas} />
        <canvas
          ref={overlay}
          className="overlay"
          aria-label="编辑画布"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => {
            if (drag.current?.changed) e.undo();
            drag.current = null;
            setPreview(null);
          }}
          onPointerLeave={() => setCursor(null)}
          style={{
            cursor:
              space || e.tool === "hand"
                ? "grab"
                : e.tool === "move"
                  ? "move"
                  : "crosshair",
          }}
        />
      </div>
      <div className="canvas-hint">
        {e.tool === "clone"
          ? "Alt + 点击设置源点"
          : e.tool === "transform"
            ? "拖动缩放 · Shift 保持比例"
            : e.tool === "move"
              ? "拖动移动 · Alt 暂停吸附"
              : "在画布上拖动以编辑"}
        <span>空格拖动视图 · Ctrl + 滚轮缩放</span>
      </div>
    </div>
  );
}

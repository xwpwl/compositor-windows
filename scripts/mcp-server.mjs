#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { rpc, openImage, exportImage, EXPORT_FORMATS } from "./client.mjs";

export const EDIT_ACTIONS = [
  "new_document",
  "switch_document",
  "place_image",
  "select_layer",
  "add_layer",
  "add_text",
  "add_shape",
  "set_layer",
  "transform",
  "set_text",
  "adjust",
  "filter",
  "fill",
  "select_rect",
  "select_color",
  "feather_selection",
  "remove_background",
  "crop",
  "resize",
  "paint",
  "undo",
  "redo",
  "duplicate_layer",
  "delete_layer",
  "add_mask",
  "invert_mask",
  "merge_down",
  "flatten",
  "group",
  "rasterize",
  "deselect",
  "invert_selection",
  "batch",
];

const EDIT_HELP = `Edit the local Compositor Windows document using a structured command. Coordinates are document pixels; opacity is 0..1; rotation is degrees. Commands and args:
new_document: name,width,height,background ('transparent' or color).
switch_document: id. select_layer: id. add_layer: name.
place_image: base64,name,x?,y?,scaleToFit?; adds an image as a new layer in the current document for compositing. Prefer compositor_open_image with asLayer:true to load a file without manually encoding it.
add_text: text,x,y,fontSize,fontFamily,color,fontWeight,align. add_shape: kind(rectangle|ellipse|line),x,y,width,height,color.
set_layer: layerId?,name,blendMode,visible,locked,clip,maskEnabled,opacity. transform: layerId?,x,y,scaleX,scaleY,rotation.
set_text: layerId?,content,fontFamily,color,fontWeight,fontSize.
adjust: layerId?,brightness,contrast,saturation,hue,exposure,temperature,tint,shadows,highlights,blur,grayscale,invert,sepia,gamma,blackPoint,whitePoint.
filter: layerId?,target?(pixels|mask),kind(gaussian|blur|motion|sharpen|noise|pixelate|emboss|edges|vignette|bloom),amount. fill: layerId?,target?(pixels|mask),color,x?,y?.
select_rect: x,y,width,height,ellipse?. select_color: x,y,tolerance. feather_selection: radius. remove_background: tolerance.
crop: x,y,width,height (omit all to use selection). resize: width,height,scaleContent.
paint: layerId?,target?(pixels|mask),points:[{x,y}],color,size,opacity,erase. paint/fill/filter default to target:pixels regardless of the UI editing mode. target:mask requires an existing mask. Mask opacity is stored in alpha: paint with erase:true hides; paint white with erase:false restores. get_state.editingTarget reports the current UI editing target.
undo,redo,duplicate_layer,delete_layer,add_mask,invert_mask,merge_down,flatten,group,rasterize,deselect,invert_selection: no additional args; layerId is optional for layer actions.
batch: label,commands:[{action,args}], at most 100 commands; rolls back all edits if one fails. Cannot nest batch or include open_image,new_document,undo,redo,export,switch_document. Use get_state to find layer IDs and get_canvas to visually verify results. No JavaScript execution is supported.`;

const objectSchema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const annotations = (readOnlyHint, destructiveHint) => ({
  readOnlyHint,
  destructiveHint,
  openWorldHint: false,
});
export const TOOLS = [
  {
    name: "compositor_get_state",
    description:
      "Read the active document, dimensions, layers, IDs, selection, history, and current status from the running local Compositor Windows app.",
    inputSchema: objectSchema({}),
    annotations: annotations(true, false),
  },
  {
    name: "compositor_get_canvas",
    description:
      "See the current composite canvas as a PNG image. Call before and after editing to inspect the actual visual result.",
    inputSchema: objectSchema({
      maxSize: {
        type: "integer",
        minimum: 64,
        maximum: 2048,
        default: 1200,
        description: "Maximum preview width or height in pixels.",
      },
    }),
    annotations: annotations(true, false),
  },
  {
    name: "compositor_edit",
    description: EDIT_HELP,
    inputSchema: objectSchema(
      {
        action: { type: "string", enum: EDIT_ACTIONS },
        args: {
          type: "object",
          description: "Command arguments described above. Defaults to {}.",
          additionalProperties: true,
        },
      },
      ["action"],
    ),
    annotations: annotations(false, true),
  },
  {
    name: "compositor_open_image",
    description:
      "Read a local image, PSD, or .cwdoc file (at most 45 MB). By default opens a new document. Set asLayer:true to place the image into the CURRENT document as a new layer for compositing, automatically downscaled to fit if needed. Complex source documents are flattened when placed. Optional x/y specify the placed layer position in document pixels.",
    inputSchema: objectSchema(
      {
        path: {
          type: "string",
          minLength: 1,
          description: "Absolute path of the local input file.",
        },
        asLayer: {
          type: "boolean",
          default: false,
          description:
            "Place into the current document for compositing instead of opening a new document.",
        },
        x: {
          type: "number",
          description: "Layer X coordinate; only valid with asLayer:true.",
        },
        y: {
          type: "number",
          description: "Layer Y coordinate; only valid with asLayer:true.",
        },
      },
      ["path"],
    ),
    annotations: annotations(false, false),
  },
  {
    name: "compositor_export",
    description:
      "Export the active document to a local PNG, JPEG, PSD, or editable .cwdoc file. Writes atomically and replaces an existing ordinary file at the specified path. PSD preserves supported pixel layers but rasterizes text/shapes/effects; documents containing adjustment layers are flattened into one composite layer. Save .cwdoc to preserve native editing data.",
    inputSchema: objectSchema(
      {
        path: {
          type: "string",
          minLength: 1,
          description:
            "Absolute output file path; its parent directory must exist.",
        },
        format: { type: "string", enum: EXPORT_FORMATS, default: "png" },
      },
      ["path"],
    ),
    annotations: annotations(false, true),
  },
];

const textContent = (value) => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});
function argsObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("工具参数必须是对象。");
  return value;
}
function checkKeys(args, allowed) {
  if (Object.keys(args).some((key) => !allowed.includes(key)))
    throw new Error("工具包含不支持的参数。");
}

export async function executeTool(name, input = {}, call = rpc) {
  try {
    const args = argsObject(input);
    switch (name) {
      case "compositor_get_state":
        checkKeys(args, []);
        return textContent(await call("get_state"));
      case "compositor_get_canvas": {
        checkKeys(args, ["maxSize"]);
        const maxSize = args.maxSize ?? 1200;
        if (!Number.isInteger(maxSize) || maxSize < 64 || maxSize > 2048)
          throw new Error("maxSize 必须是 64 到 2048 之间的整数。");
        const result = await call("get_canvas", { maxSize });
        if (
          !result ||
          result.mimeType !== "image/png" ||
          typeof result.base64 !== "string"
        )
          throw new Error("编辑器没有返回有效的画布图像。");
        return {
          content: [
            { type: "image", data: result.base64, mimeType: "image/png" },
            {
              type: "text",
              text: `Canvas preview: ${result.width} × ${result.height} px.`,
            },
          ],
        };
      }
      case "compositor_edit": {
        checkKeys(args, ["action", "args"]);
        if (!EDIT_ACTIONS.includes(args.action))
          throw new Error(
            "不支持的编辑命令。请参考 compositor_edit 的 action 枚举。",
          );
        return textContent(
          await call(args.action, argsObject(args.args ?? {})),
        );
      }
      case "compositor_open_image": {
        checkKeys(args, ["path", "asLayer", "x", "y"]);
        if (args.asLayer !== undefined && typeof args.asLayer !== "boolean")
          throw new Error("asLayer 必须是布尔值。");
        if (!args.asLayer && (args.x !== undefined || args.y !== undefined))
          throw new Error("x/y 只适用于 asLayer:true。");
        return textContent(await openImage(args.path, call, args));
      }
      case "compositor_export":
        checkKeys(args, ["path", "format"]);
        if (typeof args.path !== "string" || !args.path.trim())
          throw new Error("请提供输出文件路径。");
        return textContent(
          await exportImage(args.path, args.format ?? "png", call),
        );
      default:
        throw new Error(`未知工具：${String(name)}`);
    }
  } catch (error) {
    return {
      ...textContent(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  }
}

export function createDispatcher(call = rpc) {
  let initialized = false;
  return async (request) => {
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      request.jsonrpc !== "2.0" ||
      typeof request.method !== "string" ||
      (request.id !== undefined &&
        request.id !== null &&
        typeof request.id !== "number" &&
        typeof request.id !== "string")
    )
      return {
        jsonrpc: "2.0",
        id: request?.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      };
    if (request.id === undefined) return null;
    const respond = (result) => ({ jsonrpc: "2.0", id: request.id, result });
    const reject = (code, message) => ({
      jsonrpc: "2.0",
      id: request.id,
      error: { code, message },
    });
    switch (request.method) {
      case "initialize": {
        initialized = true;
        const supported = [
          "2024-11-05",
          "2025-03-26",
          "2025-06-18",
          "2025-11-25",
        ];
        const protocolVersion = supported.includes(
          request.params?.protocolVersion,
        )
          ? request.params.protocolVersion
          : "2025-11-25";
        return respond({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "compositor-windows", version: "0.1.0" },
          instructions:
            "Control the running local Compositor Windows editor. First read state and canvas; use structured edits, then verify the canvas and export. Changes remain editable in the desktop app; save as cwdoc to preserve them.",
        });
      }
      case "ping":
        return respond({});
      case "tools/list":
        if (!initialized)
          return reject(-32000, "Initialize the MCP connection first.");
        return respond({ tools: TOOLS });
      case "tools/call":
        if (!initialized)
          return reject(-32000, "Initialize the MCP connection first.");
        return respond(
          await executeTool(
            request.params?.name,
            request.params?.arguments ?? {},
            call,
          ),
        );
      default:
        return reject(-32601, "Method not found");
    }
  };
}

export function startStdio() {
  const dispatch = createDispatcher();
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  let queue = Promise.resolve();
  process.stdout.on("error", (error) => {
    if (error.code === "EPIPE") process.exit(0);
  });
  lines.on("line", (line) => {
    queue = queue
      .then(async () => {
        let response;
        try {
          if (Buffer.byteLength(line) > 4 * 1024 * 1024)
            throw new Error("Message too large");
          response = await dispatch(JSON.parse(line));
        } catch {
          response = {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          };
        }
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      })
      .catch(() => {
        process.stderr.write("MCP 请求处理失败。\n");
        process.exitCode = 1;
      });
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.includes("--help") || process.argv.includes("-h"))
    process.stdout.write(
      'Compositor Windows MCP stdio server\nUsage: node scripts/mcp-server.mjs\nStart Compositor Windows first. Configure your MCP client with command "node" and args ["<absolute path>/scripts/mcp-server.mjs"].\nSet COMPOSITOR_AUTOMATION_FILE to override the discovery JSON path.\nProtocol: newline-delimited JSON-RPC, initialize, ping, tools/list, tools/call.\n',
    );
  else startStdio();
}

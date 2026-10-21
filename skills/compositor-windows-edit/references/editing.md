# 编辑接口要点

本文对应社区 Windows 版 0.1.0。更新软件后优先读取实时 `tools/list`；不要仅按此文猜测新增命令。颜色使用 CSS 色值，不透明度 `0..1`，坐标是当前文档像素，旋转单位为度。

## 常用调用

| MCP 工具 | 参数及用途 |
| --- | --- |
| `compositor_get_state` | `{}`；文档与图层 ID、尺寸、选区、历史、`editingTarget` |
| `compositor_get_canvas` | `{"maxSize":1200}`；最长边 64–2048，返回 PNG 预览及实际尺寸 |
| `compositor_open_image` | `{"path":"绝对路径"}` 新开；加入当前文档用 `asLayer:true`，可选 `x/y`，默认缩放到画布内 |
| `compositor_edit` | `{"action":"动作名","args":{...}}`；参数见下文 |
| `compositor_export` | `{"path":"绝对路径","format":"jpeg"}`；可选 `png/jpeg/psd/cwdoc`，父目录须存在 |

`compositor_edit` 的常用 action：

| 动作 | args |
| --- | --- |
| `new_document` | `name,width,height,background`（颜色或 `transparent`） |
| `switch_document` / `select_layer` | `id` |
| `crop` | `x,y,width,height`；省略全部参数使用选区 |
| `resize` | `width,height,scaleContent` |
| `set_layer` | `layerId?,name?,visible?,locked?,opacity?,blendMode?,clip?,maskEnabled?` |
| `transform` | `layerId?,x?,y?,scaleX?,scaleY?,rotation?` |
| `adjust` | `layerId?` 加需要修改的调色字段；未提供字段保持原值 |
| `add_text` | `text,x,y,fontSize,fontFamily,color,fontWeight,align` |
| `set_text` | `layerId?,content,fontFamily,color,fontWeight,fontSize`；内容字段是 `content` |
| `add_shape` | `kind:rectangle/ellipse/line,x,y,width,height,color` |
| `select_rect` | `x,y,width,height,ellipse?` |
| `select_color` | `x,y,tolerance` |
| `feather_selection` | `radius` |
| `paint` | `layerId?,target?,points:[{x,y}],color,size,opacity,erase` |
| `fill` | `layerId?,target?,color,x?,y?` |
| `filter` | `layerId?,target?,kind,amount`；`gaussian/blur/motion/sharpen/noise/pixelate/emboss/edges/vignette/bloom` |
| `remove_background` | `tolerance`，仅适合连通边缘的近似纯色背景 |
| `duplicate_layer/delete_layer/add_mask/invert_mask/merge_down/group/rasterize` | 通常只需可选 `layerId`；以实时 schema 为准 |
| `undo/redo/flatten/deselect/invert_selection` | `{}` |

文字、形状需要先栅格化才能用像素画笔与滤镜；保留可编辑原件是否需要复制，按用户任务和内存判断。

## 调色语义

`brightness,contrast,saturation,hue,temperature,tint,shadows,highlights` 的中性值是 0；`exposure` 的中性值也是 0，按 `2^exposure` 改变 RGB。`gamma` 中性值 1，大于 1 提亮中间调；`blackPoint/whitePoint` 中性值 0/255。其他字段包括 `blur,grayscale,invert,sepia`。

饱和度 0 不是黑白，`grayscale:true` 才是黑白。阴影正值提亮暗部，高光负值压低亮部；色温正值增加暖色。压高光不能恢复输入中已经剪切的细节。参数只作适量修改并看图验证，不使用通用“大片预设”。

传入数值是绝对设置而非增量。例如要在现有曝光上增加 0.1，先读取当前值再计算新值；未传入的字段保持不变。

### 只提亮人物等局部调整

`adjust` 修改整层，选区不会限定它的作用范围。`add_mask` 则会根据当前选区生成蒙版；没有选区时生成全不透明蒙版。

对于单张、无既有蒙版的像素照片，可用以下路径保留背景：复制原图层一次 → 从新状态读取副本 ID → 在当前文档坐标中建立覆盖人物的选区并羽化 → 对副本 `add_mask` → `deselect` → 对副本 `adjust`。随后检查人物轮廓是否出现亮边、光斑或过宽的背景提亮，必要时调整蒙版。不要直接在唯一原图层上建立只显示人物的蒙版。

这是为了局部效果而有目的地复制一次，大图不再做多余整图复制。若原层已有蒙版、剪贴或组结构，先理解其范围再选择局部方案，不直接覆盖已有蒙版。

示例仅说明结构，不是每张图的推荐参数：

```json
{
  "action": "batch",
  "args": {
    "label": "人物构图与自然调色",
    "commands": [
      { "action": "crop", "args": { "x": 200, "y": 100, "width": 2000, "height": 2000 } },
      { "action": "adjust", "args": { "layerId": "从当前状态读取", "contrast": 4, "shadows": 10, "highlights": -12 } }
    ]
  }
}
```

执行前按实际图像重算裁剪框并替换图层 ID。批处理最多 100 条兼容命令，出错整体回滚。

## 格式与尺寸边界

- 当前编辑为 8 位 RGB/sRGB；不支持 RAW、16/32 位、完整 ICC/CMYK 流程。
- 文档边长最多 16384、总像素最多 4000 万；8K 单图 RGBA 约 127 MiB，复制和历史还会增加内存。
- `crop` 只平移图层与改变画布，`.cwdoc` 可保留裁掉的原始像素；重新扩大画布或移动图层能再利用这些像素。历史本身不写入工程。
- PSD 导出可能栅格化文字、形状、变换和效果；存在调整图层时可能合成为单层。保留本版编辑结构优先 `.cwdoc`。
- 普通照片导出 JPEG 当前质量固定 0.94。PNG 支持透明，JPEG 透明区域填白。

软件完整边界在安装目录的 `FEATURE_PARITY.md`；只有任务涉及对应格式/功能时才读取。

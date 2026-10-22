import { useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  Circle,
  Copy,
  FolderOpen,
  LoaderCircle,
  PlugZap,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import type { CodexSetupStatus, CodexConnectionResult } from "./types";

const examplePrompt =
  "使用 compositor-windows-edit Skill，先查看 Compositor 中打开的照片，保留人物，调暖色调并轻微提亮阴影，另存为新文件。";

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function CodexSetup({ onOpenPhoto }: { onOpenPhoto: () => void }) {
  const bridge = window.desktop;
  const available = !!bridge;
  const [status, setStatus] = useState<CodexSetupStatus | null>(null);
  const [busy, setBusy] = useState<"status" | "setup" | "check" | "choose" | null>(
    available ? "status" : null,
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [test, setTest] = useState<CodexConnectionResult | null>(null);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (available) {
      bridge!.getCodexStatus!()
        .then((result) => {
          if (mounted.current) setStatus(result);
        })
        .catch((cause) => {
          if (mounted.current)
            setError("无法读取配置状态：" + readableError(cause));
        })
        .finally(() => {
          if (mounted.current) setBusy(null);
        });
    }
    return () => {
      mounted.current = false;
    };
  }, []);

  async function configure() {
    if (!available || busy) return;
    setBusy("setup");
    setError("");
    setNotice("");
    setTest(null);
    try {
      const result = await bridge!.setupCodex!();
      if (!mounted.current) return;
      setStatus(result);
      if (result.configured)
        setNotice("Skill 和 MCP 配置已保存。");
      else setError(result.message || "配置未完成，请重试。");
    } catch (cause) {
      if (mounted.current)
        setError("配置未完成：" + readableError(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function chooseExecutable() {
    if (!bridge?.chooseCodexExecutable || busy) return;
    setBusy("choose");
    setError("");
    try {
      const result = await bridge.chooseCodexExecutable();
      if (mounted.current && result) setStatus(result);
    } catch (cause) {
      if (mounted.current)
        setError("无法使用所选程序：" + readableError(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function checkConnection() {
    if (!available || busy) return;
    setBusy("check");
    setError("");
    setTest(null);
    try {
      const result = await bridge!.checkCodexConnection!();
      if (mounted.current) setTest(result);
    } catch (cause) {
      if (mounted.current)
        setError("连接测试未完成：" + readableError(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function refreshStatus() {
    if (!available || busy) return;
    setBusy("status");
    setError("");
    try {
      const result = await bridge!.getCodexStatus!();
      if (mounted.current) setStatus(result);
    } catch (cause) {
      if (mounted.current)
        setError("无法读取配置状态：" + readableError(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(examplePrompt);
      if (mounted.current) setCopied(true);
    } catch {
      if (mounted.current)
        setError("复制失败，请选中下方示例文字后复制。");
    }
  }

  return (
    <section className="codex-setup" aria-labelledby="codex-setup-title">
      <div className="codex-setup-heading">
        <div className="codex-mark"><Sparkles size={19} /></div>
        <div>
          <h2 id="codex-setup-title">用 Codex 修图</h2>
          <span>你描述想法，Codex 操作画布</span>
        </div>
      </div>
      <p className="codex-intro">
        一次配置 Skill 与 MCP，之后在 Codex 对话里直接提出修图要求。
        需先安装并登录 Codex。
      </p>

      <div className="codex-config-card" aria-busy={!!busy}>
        <div className="codex-card-heading">
          <span>本机配置</span>
          <button
            className="codex-refresh"
            title="刷新配置状态"
            aria-label="刷新配置状态"
            onClick={refreshStatus}
            disabled={!available || !!busy}
          >
            <RefreshCw size={13} className={busy === "status" ? "codex-spinning" : ""} />
          </button>
        </div>
        {([
          ["skill", "修图 Skill", "教 Codex 怎样操作编辑器"],
          ["mcp", "MCP 连接", "让 Codex 查看和编辑画布"],
        ] as const).map(([key, label, description]) => {
          const configured = key === "skill" ? status?.skill.installed : status?.mcp.registered;
          return (
            <div className="codex-config-row" key={key}>
              {configured ? <CheckCircle2 size={16} /> : <Circle size={16} />}
              <div><strong>{label}</strong><small>{description}</small></div>
              <span className={configured ? "configured" : ""}>
                {!available ? "桌面版可用" : busy === "status" ? "检查中" : configured ? "已配置" : status ? "待配置" : "未知"}
              </span>
            </div>
          );
        })}
        {status && !status.codex.available && (
          <div className="codex-missing">
            <p>未找到 Codex。请先安装并登录；如果已经安装，可以手动选择程序。</p>
            <button onClick={chooseExecutable} disabled={!!busy || !bridge?.chooseCodexExecutable}>
              <FolderOpen size={13} />{busy === "choose" ? "选择中…" : "选择 Codex 程序"}
            </button>
          </div>
        )}
        <button
          className="primary codex-connect-button"
          onClick={configure}
          disabled={!available || !!busy || !status?.codex.available}
        >
          {busy === "setup" ? <LoaderCircle size={16} className="codex-spinning" /> : <PlugZap size={16} />}
          {busy === "setup" ? "正在配置…" : status?.configured ? "更新 / 修复配置" : "一键连接 Codex"}
        </button>
        <p className="codex-config-footnote">
          {available
            ? "点击后安装配套 Skill 并登记 MCP；更新已有配置时会保存备份。"
            : "请在安装后的 Windows 软件中完成一键配置。"}
        </p>
      </div>

      <div className="codex-feedback" aria-live="polite" aria-atomic="true">
        {error && <p className="codex-message error"><TriangleAlert size={14} /><span>{error}</span></p>}
        {notice && <p className="codex-message success"><CheckCircle2 size={14} /><span>{notice}</span></p>}
        {status?.configured && (
          <p className="codex-restart-note">
            配置已就绪。请重启 Codex 并新建聊天，让它加载 Skill 和 MCP；首次调用时按 Codex 提示允许使用工具。
          </p>
        )}
        {!error && status?.message && <p className="codex-config-footnote">{status.message}</p>}
      </div>

      <div className="codex-next-step">
        <div className="codex-step-heading"><span>接下来</span><span>2 个简单步骤</span></div>
        <button className="codex-open-photo" onClick={onOpenPhoto}>
          <FolderOpen size={15} /><span>打开要编辑的照片</span>
        </button>
        <div className="codex-prompt">
          <div><strong>在 Codex 聊天里说</strong><button onClick={copyPrompt} aria-label="复制修图提示词"><Copy size={12} />{copied ? "已复制" : "复制"}</button></div>
          <p>{examplePrompt}</p>
        </div>
      </div>

      <button
        className="codex-test-button"
        onClick={checkConnection}
        disabled={!available || !!busy || !status?.configured}
      >
        {busy === "check" ? <LoaderCircle size={14} className="codex-spinning" /> : <Check size={14} />}
        {busy === "check" ? "正在测试…" : "测试本机连接"}
      </button>
      <div aria-live="polite">
        {test && (
          <p className={"codex-message " + (test.ok ? "success" : "error")}>
            {test.ok ? <CheckCircle2 size={14} /> : <TriangleAlert size={14} />}
            <span>{test.message}{test.documentName ? ` 当前文档：${test.documentName}` : ""}</span>
          </p>
        )}
      </div>
      <p className="codex-config-footnote">测试检查本机桥接是否可用；Codex 是否已加载工具，请在 Codex 中确认。</p>

      {status && (
        <details className="codex-config-details">
          <summary>配置位置与备份</summary>
          <p>Codex 目录<code>{status.codex.home}</code></p>
          <p>Skill<code>{status.skill.path}</code></p>
          <p>MCP 名称<code>{status.mcp.name}</code></p>
          {status.backupDirectory && <p>备份<code>{status.backupDirectory}</code></p>}
        </details>
      )}
    </section>
  );
}

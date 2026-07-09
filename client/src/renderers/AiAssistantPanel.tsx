import { useEffect, useRef, useState } from "react";
import { Bot, FileSpreadsheet, Image, Paperclip, Send, Sparkles, X } from "lucide-react";
import { GatewayClient } from "../api/GatewayClient";
import { MarkdownContent } from "./MarkdownContent";
import { useToast } from "../context/ToastContext";

type Message = {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  progress?: Array<{ title: string; message: string; stage: string; toolName?: string; status?: string }>;
};

type AttachmentItem = {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storageUrl: string;
};

export function AiAssistantPanel({ schemaName, initialSessionId, onClose, onNavigate }: { schemaName: string; initialSessionId?: string; onClose: () => void; onNavigate?: (pageCode: string, filters?: Record<string, unknown>) => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  useEffect(() => {
    setSessionId(initialSessionId);
    if (!initialSessionId) return;
    GatewayClient.getActiveChatSession(schemaName, initialSessionId)
      .then((res) => {
        setSessionId(res.sessionId || initialSessionId);
        setMessages(res.messages.filter((msg) => msg.role === "user" || msg.role === "assistant").map((msg) => ({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        })));
      })
      .catch(() => toast.error("加载对话记录失败"));
  }, [schemaName, initialSessionId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  function fileToBase64(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
      reader.readAsDataURL(file);
    });
  }

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const contentBase64 = await fileToBase64(file);
      const res = await GatewayClient.uploadAgentAttachment({
        schemaName,
        sessionId,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        contentBase64,
      });
      setAttachments((prev) => [...prev, res.attachment]);
    } catch (err) {
      toast.error(`上传失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  }

  async function send(textOverride?: string) {
    const text = (textOverride ?? input).trim();
    if ((!text && attachments.length === 0) || sending) return;
    const currentAttachments = attachments;
    setInput("");
    setAttachments([]);
    const assistantIndex = messages.length + 1;
    setMessages((prev) => [
      ...prev,
      { role: "user", content: `${text || "请处理附件"}${currentAttachments.length ? `\n附件：${currentAttachments.map((item) => item.fileName).join("、")}` : ""}` },
      { role: "assistant", content: "", streaming: true, progress: [] },
    ]);
    setSending(true);
    let streamedSummary = "";
    let streamedText = "";
    try {
      const result = await GatewayClient.tenantAssistantChatStream(schemaName, text || "请分析附件并给出处理建议", sessionId, currentAttachments.map((item) => item.id), {
        onProgress: (event) => {
          if (!event.visibleToTenant) return;
          // 业务导航：收到 navigate 工具结果时直接打开目标页面
          if (event.toolName === "navigate" && onNavigate) {
            try {
              const nav = JSON.parse(event.message) as { pageCode?: string; filters?: Record<string, unknown> };
              if (nav.pageCode) onNavigate(nav.pageCode, nav.filters);
            } catch { /* ignore */ }
          }
          setMessages((prev) => prev.map((msg, index) => index === assistantIndex ? {
            ...msg,
            progress: [...(msg.progress ?? []), { title: event.title, message: event.message, stage: event.stage, toolName: event.toolName, status: event.status }],
          } : msg));
        },
        onDelta: (delta) => {
          streamedText += delta;
          setMessages((prev) => prev.map((msg, index) => index === assistantIndex ? { ...msg, content: streamedText } : msg));
        },
        onSummary: (summary) => {
          streamedSummary = summary;
          setMessages((prev) => prev.map((msg, index) => index === assistantIndex ? { ...msg, content: summary } : msg));
        },
      });
      setSessionId(result.sessionId);
      setMessages((prev) => prev.map((msg, index) => index === assistantIndex ? {
        ...msg,
        content: streamedSummary || streamedText || result.reply,
        streaming: false,
      } : msg));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message);
      setMessages((prev) => prev.map((msg, index) => index === assistantIndex ? { ...msg, content: `处理失败：${message}`, streaming: false } : msg));
    } finally {
      setSending(false);
    }
  }

  const quickPrompts = [
    "帮我查询今天新增学员",
    "按当前管理架构统计收款情况",
    "先校验我上传的 Excel 导入顺序",
  ];

  return (
    <div className="fixed inset-0 z-[200]">
      <div className="absolute inset-0 bg-black/35" onClick={onClose} />
      <aside className="absolute right-0 top-0 flex h-full w-[520px] max-w-[100vw] flex-col bg-white shadow-[-12px_0_34px_rgba(15,23,42,0.22)]">
        <div className="flex h-14 items-center justify-between border-b border-[#e8edf5] px-5">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center bg-[#eef5ff] text-[#2f80ed]"><Bot className="h-5 w-5" /></span>
            <div>
              <div className="text-base font-semibold text-[#172033]">AI 助手</div>
              <div className="text-xs text-[#7a8494]">按当前账号和管理架构的数据权限执行</div>
            </div>
          </div>
          <button className="text-[#8b95a7] hover:text-[#263445]" onClick={onClose}><X className="h-5 w-5" /></button>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-[#f6f8fb] px-5 py-4">
          {messages.length === 0 && (
            <div className="space-y-4">
              <div className="border border-[#dbe5f2] bg-white p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#263445]"><Sparkles className="h-4 w-4 text-[#2f80ed]" />可以帮你做什么</div>
                <div className="grid gap-2 text-sm text-[#526075]">
                  <div>查询当前权限内的学员、合同、收款、排课等数据</div>
                  <div>根据自然语言调用已有业务接口完成操作</div>
                  <div>上传图片或 Excel，解析、清洗并按依赖顺序导入</div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {quickPrompts.map((prompt) => (
                  <button key={prompt} className="border border-[#d9e3ef] bg-white px-3 py-2 text-sm text-[#526075] hover:border-[#2f80ed] hover:text-[#2f80ed]" onClick={() => void send(prompt)}>
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-4">
            {messages.map((msg, index) => (
              <div key={index} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[86%] px-4 py-3 text-sm leading-6 shadow-sm ${msg.role === "user" ? "bg-[#2f80ed] text-white" : "border border-[#e2e8f2] bg-white text-[#263445]"}`}>
                  {msg.progress && msg.progress.length > 0 && (
                    <div className="mb-3 space-y-1 border-b border-[#edf1f6] pb-2">
                      {msg.progress.map((event, eventIndex) => (
                        <div key={`${event.stage}-${eventIndex}`} className="flex items-start gap-2 text-xs text-[#607083]">
                          <span className={`mt-1 h-1.5 w-1.5 shrink-0 ${event.status === "success" ? "bg-[#25a55f]" : "bg-[#2f80ed]"}`} />
                          <div>
                            <span className="font-medium text-[#263445]">{event.toolName ?? event.title}</span>
                            <span className="ml-1">{event.message}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <MarkdownContent content={msg.content || (msg.streaming ? "正在处理..." : "")} inverse={msg.role === "user"} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-[#e8edf5] bg-white p-4">
          {attachments.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {attachments.map((item) => (
                <span key={item.id} className="inline-flex max-w-full items-center gap-2 border border-[#d9e3ef] bg-[#f8fafc] px-2 py-1 text-xs text-[#526075]">
                  {item.mimeType.startsWith("image/") ? <Image className="h-3.5 w-3.5" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
                  <span className="max-w-[260px] truncate">{item.fileName}</span>
                  <button onClick={() => setAttachments((prev) => prev.filter((att) => att.id !== item.id))}>×</button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <label className="flex h-10 cursor-pointer items-center justify-center border border-[#d9e3ef] px-3 text-[#526075] hover:border-[#2f80ed] hover:text-[#2f80ed]">
              <Paperclip className="h-4 w-4" />
              <input
                type="file"
                className="hidden"
                accept=".xlsx,.xls,.csv,image/*"
                disabled={uploading || sending}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.currentTarget.value = "";
                  files.forEach((file) => void uploadFile(file));
                }}
                multiple
              />
            </label>
            <input
              className="h-10 min-w-0 flex-1 border border-[#d9e3ef] px-3 text-sm outline-none focus:border-[#2f80ed]"
              value={input}
              placeholder="问数据、做业务操作，或上传 Excel 后说“校验导入”"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              disabled={sending}
            />
            <button className="flex h-10 items-center gap-2 bg-[#2f80ed] px-4 text-sm font-medium text-white hover:bg-[#1c6fd8] disabled:opacity-50" onClick={() => void send()} disabled={sending || (!input.trim() && attachments.length === 0)}>
              <Send className="h-4 w-4" />
              发送
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

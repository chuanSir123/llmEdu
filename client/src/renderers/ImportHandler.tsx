import { useState } from "react";
import { GatewayClient } from "../api/GatewayClient";
import type { PageDsl } from "../dsl/types";

type ImportHandlerProps = {
  dsl: PageDsl;
  scope: "admin" | "tenant";
  schemaName?: string;
  importConfig?: Record<string, unknown>;
  onComplete: () => void;
};

type ImportMode = "import" | "validate";
type CachedImportFile = { fileName: string; contentBase64: string };
type IdResolutionStrategy = "first" | "error";
type ValidatedImportFile = CachedImportFile & { idResolutionStrategy: IdResolutionStrategy };

export function ImportHandler({ dsl, scope, schemaName, importConfig, onComplete }: ImportHandlerProps) {
  const [importing, setImporting] = useState(false);
  const [phase, setPhase] = useState("");
  const [mode, setMode] = useState<ImportMode>("validate");
  const [idResolutionStrategy, setIdResolutionStrategy] = useState<IdResolutionStrategy>("error");
  const [lastFile, setLastFile] = useState<CachedImportFile | null>(null);
  const [validatedFile, setValidatedFile] = useState<ValidatedImportFile | null>(null);
  const [result, setResult] = useState<{ mode?: ImportMode; total: number; success: number; failed: number; resultUrl?: string; resultName?: string; errors?: string[] } | null>(null);

  const apiCode = (importConfig?.apiCode as string) ?? dsl.createApi;
  const configuredFields = Array.isArray(importConfig?.fields)
    ? importConfig.fields as Array<{ key: string; label?: string; title?: string; required?: boolean }>
    : [];
  const formFields = dsl.modal?.fields ?? [];
  const rawTemplateColumns = configuredFields.length > 0
    ? configuredFields
    : formFields.length > 0
      ? formFields
      : dsl.table?.columns ?? [];
  const templateColumns = rawTemplateColumns.map((field) => ({
    ...field,
    valueLabels: dsl.presentation?.valueLabels?.[field.key],
  }));

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setPhase("正在读取文件");
    setResult(null);
    setValidatedFile(null);

    try {
      const contentBase64 = await fileToBase64(file);
      const cached = { fileName: file.name, contentBase64 };
      setLastFile(cached);
      await submitImport(cached, mode, idResolutionStrategy);
    } catch (err) {
      setResult({ total: 0, success: 0, failed: 0, errors: [`导入失败: ${err instanceof Error ? err.message : String(err)}`] });
    } finally {
      setImporting(false);
      setPhase("");
      e.target.value = "";
    }
  }

  function fileToBase64(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
      reader.readAsDataURL(file);
    });
  }

  async function submitImport(file: CachedImportFile, requestedMode: ImportMode, requestedStrategy: IdResolutionStrategy) {
    setPhase(requestedMode === "validate" ? "正在解析名称和校验数据" : "正在解析名称和写入数据");
    const res = await GatewayClient.executeImport({
      schemaName: schemaName ?? "",
      pageCode: dsl.pageCode,
      apiCode,
      fileName: file.fileName,
      contentBase64: file.contentBase64,
      fields: templateColumns as Array<Record<string, unknown>>,
      idResolutionStrategy: requestedStrategy,
      mode: requestedMode,
    });
    setPhase("正在生成结果文件");
    setResult({
      mode: res.mode,
      total: res.total,
      success: res.success,
      failed: res.failed,
      resultUrl: res.resultFile.storageUrl,
      resultName: res.resultFile.fileName,
    });
    if (requestedMode === "validate") {
      setValidatedFile(res.total > 0 && res.failed === 0 ? { ...file, idResolutionStrategy: requestedStrategy } : null);
    }
    if (requestedMode === "import" && res.success > 0) onComplete();
  }

  async function importLastValidatedFile() {
    if (!validatedFile) return;
    setMode("import");
    setImporting(true);
    setResult(null);
    try {
      await submitImport(validatedFile, "import", validatedFile.idResolutionStrategy);
    } catch (err) {
      setResult({ total: 0, success: 0, failed: 0, errors: [`导入失败: ${err instanceof Error ? err.message : String(err)}`] });
    } finally {
      setImporting(false);
      setPhase("");
    }
  }

  async function downloadTemplate() {
    const blob = await GatewayClient.downloadImportTemplate({
      schemaName: schemaName ?? "",
      title: `${dsl.title}_导入模板`,
      pageCode: dsl.pageCode,
      apiCode,
      fields: templateColumns as Array<Record<string, unknown>>,
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${dsl.title}_导入模板.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function downloadResult() {
    if (!result?.resultUrl) return;
    const urlWithSchema = schemaName
      ? `${result.resultUrl}${result.resultUrl.includes("?") ? "&" : "?"}schemaName=${encodeURIComponent(schemaName)}`
      : result.resultUrl;
    const blob = await GatewayClient.downloadAttachment(urlWithSchema);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.resultName ?? `${dsl.title}_导入结果.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <select
          className="h-8 rounded border border-[#dde3ee] bg-white px-2 text-xs text-[#526075]"
          value={mode}
          onChange={(event) => setMode(event.target.value as "import" | "validate")}
          disabled={importing}
        >
          <option value="validate">只校验不写入</option>
          <option value="import">正式导入写入</option>
        </select>
        <select
          className="h-8 rounded border border-[#dde3ee] bg-white px-2 text-xs text-[#526075]"
          value={idResolutionStrategy}
          onChange={(event) => {
            setIdResolutionStrategy(event.target.value as IdResolutionStrategy);
            setValidatedFile(null);
          }}
          disabled={importing}
        >
          <option value="error">名称重名则失败</option>
          <option value="first">名称重名取第一个</option>
        </select>
        <label className="cursor-pointer rounded border border-[#dde3ee] px-3 py-1.5 text-xs text-[#526075] hover:bg-[#f2f7ff]">
          {importing ? "处理中..." : mode === "validate" ? "选择文件并校验" : "选择文件并导入"}
          <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} disabled={importing || scope !== "tenant"} />
        </label>
        <button className="text-xs text-[#4968ff] hover:underline" onClick={() => void downloadTemplate()}>下载导入模板</button>
      </div>
      {importing && (
        <div className="rounded border border-[#dbe7ff] bg-[#f3f7ff] p-3 text-xs text-[#2f64c8]">
          {phase || "正在导入"}...
        </div>
      )}
      {result && (
        <div className="rounded border border-[#e8edf5] bg-[#f7f9fc] p-3 text-xs">
          <div className="text-[#263445]">
            {result.mode === "validate" ? "校验完成" : "导入完成"}：共 {result.total} 条，通过 {result.success} 条，失败 {result.failed} 条
          </div>
          {result.resultUrl && (
            <button className="mt-2 inline-block text-[#4968ff] hover:underline" onClick={() => void downloadResult()}>
              下载导入结果 Excel
            </button>
          )}
          {result.mode === "validate" && result.total > 0 && result.failed === 0 && validatedFile && (
            <button
              className="ml-3 mt-2 inline-block rounded border border-[#4968ff] px-3 py-1 text-[#4968ff] hover:bg-[#eef3ff]"
              onClick={() => void importLastValidatedFile()}
              disabled={importing || scope !== "tenant"}
            >
              正式导入此文件
            </button>
          )}
          {(result.errors ?? []).length > 0 && (
            <div className="mt-2 space-y-1">
              {(result.errors ?? []).map((err, i) => (
                <div key={i} className="text-red-600">{err}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { GatewayClient } from "../api/GatewayClient";
import { token } from "../styles/designTokens";
import { SearchSelect, type SearchSelectSource } from "./SearchSelect";

// 排课弹窗的"学员-合同产品"逐行编辑器（field.type === "student_cp_table"）：
// 每行一个学员 + 该学员名下的合同产品（选项按学员过滤，显示签约时间/剩余课时）；
// 合同产品留空时后端按 course_create_rule.contractProductMatch 自动匹配。
// 值形态与后端 course.create/update 的 students 入参一致：[{ student_id, contract_product_id }]

type EditorRow = { student_id?: string; contract_product_id?: string };
type Option = { value: string; label: string; hint?: string };

export function StudentContractRows({
  scope,
  schemaName,
  value,
  onChange,
  studentOptions,
  studentSource
}: {
  scope: "admin" | "tenant";
  schemaName?: string;
  value: unknown;
  onChange: (rows: EditorRow[]) => void;
  studentOptions: Option[];
  studentSource?: SearchSelectSource;
}) {
  const rows: EditorRow[] = Array.isArray(value) ? (value as EditorRow[]) : [];
  const [cpOptions, setCpOptions] = useState<Record<string, Option[]>>({});
  const loadingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    async function loadCpOptions(studentId: string) {
      if (!studentId || cpOptions[studentId] || loadingRef.current.has(studentId)) return;
      loadingRef.current.add(studentId);
      try {
        const contractsRes = await GatewayClient.executeApi({
          scope,
          schemaName,
          pageCode: "contract_list",
          apiCode: "contract_list.query",
          params: { filters: { student_id: studentId }, page: 1, pageSize: 50 }
        });
        const contracts = ((contractsRes.data as { rows?: Record<string, unknown>[] }).rows ?? [])
          .filter((contract) => String(contract.contract_status ?? "").includes("ACTIVE"));
        const options: Option[] = [];
        for (const contract of contracts) {
          const cpRes = await GatewayClient.executeApi({
            scope,
            schemaName,
            pageCode: "contract_product_list",
            apiCode: "contract_product_list.query",
            params: { filters: { contract_id: contract.id }, page: 1, pageSize: 50 }
          });
          for (const cp of ((cpRes.data as { rows?: Record<string, unknown>[] }).rows ?? [])) {
            const signDate = String(contract.sign_time ?? "").slice(0, 10);
            options.push({
              value: String(cp.id),
              label: String(cp.product_name ?? cp.product_id ?? "产品"),
              hint: `签约${signDate || "-"} · 剩${String(cp.remaining_real_hour ?? 0)}课时(赠${String(cp.remaining_promotion_hour ?? 0)})`
            });
          }
        }
        if (!cancelled) setCpOptions((current) => ({ ...current, [studentId]: options }));
      } catch {
        if (!cancelled) setCpOptions((current) => ({ ...current, [studentId]: [] }));
      } finally {
        loadingRef.current.delete(studentId);
      }
    }
    for (const row of rows) {
      if (row.student_id) void loadCpOptions(String(row.student_id));
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(rows.map((row) => row.student_id ?? "")), scope, schemaName]);

  const patchRow = (index: number, patch: EditorRow) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const removeRow = (index: number) => onChange(rows.filter((_, i) => i !== index));
  const addRow = () => onChange([...rows, {}]);
  const chosenStudents = (excludeIndex: number) =>
    new Set(rows.filter((_, i) => i !== excludeIndex).map((row) => String(row.student_id ?? "")).filter(Boolean));

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border border-[#dbe5f2] bg-white">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-[#f3f7fc] text-[#526075]">
            <tr>
              <th className="w-[30%] px-2 py-2 text-left">学员</th>
              <th className="w-[58%] px-2 py-2 text-left">合同产品（留空按规则自动匹配）</th>
              <th className="w-[12%] px-2 py-2 text-center">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const studentId = String(row.student_id ?? "");
              const used = chosenStudents(index);
              const options = cpOptions[studentId];
              return (
                <tr key={index} className="border-t border-[#eef2f7]">
                  <td className="px-2 py-2">
                    <SearchSelect
                      scope={scope}
                      schemaName={schemaName}
                      value={studentId}
                      placeholder="请选择学员"
                      options={studentOptions}
                      optionSource={studentSource}
                      excludeValues={[...used]}
                      onChange={(next) => patchRow(index, { student_id: next || undefined, contract_product_id: undefined })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <SearchSelect
                      value={String(row.contract_product_id ?? "")}
                      disabled={!studentId}
                      placeholder={!studentId ? "先选择学员" : options === undefined ? "加载中..." : options.length ? "自动匹配（按排课产品/年级/科目）" : "暂无可用合同产品，将走自动匹配"}
                      clearLabel="自动匹配（按排课产品/年级/科目）"
                      options={(options ?? []).concat(
                        row.contract_product_id && !(options ?? []).some((option) => option.value === String(row.contract_product_id))
                          ? [{ value: String(row.contract_product_id), label: `当前绑定: ${String(row.contract_product_id)}` }]
                          : []
                      )}
                      onChange={(next) => patchRow(index, { contract_product_id: next || undefined })}
                    />
                  </td>
                  <td className="px-2 py-2 text-center">
                    <button type="button" className="text-[#ff4d64] hover:text-[#e63d52]" onClick={() => removeRow(index)}>删除</button>
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td className="px-3 py-4 text-center text-[#8b95a7]" colSpan={3}>暂无学员，点击下方「添加学员」</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <button type="button" className={`${token.button} ${token.defaultButton} h-8`} onClick={addRow}>+ 添加学员</button>
    </div>
  );
}

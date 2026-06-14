import { executeGatewayApi } from "./api-executor.js";

export async function executeAction(scope: "admin" | "tenant", schemaName: string, actionCode: string, params: Record<string, unknown>) {
  const apiCode = String(params.apiCode ?? actionCode.replace(/\.(create|edit|detail|delete|refresh)$/, (match) => {
    if (match === ".edit") return ".update";
    if (match === ".refresh") return ".query";
    return match;
  }));
  return executeGatewayApi(scope, schemaName, apiCode, params);
}

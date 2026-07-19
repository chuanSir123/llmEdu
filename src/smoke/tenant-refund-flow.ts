import { pool } from "../db/pool.js";
import { createTenantWithModules } from "../tenant/tenant-create.service.js";
import { executeGatewayApi } from "../gateway/api-executor.js";
import type { SessionUser } from "../types.js";
import { assert, cleanupTenant } from "./smoke-utils.js";

type Row = Record<string, unknown>;

function idOf(value: unknown) {
  return String((value as Row | undefined)?.id ?? "");
}

async function one(sql: string, values: unknown[]) {
  const { rows } = await pool.query(sql, values);
  return rows[0] as Row | undefined;
}

async function createPaidContract(schemaName: string, user: SessionUser, label: string) {
  const student = await executeGatewayApi("tenant", schemaName, "student_list.create", {
    data: {
      name: `${label}学员`,
      contact: `138${Math.floor(Math.random() * 100000000).toString().padStart(8, "0")}`,
      organization_id: "org_head",
      student_status: "FORMAL",
    },
  }, user) as Row;
  const studentId = idOf(student);
  assert(studentId, `${label}学员创建失败`);

  const product = await executeGatewayApi("tenant", schemaName, "product_list.create", {
    data: {
      name: `${label}课程包`,
      product_type: "ONE_ON_ONE_COURSE",
      unit_price: 200,
      default_course_hour: 10,
      total_amount: 2000,
      status: "ACTIVE",
    },
  }, user) as Row;
  const productId = idOf(product);
  assert(productId, `${label}产品创建失败`);

  const contractResult = await executeGatewayApi("tenant", schemaName, "contract_list.create", {
    data: {
      student_id: studentId,
      product_ids: [productId],
      contract_type: "ONE_ON_ONE_COURSE",
      organization_id: "org_head",
      sign_staff_id: "user_owner",
    },
  }, user) as { contract?: Row; contractProducts?: Row[] };
  const contractId = String(contractResult.contract?.id ?? "");
  const contractProductId = String(contractResult.contractProducts?.[0]?.id ?? "");
  assert(contractId && contractProductId, `${label}合同创建失败`);

  await executeGatewayApi("tenant", schemaName, "funds_history.create", {
    data: {
      contract_id: contractId,
      student_id: studentId,
      organization_id: "org_head",
      transaction_amount: 1000,
      pay_way_config_id: "pay_cash",
      funds_type: "CONTRACT_PAY",
    },
  }, user);

  return { studentId, productId, contractId, contractProductId };
}

async function main() {
  let schemaName = "";
  try {
    const created = await createTenantWithModules({
      name: "退费冒烟机构",
      contactPhone: "19900006666",
      ownerName: "退费校长",
      selectedModules: ["frontdesk", "student", "finance", "education", "system"],
      selectedFeatures: [
        "frontdesk_home",
        "student_list",
        "product_list",
        "contract_list",
        "contract_product_list",
        "funds_history",
        "refund_record",
        "organization_list",
        "user_list",
        "role_list",
      ],
      operatorId: "smoke_admin",
    });
    schemaName = created.schemaName;
    const user: SessionUser = { kind: "tenant", userId: "user_owner", name: "退费校长", schemaName };

    const productRefundCase = await createPaidContract(schemaName, user, "产品退费");
    const productRefund = await executeGatewayApi("tenant", schemaName, "refund_record.create", {
      data: {
        student_id: productRefundCase.studentId,
        contract_product_id: productRefundCase.contractProductId,
        refund_real_hour: 1,
        refund_real_amount: 200,
        refund_way_config_id: "pay_cash",
        refund_time: "2026-07-04T09:00:00+08:00",
        remark: "产品退费冒烟",
      },
    }, user) as Row;
    const productRefundId = idOf(productRefund);
    assert(productRefundId, "产品退费记录未创建");

    const cpAfterProductRefund = await one(
      `select consumed_real_hour, consumed_real_amount, remaining_real_hour, remaining_real_amount from "${schemaName}".contract_product where id = $1`,
      [productRefundCase.contractProductId]
    );
    const contractAfterProductRefund = await one(
      `select paid_amount, paid_status, contract_status from "${schemaName}".contract where id = $1`,
      [productRefundCase.contractId]
    );
    assert(Number(cpAfterProductRefund?.consumed_real_hour) === 0, "产品退费不应改动已消耗课时");
    assert(Number(cpAfterProductRefund?.consumed_real_amount) === 0, "产品退费不应改动已消耗金额");
    assert(Number(cpAfterProductRefund?.remaining_real_hour) === 4, "产品退费后合同产品剩余课时异常");
    assert(Number(cpAfterProductRefund?.remaining_real_amount) === 800, "产品退费后合同产品剩余金额异常");
    assert(Number(contractAfterProductRefund?.paid_amount) === 800, "产品退费后合同已收金额异常");
    assert(contractAfterProductRefund?.paid_status === "PART_PAID", "产品退费后合同付款状态异常");

    await executeGatewayApi("tenant", schemaName, "refund.delete", { id: productRefundId }, user);
    const cpAfterProductRefundDelete = await one(
      `select consumed_real_hour, consumed_real_amount, remaining_real_hour, remaining_real_amount from "${schemaName}".contract_product where id = $1`,
      [productRefundCase.contractProductId]
    );
    const contractAfterProductRefundDelete = await one(
      `select paid_amount, paid_status, contract_status from "${schemaName}".contract where id = $1`,
      [productRefundCase.contractId]
    );
    assert(Number(cpAfterProductRefundDelete?.consumed_real_hour) === 0, "删除产品退费不应改动已消耗课时");
    assert(Number(cpAfterProductRefundDelete?.consumed_real_amount) === 0, "删除产品退费不应改动已消耗金额");
    assert(Number(cpAfterProductRefundDelete?.remaining_real_hour) === 5, "删除产品退费后剩余课时未恢复");
    assert(Number(cpAfterProductRefundDelete?.remaining_real_amount) === 1000, "删除产品退费后剩余金额未恢复");
    assert(Number(contractAfterProductRefundDelete?.paid_amount) === 1000, "删除产品退费后合同已收未恢复");

    const contractRefundCase = await createPaidContract(schemaName, user, "合同退费");
    const contractRefund = await executeGatewayApi("tenant", schemaName, "contract.refund", {
      data: {
        contract_id: contractRefundCase.contractId,
        refund_real_hour: 2,
        refund_real_amount: 400,
        refund_way_config_id: "pay_cash",
        refund_time: "2026-07-04T10:00:00+08:00",
        remark: "合同退费冒烟",
      },
    }, user) as { refundRecords?: Row[]; totalRefundAmount?: number; contractStatus?: string };
    const contractRefundId = String(contractRefund.refundRecords?.[0]?.id ?? "");
    assert(contractRefundId, "合同退费未生成退费记录");
    assert(contractRefund.totalRefundAmount === 400, "合同退费金额汇总异常");

    const cpAfterContractRefund = await one(
      `select consumed_real_hour, consumed_real_amount, remaining_real_hour, remaining_real_amount from "${schemaName}".contract_product where id = $1`,
      [contractRefundCase.contractProductId]
    );
    const contractAfterContractRefund = await one(
      `select paid_amount, paid_status, contract_status from "${schemaName}".contract where id = $1`,
      [contractRefundCase.contractId]
    );
    assert(Number(cpAfterContractRefund?.consumed_real_hour) === 0, "合同退费不应改动已消耗课时");
    assert(Number(cpAfterContractRefund?.consumed_real_amount) === 0, "合同退费不应改动已消耗金额");
    assert(Number(cpAfterContractRefund?.remaining_real_hour) === 3, "合同退费后剩余课时异常");
    assert(Number(cpAfterContractRefund?.remaining_real_amount) === 600, "合同退费后剩余金额异常");
    assert(Number(contractAfterContractRefund?.paid_amount) === 600, "合同退费后合同已收金额异常");
    assert(contractAfterContractRefund?.contract_status === "ACTIVE", "部分合同退费不应关闭合同");

    await executeGatewayApi("tenant", schemaName, "refund.delete", { id: contractRefundId }, user);
    const cpAfterContractRefundDelete = await one(
      `select consumed_real_hour, consumed_real_amount, remaining_real_hour, remaining_real_amount from "${schemaName}".contract_product where id = $1`,
      [contractRefundCase.contractProductId]
    );
    const contractAfterContractRefundDelete = await one(
      `select paid_amount, paid_status, contract_status from "${schemaName}".contract where id = $1`,
      [contractRefundCase.contractId]
    );
    assert(Number(cpAfterContractRefundDelete?.consumed_real_hour) === 0, "删除合同退费不应改动已消耗课时");
    assert(Number(cpAfterContractRefundDelete?.consumed_real_amount) === 0, "删除合同退费不应改动已消耗金额");
    assert(Number(cpAfterContractRefundDelete?.remaining_real_hour) === 5, "删除合同退费后剩余课时未恢复");
    assert(Number(cpAfterContractRefundDelete?.remaining_real_amount) === 1000, "删除合同退费后剩余金额未恢复");
    assert(Number(contractAfterContractRefundDelete?.paid_amount) === 1000, "删除合同退费后合同已收未恢复");
    assert(contractAfterContractRefundDelete?.contract_status === "ACTIVE", "删除合同退费后合同状态异常");

    const activeRefunds = await one(`select count(*)::int as count from "${schemaName}".refund_record where deleted = false`, []);
    assert(Number(activeRefunds?.count) === 0, "删除退费后仍存在有效退费记录");

    console.log(JSON.stringify({
      ok: true,
      schemaName,
      productRefundId,
      contractRefundId,
      productRefundPaidAfterCreate: Number(contractAfterProductRefund?.paid_amount),
      contractRefundPaidAfterCreate: Number(contractAfterContractRefund?.paid_amount),
      activeRefunds: Number(activeRefunds?.count),
    }, null, 2));
  } finally {
    if (schemaName) await cleanupTenant(schemaName);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

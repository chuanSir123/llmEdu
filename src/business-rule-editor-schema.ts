export const businessRuleEditorSchema = {
  sections: {
    funds_allocation: {
      businessTypes: ["funds_create", "funds_delete", "contract_update"],
      selects: [
        { key: "fundsAllocation", label: "资金分配方式", dictCode: "funds_allocation_method" },
        { key: "splitBy", label: "拆分维度", dictCode: "allocation_split_by" },
        { key: "generateLogTable", label: "生成明细", dictCode: "generated_log_table" }
      ],
      switches: [
        { key: "updateContractPaidStatus", label: "自动更新合同收款状态" },
        { key: "allowPreStoreWithoutContract", label: "允许无合同预存" },
        { key: "allowManualAdjust", label: "允许手工调整" }
      ],
      rows: ["validations"]
    },
    promotion_allocation: {
      businessTypes: ["contract_create", "contract_update", "funds_create", "funds_delete"],
      selects: [
        { key: "promotionAllocation", label: "优惠分配方式", dictCode: "promotion_allocation_method" },
        { key: "splitBy", label: "拆分维度", dictCode: "allocation_split_by" },
        { key: "generateLogTable", label: "生成明细", dictCode: "generated_log_table" }
      ],
      switches: [
        { key: "requireAtLeastOneProduct", label: "合同至少包含一个产品" },
        { key: "snapshotPromotion", label: "签约时保存优惠快照" },
        { key: "allowManualAdjust", label: "允许手工调整" }
      ]
    },
    performance_allocation: {
      businessTypes: ["funds_create", "funds_delete", "contract_update", "performance", "performance_adjust"],
      selects: [
        { key: "performanceAllocation", label: "业绩分配方式", dictCode: "performance_allocation_method" },
        { key: "organizationPerformanceOwner", label: "校区业绩归属", dictCode: "organization_performance_owner" },
        { key: "personalPerformanceOwner", label: "个人业绩归属", dictCode: "personal_performance_owner" },
        { key: "productPriority", label: "产品优先级", dictCode: "product_priority" },
        { key: "generateLogTable", label: "生成明细", dictCode: "generated_log_table" }
      ],
      switches: [
        { key: "includePromotionAmount", label: "优惠金额计入业绩" },
        { key: "includeRefundDeduction", label: "退费自动冲减业绩" },
        { key: "allowManualAdjust", label: "允许手工调整" }
      ],
      numbers: [
        { key: "oneToOneWeight", label: "一对一权重", suffix: "%" },
        { key: "classCourseWeight", label: "班课权重", suffix: "%" }
      ]
    },
    validation: { businessTypes: ["course_create", "makeup", "product_price"], selects: [{ key: "targetApi", label: "校验接口", dictCode: "business_action_code" }], switches: [{ key: "preventTeacherTimeConflict", label: "防止老师时间冲突" }, { key: "preventStudentTimeConflict", label: "防止学员时间冲突" }, { key: "preventInvalidTimeRange", label: "防止无效时间范围" }], rows: ["validations"] },
    refund: { businessTypes: ["refund_create", "refund_delete", "contract_refund"], selects: [{ key: "refundAllocation", label: "退费冲减方式", dictCode: "refund_allocation_method" }], switches: [{ key: "allowRefundOverBalance", label: "允许超过余额退费" }, { key: "updateContractProductBalance", label: "自动更新产品余额" }, { key: "updateContractPaidStatus", label: "自动更新合同收款状态" }, { key: "autoRefundToEleAccount", label: "退回电子账户" }], rows: ["validations"] },
    charge: { businessTypes: ["charge", "charge_reverse", "course_delete"], selects: [{ key: "defaultChargeType", label: "默认扣费类型", dictCode: "charge_type" }], switches: [{ key: "allowNegativeBalance", label: "允许负余额扣费" }, { key: "updateContractProductBalance", label: "自动更新产品余额" }, { key: "autoCalculateChargeAmount", label: "自动计算扣费金额" }], rows: ["validations"] },
    attendance: { businessTypes: ["attendance", "leave", "course_delete"], switches: [{ key: "requireCheckInBeforeCharge", label: "签到后才允许扣费" }, { key: "autoCalculateChargeAmount", label: "按课时自动计算扣费" }, { key: "allowAfterFinished", label: "允许课后补签" }], rows: ["validations"] }
  }
};

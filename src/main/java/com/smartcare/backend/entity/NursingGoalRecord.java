package com.smartcare.backend.entity;

import lombok.Data;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.Map;

/**
 * 重症患者护理目标管理记录（手工录入）。
 * 一条记录 = 一个日期的各目标项填写值（项目编码 → 录入值），目标参考值固定打印在表格中。
 */
@Data
@Document(collection = "nursingGoalRecord")
@CompoundIndex(name = "idx_nursing_goal_pid_valid_date", def = "{'pid':1,'valid':1,'recordDate':1}")
public class NursingGoalRecord {
    @Id private String id;
    private String pid;
    /** 记录日期 YYYY-MM-DD */
    private String recordDate;
    /** 目标项编码 → 录入值（仅保存非空项） */
    private Map<String, String> values;
    /** 医生签名（账号姓名） */
    private String doctorSign;

    private Boolean valid = true;
    private Instant createdAt;
    private String createdBy;
    private Instant updatedAt;
    private String updatedBy;
}

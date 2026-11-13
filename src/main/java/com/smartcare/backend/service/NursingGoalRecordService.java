package com.smartcare.backend.service;

import com.smartcare.backend.entity.NursingGoalRecord;
import com.smartcare.backend.repository.NursingGoalRecordRepository;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

@Service
public class NursingGoalRecordService {
    /** 支持 yyyy-MM-dd 或 yyyy-MM-dd HH:mm（兼容 datetime-local 的 T 分隔） */
    private static final Pattern DATE_PATTERN = Pattern.compile("\\d{4}-\\d{2}-\\d{2}([ T]\\d{2}:\\d{2}(:\\d{2})?)?");

    private final NursingGoalRecordRepository repository;

    public NursingGoalRecordService(NursingGoalRecordRepository repository) {
        this.repository = repository;
    }

    public List<NursingGoalRecord> listValid(String pid) {
        if (!StringUtils.hasText(pid)) throw new IllegalArgumentException("pid不能为空");
        return repository.findByPidAndValidOrderByRecordDateAsc(pid.trim(), true);
    }

    public NursingGoalRecord save(NursingGoalRecord input) {
        if (!StringUtils.hasText(input.getPid())) throw new IllegalArgumentException("pid不能为空");
        String recordDate = input.getRecordDate() == null ? "" : input.getRecordDate().trim().replace('T', ' ');
        if (!DATE_PATTERN.matcher(recordDate).matches()) throw new IllegalArgumentException("记录时间格式应为yyyy-MM-dd HH:mm");
        // 统一为 yyyy-MM-dd HH:mm（仅日期时补 00:00）
        if (recordDate.length() == 10) recordDate = recordDate + " 00:00";
        else if (recordDate.length() > 16) recordDate = recordDate.substring(0, 16);
        boolean hasValues = input.getValues() != null && input.getValues().values().stream()
            .anyMatch(v -> v != null && !v.trim().isEmpty());
        if (!hasValues && !StringUtils.hasText(input.getDoctorSign())) {
            throw new IllegalArgumentException("请至少录入一项内容");
        }

        Instant now = Instant.now();
        if (StringUtils.hasText(input.getId())) {
            NursingGoalRecord existing = repository.findById(input.getId())
                .orElseThrow(() -> new IllegalArgumentException("记录不存在"));
            if (Boolean.FALSE.equals(existing.getValid())) throw new IllegalArgumentException("记录已删除");
            if (!existing.getPid().equals(input.getPid())) throw new IllegalArgumentException("禁止修改患者归属");
            checkDuplicate(input.getPid(), recordDate, input.getId());
            existing.setRecordDate(recordDate);
            existing.setValues(clean(input.getValues()));
            existing.setDoctorSign(StringUtils.hasText(input.getDoctorSign()) ? input.getDoctorSign().trim() : null);
            existing.setUpdatedAt(now);
            existing.setUpdatedBy(input.getUpdatedBy());
            return repository.save(existing);
        }
        checkDuplicate(input.getPid(), recordDate, null);
        input.setId(null);
        input.setRecordDate(recordDate);
        input.setValues(clean(input.getValues()));
        input.setDoctorSign(StringUtils.hasText(input.getDoctorSign()) ? input.getDoctorSign().trim() : null);
        input.setValid(true);
        input.setCreatedAt(now);
        input.setCreatedBy(input.getUpdatedBy());
        input.setUpdatedAt(now);
        return repository.save(input);
    }

    public void invalidate(String id, String operatorId) {
        NursingGoalRecord record = repository.findById(id)
            .orElseThrow(() -> new IllegalArgumentException("记录不存在"));
        record.setValid(false);
        record.setUpdatedAt(Instant.now());
        record.setUpdatedBy(operatorId);
        repository.save(record);
    }

    /** 同一患者同一日期只允许一条有效记录 */
    private void checkDuplicate(String pid, String recordDate, String excludeId) {
        List<NursingGoalRecord> sameDate = repository.findByPidAndRecordDateAndValid(pid, recordDate, true);
        boolean exists = sameDate.stream().anyMatch(r -> excludeId == null || !excludeId.equals(r.getId()));
        if (exists) throw new IllegalArgumentException("该日期已存在记录，请通过编辑修改");
    }

    /** 去掉空白值，避免空串占位 */
    private Map<String, String> clean(Map<String, String> values) {
        Map<String, String> result = new LinkedHashMap<>();
        if (values == null) return result;
        values.forEach((k, v) -> {
            if (k != null && v != null && !v.trim().isEmpty()) result.put(k.trim(), v.trim());
        });
        return result;
    }
}

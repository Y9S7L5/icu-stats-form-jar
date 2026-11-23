package com.smartcare.backend.controller;

import org.bson.Document;
import org.bson.types.ObjectId;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.web.bind.annotation.*;

import java.text.SimpleDateFormat;
import java.util.*;
import java.util.stream.Collectors;

/**
 * ICU 护理记录单打印数据接口
 * 一次性返回入科到出科（或当前时间）的全量数据，供前端离屏测量分页打印。
 * 不带 limit/skip，ICU 长住院几千行也一次性给全。
 */
@RestController
@RequestMapping("/api/v1/icu/hljld")
@CrossOrigin(origins = {"*"})
public class HljldPrintController {

    private static final Logger log = LoggerFactory.getLogger(HljldPrintController.class);

    private final MongoTemplate mongoTemplate;

    public HljldPrintController(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    /**
     * 打印数据：一次性返回入科到出科的全量护理记录行
     *
     * GET /api/v1/icu/hljld/print-data?pid=xxx
     *
     * 返回结构：
     * {
     *   "patient": { name, bedNo, mrn, sex, age, ... },
     *   "start": "2026-03-01T08:00:00Z",
     *   "end": "2026-03-14T14:30:00Z",
     *   "printedAt": "2026-08-21T06:30:00Z",
     *   "rows": [ { timeText, medName, medAmount, ... } ]
     * }
     */
    @GetMapping("/print-data")
    public Map<String, Object> printData(@RequestParam String pid) {
        log.info("[HLJLD][print-data] pid={}", pid);

        // 1. 查患者
        org.bson.Document patient = getPatientInfo(pid);

        // 2. 确定时间窗口：入科 → 出科（或当前时间）
        Date start = getStartTime(patient);
        Date end = getEndTime(patient);
        Date printedAt = new Date();
        log.info("[HLJLD][print-data] window: {} ~ {}", start, end);

        // 3. 一次性查询4个来源的全量数据
        List<Document> vitals = loadVitals(pid, start, end);
        List<Document> drugExecutions = loadDrugExecutions(pid, start, end);
        List<Document> nurseRecords = loadNurseRecords(pid, start, end);
        List<Document> tubeRecords = loadTubeRecords(pid, start, end);
        log.info("[HLJLD][print-data] vitals={}, drugs={}, nurses={}, tubes={}",
                vitals.size(), drugExecutions.size(), nurseRecords.size(), tubeRecords.size());

        // 4. 合并到统一时间轴
        List<Map<String, Object>> rows = mergeIntoRows(vitals, drugExecutions, nurseRecords, tubeRecords);

        // 5. 组装返回
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("patient", normalizeDocument(patient));
        result.put("start", start.toInstant().toString());
        result.put("end", end.toInstant().toString());
        result.put("printedAt", printedAt.toInstant().toString());
        result.put("rows", rows);
        return result;
    }

    // ==================== 时间窗口 ====================

    private Date getStartTime(org.bson.Document patient) {
        // 优先用 icuAdmissionTime，其次 admissionTime
        Date t = patient.getDate("icuAdmissionTime");
        if (t == null) t = patient.getDate("admissionTime");
        if (t == null) {
            // 兜底：30天前
            t = new Date(System.currentTimeMillis() - 30L * 24 * 60 * 60 * 1000);
        }
        return t;
    }

    private Date getEndTime(org.bson.Document patient) {
        // 已出科用 icuDischargeTime，未出科用当前时间
        Date t = patient.getDate("icuDischargeTime");
        if (t == null) t = patient.getDate("dischargeTime");
        if (t == null) {
            t = new Date(); // 在科病人：截止到打印那一刻
        }
        return t;
    }

    // ==================== 数据加载 =====================

    private List<Document> loadVitals(String pid, Date start, Date end) {
        Query q = new Query(Criteria.where("pid").is(pid)
                .and("time").gte(start).lte(end));  // gte/lte 两端闭区间
        q.with(Sort.by(Sort.Direction.ASC, "time"));
        return mongoTemplate.find(q, Document.class, "bedside");
    }

    private List<Document> loadDrugExecutions(String pid, Date start, Date end) {
        // 区间相交：用药开始 ≤ 窗口结束 AND 用药结束 ≥ 窗口开始
        // endTime 用 gte：零时长记录(startTime==endTime)恰好落在窗口起点时 gt 会漏掉
        Criteria overlap = new Criteria().andOperator(
                Criteria.where("startTime").lte(end),
                new Criteria().orOperator(
                        Criteria.where("endTime").exists(false),
                        Criteria.where("endTime").is(null),
                        Criteria.where("endTime").gte(start)));
        Query q = new Query(Criteria.where("pid").is(pid)
                .and("status").ne("invalid")
                .andOperator(overlap));
        q.with(Sort.by(Sort.Direction.ASC, "startTime"));
        return mongoTemplate.find(q, Document.class, "drugExe");
    }

    private List<Document> loadNurseRecords(String pid, Date start, Date end) {
        Query q = new Query(Criteria.where("pid").is(pid.trim())
                .and("time").gte(start).lte(end)  // gte/lte 两端闭区间
                .and("valid").ne(false)
                .and("desc").nin(null, ""));
        q.with(Sort.by(Sort.Direction.ASC, "time"));
        return mongoTemplate.find(q, Document.class, "nurseRecords");
    }

    private List<Document> loadTubeRecords(String pid, Date start, Date end) {
        Query q = new Query(Criteria.where("pid").is(pid)
                .and("valid").ne(false)
                .and("status").ne("invalid")
                .and("tubeRecordList").ne(null));
        q.with(Sort.by(Sort.Direction.ASC, "startTime"));
        return mongoTemplate.find(q, Document.class, "tubeExe");
    }

    // ==================== 时间轴合并 =====================

    private List<Map<String, Object>> mergeIntoRows(
            List<Document> vitals, List<Document> drugExecutions,
            List<Document> nurseRecords, List<Document> tubeRecords) {

        SimpleDateFormat tf = new SimpleDateFormat("HH:mm");
        TreeMap<Date, Map<String, Object>> timeMap = new TreeMap<>();

        // 1. 床旁数据（体征、出入量、检查、治疗等）
        for (Document v : vitals) {
            Date t = v.getDate("time");
            if (t == null) continue;
            String code = str(v, "code");
            String val = str(v, "strVal");
            String remark = str(v, "remark");

            if ("param_Yishi".equals(code)) continue;  // 跳过签名
            if (val == null || val.trim().isEmpty()) continue;

            Map<String, Object> row = timeMap.computeIfAbsent(t, k -> new LinkedHashMap<>());
            row.put("timeText", tf.format(t));

            switch (code) {
                case "param_niaoLiang":
                    row.put("urine", val);
                    break;
                case "param_chaoLvLiang":
                    row.put("ultrafiltration", val);
                    break;
                case "param_daBianAmount":
                case "param_造瘘口量":
                case "param_outuwuliang":
                case "param_咯血":
                case "param_tanLiang":
                    row.put("outputName", getOutputName(code));
                    row.put("outputAmount", val);
                    break;
                case "param_带入药量":
                case "param_kouFu":
                case "param_biSi":
                    String route = "param_带入药量".equals(code) ? "带入" :
                                   "param_kouFu".equals(code) ? "po" : "鼻饲";
                    row.put("enteralName", remark != null ? remark.trim() : "");
                    row.put("enteralAmount", val);
                    row.put("enteralRoute", route);
                    break;
                case "param_外出检查":
                    row.put("examination", val);
                    break;
                case "param_物理治疗":
                    row.put("treatment", val);
                    break;
                case "param_基础护理1":
                    row.put("basicCare", val);
                    break;
                case "param_健康教育":
                    row.put("healthEducation", val);
                    break;
                default:
                    if (code.contains("引流")) {
                        String drainName = code.replace("param_tube_", "").replace("param_", "");
                        drainName = drainName.endsWith("管") ?
                                    drainName.substring(0, drainName.length() - 1) + "液" : drainName;
                        row.put("drainName", drainName);
                        row.put("drainAmount", val);
                    }
                    break;
            }
        }

        // 2. 护理记录
        for (Document r : nurseRecords) {
            Date t = r.getDate("time");
            if (t == null) continue;
            String desc = str(r, "desc");
            if (desc == null || desc.trim().isEmpty()) continue;

            Map<String, Object> row = timeMap.computeIfAbsent(t, k -> new LinkedHashMap<>());
            row.put("timeText", tf.format(t));
            String existing = mapStr(row, "nursingRecord");
            row.put("nursingRecord", existing.isEmpty() ? desc : existing + "\n" + desc);

            String signature = str(r, "accountId");
            if (!signature.isEmpty()) {
                row.put("signature", signature);
            }
        }

        // 3. 药物执行
        for (Document d : drugExecutions) {
            Date t = d.getDate("startTime");
            if (t == null) continue;
            Map<String, Object> row = timeMap.computeIfAbsent(t, k -> new LinkedHashMap<>());
            row.put("timeText", tf.format(t));

            @SuppressWarnings("unchecked")
            List<Document> drugList = (List<Document>) d.get("drugList");
            if (drugList != null && !drugList.isEmpty()) {
                String names = drugList.stream()
                        .map(drug -> str(drug, "name"))
                        .filter(n -> !n.isEmpty())
                        .collect(Collectors.joining("、"));
                if (!names.isEmpty()) row.put("medName", names);
            }

            Object doseObj = d.get("dose");
            if (doseObj != null) row.put("medAmount", doseObj.toString());

            String route = str(d, "route");
            if (!route.isEmpty()) row.put("medRoute", route);
        }

        // 4. 管路记录（引流液）
        for (Document tube : tubeRecords) {
            @SuppressWarnings("unchecked")
            List<Document> recordList = (List<Document>) tube.get("tubeRecordList");
            if (recordList == null) continue;
            for (Document record : recordList) {
                Date t = record.getDate("time");
                if (t == null) continue;
                Map<String, Object> row = timeMap.computeIfAbsent(t, k -> new LinkedHashMap<>());
                row.put("timeText", tf.format(t));
                String name = str(record, "name");
                String amount = str(record, "strVal");
                if (!name.isEmpty()) row.put("drainName", name);
                if (!amount.isEmpty()) row.put("drainAmount", amount);
            }
        }

        return new ArrayList<>(timeMap.values());
    }

    // ==================== 工具方法 ====================

    private String getOutputName(String code) {
        switch (code) {
            case "param_daBianAmount": return "大便量";
            case "param_造瘘口量": return "造瘘口量";
            case "param_outuwuliang": return "呕吐物量";
            case "param_咯血": return "咯血";
            case "param_tanLiang": return "痰液量";
            default: return "";
        }
    }

    private org.bson.Document getPatientInfo(String pid) {
        Query q = new Query(new Criteria().orOperator(
                Criteria.where("_id").is(pid), Criteria.where("pid").is(pid)));
        org.bson.Document p = mongoTemplate.findOne(q, org.bson.Document.class, "patient");
        if (p == null) {
            p = new org.bson.Document();
            p.put("name", "未知");
            p.put("bedNo", "");
            p.put("mrn", "");
            p.put("sex", "");
            p.put("age", "");
        }
        return p;
    }

    private String str(Document doc, String key) {
        Object v = doc.get(key);
        return v != null ? v.toString() : "";
    }

    private String mapStr(Map<String, Object> map, String key) {
        Object v = map.get(key);
        return v != null ? v.toString() : "";
    }

    /**
     * 递归将 Document 中的 Date/ObjectId 转为前端可用的值
     */
    private Object normalizeDocument(Object value) {
        if (value instanceof Date) {
            return ((Date) value).toInstant().toString();
        }
        if (value instanceof ObjectId) {
            return ((ObjectId) value).toHexString();
        }
        if (value instanceof Document) {
            Document source = (Document) value;
            Map<String, Object> result = new LinkedHashMap<>();
            for (Map.Entry<String, Object> entry : source.entrySet()) {
                result.put(entry.getKey(), normalizeDocument(entry.getValue()));
            }
            return result;
        }
        if (value instanceof Map) {
            Map<?, ?> source = (Map<?, ?>) value;
            Map<String, Object> result = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : source.entrySet()) {
                result.put(String.valueOf(entry.getKey()), normalizeDocument(entry.getValue()));
            }
            return result;
        }
        if (value instanceof List) {
            List<?> source = (List<?>) value;
            List<Object> result = new ArrayList<>();
            for (Object item : source) {
                result.add(normalizeDocument(item));
            }
            return result;
        }
        return value;
    }
}

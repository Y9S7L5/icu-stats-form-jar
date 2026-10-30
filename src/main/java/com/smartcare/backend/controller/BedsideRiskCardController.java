package com.smartcare.backend.controller;

import com.smartcare.backend.config.DatacenterMongo;
import java.util.*;
import org.bson.Document;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * 床头卡危险风险标识 —— 补充数据接口。
 * 前端 bedside 已有 /api/v1/icu/bedside/listByPid 可取各风险评分最新值；
 * 本接口补齐无法从 bedside 集合直接获得的两类数据：
 * 1. 过敏史：主库 dFormData（入院/转入护理评估单），最新一条有效记录的 gms1/gms4；
 * 2. 解除隔离：DataCenter 库 VI_ICU_ZYYZ（医嘱集合），最新一条 orderName 含"解除隔离"的医嘱，
 *    无停止时间或停止时间未到 → true（红底），停止时间已过 → false（灰底），重新开立自然以最新为准。
 */
@RestController
@RequestMapping({"/api/v1/icu/bedside-risk-card"})
@CrossOrigin(origins = {"*"})
public class BedsideRiskCardController {

    /** DataCenter 库中医嘱集合候选名称（VI_ICU_ZYYZ 同步，与交班报告一致） */
    private static final String[] ORDER_COLLECTIONS = {"order", "orders", "VI_ICU_ZYYZ", "vi_icu_zyyz"};
    /** 入院 / 转入护理评估单 formCode */
    private static final List<String> ASSESSMENT_FORM_CODES = List.of("ruyuanhulipinggudan", "zhuanruhulipinggudan");

    private final MongoTemplate mongoTemplate;
    private final DatacenterMongo datacenterMongo;

    public BedsideRiskCardController(MongoTemplate mongoTemplate, DatacenterMongo datacenterMongo) {
        this.mongoTemplate = mongoTemplate;
        this.datacenterMongo = datacenterMongo;
    }

    @GetMapping("/extra-info")
    public ResponseEntity<Map<String, Object>> extraInfo(
            @RequestParam String pid,
            @RequestParam(required = false) String mrn) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("allergy", queryAllergy(pid));
        result.put("removeIsolation", queryRemoveIsolation(pid, mrn));
        return ResponseEntity.ok(result);
    }

    /**
     * 过敏史：取最新一条有效的入院/转入评估单，
     * gms1 有值即有过敏史；gms4 有值时作为详情文本一并返回。
     */
    private Map<String, Object> queryAllergy(String pid) {
        Map<String, Object> allergy = new LinkedHashMap<>();
        allergy.put("hasAllergy", false);
        allergy.put("detail", "");
        try {
            Query query = new Query(Criteria.where("pid").is(pid)
                    .and("formCode").in(ASSESSMENT_FORM_CODES)
                    .and("status").is("valid"));
            // _id 递增即插入时间递增，取最新一条
            query.with(Sort.by(Sort.Direction.DESC, "_id"));
            query.limit(1);
            List<Map> docs = mongoTemplate.find(query, Map.class, "dFormData");
            if (docs.isEmpty()) return allergy;
            Map<?, ?> doc = docs.get(0);
            Object fieldList = doc.get("fieldDataList");
            if (!(fieldList instanceof List)) return allergy;
            for (Object elem : (List<?>) fieldList) {
                if (!(elem instanceof Map)) continue;
                Map<?, ?> entry = (Map<?, ?>) elem;
                String field = String.valueOf(entry.get("field"));
                if ("gms1".equals(field) && hasValue(entry.get("value"))) {
                    allergy.put("hasAllergy", true);
                } else if ("gms4".equals(field)) {
                    String detail = stringifyValue(entry.get("value"));
                    if (!detail.isEmpty()) allergy.put("detail", detail);
                }
            }
            return allergy;
        } catch (Exception e) {
            System.out.println("[BEDSIDE-RISK-CARD] query allergy failed: " + e.getMessage());
            return allergy;
        }
    }

    /**
     * 解除隔离：取该患者最新一条 orderName 含"解除隔离"的医嘱（作废不计）。
     * 无停止时间 或 停止时间未到 → true；停止时间已过 → false。
     */
    private boolean queryRemoveIsolation(String pid, String mrn) {
        try {
            List<Criteria> matchers = new ArrayList<>();
            matchers.add(Criteria.where("orderName").regex("解除隔离"));
            matchers.add(Criteria.where("status").ne("作废"));
            List<Criteria> patientMatchers = new ArrayList<>();
            patientMatchers.add(Criteria.where("pid").is(pid));
            if (mrn != null && !mrn.trim().isEmpty()) {
                patientMatchers.add(Criteria.where("mrn").is(mrn.trim()));
            }
            matchers.add(new Criteria().orOperator(patientMatchers.toArray(new Criteria[0])));

            Query query = new Query(new Criteria().andOperator(matchers.toArray(new Criteria[0])));
            query.with(Sort.by(Sort.Direction.DESC, "orderTime"));
            query.limit(1);
            for (String collection : ORDER_COLLECTIONS) {
                List<Document> docs = datacenterMongo.find(query, Document.class, collection);
                if (!docs.isEmpty()) {
                    Object stop = docs.get(0).get("stopTime");
                    if (stop == null) return true;
                    Date stopDate = toDate(stop);
                    return stopDate == null || stopDate.after(new Date());
                }
            }
            return false;
        } catch (Exception e) {
            System.out.println("[BEDSIDE-RISK-CARD] query remove-isolation failed: " + e.getMessage());
            return false;
        }
    }

    /** 值是否有效：非空字符串 / 非空集合 / 非零数字 / 其他非 null */
    private boolean hasValue(Object val) {
        if (val == null) return false;
        if (val instanceof String) return !((String) val).trim().isEmpty();
        if (val instanceof Collection) return !((Collection<?>) val).isEmpty();
        if (val instanceof Number) return ((Number) val).doubleValue() != 0;
        return true;
    }

    /** 值转展示文本：字符串直接用，集合取非空元素以"/"连接 */
    private String stringifyValue(Object val) {
        if (val == null) return "";
        if (val instanceof String) return ((String) val).trim();
        if (val instanceof Collection) {
            List<String> parts = new ArrayList<>();
            for (Object item : (Collection<?>) val) {
                String s = stringifyValue(item);
                if (!s.isEmpty()) parts.add(s);
            }
            return String.join("/", parts);
        }
        return String.valueOf(val).trim();
    }

    private Date toDate(Object val) {
        if (val instanceof Date) return (Date) val;
        if (val instanceof Number) {
            long ms = ((Number) val).longValue();
            // 10 位及以下按秒处理
            if (ms < 100000000000L) ms *= 1000;
            return new Date(ms);
        }
        if (val instanceof String) {
            String s = ((String) val).trim();
            if (s.isEmpty()) return null;
            try {
                return toDate(Long.parseLong(s));
            } catch (NumberFormatException ignored) {}
            try {
                return new Date(java.text.Date.parse(s));
            } catch (Exception ignored) { return null; }
        }
        return null;
    }
}

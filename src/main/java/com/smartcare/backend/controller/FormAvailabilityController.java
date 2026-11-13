package com.smartcare.backend.controller;

import com.smartcare.backend.dto.IcuFormAvailabilityResponse;
import com.smartcare.backend.dto.IcuFormAvailabilityStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.web.bind.annotation.*;

import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 表单数据可用性聚合查询接口。
 * 一次请求查询所有表单是否有数据，用于下拉框标红提示。
 */
@RestController
@RequestMapping("/api/v1/icu/form-availability")
@CrossOrigin(origins = {"*"})
public class FormAvailabilityController {

    private static final Logger log = LoggerFactory.getLogger(FormAvailabilityController.class);
    private static final ExecutorService executor = Executors.newFixedThreadPool(4);

    private final MongoTemplate mongoTemplate;

    public FormAvailabilityController(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    @GetMapping
    public CompletableFuture<Map<String, IcuFormAvailabilityResponse>> getAvailability(
            @RequestParam String pid) {

        Map<String, IcuFormAvailabilityResponse> result = new LinkedHashMap<>();

        List<CompletableFuture<Void>> futures = new ArrayList<>();

        // ── 评分表类（score 集合，按 scoreType 区分） ──
        Map<String, String> scoreForms = Map.of(
            "bradenForm", "bradenScore",
            "patientFallDangerForm", "patientFallDangerLJRMYY",
            "baetheiForm", "selfCareAbility",
            "unPlannedCGZYYForm", "unPlannedCGZYYScore",
            "IADForm", "incontinenceScore",
            "toleranceForm", "toleranceScoreV2",
            "commitSuicideForm", "commitSuicideScore"
        );
        scoreForms.forEach((formKey, scoreType) ->
            futures.add(CompletableFuture.runAsync(() -> {
                long count = mongoTemplate.count(
                    Query.query(Criteria.where("pid").is(pid)
                        .and("scoreType").is(scoreType)
                        .and("valid").is(true)),
                    "score"
                );
                result.put(formKey, toResponse(formKey, count));
            }, executor))
        );

        // ── 床旁数据类（bedside 集合，按 code 过滤） ──
        Map<String, List<String>> bedsideForms = Map.of(
            "ecmoForm", List.of("param_ECMOMoShi", "param_ECMO_xueLiuLiang"),
            "crrtForm", List.of("param_CBP_Mode", "param_血流速度"),
            "iabpForm", List.of("param_反博压", "param_iabp心率"),
            "ydwzlForm", List.of("param_亚低温体温设置", "param_亚低温水温设置")
        );
        bedsideForms.forEach((formKey, codes) ->
            futures.add(CompletableFuture.runAsync(() -> {
                long count = mongoTemplate.count(
                    Query.query(Criteria.where("pid").is(pid)
                        .and("valid").is(true)
                        .and("code").in(codes)),
                    "bedside"
                );
                result.put(formKey, toResponse(formKey, count));
            }, executor))
        );

        // ── CRRT 医嘱单 ──
        futures.add(CompletableFuture.runAsync(() -> {
            long count = mongoTemplate.count(
                Query.query(Criteria.where("pid").is(pid)),
                "crrt_order_form"
            );
            result.put("crrtOrderForm", toResponse("crrtOrderForm", count));
        }, executor));

        // ── CRRT 护理记录 ──
        futures.add(CompletableFuture.runAsync(() -> {
            long count = mongoTemplate.count(
                Query.query(Criteria.where("pid").is(pid)),
                "crrt_records"
            );
            // crrtForm 同时检查 bedside，取两者最大值
            result.putIfAbsent("crrtForm", toResponse("crrtForm", 0));
            IcuFormAvailabilityResponse existing = result.get("crrtForm");
            if (count > 0 && existing != null) {
                result.put("crrtForm", toResponse("crrtForm", existing.getCount() + count));
            } else if (count > 0) {
                result.put("crrtForm", toResponse("crrtForm", count));
            }
        }, executor));

        // ── PICCO 参数手工录入记录（不再读取 bedside 同步数据） ──
        futures.add(CompletableFuture.runAsync(() -> {
            long count = mongoTemplate.count(
                Query.query(Criteria.where("pid").is(pid)
                    .and("valid").is(true)),
                "piccoParamRecord"
            );
            result.put("piccoForm", toResponse("piccoForm", count));
        }, executor));

        // ── 重症患者护理目标管理记录 ──
        futures.add(CompletableFuture.runAsync(() -> {
            long count = mongoTemplate.count(
                Query.query(Criteria.where("pid").is(pid)
                    .and("valid").is(true)),
                "nursingGoalRecord"
            );
            result.put("hlmbForm", toResponse("hlmbForm", count));
        }, executor));

        // ── 健康教育记录 ──
        futures.add(CompletableFuture.runAsync(() -> {
            long count = mongoTemplate.count(
                Query.query(Criteria.where("pid").is(pid)
                    .and("valid").is(true)),
                "healthEducationRecord"
            );
            result.put("jkjyForm", toResponse("jkjyForm", count));
        }, executor));

        // ── HLJLD 护理记录单（通过 form_page_index 检查） ──
        futures.add(CompletableFuture.runAsync(() -> {
            long count = mongoTemplate.count(
                Query.query(Criteria.where("pid").is(pid)
                    .and("formType").is("hljld2-flow-new")),
                "form_page_index"
            );
            result.put("hljldFormPDFNew", toResponse("hljldFormPDFNew", count));
        }, executor));

        // ── 入院/转入护理评估单（dFormData 集合，sj 字段有值即有数据） ──
        List<String> assessmentFormCodes = List.of("ruyuanhulipinggudan", "zhuanruhulipinggudan");
        Map<String, String> assessmentFormKeys = Map.of(
            "ruyuanhulipinggudan", "ruyuanhulipinggudan",
            "zhuanruhulipinggudan", "zhuanruhulipinggudan"
        );
        assessmentFormCodes.forEach(formCode ->
            futures.add(CompletableFuture.runAsync(() -> {
                List<Map> docs = mongoTemplate.find(
                    Query.query(Criteria.where("pid").is(pid)
                        .and("formCode").is(formCode)
                        .and("status").is("valid")),
                    Map.class,
                    "dFormData"
                );
                boolean hasData = docs.stream().anyMatch(doc -> {
                    Object fieldList = doc.get("fieldDataList");
                    if (!(fieldList instanceof List)) return false;
                    return ((List<?>) fieldList).stream().anyMatch(elem -> {
                        if (!(elem instanceof Map)) return false;
                        Map<?, ?> entry = (Map<?, ?>) elem;
                        if (!"sj".equals(entry.get("field"))) return false;
                        Object val = entry.get("value");
                        if (val == null) return false;
                        if (val instanceof String) return !((String) val).trim().isEmpty();
                        if (val instanceof List) return !((List<?>) val).isEmpty();
                        if (val instanceof Number) return ((Number) val).longValue() != 0;
                        return true;
                    });
                });
                result.put(assessmentFormKeys.get(formCode),
                    hasData
                        ? IcuFormAvailabilityResponse.available(assessmentFormKeys.get(formCode), 1)
                        : IcuFormAvailabilityResponse.empty(assessmentFormKeys.get(formCode)));
            }, executor))
        );

        // 等待所有查询完成
        return CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
            .thenApply(v -> {
                log.debug("[form-availability] pid={} completed, {} forms checked", pid, result.size());
                return result;
            });
    }

    private IcuFormAvailabilityResponse toResponse(String formKey, long count) {
        if (count > 0) {
            return IcuFormAvailabilityResponse.available(formKey, count);
        }
        return IcuFormAvailabilityResponse.empty(formKey);
    }
}

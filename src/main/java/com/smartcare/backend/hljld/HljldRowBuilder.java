package com.smartcare.backend.hljld;

import org.bson.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.text.SimpleDateFormat;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 构建 HljldTimeRow 和 HljldDisplayRow，对应前端 buildRows 和 buildDisplayGroups。
 *
 * 核心逻辑：
 * 1. 收集所有数据源中的有效记录
 * 2. 按分钟键归组到 TreeMap
 * 3. 为每个时间点构建 HljldTimeRow（同分钟多条不覆盖）
 * 4. 将 HljldTimeRow 展开为 HljldDisplayRow 列表
 */
@Service
public class HljldRowBuilder {

    private static final Logger log = LoggerFactory.getLogger(HljldRowBuilder.class);

    @Autowired
    public HljldRowBuilder() {}

    /**
     * 构建时间行列表，对应前端 buildRows（使用当前时间）。
     */
    public List<HljldTimeRow> buildRows(HljldSourceData source, Date start, Date end, boolean startExclusive) {
        return buildRows(source, start, end, startExclusive, System.currentTimeMillis());
    }

    /**
     * 构建时间行列表，对应前端 buildRows。
     *
     * @param source 原始数据
     * @param start  护理日有效开始时间
     * @param end    护理日结束时间（次日07:00）
     * @param startExclusive 是否排除开始时刻（入科截断时为false）
     * @param nowMs  当前时刻毫秒（一次获取，向下传递）
     * @return 按时间排序的行列表
     */
    public List<HljldTimeRow> buildRows(HljldSourceData source, Date start, Date end, boolean startExclusive, long nowMs) {
        long startMs = start.getTime();
        long endMs = end.getTime();

        // 过滤各类数据
        List<Document> bedsideInPeriod = source.getBedside().stream()
            .filter(item -> HljldUtils.isRenderableBedsideRecord(item))
            .filter(item -> HljldUtils.inNursingRange(str(item, "time"), start, end, startExclusive))
            .collect(Collectors.toList());

        List<Document> drugsInPeriod = source.getDrugExecutions().stream()
            .filter(item -> HljldUtils.isRenderableDrugExecution(item))
            .filter(item -> HljldUtils.inNursingRange(str(item, "startTime"), start, end, startExclusive))
            .collect(Collectors.toList());

        List<Document> nurseInPeriod = source.getNurseRecords().stream()
            .filter(item -> HljldUtils.isValidBusinessRecord(item))
            .filter(item -> !HljldUtils.str(item, "desc").isEmpty())
            .filter(item -> HljldUtils.inNursingRange(str(item, "time"), start, end, startExclusive))
            .collect(Collectors.toList());

        // 肠内营养跨护理日补充：startTime 不在当前护理日但 quickAdd 在当前护理日的药物
        List<Document> enteralCrossDayDrugs = source.getDrugExecutions().stream()
            .filter(item -> HljldUtils.isRenderableDrugExecution(item))
            .filter(item -> !HljldUtils.inNursingRange(str(item, "startTime"), start, end, startExclusive))
            .filter(item -> {
                Document method = HljldUtils.findDrugMethod(str(item, "methodCode"), source.getDrugMethods());
                if (method == null || !"胃肠".equals(str(method, "group"))) return false;
                // 行为判定：含带量 quickAdd 即按分次展示，不再限定肠内营养药名
                return HljldUtils.hasQuickAddActions(item);
            })
            .filter(item -> {
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> actionList = (List<Map<String, Object>>) item.get("drugActionList");
                if (actionList == null) return false;
                return actionList.stream().anyMatch(a -> {
                    String act = str(a, "action").trim().toLowerCase();
                    // quickAdd 或带量 stop 落在当前护理日即纳入（stop 携带末次给药量，跨日不可丢）
                    boolean isDoseAction = "quickadd".equals(act)
                        || ("stop".equals(act) && HljldUtils.parseAmount(a.get("quickAddAmount")) > 0);
                    return isDoseAction && HljldUtils.inNursingRange(str(a, "time"), start, end, startExclusive);
                });
            })
            .collect(Collectors.toList());

        // 收集所有唯一分钟键
        Set<Long> uniqueKeys = new TreeSet<>();
        for (Document v : bedsideInPeriod) {
            long k = HljldUtils.minuteKey(str(v, "time"));
            if (k != Long.MIN_VALUE) uniqueKeys.add(k);
        }
        for (Document d : drugsInPeriod) {
            String startTimeStr = str(d, "startTime");
            long k = HljldUtils.minuteKey(startTimeStr);
            log.info("[hljld] 药物时间Key: drugName={}, startTime(str)={}, minuteKey={}, id={}", HljldUtils.drugDisplayName(d), startTimeStr, k, d.get("_id"));
            if (k != Long.MIN_VALUE) uniqueKeys.add(k);
        }
        // 分次给药（快推/带量stop）的分钟键：无护理记录同分钟时行也要渲染
        for (Document d : drugsInPeriod) {
            collectDoseActionKeys(uniqueKeys, d, start, end, startExclusive);
        }
        for (Document d : enteralCrossDayDrugs) {
            collectDoseActionKeys(uniqueKeys, d, start, end, startExclusive);
        }
        for (Document r : nurseInPeriod) {
            long k = HljldUtils.minuteKey(str(r, "time"));
            if (k != Long.MIN_VALUE) uniqueKeys.add(k);
        }

        // 护理班段
        List<HljldUtils.NursingSegment> segments = HljldUtils.resolveNursingSegments(start);
        HljldUtils.NursingSegment daySegment = segments.get(0);
        HljldUtils.NursingSegment nightSegment = segments.get(1);

        // 日间小结时间点（17:00）
        long dayBoundaryMs = daySegment.end.getTime();

        List<HljldTimeRow> rows = new ArrayList<>();

        // 表首 carryOver 行：前一护理日仍在执行的续用药物
        addCarryOverRow(rows, source, startMs, segments, nowMs);

        // 追踪是否已添加日间小结后剩余量
        boolean[] daySummaryRemaindersAdded = {false};

        SimpleDateFormat tf = new SimpleDateFormat("yyyy-MM-dd HH:mm");
        tf.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));

        for (long key : uniqueKeys) {
            long timeMs = key * 60000;

            List<Document> bedsideAtKey = bedsideInPeriod.stream()
                .filter(item -> HljldUtils.minuteKey(str(item, "time")) == key)
                .collect(Collectors.toList());

            List<NameAmountRoute> medications = new ArrayList<>();
            List<NameAmountRoute> enteral = new ArrayList<>();

            // 肠内营养 quickAdd：遍历区间内药物和跨日药物
            collectEnteralQuickAdd(enteral, source, drugsInPeriod, enteralCrossDayDrugs, key);

            List<Document> drugExecutionsAtKey = drugsInPeriod.stream()
                .filter(item -> HljldUtils.minuteKey(str(item, "startTime")) == key)
                .collect(Collectors.toList());

            // 日间小结（17:00）之后：插入 night 段结算行
            if (!daySummaryRemaindersAdded[0] && timeMs > dayBoundaryMs) {
                addNightSettlementRow(rows, source, nightSegment, nowMs);
                daySummaryRemaindersAdded[0] = true;
            }

            // 处理药物执行
            for (Document execution : drugExecutionsAtKey) {
                processDrugExecution(medications, enteral, execution, source, key, timeMs, segments);
            }

            // 单次给药 stop 时间点（肠内营养；含跨日药物——次日stop的末次给药量不可丢）
            processEnteralStop(medications, enteral, drugsInPeriod, enteralCrossDayDrugs, source, key);

            // 床旁数据：带入药量 → medications
            bedsideAtKey.stream()
                .filter(item -> "param_带入药量".equals(str(item, "code")))
                .map(HljldUtils::bedsideInputCell)
                .filter(NameAmountRoute::hasNameOrAmount)
                .forEach(medications::add);

            // 床旁数据：口服/鼻饲 → enteral
            bedsideAtKey.stream()
                .filter(item -> "param_kouFu".equals(str(item, "code")) || "param_biSi".equals(str(item, "code")))
                .map(HljldUtils::bedsideInputCell)
                .filter(NameAmountRoute::hasNameOrAmount)
                .forEach(enteral::add);

            // 尿量、净超滤量
            List<String> urines = bedsideAtKey.stream()
                .filter(item -> HljldUtils.URINE_CODE.equals(str(item, "code")))
                .map(item -> HljldUtils.displayAmount(item.get("strVal")))
                .filter(s -> !s.isEmpty())
                .collect(Collectors.toList());

            List<String> ultrafiltrations = bedsideAtKey.stream()
                .filter(item -> HljldUtils.ULTRAFILTRATION_CODE.equals(str(item, "code")))
                .map(item -> HljldUtils.displayAmount(item.get("strVal")))
                .filter(s -> !s.isEmpty())
                .collect(Collectors.toList());

            // 排出物
            List<NameAmount> outputs = bedsideAtKey.stream()
                .filter(item -> HljldUtils.OUTPUT_CODE_NAMES.containsKey(str(item, "code")))
                .map(item -> new NameAmount(
                    HljldUtils.OUTPUT_CODE_NAMES.get(str(item, "code")),
                    HljldUtils.displayAmount(item.get("strVal")),
                    HljldUtils.parseAmount(item.get("strVal"))))
                .filter(NameAmount::hasAmountValue)
                .collect(Collectors.toList());

            // 引流液
            List<NameAmount> drains = bedsideAtKey.stream()
                .filter(item -> HljldUtils.isDrainCode(str(item, "code")))
                .map(item -> new NameAmount(
                    HljldUtils.drainName(str(item, "code")),
                    HljldUtils.displayAmount(item.get("strVal")),
                    HljldUtils.parseAmount(item.get("strVal"))))
                .filter(NameAmount::hasAmountValue)
                .collect(Collectors.toList());

            // 检查、治疗、基础护理、健康教育
            List<String> examination = collectValues(bedsideAtKey, "param_外出检查");
            List<String> treatment = collectValues(bedsideAtKey, "param_物理治疗");
            List<String> basicCare = collectValues(bedsideAtKey, "param_基础护理1");
            List<String> healthEducation = collectValues(bedsideAtKey, "param_健康教育");

            // 护理记录
            List<Document> nurseRowsAtKey = nurseInPeriod.stream()
                .filter(item -> HljldUtils.minuteKey(str(item, "time")) == key)
                .collect(Collectors.toList());

            List<String> nursingRecords = new ArrayList<>();
            String combinedNursing = nurseRowsAtKey.stream()
                .map(item -> str(item, "desc").trim())
                .filter(s -> !s.isEmpty())
                .collect(Collectors.joining("；"));
            if (!combinedNursing.isEmpty()) {
                nursingRecords.add(combinedNursing);
            }

            // 检查是否有内容
            boolean hasContent = !medications.isEmpty() || !enteral.isEmpty()
                || !urines.isEmpty() || !ultrafiltrations.isEmpty()
                || !outputs.isEmpty() || !drains.isEmpty()
                || !examination.isEmpty() || !treatment.isEmpty()
                || !basicCare.isEmpty() || !healthEducation.isEmpty()
                || !nursingRecords.isEmpty();
            if (!hasContent) continue;

            // 签名解析
            String signature = resolveSignature(nurseRowsAtKey, source, timeMs);

            HljldTimeRow row = new HljldTimeRow();
            row.setKey(String.valueOf(key));
            row.setTime(new Date(timeMs));
            row.setTimeText(tf.format(new Date(timeMs)));
            row.setSortRank(0);
            row.setMedications(medications);
            row.setEnteral(enteral);
            row.setUrines(urines);
            row.setUltrafiltrations(ultrafiltrations);
            row.setOutputs(outputs);
            row.setDrains(drains);
            row.setExamination(examination);
            row.setTreatment(treatment);
            row.setBasicCare(basicCare);
            row.setHealthEducation(healthEducation);
            row.setNursingRecords(nursingRecords);
            row.setSignature(signature);
            rows.add(row);
        }

        // night 段结算行（07:00）：插入到表尾
        addNightEndSettlementRow(rows, source, nightSegment, nowMs);

        return rows;
    }

    /**
     * 将 HljldTimeRow 列表展开为 HljldTimeGroup 列表。
     * 对应前端 buildDisplayGroups。
     *
     * 特殊处理：对尿量(ml)、净超滤量(ml)、排出物、引流液的整点数据（分钟为0），
     * 从原时间行中拆分出来，时间+1小时显示。如果+1小时后的时间点已有其他数据，则合并显示。
     */
    public List<HljldTimeGroup> buildDisplayGroups(List<HljldTimeRow> sourceRows) {
        // 排序
        List<HljldTimeRow> sorted = sourceRows.stream()
            .sorted(Comparator.comparingLong((HljldTimeRow r) -> HljldUtils.minuteInstant(r.getTime()))
                .thenComparingInt(HljldTimeRow::getSortRank))
            .collect(Collectors.toList());

        // 第一步：处理尿量等字段的时间调整，生成调整后的行列表
        List<HljldTimeRow> adjustedRows = adjustOutputFieldsTime(sorted);

        // 第二步：按时间分组，合并相同时间的行
        List<HljldTimeRow> mergedRows = mergeRowsByTime(adjustedRows);

        // 第三步：按时间排序并生成 displayGroups
        List<HljldTimeGroup> groups = new ArrayList<>();
        for (HljldTimeRow row : mergedRows) {
            HljldTimeGroup group = buildGroupFromRow(row);
            if (group != null) {
                groups.add(group);
            }
        }

        return groups;
    }

    /**
     * 处理尿量、净超滤量、排出物、引流液字段的时间调整。
     * 整点数据（分钟为0）+1小时显示。
     */
    private List<HljldTimeRow> adjustOutputFieldsTime(List<HljldTimeRow> sortedRows) {
        List<HljldTimeRow> result = new ArrayList<>();

        for (HljldTimeRow row : sortedRows) {
            long timestamp = row.getTime().getTime();

            // carryOver行（sortRank=-1）和结算行（sortRank=2）不进行时间调整
            int sortRank = row.getSortRank();
            if (sortRank == -1 || sortRank == 2) {
                result.add(row);
                continue;
            }

            // 检查是否有尿量等字段需要时间调整
            boolean hasOutputFields = hasOutputFieldData(row);
            boolean isWholeHour = isWholeHour(timestamp);

            if (hasOutputFields && isWholeHour) {
                // 拆分尿量等字段到新行（时间+1小时）
                HljldTimeRow originalRow = createRowWithoutOutputFields(row);
                HljldTimeRow outputRow = createOutputFieldRow(row);

                if (originalRow != null) {
                    result.add(originalRow);
                }
                if (outputRow != null) {
                    result.add(outputRow);
                }
            } else {
                // 不需要调整，直接添加
                result.add(row);
            }
        }

        return result;
    }

    /**
     * 检查行是否包含需要时间调整的床旁录入数据（口服量、鼻饲量）。
     * 只检查来自 bedside 的数据，不检查来自 drugExecutions 的肠内营养药物。
     */
    private boolean hasOutputFieldData(HljldTimeRow row) {
        if (row.getUrines() != null && !row.getUrines().isEmpty()) return true;
        if (row.getUltrafiltrations() != null && !row.getUltrafiltrations().isEmpty()) return true;
        if (row.getOutputs() != null && !row.getOutputs().isEmpty()) return true;
        if (row.getDrains() != null && !row.getDrains().isEmpty()) return true;
        // 只检查来自 bedside 的 enteral 数据（口服量、鼻饲量）
        if (row.getEnteral() != null) {
            return row.getEnteral().stream().anyMatch(NameAmountRoute::isFromBedside);
        }
        return false;
    }

    /**
     * 判断时间戳是否为整点（分钟为0）
     */
    private boolean isWholeHour(long timestampMs) {
        Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        cal.setTimeInMillis(timestampMs);
        return cal.get(Calendar.MINUTE) == 0 && cal.get(Calendar.SECOND) == 0;
    }

    /**
     * 创建移除尿量等字段后的行（原时间）
     * 保留来自 drugExecutions 的 enteral 数据（肠内营养药物）
     */
    private HljldTimeRow createRowWithoutOutputFields(HljldTimeRow original) {
        // 检查是否还有其他数据（包括 drugExecutions 的 enteral 数据）
        boolean hasOtherData = hasNonOutputFieldData(original);
        boolean hasDrugEnteral = original.getEnteral() != null
            && original.getEnteral().stream().anyMatch(e -> !e.isFromBedside());

        if (!hasOtherData && !hasDrugEnteral) {
            return null; // 没有其他数据，不创建原时间行
        }

        HljldTimeRow row = new HljldTimeRow();
        row.setKey(original.getKey());
        row.setTime(original.getTime());
        row.setTimeText(original.getTimeText());
        row.setSortRank(original.getSortRank());
        row.setMedications(original.getMedications());
        // 保留来自 drugExecutions 的 enteral 数据，移除 bedside 数据
        if (original.getEnteral() != null) {
            row.setEnteral(original.getEnteral().stream()
                .filter(e -> !e.isFromBedside())
                .collect(Collectors.toList()));
        } else {
            row.setEnteral(new ArrayList<>());
        }
        row.setUrines(new ArrayList<>()); // 清空尿量等字段
        row.setUltrafiltrations(new ArrayList<>());
        row.setOutputs(new ArrayList<>());
        row.setDrains(new ArrayList<>());
        row.setExamination(original.getExamination());
        row.setTreatment(original.getTreatment());
        row.setBasicCare(original.getBasicCare());
        row.setHealthEducation(original.getHealthEducation());
        row.setNursingRecords(original.getNursingRecords());
        row.setSignature(original.getSignature());
        return row;
    }

    /**
     * 检查行是否包含非尿量等字段的数据
     * 包含来自 drugExecutions 的 enteral 数据（肠内营养药物）
     */
    private boolean hasNonOutputFieldData(HljldTimeRow row) {
        if (row.getMedications() != null && !row.getMedications().isEmpty()) return true;
        if (row.getExamination() != null && !row.getExamination().isEmpty()) return true;
        if (row.getTreatment() != null && !row.getTreatment().isEmpty()) return true;
        if (row.getBasicCare() != null && !row.getBasicCare().isEmpty()) return true;
        if (row.getHealthEducation() != null && !row.getHealthEducation().isEmpty()) return true;
        if (row.getNursingRecords() != null && !row.getNursingRecords().isEmpty()) return true;
        // 包含来自 drugExecutions 的 enteral 数据
        if (row.getEnteral() != null) {
            return row.getEnteral().stream().anyMatch(e -> !e.isFromBedside());
        }
        return false;
    }

    /**
     * 创建尿量等字段的新行（时间+1小时）
     * 只移动来自 bedside 的 enteral 数据（口服量、鼻饲量）
     */
    private HljldTimeRow createOutputFieldRow(HljldTimeRow original) {
        // 检查是否有需要移动的床旁数据
        boolean hasUrines = original.getUrines() != null && !original.getUrines().isEmpty();
        boolean hasUltrafiltrations = original.getUltrafiltrations() != null && !original.getUltrafiltrations().isEmpty();
        boolean hasOutputs = original.getOutputs() != null && !original.getOutputs().isEmpty();
        boolean hasDrains = original.getDrains() != null && !original.getDrains().isEmpty();
        // 只检查来自 bedside 的 enteral 数据
        boolean hasBedsideEnteral = original.getEnteral() != null
            && original.getEnteral().stream().anyMatch(NameAmountRoute::isFromBedside);

        if (!hasUrines && !hasUltrafiltrations && !hasOutputs && !hasDrains && !hasBedsideEnteral) {
            return null; // 没有需要移动的床旁数据，不创建新行
        }

        // 时间+1小时
        long originalTimestamp = original.getTime().getTime();
        long adjustedTimestamp = originalTimestamp + 60 * 60 * 1000L; // +1小时

        // 格式化调整后的时间文本
        SimpleDateFormat tf = new SimpleDateFormat("yyyy-MM-dd HH:mm");
        tf.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
        String adjustedTimeText = tf.format(new Date(adjustedTimestamp));

        // 生成新的 key（避免与原 key 冲突）
        String adjustedKey = original.getKey() + "-adjusted";

        HljldTimeRow row = new HljldTimeRow();
        row.setKey(adjustedKey);
        row.setTime(new Date(adjustedTimestamp));
        row.setTimeText(adjustedTimeText);
        row.setSortRank(original.getSortRank());
        row.setTimeAdjusted(true); // 标记为时间调整过的行
        row.setMedications(new ArrayList<>()); // 不包含药物治疗
        // 只移动来自 bedside 的 enteral 数据
        if (original.getEnteral() != null) {
            row.setEnteral(original.getEnteral().stream()
                .filter(NameAmountRoute::isFromBedside)
                .collect(Collectors.toList()));
        } else {
            row.setEnteral(new ArrayList<>());
        }
        row.setUrines(original.getUrines());
        row.setUltrafiltrations(original.getUltrafiltrations());
        row.setOutputs(original.getOutputs());
        row.setDrains(original.getDrains());
        row.setExamination(new ArrayList<>()); // 不包含检查
        row.setTreatment(new ArrayList<>()); // 不包含治疗
        row.setBasicCare(new ArrayList<>()); // 不包含基础护理
        row.setHealthEducation(new ArrayList<>()); // 不包含健康教育
        row.setNursingRecords(new ArrayList<>()); // 不包含护理记录
        row.setSignature(original.getSignature()); // 保留原始签名
        return row;
    }

    /**
     * 按时间分组，合并相同时间的行
     */
    private List<HljldTimeRow> mergeRowsByTime(List<HljldTimeRow> rows) {
        // 按时间排序
        List<HljldTimeRow> sorted = rows.stream()
            .sorted(Comparator.comparingLong((HljldTimeRow r) -> r.getTime().getTime()))
            .collect(Collectors.toList());

        // 按时间分组合并
        Map<Long, HljldTimeRow> mergedByTime = new LinkedHashMap<>();
        for (HljldTimeRow row : sorted) {
            long timestamp = row.getTime().getTime();
            HljldTimeRow existing = mergedByTime.get(timestamp);
            if (existing == null) {
                mergedByTime.put(timestamp, row);
            } else {
                // 合并相同时间的行
                mergeTimeRows(existing, row);
            }
        }

        return new ArrayList<>(mergedByTime.values());
    }

    /**
     * 合并两个相同时间的行
     */
    private void mergeTimeRows(HljldTimeRow target, HljldTimeRow source) {
        // 合并药物治疗
        if (source.getMedications() != null && !source.getMedications().isEmpty()) {
            if (target.getMedications() == null) {
                target.setMedications(new ArrayList<>(source.getMedications()));
            } else {
                target.getMedications().addAll(source.getMedications());
            }
        }

        // 合并胃肠摄入
        if (source.getEnteral() != null && !source.getEnteral().isEmpty()) {
            if (target.getEnteral() == null) {
                target.setEnteral(new ArrayList<>(source.getEnteral()));
            } else {
                target.getEnteral().addAll(source.getEnteral());
            }
        }

        // 合并尿量
        if (source.getUrines() != null && !source.getUrines().isEmpty()) {
            if (target.getUrines() == null) {
                target.setUrines(new ArrayList<>(source.getUrines()));
            } else {
                target.getUrines().addAll(source.getUrines());
            }
        }

        // 合并净超滤量
        if (source.getUltrafiltrations() != null && !source.getUltrafiltrations().isEmpty()) {
            if (target.getUltrafiltrations() == null) {
                target.setUltrafiltrations(new ArrayList<>(source.getUltrafiltrations()));
            } else {
                target.getUltrafiltrations().addAll(source.getUltrafiltrations());
            }
        }

        // 合并排出物
        if (source.getOutputs() != null && !source.getOutputs().isEmpty()) {
            if (target.getOutputs() == null) {
                target.setOutputs(new ArrayList<>(source.getOutputs()));
            } else {
                target.getOutputs().addAll(source.getOutputs());
            }
        }

        // 合并引流液
        if (source.getDrains() != null && !source.getDrains().isEmpty()) {
            if (target.getDrains() == null) {
                target.setDrains(new ArrayList<>(source.getDrains()));
            } else {
                target.getDrains().addAll(source.getDrains());
            }
        }

        // 合并检查
        if (source.getExamination() != null && !source.getExamination().isEmpty()) {
            if (target.getExamination() == null) {
                target.setExamination(new ArrayList<>(source.getExamination()));
            } else {
                target.getExamination().addAll(source.getExamination());
            }
        }

        // 合并治疗
        if (source.getTreatment() != null && !source.getTreatment().isEmpty()) {
            if (target.getTreatment() == null) {
                target.setTreatment(new ArrayList<>(source.getTreatment()));
            } else {
                target.getTreatment().addAll(source.getTreatment());
            }
        }

        // 合并基础护理
        if (source.getBasicCare() != null && !source.getBasicCare().isEmpty()) {
            if (target.getBasicCare() == null) {
                target.setBasicCare(new ArrayList<>(source.getBasicCare()));
            } else {
                target.getBasicCare().addAll(source.getBasicCare());
            }
        }

        // 合并健康教育
        if (source.getHealthEducation() != null && !source.getHealthEducation().isEmpty()) {
            if (target.getHealthEducation() == null) {
                target.setHealthEducation(new ArrayList<>(source.getHealthEducation()));
            } else {
                target.getHealthEducation().addAll(source.getHealthEducation());
            }
        }

        // 合并护理记录
        if (source.getNursingRecords() != null && !source.getNursingRecords().isEmpty()) {
            if (target.getNursingRecords() == null) {
                target.setNursingRecords(new ArrayList<>(source.getNursingRecords()));
            } else {
                target.getNursingRecords().addAll(source.getNursingRecords());
            }
        }

        // 签名：优先使用 source 的签名（如果有）
        if (source.getSignature() != null && !source.getSignature().isEmpty()) {
            target.setSignature(source.getSignature());
        }
    }

    /**
     * 从单个 HljldTimeRow 构建 HljldTimeGroup
     */
    private HljldTimeGroup buildGroupFromRow(HljldTimeRow row) {
        // 过滤
        List<NameAmountRoute> medications = row.getMedications() != null
            ? row.getMedications().stream().filter(NameAmountRoute::hasNameOrAmount).collect(Collectors.toList())
            : new ArrayList<>();
        List<NameAmountRoute> enteral = row.getEnteral() != null
            ? row.getEnteral().stream().filter(NameAmountRoute::hasNameOrAmount).collect(Collectors.toList())
            : new ArrayList<>();
        List<NameAmount> outputs = row.getOutputs() != null
            ? row.getOutputs().stream().filter(NameAmount::hasAmountValue).collect(Collectors.toList())
            : new ArrayList<>();
        List<NameAmount> drains = row.getDrains() != null
            ? row.getDrains().stream().filter(NameAmount::hasAmountValue).collect(Collectors.toList())
            : new ArrayList<>();
        List<String> urines = row.getUrines() != null
            ? row.getUrines().stream().filter(s -> !s.isEmpty()).collect(Collectors.toList())
            : new ArrayList<>();
        List<String> ultrafiltrations = row.getUltrafiltrations() != null
            ? row.getUltrafiltrations().stream().filter(s -> !s.isEmpty()).collect(Collectors.toList())
            : new ArrayList<>();
        List<String> examination = row.getExamination() != null
            ? row.getExamination().stream().filter(s -> !s.isEmpty()).collect(Collectors.toList())
            : new ArrayList<>();
        List<String> treatment = row.getTreatment() != null
            ? row.getTreatment().stream().filter(s -> !s.isEmpty()).collect(Collectors.toList())
            : new ArrayList<>();
        List<String> basicCare = row.getBasicCare() != null
            ? row.getBasicCare().stream().filter(s -> !s.isEmpty()).collect(Collectors.toList())
            : new ArrayList<>();
        List<String> healthEducation = row.getHealthEducation() != null
            ? row.getHealthEducation().stream().filter(s -> !s.isEmpty()).collect(Collectors.toList())
            : new ArrayList<>();
        List<String> nursingRecords = row.getNursingRecords() != null
            ? row.getNursingRecords().stream().filter(s -> !s.isEmpty()).collect(Collectors.toList())
            : new ArrayList<>();

        // 确定最大行数
        int lineCount = Math.max(1, Math.max(medications.size(), Math.max(enteral.size(),
            Math.max(Math.max(urines.size(), ultrafiltrations.size()),
            Math.max(Math.max(outputs.size(), drains.size()),
            Math.max(Math.max(examination.size(), treatment.size()),
            Math.max(Math.max(basicCare.size(), healthEducation.size()),
            nursingRecords.size())))))));

        if (lineCount <= 0) return null;

        long timestamp = row.getTime().getTime();
        String groupKey = row.getKey();
        List<HljldDisplayRow> displayRows = new ArrayList<>();

        for (int lineIndex = 0; lineIndex < lineCount; lineIndex++) {
            HljldDisplayRow dr = new HljldDisplayRow();
            dr.setKey(groupKey + "::" + lineIndex);
            dr.setGroupKey(groupKey);
            dr.setTimestamp(timestamp);
            dr.setLineIndex(lineIndex);
            dr.setFirstLine(lineIndex == 0);
            dr.setLastLine(lineIndex == lineCount - 1);
            dr.setTimeText(lineIndex == 0 ? row.getTimeText() : "");
            dr.setMedication(lineIndex < medications.size() ? medications.get(lineIndex) : null);
            dr.setEnteral(lineIndex < enteral.size() ? enteral.get(lineIndex) : null);
            dr.setUrine(lineIndex < urines.size() ? urines.get(lineIndex) : "");
            dr.setUltrafiltration(lineIndex < ultrafiltrations.size() ? ultrafiltrations.get(lineIndex) : "");
            dr.setOutput(lineIndex < outputs.size() ? outputs.get(lineIndex) : null);
            dr.setDrain(lineIndex < drains.size() ? drains.get(lineIndex) : null);
            dr.setExamination(lineIndex < examination.size() ? examination.get(lineIndex) : "");
            dr.setTreatment(lineIndex < treatment.size() ? treatment.get(lineIndex) : "");
            dr.setBasicCare(lineIndex < basicCare.size() ? basicCare.get(lineIndex) : "");
            dr.setHealthEducation(lineIndex < healthEducation.size() ? healthEducation.get(lineIndex) : "");
            dr.setNursingRecord(lineIndex < nursingRecords.size() ? nursingRecords.get(lineIndex) : "");
            dr.setSignature(lineIndex == lineCount - 1 ? row.getSignature() : "");
            displayRows.add(dr);
        }

        HljldTimeGroup group = new HljldTimeGroup();
        group.setKey(groupKey);
        group.setTimestamp(timestamp);
        group.setRows(displayRows);
        group.setTimeAdjusted(row.isTimeAdjusted()); // 传递时间调整标记
        return group;
    }

    // ══════════════════════════════════════════════════════════
    //  私有辅助方法
    // ══════════════════════════════════════════════════════════

    private void addCarryOverRow(List<HljldTimeRow> rows, HljldSourceData source, long dayStartMs,
                                  List<HljldUtils.NursingSegment> segments, long nowMs) {
        List<NameAmountRoute> carryMeds = new ArrayList<>();
        List<NameAmountRoute> carryEnteral = new ArrayList<>();

        for (Document execution : source.getDrugExecutions()) {
            if (!HljldUtils.isRenderableDrugExecution(execution)) continue;
            Document method = HljldUtils.findDrugMethod(str(execution, "methodCode"), source.getDrugMethods());
            if (method == null || !Boolean.FALSE.equals(method.get("isOnce"))) continue;

            long startMsExec = (long) HljldUtils.databaseTimeValue(str(execution, "startTime"));
            if (startMsExec == Long.MIN_VALUE || startMsExec >= dayStartMs) continue;
            if (!HljldUtils.isDrugOngoingAt(execution, dayStartMs)) continue;

            double cap = HljldUtils.round1(HljldUtils.resolveLiquidCap(execution));
            if (cap <= 0) continue;

            String name = HljldUtils.drugDisplayName(execution);
            if (name.isEmpty()) continue;

            double usedAt0700 = HljldUtils.round1(HljldUtils.calcDrugUsageUpTo(execution, dayStartMs));
            double remaining = HljldUtils.round1(cap - usedAt0700);
            // 实用量 = 整个日间段 [07:00, 17:00] 的完整用量
            HljldUtils.NursingSegment daySeg = segments.get(0);
            double currentUsage = HljldUtils.calcSegmentUsage(execution,
                daySeg.start, daySeg.end);

            // 根据药物方法配置判断是胃肠还是非胃肠
            boolean isEnteral = "胃肠".equals(str(method, "group"));

            // 药物治疗列过滤：不展示血液净化；其它中只展示含"雾化吸入"/"冲洗"的；会阴冲洗/擦洗也展示
            if (!isEnteral) {
                String group = str(method, "group");
                if ("血液净化".equals(group)
                    || ("其它".equals(group) && !name.contains("雾化吸入") && !name.contains("冲洗")
                        && !HljldUtils.hasPerinealCareNotes(execution))) {
                    continue;
                }
            }

            String displayName = isEnteral ? HljldUtils.enteralDisplayName(name) : name;

            NameAmountRoute cell = new NameAmountRoute(displayName,
                "续*剩余:" + String.format("%.0f", remaining) + "|实用:" + String.format("%.0f", currentUsage),
                HljldUtils.routeLabel(str(method, "name")), 0);

            if (isEnteral) {
                carryEnteral.add(cell);
            } else {
                carryMeds.add(cell);
            }
        }

        if (!carryMeds.isEmpty() || !carryEnteral.isEmpty()) {
            HljldTimeRow carryRow = new HljldTimeRow();
            carryRow.setKey("carry-over-" + dayStartMs);
            carryRow.setTime(new Date(dayStartMs));
            carryRow.setTimeText("");
            carryRow.setSortRank(-1);
            carryRow.setMedications(carryMeds);
            carryRow.setEnteral(carryEnteral);
            rows.add(carryRow);
        }
    }

    private void addNightSettlementRow(List<HljldTimeRow> rows, HljldSourceData source,
                                        HljldUtils.NursingSegment nightSegment, long nowMs) {
        List<HljldUtils.SegmentSettlement> settlements = HljldUtils.buildSegmentSettlements(
            source.getDrugExecutions(), source.getDrugMethods(), nightSegment, nowMs);
        List<NameAmountRoute> settlementMeds = new ArrayList<>();
        List<NameAmountRoute> settlementEnteral = new ArrayList<>();
        convertSettlements(settlements, settlementMeds, settlementEnteral);

        if (!settlementMeds.isEmpty() || !settlementEnteral.isEmpty()) {
            HljldTimeRow settlementRow = new HljldTimeRow();
            settlementRow.setKey("settlement-day-" + nightSegment.start.getTime());
            settlementRow.setTime(new Date(nightSegment.start.getTime() + 1000));
            settlementRow.setTimeText("");
            settlementRow.setSortRank(2);
            settlementRow.setMedications(settlementMeds);
            settlementRow.setEnteral(settlementEnteral);
            rows.add(settlementRow);
        }
    }

    private void addNightEndSettlementRow(List<HljldTimeRow> rows, HljldSourceData source,
                                           HljldUtils.NursingSegment nightSegment, long nowMs) {
        List<HljldUtils.SegmentSettlement> settlements = HljldUtils.buildSegmentSettlements(
            source.getDrugExecutions(), source.getDrugMethods(), nightSegment, nowMs);
        List<NameAmountRoute> settlementMeds = new ArrayList<>();
        List<NameAmountRoute> settlementEnteral = new ArrayList<>();
        convertSettlements(settlements, settlementMeds, settlementEnteral);

        if (!settlementMeds.isEmpty() || !settlementEnteral.isEmpty()) {
            HljldTimeRow settlementRow = new HljldTimeRow();
            settlementRow.setKey("settlement-night-" + nightSegment.end.getTime());
            settlementRow.setTime(new Date(nightSegment.end.getTime() + 1000));
            settlementRow.setTimeText("");
            settlementRow.setSortRank(2);
            settlementRow.setMedications(settlementMeds);
            settlementRow.setEnteral(settlementEnteral);
            rows.add(settlementRow);
        }
    }

    private void collectEnteralQuickAdd(List<NameAmountRoute> enteral, HljldSourceData source,
                                         List<Document> drugsInPeriod,
                                         List<Document> enteralCrossDayDrugs, long key) {
        Set<String> processedExecutions = new HashSet<>();
        // 合并区间内药物和跨日药物
        List<Document> allEnteralCandidates = new ArrayList<>();
        allEnteralCandidates.addAll(drugsInPeriod);
        allEnteralCandidates.addAll(enteralCrossDayDrugs);

        for (Document execution : allEnteralCandidates) {
            String execId = str(execution, "_id");
            if (processedExecutions.contains(execId)) continue;
            processedExecutions.add(execId);

            Document method = HljldUtils.findDrugMethod(str(execution, "methodCode"), source.getDrugMethods());
            if (method == null) continue;
            if (!"胃肠".equals(str(method, "group"))) continue;

            String drugName = HljldUtils.drugDisplayName(execution);
            if (!HljldUtils.hasQuickAddActions(execution)) continue;

            List<Map<String, Object>> actionList = getList(execution, "drugActionList");
            if (actionList == null) continue;

            for (Map<String, Object> action : actionList) {
                String act = str(action, "action").trim().toLowerCase();
                if (!"quickadd".equals(act)) continue;
                long actionKey = HljldUtils.minuteKey(str(action, "time"));
                if (actionKey != key) continue;
                double quickAddAmount = HljldUtils.parseAmount(action.get("quickAddAmount"));

                NameAmountRoute cell = new NameAmountRoute(
                    HljldUtils.enteralDisplayName(drugName),
                    quickAddAmount > 0 ? String.format("%.0f", quickAddAmount) : "0",
                    HljldUtils.routeLabel(str(method, "name")),
                    quickAddAmount);
                if (cell.hasNameOrAmount()) enteral.add(cell);
            }
        }
    }

    private void processDrugExecution(List<NameAmountRoute> medications, List<NameAmountRoute> enteral,
                                       Document execution, HljldSourceData source, long key, long timeMs,
                                       List<HljldUtils.NursingSegment> segments) {
        Document method = HljldUtils.findDrugMethod(str(execution, "methodCode"), source.getDrugMethods());
        if (method == null) return;

        boolean isEnteral = "胃肠".equals(str(method, "group"));
        String drugName = HljldUtils.drugDisplayName(execution);

        // 药物治疗列过滤：不展示血液净化；其它中只展示含"雾化吸入"/"冲洗"的；会阴冲洗/擦洗也展示
        if (!isEnteral) {
            String group = str(method, "group");
            if ("血液净化".equals(group)
                || ("其它".equals(group) && !drugName.contains("雾化吸入") && !drugName.contains("冲洗")
                    && !HljldUtils.hasPerinealCareNotes(execution))) {
                return;
            }
        }

        // 行为判定替代药名白名单：胃肠组且含带量 quickAdd 的执行按分次给药处理
        boolean isTargetEnteral = isEnteral && HljldUtils.hasQuickAddActions(execution);

        // 检查当前时间点是否有 quickAdd
        boolean hasQuickAddAtTime = false;
        if (isTargetEnteral) {
            List<Map<String, Object>> actionList = getList(execution, "drugActionList");
            if (actionList != null) {
                for (Map<String, Object> action : actionList) {
                    String act = str(action, "action").trim().toLowerCase();
                    if (!"quickadd".equals(act)) continue;
                    if (HljldUtils.minuteKey(str(action, "time")) != key) continue;
                    double quickAddAmount = HljldUtils.parseAmount(action.get("quickAddAmount"));
                    if (quickAddAmount > 0) { hasQuickAddAtTime = true; break; }
                }
            }
        }

        // 持续药物
        if (Boolean.FALSE.equals(method.get("isOnce"))) {
            long startMs = (long) HljldUtils.databaseTimeValue(str(execution, "startTime"));
            boolean ongoing = HljldUtils.isDrugOngoingAt(execution, timeMs);
            boolean startsAtTime = startMs != Long.MIN_VALUE && HljldUtils.minuteKey(new Date(startMs)) == key;

            if (!ongoing && !startsAtTime) return;

            if (startsAtTime) {
                // 开始行：显示从实际开始时间到段末的用量
                Optional<HljldUtils.NursingSegment> seg = segments.stream()
                    .filter(s -> startMs >= s.start.getTime() && startMs < s.end.getTime())
                    .findFirst();
                long segEndMs = seg.isPresent() ? seg.get().end.getTime() : startMs + 3600000;

                NameAmountRoute cell = HljldUtils.drugToCell(execution, method, isEnteral, startMs, startMs, segEndMs);
                cell.setAmount("实用量 " + String.format("%.0f", cell.getNumericAmount()));
                if (cell.hasNameOrAmount()) {
                    (isEnteral ? enteral : medications).add(cell);
                }
                return;
            }

            // 其余行：段初到当前时刻的累计
            Optional<HljldUtils.NursingSegment> seg = segments.stream()
                .filter(s -> timeMs > s.start.getTime() && timeMs <= s.end.getTime())
                .findFirst();
            long segStartMs = seg.isPresent() ? seg.get().start.getTime() : timeMs - 3600000;

            NameAmountRoute cell = HljldUtils.drugToCell(execution, method, isEnteral, timeMs, segStartMs, timeMs);
            if (cell.hasNameOrAmount()) {
                (isEnteral ? enteral : medications).add(cell);
            }
            return;
        }

        // 单次给药
        if (!hasQuickAddAtTime) {
            long startMs = (long) HljldUtils.databaseTimeValue(str(execution, "startTime"));
            boolean startsAtTime = startMs != Long.MIN_VALUE && HljldUtils.minuteKey(new Date(startMs)) == key;
            if (startsAtTime) {
                // 检查是否会被 collectEnteralQuickAdd 或 processEnteralStop 处理
                // 如果有 quickAdd 动作或 stop 动作满足条件，则不添加
                boolean willBeHandled = false;
                if (isTargetEnteral) {
                    List<Map<String, Object>> actionList = getList(execution, "drugActionList");
                    if (actionList != null) {
                        // 检查是否有任何 quickAdd 动作
                        boolean hasAnyQuickAdd = actionList.stream()
                            .anyMatch(a -> "quickadd".equals(str(a, "action").trim().toLowerCase()));

                        // 检查是否有 stop 动作且 quickAdd 累计 == liquidCap
                        double liquidCap = HljldUtils.resolveLiquidCap(execution);
                        double cumulativeQuickAdd = 0;
                        boolean hasStopWithFullAmount = false;
                        for (Map<String, Object> action : actionList) {
                            String act = str(action, "action").trim().toLowerCase();
                            if ("quickadd".equals(act)) {
                                cumulativeQuickAdd += HljldUtils.parseAmount(action.get("quickAddAmount"));
                            }
                            if ("stop".equals(act)) {
                                cumulativeQuickAdd += HljldUtils.parseAmount(action.get("quickAddAmount"));
                                if (Math.abs(cumulativeQuickAdd - liquidCap) < 0.05) {
                                    hasStopWithFullAmount = true;
                                }
                            }
                        }

                        // 如果有 quickAdd 动作，或者有 stop 动作且累计 == liquidCap
                        willBeHandled = hasAnyQuickAdd || hasStopWithFullAmount;
                    }
                }
                if (!willBeHandled) {
                    NameAmountRoute cell = HljldUtils.drugToCell(execution, method, isEnteral, startMs);
                    if (cell.hasNameOrAmount()) {
                        (isEnteral ? enteral : medications).add(cell);
                    }
                }
            }
        }
    }

    private void processEnteralStop(List<NameAmountRoute> medications, List<NameAmountRoute> enteral,
                                     List<Document> drugsInPeriod, List<Document> crossDayDrugs,
                                     HljldSourceData source, long key) {
        // 跨日药物 startTime 不在本护理日，但 stop 可能落在本护理日
        for (Document execution : crossDayDrugs) {
            processEnteralStopForExecution(medications, enteral, execution, source, key);
        }
        for (Document execution : drugsInPeriod) {
            processEnteralStopForExecution(medications, enteral, execution, source, key);
        }
    }

    private void processEnteralStopForExecution(List<NameAmountRoute> medications, List<NameAmountRoute> enteral,
                                                Document execution, HljldSourceData source, long key) {
        Document method = HljldUtils.findDrugMethod(str(execution, "methodCode"), source.getDrugMethods());
        if (method == null) return;
        if (!"胃肠".equals(str(method, "group"))) return;
        if (!HljldUtils.hasQuickAddActions(execution)) return;

        List<Map<String, Object>> actionList = getList(execution, "drugActionList");
        if (actionList == null) return;

        for (Map<String, Object> stopAction : actionList) {
            String act = str(stopAction, "action").trim().toLowerCase();
            if (!"stop".equals(act)) continue;
            if (HljldUtils.minuteKey(str(stopAction, "time")) != key) continue;

            long execStartMs = (long) HljldUtils.databaseTimeValue(str(execution, "startTime"));
            long stopMs = (long) HljldUtils.databaseTimeValue(str(stopAction, "time"));
            if (execStartMs == Long.MIN_VALUE || stopMs == Long.MIN_VALUE) continue;

            // 累积 stop 之前的所有 quickAdd 量
            double cumulativeQuickAdd = 0;
            for (Map<String, Object> a : actionList) {
                String aAct = str(a, "action").trim().toLowerCase();
                if (!"quickadd".equals(aAct)) continue;
                long aMs = (long) HljldUtils.databaseTimeValue(str(a, "time"));
                if (aMs >= execStartMs && aMs <= stopMs) {
                    cumulativeQuickAdd += HljldUtils.parseAmount(a.get("quickAddAmount"));
                }
            }
            cumulativeQuickAdd += HljldUtils.parseAmount(stopAction.get("quickAddAmount"));
            double liquidCap = HljldUtils.resolveLiquidCap(execution);

            if (Math.abs(cumulativeQuickAdd - liquidCap) < 0.05) {
                NameAmountRoute cell = HljldUtils.drugToCell(execution, method, true, stopMs);
                double stopAmount = HljldUtils.parseAmount(stopAction.get("quickAddAmount"));
                cell.setAmount(stopAmount > 0 ? String.format("%.0f", stopAmount) : "");
                cell.setNumericAmount(stopAmount);
                if (cell.hasNameOrAmount()) enteral.add(cell);
            }
        }
    }

    /**
     * 收集执行记录中带量给药动作（quickAdd/stop）的分钟键。
     * 分次给药的行按动作时间渲染，动作分钟若无护理/床旁记录同分钟，行会整体缺失——故将其纳入 uniqueKeys。
     * 仅收当前护理日区间内的动作，避免区间外动作（如次日 stop）在本页产生幻影行。
     */
    private void collectDoseActionKeys(Set<Long> uniqueKeys, Document execution,
                                       Date start, Date end, boolean startExclusive) {
        List<Map<String, Object>> actionList = getList(execution, "drugActionList");
        if (actionList == null) return;
        for (Map<String, Object> a : actionList) {
            String act = str(a, "action").trim().toLowerCase();
            boolean isDoseAction = "quickadd".equals(act)
                || ("stop".equals(act) && HljldUtils.parseAmount(a.get("quickAddAmount")) > 0);
            if (!isDoseAction) continue;
            if (!HljldUtils.inNursingRange(str(a, "time"), start, end, startExclusive)) continue;
            long k = HljldUtils.minuteKey(str(a, "time"));
            if (k != Long.MIN_VALUE) uniqueKeys.add(k);
        }
    }

    private String resolveSignature(List<Document> nurseRowsAtKey, HljldSourceData source, long timeMs) {
        // 有护理记录时优先用护理记录的记录者
        for (int i = nurseRowsAtKey.size() - 1; i >= 0; i--) {
            String name = HljldUtils.resolveNurseSignature(nurseRowsAtKey.get(i), source.getAccountMap());
            if (!name.isEmpty()) return name;
        }
        // 没有护理记录时回退到意识记录
        String signUserId = HljldUtils.resolveYishiSignerId(timeMs, source.getBedside());
        return signUserId.isEmpty() ? "" : source.getAccountMap().getOrDefault(signUserId, "");
    }

    private List<String> collectValues(List<Document> records, String code) {
        return records.stream()
            .filter(item -> code.equals(str(item, "code")))
            .map(item -> HljldUtils.displayAmount(item.get("strVal")))
            .filter(s -> !s.isEmpty())
            .collect(Collectors.toList());
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> getList(Document doc, String key) {
        Object v = doc.get(key);
        if (v instanceof List) return (List<Map<String, Object>>) v;
        return null;
    }

    private static String str(Document doc, String key) {
        Object v = doc.get(key);
        return v != null ? v.toString().trim() : "";
    }

    private static String str(Map<?, ?> map, String key) {
        Object v = map.get(key);
        return v != null ? v.toString().trim() : "";
    }

    /**
     * 将 SegmentSettlement 列表转换为 NameAmountRoute 列表，按 isEnteral 分类。
     */
    private void convertSettlements(List<HljldUtils.SegmentSettlement> settlements,
                                     List<NameAmountRoute> medications,
                                     List<NameAmountRoute> enteral) {
        for (HljldUtils.SegmentSettlement s : settlements) {
            // 药物治疗列过滤：不展示血液净化；其它中只展示含"雾化吸入"/"冲洗"的；会阴冲洗/擦洗也展示
            if (!s.isEnteral) {
                if ("血液净化".equals(s.group)
                    || ("其它".equals(s.group) && !s.name.contains("雾化吸入") && !s.name.contains("冲洗")
                        && !HljldUtils.hasPerinealCareNotes(s.execution))) {
                    continue;
                }
            }

            String amountText = HljldUtils.formatSegmentAmountText(s);
            String displayName = s.isEnteral ? HljldUtils.enteralDisplayName(s.name) : s.name;
            NameAmountRoute cell = new NameAmountRoute(displayName, amountText, s.route, s.segmentUsed);
            if (s.isEnteral) {
                enteral.add(cell);
            } else {
                medications.add(cell);
            }
        }
    }
}

package com.smartcare.backend.hljld;

import org.bson.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * 护理记录单工具类，完整移植前端 form-date.util.ts 和 hljld2-form.utils.ts 的业务逻辑。
 * <p>
 * 所有时区操作均使用 Asia/Shanghai，绝不使用服务器默认时区。
 * 所有数据来自 MongoDB，使用 {@link org.bson.Document} 表示。
 *
 * @author auto-generated
 */
public final class HljldUtils {

    private static final Logger log = LoggerFactory.getLogger(HljldUtils.class);

    private HljldUtils() { /* 工具类不可实例化 */ }

    // =========================================================================
    // 常量
    // =========================================================================

    /** 上海时区 */
    public static final ZoneId ZONE_SHANGHAI = ZoneId.of("Asia/Shanghai");

    /** CST (China Standard Time) 偏移量：UTC+8 毫秒 */
    private static final long CST_OFFSET_MS = 8L * 3600 * 1000;

    /** 毫秒/小时 */
    private static final double MS_PER_HOUR = 3_600_000.0;

    /** 毫秒/分钟 */
    private static final long MS_PER_MINUTE = 60_000L;

    // ---- 统计分类定义 ----

    /** 带入药量编码 */
    public static final String CODE_BROUGHT = "param_带入药量";
    /** 口服编码 */
    public static final String CODE_ORAL = "param_kouFu";
    /** 鼻饲编码 */
    public static final String CODE_TUBE_FEEDING = "param_biSi";
    /** 尿量编码 */
    public static final String URINE_CODE = "param_niaoLiang";
    /** 净超滤量编码 */
    public static final String ULTRAFILTRATION_CODE = "param_chaoLvLiang";

    /** 明细表「排出物」列的名称映射，不含尿量与净超滤量 */
    public static final Map<String, String> OUTPUT_CODE_NAMES;
    static {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("param_daBianAmount", "大便量");
        m.put("param_造瘘口量", "造瘘口量");
        m.put("param_outuwuliang", "呕吐物量");
        m.put("param_咯血", "咯血");
        m.put("param_tanLiang", "痰液量");
        OUTPUT_CODE_NAMES = Collections.unmodifiableMap(m);
    }

    /** bedside 中可展示的编码白名单 */
    public static final Set<String> DISPLAY_BEDSIDE_CODES;
    static {
        Set<String> s = new LinkedHashSet<>(Arrays.asList(
            CODE_BROUGHT, CODE_ORAL, CODE_TUBE_FEEDING,
            "param_YaoYeti_in_hour", "param_YaoStomach_in_hour",
            ULTRAFILTRATION_CODE, URINE_CODE, "param_daBianAmount",
            "param_造瘘口量", "param_outuwuliang",
            "param_咯血", "param_tanLiang",
            "param_外出检查", "param_物理治疗",
            "param_基础护理1", "param_健康教育"
        ));
        DISPLAY_BEDSIDE_CODES = Collections.unmodifiableSet(s);
    }

    /** 历史引流编码白名单 */
    public static final Set<String> LEGACY_DRAIN_CODES;
    static {
        LEGACY_DRAIN_CODES = Collections.unmodifiableSet(
            new HashSet<>(Collections.singletonList("param_tube_胃肠减压")));
    }

    /** 排出物小结定义 */
    public static final List<Map<String, String>> EXCRETION_SUMMARY_DEFINITIONS;
    static {
        List<Map<String, String>> list = new ArrayList<>();
        list.add(Map.of("key", "stool", "code", "param_daBianAmount", "label", "大便量"));
        list.add(Map.of("key", "stoma", "code", "param_造瘘口量", "label", "造瘘口量"));
        list.add(Map.of("key", "vomit", "code", "param_outuwuliang", "label", "呕吐物量"));
        list.add(Map.of("key", "hemoptysis", "code", "param_咯血", "label", "咯血"));
        list.add(Map.of("key", "sputum", "code", "param_tanLiang", "label", "痰液量"));
        EXCRETION_SUMMARY_DEFINITIONS = Collections.unmodifiableList(list);
    }

    /** 参与出入量统计的入量通道，其余（含空值）一律不计 */
    public static final Set<String> COUNTED_IN_CHANNELS;
    static {
        COUNTED_IN_CHANNELS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList("胃肠", "静脉", "输血")));
    }

    /** 肠内营养泵入判定正则 */
    public static final Pattern ENTERAL_NUTRITION_PATTERN = Pattern.compile("肠内营养");

    /** 动作别名规范化映射（trim + 小写 + 中英别名） */
    public static final Map<String, String> ACTION_ALIAS;
    static {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("start", "speed"); m.put("begin", "speed"); m.put("recovery", "speed");
        m.put("resume", "speed"); m.put("add", "speed"); m.put("minus", "speed");
        m.put("adjust", "speed"); m.put("change", "speed");
        m.put("开始", "speed"); m.put("升始", "speed");
        m.put("恢复", "speed"); m.put("调速", "speed");
        m.put("加速", "speed"); m.put("减速", "speed");
        m.put("降速", "speed"); m.put("调快", "speed");
        m.put("调慢", "speed");
        m.put("pause", "pause"); m.put("暂停", "pause");
        m.put("stop", "stop"); m.put("end", "stop"); m.put("complete", "stop");
        m.put("finish", "stop"); m.put("停止", "stop");
        m.put("完成", "stop"); m.put("结束", "stop");
        m.put("quickadd", "quickAdd"); m.put("bolus", "quickAdd");
        m.put("快推", "quickAdd");
        ACTION_ALIAS = Collections.unmodifiableMap(m);
    }

    /** 变更速度的动作集合 */
    public static final Set<String> SPEED_ACTIONS;
    static {
        SPEED_ACTIONS = Collections.unmodifiableSet(
            new HashSet<>(Arrays.asList("start", "recovery", "add", "minus")));
    }

    /** 默认备注行（选项之间保留空格，提升可读性） */
    public static final List<String> DEFAULT_REMARK_LINES = Arrays.asList(
        "检查：A：CT B：核磁共振 C：胃镜 D：肠镜 E：超声检查 F：床旁胸片 G：心电图",
        "治疗：A：机械辅助排痰B：气压治疗C：支气管镜灌洗D：TDP照射E：针灸治疗F：运动治疗G：肺复张",
        "基础护理：A：口腔护理B：动/静脉置管护理C：擦浴D：肛周护理E：压疮护理F：床上洗头",
        "健康教育：A：入院指导 B：入科指导 C：疾病知识 D：药物指导 E：饮食指导 F：肢体活动指导 G：检查指导 H：安全指导 I：心理指导 J：术前指导 K：术后指导 L：转科/出院指导 M：用氧注意事项 N：通气配合指导 O：康复指导 P：VTE预防指导"
    );

    // =========================================================================
    // Date/Time 工具方法
    // =========================================================================

    /**
     * 解析数据库/API时间，返回绝对毫秒时间戳。
     * 支持格式：ISO字符串、"Fri Jul 24 09:00:00 CST 2026" legacy格式、Unix毫秒、纯日期 YYYY-MM-DD。
     * 解析失败返回 {@link Double#NaN}（绝不返回 0）。
     *
     * @param value 待解析的时间值（可以是 String、Number、Date、null）
     * @return 绝对毫秒时间戳，解析失败返回 NaN
     */
    public static double databaseTimeValue(Object value) {
        if (value == null) return Double.NaN;
        if (value instanceof Date) {
            long t = ((Date) value).getTime();
            return Long.MIN_VALUE == t ? Double.NaN : t;
        }
        if (value instanceof Number) {
            double d = ((Number) value).doubleValue();
            return Double.isNaN(d) || Double.isInfinite(d) ? Double.NaN : d;
        }
        String raw = String.valueOf(value).trim();
        if (raw.isEmpty()) return Double.NaN;

        // Unix毫秒时间戳 (13位或更多数字)
        if (raw.matches("^\\d{13,}$")) {
            try {
                double v = Double.parseDouble(raw);
                return Double.isFinite(v) ? v : Double.NaN;
            } catch (NumberFormatException e) {
                return Double.NaN;
            }
        }

        // 纯日期 YYYY-MM-DD
        if (raw.matches("^\\d{4}-\\d{2}-\\d{2}$")) {
            try {
                SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
                sdf.setTimeZone(TimeZone.getTimeZone("UTC"));
                Date d = sdf.parse(raw);
                return d != null ? d.getTime() : Double.NaN;
            } catch (ParseException e) {
                return Double.NaN;
            }
        }

        // Legacy Java Date.toString(): "Fri Jul 24 09:00:00 CST 2026"
        Double legacy = parseLegacyCstString(raw);
        if (legacy != null) return legacy;

        // ISO格式：带Z/偏移量，或无时区
        if (raw.matches("^\\d{4}-\\d{2}-\\d{2}.*")) {
            String normalized = raw.replace(' ', 'T');
            boolean hasTZ = normalized.matches(".*(?:Z|[+-]\\d{2}:?\\d{2})$");
            String src = hasTZ ? normalized : normalized + "Z";
            try {
                SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
                sdf.setTimeZone(TimeZone.getTimeZone("UTC"));
                // 尝试多种格式
                Date d = tryParseIsoDate(src);
                if (d != null) return d.getTime();
            } catch (Exception e) {
                // fall through
            }
        }

        // 其他格式：尝试原生解析
        try {
            SimpleDateFormat sdf = new SimpleDateFormat("EEE MMM dd HH:mm:ss zzz yyyy", Locale.US);
            Date d = sdf.parse(raw);
            if (d != null) return d.getTime();
        } catch (ParseException e) {
            // fall through
        }

        log.info("[hljld] databaseTimeValue 解析失败: raw={}", raw);
        return Double.NaN;
    }

    /**
     * 安全提取时间戳毫秒。对 Date 类型直接 getTime()，避免 String.valueOf 导致的时区双重转换。
     * 对其他类型委托 databaseTimeValue。
     */
    public static double toTimestampMs(Object value) {
        if (value instanceof Date) {
            return ((Date) value).getTime();
        }
        if (value instanceof Number) {
            return ((Number) value).doubleValue();
        }
        return databaseTimeValue(value);
    }

    /**
     * 解析 Java Date.toString() 格式的时间字符串（如 "Fri Jul 24 09:00:00 CST 2026"），
     * 也支持 "Fri Aug 28 2026 12:36:00 GMT+0800" 格式。
     * CST = China Standard Time (UTC+8)，手工解析避免歧义。
     */
    private static Double parseLegacyCstString(String raw) {
        Map<String, Integer> months = new HashMap<>();
        months.put("Jan", 0); months.put("Feb", 1); months.put("Mar", 2);
        months.put("Apr", 3); months.put("May", 4); months.put("Jun", 5);
        months.put("Jul", 6); months.put("Aug", 7); months.put("Sep", 8);
        months.put("Oct", 9); months.put("Nov", 10); months.put("Dec", 11);

        // Pattern 1: "Fri Jul 24 09:00:00 CST 2026" — timezone is letters only
        Matcher m1 = Pattern.compile(
            "^[A-Za-z]{3}\\s+([A-Za-z]{3})\\s+(\\d{1,2})\\s+(\\d{2}):(\\d{2}):(\\d{2})\\s+[A-Za-z]{2,5}\\s+(\\d{4})$"
        ).matcher(raw);
        if (m1.find()) {
            Integer mi = months.get(m1.group(1));
            if (mi != null) {
                int year = Integer.parseInt(m1.group(6));
                int day = Integer.parseInt(m1.group(2));
                int hh = Integer.parseInt(m1.group(3));
                int mm = Integer.parseInt(m1.group(4));
                int ss = Integer.parseInt(m1.group(5));
                Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
                cal.set(year, mi, day, hh, mm, ss);
                cal.set(Calendar.MILLISECOND, 0);
                long utcMs = cal.getTimeInMillis() - CST_OFFSET_MS;
                return (double) utcMs;
            }
        }

        // Pattern 2: "Fri Aug 28 2026 12:36:00 GMT+0800" — year BEFORE time
        Matcher m2 = Pattern.compile(
            "^[A-Za-z]{3}\\s+([A-Za-z]{3})\\s+(\\d{1,2})\\s+(\\d{4})\\s+(\\d{2}):(\\d{2}):(\\d{2})\\s+GMT([+-]\\d{4})$"
        ).matcher(raw);
        if (m2.find()) {
            Integer mi = months.get(m2.group(1));
            if (mi != null) {
                int year = Integer.parseInt(m2.group(4));
                int day = Integer.parseInt(m2.group(3));
                int hh = Integer.parseInt(m2.group(5));
                int mm = Integer.parseInt(m2.group(6));
                int ss = Integer.parseInt(m2.group(7));
                // Parse offset like "+0800" or "-0500"
                String offsetStr = m2.group(8);
                boolean negative = offsetStr.startsWith("-");
                String digits = offsetStr.substring(1);
                int offsetHours = Integer.parseInt(digits.substring(0, 2));
                int offsetMins = Integer.parseInt(digits.substring(2, 4));
                long offsetMs = (offsetHours * 3600L + offsetMins * 60L) * 1000L;
                if (negative) offsetMs = -offsetMs;
                Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
                cal.set(year, mi, day, hh, mm, ss);
                cal.set(Calendar.MILLISECOND, 0);
                long utcMs = cal.getTimeInMillis() - offsetMs;
                return (double) utcMs;
            }
        }

        return null;
    }

    /**
     * 尝试用多种 ISO 格式解析日期字符串。
     */
    private static Date tryParseIsoDate(String src) {
        String[] patterns = {
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            "yyyy-MM-dd'T'HH:mm:ss'Z'",
            "yyyy-MM-dd'T'HH:mm:ss.SSSZ",
            "yyyy-MM-dd'T'HH:mm:ssZ",
            "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
            "yyyy-MM-dd'T'HH:mm:ssXXX",
        };
        for (String pattern : patterns) {
            try {
                SimpleDateFormat sdf = new SimpleDateFormat(pattern, Locale.US);
                sdf.setTimeZone(TimeZone.getTimeZone("UTC"));
                sdf.setLenient(false);
                Date d = sdf.parse(src);
                if (d != null) return d;
            } catch (ParseException e) {
                // try next
            }
        }
        return null;
    }

    /**
     * 将绝对毫秒时间戳格式化为上海时间 yyyy-MM-dd HH:mm。
     *
     * @param ms 毫秒时间戳
     * @return 格式化后的日期时间字符串
     */
    public static String formatShanghaiDateMinute(long ms) {
        if (Double.isNaN(ms) || ms <= 0) return "";
        Instant instant = Instant.ofEpochMilli(ms);
        LocalDateTime ldt = LocalDateTime.ofInstant(instant, ZONE_SHANGHAI);
        return ldt.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"));
    }

    /**
     * 将绝对毫秒时间戳格式化为上海时间 yyyy-MM-dd HH:mm。
     * 重载版本接受 double（兼容 databaseTimeValue 返回值）。
     */
    public static String formatShanghaiDateMinute(double ms) {
        if (Double.isNaN(ms) || ms <= 0) return "";
        return formatShanghaiDateMinute((long) ms);
    }

    /**
     * 护理日左端点：当日 07:00，本身计入（区间左闭）。
     *
     * @param selectedDate 选择的日期
     * @return 当日 07:00 的 Date
     */
    public static Date startOfNursingDay(Date selectedDate) {
        Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        cal.setTime(selectedDate);
        cal.set(Calendar.HOUR_OF_DAY, 7);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        return cal.getTime();
    }

    /**
     * 护理日右端点：次日 07:00，本身不计入（区间右开）。
     *
     * @param selectedDate 选择的日期
     * @return 次日 07:00 的 Date
     */
    public static Date endOfNursingDay(Date selectedDate) {
        Date start = startOfNursingDay(selectedDate);
        Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        cal.setTime(start);
        cal.add(Calendar.DAY_OF_MONTH, 1);
        return cal.getTime();
    }

    /**
     * 分钟键：使用绝对毫秒时间戳除以 60000 取整。
     * 保证跨时区和跨数据源的分钟匹配一致。
     *
     * @param value 时间值（String 或 Date）
     * @return 分钟级整数键，解析失败返回 NaN
     */
    public static long minuteKey(Object value) {
        double timestamp;
        if (value instanceof Date) {
            timestamp = ((Date) value).getTime();
        } else {
            timestamp = databaseTimeValue(value);
        }
        if (!Double.isFinite(timestamp)) return Long.MIN_VALUE;
        return (long) Math.floor(timestamp / MS_PER_MINUTE);
    }

    /**
     * 将绝对毫秒时间戳格式化为上海时间 yyyy-MM-dd HH:mm。
     * 与 formatShanghaiDateMinute 等价，用于语义区分。
     */
    public static String formatTime(long ms) {
        return formatShanghaiDateMinute(ms);
    }

    /**
     * 将绝对毫秒时间戳格式化为上海时间 yyyy-MM-dd HH:mm。
     * 重载版本接受 double。
     */
    public static String formatTime(double ms) {
        return formatShanghaiDateMinute(ms);
    }

    /**
     * 从各种类型解析数值金额。
     *
     * @param value 待解析的值
     * @return 数值，解析失败返回 0
     */
    public static double parseAmount(Object value) {
        if (value == null) return 0;
        if (value instanceof Number) {
            double v = ((Number) value).doubleValue();
            return Double.isFinite(v) ? v : 0;
        }
        String s = String.valueOf(value).trim();
        if (s.isEmpty()) return 0;
        // 将中文逗号替换为点
        s = s.replace(',', '.');
        Matcher m = Pattern.compile("-?\\d+(?:\\.\\d+)?").matcher(s);
        if (m.find()) {
            try {
                return Double.parseDouble(m.group());
            } catch (NumberFormatException e) {
                return 0;
            }
        }
        return 0;
    }

    /**
     * 显示金额值，null/undefined 返回空字符串。
     */
    public static String displayAmount(Object value) {
        if (value == null) return "";
        return String.valueOf(value).trim();
    }

    /**
     * 判断字符串是否有实际文本内容（非 null、非空白）。
     */
    public static boolean hasText(Object value) {
        if (value == null) return false;
        String s = String.valueOf(value).trim();
        return !s.isEmpty();
    }

    /**
     * 统一解析患者时间字段，使用 databaseTimeValue 处理数据库时区。
     *
     * @param value 患者时间字段字符串
     * @return 绝对毫秒时间戳，解析失败返回 NaN
     */
    public static double parsePatientDateTime(String value) {
        if (value == null || value.trim().isEmpty()) return Double.NaN;
        double ts = databaseTimeValue(value);
        return Double.isFinite(ts) ? ts : Double.NaN;
    }

    // =========================================================================
    // 有效住院区间
    // =========================================================================

    /**
     * 有效住院区间结果。
     */
    public static class ActiveStayRange {
        public final Date nursingDayStart;
        public final Date nursingDayEnd;
        public final Date effectiveStart;
        public final Date effectiveEnd;
        public final boolean admissionClipped;
        public final boolean dischargeClipped;
        public final boolean beforeAdmission;
        public final boolean afterDischarge;
        public final boolean hasValidRange;
        public final boolean startExclusive;

        public ActiveStayRange(Date nursingDayStart, Date nursingDayEnd,
                               Date effectiveStart, Date effectiveEnd,
                               boolean admissionClipped, boolean dischargeClipped,
                               boolean beforeAdmission, boolean afterDischarge,
                               boolean hasValidRange, boolean startExclusive) {
            this.nursingDayStart = nursingDayStart;
            this.nursingDayEnd = nursingDayEnd;
            this.effectiveStart = effectiveStart;
            this.effectiveEnd = effectiveEnd;
            this.admissionClipped = admissionClipped;
            this.dischargeClipped = dischargeClipped;
            this.beforeAdmission = beforeAdmission;
            this.afterDischarge = afterDischarge;
            this.hasValidRange = hasValidRange;
            this.startExclusive = startExclusive;
        }
    }

    /**
     * 计算有效住院区间，考虑入科/出科裁剪。
     *
     * @param patient            患者信息 Document（包含 admissionTime、dischargeTime）
     * @param nursingDayStart    护理日开始
     * @param nursingDayEnd      护理日结束
     * @param skipDischargeClip  是否跳过出科裁剪（打印时使用完整护理日范围）
     * @return 有效住院区间
     */
    public static ActiveStayRange resolveActiveStayRange(
            Document patient,
            Date nursingDayStart,
            Date nursingDayEnd,
            boolean skipDischargeClip) {

        double admissionTs = parsePatientDateTime(strOrNull(patient, "icuAdmissionTime"));
        if (!Double.isFinite(admissionTs)) {
            admissionTs = parsePatientDateTime(strOrNull(patient, "admissionTime"));
        }
        double dischargeTs = parsePatientDateTime(strOrNull(patient, "icuDischargeTime"));
        if (!Double.isFinite(dischargeTs)) {
            dischargeTs = parsePatientDateTime(strOrNull(patient, "dischargeTime"));
        }

        Date admissionTime = Double.isFinite(admissionTs) ? new Date((long) admissionTs) : null;
        Date dischargeTime = Double.isFinite(dischargeTs) ? new Date((long) dischargeTs) : null;

        long dayStartMinute = minuteInstant(nursingDayStart);
        long dayEndMinute = minuteInstant(nursingDayEnd);

        // effectiveStart = max(nursingDayStart, admissionTime)
        Date effectiveStart = new Date(nursingDayStart.getTime());
        boolean admissionClipped = false;
        if (admissionTime != null && minuteInstant(admissionTime) > dayStartMinute) {
            effectiveStart = admissionTime;
            admissionClipped = true;
        }

        // effectiveEnd = min(nursingDayEnd, dischargeTime)
        Date effectiveEnd = new Date(nursingDayEnd.getTime());
        boolean dischargeClipped = false;
        if (!skipDischargeClip && dischargeTime != null && minuteInstant(dischargeTime) < dayEndMinute) {
            effectiveEnd = dischargeTime;
            dischargeClipped = true;
        }

        // 右开：入科时间正好等于次日 07:00 时不属于本护理日
        boolean beforeAdmission = admissionTime != null && minuteInstant(admissionTime) > dayEndMinute;
        // 左闭：出科时间正好等于当日 07:00 时仍属于本护理日
        boolean afterDischarge = dischargeTime != null && minuteInstant(dischargeTime) < dayStartMinute;

        // 护理日 07:00 始终属于当天（左闭），startExclusive 只在入科裁剪时用于
        // 标记 effectiveStart 可能不精确到分钟（用于统计差值场景）。
        // 正常护理日 range 为 [07:00, 次日07:00)，07:00 必须包含。
        boolean startExclusive = false;
        long startMinute = minuteInstant(effectiveStart);
        long endMinute = minuteInstant(effectiveEnd);
        boolean hasValidRange = !beforeAdmission && !afterDischarge
            && endMinute >= startMinute;

        return new ActiveStayRange(
            nursingDayStart, nursingDayEnd, effectiveStart, effectiveEnd,
            admissionClipped, dischargeClipped, beforeAdmission, afterDischarge,
            hasValidRange, startExclusive);
    }

    /**
     * 计算有效住院区间（默认不跳过出科裁剪）。
     */
    public static ActiveStayRange resolveActiveStayRange(
            Document patient, Date nursingDayStart, Date nursingDayEnd) {
        return resolveActiveStayRange(patient, nursingDayStart, nursingDayEnd, false);
    }

    // =========================================================================
    // Minute Instant 工具
    // =========================================================================

    /**
     * 将任意时间归一到所属分钟的起始毫秒，与 minuteKey 同粒度。
     * 统计与展示都按分钟对齐，避免 07:00:30 这类秒级数据在两个护理日重复出现。
     *
     * @param value 时间值（String、Date 或 long）
     * @return 分钟级毫秒时间戳，解析失败返回 NaN
     */
    public static long minuteInstant(Object value) {
        double ts;
        if (value instanceof Long) {
            ts = (long) value;
        } else if (value instanceof Integer) {
            ts = (int) value;
        } else if (value instanceof Date) {
            ts = ((Date) value).getTime();
        } else if (value instanceof Number) {
            ts = ((Number) value).doubleValue();
        } else {
            ts = databaseTimeValue(value);
        }
        if (!Double.isFinite(ts)) return Long.MIN_VALUE;
        return (long) (Math.floor(ts / MS_PER_MINUTE) * MS_PER_MINUTE);
    }

    /**
     * 重载版本，接受 long 类型。
     */
    public static long minuteInstant(long value) {
        return (long) (Math.floor(value / MS_PER_MINUTE) * MS_PER_MINUTE);
    }

    // =========================================================================
    // 护理日范围判断
    // =========================================================================

    /**
     * 护理日统计区间判断，默认左闭右开 [start, end)。
     * <p>
     * 07:00 起属于当前护理日，次日 07:00 不属于当前护理日，即 [07:00, 次日07:00)。
     *
     * @param value          待判断的时间值
     * @param start          区间开始
     * @param end            区间结束
     * @param startExclusive true 时使用左开区间 (start, end)
     * @return 是否在范围内
     */
    public static boolean inNursingRange(Object value, Date start, Date end, boolean startExclusive) {
        long ts = minuteInstant(value);
        if (ts == Long.MIN_VALUE) return false;
        long startMs = minuteInstant(start);
        long endMs = minuteInstant(end);
        if (startMs == Long.MIN_VALUE || endMs == Long.MIN_VALUE) return false;
        return (startExclusive ? ts > startMs : ts >= startMs) && ts < endMs;
    }

    /**
     * 护理日统计区间判断，默认左闭右开。
     */
    public static boolean inNursingRange(Object value, Date start, Date end) {
        return inNursingRange(value, start, end, false);
    }

    // =========================================================================
    // 引流/Bedside 判断
    // =========================================================================

    /**
     * 判断 bedside 项目是否属于引流量。
     * 兼容历史编码 param_tube_胃肠减压 和 code 中包含"引流"的项目。
     */
    public static boolean isDrainCode(String code) {
        String normalizedCode = (code == null ? "" : code).trim();
        if (normalizedCode.isEmpty()) return false;
        return LEGACY_DRAIN_CODES.contains(normalizedCode) || normalizedCode.contains("引流");
    }

    /**
     * 将引流编码转换为显示名称。
     * 例如 param_tube_胃肠减压 → 胃管负压引流量。
     */
    public static String drainName(String code) {
        String normalizedCode = (code == null ? "" : code).trim();
        if ("param_tube_胃肠减压".equals(normalizedCode)) {
            return "胃管负压引流量";
        }
        String stripped = normalizedCode
            .replaceFirst("^param_tube_", "")
            .replaceFirst("^param_", "");
        if (stripped.endsWith("管")) {
            return stripped.substring(0, stripped.length() - 1) + "液";
        }
        return stripped.replace("管", "液");
    }

    /**
     * 判断 bedside 记录是否可渲染。
     */
    public static boolean isRenderableBedsideRecord(Document record) {
        if (record == null) return false;
        String time = strOrNull(record, "time");
        String code = strOrNull(record, "code");
        if (time == null || time.isEmpty() || code == null || code.isEmpty()) return false;
        if (!isValidBusinessRecord(record)) return false;
        if ("param_Yishi".equals(code)) return false;
        if (!DISPLAY_BEDSIDE_CODES.contains(code) && !isDrainCode(code)) return false;
        return hasText(record.get("strVal")) || hasText(record.get("remark"));
    }

    /**
     * 统一 valid/status 过滤。
     * 与前端 isValidBusinessRecord 保持一致：仅排除 valid=false，字段缺失视为有效。
     * 若要求 valid 必须为 true，会丢失 valid 字段缺失的记录（如急救/复苏等快捷录入），
     * 导致表单显示而打印缺失。
     */
    public static boolean isValidBusinessRecord(Document record) {
        if (record == null) return false;
        Object valid = record.get("valid");
        if (Boolean.FALSE.equals(valid)) return false;
        String status = strOrNull(record, "status");
        if ("invalid".equalsIgnoreCase(status)) return false;
        return true;
    }

    /**
     * 统一 valid/status 过滤（Map 版本）。
     * 与前端一致：仅排除 valid=false，字段缺失视为有效。
     */
    public static boolean isValidBusinessRecord(Map<?, ?> record) {
        if (record == null) return false;
        Object valid = record.get("valid");
        if (Boolean.FALSE.equals(valid)) return false;
        Object statusObj = record.get("status");
        if (statusObj != null && "invalid".equalsIgnoreCase(String.valueOf(statusObj).trim())) return false;
        return true;
    }

    // =========================================================================
    // 药物方法匹配
    // =========================================================================

    /**
     * 按编码匹配药物方法配置。配置的 code 字段与执行记录的 methodCode 均可能以 '、' 分隔，
     * 复合编码（如 "1、154"）各段指向同一途径，任一段命中即返回。
     *
     * @param methodCode 药物方法编码（可能为复合编码）
     * @param configs    药物方法配置列表
     * @return 匹配的配置 Document，未找到返回 null
     */
    public static Document findDrugMethod(String methodCode, List<Document> configs) {
        List<String> targetParts = splitMethodCodes(methodCode);
        if (targetParts.isEmpty()) return null;
        for (Document config : configs) {
            if (Boolean.FALSE.equals(config.get("valid"))) continue;
            String code = strOrNull(config, "code");
            if (code == null) continue;
            for (String configPart : code.split("、")) {
                String trimmed = configPart.trim();
                if (!trimmed.isEmpty() && targetParts.contains(trimmed)) {
                    return config;
                }
            }
        }
        return null;
    }

    /**
     * 拆分方法编码，支持 '、' 复合编码，去空并保持顺序。
     */
    public static List<String> splitMethodCodes(String methodCode) {
        String value = (methodCode == null ? "" : methodCode).trim();
        if (value.isEmpty()) return Collections.emptyList();
        List<String> parts = new ArrayList<>();
        for (String part : value.split("、")) {
            String trimmed = part.trim();
            if (!trimmed.isEmpty() && !parts.contains(trimmed)) {
                parts.add(trimmed);
            }
        }
        return parts;
    }

    /**
     * 根据方法名称映射途径标签。
     */
    public static String routeLabel(String name) {
        String value = name == null ? "" : name;
        if (value.contains("输液泵") || value.contains("静滴")) return "ivgtt";
        if (value.contains("微量泵")) return "iv泵";
        if (value.contains("肌肉注射")) return "im";
        if (value.contains("皮下注射")) return "IH";
        if (value.contains("静注")) return "iv";
        if (value.contains("口服")) return "po";
        if (value.contains("胃管置管术")) return "鼻饲";
        if (ENTERAL_NUTRITION_PATTERN.matcher(value).find()) return "鼻饲注入";
        return value;
    }

    /**
     * 肠内营养显示名称简化。
     * 匹配顺序必须严格：TP-HE → 瑞高, TPF-T → 瑞能, SP → 短肽, TP → 瑞素。
     * TP 必须最后匹配，因为 TP-HE、TPF-T 都包含 TP。
     * 同时兼容中文商品名：短肽、瑞高、瑞能、瑞素。
     */
    public static String enteralDisplayName(String rawName) {
        String original = rawName == null ? "" : rawName.trim();
        String normalized = original.toUpperCase(Locale.ROOT);
        // 按匹配顺序：最长/最具体优先
        if (normalized.contains("TP-HE") || original.contains("瑞高")) return "瑞高";
        if (normalized.contains("TPF-T") || original.contains("瑞能")) return "瑞能";
        if (normalized.contains("SP") || original.contains("短肽")) return "短肽";
        if (normalized.contains("TP") || original.contains("瑞素")) return "瑞素";
        return original;
    }

    /**
     * 获取药物显示名称（drugList 中所有 name 用 '、' 连接）。
     */
    public static String drugDisplayName(Document execution) {
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> drugList = (List<Map<String, Object>>) execution.get("drugList");
        if (drugList == null) return "";
        return drugList.stream()
            .map(item -> strOrNull(item, "name"))
            .filter(n -> n != null && !n.trim().isEmpty())
            .map(String::trim)
            .collect(Collectors.joining("、"));
    }

    // =========================================================================
    // 速度归一化与液体封顶
    // =========================================================================

    /**
     * 速度归一为 ml/h；单位缺失按 ml/h 处理。
     */
    public static double normalizeSpeed(Map<?, ?> action) {
        double speed = parseAmount(action.get("speed"));
        if (!Double.isFinite(speed) || speed <= 0) return 0;
        String unit = strOrNull(action, "speedUnit");
        if (unit != null) unit = unit.trim().toLowerCase();
        if ("ml/min".equals(unit)) return speed * 60;
        if (unit != null && !unit.isEmpty()
            && !"ml/h".equals(unit) && !"ml/hour".equals(unit) && !"ml/hours".equals(unit)) {
            log.warn("[hljld] 未识别的速度单位，按 ml/h 处理：{}", unit);
        }
        return speed;
    }

    /**
     * 顶层 liquidAmount 优先，缺失时回退 drugList 求和。
     */
    public static double resolveLiquidCap(Document execution) {
        double top = parseAmount(execution.get("liquidAmount"));
        if (top > 0) return top;
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> drugList = (List<Map<String, Object>>) execution.get("drugList");
        if (drugList == null) return 0;
        return drugList.stream()
            .mapToDouble(d -> parseAmount(d.get("liquidAmount")))
            .sum();
    }

    // =========================================================================
    // 持续用药实际用量计算
    // =========================================================================

    /**
     * 持续用药实际用量结果。
     */
    public static class DrugActualAmount {
        /** 落在统计区间内的实际入量，全精度不舍入 */
        public final double inRange;
        /** 全程累计实际入量（已封顶），用于自检 */
        public final double total;
        /** 无动作数据，已回退为开始时点全额计入 */
        public final boolean fallback;

        public DrugActualAmount(double inRange, double total, boolean fallback) {
            this.inRange = inRange;
            this.total = total;
            this.fallback = fallback;
        }
    }

    /**
     * 按 drugActionList 计算持续用药在 (rangeStart, rangeEnd] 内的实际入量。
     * <p>
     * 规则：
     * 1. speed 为变更后的绝对速度，单位 ml/h；start/recovery/add/minus 均置为该值。
     * 2. pause 期间速度记 0，recovery 恢复为该条 speed。
     * 3. quickAdd 为该时刻的瞬时快推，不改变速度，占用 liquidAmount 额度。
     * 4. 结束时刻取顶层 endTime；未结束时算到 min(当前时刻, rangeEnd)。
     * 5. 提前 stop 时按积分自然截断，未输完的液体不计。
     * 6. 累计量封顶到 liquidAmount，触顶即视为在跑满那一刻结束。
     * 7. 全程保留毫秒精度，不做分钟归一；舍入只在展示层做一次。
     *
     * @param execution      药物执行记录 Document
     * @param rangeStart     统计区间开始
     * @param rangeEnd       统计区间结束
     * @param startExclusive 是否左开区间
     * @return 实际入量结果
     */
    @SuppressWarnings("unchecked")
    public static DrugActualAmount calcContinuousDrugAmount(
            Document execution,
            Date rangeStart,
            Date rangeEnd,
            boolean startExclusive) {

        long rangeStartMs = rangeStart.getTime();
        long rangeEndMs = rangeEnd.getTime();
        double startMsRaw = toTimestampMs(execution.get("startTime"));
        if (!Double.isFinite(startMsRaw) || startMsRaw <= 0) return new DrugActualAmount(0, 0, false);
        long startMs = (long) startMsRaw;

        double cap = resolveLiquidCap(execution);
        boolean hasCap = cap > 0;

        double endRaw = toTimestampMs(execution.get("endTime"));
        // 未结束的记录随时间推进，展示时按截断时刻计算
        long cutoff = Double.isFinite(endRaw) ? (long) endRaw : Math.min(System.currentTimeMillis(), rangeEndMs);
        if (cutoff <= startMs) return new DrugActualAmount(0, 0, false);

        List<Map<String, Object>> actionList = (List<Map<String, Object>>) execution.get("drugActionList");
        if (actionList == null) actionList = Collections.emptyList();

        List<Map<String, Object>> sortedActions = actionList.stream()
            .map(item -> {
                Map<String, Object> wrapped = new HashMap<>(item);
                wrapped.put("__ts", databaseTimeValue(String.valueOf(item.get("time"))));
                return wrapped;
            })
            .filter(item -> Double.isFinite((double) item.get("__ts")))
            .sorted(Comparator.comparingLong(item -> (long) ((double) item.get("__ts"))))
            .collect(Collectors.toList());

        // 无动作数据：回退按 drugActionList 分段计算
        if (sortedActions.isEmpty()) {
            boolean hit = inNursingRange(execution.get("startTime"), rangeStart, rangeEnd, startExclusive);
            if (!hit) return new DrugActualAmount(0, 0, false);

            double amt = 0;
            double currentSpeed = 0;
            long segStartMs = startMs;
            // 按 actionList 分段计算（忽略时间解析，直接用 action 的 time 字段）
            for (int i = 0; i < actionList.size(); i++) {
                Map<String, Object> item = actionList.get(i);
                long actionTime = ((Date) item.get("time")).getTime();
                String action = String.valueOf(item.get("action"));
                Object spdObj = item.get("speed");

                // 记录上一段的用量
                if (currentSpeed > 0 && actionTime > segStartMs) {
                    long segEnd = Math.min(actionTime, cutoff);
                    if (segEnd > segStartMs) {
                        amt += currentSpeed * (segEnd - segStartMs) / MS_PER_HOUR;
                    }
                }

                // 更新速度
                if ("start".equals(action) || "recovery".equals(action) || "add".equals(action)) {
                    if (spdObj instanceof Number) currentSpeed = ((Number) spdObj).doubleValue();
                } else if ("stop".equals(action) || "pause".equals(action) || "minus".equals(action)) {
                    if ("minus".equals(action) && spdObj instanceof Number) {
                        currentSpeed = ((Number) spdObj).doubleValue();
                    } else {
                        currentSpeed = 0;
                    }
                }
                segStartMs = actionTime;
            }
            // 最后一段到 cutoff
            if (currentSpeed > 0 && cutoff > segStartMs) {
                amt += currentSpeed * (cutoff - segStartMs) / MS_PER_HOUR;
            }

            // 没有结束时间（仍在进行中）且有总量封顶时，超过才封顶
            if (!Double.isFinite(endRaw) && hasCap && amt > cap) {
                amt = cap;
            }
            return new DrugActualAmount(Math.min(amt, hasCap ? cap : amt), Math.min(amt, hasCap ? cap : amt), false);
        }

        List<long[]> segments = new ArrayList<>(); // [start, end, speed_as_bits]
        List<long[]> boluses = new ArrayList<>(); // [time, amount_as_bits]
        long cursor = startMs;
        double speed = 0;
        boolean stopped = false;
        Set<String> unknownActions = new HashSet<>();

        for (Map<String, Object> actionItem : sortedActions) {
            long ts = (long) ((double) actionItem.get("__ts"));
            long at = Math.min(Math.max(ts, cursor), cutoff);
            if (at > cursor && speed > 0) {
                segments.add(new long[]{cursor, at, Double.doubleToLongBits(speed)});
            }
            cursor = at;

            String normalized = normalizeAction(actionItem, unknownActions);
            if ("quickAdd".equals(normalized)) {
                double amount = parseAmount(actionItem.get("quickAddAmount"));
                if (amount > 0) {
                    boluses.add(new long[]{at, Double.doubleToLongBits(amount)});
                }
                continue;
            }
            if ("pause".equals(normalized)) { speed = 0; continue; }
            if ("stop".equals(normalized)) { speed = 0; stopped = true; break; }
            if ("speed".equals(normalized)) { speed = normalizeSpeed(actionItem); continue; }
        }

        if (!unknownActions.isEmpty()) {
            log.warn("[hljld] 未识别的泵注动作，速度按 0 处理：{}", unknownActions);
        }

        if (!stopped && cursor < cutoff && speed > 0) {
            segments.add(new long[]{cursor, cutoff, Double.doubleToLongBits(speed)});
        }

        // 按时间顺序积分，边算边封顶；同一时刻快推优先占额
        // 事件列表: [time, order(0=bolus,1=seg), segIndex 或 -1, bolusIndex 或 -1]
        List<long[]> events = new ArrayList<>();
        for (int i = 0; i < boluses.size(); i++) {
            long[] b = boluses.get(i);
            events.add(new long[]{b[0], 0, -1, i});
        }
        for (int i = 0; i < segments.size(); i++) {
            long[] s = segments.get(i);
            events.add(new long[]{s[0], 1, i, -1});
        }
        events.sort((a, b) -> {
            int cmp = Long.compare(a[0], b[0]);
            return cmp != 0 ? cmp : Long.compare(a[1], b[1]);
        });

        double used = 0;
        double inRange = 0;

        for (long[] ev : events) {
            double avail = hasCap ? Math.max(0, cap - used) : Double.POSITIVE_INFINITY;
            if (avail <= 0) break;

            if (ev[2] >= 0) {
                // segment
                long[] seg = segments.get((int) ev[2]);
                long segStart = seg[0];
                long segEnd = seg[1];
                double rate = Double.longBitsToDouble(seg[2]);
                double amount = rate * (segEnd - segStart) / MS_PER_HOUR;
                long effEnd = segEnd;
                if (amount > avail) {
                    amount = avail;
                    effEnd = segStart + (long) ((avail / rate) * MS_PER_HOUR);
                }
                used += amount;
                long ovStart = Math.max(segStart, rangeStartMs);
                long ovEnd = Math.min(effEnd, rangeEndMs);
                if (ovEnd >= ovStart) {
                    inRange += rate * (ovEnd - ovStart) / MS_PER_HOUR;
                }
            } else if (ev[3] >= 0) {
                // bolus
                long[] bolus = boluses.get((int) ev[3]);
                double amount = Math.min(Double.longBitsToDouble(bolus[1]), avail);
                if (amount <= 0) continue;
                used += amount;
                long t = bolus[0];
                boolean hit = startExclusive
                    ? (t > rangeStartMs && t <= rangeEndMs)
                    : (t >= rangeStartMs && t <= rangeEndMs);
                if (hit) inRange += amount;
            }
        }

        // 当没有结束时间（仍在进行中）且计算量超出总量时，按总量算
        boolean hasEnd = Double.isFinite(endRaw);
        if (!hasEnd && hasCap && inRange > cap) {
            inRange = cap;
        }
        return new DrugActualAmount(hasCap ? Math.min(inRange, cap) : inRange, used, false);
    }

    /**
     * 计算持续药物在指定时间段内的实际用量（简化版，使用 long ms）。
     */
    public static DrugActualAmount calcContinuousDrugAmountMs(
            Document execution, long rangeStartMs, long rangeEndMs, boolean startExclusive) {
        return calcContinuousDrugAmount(execution, new Date(rangeStartMs), new Date(rangeEndMs), startExclusive);
    }

    /**
     * 计算药物从开始到指定时间点的累计用量。
     * 用于计算剩余量 = 总量 - 已用量。
     */
    public static double calcDrugUsageUpTo(Document execution, long timeMs) {
        double startMs = toTimestampMs(execution.get("startTime"));
        if (!Double.isFinite(startMs)) return 0;
        Date startMinusOne = new Date((long) startMs - 1);
        Date timeEnd = new Date(timeMs);
        DrugActualAmount result = calcContinuousDrugAmount(execution, startMinusOne, timeEnd, false);
        return result.inRange;
    }

    /**
     * 计算持续药物在指定时间段内的实际用量。
     * 用于日间小结（14:00-17:00）或夜班小结等时段计算。
     */
    public static DrugActualAmount calcDrugUsageForPeriod(Document execution, Date periodStart, Date periodEnd) {
        return calcContinuousDrugAmount(execution, periodStart, periodEnd, true);
    }

    /**
     * 段内用量 = 累计(段末) - 累计(段初)。
     * 用差值而非重新积分，天然保证 sum(段用量) === 总用量，且复用已有的 cap 封顶逻辑。
     * 注意：此方法返回精确值，不进行四舍五入，避免累积误差。
     */
    public static double calcSegmentUsage(Document execution, Date segStart, Date segEnd) {
        double from = calcDrugUsageUpTo(execution, segStart.getTime());
        double to = calcDrugUsageUpTo(execution, segEnd.getTime());
        return Math.max(0, to - from);
    }

    /**
     * 判断药物在指定时间点是否仍在进行（未停止）。
     */
    public static boolean isDrugOngoingAt(Document execution, long timeMs) {
        double startMs = toTimestampMs(execution.get("startTime"));
        if (!Double.isFinite(startMs) || startMs >= timeMs) return false;

        // 有 endTime 且 endTime <= timeMs，说明已停止
        if (execution.containsKey("endTime") && execution.get("endTime") != null) {
            double endMs = toTimestampMs(execution.get("endTime"));
            if (Double.isFinite(endMs) && endMs <= timeMs) return false;
        }

        // 检查 drugActionList 中是否有 stop 动作且时间 <= timeMs
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> actions = (List<Map<String, Object>>) execution.get("drugActionList");
        if (actions != null) {
            for (Map<String, Object> action : actions) {
                String act = strOrNull(action, "action");
                if ("stop".equals(act == null ? "" : act.trim())) {
                    double actionMs = databaseTimeValue(String.valueOf(action.get("time")));
                    if (Double.isFinite(actionMs) && actionMs <= timeMs) return false;
                }
            }
        }
        return true;
    }

    // =========================================================================
    // 动作规范化
    // =========================================================================

    /**
     * 将原始动作映射为标准类型：speed/pause/stop/quickAdd，无法识别返回 null。
     */
    public static String normalizeAction(Map<?, ?> raw, Set<String> unknown) {
        String action = strOrNull(raw, "action");
        if (action == null) action = "";
        String key = action.trim().toLowerCase();
        String hit = ACTION_ALIAS.get(key);
        if (hit != null) return hit;
        // 未登记但带了速度值，按调速处理
        Object speedObj = raw.get("speed");
        if (speedObj != null && !String.valueOf(speedObj).trim().isEmpty()) return "speed";
        if (!key.isEmpty() && unknown != null) unknown.add(key);
        return null;
    }

    // =========================================================================
    // 签名解析
    // =========================================================================

    /**
     * 护理记录签名：优先取记录自带的 username，其次 trueName，
     * 最后用 userId / editUser 查账户映射。
     */
    public static String resolveNurseSignature(Document record, Map<String, String> accountMap) {
        String direct = strOrNull(record, "username");
        if (direct == null || direct.isEmpty()) direct = strOrNull(record, "trueName");
        if (direct != null && !direct.isEmpty()) return direct;
        String id = strOrNull(record, "userId");
        if (id == null || id.isEmpty()) id = strOrNull(record, "editUser");
        if (id == null || id.isEmpty()) return "";
        return accountMap.getOrDefault(id, "");
    }

    /**
     * 根据 param_Yishi 记录解析签名用户ID。
     * 只使用 bedside.code === 'param_Yishi' 的 editUser。
     * 选择 time <= targetTime 的最近一条。
     *
     * @param targetTimeMs   目标时间毫秒
     * @param bedsideRecords bedSide 记录列表
     * @return 匹配的 editUser 字符串，未找到返回空字符串
     */
    @SuppressWarnings("unchecked")
    public static String resolveYishiSignerId(long targetTimeMs, List<Document> bedsideRecords) {
        if (!Double.isFinite(targetTimeMs)) return "";

        // 筛选 param_Yishi 记录并排序
        List<Map<String, Object>> yishiRecords = bedsideRecords.stream()
            .filter(item -> isValidBusinessRecord(item)
                && "param_Yishi".equals(strOrNull(item, "code"))
                && item.get("time") != null
                && item.get("editUser") != null)
            .map(item -> {
                Map<String, Object> wrapped = new HashMap<>(item);
                wrapped.put("__instant", databaseTimeValue(String.valueOf(item.get("time"))));
                wrapped.put("__editUser", String.valueOf(item.get("editUser")).trim());
                return wrapped;
            })
            .filter(item -> Double.isFinite((double) item.get("__instant"))
                && !((String) item.get("__editUser")).isEmpty())
            .sorted(Comparator.comparingLong(item -> (long) ((double) item.get("__instant"))))
            .collect(Collectors.toList());

        for (int i = yishiRecords.size() - 1; i >= 0; i--) {
            Map<String, Object> record = yishiRecords.get(i);
            long instant = (long) ((double) record.get("__instant"));
            if (instant <= targetTimeMs) {
                return (String) record.get("__editUser");
            }
        }
        return "";
    }

    // =========================================================================
    // 时长与摘要
    // =========================================================================

    /**
     * 计算两个时间之间的时长，始终显示"xx小时xx分钟"格式。
     * 使用 Math.floor 向下取整，避免带秒时间向上取整。
     *
     * @param startMs 开始毫秒时间戳
     * @param endMs   结束毫秒时间戳
     * @return 格式化的时长文本
     */
    public static String durationText(long startMs, long endMs) {
        long totalMinutes = Math.max(0, (long) Math.floor((endMs - startMs) / 60000.0));
        long hours = totalMinutes / 60;
        long minutes = totalMinutes % 60;
        return hours + "小时" + minutes + "分钟";
    }

    /**
     * 根据入科/出科截断情况和时间段类型，生成小结标题。
     *
     * @param defaultLabel      默认标签
     * @param kind              小结类型
     * @param actualStart       实际开始时间
     * @param actualEnd         实际结束时间
     * @param admissionClipped  是否入科截断
     * @param dischargeClipped  是否出科截断
     * @return 动态生成的标题
     */
    public static String buildSummaryLabel(
            String defaultLabel, String kind,
            Date actualStart, Date actualEnd,
            boolean admissionClipped, boolean dischargeClipped) {

        // 出科总结：始终显示实际时长
        if ("discharge".equals(kind)) {
            return durationText(actualStart.getTime(), actualEnd.getTime()) + "总结";
        }
        // 入科截断：显示实际时长
        if (admissionClipped) {
            if ("24h".equals(kind)) {
                return durationText(actualStart.getTime(), actualEnd.getTime()) + "总结";
            }
            return durationText(actualStart.getTime(), actualEnd.getTime()) + "小结";
        }
        // 出科截断且非入科截断：显示实际时长总结
        if (dischargeClipped) {
            return durationText(actualStart.getTime(), actualEnd.getTime()) + "总结";
        }
        // 正常情况使用默认标签
        return defaultLabel;
    }

    /**
     * 金额格式化，保留一位小数。
     */
    public static String formatSummaryAmount(double value) {
        return String.format(Locale.CHINA, "%.0f", value);
    }

    /**
     * 四舍五入到一位小数。
     */
    public static double round1(double value) {
        return Math.round(value);
    }

    // =========================================================================
    // 护理班段
    // =========================================================================

    /**
     * 护理班段。
     */
    public static class NursingSegment {
        public final String key; // "day" 或 "night"
        /** 左端点，左开，不计入 */
        public final Date start;
        /** 右端点，右闭，结算点 */
        public final Date end;
        public final String label;

        public NursingSegment(String key, Date start, Date end, String label) {
            this.key = key;
            this.start = start;
            this.end = end;
            this.label = label;
        }
    }

    /**
     * 护理日切成 (7:00,17:00] 与 (17:00,次日7:00] 两段。
     *
     * @param selectedDate 选择的日期
     * @return 护理班段列表（day, night）
     */
    public static List<NursingSegment> resolveNursingSegments(Date selectedDate) {
        Date dayStart = startOfNursingDay(selectedDate); // D 07:00
        Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        cal.setTime(dayStart);
        cal.set(Calendar.HOUR_OF_DAY, 17);
        Date shiftPoint = cal.getTime(); // D 17:00
        Date nightEnd = endOfNursingDay(selectedDate); // D+1 07:00
        List<NursingSegment> segments = new ArrayList<>(2);
        segments.add(new NursingSegment("day", dayStart, shiftPoint, "07:00-17:00"));
        segments.add(new NursingSegment("night", shiftPoint, nightEnd, "17:00-次日07:00"));
        return segments;
    }

    // =========================================================================
    // 段结算
    // =========================================================================

    /**
     * 段结算结果。
     */
    public static class SegmentSettlement {
        public final Document execution;
        public final String name;
        public final String route;
        /** 本段实用量 */
        public final double segmentUsed;
        /** 至段末累计已入 */
        public final double cumulativeUsed;
        /** 至段末剩余 */
        public final double remainder;
        public final double cap;
        /** 段末仍在泵注 */
        public final boolean ongoing;
        /** 段未走完，只结算到 now */
        public final boolean partial;
        /** cumulativeUsed + remainder === cap */
        public final boolean consistent;
        /** 是否为胃肠类药物（用于分类到 enteral 列） */
        public final boolean isEnteral;
        /** 给药途径 group（静脉/其它/胃肠等） */
        public final String group;

        public SegmentSettlement(Document execution, String name, String route,
                                  double segmentUsed, double cumulativeUsed,
                                  double remainder, double cap,
                                  boolean ongoing, boolean partial, boolean consistent,
                                  boolean isEnteral, String group) {
            this.execution = execution;
            this.name = name;
            this.route = route;
            this.segmentUsed = segmentUsed;
            this.cumulativeUsed = cumulativeUsed;
            this.remainder = remainder;
            this.cap = cap;
            this.ongoing = ongoing;
            this.partial = partial;
            this.consistent = consistent;
            this.isEnteral = isEnteral;
            this.group = group;
        }
    }

    /**
     * 结算一个班段内所有持续泵注药物。
     *
     * @param executions  药物执行记录列表
     * @param methods     药物方法配置列表
     * @param segment     护理班段
     * @param nowMs       截断时刻，打印时必须显式传入固定值
     * @return 结算行列表
     */
    public static List<SegmentSettlement> buildSegmentSettlements(
            List<Document> executions, List<Document> methods,
            NursingSegment segment, long nowMs) {

        long segStartMs = segment.start.getTime();
        long segEndMs = segment.end.getTime();

        // 整段还没开始，不结算
        if (nowMs <= segStartMs) {
            return Collections.emptyList();
        }

        long cutoffMs = Math.min(segEndMs, nowMs);
        boolean partial = cutoffMs < segEndMs;

        List<SegmentSettlement> out = new ArrayList<>();

        for (Document execution : executions) {
            Document method = findDrugMethod(strOrNull(execution, "methodCode"), methods);
            if (method == null) continue;
            // 只处理持续泵注；单次给药走原有明细行逻辑
            if (!Boolean.FALSE.equals(method.get("isOnce"))) continue;

            double startMs = toTimestampMs(execution.get("startTime"));

            // 只展示在 day 段（07:00-17:00）内开始的药物
            if (!Double.isFinite(startMs) || startMs >= segStartMs) {
                continue;
            }

            double endRaw = toTimestampMs(execution.get("endTime"));
            double endMs = Double.isFinite(endRaw) ? endRaw : Double.NaN;

            double cap = round1(resolveLiquidCap(execution));
            double segmentUsed = calcSegmentUsage(execution, segment.start, segment.end);
            double cumulativeUsed = round1(calcDrugUsageUpTo(execution, cutoffMs));
            double cumulativeAtSegStart = round1(calcDrugUsageUpTo(execution, segStartMs));
            double remainder = round1(cap - cumulativeAtSegStart);
            boolean ongoing = !Double.isFinite(endMs) || endMs > cutoffMs;

            // 已用完的药物不出现在结算行
            if (remainder <= 0) {
                continue;
            }

            boolean consistent = Math.abs(cumulativeAtSegStart + remainder - cap) < 0.05;
            if (!consistent) {
                log.warn("[hljld] 用量不自洽，仅渲染实用量 cap={}, cumulativeUsed={}, remainder={}",
                    cap, cumulativeUsed, remainder);
            }

            // 判断是否为胃肠类药物
            String methodGroup = strOrNull(method, "group");
            boolean isEnteral = "胃肠".equals(methodGroup);

            out.add(new SegmentSettlement(
                execution, drugDisplayName(execution), routeLabel(strOrNull(method, "name")),
                segmentUsed, cumulativeUsed, remainder, cap,
                ongoing, partial, consistent, isEnteral, methodGroup));
        }
        return out;
    }

    /**
     * 量列文案：已停药只显示实用量；仍在进行显示剩余量+实用量；不自洽只显示实用量。
     */
    public static String formatSegmentAmountText(SegmentSettlement s) {
        String used = "实用" + formatSummaryAmount(s.segmentUsed);
        if (!s.consistent) return used;
        return "剩余" + formatSummaryAmount(s.remainder) + " " + used;
    }

    // =========================================================================
    // bedside 单元格构建
    // =========================================================================

    /**
     * 将 bedside 记录转换为输入单元格。
     */
    public static NameAmountRoute bedsideInputCell(Document record) {
        String route = "";
        String code = strOrNull(record, "code");
        if (CODE_BROUGHT.equals(code)) route = "带入";
        else if (CODE_ORAL.equals(code)) route = "po";
        else if (CODE_TUBE_FEEDING.equals(code)) route = "鼻饲";
        String remark = strOrNull(record, "remark");
        String strVal = strOrNull(record, "strVal");
        NameAmountRoute cell = new NameAmountRoute(
            remark != null ? remark.trim() : "",
            displayAmount(record.get("strVal")),
            route,
            parseAmount(record.get("strVal")));
        cell.setFromBedside(true); // 标记为床旁录入数据
        return cell;
    }

    /**
     * 将药物执行转为 NameAmountRoute 单元格（单时间点版本）。
     * 对应前端 drugToCell(execution, method, isEnteral, timeMs)。
     */
    public static NameAmountRoute drugToCell(Document execution, Document method, boolean isEnteral, long timeMs) {
        String name = drugDisplayName(execution);
        String route = hasPerinealCareNotes(execution)
            ? strOrNull(execution, "notes")
            : routeLabel(strOrNull(method, "name"));
        // 单次给药：优先用 liquidAmount，回退到 dose
        double amount = parseAmount(execution.get("liquidAmount"));
        if (amount <= 0) {
            amount = parseAmount(execution.get("dose"));
        }
        String amountText = amount > 0 ? formatSummaryAmount(amount) : "";
        return new NameAmountRoute(
            isEnteral ? enteralDisplayName(name) : name,
            amountText,
            route,
            amount);
    }

    /**
     * 将药物执行转为 NameAmountRoute 单元格（时间段版本）。
     * 对应前端 drugToCell(execution, method, isEnteral, timeMs, segStartMs, segEndMs)。
     */
    public static NameAmountRoute drugToCell(Document execution, Document method, boolean isEnteral,
                                              long timeMs, long segStartMs, long segEndMs) {
        String name = drugDisplayName(execution);
        String route = hasPerinealCareNotes(execution)
            ? strOrNull(execution, "notes")
            : routeLabel(strOrNull(method, "name"));
        double amount = calcSegmentUsage(execution, new Date(segStartMs), new Date(segEndMs));
        String amountText = amount > 0 ? formatSummaryAmount(amount) : "";
        return new NameAmountRoute(
            isEnteral ? enteralDisplayName(name) : name,
            amountText,
            route,
            amount);
    }

    /**
     * bedside 中按编码求和。
     */
    public static double sumBedsideByCodes(List<Document> records, String... codes) {
        Set<String> codeSet = new HashSet<>(Arrays.asList(codes));
        return records.stream()
            .filter(item -> codeSet.contains(strOrNull(item, "code")))
            .mapToDouble(item -> parseAmount(item.get("strVal")))
            .sum();
    }

    /**
     * bedside 中按编码求和（List 版本）。
     */
    public static double sumBedsideByCodes(List<Document> records, List<String> codes) {
        Set<String> codeSet = new HashSet<>(codes);
        return records.stream()
            .filter(item -> codeSet.contains(strOrNull(item, "code")))
            .mapToDouble(item -> parseAmount(item.get("strVal")))
            .sum();
    }

    /**
     * bedside 中按单个编码求和。
     */
    public static double sumByCode(List<Document> records, String code) {
        return round1(records.stream()
            .filter(item -> code.equals(strOrNull(item, "code")))
            .mapToDouble(item -> parseAmount(item.get("strVal")))
            .sum());
    }

    // =========================================================================
    // Drug Execution 判断
    // =========================================================================

    /**
     * 判断药物执行记录是否可渲染。
     * 条件：非 null、非 invalid、有 startTime、drugList 中有有效数据。
     */
    public static boolean isRenderableDrugExecution(Document item) {
        if (item == null) return false;
        String status = strOrNull(item, "status");
        // 只保留 working（执行中）和 finished（已完成），排除 invalid（无效）和 ready（未执行）
        if (!"working".equalsIgnoreCase(status) && !"finished".equalsIgnoreCase(status)) return false;
        if (strOrNull(item, "startTime") == null) {
            log.info("[hljld] 药物记录被过滤: startTime为空, id={}, status={}, drugName={}",
                item.get("_id"), status, drugDisplayName(item));
            return false;
        }
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> drugList = (List<Map<String, Object>>) item.get("drugList");
        if (drugList == null) return false;
        return drugList.stream().anyMatch(drug ->
            hasText(drug.get("name"))
            || parseAmount(drug.get("liquidAmount")) != 0
            || hasText(drug.get("dose"))
            || hasText(drug.get("unit")));
    }

    /**
     * 判断药物执行记录的 notes 是否包含会阴冲洗/擦洗关键词。
     * 满足条件时，该记录需在药物治疗列展示，途径显示 notes 内容。
     */
    public static boolean hasPerinealCareNotes(Document execution) {
        String notes = strOrNull(execution, "notes");
        if (notes == null || notes.isEmpty()) return false;
        return notes.contains("会阴冲洗") || notes.contains("会阴擦洗");
    }

    /**
     * 判断药物名称是否为肠内营养目标类型（SP、TP-HE、TPF-T、TP、瑞素、瑞高、瑞能、短肽）。
     */
    public static boolean isTargetEnteral(String drugName) {
        if (drugName == null) return false;
        String upper = drugName.toUpperCase(Locale.ROOT);
        return upper.contains("SP") || upper.contains("TP-HE") || upper.contains("TPF-T")
            || upper.contains("TP") || drugName.contains("瑞素")
            || drugName.contains("瑞高") || drugName.contains("瑞能") || drugName.contains("短肽");
    }

    /**
     * 判断编码是否属于检查/治疗/基础护理/健康教育。
     */
    public static boolean isExaminationTreatmentBasicCareOrHealthEducation(String code) {
        if (code == null) return false;
        return "param_外出检查".equals(code)
            || "param_物理治疗".equals(code)
            || "param_基础护理1".equals(code)
            || "param_健康教育".equals(code);
    }

    /**
     * 根据编码获取显示名称。
     */
    public static String displayName(String code) {
        if (code == null) return "";
        switch (code) {
            case "param_外出检查": return "外出检查";
            case "param_物理治疗": return "物理治疗";
            case "param_基础护理1": return "基础护理";
            case "param_健康教育": return "健康教育";
            default: return "";
        }
    }

    // =========================================================================
    // 简化版持续药物计算（speed + 时间范围）
    // =========================================================================

    /**
     * 根据速度和时间范围计算药物用量。
     * 简化版本，直接使用速度（ml/h）和毫秒时间戳。
     *
     * @param speed    速度（ml/h）
     * @param startMs  开始时间毫秒
     * @param endMs    结束时间毫秒
     * @return 药物用量（ml）
     */
    public static double calcContinuousDrugAmount(double speed, long startMs, long endMs) {
        if (speed <= 0 || endMs <= startMs) return 0;
        return speed * (endMs - startMs) / MS_PER_HOUR;
    }

    // =========================================================================
    // TextSegment 内部类
    // =========================================================================

    /**
     * 文本段落，用于小结中按班段分类的文本描述。
     */
    public static class TextSegment {
        private String category = "";
        private String categoryDisplay = "";
        private String segment = "";    // "day" 或 "night"
        private long segmentStartMs;
        private long segmentEndMs;
        private long startMs;
        private long endMs;
        private String text = "";
        private List<SummaryTextToken> tokens = new ArrayList<>();

        public TextSegment() {}

        public String getCategory() { return category; }
        public void setCategory(String category) { this.category = category; }
        public String getCategoryDisplay() { return categoryDisplay; }
        public void setCategoryDisplay(String categoryDisplay) { this.categoryDisplay = categoryDisplay; }
        public String getSegment() { return segment; }
        public void setSegment(String segment) { this.segment = segment; }
        public long getSegmentStartMs() { return segmentStartMs; }
        public void setSegmentStartMs(long segmentStartMs) { this.segmentStartMs = segmentStartMs; }
        public long getSegmentEndMs() { return segmentEndMs; }
        public void setSegmentEndMs(long segmentEndMs) { this.segmentEndMs = segmentEndMs; }
        public long getStartMs() { return startMs; }
        public void setStartMs(long startMs) { this.startMs = startMs; }
        public long getEndMs() { return endMs; }
        public void setEndMs(long endMs) { this.endMs = endMs; }
        public String getText() { return text; }
        public void setText(String text) { this.text = text; }
        public List<SummaryTextToken> getTokens() { return tokens; }
        public void setTokens(List<SummaryTextToken> tokens) { this.tokens = tokens; }
    }

    // =========================================================================
    // 内部辅助方法
    // =========================================================================

    /**
     * 从 Document 安全获取字符串值，null 返回 null。
     */
    private static String strOrNull(Document doc, String key) {
        if (doc == null) return null;
        Object v = doc.get(key);
        return v != null ? String.valueOf(v).trim() : null;
    }

    /**
     * 从 Map 安全获取字符串值。
     */
    private static String strOrNull(Map<?, ?> map, String key) {
        if (map == null) return null;
        Object v = map.get(key);
        return v != null ? String.valueOf(v).trim() : null;
    }

    /**
     * 从 Document 获取字符串值，null 返回空字符串（公开版本，供外部调用）。
     */
    public static String str(Document doc, String key) {
        String v = strOrNull(doc, key);
        return v != null ? v : "";
    }
}

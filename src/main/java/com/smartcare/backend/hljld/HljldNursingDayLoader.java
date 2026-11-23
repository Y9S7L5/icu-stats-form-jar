package com.smartcare.backend.hljld;

import org.bson.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.stream.Collectors;

/**
 * 从 MongoDB 加载护理日所需的全部原始数据。
 * 对应前端 Hljld2FormService.load()。
 *
 * 数据源：
 * - bedside：床旁数据/生命体征
 * - drugExe：药物执行记录
 * - configDrugMethod：药物方法配置
 * - nurseRecords：护理记录
 * - tubeExe：管路执行记录
 * - configTubeView：管路配置视图
 * - account：账户信息（用于签名映射）
 */
@Service
public class HljldNursingDayLoader {

    private static final Logger log = LoggerFactory.getLogger(HljldNursingDayLoader.class);

    private final MongoTemplate mongoTemplate;

    @Autowired
    public HljldNursingDayLoader(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    /**
     * 加载患者信息。
     */
    public Document loadPatientInfo(String pid) {
        Query q = new Query(new Criteria().orOperator(
            Criteria.where("_id").is(pid),
            Criteria.where("pid").is(pid)));
        Document p = mongoTemplate.findOne(q, Document.class, "patient");
        if (p == null) {
            p = new Document();
            p.put("name", "未知");
        }
        return p;
    }

    /**
     * 加载护理日所需的全部原始数据。
     * 时间范围：[nursingDayStart, nursingDayEnd) 加上 1 秒缓冲
     */
    public HljldSourceData loadAll(String pid, Date nursingDayStart, Date nursingDayEnd) {
        log.info("加载护理日数据: pid={}, start={}, end={}", pid, nursingDayStart, nursingDayEnd);

        // 上界放宽 1 秒保证边界数据被取回，精确过滤由 inNursingRange 完成
        Date queryEnd = new Date(nursingDayEnd.getTime() + 1000);

        List<Document> bedside = loadBedside(pid);
        List<Document> drugExecutions = loadDrugExecutions(pid, nursingDayStart, queryEnd);
        List<Document> drugMethods = loadDrugMethods();
        List<Document> nurseRecords = loadNurseRecords(pid, nursingDayStart, queryEnd);
        List<Document> tubeExecutions = loadTubeExecutions(pid, nursingDayStart, queryEnd);
        List<Document> tubeViews = loadTubeViews();
        Map<String, String> accountMap = buildAccountMap(bedside, nurseRecords);
        Document patientInfo = loadPatientInfo(pid);

        log.info("数据加载完成: bedside={}, drugExe={}, drugMethods={}, nurseRecords={}, tubeExe={}, tubeViews={}, accounts={}",
            bedside.size(), drugExecutions.size(), drugMethods.size(),
            nurseRecords.size(), tubeExecutions.size(), tubeViews.size(), accountMap.size());

        HljldSourceData data = new HljldSourceData();
        data.setBedside(bedside);
        data.setDrugExecutions(drugExecutions);
        data.setDrugMethods(drugMethods);
        data.setNurseRecords(nurseRecords);
        data.setTubeExecutions(tubeExecutions);
        data.setTubeViews(tubeViews);
        data.setAccountMap(accountMap);
        data.setPatientInfo(patientInfo);
        return data;
    }

    /**
     * 加载全量数据（用于一键打印全部）。
     */
    public HljldSourceData loadAllForStay(String pid, Date stayStart, Date stayEnd) {
        log.info("加载全量数据: pid={}, start={}, end={}", pid, stayStart, stayEnd);
        Date queryEnd = new Date(stayEnd.getTime() + 1000);

        List<Document> bedside = loadBedsideByTimeRange(pid, stayStart, queryEnd);
        List<Document> drugExecutions = loadDrugExecutions(pid, stayStart, queryEnd);
        List<Document> drugMethods = loadDrugMethods();
        List<Document> nurseRecords = loadNurseRecords(pid, stayStart, queryEnd);
        List<Document> tubeExecutions = loadTubeExecutions(pid, stayStart, queryEnd);
        List<Document> tubeViews = loadTubeViews();
        Map<String, String> accountMap = buildAccountMap(bedside, nurseRecords);

        HljldSourceData data = new HljldSourceData();
        data.setBedside(bedside);
        data.setDrugExecutions(drugExecutions);
        data.setDrugMethods(drugMethods);
        data.setNurseRecords(nurseRecords);
        data.setTubeExecutions(tubeExecutions);
        data.setTubeViews(tubeViews);
        data.setAccountMap(accountMap);
        return data;
    }

    private List<Document> loadBedside(String pid) {
        Query q = new Query(Criteria.where("pid").is(pid));
        q.with(Sort.by(Sort.Direction.ASC, "time"));
        return mongoTemplate.find(q, Document.class, "bedside");
    }

    private List<Document> loadBedsideByTimeRange(String pid, Date start, Date end) {
        Query q = new Query(Criteria.where("pid").is(pid)
            .and("time").gte(start).lt(end));
        q.with(Sort.by(Sort.Direction.ASC, "time"));
        return mongoTemplate.find(q, Document.class, "bedside");
    }

    private List<Document> loadDrugExecutions(String pid, Date start, Date end) {
        // 区间相交：跨07:00仍在执行的持续用药必须取回
        // endTime 用 gte：零时长记录(startTime==endTime)恰好落在护理日07:00起点时，
        // gt(start) 会漏掉，导致该记录在前后两个护理日都取不到（22号右开过滤、23号查询漏掉）
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

    private List<Document> loadDrugMethods() {
        Query q = new Query(Criteria.where("valid").ne(false));
        return mongoTemplate.find(q, Document.class, "configDrugMethod");
    }

    private List<Document> loadNurseRecords(String pid, Date start, Date end) {
        Query q = new Query(Criteria.where("pid").is(pid.trim())
            .and("time").gte(start).lt(end)
            .and("valid").ne(false)
            .and("desc").nin(null, ""));
        q.with(Sort.by(Sort.Direction.ASC, "time"));
        return mongoTemplate.find(q, Document.class, "nurseRecords");
    }

    private List<Document> loadTubeExecutions(String pid, Date start, Date end) {
        Query q = new Query(Criteria.where("pid").is(pid)
            .and("valid").ne(false)
            .and("status").ne("invalid")
            .and("tubeRecordList").ne(null));
        q.with(Sort.by(Sort.Direction.ASC, "startTime"));
        List<Document> docs = mongoTemplate.find(q, Document.class, "tubeExe");

        // 过滤 tubeRecordList 中不在时间范围内的记录
        List<Document> result = new ArrayList<>();
        for (Document doc : docs) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> tubeRecords = (List<Map<String, Object>>) doc.get("tubeRecordList");
            if (tubeRecords == null) continue;

            List<Map<String, Object>> filtered = new ArrayList<>();
            for (Map<String, Object> record : tubeRecords) {
                Object rValid = record.get("valid");
                if (Boolean.FALSE.equals(rValid)) continue;
                Object rStatus = record.get("status");
                if ("invalid".equalsIgnoreCase(str(record, "status"))) continue;

                Object timeObj = record.get("time");
                if (timeObj instanceof Date) {
                    Date recordTime = (Date) timeObj;
                    if (recordTime.compareTo(start) >= 0 && recordTime.compareTo(end) < 0) {
                        filtered.add(record);
                    }
                }
            }
            doc.put("tubeRecordList", filtered);
            result.add(doc);
        }
        return result;
    }

    private List<Document> loadTubeViews() {
        Query q = new Query(Criteria.where("valid").ne(false)
            .and("status").ne("invalid"));
        q.with(Sort.by(Sort.Direction.ASC, "tubeType"));
        return mongoTemplate.find(q, Document.class, "configTubeView");
    }

    /**
     * 构建 accountId → trueName 映射。
     * 从 bedside (param_Yishi) 和 nurseRecords 收集 userId，批量查询账户。
     */
    private Map<String, String> buildAccountMap(List<Document> bedside, List<Document> nurseRecords) {
        Set<String> userIds = new HashSet<>();

        // 从 param_Yishi bedside 记录收集 editUser（只保留 valid=true 的记录）
        for (Document doc : bedside) {
            if (!Boolean.TRUE.equals(doc.getBoolean("valid"))) continue;
            if ("param_Yishi".equals(str(doc, "code"))) {
                String editUser = str(doc, "editUser");
                if (!editUser.isEmpty()) userIds.add(editUser);
            }
        }

        // 从护理记录收集 userId/editUser（仅在未自带 username/trueName 时）
        for (Document doc : nurseRecords) {
            if (!Boolean.TRUE.equals(doc.getBoolean("valid"))) continue;
            String username = str(doc, "username");
            String trueName = str(doc, "trueName");
            if (!username.isEmpty() || !trueName.isEmpty()) continue;
            String userId = str(doc, "userId");
            if (userId.isEmpty()) userId = str(doc, "editUser");
            if (!userId.isEmpty()) userIds.add(userId);
        }

        if (userIds.isEmpty()) return Collections.emptyMap();

        // 批量查询账户
        Query q = new Query(Criteria.where("_id").in(userIds));
        List<Document> accounts = mongoTemplate.find(q, Document.class, "account");
        Map<String, String> map = new HashMap<>();
        for (Document account : accounts) {
            String id = account.containsKey("_id") ? String.valueOf(account.get("_id")) : "";
            String trueName = str(account, "trueName");
            if (trueName.isEmpty()) trueName = str(account, "accountName");
            if (trueName.isEmpty()) trueName = str(account, "name");
            if (!id.isEmpty() && !trueName.isEmpty()) {
                map.put(id, trueName);
            }
        }
        return map;
    }

    private static String str(Document doc, String key) {
        Object v = doc.get(key);
        return v != null ? v.toString().trim() : "";
    }

    private static String str(Map<?, ?> map, String key) {
        Object v = map.get(key);
        return v != null ? v.toString().trim() : "";
    }
}

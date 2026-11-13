# 表单目录 — 重钢总医院重症医学科护理记录系统

## 护理与评估表单

| 表单名称 | 访问路径 | 前端组件 | 主要 API | 后端实体 | 直接保存 |
|---|---|---|---|---|---|
| 深静脉维护记录单（一） | /form/sjm1 | Sjm1VeinMaintenanceComponent | /api/v1/icu/tube-exe, /api/v1/icu/sjm1-vein-extra | TubeExe, Sjm1VeinExtra | 是 |
| 深静脉维护记录单（三）·透析导管 | /form/sjmCrrt | SjmCrrtVeinMaintenanceComponent | /api/v1/icu/tube-exe, /api/v1/icu/sjm1-vein-extra | TubeExe, Sjm1VeinExtra | 是 |
| 亚低温治疗体温记录单 | /form/ydwzlForm | YdwzlTemperatureComponent | /api/v1/icu/bedside/listByPid, /api/v1/icu/ydwzl-extra | Bedside, YdwzlFormExtra | 是 |
| 肠内营养耐受性评分表 | /form/toleranceForm | ToleranceScoreComponent | /api/v1/icu/scores | Score | 是 |
| 自杀风险评估表（NGASR） | /form/commitSuicideForm | CommitSuicideScoreComponent | /api/v1/icu/scores | Score | 是 |
| 失禁相关性皮炎（IAD）评估记录单 | /form/IADForm | IadScoreComponent | /api/v1/icu/scores, /api/v1/icu/fall-danger-extra | Score, FallDangerFormExtra | 是 |
| 住院患者日常生活能力评估单（Barthel） | /form/baetheiForm | BaetheiScoreComponent | /api/v1/icu/scores, /api/v1/icu/self-care-extra | Score, SelfCareFormExtra | 是 |
| 跌倒/坠床风险评估及预防措施记录单 | /form/patientFallDangerForm | PatientFallDangerComponent | /api/v1/icu/scores, /api/v1/icu/fall-danger-extra | Score, FallDangerFormExtra | 是 |
| 健康教育记录单 | /form/jkjyForm | HealthEducationComponent | /api/v1/icu/health-education | HealthEducationRecord | 是 |
| 重症患者护理目标管理 | /form/hlmbForm | HlmbFormComponent | /api/v1/icu/nursing-goal-records | NursingGoalRecord | 是 |
| 住院患者物品管理表 | /form/wpgmForm | WpgmFormComponent | 无（仅浏览器 localStorage） | 无 | 否 |
| ECMO 运行护理记录单 | /form/ecmoForm | EcmoRecordComponent | /api/v1/icu/bedside/listByPid, /api/v1/icu/ecmo-extra | Bedside, EcmoRecordExtra | 是 |
| 输血记录单（第三方输血系统调阅） | /form/transfusionForm | TransfusionSystemComponent | 无（iframe 调阅输血系统，sign 由 SM4-ECB 生成） | — | 否 |
| 非计划拔管风险评估及护理措施记录单 | /form/unPlannedCGZYYForm | UnplannedExtubationComponent | /api/v1/icu/score/listByPid | Score | 是 |
| 一键批量打印中心 | /form/printCenter | PrintCenterComponent | 聚合探测各表单 API | — | 否（只读） |

## ICU 治疗记录系统（SmartCare 内嵌）

| 系统名称 | 访问路径 | 前端 | 主要 API | 后端实体 | 直接保存 |
|---|---|---|---|---|---|
| CRRT 护理记录系统 | /crrt | SmartCare SPA | /api/v1/icu/crrt | CrrtRecord | 是 |
| CVC 护理记录系统 | /cvc | SmartCare SPA | /api/v1/icu/cvc | CvcRecord | 是 |
| 呼吸治疗记录系统 | /rm | SmartCare SPA | /api/v1/icu/rm | RmRecord | 是 |
| PiCCO 监测记录系统 | /picco | SmartCare SPA | /api/v1/icu/picco | PiccoRecord | 是 |
| IABP 护理记录系统 | /iabp | SmartCare SPA | /api/v1/icu/iabp | IabpRecord | 是 |
| 血浆置换记录系统 | /pe | SmartCare SPA | /api/v1/icu/pe | PeRecord | 是 |
| 血液灌流记录系统 | /hp | SmartCare SPA | /api/v1/icu/hp | HpRecord | 是 |
| Protein A 免疫吸附记录系统 | /protein-a | SmartCare SPA | /api/v1/icu/protein-a | ProteinARecord | 是 |

## 说明

- "直接保存" = 该页面/系统包含用户触发的写入操作（新建/编辑/保存/删除）。
- "Bedside" 实体在 ECMO 和亚低温表单中作为只读数据源使用（GET /listByPid），不通过表单本身写入。
- `/form/wpgmForm`（住院患者物品管理表）仅使用 `localStorage` 存储已选物品 ID，无后端持久化。
- `/form/transfusionForm` 已改为第三方输血系统 iframe 调阅（sign = SM4-ECB(登录参数) Hex，login_id 取登录账号 username）；本地 `TransfusionRecordComponent` 与 `/api/v1/icu/transfusion-record` 保留，仅供打印中心使用。
- SmartCare 治疗记录系统的前端代码不在本仓库的 `sjm1-app` 中，由 SmartCare 宿主 SPA 提供。
- 同名字段 `pid` 表示患者 ID，跨集合关联患者数据。

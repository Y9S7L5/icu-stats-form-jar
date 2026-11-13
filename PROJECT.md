# ICU 护理记录与评分表单系统 — 项目索引

> 重钢总医院重症医学科护理记录与评分表单系统  
> Spring Boot 单体可执行 JAR + Angular 静态资源托管  
> 通过 postMessage 接收 SmartCare 宿主患者上下文

---

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Java 11 · Spring Boot 2.7.18 · Spring Data MongoDB · Maven |
| 前端 | Angular 21.2 · TypeScript 5.9 · RxJS 7.8 · Node.js 24+ |
| 数据库 | MongoDB（业务库名 SmartCare） |
| 交付 | Spring Boot 可执行 JAR，内嵌前端静态资源 |
| 集成 | 页面嵌入 SmartCare；通过 postMessage 接收患者上下文 |

---

## 目录结构

`
icu-stats-form-jar/
├── pom.xml                          # Maven 打包配置
├── build-and-push.sh                # 一键编译+打包+Git推送
├── FORM_CATALOG.md                  # 表单目录（路由/API/实体对应关系）
├── sjm1-app/                        # Angular 前端
│   ├── src/app/
│   │   ├── app.routes.ts            # 路由定义
│   │   ├── app.module.ts            # 根模块
│   │   ├── services/
│   │   │   └── host-patient.service.ts   # 宿主患者上下文
│   │   ├── models/
│   │   │   └── smartcare-host-message.model.ts
│   │   ├── form-date.util.ts        # 日期工具
│   │   ├── form-measure.util.ts     # 计量工具
│   │   ├── form-print.util.ts       # 打印工具
│   │   ├── form-print-pages.util.ts # 打印分页工具
│   │   └── <component-name>.component.{ts,html,css}
│   └── dist/sjm1-app/browser/      # Angular 构建产物
├── src/main/java/com/smartcare/backend/
│   ├── BackendApplication.java      # 应用入口
│   ├── config/
│   │   ├── MultiFrontendWebConfig.java   # 静态资源与路由映射
│   │   ├── FrontendRedirectController.java
│   │   ├── JacksonConfig.java
│   │   ├── AsyncConfig.java
│   │   └── GlobalExceptionHandler.java
│   ├── controller/                  # REST 控制器（30个）
│   └── entity/                      # MongoDB 文档实体（26个）
└── src/main/resources/static/form/  # 前端构建产物部署目录
`

---

## 表单路由一览

所有表单挂载在 /form/<route> 下。

| 路由 | 组件 | 说明 | 写操作 |
|---|---|---|---|
| sjm1 | Sjm1VeinMaintenanceComponent | 深静脉维护记录单（一） | ✅ |
| sjmCrrt | SjmCrrtVeinMaintenanceComponent | 深静脉维护记录单（三）·透析导管 | ✅ |
| ydwzlForm | YdwzlTemperatureComponent | 亚低温治疗体温记录单 | ✅ |
| 	oleranceForm | ToleranceScoreComponent | 肠内营养耐受性评分表 | ✅ |
| commitSuicideForm | CommitSuicideScoreComponent | 自杀风险评估表（NGASR） | ✅ |
| IADForm | IadScoreComponent | 失禁相关性皮炎（IAD）评估记录单 | ✅ |
| aetheiForm | BaetheiScoreComponent | 日常生活活动能力评估单（Barthel） | ✅ |
| patientFallDangerForm | PatientFallDangerComponent | 跌倒/坠床风险评估及预防措施记录单 | ✅ |
| jkjyForm | HealthEducationComponent | 健康教育记录单 | ✅ |
| wpgmForm | WpgmFormComponent | 住院患者物品管理表 | ❌ localStorage |
| ecmoForm | EcmoRecordComponent | ECMO 运行护理记录单 | ✅ |
| radenForm | BradenFormComponent | 压力性损伤评估及措施记录单 | ✅ |
| 	ransfusionForm | TransfusionRecordComponent | 输血记录单 | ✅ |
| piccoForm | PiccoRecordComponent | PiCCO 监测记录单 | ✅ |
| hlmbForm | HlmbFormComponent | 重症患者护理目标管理 | ✅ |
| iabpForm | IabpRecordComponent | IABP 护理记录单 | ✅ |
| crrtForm | CrrtRecordComponent | CRRT 护理记录单 | ✅ |
| crrtOrderForm | CrrtOrderFormComponent | CRRT 医嘱单 | ✅ |
| hljldForm | HljldFormComponent | 护理记录单（旧版） | ❌ 只读 |
| **hljldForm2** | **Hljld2FormComponent** | **护理记录单（独立版）** | ❌ 只读 |
| hljldFormPDF | HljldFormPdfComponent | 护理记录单 PDF 导出 | ❌ 只读 |
| handoverReport | HandoverReportComponent | 交接班报告 | ✅ |
| loodSugar | BloodSugarComponent | 血糖监测记录 | ✅ |
| 	emperatureRecord | TemperatureRecordComponent | 体温监测记录 | ✅ |
| unPlannedCGZYYForm | UnplannedExtubationComponent | 非计划拔管风险评估及护理措施记录单 | ✅ |
| printCenter | PrintCenterComponent | 一键批量打印中心 | ❌ 只读 |

---

## hljld2 护理记录单架构（重点）

### 文件职责

| 文件 | 职责 |
|---|---|
| hljld2-form.component.ts | 主组件：数据加载、分页、UI交互 |
| hljld2-form.component.html | 模板：卡片式分页、表格渲染 |
| hljld2-form.component.css | 样式：屏幕布局 + @media print |
| hljld2-form.models.ts | 数据模型定义（PatientContext, HljldViewModel 等） |
| hljld2-form.service.ts | HTTP 服务：并行拉取6类源数据 |
| hljld2-form.utils.ts | 数据处理：时间解析、行构建、摘要计算、**按列宽拆行** |
| hljld2-pagination.core.ts | 打印分页核心：DOM量测分页、溢出校验 |
| hljld2-print.util.ts | 打印入口：打印全部/选页 |
| hljld2-pdf.service.ts | PDF 服务 |
| hljld2-sheet.styles.ts | 打印样式常量 |

### 数据流

`
SmartCare postMessage → HostPatientService → selectedDate$
  → Hljld2FormService.loadAll(pid, date)
    → 并行拉取: bedside / drugExecutions / drugMethods / nurseRecords / tubeExecutions / tubeViews / signatures
  → buildTimeRows() → 按分钟键聚合
  → buildDisplayGroups() → 按列宽拆行（splitTextToLines）
  → buildTimeline() → 穿插日间/交接班/全日/出院摘要
  → buildSummary() → 出入量汇总
  → HljldViewModel
  → splitIntoPages() → 每页最多33行
  → flattenPageItems() → 长文本拆行渲染
`

### 分页逻辑

- **屏幕分页**：splitIntoPages() 按 MAX_ROWS_PER_PAGE = 33 分页
- **打印分页**：paginateHljld2() 在隐藏 A4 容器中 DOM 量测，溢出时自动分页
- **摘要行数**：日间/交接班小结固定4行，全日/出院总结固定8行

### 拆行机制

| 函数 | 位置 | 用途 |
|---|---|---|
| splitTextToLines(text, maxChars) | utils.ts | 打印+屏幕共用：按标点/空格自然断句 |
| splitText(text, maxLen) | component.ts | 屏幕专用：固定长度拆分 |
| splitNameAmountItems() | utils.ts | 药物/肠内营养名称+数量联合拆行 |

**各列最大字符数** (COL_MAX_CHARS)：

| 列 | maxChars | 列 | maxChars |
|---|---|---|---|
| time | 14 | outputName | 7 |
| medName | 20 | outputAmount | 6 |
| medAmount | 9 | drainName | 7 |
| medRoute | 7 | drainAmount | 6 |
| enteralName | 18 | check | 6 |
| enteralAmount | 8 | treatment | 6 |
| enteralRoute | 7 | basicCare | 6 |
| urine | 7 | health | 6 |
| ultrafiltration | 7 | **nursing** | **34** |
| sign | 10 | | |

### A4 横向打印布局（7mm页边距）

| 区域 | 高度 |
|---|---|
| 标题（15pt） | 9.0mm |
| 患者信息（7.5pt） | 6.7mm |
| 表头2行（7.5pt/9pt） | 8.8mm |
| 数据行 ×33（9pt） | ~145mm |
| 备注4行（7.5pt） | 12.8mm |
| 页码（**12pt**） | 8.0mm |
| **合计** | **~190mm**（A4可用196mm） |

---

## 构建与交付

### 一键脚本（Linux/Git Bash）

`ash
./build-and-push.sh "提交说明"
`

步骤：Angular编译 → 同步静态资源 → Maven打包 → 验证JAR → Git提交推送

### 手动步骤（Windows PowerShell）

`powershell
# 1. Angular 编译
cd sjm1-app; npm run build; cd ..

# 2. 清理并同步静态资源
Remove-Item -Recurse -Force src\main\resources\static\form
New-Item -ItemType Directory src\main\resources\static\form
xcopy /E /Y /I sjm1-app\dist\sjm1-app\browser\* src\main\resources\static\form\

# 3. Maven 打包
mvn clean package -DskipTests

# 4. 验证 JAR
jar tf target\backend-from-0.0.1.jar | Select-String "static/form/main"

# 5. Git 提交推送
git add -A
git commit -m "chore: 前端重新编译并同步到Java静态资源"
git push origin master
`

### 关键规则

- **禁止**直接 mvn clean package（不会编译前端）
- 提交前必须同时看到 sjm1-app/src 和 src/main/resources/static/form 变化
- JAR 中 index.html 引用的 main-*.js 必须与 Angular 构建产物一致

---

## 后端控制器（30个）

| 控制器 | 说明 |
|---|---|
| AccountController | 账户/签名 |
| BedsideController | 床旁数据 |
| ConfigBedController | 床位配置 |
| CrrtController / CrrtOrderFormController | CRRT 相关 |
| CvcController | CVC 导管 |
| DepartmentController | 科室 |
| EcmoExtraController | ECMO 扩展 |
| FallDangerFormExtraController | 跌倒评估扩展 |
| HandoverReportController | 交接班报告 |
| HealthEducationRecordController | 健康教育 |
| HljldController / HljldPdfController / HljldPrintController | 护理记录单 |
| HospitalConfigController | 医院配置 |
| HpController | 血液灌流 |
| IabpController / IabpRecordExtraController | IABP |
| PatientController | 患者信息 |
| PeController | 血浆置换 |
| PiccoController / PiccoRecordExtraController | PiCCO |
| ProteinAController | Protein A 免疫吸附 |
| RmController | 呼吸治疗 |
| ScoreController | 评分通用 |
| SelfCareFormExtraController | 自理能力扩展 |
| Sjm1VeinExtraController | 深静脉扩展 |
| TransfusionRecordController | 输血记录 |
| TubeExeController | 管道执行 |
| YdwzlFormExtraController | 亚低温扩展 |

---

## MongoDB 实体（26个）

AccountSignature · Bedside · BloodProductSnapshot · CrrtOrderFormRecord · CrrtRecord · CvcRecord · EcmoRecordExtra · FallDangerFormExtra · HealthEducationRecord · HljldPageIndex · HpRecord · IabpRecord · IabpRecordExtra · PeRecord · PiccoRecord · PiccoRecordExtra · ProteinARecord · RmRecord · Score · SelfCareFormExtra · Sjm1VeinExtra · TransfusionItem · TransfusionPage · TransfusionRecord · TubeExe · VitalSigns · YdwzlFormExtra

---

## 近期整改记录

| 提交 | 说明 |
|---|---|
| 9b43f5f | 每页33行 + 修复拆行空格导致空白行 + 页码改为12pt |
| d0a505a | 新增按列宽拆行功能（COL_MAX_CHARS + splitTextToLines） |
| c8143e | 所有列统一 white-space:nowrap 固定18px行高 |
| 0d1097 | 全局移除 text-overflow:ellipsis，统一 normal+overflow:hidden |
| d7d2be8 | 固定18px行高不撑开，移除备注上方横线 |
|  debe50 | 恢复固定18px行高，日期列加宽至7% |
| 92d789f | 缩窄日期列、量列去除截断、护理记录自动换行 |
| fffcf5 | 行高固定18px，超宽截断，按行数分页 |
| 3537620 | 行高固定24px，名称列加宽，每页22行 |
| 768ef57 | 每页固定A4大小，每页独立标题/表头/备注/页码 |
| cf41d6b | 改为卡片式独立分页 |
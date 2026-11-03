/**
 * 非计划拔管风险评估及护理措施记录单 —— Angular 组件
 * 访问路径：/form/unPlannedCGZYYForm
 *
 * A4 横向；每组最多 5 条评估记录，生成 2 张物理页（评分页+护理措施页）
 * 参照 ToleranceScoreComponent 的数据加载、患者切换、账号签名回填、分页、缩放和打印逻辑
 */

import { HttpClient } from '@angular/common/http';
import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { Subject } from 'rxjs';
import { distinctUntilChanged, filter, finalize, map, switchMap, takeUntil, tap } from 'rxjs/operators';
import { HostPatientService } from './services/host-patient.service';
import { databaseTimeValue, formatShanghaiDate, formatShanghaiTime } from './form-date.util';
import { normalizePrintPages, shouldPrintPage } from './form-print-pages.util';
import { IcuFormViewerContextService } from './icu-form-viewer-context.service';
import { firstDiagnosisSegment, resolvePageDiagnosis } from './diagnosis-history.util';
import { DiagnosisHistoryService } from './diagnosis-history.service';

/* ============================= 配置区 ============================= */

const SCORE_TYPE = 'unPlannedCGZYYScore';
const FORM_CODE = 'unPlannedCGZYYForm';
const API_EXTRA_LATEST = '/api/v1/icu/fall-danger-extra/latest';
const API_EXTRA_SAVE = '/api/v1/icu/fall-danger-extra/save';

/** 未实施镇静或不适宜用 RASS 评分患者选项 */
const NO_RASS_OPTIONS = [
  { label: '意识清楚，情绪稳定或平静/昏迷且对外界刺激无反应', score: 0 },
  { label: '意识清楚，情绪烦躁或易激惹、兴奋或欣快', score: 3 },
  { label: '意识清楚，情绪悲观或拒绝治疗', score: 3 },
  { label: '嗜睡或昏睡或痴呆', score: 2 },
  { label: '意识模糊或谵妄，精神狂躁或抑郁', score: 3 },
  { label: '昏迷且躁动、无指令性动作', score: 3 },
];

/** 舒适度评分 */
const SSD_OPTIONS = [
  { label: '无疼痛或不适主诉(含含昏迷或镇静)/CPOT:0分', score: 0 },
  { label: 'NRS:1~3分/CPOT:1分/偶有不适主诉，可耐受导管留置', score: 1 },
  { label: 'NRS:≥4分/CPOT:2分/频感不适，意图拔管', score: 2 },
  { label: 'NRS:≥7分/CPOT:≥3分/严重不适，无法耐受导管留置，意图拔管', score: 3 },
];

/** 沟通合作评分 */
const GTHZ_OPTIONS = [
  { label: '患者或陪护人员完全理解并配合', score: 0 },
  { label: '患者或陪护人员部分理解并配合', score: 1 },
  { label: '患者或陪护人员不理解或拒绝并配合', score: 3 },
];

/** 行为合作评分 */
const XWHZ_OPTIONS = [
  { label: '肌力≤2级', score: 0 },
  { label: '肌力＞2级，无拔管史', score: 1 },
  { label: '肌力＞2级，有拔管史', score: 2 },
];

/** 导管数量评分 */
const DGSL_OPTIONS = [
  { label: '留置导管数量≤2', score: 1 },
  { label: '留置导管数量＞2', score: 2 },
];

/** 导管固定评分 */
const DGGD_OPTIONS = [
  { label: '使用胶布或贴膜固定或系带固定', score: 3 },
  { label: '使用胶布+贴膜固定/系带+胶布固定/系带+贴膜固定', score: 2 },
  { label: '缝线固定或固定器固定或水囊(气囊)固定', score: 1 },
];

/** 护理措施 19 条 — code 与后端 measuresGroupList 一致 */
const NURSE_MEASURES = [
  // 妥善固定 (0-4)
  { group: '妥善固定', code: '1.1gen13ju16huan14zhe19yi5shi10zhuang7tai17he4pi7fu11qing6kuang5，3xuan5ze15he11kuo8de16gu7ding11cai11liao6。7', label: '1.根据患者意识状态和皮肤情况，选择合适的固定材料。' },
  { group: '妥善固定', code: '2.14xuan16ze5he1kuo3de3gu15ding2fang16fa14，17jin19hang10er13ci16gu17ding6，6que12bao15gu6ding11lao4gu18、3song6jin3kuo2yi1。19', label: '2.选择合适的固定方法，进行二次固定，确保固定牢固、松紧适宜。' },
  { group: '妥善固定', code: '3.16mei13ban18guan1cha8guan4dao1qing12kuang15，8gao5feng7xian0huan3zhe19mei14xiao11shi18guan6cha14116ci4，17ru0dao0guan19yi3wei16huo17fu9liao5chao8shi16、6song3dong9deng13yi17chang19qing3kuang3，18ji9shi17chu18zhi15。16', label: '3.每班观察管道情况，高风险患者每小时观察1次，如导管移位或敷料潮湿、松动等异常情况，及时处置。' },
  { group: '妥善固定', code: '4.5huan5zhe15fan18shen8、2chuan18tuo12yi2wu19、1xia4chuang18、13guo14chuang14、12wai6chu8jian5cha19deng0guo4cheng2zhong13，14bi6mian16wai19li19qian6la0guan13dao0。9', label: '4.患者翻身、穿脱衣物、下床、过床、外出检查等过程中，避免外力牵拉管道。' },
  { group: '妥善固定', code: '5.12geng9huan2gu2ding1cai16liao4shi8，12xuan5ze1zheng8que16de9geng16huan19fang2shi8，1bi4mian8guan9dao0yi3wei12huo9tuo7chu10，1bi12yao8shi10shuang15ren7cao1zuo4。7', label: '5.更换固定材料时，选择正确的更换方式，避免管道移位或脱出，必要时双人操作。' },
  // 患者管理 (5-7)
  { group: '患者管理', code: '1.15bao7chi2guan11lu5lian10jie1bu8wei7yuan7li7huan11zhe18shuang3shou16huo8dong10fan12wei9。1', label: '1.保持管路连接部位远离患者双手活动范围。' },
  { group: '患者管理', code: '2.8gui18fan9shi16yong4guan18dao17biao19shi10。4', label: '2.规范使用管道标识。' },
  { group: '患者管理', code: '3.2jian13kang13jiao7yu17 12gao16zhi6guan14dao17de18zhong13yao15xing17ji7hu2li10fang7fa16，19gu11li1huan8zhe5he1pei11hu13zhu7dong8can14yu0guan17dao4guan4li6，0chu14xian11yi2chang6li2ji5tong16zhi13yi2wu4ren2yuan9。18', label: '3.健康教育 告知管道的重要性及护理方法，鼓励患者和陪护主动参与管道管理，出现异常立即通知医务人员。' },
  // 镇静镇痛管理 (8-10)
  { group: '镇静镇痛管理', code: '1.10xuan14ze2kuo3yi2de10teng9tong12ping10gu14gong2ju3jin7hang3ping13gu2，3zun16yi11zhu4shi15yong9zhen16tong11yao10wu13，15zhen8tong16qi0jian0mi12qie5jian7ce6zhen2tong19xiao12guo16he18sheng12ming9ti4zheng7，3jiang14huan13zhe3de5teng1tong3cheng4du18kong18zhi17zai0qing18du9ji12yi5xia17fan14wei11nei4。7', label: '1.选择适宜的疼痛评估工具进行评估，遵医嘱使用镇痛药物，镇痛期间密切监测镇痛效果和生命体征，将患者的疼痛程度控制在轻度及以下范围内。' },
  { group: '镇静镇痛管理', code: '2.8zun7yi14zhu0shi19yong11zhen16jing17yao9wu18，11ke3gen14ju11RASS1ping19fen7dong14tai6tiao10zheng5gei8yao13fang10shi19he10yao7wu0yong13liang15，16shi9huan8zhe4de2zhen15jing8shen15du13da1dao6zhi15liao10mu8biao11，6bi12mian7zhen18jing19bu17zu0huo5guo13du15。11', label: '2.遵医嘱使用镇静药物，可根据RASS评分动态调整给药方式和药物用量，使患者的镇静深度达到治疗目标，避免镇静不足或过度。' },
  { group: '镇静镇痛管理', code: '3.7gen0ju13bing8qing8shi19shi1mei7ri12huan6xing19。1', label: '3.根据病情实施每日唤醒。' },
  // 谵妄管理 (11-12)
  { group: '谵妄管理', code: '1.9yi8si0zhan11wang0huan13zhe14，6ying10gen8ju9CAM-ICU8liang4biao14、ICDSC8liang9biao4jin7hang1ping15gu2。8', label: '1.疑似谵妄患者，应根据CAM-ICU量表、ICDSC量表进行评估。' },
  { group: '谵妄管理', code: ' 1.4yi18si9zhan5wang18huan8zhe5，4ying17gen19ju16CAM-ICU3liang6biao7、ICDSC16liang14biao3jin5hang1ping12gu9。 2.0zhan9wang5huan16zhe3ji1ji0zhi7liao5yuan17fa14bing5，11jian15shao8huo7bi14mian3yin11fa3zhan18wang15de18gao10wei16yin16su1，19bi19yao19shi12zun13yi13zhu19yong17yao10he16/7huo10shi11shi9yue0shu19。3', label: '2.谵妄患者积极治疗原发病，减少或避免引发谵妄的高危因素，必要时遵医嘱用药和/或实施约束。' },
  // 身体约束管理 (13-17)
  { group: '身体约束管理', code: '1.19he6li9ba5wo4yue6shu16zhi4zheng19，0dui18yu5yi10shi4zhang15ai1、8fan5zao16bu2an11deng17huan8zhe3，18bi19yao4shi19zun18yi18zhu17gei15yu18you4xiao3yue13shu15。18', label: '1.合理把握约束指征，对于意识障碍、烦躁不安等患者，必要时遵医嘱给予有效约束。' },
  { group: '身体约束管理', code: '2.3qian12shu5《1bao8hu6xing15yue3shu17zhi10qing8tong5yi17shu9》，8xiang6jia19shu10jie19shi2yue10shu15bi0yao7xing9。17', label: '2.签署《保护性约束知情同意书》，向家属解释约束必要性。' },
  { group: '身体约束管理', code: '3.6mei3ban9ping15gu1yue6shu13de16bi6yao18xing9，17shi16yong12zui16xiao4hua6yue9shu3，17ji2shi19jie15chu9bu4bi8yao14de4yue17shu13。8', label: '3.每班评估约束的必要性，使用最小化约束，及时解除不必要的约束。' },
  { group: '身体约束管理', code: '4.9yue16shu19shi7zhi8ti11ying5chu6yu13gong5neng13wei4，10dong16tai18guan3cha14yue3shu9xiao3guo7ji6you18wu13bing12fa6zheng9，7bi15yao8shi17geng15huan14yue10shu4bu8wei16。2ru12ti16wei0gai19bian15，15ying10ji18shi7tiao5zheng15yue6shu13wei5zhi6，12que12bao6shou13bu8yu12guan17dao0bao19chi17an2quan6ju3li2。17', label: '4.约束时肢体应处于功能位，动态观察约束效果及有无并发症，必要时更换约束部位。如体位改变，应及时调整约束位置，确保手部与管道保持安全距离。' },
  { group: '身体约束管理', code: '5.19mei13 2h 3guan17cha13yue3shu18bu12wei0de14pi17fu2ji10xie1ye19xun13huan3qing14kuang1。15', label: '5.每 2h 观察约束部位的皮肤及血液循环情况。' },
  // 尽早拔管 (18)
  { group: '尽早拔管', code: 'mei5ri2ping8gu11guan1dao4liu3zhi5de16bi5yao19xing16，5fu0he14ba9guan3zhi16zheng7ying19jin5zao2ba17chu14。10', label: '每日评估管道留置的必要性，符合拔管指征应尽早拔除。' },
];

/** 备注文本 */
const FOOTNOTE =
  '备注：评估总分：≥9分高危，6-8分中危，≤5分低危；首次评估后:＜9分者每周评估1次；≥9分者每天评估1次，每班交接，直至导管拔出；当评估内容发生变化随时评估更新。RASS, Richmond 躁动 - 镇静量表；NRS 疼痛数字评定量表；CPOT 重症监护疼痛观察工具。* 如果按照低风险为 1 分，并根据等级分值逐渐累加，结合组合权重的分值，将组合权重 ×50 后可初步得出相应的分值，考虑到部分情况无拔管风险，故将组合权重 ×50-1，得到无风险的分值为 0 分，低风险为 1 分，如此累加。';

/* ============================= 数据模型 ============================= */

interface NurseMeasure { code: string; value: boolean; }

interface UnPlannedScore {
  rass?: number;
  noRass?: number;
  noRassIndexList?: number[];
  ssd?: number;
  gthz?: number;
  xwhz?: number;
  dgsl?: number;
  dggd?: number;
}

interface ScoreRecord {
  _id?: string;
  pid?: string;
  time?: string;
  scoreType?: string;
  total?: number;
  conclusion?: string;
  valid?: boolean;
  inputUserId?: string;
  inputUser?: string;
  nurseMeasureList?: NurseMeasure[];
  /** 无导管：true 时在该行打钩 */
  noTube?: boolean;
  unPlannedCGZYYScore?: UnPlannedScore;
}

/** 单条评估记录（用于表格列） */
interface EvalColumn {
  time: string;
  rass: number | null;
  noRass: number | null;
  noRassIndexList: number[];
  ssd: number | null;
  gthz: number | null;
  xwhz: number | null;
  dgsl: number | null;
  dggd: number | null;
  total: number | null;
  conclusion: string;
  measures: boolean[];
  /** 无导管：true 时在该行打钩 */
  noTube?: boolean;
  signUserId?: string;
  signName?: string;
}

/** 物理页 */
interface RenderPage {
  index: number;
  cols: EvalColumn[];
  isSecondPage: boolean;
  diagnosis?: string;
}

type ScoreField = 'ssd' | 'gthz' | 'xwhz' | 'dgsl' | 'dggd';

/* ============================= 组件 ============================= */

@Component({
  standalone: false,
  selector: 'app-unplanned-extubation',
  template: `
    <div class="toolbar no-print" *ngIf="!isViewerMode">
      <div class="toolbar-right">
        <span class="auditor-field">
          <span class="auditor-label">审核护士签名：</span>
          <span class="auditor-combo">
            <input class="auditor-input" type="text" [(ngModel)]="auditorQuery"
                   [placeholder]="auditorName || '搜索并选择'"
                   (focus)="onAuditorFocus()" (blur)="onAuditorBlur()" />
            <ul class="auditor-menu" *ngIf="auditorOpen">
              <li class="auditor-opt empty-opt" (mousedown)="clearAuditor()">（空）</li>
              <li class="auditor-opt" *ngFor="let a of filteredAccounts" (mousedown)="selectAuditor(a)">{{ a.accountName }}</li>
              <li class="auditor-opt no-opt" *ngIf="filteredAccounts.length === 0">无匹配账号</li>
            </ul>
          </span>
        </span>
        <app-print-page-multi-select
          [totalPages]="pages.length"
          [(selectedPages)]="selectedPrintPages"
          [disabled]="loading"
        ></app-print-page-multi-select>
        <button class="btn" (click)="onPrint()">打印</button>
      </div>
    </div>

    <div class="loading" *ngIf="loading">加载中…</div>

    <!-- 第一页：评分页 -->
    <ng-container *ngFor="let page of pages">
      <div class="sheet" *ngIf="!page.isSecondPage"
           [class.sheet-hidden]="!isPrintPageSelected(page.index)">
        <div class="sheet-head">
          <div class="title-line">{{hospitalName}}非计划拔管风险评估及护理措施记录单</div>
        </div>

        <div class="patient-info-row">
          <span class="info-item"><b>科室：</b>{{patient?.dept || ''}}</span>
          <span class="info-item"><b>姓名：</b>{{patient?.name || ''}}</span>
          <span class="info-item"><b>床号：</b>{{patient?.hisBed ? (patient.hisBed.endsWith('床') ? patient.hisBed : patient.hisBed + '床') : ''}}</span>
          <span class="info-item"><b>住院号：</b>{{patient?.mrn || ''}}</span>
          <span class="info-item"><b>性别：</b>{{genderText(patient?.gender)}}</span>
          <span class="info-item"><b>年龄：</b>{{age ?? ''}}</span>
          <span class="info-item diagnosis-item"><b>诊断：</b>{{page.diagnosis || diagnosisDisplay}}</span>
        </div>

        <table class="record-table assessment-table">
          <colgroup>
            <col class="item-col">
            <col class="sub-item-col">
            <col class="desc-col">
            <col class="score-col">
            <col class="data-col" *ngFor="let c of pagePaddedCols(page)">
          </colgroup>
          <thead>
            <tr>
              <th class="item-col">项目</th>
              <th class="sub-item-col">具体评估细则</th>
              <th class="desc-col">评估内容</th>
              <th class="score-col">分值</th>
              <th class="data-col" *ngFor="let c of pagePaddedCols(page)">
                <div class="dt-date">{{ c ? fmtDate(c.time) : '' }}</div>
                <div class="dt-time">{{ c ? fmtTime(c.time) : '' }}</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <!-- 神志意识及精神状态 - 实施镇静剂 -->
            <tr>
              <td class="item-cell" rowspan="10">神志意识及<br>精神状态</td>
              <td class="sub-item-cell" rowspan="4">实施镇静剂<br>的患者</td>
              <td class="desc-cell">RASS -5~-3</td>
              <td class="score-cell">0</td>
              <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkRass(c, 0) }}</td>
            </tr>
            <tr>
              <td class="desc-cell">RASS -2~0</td>
              <td class="score-cell">1</td>
              <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkRass(c, 1) }}</td>
            </tr>
            <tr>
              <td class="desc-cell">RASS 1~2</td>
              <td class="score-cell">2</td>
              <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkRass(c, 2) }}</td>
            </tr>
            <tr>
              <td class="desc-cell">RASS 3~4</td>
              <td class="score-cell">3</td>
              <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkRass(c, 3) }}</td>
            </tr>
            <!-- 神志意识及精神状态 - 未实施镇静 -->
            <tr>
              <td class="sub-item-cell" rowspan="6">未实施镇静或<br>不适宜用 RASS<br>评分患者</td>
              <td class="desc-cell">{{noRassOptions[0].label}}</td>
              <td class="score-cell">{{noRassOptions[0].score}}</td>
              <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkNoRass(c, 0) }}</td>
            </tr>
            <tr>
              <td class="desc-cell">{{noRassOptions[1].label}}</td>
              <td class="score-cell">{{noRassOptions[1].score}}</td>
              <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkNoRass(c, 1) }}</td>
            </tr>
            <tr>
              <td class="desc-cell">{{noRassOptions[2].label}}</td>
              <td class="score-cell">{{noRassOptions[2].score}}</td>
              <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkNoRass(c, 2) }}</td>
            </tr>
            <tr>
              <td class="desc-cell">{{noRassOptions[3].label}}</td>
              <td class="score-cell">{{noRassOptions[3].score}}</td>
              <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkNoRass(c, 3) }}</td>
            </tr>
            <tr>
              <td class="desc-cell">{{noRassOptions[4].label}}</td>
              <td class="score-cell">{{noRassOptions[4].score}}</td>
              <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkNoRass(c, 4) }}</td>
            </tr>
            <tr>
              <td class="desc-cell">{{noRassOptions[5].label}}</td>
              <td class="score-cell">{{noRassOptions[5].score}}</td>
              <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkNoRass(c, 5) }}</td>
            </tr>
            <!-- 舒适度：合并具体评估细则和评估内容 -->
            <ng-container *ngFor="let option of ssdOptions; let index = index">
              <tr>
                <td *ngIf="index === 0" [attr.rowspan]="ssdOptions.length" class="item-cell">舒适度</td>
                <td colspan="2" class="desc-cell merged-detail-cell">{{ option.label }}</td>
                <td class="score-cell">{{ option.score }}</td>
                <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkField(c, 'ssd', option.score) }}</td>
              </tr>
            </ng-container>
            <!-- 沟通合作：合并具体评估细则和评估内容 -->
            <ng-container *ngFor="let option of gthzOptions; let index = index">
              <tr>
                <td *ngIf="index === 0" [attr.rowspan]="gthzOptions.length" class="item-cell">沟通合作</td>
                <td colspan="2" class="desc-cell merged-detail-cell">{{ option.label }}</td>
                <td class="score-cell">{{ option.score }}</td>
                <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkField(c, 'gthz', option.score) }}</td>
              </tr>
            </ng-container>
            <!-- 行为合作：合并具体评估细则和评估内容 -->
            <ng-container *ngFor="let option of xwhzOptions; let index = index">
              <tr>
                <td *ngIf="index === 0" [attr.rowspan]="xwhzOptions.length" class="item-cell">行为合作</td>
                <td colspan="2" class="desc-cell merged-detail-cell">{{ option.label }}</td>
                <td class="score-cell">{{ option.score }}</td>
                <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkField(c, 'xwhz', option.score) }}</td>
              </tr>
            </ng-container>
            <!-- 导管数量：完整展示所有选项 -->
            <ng-container *ngFor="let option of dgslOptions; let optionIndex = index">
              <tr>
                <td *ngIf="optionIndex === 0" [attr.rowspan]="dgslOptions.length" class="item-cell">导管数量</td>
                <td colspan="2" class="desc-cell merged-detail-cell">{{ option.label }}</td>
                <td class="score-cell">{{ option.score }}</td>
                <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkField(c, 'dgsl', option.score) }}</td>
              </tr>
            </ng-container>
          </tbody>
        </table>

        <div class="footnote">
          {{ footnote }}
        </div>

        <div class="sheet-pageno">第 {{page.index}} 页</div>
      </div>

      <!-- 第二页：护理措施页 -->
      <div class="sheet" *ngIf="page.isSecondPage"
           [class.sheet-hidden]="!isPrintPageSelected(page.index)">
        <div class="sheet-head">
          <div class="title-line">{{hospitalName}}非计划拔管风险评估及护理措施记录单</div>
        </div>

        <div class="patient-info-row">
          <span class="info-item"><b>科室：</b>{{patient?.dept || ''}}</span>
          <span class="info-item"><b>姓名：</b>{{patient?.name || ''}}</span>
          <span class="info-item"><b>床号：</b>{{patient?.hisBed ? (patient.hisBed.endsWith('床') ? patient.hisBed : patient.hisBed + '床') : ''}}</span>
          <span class="info-item"><b>住院号：</b>{{patient?.mrn || ''}}</span>
          <span class="info-item"><b>性别：</b>{{genderText(patient?.gender)}}</span>
          <span class="info-item"><b>年龄：</b>{{age ?? ''}}</span>
          <span class="info-item diagnosis-item"><b>诊断：</b>{{page.diagnosis || diagnosisDisplay}}</span>
        </div>

        <table class="record-table second-page-table">
          <colgroup>
            <col class="item-col" />
            <col class="sub-item-col" />
            <col class="desc-col" />
            <col class="score-col" />
            <col *ngFor="let c of pagePaddedCols(page)" class="data-col" />
          </colgroup>
          <thead>
            <tr>
              <th class="item-col">项目</th>
              <th class="sub-item-col" colspan="2">评估内容</th>
              <th class="score-col">分值</th>
              <th class="data-col" *ngFor="let c of pagePaddedCols(page)">
                <div class="dt-date">{{ c ? fmtDate(c.time) : '' }}</div>
                <div class="dt-time">{{ c ? fmtTime(c.time) : '' }}</div>
              </th>
            </tr>
          </thead>

          <tbody>
            <!-- 导管固定 -->
            <ng-container *ngFor="let option of dggdOptions; let index = index">
              <tr>
                <td *ngIf="index === 0" [attr.rowspan]="dggdOptions.length" class="item-cell">导管固定</td>
                <td colspan="2" class="desc-cell merged-detail-cell">{{ option.label }}</td>
                <td class="score-cell">{{ option.score }}</td>
                <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkField(c, 'dggd', option.score) }}</td>
              </tr>
            </ng-container>

            <!-- 评估总分 -->
            <tr>
              <td colspan="4" class="sum-label">评估总分</td>
              <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ c && c.total !== null ? c.total : '' }}</td>
            </tr>

            <!-- 危险程度 -->
            <tr>
              <td colspan="4" class="sum-label">危险程度</td>
              <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ c ? c.conclusion : '' }}</td>
            </tr>

            <!-- 护理措施 -->
            <tr *ngFor="let measure of nurseMeasures; let measureIndex = index">
              <td *ngIf="measureIndex === 0" [attr.rowspan]="nurseMeasures.length" class="measure-main-label">
                <span class="vertical-text">护理措施</span>
              </td>
              <td *ngIf="measure.rowspan > 0" [attr.rowspan]="measure.rowspan" class="measure-label">{{ measure.group }}</td>
              <td colspan="2" class="measure-item">{{ measure.label }}</td>
              <td *ngFor="let c of pagePaddedCols(page)" class="data-cell measure-check-cell">{{ checkMeasure(c, measureIndex) }}</td>
            </tr>

            <!-- 无导管（数据源字段 noTube，true 打钩） -->
            <tr>
              <td colspan="4" class="sum-label">无导管</td>
              <td *ngFor="let c of pagePaddedCols(page)" class="data-cell">{{ checkNoTube(c) }}</td>
            </tr>

            <!-- 护士签名 -->
            <tr>
              <td colspan="4" class="sum-label">护士签名</td>
              <td *ngFor="let c of pagePaddedCols(page)" class="data-cell sign-cell">{{ c ? (c.signName || '') : '' }}</td>
            </tr>
          </tbody>
        </table>

        <div class="footnote">
          {{ footnote }}
        </div>

        <div class="review-sign" *ngIf="page.index === pages.length">审核护士签名：{{ auditorName || '__________' }}</div>
        <div class="sheet-pageno">第 {{page.index}} 页</div>
      </div>
    </ng-container>
  `,
  styles: [`
    :host { display:block; background:#f0f2f5; height:100vh; overflow:auto; }
    .toolbar { display:flex; justify-content:flex-end; align-items:center; padding:10px 16px; background:#fff; border-bottom:1px solid #eee; position:sticky; top:0; z-index:50; }
    .toolbar-right { display:flex; align-items:center; gap:12px; }
    .page-select select { padding:4px 8px; }
    .btn { padding:5px 16px; border:1px solid #1890ff; background:#1890ff; color:#fff; border-radius:4px; cursor:pointer; }
    .loading { padding:16px; font-family:'SimSun', '宋体', serif; }
    .sheet-hidden { display:none; }

    .auditor-field { display:flex; align-items:center; }
    .auditor-label { font-family:'SimSun','宋体',serif; font-size:14px; white-space:nowrap; }
    .auditor-combo { position:relative; display:inline-block; }
    .auditor-input { padding:4px 8px; border:1px solid #ccc; border-radius:4px; font-size:14px; width:150px; }
    .auditor-menu { position:absolute; top:100%; left:0; right:0; margin:2px 0 0; padding:4px 0; list-style:none; max-height:240px; overflow-y:auto; background:#fff; border:1px solid #d9d9d9; border-radius:4px; box-shadow:0 2px 8px rgba(0,0,0,0.15); z-index:100; }
    .auditor-opt { padding:5px 10px; font-size:14px; cursor:pointer; white-space:nowrap; }
    .auditor-opt:hover { background:#f0f7ff; } .empty-opt { color:#999; } .no-opt { color:#999; cursor:default; }

    .sheet {
      box-sizing: border-box;
      position: relative;
      width: 297mm;
      height: 210mm;
      min-height: 210mm;
      margin: 16px auto;
      padding: 7mm 10mm;
      overflow: hidden;
      background: #fff;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      color: #000;
      font-family: 'SimSun', '宋体', serif;
    }

    .sheet-head {
      padding-bottom: 1px;
      text-align: center;
    }

    .title-line {
      font-family: 'SimHei', '黑体', sans-serif;
      font-size: 19pt;
      font-weight: 700;
      line-height: 1.1;
    }

    .patient-info-row {
      display: flex;
      align-items: center;
      width: 100%;
      gap: 10px;
      margin: 0 0 2px;
      color: #000;
      font-family: 'SimSun', '宋体', serif;
      font-size: 10pt;
      font-weight: 400;
      line-height: 1.05;
      white-space: nowrap;
    }

    .info-item {
      flex: 0 0 auto;
      white-space: nowrap;
    }

    .info-item b {
      font-weight: 700;
    }

    .diagnosis-item {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .record-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      color: #000;
      font-family: 'SimSun', '宋体', serif;
      font-size: 9.5pt;
      line-height: 1.12;
    }

    .record-table th,
    .record-table td {
      box-sizing: border-box;
      height: 26px;
      padding: 2px 3px;
      border: 1px solid #000;
      text-align: center;
      vertical-align: middle;
      overflow-wrap: break-word;
      word-break: normal;
    }

    .record-table th {
      background: transparent;
      color: #000;
      font-weight: 700;
    }

    .record-table td {
      color: #000;
      font-weight: 400;
    }

    /* 第一页评分表 */
    .assessment-table th,
    .assessment-table td {
      height: 26px;
      padding-top: 2px;
      padding-bottom: 2px;
      line-height: 1.1;
    }

    /* 第二页内容更多，需要进一步压缩 */
    .second-page-table th,
    .second-page-table td {
      height: 21px;
      padding: 1px 2px;
      line-height: 1.02;
    }

    .item-col { width: 82px; }
    .sub-item-col { width: 96px; }
    .desc-col { width: 250px; }
    .score-col { width: 42px; }
    .data-col { width: 90px; min-width: 90px; max-width: 90px; }

    .item-cell { font-weight: 700; vertical-align: middle; }
    .sub-item-cell { font-weight: 700; vertical-align: middle; }
    .desc-cell { padding-right: 3px; padding-left: 3px; text-align: left; overflow-wrap: break-word; word-break: normal; }
    .score-cell { font-weight: 700; }
    .sum-label { padding-left: 4px; text-align: center; font-weight: 700; }
    .merged-detail-cell { padding-right: 3px; padding-left: 3px; text-align: center; overflow-wrap: break-word; word-break: normal; }

    .measure-main-label { width: 82px; padding: 0; text-align: center; vertical-align: middle; font-weight: 700; font-size: 8.5pt; line-height: 1; }
    .vertical-text { display: inline-block; writing-mode: vertical-rl; text-orientation: upright; letter-spacing: 1px; line-height: 1.1; }
    .measure-label { width: 96px; padding: 0 1px; text-align: center; vertical-align: middle; font-size: 8pt; font-weight: 400; line-height: 1; }
    .measure-item { padding: 1px 2px; text-align: left; vertical-align: middle; font-size: 8pt; line-height: 1.02; overflow-wrap: break-word; word-break: normal; }

    .data-cell { width: 90px; min-width: 90px; max-width: 90px; padding: 1px; text-align: center; vertical-align: middle; font-size: 10.5pt; }
    .measure-check-cell { font-size: 10.5pt; font-weight: 700; line-height: 1; }
    .sign-cell { font-size: 8.5pt; white-space: normal; word-break: break-all; line-height: 1; }

    .dt-date, .dt-time { display: block; width: 100%; padding: 0; overflow: visible; text-align: center; white-space: nowrap; font-size: 9pt; line-height: 1.1; }

    .footnote {
      box-sizing: border-box;
      width: 100%;
      margin-top: 1px;
      padding: 0;
      color: #000;
      font-family: 'SimSun', '宋体', serif;
      font-size: 6.8pt;
      font-weight: 400;
      line-height: 1.02;
      text-align: left;
      white-space: normal;
      word-break: normal;
      overflow-wrap: break-word;
    }

    .sheet-pageno {
      position: absolute;
      right: 0;
      bottom: 35px;
      left: 0;
      margin: 0;
      color: #000;
      font-family: 'SimSun', '宋体', serif;
      font-size: 12pt;
      font-weight: 400;
      line-height: 1;
      text-align: center;
      white-space: nowrap;
    }

    .review-sign { margin-top:8px; text-align:right; font-family:'SimSun','宋体',serif; font-size:13pt; font-weight:400; padding-right:6px; }

    @media screen {
      .sheet { zoom: var(--sheet-scale, 1); }
    }

    @media print {
      :host { height: auto; overflow: visible; background: #fff; }
      .no-print { display: none !important; }
      .sheet-hidden { display: none !important; }
      .sheet { margin: 0; box-shadow: none; transform: none !important; zoom: 1 !important; }
    }
  `],
})
export class UnplannedExtubationComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly API_SCORE = '/api/v1/icu/score/listByPid';
  private readonly API_HOSPITAL = '/api/v1/config/hospital';
  private readonly API_ACCOUNT = '/api/v1/icu/accounts/listByIds';
  private readonly API_ACCOUNT_ALL = '/api/v1/icu/accounts';

  readonly noRassOptions = NO_RASS_OPTIONS;
  readonly ssdOptions = SSD_OPTIONS;
  readonly gthzOptions = GTHZ_OPTIONS;
  readonly xwhzOptions = XWHZ_OPTIONS;
  readonly dgslOptions = DGSL_OPTIONS;
  readonly dggdOptions = DGGD_OPTIONS;
  readonly nurseMeasures = NURSE_MEASURES.map((m, i) => {
    const groupStart = NURSE_MEASURES.findIndex(x => x.group === m.group);
    return { ...m, rowspan: i === groupStart ? NURSE_MEASURES.filter(x => x.group === m.group).length : 0 };
  });
  readonly footnote = FOOTNOTE;

  loading = true;
  patient: any = null;
  hospitalName = '重钢总医院';
  diagnosisDisplay = '';
  age: number | null = null;

  records: ScoreRecord[] = [];
  columns: EvalColumn[] = [];
  pages: RenderPage[] = [];
  selectedPrintPages: number[] = [];
  isViewerMode = false;

  // 审核者签名
  auditorName = ''; auditorId = ''; auditorQuery = ''; auditorOpen = false;
  accountList: { accountId: string; accountName: string }[] = [];
  private blurTimer: any = null;
  private readonly AUDITOR_BLOCK = ['工程师', '美康', '他科带入', '外院带入', '其他账号'];

  readonly colsPerPage = 5;
  private pid = '';
  private destroy$ = new Subject<void>();
  private ro?: ResizeObserver;
  private __lastPid: string | null = null;

  constructor(
    private http: HttpClient,
    private hostPatient: HostPatientService,
    private cdr: ChangeDetectorRef,
    private host: ElementRef,
    private contextService: IcuFormViewerContextService,
    private diagHistory: DiagnosisHistoryService,
  ) {}

  ngOnInit(): void {
    this.contextService.getContext$().pipe(
      takeUntil(this.destroy$),
    ).subscribe(ctx => {
      this.isViewerMode = ctx.isViewerMode;
      this.cdr.markForCheck();
    });
    this.loadHospitalName();
    this.loadAccountList();
    this.hostPatient.patient$.pipe(
      filter(p => !!p),
      map(p => ({ p, pid: String(p.id || '').trim() })),
      filter(({ pid }) => !!pid),
      tap(({ pid }) => { if (pid !== this.__lastPid) this.__lastPid = pid; }),
      distinctUntilChanged((a, b) => a.pid === b.pid),
      switchMap(({ p, pid }) => this.diagHistory.ensurePatient(p).pipe(map(ep => ({ p: ep, pid })))),
      tap(({ p, pid }) => {
        this.resetForm();
        this.patient = p;
        this.pid = pid;
        this.age = this.calcAge(p.birthday);
        this.diagnosisDisplay = this.formatDiagnosis(p.clinicalDiagnosis);
        this.loadAuditor();
      }),
      switchMap(({ pid }) => this.loadFromServer(pid)),
      takeUntil(this.destroy$),
    ).subscribe();
  }

  ngAfterViewInit(): void {
    this.fitScale();
    this.ro = new ResizeObserver(() => this.fitScale());
    this.ro.observe(this.host.nativeElement);
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.ro?.disconnect();
  }

  private resetForm(): void {
    this.records = [];
    this.columns = [];
    this.pages = [];
    this.selectedPrintPages = [];
    this.age = null;
    this.diagnosisDisplay = '';
    this.auditorName = ''; this.auditorId = ''; this.auditorQuery = ''; this.auditorOpen = false;
    this.cdr.detectChanges();
  }

  private loadFromServer(pid: string) {
    this.loading = true;
    return this.http
      .get<ScoreRecord[]>(this.API_SCORE, { params: { pid, scoreType: SCORE_TYPE } })
      .pipe(
        tap((res) => {
          const list = Array.isArray(res) ? res : res ? [res as any] : [];
          this.records = list.filter(r => r && r.valid === true && r.scoreType === SCORE_TYPE && !!r.time);
          this.buildColumns();
        }),
        finalize(() => { this.loading = false; this.cdr.detectChanges(); }),
      );
  }

  private buildColumns(): void {
    const cols: EvalColumn[] = this.records
      .filter(record => !!record.time)
      .map(record => {
        const score = record.unPlannedCGZYYScore || {};
        return {
          time: record.time!,
          rass: this.num(score.rass),
          noRass: this.num(score.noRass),
          noRassIndexList: Array.isArray(score.noRassIndexList)
            ? score.noRassIndexList.map(value => Number(value)).filter(value => Number.isInteger(value))
            : [],
          ssd: this.num(score.ssd),
          gthz: this.num(score.gthz),
          xwhz: this.num(score.xwhz),
          dgsl: this.num(score.dgsl),
          dggd: this.num(score.dggd),
          total: this.num(record.total),
          conclusion: record.conclusion || '',
          measures: this.parseMeasures(record.nurseMeasureList),
          noTube: record.noTube === true,
          signUserId: record.inputUserId,
          signName: record.inputUser || '',
        };
      })
      .sort((a, b) => this.ts(a.time) - this.ts(b.time));

    this.columns = cols;

    const userIds = [
      ...new Set(cols.map(column => column.signUserId).filter(Boolean) as string[]),
    ];

    if (!userIds.length) {
      this.paginate();
      this.cdr.detectChanges();
      return;
    }

    this.http
      .get<any[]>(this.API_ACCOUNT, { params: { ids: userIds.join(',') } })
      .subscribe({
        next: accounts => {
          const nameMap = new Map<string, string>();
          if (Array.isArray(accounts)) {
            for (const account of accounts) {
              const accountId = account?._id || account?.id;
              if (accountId) {
                nameMap.set(String(accountId), account?.trueName || account?.accountName || '');
              }
            }
          }
          for (const column of this.columns) {
            if (column.signUserId && nameMap.has(column.signUserId)) {
              column.signName = nameMap.get(column.signUserId) || column.signName;
            }
          }
          this.paginate();
          this.cdr.detectChanges();
        },
        error: () => {
          this.paginate();
          this.cdr.detectChanges();
        },
      });
  }

  private parseMeasures(list?: NurseMeasure[]): boolean[] {
    const result = new Array<boolean>(NURSE_MEASURES.length).fill(false);
    if (!Array.isArray(list)) return result;
    // 按 code 匹配，而非按数组下标
    for (const item of list) {
      if (item?.value !== true || !item.code) continue;
      const idx = NURSE_MEASURES.findIndex(m => m.code === item.code);
      if (idx >= 0) result[idx] = true;
    }
    return result;
  }

  checkRass(col: EvalColumn | null, score: number): string {
    if (!col) return '';
    return col.rass === score ? '√' : '';
  }

  checkNoRass(col: EvalColumn | null, index: number): string {
    if (!col) return '';
    const indexes = Array.isArray(col.noRassIndexList) ? col.noRassIndexList : [];
    if (indexes.length > 0) {
      return indexes.includes(index) ? '√' : '';
    }
    const option = NO_RASS_OPTIONS[index];
    if (!option || col.noRass !== option.score) return '';
    const firstMatchIndex = NO_RASS_OPTIONS.findIndex(item => item.score === option.score);
    return index === firstMatchIndex ? '√' : '';
  }

  checkField(col: EvalColumn | null, field: ScoreField, score: number): string {
    if (!col) return '';
    return col[field] === score ? '√' : '';
  }

  checkMeasure(col: EvalColumn | null, index: number): string {
    if (!col) return '';
    return col.measures[index] === true ? '√' : '';
  }

  /** 无导管：字段 noTube 为 true 才打钩，否则置空 */
  checkNoTube(col: EvalColumn | null): string {
    if (!col) return '';
    return col.noTube === true ? '√' : '';
  }

  private paginate(): void {
    const per = this.colsPerPage;
    const pages: RenderPage[] = [];
    if (!this.columns.length) {
      const blank = this.diagnosisForPage(null);
      pages.push({ index: 1, cols: [], isSecondPage: false, diagnosis: blank });
      pages.push({ index: 2, cols: [], isSecondPage: true, diagnosis: blank });
    } else {
      for (let i = 0; i < this.columns.length; i += per) {
        const cols = this.columns.slice(i, i + per);
        const diagnosis = this.diagnosisForPage(cols[0]);
        const baseIndex = pages.length + 1;
        pages.push({ index: baseIndex, cols, isSecondPage: false, diagnosis });
        pages.push({ index: baseIndex + 1, cols, isSecondPage: true, diagnosis });
      }
    }
    this.pages = pages;
    this.normalizeSelectedPrintPages(pages.length);
  }

  pagePaddedCols(page: RenderPage): (EvalColumn | null)[] {
    const result: (EvalColumn | null)[] = page.cols.slice(0, this.colsPerPage);
    while (result.length < this.colsPerPage) result.push(null);
    return result;
  }

  private fitScale(): void {
    const SHEET_W = 297 * (96 / 25.4);
    const avail = this.host.nativeElement.clientWidth - 32;
    const scale = Math.min(1, avail / SHEET_W);
    this.host.nativeElement.style.setProperty('--sheet-scale', String(scale));
  }

  private loadHospitalName(): void {
    this.http.get<{ hospitalName: string }>(this.API_HOSPITAL).subscribe({
      next: (res) => { if (res?.hospitalName) { this.hospitalName = res.hospitalName; this.cdr.detectChanges(); } },
      error: () => {},
    });
  }

  /* ===== 审核者下拉（可检索 + 屏蔽 + 登录者置顶） ===== */
  private get baseAccounts() { return this.accountList.filter(a => a.accountName && !this.AUDITOR_BLOCK.includes(a.accountName.trim())); }
  get orderedAccounts(): { accountId: string; accountName: string }[] {
    const login = this.hostPatient.getAccount(); const loginName = (login?.trueName || '').trim();
    const list = [...this.baseAccounts];
    if (loginName && !this.AUDITOR_BLOCK.includes(loginName)) {
      const idx = list.findIndex(a => a.accountName === loginName);
      const opt = idx >= 0 ? list.splice(idx, 1)[0] : { accountId: login.username || login.accountId || login.id || '', accountName: loginName };
      return [opt, ...list];
    }
    return list;
  }
  get filteredAccounts() {
    const q = (this.auditorQuery || '').trim().toLowerCase();
    const base = this.orderedAccounts;
    return q ? base.filter(a => a.accountName.toLowerCase().includes(q)) : base;
  }
  onAuditorFocus(): void { if (this.blurTimer) { clearTimeout(this.blurTimer); this.blurTimer = null; } this.auditorOpen = true; this.auditorQuery = ''; }
  onAuditorBlur(): void { this.blurTimer = setTimeout(() => { this.auditorOpen = false; this.auditorQuery = this.auditorName; this.cdr.detectChanges(); }, 150); }
  selectAuditor(a: { accountId: string; accountName: string }): void { this.auditorName = a.accountName; this.auditorId = a.accountId; this.auditorQuery = a.accountName; this.auditorOpen = false; this.saveAuditor(); }
  clearAuditor(): void { this.auditorName = ''; this.auditorId = ''; this.auditorQuery = ''; this.auditorOpen = false; this.saveAuditor(); }
  private saveAuditor(): void {
    if (!this.pid) return;
    this.http.post(API_EXTRA_SAVE, {
      pid: this.pid, formCode: FORM_CODE,
      auditorId: this.auditorId, auditorName: this.auditorName,
    }).subscribe({ next: () => {}, error: (e) => console.error('[unplanned] saveAuditor failed', e) });
  }
  private loadAuditor(): void {
    if (!this.pid) return;
    this.http.get<any>(API_EXTRA_LATEST, { params: { pid: this.pid, formCode: FORM_CODE } }).subscribe({
      next: (d) => {
        if (d) { this.auditorName = d.auditorName || ''; this.auditorId = d.auditorId || ''; }
        this.auditorQuery = this.auditorName;
        this.cdr.detectChanges();
      },
      error: () => this.cdr.detectChanges(),
    });
  }
  private loadAccountList(): void {
    this.http.get<any[]>(this.API_ACCOUNT_ALL).subscribe({
      next: (list) => {
        this.accountList = (Array.isArray(list) ? list : [])
          .map(a => ({ accountId: a?.accountId || a?.username || a?.id || '', accountName: a?.accountName || a?.trueName || '' }))
          .filter(a => a.accountName);
        this.cdr.detectChanges();
      },
      error: (e) => console.error('[unplanned] loadAccountList failed', e),
    });
  }

  genderText(g?: string): string {
    if (g === 'Male' || g === 'M' || g === '男') return '男';
    if (g === 'Female' || g === 'F' || g === '女') return '女';
    return g || '';
  }

  private calcAge(birthday?: string): number | null {
    if (!birthday) return null;
    const b = new Date(birthday);
    if (isNaN(b.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - b.getFullYear();
    if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--;
    return age >= 0 ? age : null;
  }

  private formatDiagnosis(diagnosis?: string): string {
    return firstDiagnosisSegment(diagnosis, 'legacy');
  }

  /** 页诊断 = 该页第一条数据所在时间区间的诊断 */
  private diagnosisForPage(firstRecord: any): string {
    return resolvePageDiagnosis(this.patient, firstRecord, ['time'], this.diagnosisDisplay);
  }

  isPrintPageSelected(pageNumber: number, totalPages = this.pages.length): boolean {
    return shouldPrintPage(pageNumber, this.selectedPrintPages, totalPages);
  }
  private normalizeSelectedPrintPages(totalPages: number): void {
    const normalized = normalizePrintPages(this.selectedPrintPages, totalPages);
    this.selectedPrintPages = (normalized.length === totalPages && totalPages > 0) ? [] : normalized;
  }

  onPrint(): void {
    const allSheets = Array.from(this.host.nativeElement.querySelectorAll('.sheet')) as HTMLElement[];
    if (!allSheets.length) return;
    const sheets = this.pages;
    let body = '';
    allSheets.forEach((s: HTMLElement, idx: number) => {
      const pageIndex = idx + 1;
      if (!shouldPrintPage(pageIndex, this.selectedPrintPages, sheets.length)) return;
      const c = s.cloneNode(true) as HTMLElement;
      c.classList.remove('sheet-hidden');
      c.querySelectorAll('.no-print,.toolbar').forEach(el => el.remove());
      c.style.zoom = '1'; c.style.transform = 'none';
      body += `
        <div class="print-page">
          ${c.outerHTML}
        </div>
      `;
    });
    const css = `
      @page {
        size: A4 landscape;
        margin: 0;
      }

      html,
      body {
        width: 297mm;
        margin: 0;
        padding: 0;
        background: #fff;
      }

      body {
        color: #000;
        font-family: 'SimSun', '宋体', serif;
      }

      .print-page {
        box-sizing: border-box;
        position: relative;
        width: 297mm;
        height: 210mm;
        margin: 0;
        padding: 0;
        overflow: hidden;
        break-after: page;
        page-break-after: always;
        background: #fff;
      }

      .print-page:last-child {
        break-after: auto;
        page-break-after: auto;
      }

      .sheet {
        box-sizing: border-box;
        position: relative;
        width: 297mm !important;
        max-width: 297mm !important;
        height: 210mm !important;
        min-height: 210mm !important;
        max-height: 210mm !important;
        margin: 0 !important;
        padding: 7mm 10mm !important;
        overflow: hidden !important;
        background: #fff;
        box-shadow: none !important;
        color: #000;
        transform: none !important;
        zoom: 1 !important;
        filter: none !important;
        text-shadow: none !important;
      }

      .sheet-head {
        padding-bottom: 1px;
        text-align: center;
      }

      .title-line {
        font-family: 'SimHei', '黑体', sans-serif;
        font-size: 19pt;
        font-weight: 700;
        line-height: 1.1;
      }

      .patient-info-row {
        display: flex;
        align-items: center;
        width: 100%;
        gap: 10px;
        margin: 0 0 2px;
        color: #000;
        font-size: 10pt;
        font-weight: 400;
        line-height: 1.05;
        white-space: nowrap;
      }

      .info-item {
        flex: 0 0 auto;
        white-space: nowrap;
      }

      .diagnosis-item {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .record-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        color: #000;
        font-size: 9.5pt;
        line-height: 1.12;
      }

      .record-table th,
      .record-table td {
        box-sizing: border-box;
        height: 26px;
        padding: 2px 3px;
        border: 1px solid #000;
        color: #000;
        text-align: center;
        vertical-align: middle;
        overflow-wrap: break-word;
        word-break: normal;
      }

      .record-table th {
        background: transparent;
        font-weight: 700;
      }

      .record-table td {
        font-weight: 400;
      }

      .assessment-table th,
      .assessment-table td {
        height: 26px;
        line-height: 1.1;
      }

      .second-page-table th,
      .second-page-table td {
        height: 21px;
        padding: 1px 2px;
        line-height: 1.02;
      }

      .item-col { width: 82px; }
      .sub-item-col { width: 96px; }
      .desc-col { width: 250px; }
      .score-col { width: 42px; }
      .data-col { width: 90px; min-width: 90px; max-width: 90px; }

      .item-cell { font-weight: 700; vertical-align: middle; }
      .sub-item-cell { font-weight: 700; vertical-align: middle; }
      .desc-cell { padding-right: 3px; padding-left: 3px; text-align: left; overflow-wrap: break-word; word-break: normal; }
      .score-cell { font-weight: 700; }
      .sum-label { padding-left: 3px; text-align: center; font-weight: 700; }
      .merged-detail-cell { padding-right: 3px; padding-left: 3px; text-align: center; overflow-wrap: break-word; word-break: normal; }

      .measure-main-label { width: 82px; padding: 0; text-align: center; vertical-align: middle; font-weight: 700; font-size: 8.5pt; line-height: 1; }
      .vertical-text { display: inline-block; writing-mode: vertical-rl; text-orientation: upright; letter-spacing: 1px; line-height: 1; }
      .measure-label { width: 96px; padding: 0 1px; text-align: center; vertical-align: middle; font-size: 8pt; line-height: 1; }
      .measure-item { padding: 1px 2px; text-align: left; vertical-align: middle; font-size: 8pt; line-height: 1.02; overflow-wrap: break-word; word-break: normal; }

      .data-cell { width: 90px; min-width: 90px; max-width: 90px; padding: 1px; text-align: center; vertical-align: middle; font-size: 10.5pt; }
      .measure-check-cell { font-size: 10.5pt; font-weight: 700; line-height: 1; }
      .sign-cell { font-size: 8.5pt; white-space: normal; word-break: break-all; line-height: 1; }

      .dt-date,
      .dt-time { display: block; width: 100%; padding: 0; overflow: visible; text-align: center; white-space: nowrap; font-size: 9pt; line-height: 1.1; }

      .footnote {
        box-sizing: border-box;
        width: 100%;
        margin-top: 1px;
        padding: 0;
        color: #000;
        font-size: 6.8pt;
        font-weight: 400;
        line-height: 1.02;
        text-align: left;
        white-space: normal;
        word-break: normal;
        overflow-wrap: break-word;
      }

      .sheet-pageno {
        position: absolute;
        right: 0;
        bottom: 35px;
        left: 0;
        margin: 0;
        color: #000;
        font-family: 'SimSun', '宋体', serif;
        font-size: 12pt;
        font-weight: 400;
        line-height: 1;
        text-align: center;
        white-space: nowrap;
      }

      .review-sign { margin-top:8px; text-align:right; font-family:'SimSun','宋体',serif; font-size:12pt; font-weight:400; padding-right:6px; }

      .no-print,
      .sheet-hidden {
        display: none !important;
      }
    `;
    const win = window.open('', '_blank', 'width=1400,height=900');
    if (!win) { alert('打印窗口被拦截，请允许弹出窗口'); return; }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>非计划拔管风险评估及护理措施记录单</title><style>${css}</style></head><body>${body}</body></html>`);
    win.document.close();
    const doPrint = () => {
      const printSheets = win.document.querySelectorAll<HTMLElement>('.sheet');
      printSheets.forEach((sheet, index) => {
        const horizontalOverflow = sheet.scrollWidth - sheet.clientWidth;
        const verticalOverflow = sheet.scrollHeight - sheet.clientHeight;
        if (horizontalOverflow > 1) {
          console.warn(`[unplanned-print] 第${index + 1}页横向溢出：${horizontalOverflow}px`);
        }
        if (verticalOverflow > 1) {
          console.warn(`[unplanned-print] 第${index + 1}页纵向溢出：${verticalOverflow}px`);
        }
        const titleRect = sheet.querySelector('.title-line')?.getBoundingClientRect();
        const tableRect = sheet.querySelector('.record-table')?.getBoundingClientRect();
        const footnoteRect = sheet.querySelector('.footnote')?.getBoundingClientRect();
        const pageNumberRect = sheet.querySelector('.sheet-pageno')?.getBoundingClientRect();
        if (footnoteRect && pageNumberRect) {
          if (footnoteRect.bottom > pageNumberRect.top) {
            console.warn(`[unplanned-print] 第${index + 1}页备注与页码重叠：${Math.round(footnoteRect.bottom)} > ${Math.round(pageNumberRect.top)}`);
          }
        }
      });
      win.focus(); win.print();
    };
    const ready = () => {
      const docWithFonts = win.document as Document & { fonts?: { ready: Promise<unknown> } };
      if (docWithFonts.fonts?.ready) {
        docWithFonts.fonts.ready.then(() => { requestAnimationFrame(() => requestAnimationFrame(doPrint)); });
      } else {
        requestAnimationFrame(() => requestAnimationFrame(doPrint));
      }
    };
    win.addEventListener('afterprint', () => { try { win.close(); } catch (e) {} });
    if ((win.document as any).readyState === 'complete') { ready(); } else { win.addEventListener('load', ready); }
  }

  fmtDate(v?: string): string { return formatShanghaiDate(v) || ''; }
  fmtTime(v?: string): string { return formatShanghaiTime(v) || ''; }

  private num(v: any): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  private ts(v?: string): number { return databaseTimeValue(v); }
}

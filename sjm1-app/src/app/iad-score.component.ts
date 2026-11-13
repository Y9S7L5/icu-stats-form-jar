/**
 * 成人失禁相关性皮炎(IAD)分类及会阴部皮肤评估护理记录单 —— Angular 组件
 * 访问路径：/form/IADForm
 *
 * A4 横向；行=每条 Score 记录（scoreType=incontinenceScore）
 * 打印模式与住院患者压力性损伤评估及措施记录单（Braden，braden-form）保持一致：
 * - 屏幕预览与打印共用同一 DOM，window.print() 直接打印（无弹窗、无自动缩放）
 * - @page{size:A4 landscape;margin:0}，.sheet 297×209mm，padding 7mm/10mm 承担页边距
 * - 每页一个 .sheet，page-break-after 分页；备注与审核护士签名仅末页展示
 * - 流式分页：按实测行高装页（整行原子不跨页拆行），末页为页脚预留高度
 */

import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { Subject } from 'rxjs';
import { distinctUntilChanged, filter, finalize, map, switchMap, takeUntil, tap } from 'rxjs/operators';
import { HostPatientService } from './services/host-patient.service';
import { IcuFormViewerContextService } from './icu-form-viewer-context.service';
import { databaseTimeValue, formatShanghaiDate, formatShanghaiTime } from './form-date.util';
import { normalizePrintPages, shouldPrintPage } from './form-print-pages.util';
import { firstDiagnosisSegment, resolvePageDiagnosis } from './diagnosis-history.util';
import { DiagnosisHistoryService } from './diagnosis-history.service';

/* ============================= 配置区 ============================= */

const SCORE_TYPE = 'incontinenceScore';
const FORM_CODE = 'IADForm';
const API_EXTRA_LATEST = '/api/v1/icu/fall-danger-extra/latest';
const API_EXTRA_SAVE = '/api/v1/icu/fall-danger-extra/save';
const MEASURE_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

/** IAD 三级描述；数组下标 i 对应 iad 值 = i + 1（0级=1、1级=2、2级=3） */
const IAD_LEVELS = [
  { label: '0级', desc: '无IAD：皮肤完好、无发红' },
  { label: '1级', desc: '轻度IAD：皮肤完整、发红；红斑、水肿' },
  { label: '2级', desc: '中重度IAD：皮肤发红、破损；水泡、大疱、皮肤糜烂、剥脱、感染' },
];

/** PAT 评分标准（分值 3/2/1 各列描述） */
const PAT_ROWS = [
  { score: 3, irritant: '水样便有或伴随尿液', time: '护理垫更换频率：至少每2小时更换', perineum: '脱皮/腐蚀（有或无皮炎）', influence: '影响因素≥3个' },
  { score: 2, irritant: '软便有或伴随尿液',   time: '护理垫更换频率：至少每4小时更换', perineum: '红斑/皮肤（有或无念珠菌感染）', influence: '影响因素：2个' },
  { score: 1, irritant: '成形便有或伴随尿液', time: '护理垫更换频率：至少每8小时更换', perineum: '干净无损伤', influence: '影响因素≤1个' },
];

/** 护理措施 A~I 全文（备注区展示） */
const MEASURE_LEGEND = [
  'A. 及时清洁有粪便和/或尿液污染的会阴部及周围皱褶处皮肤。',
  'B. 选用温和、无刺激的弱酸性或中性皮肤清洗液。',
  'C. 使用柔软、无刺激性的湿巾或布类按压式清洁皮肤。',
  'D. 使用一次性高吸收性护理用品，污染或潮湿应及时更换。',
  'E. 使用收集袋和/或引流装置管理粪便和/或尿液。',
  'F. 使用皮肤保护用品或水胶体敷料隔离潮湿和刺激物，范围大于粪便和/或尿液接触的皮肤，避免使用刺激性的皮肤保护用品。',
  'G. 使用保湿剂护理干燥皮肤。',
  'H. 根据皮肤破损面积和渗液量选用皮肤保护粉、水胶体敷料、泡沫敷料、藻酸盐敷料、亲水纤维敷料。',
  'I. 对于皮肤感染的患者，按医嘱外用抗感染药物或抗感染敷料，避免使用水胶体、泡沫类密闭、半密闭敷料。',
];

/* ============================= 数据模型 ============================= */

interface NurseMeasure { code?: string; value?: boolean; }
interface IncontinenceScore {
  iad?: number;
  irritantType?: number;
  stimulationTime?: number;
  perineum?: number;
  influenceFactor?: number;
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
  incontinenceScore?: IncontinenceScore;
}

interface IadRow {
  time: string;
  iad: number | null;
  irritantType: number | null;
  stimulationTime: number | null;
  perineum: number | null;
  influenceFactor: number | null;
  total: number | null;
  conclusion: string;
  measures: string[];
  signUserId?: string;
  signName?: string;
}

/** 一页：数据行（null=空白补白行）按顺序排列 */
interface RenderPage { index: number; rows: (IadRow | null)[]; diagnosis?: string; }

@Component({
  standalone: false,
  selector: 'app-iad-score',
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
              <li class="auditor-opt empty-opt" (mousedown)="onClearAuditorMouseDown($event)">（空）</li>
              <li class="auditor-opt" *ngFor="let a of filteredAccounts" (mousedown)="onAuditorOptionMouseDown($event, a)">{{ a.accountName }}</li>
              <li class="auditor-opt no-opt" *ngIf="filteredAccounts.length === 0">无匹配账号</li>
            </ul>
          </span>
        </span>
        <app-print-page-multi-select
          [totalPages]="pages.length"
          [(selectedPages)]="selectedPrintPages"
          [disabled]="loading"
        ></app-print-page-multi-select>
        <button class="btn" type="button" (click)="print()">打印</button>
      </div>
    </div>

    <div class="loading no-print" *ngIf="loading">加载中…</div>

    <ng-container *ngFor="let page of pages">
      <section class="sheet" [class.sheet-hidden]="!isPrintPageSelected(page.index)" [class.last-sheet]="page.index === pages.length">
        <div class="sheet-head">
          <div class="title-line">{{hospitalName}}成人失禁相关性皮炎分类及会阴部皮肤评估护理记录单</div>
          <!-- 患者信息行须放在 sheet-head 内：分页实测固定区高度量的是 .sheet-head 整体，
               放外面会漏掉约5mm，满页表格底线压进页码带 -->
          <div class="patient-info-row">
            <span class="info-item"><b>科室：</b>{{patient?.dept || patient?.deptName || patient?.departmentName || patient?.wardName || ''}}</span>
            <span class="info-item"><b>姓名：</b>{{patient?.name || ''}}</span>
            <span class="info-item"><b>床号：</b>{{ (patient?.hisBed || patient?.bedNo) ? ((patient?.hisBed || patient?.bedNo).endsWith('床') ? (patient?.hisBed || patient?.bedNo) : (patient?.hisBed || patient?.bedNo) + '床') : '' }}</span>
            <span class="info-item"><b>住院号：</b>{{patient?.mrn || patient?.hospitalNo || ''}}</span>
            <span class="info-item"><b>年龄：</b>{{age ?? ''}}</span>
            <span class="info-item"><b>性别：</b>{{genderText(patient?.gender)}}</span>
            <span class="info-item diagnosis-item"><b>诊断：</b>{{page.diagnosis || diagnosisDisplay}}</span>
          </div>
        </div>

        <table class="record-table">
          <thead>
            <tr>
              <th class="date-col" rowspan="5">日期时间</th>
              <th colspan="3">IAD分类</th>
              <th colspan="5">会阴部皮肤状况评估量表（PAT）</th>
              <th class="total-col" rowspan="5">总分</th>
              <th class="measure-col" rowspan="5">护理措施</th>
              <th class="sign-col" rowspan="5">签名</th>
            </tr>
            <tr>
              <th class="iad-sub">0级</th>
              <th class="iad-sub">1级</th>
              <th class="iad-sub">2级</th>
              <th class="pt-score-col">分值</th>
              <th>刺激物强度</th>
              <th>刺激物持续时间</th>
              <th>会阴部皮肤情况</th>
              <th>相关影响因素</th>
            </tr>
            <tr class="legend-row">
              <td class="legend-desc" rowspan="3">{{ IAD_LEVELS[0].desc }}</td>
              <td class="legend-desc" rowspan="3">{{ IAD_LEVELS[1].desc }}</td>
              <td class="legend-desc" rowspan="3">{{ IAD_LEVELS[2].desc }}</td>
              <td class="pt-score-col">{{ PAT_ROWS[0].score }}</td>
              <td class="legend-desc">{{ PAT_ROWS[0].irritant }}</td>
              <td class="legend-desc">{{ PAT_ROWS[0].time }}</td>
              <td class="legend-desc">{{ PAT_ROWS[0].perineum }}</td>
              <td class="legend-desc">{{ PAT_ROWS[0].influence }}</td>
            </tr>
            <tr class="legend-row">
              <td class="pt-score-col">{{ PAT_ROWS[1].score }}</td>
              <td class="legend-desc">{{ PAT_ROWS[1].irritant }}</td>
              <td class="legend-desc">{{ PAT_ROWS[1].time }}</td>
              <td class="legend-desc">{{ PAT_ROWS[1].perineum }}</td>
              <td class="legend-desc">{{ PAT_ROWS[1].influence }}</td>
            </tr>
            <tr class="legend-row">
              <td class="pt-score-col">{{ PAT_ROWS[2].score }}</td>
              <td class="legend-desc">{{ PAT_ROWS[2].irritant }}</td>
              <td class="legend-desc">{{ PAT_ROWS[2].time }}</td>
              <td class="legend-desc">{{ PAT_ROWS[2].perineum }}</td>
              <td class="legend-desc">{{ PAT_ROWS[2].influence }}</td>
            </tr>
          </thead>
          <tbody>
            <!-- 流式分页：一页放满才翻页（整行原子不跨页拆行）；null=末页空白补白行 -->
            <tr class="data-row" *ngFor="let r of page.rows" [attr.data-row-key]="r ? r.time : ''">
              <td class="date-cell">
                <span class="dt-date">{{ r ? fmtDate(r.time) : '' }}</span>
                <span class="dt-time">{{ r ? fmtTime(r.time) : '' }}</span>
              </td>
              <td>{{ r ? iadCheck(r, 1) : '' }}</td>
              <td>{{ r ? iadCheck(r, 2) : '' }}</td>
              <td>{{ r ? iadCheck(r, 3) : '' }}</td>
              <td class="pt-score-col"></td>
              <td>{{ r && r.irritantType !== null ? r.irritantType : '' }}</td>
              <td>{{ r && r.stimulationTime !== null ? r.stimulationTime : '' }}</td>
              <td>{{ r && r.perineum !== null ? r.perineum : '' }}</td>
              <td>{{ r && r.influenceFactor !== null ? r.influenceFactor : '' }}</td>
              <td class="total-col">{{ r && r.total !== null ? r.total : '' }}</td>
              <td class="measure-col">{{ r ? r.measures.join('、') : '' }}</td>
              <td class="sign-col">{{ r ? (r.signName || '') : '' }}</td>
            </tr>
          </tbody>
        </table>

        <!-- 备注与审核护士签名仅末页展示（与 Braden 压疮评估单一致）。
             footnoteLevel 0~3 备注块压缩级别：数据少、备注放不下会把尾行挤到新页时自动缩小省页 -->
        <div class="footnote-wrap" *ngIf="page.index === pages.length">
          <div class="iad-footnote" [class.lv1]="footnoteLevel >= 1" [class.lv2]="footnoteLevel >= 2" [class.lv3]="footnoteLevel >= 3">
            <div class="footnote-title">备注：</div>
            <div class="fn">1、IAD分类：对应栏内打"√"；IAD 0级患者，每日评估1次，对于1级、2级患者，每日评估2次。</div>
            <div class="fn">2、PAT量表采用 Likert 3 点计分法，各部分评分最佳至最差为 1~3 分；总分 4~12 分，4~6 分为低风险，7~12 分为高风险。</div>
            <div class="fn">3、PAT量表中相关影响因素有：低蛋白、使用抗生素、管饲饮食、艰难梭状芽孢杆菌、其他。</div>
            <div class="fn">4、护理措施：</div>
            <div class="fn fn-para">{{ MEASURE_PARAGRAPH }}</div>
          </div>
          <div class="review-sign">审核护士签名：{{ auditorName || '__________' }}</div>
        </div>
        <div class="sheet-pageno">第 {{page.index}} 页</div>
      </section>
    </ng-container>
  `,
  styles: [`
    :host{display:block;background:#f0f2f5;height:100vh;overflow:auto}
    .toolbar{display:flex;justify-content:flex-end;align-items:center;padding:10px 16px;background:#fff;border-bottom:1px solid #eee;position:sticky;top:0;z-index:50}
    .toolbar-right{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:flex-end}
    .btn{padding:5px 16px;border:1px solid #1890ff;background:#1890ff;color:#fff;border-radius:4px;cursor:pointer}
    .loading{padding:16px;font-family:'SimSun','宋体',serif}
    .sheet-hidden{display:none}

    .auditor-field{display:flex;align-items:center}
    .auditor-label{font-family:'SimSun','宋体',serif;font-size:14px;white-space:nowrap}
    .auditor-combo{position:relative;display:inline-block}
    .auditor-input{padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-size:14px;width:150px}
    .auditor-menu{position:absolute;top:100%;left:0;right:0;margin:2px 0 0;padding:4px 0;list-style:none;max-height:240px;overflow-y:auto;background:#fff;border:1px solid #d9d9d9;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.15);z-index:100}
    .auditor-opt{padding:5px 10px;font-size:14px;cursor:pointer;white-space:nowrap}
    .auditor-opt:hover{background:#f0f7ff} .empty-opt{color:#999} .no-opt{color:#999;cursor:default}

    .sheet{box-sizing:border-box;width:297mm;min-height:210mm;margin:16px auto;padding:7mm 10mm;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.15);position:relative;color:#000}
    .sheet-head{text-align:center;padding-bottom:2px}
    .title-line{font-family:'SimHei','黑体',sans-serif;font-weight:700;font-size:20pt;line-height:1.3}
    .patient-info-row{display:flex;align-items:center;width:100%;gap:12px;font-family:'SimSun','宋体',serif;font-size:11pt;font-weight:400;white-space:nowrap;margin:2px 0 4px;color:#000;text-align:left}
    .info-item{flex:0 0 auto;white-space:nowrap}
    .info-item b{font-weight:700}
    .diagnosis-item{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}

    .record-table{width:100%;border-collapse:collapse;table-layout:fixed;font-family:'SimSun','宋体',serif;font-size:12px;font-weight:400;font-style:normal;color:#000}
    .record-table th,.record-table td{box-sizing:border-box;border:1px solid #000;text-align:center;vertical-align:middle;padding:2px 1px;height:32px;overflow:hidden;font-family:'SimSun','宋体',serif;font-size:12px;font-weight:400;font-style:normal;color:#000}
    .record-table th{background:transparent;font-weight:700;line-height:1.25}
    .record-table td{line-height:1.25}
    .date-col{width:74px;min-width:74px;white-space:nowrap;word-break:normal}
    .iad-sub{width:auto}
    .pt-score-col{width:28px;min-width:28px}
    .total-col{width:36px;min-width:36px}
    .measure-col{width:76px;min-width:76px}
    .sign-col{width:48px;min-width:48px}

    /* 图例 */
    .legend-row td{font-weight:700;color:#000}
    .legend-desc{text-align:left;padding-left:4px;line-height:1.25}

    /* 日期两行 */
    .dt-date,.dt-time{display:block;white-space:nowrap;word-break:normal;text-align:center;line-height:1.25}

    /* 备注：仅末页展示；footnoteLevel 1~3 逐级压缩（字号/行高减小、A~I 图例 2/3 栏），放不下才缩 */
    .footnote-wrap{box-sizing:border-box;width:100%;padding:2px 0 6mm;color:#000}
    .iad-footnote{box-sizing:border-box;width:100%;padding:0 2px;font-family:'SimSun','宋体',serif;font-size:9.5pt;font-weight:400;line-height:1.3;text-align:left}
    .iad-footnote .footnote-title{font-weight:700}
    .iad-footnote .fn{margin:0;padding-left:2em;text-indent:-2em}
    /* 护理措施 A~I 为一段连续文字，整体齐左不悬挂 */
    .iad-footnote .fn-para{padding-left:0;text-indent:0}
    .iad-footnote.lv1{font-size:9pt;line-height:1.24}
    .iad-footnote.lv2{font-size:8.5pt;line-height:1.2}
    .iad-footnote.lv3{font-size:8pt;line-height:1.15}
    .review-sign{margin:3mm 0 0;text-align:right;font-family:'SimSun','宋体',serif;font-size:13pt;font-weight:400;padding-right:6px}
    .sheet-pageno{position:absolute;right:0;bottom:35px;left:0;width:auto;margin:0;padding:0;box-sizing:border-box;text-align:center;font-family:'SimSun','宋体',serif;font-size:12pt;font-weight:400;line-height:1;color:#000;white-space:nowrap;pointer-events:none;z-index:20}

    @media screen{.sheet{width:calc(100vw - 32px);max-width:297mm;min-width:980px;zoom:1!important;transform:none!important}}
    @media print{
      @page{size:A4 landscape;margin:0}
      :host{display:block;width:297mm;height:auto;margin:0!important;padding:0!important;overflow:visible}
      .no-print{display:none!important}
      .sheet-hidden{display:none!important}
      .sheet{box-sizing:border-box;width:297mm!important;min-width:0!important;max-width:297mm!important;height:209mm!important;min-height:209mm!important;max-height:209mm!important;margin:0!important;padding:7mm 10mm!important;overflow:hidden!important;zoom:1!important;transform:none!important;filter:none!important;box-shadow:none!important;page-break-before:auto;page-break-inside:avoid;break-inside:avoid-page;page-break-after:always;break-after:page}
      .sheet.last-sheet{page-break-after:auto!important;break-after:auto!important}
      .record-table th,.record-table td{overflow:hidden}
    }
  `],
})
export class IadScoreComponent implements OnInit, OnDestroy {
  private readonly API_SCORE = '/api/v1/icu/score/listByPid';
  private readonly API_HOSPITAL = '/api/v1/config/hospital';
  private readonly API_ACCOUNT = '/api/v1/icu/accounts/listByIds';
  private readonly API_ACCOUNT_ALL = '/api/v1/icu/accounts';

  // 供模板引用
  readonly IAD_LEVELS = IAD_LEVELS;
  readonly PAT_ROWS = PAT_ROWS;
  /** 备注 4 正文：护理措施 A~I 合并为一段连续文字（统一版式） */
  readonly MEASURE_PARAGRAPH = MEASURE_LEGEND.join('');

  /** 每页新起数据行数上限（中间页满槽 12；末页可少于 12 但不截断） */
  readonly maxRowsPerPageMultiPage = 12;
  /** 空白表单模板行数（仅无任何数据时单页补 8 行；有数据时不补空白行） */
  readonly maxRowsLastPage = 8;
  /** 最小行高（数据行内容超高时按实际高度撑开） */
  readonly baseRowHeight = 32;

  /** 每行实测高度（key=行 time，px）；未测量到的行按 baseRowHeight */
  private rowHeights = new Map<string, number>();
  /** 每页留给数据行的总高度（px）；未测量时为 Infinity，退化为纯行数分页 */
  private availableRowsPx = Number.POSITIVE_INFINITY;
  /** 末页页脚（备注/审核签名）占高（px，0 级未压缩）；仅末页预留 */
  private footerReservedPx = 0;
  /** 备注块 0~3 级压缩实测占高（px），下标=压缩级别 */
  private footnoteLevelHeights: number[] = [];
  /** 备注压缩级别：0=原大小，1~3=逐级缩小（字号/行高减小、图例分栏）。
   *  备注太高会把末页数据行挤到新页；分页时逐级试算，选总页数最少的最小压缩级别（放得下就不缩） */
  footnoteLevel = 0;

  loading = true;
  patient: any = null;
  hospitalName = '重钢总医院';
  diagnosisDisplay = '';
  age: number | null = null;

  rows: IadRow[] = [];
  pages: RenderPage[] = [];
  selectedPrintPages: number[] = [];
  isViewerMode = false;

  // 审核者签名
  auditorName = ''; auditorId = ''; auditorQuery = ''; auditorOpen = false;
  accountList: { accountId: string; accountName: string }[] = [];
  private blurTimer: any = null;
  private readonly AUDITOR_BLOCK = ['工程师', '美康', '他科带入', '外院带入', '其他账号'];

  private pid = '';
  private destroy$ = new Subject<void>();

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
      tap(({ pid }) => { if (pid !== this.pid) this.pid = pid; }),
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

  ngOnDestroy(): void {
    if (this.blurTimer) { clearTimeout(this.blurTimer); this.blurTimer = null; }
    this.destroy$.next();
    this.destroy$.complete();
  }

  private resetForm(): void {
    this.rows = [];
    this.pages = [];
    this.selectedPrintPages = [];
    this.diagnosisDisplay = '';
    this.age = null;
    this.auditorName = '';
    this.auditorId = '';
    this.auditorQuery = '';
    this.auditorOpen = false;
    this.cdr.detectChanges();
  }

  private loadFromServer(pid: string) {
    this.loading = true;
    return this.http
      .get<ScoreRecord[]>(this.API_SCORE, { params: { pid, scoreType: SCORE_TYPE } })
      .pipe(
        tap((res) => {
          const list = Array.isArray(res) ? res : res ? [res as any] : [];
          this.recordsToRows(list.filter(r => r && r.valid === true && r.scoreType === SCORE_TYPE));
        }),
        finalize(() => { this.loading = false; this.cdr.detectChanges(); }),
      );
  }

  private recordsToRows(records: ScoreRecord[]): void {
    const rows: IadRow[] = records
      .filter(r => !!r.time)
      .map(r => {
        const s = r.incontinenceScore || {};
        return {
          time: r.time!,
          iad: this.num(s.iad),
          irritantType: this.num(s.irritantType),
          stimulationTime: this.num(s.stimulationTime),
          perineum: this.num(s.perineum),
          influenceFactor: this.num(s.influenceFactor),
          total: this.num(r.total),
          conclusion: r.conclusion || '',
          measures: this.parseMeasures(r.nurseMeasureList),
          signUserId: r.inputUserId,
          signName: r.inputUser || '',
        } as IadRow;
      })
      .sort((a, b) => this.ts(a.time) - this.ts(b.time));
    this.rows = rows;
    this.paginate();
    this.resolveSignerNames(rows);
    this.cdr.detectChanges();
  }

  private resolveSignerNames(rows: IadRow[]): void {
    const userIds = [...new Set(rows.map(r => r.signUserId).filter(Boolean) as string[])];
    if (!userIds.length) return;
    this.http.get<any[]>(this.API_ACCOUNT, { params: { ids: userIds.join(',') } })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (accounts) => {
          const nameMap = new Map<string, string>();
          if (Array.isArray(accounts)) {
            for (const a of accounts) {
              const aid = a?._id || a?.id;
              if (aid) nameMap.set(String(aid), a?.trueName || '');
            }
          }
          for (const row of this.rows) {
            if (row.signUserId && nameMap.has(row.signUserId)) {
              row.signName = nameMap.get(row.signUserId) || row.signName;
            }
          }
          this.paginate();
          this.cdr.detectChanges();
        },
        error: () => {},
      });
  }

  /** iad 值命中该列（level=1→0级、2→1级、3→2级）则打√ */
  iadCheck(row: IadRow | null, level: number): string {
    if (!row) return '';
    return row.iad === level ? '√' : '';
  }

  private parseMeasures(list?: NurseMeasure[]): string[] {
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const m of list) {
      if (!m || m.value !== true) continue;
      const ch = (m.code || '').trim().charAt(0).toUpperCase();
      if (MEASURE_CODES.includes(ch)) out.push(ch);
    }
    return [...new Set(out)].sort();
  }

  /* ============================= 分页（Braden 模式：实测行高流式装页 + 备注自适应压缩） ============================= */

  private paginate(): void {
    // 第一遍：按既有行高切页渲染，保证每行都渲染过一次，量得到真实行高
    this.paginateByHeight();
    this.cdr.detectChanges();
    // 第二遍：实测行高（图例/措施换行会撑高行）与备注各级压缩高度后重切
    if (this.measureRealHeights()) {
      this.paginateByHeight();
      this.cdr.detectChanges();
    }
  }

  /** 单行高度：实测值兜底最小行高 */
  private rowHeight(row: IadRow): number {
    const h = this.rowHeights.get(row.time);
    return h && h > 0 ? Math.max(h, this.baseRowHeight) : this.baseRowHeight;
  }

  /** 备注块在该压缩级别的占高（px）；未实测到该级时退化为 0 级高度 */
  private footerHeightFor(level: number): number {
    const h = this.footnoteLevelHeights[level];
    return h && h > 0 ? h : this.footerReservedPx;
  }

  /** 末页数据行可用高度 = 行区总高 - 该级备注占高（备注/审核签名仅末页展示） */
  private availLastFor(level: number): number {
    if (!Number.isFinite(this.availableRowsPx)) return Number.POSITIVE_INFINITY;
    return Math.max(this.availableRowsPx - this.footerHeightFor(level), this.baseRowHeight);
  }

  /** 贪心装页（整行原子不跨页拆行；每页数据行 ≤12），末页放不下尾行时移到新页 */
  private packPages(availLast: number): (IadRow | null)[][] {
    const avail = Number.isFinite(this.availableRowsPx)
      ? Math.max(this.availableRowsPx, this.baseRowHeight)
      : Number.POSITIVE_INFINITY;
    const pages: (IadRow | null)[][] = [];
    let cur: (IadRow | null)[] = [];
    let used = 0;
    for (const row of this.rows) {
      const h = this.rowHeight(row);
      if (cur.length && (used + h > avail + 0.5 || cur.length >= this.maxRowsPerPageMultiPage)) {
        pages.push(cur);
        cur = [];
        used = 0;
      }
      cur.push(row);
      used += h;
    }
    if (cur.length) pages.push(cur);
    // 末页为「备注/审核签名」预留高度；放不下时把尾部行移到新页
    this.fitLastPageFooter(pages, availLast);
    return pages;
  }

  /** 按行高切页 + 备注自适应压缩：备注太高会把末页数据行挤到新页（中间页只剩几行还留大片空白），
   *  逐级试算 0~3 级备注高度，选总页数最少的最小压缩级别——放得下就不缩。
   *  未测量时 availableRowsPx=Infinity、行高=32px，退化为纯行数分页。 */
  private paginateByHeight(): void {
    if (!this.rows.length) {
      // 空白表单模板：单页 8 行空白（仅无任何记录时，非补白）；有数据时一律不补空白行
      const blanks: (IadRow | null)[] = [];
      while (blanks.length < this.maxRowsLastPage) blanks.push(null);
      this.footnoteLevel = 0;
      this.pages = [{ index: 1, rows: blanks, diagnosis: this.diagnosisForRows([]) }];
      this.normalizeSelectedPrintPages(this.pages.length);
      return;
    }

    // 逐级试算：0~3 级备注高度各切一次，取总页数最少者（并列取压缩最小的级别）——
    // 放得下就不缩，放不下才缩到刚好省掉一整页
    const trials = [0, 1, 2, 3].map(level => ({ level, pages: this.packPages(this.availLastFor(level)) }));
    const best = trials.reduce((a, b) => (b.pages.length < a.pages.length ? b : a));
    this.footnoteLevel = best.level;

    this.pages = best.pages.map((rows, i) => ({
      index: i + 1,
      rows,
      diagnosis: this.diagnosisForRows(rows.filter((r): r is IadRow => !!r)),
    }));
    this.normalizeSelectedPrintPages(this.pages.length);
  }

  /** 末页放不下（备注/审核签名占高后）时，把尾部行移到后续页，直到末页放得下 */
  private fitLastPageFooter(pages: (IadRow | null)[][], availLast: number): void {
    if (!Number.isFinite(availLast)) return;
    let guard = 0;
    while (pages.length && guard++ < 30) {
      const lastPage = pages[pages.length - 1];
      let lastUsed = lastPage.reduce((sum, r) => sum + (r ? this.rowHeight(r) : this.baseRowHeight), 0);
      if (lastUsed <= availLast + 0.5) break;

      const leftover: (IadRow | null)[] = [];
      while (lastPage.length && lastUsed > availLast + 0.5) {
        const row = lastPage.pop()!;
        leftover.unshift(row);
        lastUsed -= row ? this.rowHeight(row) : this.baseRowHeight;
      }
      if (!lastPage.length) {
        // 单行就超过末页可用高度：整行强放交给 CSS 裁剪
        lastPage.push(...leftover);
        break;
      }
      pages.push(leftover);
    }
  }

  /** 从已渲染的真实 DOM 实测行高与固定区高度；量不到返回 false（保留上次结果）。
   *  行高只取决于内容与列宽，与分页无关，所以任意一页量到的行高都有效。 */
  private measureRealHeights(): boolean {
    const root = this.host.nativeElement as HTMLElement;
    const head = root.querySelector('.sheet-head') as HTMLElement | null;
    const thead = root.querySelector('.record-table thead') as HTMLElement | null;
    if (!head || !thead) return false;

    const ppm = this.pxPerMm();
    // 打印页数据行可用高度：A4 横向 209mm - 上下 padding 7mm×2 - 固定区 - 余量
    const contentPx = (209 - 14) * ppm;
    // 余量须盖过页码带：.sheet-pageno 定位 bottom:35px、12pt/行高1，占 [35,51]px，
    // 顶边约在纸面底缘上方 13.5mm，侵入内容区约 6.5mm。余量取 7.5mm 使表格底边
    // 停在页码上方约 1mm（与 Braden 一致）。
    const safetyPx = 7.5 * ppm;
    const fixedPx = head.getBoundingClientRect().height + thead.getBoundingClientRect().height;
    const available = contentPx - fixedPx - safetyPx;
    if (!(available > 0)) return false;
    this.availableRowsPx = available;

    // 页脚整体（备注 + 审核签名，.footnote-wrap 一体含 padding）逐级实测：
    // 切换 footnoteLevel 0~3 重渲染后量高度，供分页按「总页数最少」选最小压缩级别
    const wrap = root.querySelector('.footnote-wrap') as HTMLElement | null;
    if (wrap) {
      const prevLevel = this.footnoteLevel;
      const heights: number[] = [];
      for (let level = 0; level <= 3; level++) {
        this.footnoteLevel = level;
        this.cdr.detectChanges();
        const h = wrap.getBoundingClientRect().height;
        heights[level] = h > 0 ? h : (this.footnoteLevelHeights[level] || 0);
      }
      this.footnoteLevel = prevLevel;
      this.cdr.detectChanges();
      if (heights[0] > 0) {
        this.footnoteLevelHeights = heights;
        this.footerReservedPx = heights[0];
      }
    }

    const map = new Map<string, number>();
    root.querySelectorAll('tr[data-row-key]').forEach(tr => {
      const key = tr.getAttribute('data-row-key');
      if (!key) return;
      const h = (tr as HTMLElement).getBoundingClientRect().height;
      if (h <= 0) return; // 被打印选择隐藏的页量不到，沿用旧值
      map.set(key, Math.max(h, this.baseRowHeight));
    });
    for (const row of this.rows) {
      if (!map.has(row.time)) {
        const old = this.rowHeights.get(row.time);
        map.set(row.time, Math.max(old || this.baseRowHeight, this.baseRowHeight));
      }
    }
    this.rowHeights = map;
    return true;
  }

  /** CSS px 每 mm（用探针测量，兼容浏览器缩放/zoom） */
  private pxPerMm(): number {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:-99999px;width:100mm;height:1px;visibility:hidden';
    document.body.appendChild(probe);
    const ppm = probe.getBoundingClientRect().width / 100;
    document.body.removeChild(probe);
    return ppm > 0 ? ppm : 96 / 25.4;
  }

  /** 页诊断 = 该页第一条数据所在时间区间的诊断 */
  private diagnosisForRows(rows: IadRow[]): string {
    return resolvePageDiagnosis(this.patient, rows[0], ['time'], this.diagnosisDisplay);
  }

  isPrintPageSelected(pageNumber: number, totalPages = this.pages.length): boolean {
    return shouldPrintPage(pageNumber, this.selectedPrintPages, totalPages);
  }
  private normalizeSelectedPrintPages(totalPages: number): void {
    const normalized = normalizePrintPages(this.selectedPrintPages, totalPages);
    this.selectedPrintPages = (normalized.length === totalPages && totalPages > 0) ? [] : normalized;
  }

  print(): void { window.print(); }

  private loadHospitalName(): void {
    this.http.get<any>(this.API_HOSPITAL).subscribe({
      next: res => { const name = res?.hospitalName || res?.name || res?.data?.hospitalName || res?.data?.name; if (name) this.hospitalName = String(name); },
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
  onAuditorOptionMouseDown(event: MouseEvent, account: { accountId: string; accountName: string }): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectAuditor(account);
  }
  onClearAuditorMouseDown(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.clearAuditor();
  }
  selectAuditor(a: { accountId: string; accountName: string }): void { this.auditorName = a.accountName; this.auditorId = a.accountId; this.auditorQuery = a.accountName; this.auditorOpen = false; this.saveAuditor(); }
  clearAuditor(): void { this.auditorName = ''; this.auditorId = ''; this.auditorQuery = ''; this.auditorOpen = false; this.saveAuditor(); }
  private saveAuditor(): void {
    if (!this.pid) return;
    this.http.post(API_EXTRA_SAVE, {
      pid: this.pid, formCode: FORM_CODE,
      auditorId: this.auditorId, auditorName: this.auditorName,
    }).subscribe({
      next: () => {},
      error: (e) => console.error('[iadForm] saveAuditor failed', { formCode: FORM_CODE, pid: this.pid, auditorId: this.auditorId, error: e }),
    });
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
        const seen = new Set<string>();
        this.accountList = (Array.isArray(list) ? list : [])
          .map(a => ({ accountId: a?.accountId || a?.username || a?.id || a?._id || '', accountName: a?.accountName || a?.trueName || a?.name || '' }))
          .filter(a => a.accountName)
          .filter(a => {
            const key = (a.accountId || '') + '|' + a.accountName;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        this.cdr.detectChanges();
      },
      error: (e) => console.error('[iadForm] loadAccountList failed', e),
    });
  }

  fmtDate(v?: string): string { return formatShanghaiDate(v) || ''; }
  fmtTime(v?: string): string { return formatShanghaiTime(v) || ''; }

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
    const m = now.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
    return age;
  }

  private formatDiagnosis(diagnosis?: string): string {
    return firstDiagnosisSegment(diagnosis, 'legacy');
  }

  private num(v: any): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  private ts(v?: string): number { return databaseTimeValue(v); }
}

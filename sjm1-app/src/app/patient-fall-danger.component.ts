/**
 * 跌倒/坠床风险评估及预防措施护理记录单（Morse） —— Angular 组件
 * 访问路径：/form/patientFallDangerForm
 */
import { HttpClient } from '@angular/common/http';
import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit } from '@angular/core';
import { of, Subject } from 'rxjs';
import { catchError, distinctUntilChanged, filter, finalize, map, switchMap, takeUntil, tap } from 'rxjs/operators';
import { HostPatientService } from './services/host-patient.service';
import { IcuFormViewerContextService } from './icu-form-viewer-context.service';
import { databaseTimeValue, formatShanghaiDate, formatShanghaiTime } from './form-date.util';
import { measureRowCapacity } from './form-measure.util';
import { normalizePrintPages, shouldPrintPage } from './form-print-pages.util';
import { firstDiagnosisSegment, resolvePageDiagnosis } from './diagnosis-history.util';
import { DiagnosisHistoryService } from './diagnosis-history.service';

const SCORE_TYPE = 'patientFallDangerLJRMYY';
const FORM_CODE = 'patientFallDangerForm';

/** 临床判定法（布尔 → true 打√） */
const CLINICAL = [
  { key: 'hunmiOntanhaun', label: '昏迷或完全瘫痪' },
  { key: 'preHospitalization', label: '过去24小时曾有手术麻醉史' },
  { key: 'sylzys', label: '使用两种及以上镇静安眠药物' },
  { key: 'age', label: '年龄≥80岁' },
  { key: 'thisHospitalization', label: '住院前6个月/住院期间有跌倒经历' },
  { key: 'exist', label: '存在步态不稳、关节/肌肉疼痛、视觉障碍等' },
  { key: 'sixHours', label: '6h内使用过以上镇静、安眠药物' },
];

/** Morse 评分量表（数字 → 按分值列打√） */
const MORSE = [
  { field: 'fallHistory', item: '跌倒史', opts: [{ label: '有', score: 25 }, { label: '无', score: 0 }] },
  { field: 'otherDiagnosis', item: '超过一个<br>疾病诊断', opts: [{ label: '有', score: 15 }, { label: '无', score: 0 }] },
  { field: 'useWalkTool', item: '使用助行器', opts: [{ label: '没有/卧床/轮椅/护士帮助', score: 0 }, { label: '拐杖/手杖/助行器', score: 15 }, { label: '依扶家具', score: 30 }] },
  { field: 'intravenousInjection', item: '静脉输液', opts: [{ label: '是', score: 20 }, { label: '否', score: 0 }] },
  { field: 'walk', item: '步态', opts: [{ label: '正常/卧床/轮椅', score: 0 }, { label: '虚弱', score: 10 }, { label: '受损', score: 20 }] },
  { field: 'mentality', item: '精神状态', opts: [{ label: '正确评估自我能力', score: 0 }, { label: '高估/忘记限制', score: 15 }] },
];

const MEASURE_LEGEND = [
  '1、常规措施：A 帮助患者熟悉病区环境。B 保持病房整洁无障碍物，光线明亮。C 病床/轮椅刹车固定好。D 床边桌、呼叫器置于患者健侧伸手可及。E 夜间开启地灯。F 协助患者日常生活所需。G 地面湿滑时放置安全警示牌。H 卧床时正确使用床挡。I 保持走道通畅。J 密切观察病情。',
  '2、选择性措施：K 教会患者正确使用助行设备。L 教会正确使起卧方法。M 指导患者排便/排尿。N 指导患者穿着舒适鞋袜。O 告知患者及家属发生跌倒/坠床的危险因素和预防措施24h留陪。P 床旁悬挂跌倒警示牌。Q 评估结果告知护士长及主管医生。',
  '备注：评估频次：高风险≥2次/周，中风险≥1次/周；病人入院、转科时、病情发生变化、使用高跌倒风险药物、跌倒后、跌倒高风险患者出院前，应再次评估。',
];

interface FallRow {
  time: string;
  factor: Record<string, any>;
  total: number | null;
  risk: string;
  measures: string;
  signUserId?: string;
  signName?: string;
}
interface ScoreRecord {
  time?: string; scoreType?: string; total?: number; conclusion?: string; valid?: boolean;
  inputUserId?: string; inputUser?: string; nurseMeasureList?: any[]; patientFallDangerFactorV2?: Record<string, any>;
}
interface RenderPage { index: number; rows: FallRow[]; diagnosis?: string; }
interface FinalExtraData { id: string | null; result: string; resultDate: string; happened: '' | '是' | '否'; loaded: boolean; loading: boolean; }

@Component({
  standalone: false,
  selector: 'app-patient-fall-danger',
  template: `
    <div class="fall-form-wrapper" [class.viewer-mode]="isViewerMode">
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
          <button class="btn" (click)="onPrint()">打印</button>
        </div>
      </div>

      <div class="loading" *ngIf="loading">加载中…</div>

    <div class="sheet" *ngFor="let page of pages" [class.sheet-hidden]="!isPrintPageSelected(page.index)">
        <div class="sheet-head"><div class="title-line">{{hospitalName}}跌倒/坠床风险评估及预防措施护理记录单</div></div>

        <div class="patient-info-row">
          <span class="info-item"><b>科室：</b>{{patient?.dept || ''}}</span>
          <span class="info-item"><b>姓名：</b>{{patient?.name || ''}}</span>
          <span class="info-item"><b>床号：</b>{{patient?.hisBed ? (patient.hisBed.endsWith('床') ? patient.hisBed : patient.hisBed + '床') : ''}}</span>
          <span class="info-item"><b>住院号：</b>{{patient?.mrn || ''}}</span>
          <span class="info-item"><b>年龄：</b>{{age ?? ''}}</span>
          <span class="info-item"><b>性别：</b>{{genderText(patient?.gender)}}</span>
          <span class="info-item diagnosis-item"><b>诊断：</b>{{page.diagnosis || diagnosisDisplay}}</span>
        </div>

        <table class="record-table">
          <colgroup>
            <col class="date-col" />
            <col class="method-col" /><col class="method-col" />
            <col class="cond-col cond-narrow" />
            <col class="cond-col" /><col class="cond-col" /><col class="cond-col" />
            <col class="cond-col cond-wide" /><col class="cond-col cond-wide" />
            <col class="cond-col" />
            <col class="rowlabel-col" />
            <ng-container *ngFor="let m of MORSE">
              <col *ngFor="let o of m.opts" class="opt-col" [class.opt-wide]="o.label.includes('没有')" />
            </ng-container>
            <col class="total-col" />
            <col class="risk-col" />
            <col class="measure-col" />
            <col class="sign-col" />
          </colgroup>
          <thead>
            <!-- HR1 顶层分组 -->
            <tr class="header-row1">
              <th class="date-col" rowspan="4">日期/时间</th>
              <th colspan="2">适用方法</th>
              <th colspan="7">临床判定法</th>
              <th [attr.colspan]="morseLeafCount + 2">Morse 评分量表</th>
              <th class="risk-col vtext" rowspan="4">跌倒风险</th>
              <th class="measure-col" rowspan="4">预防措施</th>
              <th class="sign-col" rowspan="4">签名</th>
            </tr>
            <!-- HR2 项目行 -->
            <tr class="situation-row">
              <th class="method-col vtext" rowspan="3">临床判定法</th>
              <th class="method-col vtext" rowspan="3">Morse评分量表</th>
              <th class="cond-col cond-narrow vtext" rowspan="3">昏迷或完全瘫痪</th>
              <th colspan="2" [innerHTML]="'存在以下<br>情况之一'"></th>
              <th colspan="4">存在以下情况之一</th>
              <th class="rowlabel-col">项目</th>
              <th *ngFor="let m of MORSE" [attr.colspan]="m.opts.length" [innerHTML]="m.item"></th>
              <th class="total-col" rowspan="3">总分</th>
            </tr>
            <!-- HR3 评估行 -->
            <tr class="eval-row">
              <th class="cond-col vtext" rowspan="2">过去24小时曾有手术麻醉史</th>
              <th class="cond-col vtext" rowspan="2">使用两种及以<br>上镇静安眠药物</th>
              <th class="cond-col vtext" rowspan="2">年龄≥80岁</th>
              <th class="cond-col cond-wide vtext" rowspan="2">住院前6个月内有跌倒经历/住院期间此次有跌倒经历</th>
              <th class="cond-col cond-wide vtext" rowspan="2">存在步态不稳、关节疼痛、肌肉疼痛、视觉障碍等</th>
              <th class="cond-col cond-short vtext" rowspan="2">6h内使用过以上镇静、安眠药物</th>
              <th class="rowlabel-col">评估</th>
              <ng-container *ngFor="let m of MORSE">
                <th *ngFor="let o of m.opts" class="opt-col vtext" [class.opt-wide]="o.label.includes('没有')">{{ o.label }}</th>
              </ng-container>
            </tr>
            <!-- HR4 评分行 -->
            <tr class="score-row">
              <th class="rowlabel-col">评分</th>
              <ng-container *ngFor="let m of MORSE">
                <th *ngFor="let o of m.opts" class="score-col">{{ o.score }}</th>
              </ng-container>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let r of pagePaddedRows(page)">
              <td class="date-cell">
                <div class="dt-date">{{ r ? fmtDate(r.time) : '' }}</div>
                <div class="dt-time">{{ r ? fmtTime(r.time) : '' }}</div>
              </td>
              <td class="method-col">{{ r ? (clinicalUsed(r) ? '√' : '') : '' }}</td>
              <td class="method-col">{{ r ? (morseUsed(r) ? '√' : '') : '' }}</td>
              <td *ngFor="let c of CLINICAL; let i = index" [class.cond-narrow]="i===0" [class.cond-wide]="i===4||i===5">{{ r ? clinicalCheck(r, c.key) : '' }}</td>
              <td class="rowlabel-col"></td>
              <ng-container *ngFor="let m of MORSE">
                <td *ngFor="let o of m.opts" [class.opt-wide]="o.label.includes('没有')">{{ r ? morseCheck(r, m.field, o.score) : '' }}</td>
              </ng-container>
              <td>{{ r && showTotal(r) ? r.total : '' }}</td>
              <td>{{ r ? r.risk : '' }}</td>
              <td class="measure-cell">{{ r ? r.measures : '' }}</td>
              <td>{{ r ? (r.signName || '') : '' }}</td>
            </tr>
          </tbody>
        </table>

        <div class="result-line" *ngIf="page.index === pages.length">
          <label class="rl-item">
            <span>结果：</span>
            <input class="result-combo screen-only" type="text" list="fall-result-options" [(ngModel)]="finalExtra.result" (ngModelChange)="scheduleSaveFinalExtra()" placeholder="请选择或输入" autocomplete="off" />
            <datalist id="fall-result-options"><option value="出院"></option><option value="死亡"></option><option value="转出"></option></datalist>
            <span class="fill-val print-only">{{ finalExtra.result }}</span>
          </label>
          <label class="rl-item">
            <span>时间：</span>
            <input class="result-datetime screen-only" type="datetime-local" [(ngModel)]="finalExtra.resultDate" (ngModelChange)="scheduleSaveFinalExtra()" />
            <span class="fill-val print-only">{{ finalExtra.resultDate ? finalExtra.resultDate.replace('T', ' ') : '' }}</span>
          </label>
          <div class="rl-item">
            <span>是否跌倒：</span>
            <label class="screen-only"><input type="radio" name="fall-result-happened" [checked]="finalExtra.happened === '是'" (click)="toggleHappened($event, '是')" /> 是</label>
            <label class="screen-only"><input type="radio" name="fall-result-happened" [checked]="finalExtra.happened === '否'" (click)="toggleHappened($event, '否')" /> 否</label>
            <span class="print-only">是 {{ finalExtra.happened === '是' ? '☑' : '☐' }}&nbsp;&nbsp;否 {{ finalExtra.happened === '否' ? '☑' : '☐' }}</span>
          </div>
        </div>

        <div class="footnote">
          <div class="fn-title">预防跌倒护理措施：</div>
          <div class="fn" *ngFor="let t of MEASURE_LEGEND">{{ t }}</div>
        </div>

        <div class="review-sign" *ngIf='pages.length==page.index'>审核护士签名：{{ auditorName || '__________' }}</div>
        <div class="sheet-pageno">第 {{page.index}} 页</div>
      </div>
    </div>
  `,
  styles: [`
    :host { display:block; background:#f0f2f5; height:100vh; overflow:auto; }
    .toolbar { display:flex; justify-content:flex-end; align-items:center; padding:10px 16px; background:#fff; border-bottom:1px solid #eee; position:sticky; top:0; z-index:50; }
    .toolbar-right { display:flex; align-items:center; gap:12px; flex-wrap:wrap; justify-content:flex-end; }
    .page-select, .auditor-label { font-family:'SimSun','宋体',serif; font-size:14px; white-space:nowrap; }
    .auditor-field { display:flex; align-items:center; }
    .auditor-combo { position:relative; display:inline-block; }
    .auditor-input { padding:4px 8px; border:1px solid #ccc; border-radius:4px; font-size:14px; width:150px; }
    .auditor-menu { position:absolute; top:100%; left:0; right:0; margin:2px 0 0; padding:4px 0; list-style:none; max-height:240px; overflow-y:auto; background:#fff; border:1px solid #d9d9d9; border-radius:4px; box-shadow:0 2px 8px rgba(0,0,0,0.15); z-index:100; }
    .auditor-opt { padding:5px 10px; font-size:14px; cursor:pointer; white-space:nowrap; }
    .auditor-opt:hover { background:#f0f7ff; } .empty-opt { color:#999; } .no-opt { color:#999; cursor:default; }
    .btn { padding:5px 16px; border:1px solid #1890ff; background:#1890ff; color:#fff; border-radius:4px; cursor:pointer; }
    .loading { padding:16px; font-family:'SimSun','宋体',serif; }
    .sheet-hidden { display:none; }

    /* 调阅模式：禁用所有输入控件 */
    :host(.viewer-mode) input:not([type="hidden"]),
    :host(.viewer-mode) select,
    :host(.viewer-mode) textarea {
      pointer-events: none;
      background: #f5f5f5 !important;
      color: #666 !important;
      cursor: not-allowed !important;
      border-color: #e0e0e0 !important;
    }
    :host(.viewer-mode) input[type="radio"],
    :host(.viewer-mode) input[type="checkbox"] {
      pointer-events: none;
      opacity: 0.6;
    }
    :host(.viewer-mode) .screen-only { display: none !important; }
    :host(.viewer-mode) .print-only { display: block !important; }

    .sheet { box-sizing:border-box; width:397mm; min-height:210mm; margin:16px auto; padding:8mm 10mm; background:#fff; box-shadow:0 2px 8px rgba(0,0,0,0.15); position:relative; color:#000; }
    .sheet-head { text-align:center; padding-bottom:6px; }
    .title-line { font-family:'SimHei','黑体',sans-serif; font-weight:700; font-size:24pt; line-height:1.35; }
    .patient-info-row { display:flex; align-items:center; width:100%; gap:14px; font-family:'SimSun','宋体',serif; font-size:13pt; font-weight:400; white-space:nowrap; margin:2px 0; color:#000; }
    .info-item { flex:0 0 auto; white-space:nowrap; }
    .info-item b, .info-item strong { font-family:inherit; font-size:inherit; font-style:inherit; line-height:inherit; color:inherit; font-weight:700; }
    .diagnosis-item { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; }

    .record-table { width:100%; border-collapse:collapse; font-family:'SimSun','宋体',serif; font-size:9pt; table-layout:fixed; }
    .record-table th,.record-table td { border:1px solid #000; text-align:center; padding:1px; word-break:break-all; vertical-align:middle; overflow:hidden; }
    .record-table th { height:60px; } /* 表头默认行高 */
    .header-row1 th { height:30px; } /* 适用方法/临床判定法/Morse评分量表 行高减半 */
    .method-col { height:15px; } /* 适用方法竖排文字行高-30px */
    .situation-row th { height:30px; } /* "存在以下情况之一"行高+10px */
    .eval-row th { height:70px; } /* 评估行高度-100px */
    .score-row th { height:45px; } /* 评分行高度-15px */
    .cond-short { height:40px; } /* 6h内使用过以上镇静、安眠药物 高-20px */
    .record-table td { height:26px; }
    /* 竖排文字：随行高自适应，从左往右换行；text-orientation:upright 保持字母数字直立；支持多列显示 */
    .vtext { writing-mode:vertical-lr; text-orientation:upright; white-space:normal; line-height:1.08; letter-spacing:0.5px; font-family:'SimSun','宋体',serif; font-size:9pt; font-weight:700; overflow:hidden; }
    .date-col { width:82px; min-width:82px; }
    .method-col { width:17px; } /* 临床判定法/Morse评分量表：-10px 后再各+5px */
    .cond-col { width:26px; }
    .cond-narrow { width:16px; } /* 昏迷或完全瘫痪 -10px */
    .cond-wide { width:36px; } /* 住院前6个月内有跌倒经历/存在步态不稳 +10px */
    .rowlabel-col { width:16px; writing-mode:vertical-rl; text-orientation:upright; white-space:nowrap; font-family:'SimSun','宋体',serif; font-size:9pt; letter-spacing:1px; }
    .opt-col { width:24px; height:50px; writing-mode:vertical-lr; text-orientation:upright; font-family:'SimSun','宋体',serif; font-size:9pt; font-weight:700; color:#000; }      /* 评估行：压缩行高-20px，容纳长竖排选项，从左往右 */
    .opt-wide { width:34px; } /* 没有/卧床/轮椅/护士帮助 +10px */
    .score-col { width:24px; font-family:'SimSun','宋体',serif; font-size:9pt; }
    .total-col { width:22px; } .risk-col { width:44px; } .measure-col { width:92px; } .sign-col { width:44px; }
    .dt-date,.dt-time { display:block; white-space:nowrap; word-break:normal; text-align:center; line-height:1.2; }
    .record-table th.date-col,
    .record-table td.date-col { white-space:nowrap; word-break:normal; overflow:hidden; }
    .measure-cell { text-align:left; padding-left:4px; letter-spacing:2px; }

    .result-line { display:flex; flex-wrap:wrap; gap:80px; margin-top:8px; align-items:center; font-family:'SimSun','宋体',serif; font-size:12pt; }
    .rl-item { display:inline-flex; align-items:center; } .rl-item .radio { margin-right:12px; }
    .fill-txt { width:160px; padding:2px 6px; border:1px solid #ccc; border-radius:3px; font-size:13px; }
    .fill-date { padding:2px 6px; border:1px solid #ccc; border-radius:3px; font-size:13px; }
    .print-only { display:none; } .fill-val { min-width:120px; border-bottom:1px solid #000; padding:0 6px; }
    .result-combo{box-sizing:border-box;width:160px;height:28px;padding:2px 26px 2px 6px;border:1px solid #999;border-radius:3px;background:#fff;color:#000;font:inherit}
    .result-combo:focus{border-color:#1677ff;outline:1px solid #1677ff;outline-offset:-1px}
    .result-datetime{box-sizing:border-box;width:190px;height:28px;padding:2px 5px;border:1px solid #999;border-radius:3px;background:#fff;color:#000;font:inherit}
    .result-line input[type="radio"]{width:14px;height:14px;margin:0 3px 0 10px;vertical-align:middle}

    .footnote { margin-top:6px; font-family:'SimSun','宋体',serif; font-size:9.5pt; line-height:1.3; text-align:left; margin-bottom:5mm; }
    .footnote .fn-title { font-weight:700; } .footnote .fn { margin:1px 0; }
    .review-sign { margin-top:6px; text-align:right; font-family:'SimSun','宋体',serif; font-size:13pt; font-weight:400; padding-right:6px; }
    .sheet-pageno { position:absolute; right:0; bottom:35px; left:0; width:auto; margin:0; padding:0; box-sizing:border-box; text-align:center; font-family:'SimSun','宋体',serif; font-size:12pt; font-weight:400; line-height:1; color:#000; white-space:nowrap; pointer-events:none; z-index:20; }
    @media screen { .sheet { zoom:var(--sheet-scale,1); } }
    @media print {
      :host { height:auto; overflow:visible; }
      .no-print { display:none !important; }
      .screen-only { display:none !important; } .print-only { display:inline !important; }
      .result-combo,.result-datetime,.result-line input[type="radio"]{display:none!important}
      .sheet-hidden { display:none !important; }
      .sheet { width:297mm; height:210mm; overflow:hidden; margin:0; box-shadow:none; zoom:1; page-break-after:always; }
      .sheet:last-of-type { page-break-after:auto; }
    }
  `],
})
export class PatientFallDangerComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly API_SCORE = '/api/v1/icu/score/listByPid';
  private readonly API_HOSPITAL = '/api/v1/config/hospital';
  private readonly API_ACCOUNT = '/api/v1/icu/accounts/listByIds';
  private readonly API_ACCOUNT_ALL = '/api/v1/icu/accounts';
  private readonly API_EXTRA_LATEST = '/api/v1/icu/fall-danger-extra/latest';
  private readonly API_EXTRA_SAVE = '/api/v1/icu/fall-danger-extra/save';

  readonly CLINICAL = CLINICAL;
  readonly MORSE = MORSE;
  readonly MEASURE_LEGEND = MEASURE_LEGEND;
  get morseLeafCount(): number { return MORSE.reduce((s, m) => s + m.opts.length, 0); }

  loading = true;
  patient: any = null;
  deptName = '';
  hospitalName = '重钢总医院';
  diagnosisDisplay = '';
  age: number | null = null;

  rows: FallRow[] = [];
  pages: RenderPage[] = [];
  selectedPrintPages: number[] = [];

  // 工具栏可选并保存
  auditorName = ''; auditorId = ''; auditorQuery = ''; auditorOpen = false;
  readonly resultOptions = ['出院', '死亡', '转出'];
  finalExtra: FinalExtraData = { id: null, result: '', resultDate: '', happened: '', loaded: false, loading: false };
  private finalExtraSaveTimer: ReturnType<typeof setTimeout> | null = null;
  accountList: { accountId: string; accountName: string }[] = [];
  private blurTimer: any = null;
  private readonly AUDITOR_BLOCK = ['工程师', '美康', '他科带入', '外院带入', '其他账号'];

  maxRowsPerPage = 11;
  private pid = '';
  private destroy$ = new Subject<void>();
  private ro?: ResizeObserver;
  private __lastPid: string | null = null;
  isViewerMode = false;

  constructor(private http: HttpClient, private hostPatient: HostPatientService,
              private cdr: ChangeDetectorRef, private host: ElementRef,
              private contextService: IcuFormViewerContextService,
              private diagHistory: DiagnosisHistoryService) {}

  ngOnInit(): void {
    // 检测 viewer 模式
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
        this.patient = p; this.pid = pid;
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
    if (this.finalExtraSaveTimer) { clearTimeout(this.finalExtraSaveTimer); this.finalExtraSaveTimer = null; }
    this.destroy$.next();
    this.destroy$.complete();
    this.ro?.disconnect();
  }

  private resetForm(): void {
    this.rows = []; this.pages = []; this.selectedPrintPages = [];
    this.diagnosisDisplay = ''; this.age = null;
    this.auditorName = ''; this.auditorId = ''; this.auditorQuery = ''; this.auditorOpen = false;
    if (this.finalExtraSaveTimer) { clearTimeout(this.finalExtraSaveTimer); this.finalExtraSaveTimer = null; }
    this.finalExtra = { id: null, result: '', resultDate: '', happened: '', loaded: false, loading: false };
    this.cdr.detectChanges();
  }

  private loadFromServer(pid: string) {
    this.loading = true;
    return this.http.get<ScoreRecord[]>(this.API_SCORE, { params: { pid, scoreType: SCORE_TYPE } }).pipe(
      tap((res) => {
        const list = Array.isArray(res) ? res : res ? [res as any] : [];
        this.buildRows(list.filter(r => r && r.valid === true && r.scoreType === SCORE_TYPE));
      }),
      finalize(() => { this.loading = false; this.cdr.detectChanges(); }),
    );
  }

  private buildRows(records: ScoreRecord[]): void {
    const rows: FallRow[] = records.filter(r => !!r.time).map(r => ({
      time: r.time!,
      factor: r.patientFallDangerFactorV2 || {},
      total: this.num(r.total),
      risk: r.conclusion || '',
      measures: this.parseMeasures(r.nurseMeasureList || []),
      signUserId: r.inputUserId,
      signName: r.inputUser || '',
    })).sort((a, b) => this.ts(a.time) - this.ts(b.time));
    this.rows = rows;

    const userIds = [...new Set(rows.map(r => r.signUserId).filter(Boolean) as string[])];
    if (userIds.length) {
      this.http.get<any[]>(this.API_ACCOUNT, { params: { ids: userIds.join(',') } }).subscribe({
        next: (accounts) => {
          const nameMap = new Map<string, string>();
          if (Array.isArray(accounts)) for (const a of accounts) { const id = a?._id || a?.id; if (id) nameMap.set(String(id), a?.trueName || ''); }
          for (const row of this.rows) if (row.signUserId && nameMap.has(row.signUserId)) row.signName = nameMap.get(row.signUserId) || row.signName;
          this.autoPaginate();
        },
        error: () => { this.autoPaginate(); },
      });
    } else { this.paginate(); }
  }

  clinicalCheck(r: FallRow, key: string): string { return r.factor[key] === true ? '√' : ''; }
  morseCheck(r: FallRow, field: string, score: number): string { return this.num(r.factor[field]) === score ? '√' : ''; }
  /** 适用方法 - 临床判定法：任一临床布尔为 true 打√ */
  clinicalUsed(r: FallRow): boolean { return this.CLINICAL.some(c => r.factor[c.key] === true); }
  /** 适用方法 - Morse：Morse 量表下有任一项填了数据才打√ */
  morseUsed(r: FallRow): boolean { return this.MORSE.some(m => this.num(r.factor[m.field]) !== null); }

  /** 是否展示总分。总分是 Morse 评分量表的产物；临床判定法为定性判定、不产生分值，故不展示。 */
  showTotal(r: FallRow): boolean {
    return this.morseUsed(r) && r.total !== null;
  }

  private parseMeasures(list: any[]): string {
    const seen = new Set<string>(); const out: string[] = [];
    for (const m of list) {
      if (m && m.value === true && typeof m.code === 'string') {
        const letter = m.code.split('.')[0].trim();
        if (letter && !seen.has(letter)) { seen.add(letter); out.push(letter); }
      }
    }
    return out.join(' ');
  }

  private async autoPaginate(): Promise<void> {
    try {
      const title = this.hospitalName + '跌倒/坠床风险评估及预防措施护理记录单';
      const fixedHtml = '<div class="sheet-head"><div class="title-line">' + title + '</div></div>' +
        '<div class="patient-info-row"><span class="info-item"><b>科室：</b>' + (this.patient?.dept || '') + '</span></div>' +
        '<table class="record-table"><thead><tr><th class="date-col" rowspan="4">日期/时间</th>' +
        '<th colspan="2">适用方法</th><th colspan="7">临床判定法</th>' +
        '<th colspan="2">Morse评分量表</th><th class="risk-col" rowspan="4">跌倒风险</th>' +
        '<th class="measure-col" rowspan="4">预防措施</th><th class="sign-col" rowspan="4">签名</th></tr></thead></table>' +
        '<div class="footnote"><div class="fn-title">预防跌倒护理措施：</div></div>' +
        '<div class="review-sign">审核护士签名：</div>';
      const rowHtml = '<table class="record-table"><tr><td class="date-cell"><span class="dt-date">2026-01-01</span>' +
        '<span class="dt-time">12:00:00</span></td><td></td><td></td>' +
        '<td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>' +
        '<td></td><td></td><td></td><td></td><td></td></tr></table>';
      const capacity = await measureRowCapacity(fixedHtml, rowHtml, { safetyMargin: 8 });
      this.maxRowsPerPage = 11;
    } catch(e) { /* keep fallback */ }
    this.paginate();
    this.cdr.detectChanges();
  }

  pageExtra(pageIndex: number): FinalExtraData {
    return this.finalExtra;
  }

  private pageFormCode(pageIndex: number): string {
    return `${FORM_CODE}:result`;
  }

  private paginate(): void {
    const per = this.maxRowsPerPage; const pages: RenderPage[] = [];
    if (!this.rows.length) pages.push({ index: 1, rows: [], diagnosis: this.diagnosisForRows([]) });
    else for (let i = 0; i < this.rows.length; i += per) {
      const pageRows = this.rows.slice(i, i + per);
      pages.push({ index: pages.length + 1, rows: pageRows, diagnosis: this.diagnosisForRows(pageRows) });
    }
    this.pages = pages;
    this.normalizeSelectedPrintPages(pages.length);
    this.loadFinalExtra();
  }
  pagePaddedRows(page: RenderPage): (FallRow | null)[] {
    const result: (FallRow | null)[] = page.rows.slice(0, this.maxRowsPerPage);
    while (result.length < this.maxRowsPerPage) result.push(null);
    return result;
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
    this.http.post(this.API_EXTRA_SAVE, {
      pid: this.pid, formCode: FORM_CODE,
      auditorId: this.auditorId, auditorName: this.auditorName,
    }).subscribe({
      next: () => {},
      error: (e) => console.error('[fallDanger] saveAuditor failed', { formCode: FORM_CODE, pid: this.pid, auditorId: this.auditorId, error: e }),
    });
  }
  private loadAuditor(): void {
    if (!this.pid) return;
    this.http.get<any>(this.API_EXTRA_LATEST, { params: { pid: this.pid, formCode: FORM_CODE } }).subscribe({
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
      error: (e) => console.error('[fallDanger] loadAccountList failed', e),
    });
  }
  private loadFinalExtra(): void {
    if (!this.pid) return;
    if (this.finalExtra.loaded || this.finalExtra.loading) return;
    const requestPid = this.pid;
    const formCode = `${FORM_CODE}:result`;
    this.finalExtra.loading = true;
    this.http.get<any>(this.API_EXTRA_LATEST, { params: { pid: requestPid, formCode } })
      .pipe(
        catchError(error => {
          console.error('[fallDanger] load final extra failed', { pid: requestPid, formCode, error });
          return of(null);
        }),
        finalize(() => {
          if (requestPid !== this.pid) return;
          this.finalExtra.loading = false;
          this.finalExtra.loaded = true;
          this.cdr.detectChanges();
        }),
        takeUntil(this.destroy$),
      )
      .subscribe(data => {
        if (requestPid !== this.pid) return;
        if (!data) {
          this.migrateFromLegacyPages(requestPid);
          return;
        }
        this.finalExtra.id = data?.id ? String(data.id) : null;
        this.finalExtra.result = String(data?.result ?? '');
        this.finalExtra.resultDate = this.normalizeDateTimeInput(data?.resultDate);
        const happened = String(data?.fell ?? '');
        this.finalExtra.happened = happened === '是' || happened === '否' ? happened : '';
      });
  }

  private migrateFromLegacyPages(requestPid: string): void {
    const maxPage = this.pages.length;
    if (maxPage <= 0) return;
    let foundLegacy = false;
    const tryLoad = (pageIndex: number): void => {
      if (foundLegacy || pageIndex < 1) return;
      this.http.get<any>(this.API_EXTRA_LATEST, { params: { pid: requestPid, formCode: `${FORM_CODE}:page:${pageIndex}` } })
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: (data) => {
            if (requestPid !== this.pid || foundLegacy) return;
            const result = String(data?.result ?? '');
            const resultDate = String(data?.resultDate ?? '');
            const fell = String(data?.fell ?? '');
            if (result || resultDate || fell === '是' || fell === '否') {
              foundLegacy = true;
              this.finalExtra.id = data?.id ? String(data.id) : null;
              this.finalExtra.result = result;
              this.finalExtra.resultDate = this.normalizeDateTimeInput(resultDate);
              this.finalExtra.happened = fell === '是' || fell === '否' ? fell : '';
              this.saveFinalExtra();
            } else {
              tryLoad(pageIndex - 1);
            }
          },
          error: () => tryLoad(pageIndex - 1),
        });
    };
    tryLoad(maxPage);
  }

  scheduleSaveFinalExtra(): void {
    if (!this.pid) return;
    if (this.finalExtraSaveTimer) clearTimeout(this.finalExtraSaveTimer);
    this.finalExtraSaveTimer = setTimeout(() => {
      this.finalExtraSaveTimer = null;
      this.saveFinalExtra();
    }, 500);
  }

  toggleHappened(event: MouseEvent, value: '是' | '否'): void {
    event.preventDefault();
    event.stopPropagation();
    this.finalExtra.happened = this.finalExtra.happened === value ? '' : value;
    this.scheduleSaveFinalExtra();
  }

  private saveFinalExtra(): void {
    if (!this.pid) return;
    if (this.finalExtra.loading) return;
    const requestPid = this.pid;
    const formCode = `${FORM_CODE}:result`;
    const body: any = {
      pid: requestPid,
      formCode,
      result: this.finalExtra.result.trim(),
      resultDate: this.finalExtra.resultDate || '',
      fell: this.finalExtra.happened || '',
    };
    if (this.finalExtra.id) body.id = this.finalExtra.id;
    this.http.post<any>(this.API_EXTRA_SAVE, body)
      .pipe(
        catchError(error => {
          console.error('[fallDanger] save final extra failed', { formCode, pid: requestPid, body, error });
          return of(null);
        }),
        takeUntil(this.destroy$),
      )
      .subscribe(response => {
        if (requestPid !== this.pid) return;
        if (response?.id) this.finalExtra.id = String(response.id);
      });
  }

  private normalizeDateTimeInput(value: any): string {
    if (!value) return '';
    const text = String(value).trim();
    const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2}))?/);
    if (!match) return '';
    const year = match[1];
    const month = match[2].padStart(2, '0');
    const day = match[3].padStart(2, '0');
    const hour = (match[4] || '00').padStart(2, '0');
    const minute = (match[5] || '00').padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:${minute}`;
  }

  /* ===== 通用 ===== */
  private fitScale(): void {
    const SHEET_W = 397 * (96 / 25.4);
    const avail = this.host.nativeElement.clientWidth - 32;
    this.host.nativeElement.style.setProperty('--sheet-scale', String(Math.min(1, avail / SHEET_W)));
  }
  private loadHospitalName(): void {
    this.http.get<{ hospitalName: string }>(this.API_HOSPITAL).subscribe({
      next: (res) => { if (res?.hospitalName) { this.hospitalName = res.hospitalName; this.cdr.detectChanges(); } }, error: () => {},
    });
  }
  genderText(g?: string): string { if (g === 'Male' || g === 'M' || g === '男') return '男'; if (g === 'Female' || g === 'F' || g === '女') return '女'; return g || ''; }
  private calcAge(b?: string): number | null {
    if (!b) return null; const d = new Date(b); if (isNaN(d.getTime())) return null;
    const now = new Date(); let a = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth(); if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--; return a;
  }
  private formatDiagnosis(x?: string): string {
    return firstDiagnosisSegment(x, 'legacy');
  }

  /** 页诊断 = 该页第一条数据所在时间区间的诊断 */
  private diagnosisForRows(rows: FallRow[]): string {
    return resolvePageDiagnosis(this.patient, rows[0], ['time'], this.diagnosisDisplay);
  }
  fmtDate(v?: string): string { return formatShanghaiDate(v) || ''; }
  fmtTime(v?: string): string { return formatShanghaiTime(v) || ''; }
  private num(v: any): number | null { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isNaN(n) ? null : n; }
  private ts(v?: string): number { return databaseTimeValue(v) || 0; }

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
      body += '<div class="print-page" data-page-index="' + pageIndex + '">' + c.outerHTML + '</div>';
    });
    const css = `
      @page { size: A4 landscape; margin:0; }
      html,body{margin:0;padding:0;} body{color:#000;font-family:'SimSun','宋体',serif;}
      .print-page{box-sizing:border-box;width:297mm;height:210mm;margin:0;overflow:hidden;page-break-after:always;background:#fff;}
      .print-page:last-of-type{page-break-after:auto;}
      .sheet{position:relative;box-sizing:border-box;width:297mm;height:210mm;margin:0;padding:4mm 10mm 12mm;overflow:hidden;box-shadow:none;background:#fff;color:#000;transform:none!important;zoom:1!important;filter:none!important;text-shadow:none!important;}
      .sheet-head{text-align:center;padding-bottom:6px;} .title-line{font-family:'SimHei','黑体',sans-serif;font-weight:700;font-size:22pt;line-height:1.35;}
      .patient-info-row{display:flex;align-items:center;width:100%;gap:14px;font-family:'SimSun','宋体',serif;font-size:12pt;font-weight:400;white-space:nowrap;margin:2px 0;color:#000;}
      .info-item{flex:0 0 auto;white-space:nowrap;} .diagnosis-item{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;}
      .record-table{width:100%;border-collapse:collapse;font-family:'SimSun','宋体',serif;font-size:9pt;table-layout:fixed;}
      .record-table th,.record-table td{border:1px solid #000;text-align:center;padding:1px;word-break:break-all;vertical-align:middle;overflow:hidden;}
      .record-table th{height:60px;}
      .header-row1 th{height:30px;}
      .method-col{height:15px;}
      .situation-row th{height:30px;}
      .eval-row th{height:70px;}
      .score-row th{height:45px;}
      .cond-short{height:40px;}
      .record-table td{height:26px;}
      .vtext{writing-mode:vertical-lr;text-orientation:upright;white-space:normal;line-height:1.08;letter-spacing:0.5px;font-family:'SimSun','宋体',serif;font-size:9pt;font-weight:700;overflow:hidden;}
      .date-col{width:82px;min-width:82px;} .method-col{width:17px;} .cond-col{width:26px;} .cond-narrow{width:16px;} .cond-wide{width:36px;}
      .rowlabel-col{width:16px;writing-mode:vertical-rl;text-orientation:upright;white-space:nowrap;font-family:'SimSun','宋体',serif;font-size:9pt;letter-spacing:1px;}
      .opt-col{width:24px;height:50px;writing-mode:vertical-lr;text-orientation:upright;font-family:'SimSun','宋体',serif;font-size:9pt;font-weight:700;color:#000;}
      .opt-wide{width:34px;}
      .score-col{width:24px;font-family:'SimSun','宋体',serif;font-size:9pt;} .total-col{width:22px;} .risk-col{width:44px;} .measure-col{width:92px;} .sign-col{width:44px;}
      .dt-date,.dt-time{display:block;white-space:nowrap;line-height:1.25;} .measure-cell{text-align:left;padding-left:4px;letter-spacing:2px;}
      .result-line{display:flex;flex-wrap:wrap;gap:80px;margin-top:8px;align-items:center;font-family:'SimSun','宋体',serif;font-size:12pt;}
      .rl-item{display:inline-flex;align-items:center;} .screen-only{display:none !important;} .print-only{display:inline !important;}
      .fill-val{display:inline-block;min-width:0;border:0!important;border-bottom:0!important;padding:0 4px;box-shadow:none!important;background:transparent!important;text-decoration:none!important;}
      .footnote{font-family:'SimSun','宋体',serif;font-size:8pt;line-height:1.3;text-align:left;margin-bottom:5mm;} .footnote .fn-title{font-weight:700;} .footnote .fn{margin:1px 0;}
      .review-sign{margin-top:6px;text-align:right;font-family:'SimSun','宋体',serif;font-size:12pt;font-weight:400;padding-right:6px;} .sheet-pageno{position:absolute;right:0;bottom:35px;left:0;width:auto;margin:0;padding:0;box-sizing:border-box;text-align:center;font-family:'SimSun','宋体',serif;font-size:12pt;font-weight:400;line-height:1;color:#000;white-space:nowrap;pointer-events:none;z-index:20;}
    `;
    const win = window.open('', '_blank', 'width=1400,height=900');
    if (!win) { alert('打印窗口被拦截，请允许弹出窗口'); return; }
    win.document.write('<html><head><meta charset="utf-8"><style>' + css + '</style></head><body>' + body + '</body></html>');
    win.document.close(); win.focus();
    const doPrint = () => { win.focus(); win.print(); };
    const ready = () => { const doc = win.document as any; if (doc.fonts?.ready) { doc.fonts.ready.then(() => { requestAnimationFrame(() => requestAnimationFrame(doPrint)); }); } else { requestAnimationFrame(() => requestAnimationFrame(doPrint)); } };
    win.addEventListener('afterprint', () => { try { win.close(); } catch(e) {} });
    if ((win.document as any).readyState === 'complete') { ready(); } else { win.addEventListener('load', ready); }
  }
}

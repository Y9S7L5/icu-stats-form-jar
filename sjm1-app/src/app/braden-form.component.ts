/**
 * 住院患者压力性损伤评估及措施记录单（Braden）—— Angular 组件
 * 访问路径：/bradenForm
 */
import { HttpClient } from '@angular/common/http';
import { ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, OnInit } from '@angular/core';
import { forkJoin, of, Subject } from 'rxjs';
import { catchError, filter, finalize, map, retry, switchMap, takeUntil, tap } from 'rxjs/operators';
import { HostPatientService } from './services/host-patient.service';
import { formatShanghaiDate, formatShanghaiTime } from './form-date.util';
import { normalizePrintPages, shouldPrintPage } from './form-print-pages.util';
import { IcuFormViewerContextService } from './icu-form-viewer-context.service';
import { legacyBradenDiagnosis, resolvePageDiagnosis } from './diagnosis-history.util';
import { DiagnosisHistoryService } from './diagnosis-history.service';

const SCORE_TYPE = 'bradenScore';
const FORM_CODE = 'bradenForm';
const API_EXTRA_LATEST = '/api/v1/icu/fall-danger-extra/latest';
const API_EXTRA_SAVE = '/api/v1/icu/fall-danger-extra/save';
/** 压力性损伤评估明细（skinCareInfo.pressureInjuryAssessList），用于填充「其他」列 */
const API_SKIN_ASSESS = '/api/v1/icu/skin-care/pressure-injury';

interface BradenOption { score: number; label: string; }
interface BradenItem { field: 'feel'|'damp'|'activityAbility'|'moveAbility'|'nutritionAbility'|'frictionAndShear'; title: string; options: BradenOption[]; }

const BRADEN_ITEMS: BradenItem[] = [
  { field:'feel',title:'感知\n能力',options:[{score:1,label:'完全\n受限'},{score:2,label:'非常\n受限'},{score:3,label:'轻微\n受限'},{score:4,label:'无损\n害'}] },
  { field:'damp',title:'潮湿\n度',options:[{score:1,label:'持续\n潮湿'},{score:2,label:'非常\n潮湿'},{score:3,label:'偶尔\n潮湿'},{score:4,label:'罕见\n潮湿'}] },
  { field:'activityAbility',title:'活动\n能力',options:[{score:1,label:'卧床\n不起'},{score:2,label:'能坐\n轮椅'},{score:3,label:'扶助\n行走'},{score:4,label:'活动\n自如'}] },
  { field:'moveAbility',title:'移动\n能力',options:[{score:1,label:'完全\n受限'},{score:2,label:'重度\n受限'},{score:3,label:'轻度\n受限'},{score:4,label:'不受\n限'}] },
  { field:'nutritionAbility',title:'营养\n摄取',options:[{score:1,label:'非常\n差'},{score:2,label:'可能\n不足'},{score:3,label:'充足'},{score:4,label:'良好'}] },
  { field:'frictionAndShear',title:'摩擦力\n/剪切力',options:[{score:1,label:'存在\n问题'},{score:2,label:'潜在\n问题'},{score:3,label:'不存在\n问题'},{score:4,label:'不存在\n问题'}] },
];

const MEASURE_COLUMNS = [
  { key:'turnOver',title:'定时翻身',match:['bao10chi17chuang1pu2he19yi6ku5qing4jie14'],showMeasures:'1' },
  { key:'bedCleanDry',title:'床单元整洁干燥',match:['bao11chi2pi19fu17qing17jie19'],showMeasures:'2' },
  { key:'airOrWaterMattress',title:'使用气垫床或水垫',match:['ding5shi2fan10shen2'],showMeasures:'3' },
  { key:'dressing',title:'使用敷料',match:['gei0yu5qi12dian13chuang16'],showMeasures:'4' },
  { key:'nutrition',title:'营养支持',match:['gei2yu9jian12ya6yong1ju12'],showMeasures:'5' },
  { key:'avoidShear',title:'避免拖、拉、推，防剪切力',match:['ju11bu11tie5tou0ming1tie17'],showMeasures:'6' },
  { key:'healthEducation',title:'健康教育',match:['jia2qiang17ying9yang5'],showMeasures:'7' },
  { key:'incontinenceCare',title:'两便失禁护理',match:['qi17ta5'],showMeasures:'8' },
  { key:'deviceRelated',title:'避免医疗器械相关性压疮因素',match:['VSD3fu6ya14xi16yin11'],showMeasures:'9' },
  { key:'changeDressing',title:'换药',match:['huan13yao2'],showMeasures:'10' },
];

const FOOT_NOTES = [
  '≥19分：无风险，轻度危险：15~18分；中度危险：13~14分；高度危险：10~12分；极高度危险：≤9分。',
  '院外带入或评分≤18分，采取预防措施。',
  '轻度危险、中度危险采取预防措施，评估与记录至少1次/周。',
  '有重要改变24小时内再次评估；高度危险、极高度危险保护护士长及伤口小组，采取预防措施，建立翻身卡并记录，评估与记录至少1次/天。',
];

interface ScoreRecord { time?: any; scoreType?: string; total?: number; conclusion?: string; valid?: boolean; inputUserId?: string; inputUser?: string; ohter?: string; nurseMeasureList?: any[]; bradenScore?: Record<string, any>; }
interface BradenRow { time: string; bradenScore: Record<BradenItem['field'], number | null>; total: number | null; risk: string; other: string; nurseMeasureList: any[]; signUserId?: string; signName?: string; }
/** 数据行在页面上的显示片段：整行，或跨页拆行后本页可见的文本窗口 */
interface RowSegment {
  row: BradenRow | null;
  /** 片段起点距行顶的偏移（px）；跨页续行时 >0 */
  offsetPx: number;
  heightPx: number;
  isFirst: boolean;
  isLast: boolean;
  /** 整行未拆分（参与行高实测） */
  isWhole: boolean;
}
interface RenderPage { index: number; segments: RowSegment[]; diagnosis?: string; }
interface FinalExtraData { id: string | null; result: string; resultDate: string; happened: '' | '是' | '否'; loaded: boolean; loading: boolean; }

@Component({
  standalone: false,
  selector: 'app-braden-form',
  template: `
    <div class="braden-form-wrapper" [class.viewer-mode]="isViewerMode">
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

      <div *ngIf="loading" class="loading no-print">加载中…</div>

    <ng-container *ngFor="let page of pages">
      <section class="sheet" [class.sheet-hidden]="!isPrintPageSelected(page.index)" [class.last-sheet]="page.index === pages.length">
        <div class="sheet-head">
          <div class="title-line">{{hospitalName}}住院患者压力性损伤评估及措施记录单</div>
          <div class="patient-info-row">
            <span class="info-item"><b>科室：</b>{{patient?.dept || patient?.deptName || patient?.departmentName || patient?.wardName || ''}}</span>
            <span class="info-item"><b>姓名：</b>{{patient?.name || ''}}</span>
            <span class="info-item"><b>床号：</b>{{ (patient?.hisBed || patient?.bedNo) ? ((patient?.hisBed || patient?.bedNo).endsWith('床') ? (patient?.hisBed || patient?.bedNo) : (patient?.hisBed || patient?.bedNo) + '床') : '' }}</span>
            <span class="info-item"><b>住院号：</b>{{patient?.mrn || patient?.hospitalNo || ''}}</span>
            <span class="info-item"><b>年龄：</b>{{age ?? patient?.age ?? ''}}</span>
            <span class="info-item"><b>性别：</b>{{genderText(patient?.gender)}}</span>
            <span class="info-item diagnosis-item"><b>诊断：</b>{{page.diagnosis || diagnosisDisplay}}</span>
          </div>
        </div>

        <table class="record-table">
          <!-- table-layout:fixed 下只有首行单元格与 colgroup 的宽度生效，
               摩擦力/剪切力（压疮风险评估最后一列）与风险等级列需在此固定为 46px -->
          <colgroup>
            <col [attr.span]="BRADEN_ITEMS.length + 1" />
            <col class="friction-col" />
            <col class="total-col" />
            <col class="risk-col" />
            <col [attr.span]="MEASURE_COLUMNS.length + 2" />
          </colgroup>
          <thead>
            <tr>
              <th rowspan="6" class="date-col">日期　时间</th>
              <th colspan="7" class="group-head">压疮风险评估</th>
              <th rowspan="6" class="total-col">总分</th>
              <th rowspan="6" class="risk-col">风险<br>等级</th>
              <th [attr.colspan]="MEASURE_COLUMNS.length" class="group-head">预防压疮护理措施</th>
              <th rowspan="6" class="other-col">其他</th>
              <th rowspan="6" class="sign-col">签名</th>
            </tr>
            <tr>
              <th class="score-index-col">分值</th>
              <th *ngFor="let item of BRADEN_ITEMS" class="braden-title-col" [class.friction-col]="$last">{{item.title}}</th>
              <ng-container *ngFor="let m of MEASURE_COLUMNS"><th rowspan="5" class="measure-head"><span class="vtext">{{m.title}}</span></th></ng-container>
            </tr>
            <tr *ngFor="let score of [1, 2, 3, 4]">
              <th class="score-index-col">{{score}}</th>
              <th *ngFor="let item of BRADEN_ITEMS" class="braden-desc-col" [class.friction-col]="$last">{{optionLabel(item, score)}}</th>
            </tr>
          </thead>
          <tbody>
            <!-- 流式分页：一页放满才翻页；行放不下时按「其他」列文本窗口拆行，余下内容下一页顶部续行 -->
            <tr *ngFor="let seg of page.segments"
                [attr.data-row-key]="seg.row && seg.isWhole ? seg.row.time : ''"
                [attr.data-clipped]="seg.row && !seg.isWhole ? '1' : null"
                [style.height.px]="seg.heightPx">
              <td class="date-col"><span class="dt-date" *ngIf="seg.row && seg.isFirst">{{fmtDate(seg.row.time)}}</span><span class="dt-time" *ngIf="seg.row && seg.isFirst">{{fmtTime(seg.row.time)}}</span></td>
              <td class="score-index-col"></td>
              <td *ngFor="let item of BRADEN_ITEMS" class="score-cell" [class.friction-col]="$last">{{seg.row && seg.isFirst ? bradenValue(seg.row, item.field) : ''}}</td>
              <td class="total-col">{{seg.row && seg.isFirst && seg.row.total !== null ? seg.row.total : ''}}</td>
              <td class="risk-col">{{seg.row && seg.isFirst ? seg.row.risk : ''}}</td>
              <ng-container *ngFor="let m of MEASURE_COLUMNS"><td class="measure-cell">{{seg.row && seg.isFirst ? measureCheck(seg.row, m) : ''}}</td></ng-container>
              <td class="other-cell"><span class="cell-text" *ngIf="seg.row && seg.row.other" [class.clipped]="!seg.isWhole" [style.height.px]="seg.row && !seg.isWhole ? seg.heightPx : null" [style.marginTop.px]="seg.row && !seg.isWhole ? -seg.offsetPx : null">{{seg.row.other}}</span></td>
              <td class="sign-col">{{seg.row && seg.isLast ? (seg.row.signName || '') : ''}}</td>
            </tr>
          </tbody>
        </table>

        <div class="result-line" *ngIf="page.index === pages.length">
          <label class="rl-item">
            <span>结果：</span>
            <input class="result-combo screen-only" type="text" list="braden-result-options" [(ngModel)]="finalExtra.result" (ngModelChange)="scheduleSaveFinalExtra()" placeholder="请选择或输入" autocomplete="off" />
            <datalist id="braden-result-options"><option value="出院"></option><option value="死亡"></option><option value="转出"></option></datalist>
            <span class="fill-val print-only">{{ finalExtra.result }}</span>
          </label>
          <label class="rl-item">
            <span>时间：</span>
            <input class="result-datetime screen-only" type="datetime-local" [(ngModel)]="finalExtra.resultDate" (ngModelChange)="scheduleSaveFinalExtra()" />
            <span class="fill-val print-only">{{ finalExtra.resultDate ? finalExtra.resultDate.replace('T', ' ') : '' }}</span>
          </label>
          <div class="rl-item pressure-radio">
            <span>发生院内压力性损伤：</span>
            <label class="screen-only"><input type="radio" name="braden-pressure-happened" [checked]="finalExtra.happened === '是'" (click)="toggleHappened($event, '是')" /> 是</label>
            <label class="screen-only"><input type="radio" name="braden-pressure-happened" [checked]="finalExtra.happened === '否'" (click)="toggleHappened($event, '否')" /> 否</label>
            <span class="print-only">是 {{ finalExtra.happened === '是' ? '☑' : '☐' }}&nbsp;&nbsp;否 {{ finalExtra.happened === '否' ? '☑' : '☐' }}</span>
          </div>
        </div>

        <div class="footnote" *ngIf="page.index === pages.length">
          <div class="fn-title">备注：</div>
          <div class="fn" *ngFor="let t of FOOT_NOTES">{{t}}</div>
        </div>

        <div class="review-sign" *ngIf="page.index === pages.length">审核护士签名：{{ auditorName || '__________' }}</div>
        <div class="sheet-pageno">第 {{page.index}} 页</div>
      </section>
    </ng-container>
    </div>
  `,
  styles: [`
    :host{display:block;background:#f0f2f5;height:100vh;overflow:auto}
    .toolbar{display:flex;justify-content:flex-end;align-items:center;padding:10px 16px;background:#fff;border-bottom:1px solid #eee;position:sticky;top:0;z-index:50}
    .toolbar-right{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:flex-end}
    .page-select{font-family:'SimSun','宋体',serif;font-size:14px;white-space:nowrap}
    .btn{padding:5px 16px;border:1px solid #1890ff;background:#1890ff;color:#fff;border-radius:4px;cursor:pointer}
    .loading{padding:16px;font-family:'SimSun','宋体',serif}
    .sheet-hidden{display:none}

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
    :host(.viewer-mode) .print-only { display: inline !important; }
    :host(.viewer-mode) .result-combo,
    :host(.viewer-mode) .result-datetime,
    :host(.viewer-mode) .result-line input[type="radio"] { display: none !important; }

    .auditor-field{display:flex;align-items:center}
    .auditor-label{font-family:'SimSun','宋体',serif;font-size:14px;white-space:nowrap}
    .auditor-combo{position:relative;display:inline-block}
    .auditor-input{padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-size:14px;width:150px}
    .auditor-menu{position:absolute;top:100%;left:0;right:0;margin:2px 0 0;padding:4px 0;list-style:none;max-height:240px;overflow-y:auto;background:#fff;border:1px solid #d9d9d9;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.15);z-index:100}
    .auditor-opt{padding:5px 10px;font-size:14px;cursor:pointer;white-space:nowrap}
    .auditor-opt:hover{background:#f0f7ff} .empty-opt{color:#999} .no-opt{color:#999;cursor:default}
    .sheet{box-sizing:border-box;width:297mm;min-height:210mm;margin:16px auto;padding:8mm 10mm;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.15);position:relative;color:#000}
    .sheet-head{text-align:center;padding-bottom:4px}
    .title-line{font-family:'SimHei','黑体',sans-serif;font-weight:700;font-size:20pt;line-height:1.3}
    .patient-info-row{display:flex;align-items:center;width:100%;gap:12px;font-family:'SimSun','宋体',serif;font-size:11pt;font-weight:400;white-space:nowrap;margin:2px 0 4px;color:#000;text-align:left}
    .info-item{flex:0 0 auto;white-space:nowrap}
    .info-item b{font-weight:700}
    .diagnosis-item{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
    .record-table{width:100%;border-collapse:collapse;table-layout:fixed;font-family:'SimSun','宋体',serif;font-size:12px;font-weight:400;font-style:normal;color:#000;text-shadow:none;text-rendering:auto;-webkit-font-smoothing:auto;font-synthesis:none}
    .record-table th,.record-table td{box-sizing:border-box;border:1px solid #000;text-align:center;vertical-align:middle;padding:1px 2px;overflow:hidden;font-family:'SimSun','宋体',serif;font-size:12px;font-weight:400;font-style:normal;color:#000;text-shadow:none;text-rendering:auto;-webkit-font-smoothing:auto;transform:none;filter:none;opacity:1;font-synthesis:none;max-height:35px}
    .record-table th{height:18px!important;line-height:1.15}
    .record-table td{line-height:1.15}
    .group-head{height:18px;font-weight:400}
    .date-col{width:74px;min-width:74px;white-space:nowrap;word-break:normal}
    .score-index-col{width:24px;min-width:24px}
    .braden-title-col{width:54px;min-width:54px;font-weight:400}
    .braden-desc-col{width:54px;min-width:54px;height:18px;line-height:1.1;font-size:12px;white-space:normal}
    .score-cell{width:54px;min-width:54px;font-size:12px}
    .friction-col{width:46px;min-width:46px}
    .record-table .friction-col{padding-left:0;padding-right:0}
    .total-col{width:28px;min-width:28px}
    .risk-col{width:46px;min-width:46px;word-break:break-word}
    .measure-head{width:22px;min-width:22px;height:92px}
    .record-table th.measure-head{padding:1px 0}
    .measure-cell{width:22px;min-width:22px;font-size:12px}
    .other-col{width:305px;min-width:305px}
    .record-table td.other-cell{width:305px;min-width:305px;text-align:left;padding-left:2px;white-space:pre-wrap;word-break:break-word}
    .record-table td.other-cell .cell-text.clipped{display:block;overflow:hidden}
    .sign-col{width:44px;min-width:44px}
    .vtext{display:inline-block;writing-mode:vertical-lr;text-orientation:upright;white-space:normal;line-height:10px;letter-spacing:0;font-family:'SimSun','宋体',serif;font-size:10px;font-weight:400;font-style:normal;color:#000;text-shadow:none;text-rendering:auto;-webkit-font-smoothing:auto;transform:none;filter:none;opacity:1;margin:0 auto}
    .dt-date,.dt-time{display:block;white-space:nowrap;word-break:normal;text-align:center;line-height:1.2}
    .result-line{display:flex;flex-wrap:wrap;gap:70px;margin-top:6px;align-items:center;font-family:'SimSun','宋体',serif;font-size:12pt}
    .rl-item{display:inline-flex;align-items:center}
    .pressure-radio{gap:10px}
    .fill-input{width:130px;padding:2px 6px;border:1px solid #ccc;border-radius:3px;font-family:'SimSun','宋体',serif;font-size:12pt;background:#fff}
    .date-picker{width:125px;border:0!important;outline:0!important;box-shadow:none!important;background:transparent!important;padding:0 4px;font-family:'SimSun','宋体',serif;font-size:12pt}
    .date-picker:focus{border:0!important;outline:0!important;box-shadow:none!important}
    .result-input{width:150px}
    .fill-val{min-width:130px;border-bottom:1px solid #000;padding:0 6px;display:inline-block}
    .print-only{display:none}
    .screen-only{display:inline}
    .result-combo{box-sizing:border-box;width:160px;height:28px;padding:2px 26px 2px 6px;border:1px solid #999;border-radius:3px;background:#fff;color:#000;font:inherit}
    .result-combo:focus{border-color:#1677ff;outline:1px solid #1677ff;outline-offset:-1px}
    .result-datetime{box-sizing:border-box;width:190px;height:28px;padding:2px 5px;border:1px solid #999;border-radius:3px;background:#fff;color:#000;font:inherit}
    .result-line input[type="radio"]{width:14px;height:14px;margin:0 3px 0 10px;vertical-align:middle}
    .footnote{margin-top:5px;font-family:'SimSun','宋体',serif;font-size:9.5pt;line-height:1.25;text-align:left;margin-bottom:10mm}
    .footnote .fn-title{font-weight:700;display:inline}
    .footnote .fn{margin:0}
    .review-sign{margin-top:-24px;text-align:right;font-family:'SimSun','宋体',serif;font-size:13pt;font-weight:400;padding-right:6px}
    .sheet-pageno{position:absolute;right:0;bottom:35px;left:0;width:auto;margin:0;padding:0;box-sizing:border-box;text-align:center;font-family:'SimSun','宋体',serif;font-size:12pt;font-weight:400;line-height:1;color:#000;white-space:nowrap;pointer-events:none;z-index:20}
    @media screen{.sheet{width:calc(100vw - 32px);max-width:297mm;min-width:980px;zoom:1!important;transform:none!important}}
    @media print{
      @page{size:A4 landscape;margin:0}
      :host{display:block;width:297mm;height:auto;margin:0!important;padding:0!important;overflow:visible}
      .no-print{display:none!important}
      .no-print-input{display:none!important}
      .sheet-hidden{display:none!important}
      .sheet{box-sizing:border-box;width:297mm!important;min-width:0!important;max-width:297mm!important;height:209mm!important;min-height:209mm!important;max-height:209mm!important;margin:0!important;padding:7mm 10mm!important;overflow:hidden!important;zoom:1!important;transform:none!important;filter:none!important;box-shadow:none!important;page-break-before:auto;page-break-inside:avoid;break-inside:avoid-page;page-break-after:always;break-after:page}
      .sheet.last-sheet{page-break-after:auto!important;break-after:auto!important}
      .record-table,.record-table th,.record-table td{font-family:'SimSun','宋体',serif!important;transform:none!important;filter:none!important;text-shadow:none!important;-webkit-font-smoothing:antialiased;max-height:35px!important}
      .record-table th{height:18px!important}
      .record-table td{}
      .footnote{margin-bottom:6mm}
      .result-line{margin-top:5px}
      .print-only{display:inline!important}
      .screen-only{display:none!important}
      .result-combo,.result-datetime,.result-line input[type="radio"]{display:none!important}
      .review-sign{margin-top:-24px;text-align:right;font-family:'SimSun','宋体',serif;font-size:12pt;font-weight:400;padding-right:6px}
    }
  `],
})
export class BradenFormComponent implements OnInit, OnDestroy {
  private readonly API_SCORE = '/api/v1/icu/score/listByPid';
  private readonly API_HOSPITAL = '/api/v1/config/hospital';
  private readonly API_ACCOUNT = '/api/v1/icu/accounts/listByIds';
  private readonly API_ACCOUNT_ALL = '/api/v1/icu/accounts';

  readonly BRADEN_ITEMS = BRADEN_ITEMS;
  readonly MEASURE_COLUMNS = MEASURE_COLUMNS;
  readonly FOOT_NOTES = FOOT_NOTES;

  /** 每页新起数据行数上限（中间页满槽 11；末页可少于 11 但不截断；跨页续行片段不计入） */
  readonly maxRowsPerPageMultiPage = 11;
  /** 末页空白补白目标行数（数据 <8 时补齐） */
  readonly maxRowsLastPage = 8;
  /** 最小行高（数据行内容超高时按实际高度撑开） */
  readonly baseRowHeight = 35;
  /** 拆行片段最小高度：剩余空间不足该值时直接换页，不硬拆 */
  private readonly minFragmentPx = 35;

  /** 每行实测高度（key=行 time，px）；未测量到的行按 baseRowHeight */
  private rowHeights = new Map<string, number>();
  /** 每页留给数据行的总高度（px）；未测量时为 Infinity，退化为纯行数分页 */
  private availableRowsPx = Number.POSITIVE_INFINITY;
  /** 「其他」列文本行高（px）；跨页续行的拆行偏移按该值对齐，避免文字被拦腰截断 */
  private otherLineHeight = 14;
  /** 末页页脚（结果/备注/审核签名）占高（px）；仅末页预留 */
  private footerReservedPx = 0;

  loading = true;
  patient: any = null;
  hospitalName = '重钢总医院';
  diagnosisDisplay = '';
  age: number | null = null;

  rows: BradenRow[] = [];
  pages: RenderPage[] = [];
  selectedPrintPages: number[] = [];
  isViewerMode = false;

  // 审核者签名
  auditorName = ''; auditorId = ''; auditorQuery = ''; auditorOpen = false;
  accountList: { accountId: string; accountName: string }[] = [];
  private blurTimer: any = null;
  private readonly AUDITOR_BLOCK = ['工程师', '美康', '他科带入', '外院带入', '其他账号'];

  readonly resultOptions = ['出院', '死亡', '转出'];
  finalExtra: FinalExtraData = { id: null, result: '', resultDate: '', happened: '', loaded: false, loading: false };
  private finalExtraSaveTimer: ReturnType<typeof setTimeout> | null = null;

  private pid = '';
  private destroy$ = new Subject<void>();
  private componentPatient$ = new Subject<any>();

  private bradenHostMessageHandler = (event: MessageEvent) => {
    const raw: any = event?.data;
    if (!raw || raw.type !== 'SmartCare' || !raw.patient) return;
    const pid = this.getPatientPid(raw.patient);
    if (!pid) return;
    this.ngZone.run(() => { this.componentPatient$.next(raw.patient); });
  };

  constructor(
    private http: HttpClient,
    private hostPatient: HostPatientService,
    private cdr: ChangeDetectorRef,
    private host: ElementRef,
    private ngZone: NgZone,
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

    window.addEventListener('message', this.bradenHostMessageHandler);

    // 主患者流
    this.componentPatient$.pipe(
      filter(p => !!p),
      map(p => ({ p, pid: this.getPatientPid(p) })),
      filter(x => !!x.pid),
      switchMap(({ p, pid }) => this.diagHistory.ensurePatient(p).pipe(map(ep => ({ p: ep, pid })))),
      switchMap(({ p, pid }) => this.activatePatient(p, pid)),
      takeUntil(this.destroy$),
    ).subscribe({
      error: err => {
        console.error('[bradenForm] patient stream error', err);
        this.loading = false;
        this.ensureBlankPage();
        this.cdr.detectChanges();
      },
    });

    // 转发 HostPatientService 的患者到 componentPatient$
    this.hostPatient.patient$.pipe(
      filter(p => !!p),
      takeUntil(this.destroy$),
    ).subscribe(p => this.componentPatient$.next(p));

    // 主动读取当前缓存患者
    const current = this.hostPatient.getPatient();
    if (current) this.componentPatient$.next(current);

    const buffered = (window as any).__scMsg;
    if (buffered?.patient) this.componentPatient$.next(buffered.patient);

    if (!current && !buffered?.patient) {
      try { parent.postMessage({ type: 'SmartCareReady' }, '*'); } catch {}
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.bradenHostMessageHandler);
    if (this.finalExtraSaveTimer) { clearTimeout(this.finalExtraSaveTimer); this.finalExtraSaveTimer = null; }
    this.destroy$.next();
    this.destroy$.complete();
  }

  private getPatientPid(p: any): string {
    return String(p?.id ?? p?._id ?? p?.pid ?? p?.patientId ?? p?.patientID ?? '').trim();
  }

  private activatePatient(patient: any, pid: string) {
    this.patient = patient;
    this.pid = pid;
    this.age = this.calcAge(patient?.birthday);
    this.diagnosisDisplay = this.formatDiagnosis(patient?.clinicalDiagnosis || patient?.diagnosis);
    this.resetPatientData();
    this.loadAuditor();
    this.loadFinalExtra();
    this.ensureBlankPage();
    this.loading = true;
    this.cdr.detectChanges();
    return this.loadFromServer(pid).pipe(
      catchError(err => {
        console.error('[bradenForm] score load failed', { pid, err });
        if (pid === this.pid) { this.rows = []; this.ensureBlankPage(); this.loading = false; this.cdr.detectChanges(); }
        return of(null);
      })
    );
  }

  private resetPatientData(): void {
    this.rows = []; this.pages = []; this.selectedPrintPages = [];
    if (this.finalExtraSaveTimer) { clearTimeout(this.finalExtraSaveTimer); this.finalExtraSaveTimer = null; }
    this.finalExtra = { id: null, result: '', resultDate: '', happened: '', loaded: false, loading: false };
    this.auditorName = ''; this.auditorId = ''; this.auditorQuery = ''; this.auditorOpen = false;
  }

  private ensureBlankPage(): void {
    if (!this.pages.length) { this.pages = [{ index: 1, segments: [], diagnosis: this.diagnosisForRows([]) }]; }
  }

  private normalizeTime(v: any): string {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toISOString(); }
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object' && v.$date) return this.normalizeTime(v.$date);
    return String(v);
  }

  /** 时间值归一为毫秒时间戳（绝对时刻），供匹配与排序使用。兼容：
   *  - "Mon Sep 28 09:00:00 CST 2026"：Java Date.toString()，CST=中国标准时间 UTC+8，须手工解析
   *    （浏览器会把 CST 当美国中部时间 UTC-6，偏 14 小时，导致与评估时间永远匹配不上）
   *  - "2026-09-28 09:00:27[.SSS]"：后端 JacksonConfig 以 GMT+8 输出的无时区串，按 UTC+8 解析
   *  - ISO 带 Z/±HH:mm、毫秒数、Date、$date：原样解析 */
  private instant(v: any): number {
    if (v === null || v === undefined) return 0;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? 0 : v.getTime();
    if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
    if (typeof v === 'object') {
      if ((v as any).$date) return this.instant((v as any).$date);
      return this.instant(this.normalizeTime(v));
    }
    const raw = String(v).trim();
    if (!raw) return 0;
    if (/^\d{13,}$/.test(raw)) return Number(raw);
    // Java Date.toString()：CST 按 UTC+8 解析
    const legacy = raw.match(/^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+[A-Za-z]{2,5}\s+(\d{4})$/);
    if (legacy) {
      const months: Record<string, number> = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
      const mi = months[legacy[1]];
      if (mi === undefined) return 0;
      return Date.UTC(Number(legacy[6]), mi, Number(legacy[2]), Number(legacy[3]) - 8, Number(legacy[4]), Number(legacy[5]));
    }
    // 无时区 yyyy-MM-dd HH:mm:ss：按 GMT+8 解析
    const wall = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
    if (wall) {
      return Date.UTC(Number(wall[1]), Number(wall[2]) - 1, Number(wall[3]), Number(wall[4]) - 8, Number(wall[5]), Number(wall[6] || 0));
    }
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  /** 清理评估描述里的多余标点，如「无红肿、；护理措施」→「无红肿；护理措施」 */
  private cleanAssessText(text: string): string {
    const cleaned = String(text || '')
      .replace(/[、，,]\s*[；;]/g, '；')
      .replace(/[；;]{2,}/g, '；')
      .replace(/[、，,]+$/, '')
      .trim();
    if (!cleaned) return cleaned;
    // 「分期」前统一用「；」分隔：已有其他标点（，,；;：:）则替换，没有标点则补一个
    // 例：「深:2cm分期:2期」「深:2cm，分期:2期」→「深:2cm；分期:2期」
    const staged = cleaned.replace(/([、，,；;：:])?\s*分期/g, (_m, p, offset) => (p || offset > 0 ? '；' : '') + '分期');
    // 末尾标点统一为「。」（本来就没有标点则补一个）
    if (staged.endsWith('。')) return staged;
    return /[、，,；;：:]$/.test(staged) ? staged.replace(/[、，,；;：:]$/, '。') : `${staged}。`;
  }

  private getBradenScoreDetail(score: any): any {
    if (!score || score.scoreType !== SCORE_TYPE) return null;
    let detail = score?.[score.scoreType] ?? score?.bradenScore ?? score?.score?.bradenScore ?? score?.data?.bradenScore ?? null;
    if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch { /* ignore */ } }
    return detail;
  }

  private normalizeBradenScore(source: any): Record<BradenItem['field'], number | null> {
    if (typeof source === 'string') {
      try { source = JSON.parse(source); } catch {
        try {
          const norm = source.replace(/Int32\(\s*["']?(-?\d+)["']?\s*\)/gi, '$1').replace(/NumberInt\(\s*["']?(-?\d+)["']?\s*\)/gi, '$1').replace(/(?:Int64|Long)\(\s*["']?(-?\d+)["']?\s*\)/gi, '$1');
          source = JSON.parse(norm);
        } catch { source = {}; }
      }
    }
    source = source || {};
    return {
      feel: this.num(source.feel), damp: this.num(source.damp), activityAbility: this.num(source.activityAbility),
      moveAbility: this.num(source.moveAbility), nutritionAbility: this.num(source.nutritionAbility), frictionAndShear: this.num(source.frictionAndShear),
    };
  }

  private extractScoreList(res: any): ScoreRecord[] {
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.data)) return res.data;
    if (Array.isArray(res?.records)) return res.records;
    if (Array.isArray(res?.content)) return res.content;
    if (Array.isArray(res?.list)) return res.list;
    if (res && typeof res === 'object') return [res];
    return [];
  }

  private loadFromServer(pid: string) {
    this.loading = true;
    return forkJoin({
      scores: this.http.get<any>(this.API_SCORE, { params: { pid, scoreType: SCORE_TYPE } }).pipe(retry(2)),
      // 皮肤护理模块失败不影响 Braden 主表展示
      assess: this.http.get<any[]>(API_SKIN_ASSESS, { params: { pid } }).pipe(catchError(() => of([] as any[]))),
    }).pipe(
      tap(({ scores, assess }) => {
        if (pid !== this.pid) return;
        const list = this.extractScoreList(scores);
        const validRows = list.filter(r => r && (r.valid === true || String(r.valid) === 'true') && r.scoreType === SCORE_TYPE);
        this.buildRows(validRows, Array.isArray(assess) ? assess : []);
      }),
      catchError(err => {
        console.error('[bradenForm] score API failed', { pid, err });
        if (pid === this.pid) { this.rows = []; this.paginate(); }
        return of(null);
      }),
      finalize(() => {
        if (pid === this.pid) { this.loading = false; this.ensureBlankPage(); this.cdr.detectChanges(); }
      }),
    );
  }

  private buildRows(records: ScoreRecord[], assessList: any[]): void {
    // 候选评估条目池：同一 recordTime 只取一次，按时刻升序
    const pool: { ms: number; text: string }[] = [];
    const seen = new Set<number>();
    for (const item of assessList) {
      const ms = this.instant(item?.recordTime);
      const text = this.cleanAssessText(String(item?.skinMessage ?? ''));
      if (!ms || !text || seen.has(ms)) continue;
      seen.add(ms);
      pool.push({ ms, text });
    }
    pool.sort((a, b) => a.ms - b.ms);

    // 先按时间升序得到有效行（含毫秒时间戳），供评估条目按「最近一行」归属；
    // ms 解析失败(=0)的行仍保留展示，只是不参与评估条目归属
    const ordered = records
      .map(score => ({ score, ms: this.instant(score.time), time: this.normalizeTime(score.time) }))
      .filter(r => !!r.time)
      .sort((a, b) => a.ms - b.ms);

    // 一次评估常同时录入多个部位（recordTime 相差数秒）。旧的一对一配对只给每行
    // 取时刻最近的一条，其余部位的明细滞留池中无人认领而被丢弃（如同一分钟内
    // 骶尾部/左侧臀部/右侧腰背部三条只显示第一条）。改为：明细只归「同一分钟」
    // （行时间所在分钟 HH:MM:00~HH:MM:59）的行，同一行合并多条（按时刻升序换行拼接）。
    const textsByRow = new Map<number, string[]>();
    for (const entry of pool) {
      const entryMinute = Math.floor(entry.ms / 60000);
      for (let i = 0; i < ordered.length; i++) {
        if (ordered[i].ms && Math.floor(ordered[i].ms / 60000) === entryMinute) {
          const texts = textsByRow.get(i);
          if (texts) texts.push(entry.text);
          else textsByRow.set(i, [entry.text]);
          break;
        }
      }
    }

    const rows: BradenRow[] = ordered.map(({ score, time }, idx) => {
      const detail = this.getBradenScoreDetail(score);
      // 没有窗口内对应数据就保持原有「其他」内容
      const matched = (textsByRow.get(idx) || []).join('\n');
      return {
        time,
        bradenScore: this.normalizeBradenScore(detail),
        total: this.num(score.total),
        risk: String(score.conclusion || ''),
        other: (matched || String(score.ohter ?? '').trim()),
        nurseMeasureList: (score as any).nurseMeasureList || (score as any).measuresList || [],
        signUserId: score.inputUserId,
        signName: score.inputUser || '',
      };
    });

    this.rows = rows;
    this.paginate();
    this.resolveSignerNames(rows);
    this.cdr.detectChanges();
  }

  private resolveSignerNames(rows: BradenRow[]): void {
    const userIds = [...new Set(rows.map(r => r.signUserId).filter(Boolean) as string[])];
    if (!userIds.length) return;
    this.http.get<any[]>(this.API_ACCOUNT, { params: { ids: userIds.join(',') } })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: accounts => {
          const nameMap = new Map<string, string>();
          if (Array.isArray(accounts)) {
            for (const a of accounts) {
              const id = a?._id || a?.id || a?.accountId;
              const name = a?.trueName || a?.accountName || a?.name;
              if (id && name) nameMap.set(String(id), String(name));
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

  private loadFinalExtra(): void {
    if (!this.pid) return;
    if (this.finalExtra.loaded || this.finalExtra.loading) return;
    const requestPid = this.pid;
    const formCode = `${FORM_CODE}:result`;
    this.finalExtra.loading = true;
    this.http.get<any>(API_EXTRA_LATEST, { params: { pid: requestPid, formCode } })
      .pipe(
        catchError(error => {
          console.error('[bradenForm] load final extra failed', { pid: requestPid, formCode, error });
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
          // 尝试从旧 :page:N 数据迁移
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
    // 从最后一页向前查找旧数据
    let foundLegacy = false;
    let legacyIndex = maxPage;
    const tryLoad = (pageIndex: number): void => {
      if (foundLegacy || pageIndex < 1) return;
      const formCode = `${FORM_CODE}:page:${pageIndex}`;
      this.http.get<any>(API_EXTRA_LATEST, { params: { pid: requestPid, formCode } })
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
              // 迁移到新 formCode
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
    this.http.post<any>(API_EXTRA_SAVE, body)
      .pipe(
        catchError(error => {
          console.error('[bradenForm] save final extra failed', { formCode, pid: requestPid, body, error });
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


  optionLabel(item: BradenItem, score: number): string { return item.options.find(o => o.score === score)?.label || ''; }
  bradenValue(row: BradenRow, field: BradenItem['field']): string { const v = this.num(row?.bradenScore?.[field]); return v === null ? '' : String(v); }
  measureCheck(row: BradenRow, measure: (typeof MEASURE_COLUMNS)[number]): string {
    const list = Array.isArray(row.nurseMeasureList) ? row.nurseMeasureList : [];
    return list.some(m => m && m.value === true && measure.match.some(kw => String(m.code || '').trim().includes(kw))) ? '√' : '';
  }
  pageExtra(pageIndex: number): FinalExtraData {
    return this.finalExtra;
  }

  private pageFormCode(pageIndex: number): string {
    return `${FORM_CODE}:result`;
  }

  private paginate(): void {
    // 第一遍：按既有行高切页渲染，保证每行都渲染过一次，量得到真实行高
    this.paginateByHeight();
    this.cdr.detectChanges();
    // 第二遍：实测行高（「其他」列文字换行会撑高行）后按高度重切（放不下拆行续页）
    if (this.measureRealHeights()) {
      this.paginateByHeight();
      this.cdr.detectChanges();
    }
  }

  /** 单行高度：实测值兜底最小行高 */
  private rowHeight(row: BradenRow): number {
    const h = this.rowHeights.get(row.time);
    return h && h > 0 ? Math.max(h, this.baseRowHeight) : this.baseRowHeight;
  }

  /** 构建行显示片段：整行未拆分时 offset=0、height=自然行高 */
  private makeSegment(row: BradenRow | null, offsetPx: number, heightPx: number, isRowStart: boolean): RowSegment {
    const natural = row ? this.rowHeight(row) : heightPx;
    const isLast = !row || offsetPx + heightPx >= natural - 0.5;
    return {
      row,
      offsetPx,
      heightPx,
      isFirst: isRowStart,
      isLast,
      isWhole: !!row && offsetPx === 0 && isLast,
    };
  }

  /** 将 px 向下对齐到「其他」列行高的整数倍，保证续行从整行文本开始，不出现半行 */
  private snapToLine(px: number): number {
    const lh = this.otherLineHeight > 0 ? this.otherLineHeight : 14;
    return Math.floor(px / lh) * lh;
  }

  /** 贪心装页：整行放不下时按剩余高度拆行，余下片段从下一页顶部继续 */
  private packPages(pieces: { row: BradenRow; offset: number; height: number }[], avail: number): RowSegment[][] {
    const pages: RowSegment[][] = [];
    let cur: RowSegment[] = [];
    let used = 0;
    let rowsStarted = 0;
    const flush = (): void => { if (cur.length) { pages.push(cur); cur = []; used = 0; rowsStarted = 0; } };

    for (const piece of pieces) {
      let offset = piece.offset;
      let left = piece.height;
      let isRowStart = offset === 0;
      let guard = 0;
      while (left > 0.5 && guard++ < 1000) {
        let room = avail - used;
        if (room < this.minFragmentPx) { flush(); room = avail; }
        if (isRowStart && rowsStarted >= this.maxRowsPerPageMultiPage) { flush(); room = avail; }
        if (left <= room + 0.5) {
          cur.push(this.makeSegment(piece.row, offset, left, isRowStart));
          used += left;
          if (isRowStart) { rowsStarted++; }
          left = 0;
        } else {
          const clip = this.snapToLine(room);
          if (clip < this.minFragmentPx) {
            if (used === 0) {
              // 异常兜底：整页都装不下最小片段，整块强放交给 CSS 裁剪
              cur.push(this.makeSegment(piece.row, offset, left, isRowStart));
              flush();
              break;
            }
            flush();
            continue;
          }
          cur.push(this.makeSegment(piece.row, offset, clip, isRowStart));
          used += clip;
          offset += clip;
          left -= clip;
          if (isRowStart) { rowsStarted++; }
          isRowStart = false;
          flush(); // 余下内容从下一页顶部继续
        }
      }
    }
    flush();
    return pages;
  }

  /** 末页为「结果/备注/审核签名」预留高度；放不下时把尾部片段移到后续页 */
  private reserveFooter(pages: RowSegment[][], avail: number, availLast: number): RowSegment[][] {
    if (!Number.isFinite(availLast)) { return pages; }
    let guard = 0;
    while (pages.length && guard++ < 30) {
      const lastPage = pages[pages.length - 1];
      let lastUsed = lastPage.reduce((sum, seg) => sum + seg.heightPx, 0);
      if (lastUsed <= availLast + 0.5) { break; }

      const leftover: { row: BradenRow; offset: number; height: number }[] = [];
      while (lastPage.length && lastUsed > availLast + 0.5) {
        const seg = lastPage.pop()!;
        lastUsed -= seg.heightPx;
        if (seg.row) { leftover.unshift({ row: seg.row, offset: seg.offsetPx, height: seg.heightPx }); }
      }

      if (!lastPage.length) {
        // 单个片段就超过末页可用高度：按 availLast 硬拆
        const p = leftover.shift();
        if (!p) { break; }
        const clip = Math.max(this.snapToLine(availLast), this.baseRowHeight);
        const h = Math.min(clip, p.height);
        lastPage.push(this.makeSegment(p.row, p.offset, h, p.offset === 0));
        if (p.height > h + 0.5) { leftover.unshift({ row: p.row, offset: p.offset + h, height: p.height - h }); }
      } else if (leftover.length) {
        // 从弹出的首个片段再回收一段，减少页尾浪费
        const p = leftover[0];
        const free = this.snapToLine(availLast - lastUsed);
        if (free >= this.minFragmentPx && free + 0.5 < p.height) {
          lastPage.push(this.makeSegment(p.row, p.offset, free, p.offset === 0));
          leftover[0] = { row: p.row, offset: p.offset + free, height: p.height - free };
        }
      }

      if (!leftover.length) { break; }
      pages.push(...this.packPages(leftover, avail));
    }
    return pages;
  }

  /** 按行高累计切页：一页放满才翻页；放不下先拆行续页；每页新起数据行不超过 11 行。
   *  未测量时 availableRowsPx=Infinity、行高=35px，等价于旧行数分页。 */
  private paginateByHeight(): void {
    if (!this.rows.length) {
      this.pages = [{ index: 1, segments: [], diagnosis: this.diagnosisForRows([]) }];
      this.normalizeSelectedPrintPages(this.pages.length);
      this.loadFinalExtra();
      return;
    }

    const avail = Number.isFinite(this.availableRowsPx)
      ? Math.max(this.availableRowsPx, this.minFragmentPx)
      : Number.POSITIVE_INFINITY;
    const availLast = Number.isFinite(this.availableRowsPx)
      ? Math.max(this.availableRowsPx - this.footerReservedPx, this.minFragmentPx)
      : Number.POSITIVE_INFINITY;

    const pieces = this.rows.map(row => ({ row, offset: 0, height: this.rowHeight(row) }));
    const pages = this.reserveFooter(this.packPages(pieces, avail), avail, availLast);

    // 末页补白：数据 <8 行且放得下时补齐
    const last = pages[pages.length - 1];
    if (last) {
      let used = last.reduce((sum, seg) => sum + seg.heightPx, 0);
      while (last.length < this.maxRowsLastPage) {
        if (Number.isFinite(availLast) && used + this.baseRowHeight > availLast + 0.5) { break; }
        last.push(this.makeSegment(null, 0, this.baseRowHeight, true));
        used += this.baseRowHeight;
      }
    }

    this.pages = pages.map((segments, i) => ({
      index: i + 1,
      segments,
      diagnosis: this.diagnosisForRows(segments.map(s => s.row).filter((r): r is BradenRow => !!r)),
    }));

    this.normalizeSelectedPrintPages(this.pages.length);
    this.loadFinalExtra();
  }

  /** 从已渲染的真实 DOM 实测行高与固定区高度；量不到返回 false（保留上次结果）。
   *  行高只取决于内容与列宽，与分页无关，所以任意一页量到的行高都有效；
   *  跨页拆行片段（data-clipped）非自然高度，跳过并沿用旧值。 */
  private measureRealHeights(): boolean {
    const root = this.host.nativeElement as HTMLElement;
    const head = root.querySelector('.sheet-head') as HTMLElement | null;
    const thead = root.querySelector('.record-table thead') as HTMLElement | null;
    if (!head || !thead) return false;

    const ppm = this.pxPerMm();
    // 打印页数据行可用高度：A4 横向 209mm - 上下 padding 7mm×2 - 固定区 - 余量
    const contentPx = (209 - 14) * ppm;
    const safetyPx = 5 * ppm;
    const fixedPx = head.getBoundingClientRect().height + thead.getBoundingClientRect().height;
    const footerPx = ['.result-line', '.footnote', '.review-sign'].reduce((sum, sel) => {
      const el = root.querySelector(sel) as HTMLElement | null;
      return sum + (el ? el.getBoundingClientRect().height : 0);
    }, 0);
    const available = contentPx - fixedPx - safetyPx;
    if (!(available > 0)) return false;
    this.availableRowsPx = available;
    this.footerReservedPx = footerPx;

    // 「其他」列行高：跨页续行的拆行偏移按该值对齐
    const otherCell = root.querySelector('.record-table td.other-cell') as HTMLElement | null;
    if (otherCell) {
      const lh = parseFloat(getComputedStyle(otherCell).lineHeight);
      if (Number.isFinite(lh) && lh > 0) this.otherLineHeight = lh;
    }

    const map = new Map<string, number>();
    root.querySelectorAll('tr[data-row-key]').forEach(tr => {
      if (tr.getAttribute('data-clipped')) return; // 拆行片段非自然高度，沿用旧值
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
  private diagnosisForRows(rows: BradenRow[]): string {
    return resolvePageDiagnosis(this.patient, rows[0], ['time'], this.diagnosisDisplay);
  }

  fmtDate(time: string): string { return formatShanghaiDate(time); }
  fmtTime(time: string): string { return formatShanghaiTime(time); }
  genderText(g: any): string { const s = String(g ?? '').trim(); if (s === '1' || s === '男' || /^m$/i.test(s) || /^male$/i.test(s)) return '男性'; if (s === '2' || s === '女' || /^f$/i.test(s) || /^female$/i.test(s)) return '女性'; return s; }
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
      error: (e) => console.error('[bradenForm] saveAuditor failed', { formCode: FORM_CODE, pid: this.pid, auditorId: this.auditorId, error: e }),
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
      error: (e) => console.error('[braden] loadAccountList failed', e),
    });
  }

  private calcAge(b: any): number | null { if (!b) return null; const d = new Date(b); if (Number.isNaN(d.getTime())) return null; const n = new Date(); let a = n.getFullYear() - d.getFullYear(); const m = n.getMonth() - d.getMonth(); if (m < 0 || (m === 0 && n.getDate() < d.getDate())) a--; return a >= 0 && a < 150 ? a : null; }
  /** 旧逻辑患者保持完整串/数组join输出；新逻辑由 resolvePageDiagnosis 再取第一诊断 */
  private formatDiagnosis(v: any): string { return legacyBradenDiagnosis(v); }
  private num(value: any): number | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const text = value.trim();
      const direct = Number(text);
      if (Number.isFinite(direct)) return direct;
      const int32Match = text.match(/^Int32\(\s*["']?(-?\d+)["']?\s*\)$/i);
      if (int32Match) return Number(int32Match[1]);
      const numberIntMatch = text.match(/^NumberInt\(\s*["']?(-?\d+)["']?\s*\)$/i);
      if (numberIntMatch) return Number(numberIntMatch[1]);
      const longMatch = text.match(/^(?:Long|Int64)\(\s*["']?(-?\d+)["']?\s*\)$/i);
      if (longMatch) return Number(longMatch[1]);
      return null;
    }
    if (typeof value === 'object') {
      const c = [value.$numberInt, value.$numberLong, value.value, value.int, value.data];
      for (const x of c) { if (x !== null && x !== undefined && x !== '') { const parsed = this.num(x); if (parsed !== null) return parsed; } }
      try { const prim = value.valueOf(); if (prim !== value && prim !== null && prim !== undefined) { const p = this.num(prim); if (p !== null) return p; } } catch {}
      try { const txt = value.toString(); if (txt && txt !== '[object Object]') { const p = this.num(txt); if (p !== null) return p; } } catch {}
    }
    return null;
  }
  private ts(t: string): number { return this.instant(t); }
}

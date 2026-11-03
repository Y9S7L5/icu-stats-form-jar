/**
 * 床头卡危险风险标识 —— Angular 组件
 * 访问路径：/form/bedsideRiskCardForm
 * 通过握手机制（HostPatientService）获取当前患者，按 2 列表格动态渲染护理级别及风险防范（固定 6 行 + 自定义行）：
 *  - R1          标题行（合并两列）：护理级别及风险防范
 *  - R2C1 特级护理（固定红底白字）      R2C2 防跌倒   bedside param_score_patientFallDangerFactorV2 最新一条 strVal
 *  - R3C1 过敏史 dFormData gms1/gms4   R3C2 防压疮   bedside param_yaChuang_score 最新一条 strVal
 *  - R4C1 饮食   bedside param_biSiLiquid 最新一条   R4C2 防误吸 bedside param_score_mechanicalAspirationRisk 最新一条
 *  - R5C1 VTE    clinicalDiagnosis 含"深静脉血栓"    R5C2 防意外拔管 bedside param_score_unPlannedCGZYY 最新一条
 *  - R6C1 接触隔离 DataCenter VI_ICU_ZYYZ 医嘱        R6C2 空白
 *  - 姓名/床号行  标题行下固定 1 行 × 2 列（姓名 | 床号，来自握手患者信息）
 *  - 自定义行     工具栏"新增行"在末尾追加，点击行可编辑文字/颜色并可删除，存库 bedsideRiskCardRow
 * 行数增多时标签字号按可用高度自动缩放（上限 15pt），卡片恒为 12cm×9cm 不超出。
 * 风险等级配色：高/极高风险（含高险/高危/高度危险）红底白字、中风险黄底白字、低风险（含低险/低危）绿底白字、未评估灰底白字。
 * 打印：前端浏览器打印，A4 纵向，卡片 12cm × 9cm 靠上水平居中，打印后裁剪使用。
 */
import { HttpClient } from '@angular/common/http';
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { forkJoin, Observable, of, Subject } from 'rxjs';
import { catchError, distinctUntilChanged, filter, finalize, map, retry, switchMap, takeUntil, tap } from 'rxjs/operators';
import { HostPatientService } from './services/host-patient.service';

/** bedside 参数定义 */
interface BedsideParamDef {
  key: string;
  code: string;
}

const BEDSIDE_PARAMS: BedsideParamDef[] = [
  { key: 'fall', code: 'param_score_patientFallDangerFactorV2' },
  { key: 'pressure', code: 'param_yaChuang_score' },
  { key: 'diet', code: 'param_biSiLiquid' },
  { key: 'aspiration', code: 'param_score_mechanicalAspirationRisk' },
  { key: 'extubation', code: 'param_score_unPlannedCGZYY' },
];

/** 单元格配色等级 */
type CellLevel = 'red' | 'yellow' | 'green' | 'gray' | 'none';

interface CardCell {
  text: string;
  level: CellLevel;
}

/** 自定义行：两列各一段可编辑文字 + 用户选择的底色（level 即颜色） */
interface CustomRow {
  id: string;
  c1: CardCell;
  c2: CardCell;
}

/** 行编辑草稿；id=null 表示新增未保存 */
interface EditDraft {
  id: string | null;
  c1: CardCell;
  c2: CardCell;
}

interface BedsideRecord {
  pid?: string;
  code?: string;
  time?: string;
  strVal?: string;
  valid?: boolean | string | number;
}

interface ExtraInfo {
  allergy?: { hasAllergy?: boolean; detail?: string };
  contactIsolation?: boolean;
}

/** 解析 bedside.time（字符串时间戳或日期串）为毫秒数 */
function parseTimeMs(str: string | undefined): number {
  const s = String(str ?? '').trim();
  if (!s) return 0;
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  const ms = Date.parse(s.replace(/-/g, '/')); // 兼容 Safari/旧内核
  return isNaN(ms) ? 0 : ms;
}

@Component({
  standalone: false,
  selector: 'app-bedside-risk-card',
  template: `
    <div class="card-wrapper">
      <div class="toolbar no-print">
        <button class="btn btn-add" type="button" (click)="addRow()" [disabled]="loading || !patient || !!editing">＋ 新增行</button>
        <button class="btn" type="button" (click)="print()" [disabled]="loading || !patient">打印</button>
      </div>

      <div class="wait-hint no-print" *ngIf="!patient">等待患者信息（握手机制）…</div>
      <div class="loading no-print" *ngIf="loading">风险评估加载中…</div>

      <div class="preview" *ngIf="patient">
        <div class="card">
          <table class="risk-table" [style.font-size]="labelFontPt + 'pt'">
            <tbody>
              <tr class="title-row">
                <td colspan="2" class="title-cell">护理级别及风险防范卡</td>
              </tr>
              <tr class="info-row">
                <td><span class="label">姓名：{{ patientName || '—' }}</span></td>
                <td><span class="label">床号：{{ bedLabel || '—' }}</span></td>
              </tr>
              <tr *ngFor="let row of cellRows">
                <td *ngFor="let cell of row" [ngClass]="cell.level">
                  <span class="label">{{ cell.text }}</span>
                </td>
              </tr>
              <tr *ngFor="let row of displayRows" class="custom-row" (click)="startEdit(row)"
                  [class.editing]="editing?.id === row.id" title="点击编辑该行">
                <td [ngClass]="row.c1.level"><span class="label wrap">{{ row.c1.text }}</span></td>
                <td [ngClass]="row.c2.level"><span class="label wrap">{{ row.c2.text }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 行编辑器：新增/修改自定义行（no-print，不随打印输出）；纵向排布：标识行 + 第1列 + 第2列 -->
        <div class="editor no-print" *ngIf="editing as e">
          <div class="editor-title">{{ editorTitle }}</div>
          <div class="editor-cells">
            <div class="cell-editor">
              <span class="cell-title">第1列</span>
              <input class="cell-input" type="text" maxlength="16" placeholder="输入内容" [(ngModel)]="e.c1.text">
              <span class="swatches">
                <i *ngFor="let opt of LEVEL_OPTIONS" class="swatch" [ngClass]="'sw-' + opt.level"
                   [class.active]="e.c1.level === opt.level" (click)="e.c1.level = opt.level"
                   [title]="opt.label">{{ opt.label }}</i>
              </span>
            </div>
            <div class="cell-editor">
              <span class="cell-title">第2列</span>
              <input class="cell-input" type="text" maxlength="16" placeholder="输入内容" [(ngModel)]="e.c2.text">
              <span class="swatches">
                <i *ngFor="let opt of LEVEL_OPTIONS" class="swatch" [ngClass]="'sw-' + opt.level"
                   [class.active]="e.c2.level === opt.level" (click)="e.c2.level = opt.level"
                   [title]="opt.label">{{ opt.label }}</i>
              </span>
            </div>
          </div>
          <div class="editor-actions">
            <button class="btn" type="button" (click)="saveEditing()" [disabled]="saving">{{ saving ? '保存中…' : '保存' }}</button>
            <button class="btn btn-danger" type="button" *ngIf="e.id" (click)="deleteEditing()" [disabled]="saving">删除</button>
            <button class="btn btn-plain" type="button" (click)="cancelEdit()" [disabled]="saving">取消</button>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .toolbar {
      display: flex; justify-content: flex-end; align-items: center; gap: 16px;
      padding: 8px 12px; background: #f5f7fa; border-bottom: 1px solid #e2e8f0;
    }
    .btn {
      padding: 6px 24px; font-size: 14px; cursor: pointer;
      background: #2563eb; color: #fff; border: none; border-radius: 4px;
    }
    .btn:disabled { cursor: not-allowed; opacity: .55; }
    .btn-add { background: #059669; }
    .btn-danger { background: #dc2626; }
    .btn-plain { background: #64748b; }
    .wait-hint, .loading { padding: 28px; text-align: center; color: #64748b; font-size: 14px; }
    .preview { padding: 16px 0; display: flex; flex-direction: column; align-items: center; }

    /* 卡片 = 12cm × 9cm；纸张边框不画，只有表格黑框 */
    .card {
      box-sizing: border-box;
      width: 12cm; height: 9cm;
      padding: 5mm;
      background: #fff;
      overflow: hidden;
    }

    /* 风险标识表格（固定行 + 自定义行，均为 2 列）；字号默认 15pt，由表级 [style.font-size] 统一缩放 */
    .risk-table {
      box-sizing: border-box;
      width: 100%; height: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 15pt;
    }
    .risk-table td {
      box-sizing: border-box;
      width: 50%;
      border: 1.5px solid #000;
      text-align: center; vertical-align: middle;
      padding: 0 2mm;
    }
    .risk-table .title-row td.title-cell {
      height: 12mm;
      font-family: 'SimHei', '黑体', sans-serif;
      font-size: 16pt; font-weight: 700; color: #000;
      background: #fff;
    }
    .risk-table td .label {
      font-family: 'SimHei', '黑体', sans-serif;
      /* 字号不写死：从表级 [style.font-size] 继承，行数增多时整体缩小保证不超 12cm×9cm */
      font-weight: 700; line-height: 1.3;
      white-space: nowrap;
    }
    /* 自定义行文字允许换行（固定行仍单行） */
    .risk-table td .label.wrap { white-space: normal; word-break: break-all; }
    /* 自定义行：点击进入编辑；editing 为编辑中行的高亮 */
    .risk-table tr.custom-row { cursor: pointer; }
    .risk-table tr.custom-row.editing td { box-shadow: inset 0 0 0 2px #2563eb; }
    /* 配色：红/黄/绿/灰底均为白字 */
    .risk-table td.red    { background: #d32f2f; }
    .risk-table td.yellow { background: #f9a825; }
    .risk-table td.green  { background: #43a047; }
    .risk-table td.gray   { background: #9e9e9e; }
    .risk-table td.red .label,
    .risk-table td.yellow .label,
    .risk-table td.green .label,
    .risk-table td.gray .label { color: #fff; }
    .risk-table td.none { background: #fff; }
    .risk-table td.none .label { color: #000; }

    /* 行编辑器（卡片正下方，宽度与卡片一致，不打印） */
    .editor {
      box-sizing: border-box;
      width: 12cm; margin-top: 8px;
      padding: 10px 12px;
      background: #fff; border: 1px solid #cbd5e1; border-radius: 6px;
    }
    .editor-title { font-size: 13px; font-weight: 700; color: #1e293b; margin-bottom: 8px; }
    .editor-cells { display: flex; flex-direction: column; gap: 8px; }
    .cell-editor { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .cell-title { width: 36px; font-size: 13px; font-weight: 700; color: #475569; white-space: nowrap; }
    .cell-input {
      flex: 1; min-width: 60px; padding: 5px 8px;
      font-size: 13px; border: 1px solid #cbd5e1; border-radius: 4px; outline: none;
    }
    .cell-input:focus { border-color: #2563eb; }
    .swatches { display: inline-flex; gap: 4px; }
    .swatch {
      width: 22px; height: 22px; border-radius: 4px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 11px; font-style: normal; line-height: 1;
      cursor: pointer; border: 1px solid rgba(0,0,0,.25); user-select: none;
    }
    .swatch.active { outline: 2px solid #2563eb; outline-offset: 1px; }
    .sw-none { background: #fff; color: #000; }
    .sw-red { background: #d32f2f; color: #fff; }
    .sw-yellow { background: #f9a825; color: #fff; }
    .sw-green { background: #43a047; color: #fff; }
    .sw-gray { background: #9e9e9e; color: #fff; }
    .editor-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 10px; }

    @media print {
      @page { size: A4 portrait; margin: 0; }
      :host { display: block; width: auto; margin: 0 !important; padding: 0 !important; overflow: visible; }
      .no-print { display: none !important; }
      .preview { padding: 0 !important; display: block !important; }
      .card {
        box-sizing: border-box;
        width: 12cm !important; height: 9cm !important;
        margin: 10mm auto 0 !important; padding: 5mm !important;
        border: none !important; box-shadow: none !important;
        overflow: hidden !important;
        -webkit-print-color-adjust: exact; print-color-adjust: exact; /* 底色需随打印输出 */
        page-break-after: always; break-after: page;
      }
      .card:last-of-type { page-break-after: auto; break-after: auto; }
      .risk-table td { border: 1.5px solid #000 !important; }
      .risk-table td.red,
      .risk-table td.yellow,
      .risk-table td.green,
      .risk-table td.gray {
        -webkit-print-color-adjust: exact; print-color-adjust: exact;
      }
      .risk-table td.red    { background: #d32f2f !important; }
      .risk-table td.yellow { background: #f9a825 !important; }
      .risk-table td.green  { background: #43a047 !important; }
      .risk-table td.gray   { background: #9e9e9e !important; }
      .risk-table td.red .label,
      .risk-table td.yellow .label,
      .risk-table td.green .label,
      .risk-table td.gray .label { color: #fff !important; }
      /* 编辑态的高亮/光标只属于屏幕交互，打印时还原 */
      .risk-table tr.custom-row { cursor: auto; }
      .risk-table tr.custom-row.editing td { box-shadow: none !important; }
    }
  `],
})
export class BedsideRiskCardComponent implements OnInit, OnDestroy {
  private readonly API_BEDSIDE = '/api/v1/icu/bedside/listByPid';
  private readonly API_EXTRA = '/api/v1/icu/bedside-risk-card/extra-info';
  private readonly API_ROWS = '/api/v1/icu/bedside-risk-card/custom-rows';
  private readonly destroy$ = new Subject<void>();

  patient: any | null = null;
  loading = false;
  /** 各单元格（固定部分：标题 + 姓名/床号 + 5 行风险） */
  cells: CardCell[][] = this.defaultCells();
  /** 自定义行（"新增行"追加，存 bedsideRiskCardRow 集合，_id 序 = 追加序） */
  customRows: CustomRow[] = [];
  /** 当前行编辑草稿；id=null 表示新增未保存 */
  editing: EditDraft | null = null;
  saving = false;
  /** 单元格可选颜色（与后端白名单一致，none=白底） */
  readonly LEVEL_OPTIONS: { level: CellLevel; label: string }[] = [
    { level: 'none', label: '白' },
    { level: 'red', label: '红' },
    { level: 'yellow', label: '黄' },
    { level: 'green', label: '绿' },
    { level: 'gray', label: '灰' },
  ];

  constructor(
    private readonly http: HttpClient,
    private readonly hostPatient: HostPatientService,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    // 主患者流：握手拿到患者后拉取 bedside 参数 + 补充信息（过敏史/接触隔离）
    this.hostPatient.patient$.pipe(
      map(p => ({ p, pid: this.getPatientPid(p) })),
      filter(x => !!x.pid),
      distinctUntilChanged((a, b) => a.pid === b.pid),
      switchMap(({ p, pid }) => this.loadCardData(p, pid)),
      takeUntil(this.destroy$),
    ).subscribe({
      error: err => console.error('[bedsideRiskCard] patient stream error', err),
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /** 模板用：第 2~6 行（标题行固定在模板中单独渲染） */
  get cellRows(): CardCell[][] {
    return this.cells.slice(1);
  }

  /** 姓名（握手患者信息） */
  get patientName(): string {
    return String(this.patient?.name ?? this.patient?.patientName ?? '').trim();
  }

  /** 床号（无"床"后缀时补上） */
  get bedLabel(): string {
    const raw = String(this.patient?.hisBed ?? this.patient?.bedNo ?? this.patient?.bedNumber ?? '').trim();
    if (!raw) return '';
    return raw.endsWith('床') ? raw : raw + '床';
  }

  /**
   * 表格展示的自定义行：编辑时以草稿实时覆盖对应行（新增则追加到末尾），
   * 输入框里敲的字立刻在卡片上看到效果，保存后才落库。
   */
  get displayRows(): CustomRow[] {
    const e = this.editing;
    if (!e) return this.customRows;
    const view: CustomRow = { id: e.id ?? '__draft__', c1: e.c1, c2: e.c2 };
    if (!e.id) return [...this.customRows, view];
    const i = this.customRows.findIndex(r => r.id === e.id);
    return i < 0
      ? [...this.customRows, view]
      : [...this.customRows.slice(0, i), view, ...this.customRows.slice(i + 1)];
  }

  /**
   * 标签字号（pt）：随行数自动缩放，保证整表始终落在 12cm×9cm 卡片内。
   * 可用高度 = 卡片 9cm − 上下 padding 1cm − 标题行 1.2cm = 6.8cm；
   * 每行分得 68/行数 mm，除以单行安全需求 7.5mm（15pt×1.3 行高再留余量）得缩放比。
   * 固定 6 行（无自定义行）时比值 ≥ 1 → 恒为 15pt，现有打印格式不变。
   */
  get labelFontPt(): number {
    const rowCount = 6 + this.displayRows.length; // 姓名/床号行 + 5 行风险 + 自定义行
    const rowH = 68 / rowCount;                   // 每行可用高度（mm）
    const scale = Math.min(1, Math.max(0.5, rowH / 7.5));
    return Math.round(15 * scale * 10) / 10;
  }

  /** 编辑器顶部标识：新增标注"新增第 N 行"，修改标注"修改第 N 行"（N=该行在自定义行中的序号） */
  get editorTitle(): string {
    const e = this.editing;
    if (!e) return '';
    if (!e.id) return `新增第 ${this.customRows.length + 1} 行`;
    const i = this.customRows.findIndex(r => r.id === e.id);
    return `修改第 ${i >= 0 ? i + 1 : this.customRows.length} 行`;
  }

  print(): void { window.print(); }

  /** 新增：卡片末尾多出一行空草稿，配合下方编辑器填写内容与颜色 */
  addRow(): void {
    if (!this.patient || this.editing || this.saving) return;
    this.editing = { id: null, c1: { text: '', level: 'none' }, c2: { text: '', level: 'none' } };
  }

  /** 点击已有自定义行进入编辑（编辑期间不响应其他行的点击，先保存或取消） */
  startEdit(row: CustomRow): void {
    if (this.editing || this.saving) return;
    this.editing = { id: row.id, c1: { ...row.c1 }, c2: { ...row.c2 } };
  }

  cancelEdit(): void {
    if (!this.saving) this.editing = null;
  }

  /** 保存草稿：无 id 新增插入，有 id 覆盖更新，成功后按返回 id 落回列表 */
  saveEditing(): void {
    const draft = this.editing;
    const pid = this.getPatientPid(this.patient);
    if (!draft || !pid || this.saving) return;
    this.saving = true;
    const payload = {
      pid,
      id: draft.id,
      c1: { text: draft.c1.text.trim(), level: draft.c1.level },
      c2: { text: draft.c2.text.trim(), level: draft.c2.level },
    };
    this.http.post<{ id?: string }>(this.API_ROWS, payload).pipe(
      finalize(() => { this.saving = false; this.cdr.detectChanges(); }),
    ).subscribe({
      next: res => {
        const row: CustomRow = {
          id: String(res?.id ?? '').trim(),
          c1: { text: payload.c1.text, level: payload.c1.level },
          c2: { text: payload.c2.text, level: payload.c2.level },
        };
        const i = draft.id ? this.customRows.findIndex(r => r.id === draft.id) : -1;
        if (i >= 0) this.customRows[i] = row;
        else this.customRows.push(row);
        this.editing = null;
      },
      error: err => {
        console.error('[bedsideRiskCard] save custom row failed', err);
        alert('保存失败，请重试');
      },
    });
  }

  /** 删除当前编辑中的行（仅已保存的行，草稿行直接取消即可） */
  deleteEditing(): void {
    const draft = this.editing;
    const pid = this.getPatientPid(this.patient);
    if (!draft?.id || !pid || this.saving) return;
    if (!confirm('确定删除该行？')) return;
    this.saving = true;
    this.http.delete(`${this.API_ROWS}/${encodeURIComponent(draft.id)}`, { params: { pid } }).pipe(
      finalize(() => { this.saving = false; this.cdr.detectChanges(); }),
    ).subscribe({
      next: () => {
        this.customRows = this.customRows.filter(r => r.id !== draft.id);
        this.editing = null;
      },
      error: err => {
        console.error('[bedsideRiskCard] delete custom row failed', err);
        alert('删除失败，请重试');
      },
    });
  }

  /** 服务端行 → 前端模型（字段容错 + level 白名单） */
  private toCustomRow(raw: any): CustomRow {
    return {
      id: String(raw?.id ?? raw?._id ?? '').trim(),
      c1: { text: String(raw?.c1?.text ?? '').trim(), level: this.normLevel(raw?.c1?.level) },
      c2: { text: String(raw?.c2?.text ?? '').trim(), level: this.normLevel(raw?.c2?.level) },
    };
  }

  private normLevel(v: any): CellLevel {
    const s = String(v ?? 'none');
    return (['red', 'yellow', 'green', 'gray', 'none'].includes(s) ? s : 'none') as CellLevel;
  }

  private defaultCells(): CardCell[][] {
    const blank = (): CardCell => ({ text: '', level: 'none' });
    return [
      [{ text: '护理级别及风险防范', level: 'none' }],           // R1 标题（模板 colspan=2 渲染）
      [{ text: '特级护理', level: 'red' }, blank()],              // R2
      [{ text: '过敏史', level: 'gray' }, blank()],               // R3C1 过敏史；R3C2 防压疮
      [{ text: '饮食', level: 'gray' }, blank()],                 // R4C1 饮食；R4C2 防误吸
      [{ text: 'VTE', level: 'gray' }, blank()],                  // R5C1 VTE；R5C2 防意外拔管
      [{ text: '接触隔离', level: 'gray' }, blank()],             // R6C1 接触隔离；R6C2 空白
    ];
  }

  private getPatientPid(p: any): string {
    return String(
      p?.id ?? p?._id ?? p?.pid ?? p?.patientId ?? p?.patientID ?? p?.patient?.id ?? p?.patient?._id ?? '',
    ).trim();
  }

  private loadCardData(patient: any, pid: string): Observable<unknown> {
    this.patient = patient;
    this.loading = true;
    this.cdr.detectChanges();

    const codes = BEDSIDE_PARAMS.map(p => p.code).join(',');
    const mrn = String(patient?.mrn ?? patient?.hospitalNo ?? '').trim();

    const bedside$ = this.http.get<any>(this.API_BEDSIDE, { params: { pid, codes } }).pipe(
      retry(1),
      map(res => this.extractList(res)),
      catchError(() => of([] as BedsideRecord[])),
    );
    const extra$ = this.http.get<ExtraInfo>(this.API_EXTRA, { params: mrn ? { pid, mrn } : { pid } }).pipe(
      retry(1),
      catchError(() => of({} as ExtraInfo)),
    );
    const rows$ = this.http.get<any>(this.API_ROWS, { params: { pid } }).pipe(
      retry(1),
      map(res => this.extractList(res)),
      catchError(() => of([] as any[])),
    );

    return forkJoin({ bedside: bedside$, extra: extra$, rows: rows$ }).pipe(
      tap(({ bedside, extra, rows }) => {
        // 过期响应保护：患者已切换则丢弃
        if (pid !== this.getPatientPid(this.hostPatient.getPatient())) return;
        this.customRows = (rows as any[]).map(r => this.toCustomRow(r)).filter(r => !!r.id);
        this.editing = null;
        this.buildCells(patient, bedside as BedsideRecord[], extra);
      }),
      catchError(err => {
        console.error('[bedsideRiskCard] load failed', { pid, err });
        return of(null);
      }),
      finalize(() => {
        if (pid === this.getPatientPid(this.hostPatient.getPatient())) {
          this.loading = false;
          this.cdr.detectChanges();
        }
      }),
    );
  }

  /** 组装 6×2 单元格 —— 判定逻辑集中在此，后续调整只改这里 */
  private buildCells(patient: any, records: BedsideRecord[], extra: ExtraInfo): void {
    // 各 code 最新一条有效记录的 strVal
    const latest = this.latestValues(records);
    const level = (key: string): CellLevel => this.riskLevelOf(latest.get(key) ?? '');

    const cells = this.defaultCells();

    // R2C2 防跌倒
    cells[1][1] = { text: '防跌倒', level: level('fall') };
    // R3C1 过敏史：gms1 含"you"（有）→ 红底；gms4 有值时追加详情（如 过敏史：13）
    const allergy = extra?.allergy;
    const allergyDetail = String(allergy?.detail ?? '').trim();
    if (allergy?.hasAllergy) {
      cells[2][0] = { text: allergyDetail ? `过敏史：${allergyDetail}` : '过敏史', level: 'red' };
    } else {
      cells[2][0] = { text: '过敏史', level: 'gray' };
    }
    // R3C2 防压疮
    cells[2][1] = { text: '防压疮', level: level('pressure') };
    // R4C1 饮食：strVal 非空 → 饮食：<值> 红底；否则灰底
    const dietVal = String(latest.get('diet') ?? '').trim();
    cells[3][0] = dietVal ? { text: `饮食：${dietVal}`, level: 'red' } : { text: '饮食', level: 'gray' };
    // R4C2 防误吸
    cells[3][1] = { text: '防误吸', level: level('aspiration') };
    // R5C1 VTE：临床诊断含"深静脉血栓" → 红底
    const diagnosis = String(patient?.clinicalDiagnosis ?? patient?.diagnosis ?? '');
    cells[4][0] = { text: 'VTE', level: diagnosis.includes('深静脉血栓') ? 'red' : 'gray' };
    // R5C2 防意外拔管
    cells[4][1] = { text: '防意外拔管', level: level('extubation') };
    // R6C1 接触隔离：医嘱无停止时间/未到期 → 红底
    cells[5][0] = { text: '接触隔离', level: extra?.contactIsolation ? 'red' : 'gray' };
    // R6C2 保持空白

    this.cells = cells;
  }

  /**
   * 按 code 取最新一条有效记录的 strVal，返回 Map<key, strVal>。
   * 注意：键是 BEDSIDE_PARAMS 的短名 key（如 'diet'），供 buildCells 按 key 查找；
   * 记录里的 code（如 'param_biSiLiquid'）需经 code→key 映射，否则查找会落空。
   */
  private latestValues(records: BedsideRecord[]): Map<string, string> {
    const keyOf = new Map<string, string>();
    for (const p of BEDSIDE_PARAMS) keyOf.set(p.code, p.key);
    const latest = new Map<string, { time: number; val: string }>();
    for (const rec of records) {
      if (!rec) continue;
      if (rec.valid === false || String(rec.valid) === 'false') continue;
      const key = keyOf.get(String(rec.code ?? ''));
      if (!key) continue;
      const time = parseTimeMs(rec.time);
      const prev = latest.get(key);
      if (!prev || time >= prev.time) {
        latest.set(key, { time, val: String(rec.strVal ?? '').trim() });
      }
    }
    const result = new Map<string, string>();
    latest.forEach((v, key) => result.set(key, v.val));
    return result;
  }

  /**
   * 风险等级映射（子串包含匹配）：高/极高风险、高险、高危、高度危险 → 红；
   * 中风险、中险、中危、中度危险 → 黄；低风险、低险、低危、低度危险 → 绿；未评估/其他 → 灰。
   * 库里实际存值示例："11(高度危险)"、"11(高危)"、"16(低危)"、"低风险"。
   */
  private riskLevelOf(val: string): CellLevel {
    const v = val.trim();
    if (!v) return 'gray';
    if (v.includes('高风险') || v.includes('高险') || v.includes('高危') || v.includes('高度危险')) return 'red';
    if (v.includes('中风险') || v.includes('中险') || v.includes('中危') || v.includes('中度危险')) return 'yellow';
    if (v.includes('低风险') || v.includes('低险') || v.includes('低危') || v.includes('低度危险')) return 'green';
    return 'gray';
  }

  private extractList(res: any): any[] {
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.data)) return res.data;
    if (Array.isArray(res?.records)) return res.records;
    if (Array.isArray(res?.content)) return res.content;
    if (Array.isArray(res?.list)) return res.list;
    return [];
  }
}

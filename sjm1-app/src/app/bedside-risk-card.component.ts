/**
 * 床头卡危险风险标识 —— Angular 组件
 * 访问路径：/form/bedsideRiskCardForm
 * 通过握手机制（HostPatientService）获取当前患者，按 6 行 × 2 列表格动态渲染护理级别及风险防范：
 *  - R1          标题行（合并两列）：护理级别及风险防范
 *  - R2C1 特级护理（固定红底白字）      R2C2 防跌倒   bedside param_score_patientFallDangerFactorV2 最新一条 strVal
 *  - R3C1 过敏史 dFormData gms1/gms4   R3C2 防压疮   bedside param_yaChuang_score 最新一条 strVal
 *  - R4C1 饮食   bedside param_biSiLiquid 最新一条   R4C2 防误吸 bedside param_score_mechanicalAspirationRisk 最新一条
 *  - R5C1 VTE    clinicalDiagnosis 含"深静脉血栓"    R5C2 防意外拔管 bedside param_score_unPlannedCGZYY 最新一条
 *  - R6C1 解除隔离 DataCenter VI_ICU_ZYYZ 医嘱        R6C2 空白
 * 风险等级配色：高/极高风险红底白字、中风险黄底白字、低风险绿底白字、未评估灰底白字。
 * 打印：前端浏览器打印，A4 纵向，卡片为半张 A4（210mm × 148.5mm），占上半页。
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

interface BedsideRecord {
  pid?: string;
  code?: string;
  time?: string;
  strVal?: string;
  valid?: boolean | string | number;
}

interface ExtraInfo {
  allergy?: { hasAllergy?: boolean; detail?: string };
  removeIsolation?: boolean;
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
        <button class="btn" type="button" (click)="print()" [disabled]="loading || !patient">打印</button>
      </div>

      <div class="wait-hint no-print" *ngIf="!patient">等待患者信息（握手机制）…</div>
      <div class="loading no-print" *ngIf="loading">风险评估加载中…</div>

      <div class="preview" *ngIf="patient">
        <div class="card">
          <table class="risk-table">
            <tbody>
              <tr class="title-row">
                <td colspan="2" class="title-cell">护理级别及风险防范</td>
              </tr>
              <tr *ngFor="let row of cellRows">
                <td *ngFor="let cell of row" [ngClass]="cell.level">
                  <span class="label">{{ cell.text }}</span>
                </td>
              </tr>
            </tbody>
          </table>
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
    .wait-hint, .loading { padding: 28px; text-align: center; color: #64748b; font-size: 14px; }
    .preview { padding: 16px 0; display: flex; justify-content: center; }

    /* 卡片 = 半张 A4（210mm × 148.5mm），距顶 5mm；纸张边框不画，只有表格黑框 */
    .card {
      box-sizing: border-box;
      width: 210mm; height: 148.5mm;
      padding: 5mm;
      background: #fff;
      overflow: hidden;
    }

    /* 6 行 × 2 列风险标识表格 */
    .risk-table {
      box-sizing: border-box;
      width: 100%; height: 100%;
      border-collapse: collapse;
      table-layout: fixed;
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
      font-size: 15pt; font-weight: 700; line-height: 1.3;
      white-space: nowrap;
    }
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

    @media print {
      @page { size: A4 portrait; margin: 0; }
      :host { display: block; width: auto; margin: 0 !important; padding: 0 !important; overflow: visible; }
      .no-print { display: none !important; }
      .preview { padding: 0 !important; display: block !important; }
      .card {
        box-sizing: border-box;
        width: 210mm !important; height: 148.5mm !important;
        margin: 0 !important; padding: 5mm !important;
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
    }
  `],
})
export class BedsideRiskCardComponent implements OnInit, OnDestroy {
  private readonly API_BEDSIDE = '/api/v1/icu/bedside/listByPid';
  private readonly API_EXTRA = '/api/v1/icu/bedside-risk-card/extra-info';
  private readonly destroy$ = new Subject<void>();

  patient: any | null = null;
  loading = false;
  /** 各单元格（6 行 × 2 列） */
  cells: CardCell[][] = this.defaultCells();

  constructor(
    private readonly http: HttpClient,
    private readonly hostPatient: HostPatientService,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    // 主患者流：握手拿到患者后拉取 bedside 参数 + 补充信息（过敏史/解除隔离）
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

  print(): void { window.print(); }

  private defaultCells(): CardCell[][] {
    const blank = (): CardCell => ({ text: '', level: 'none' });
    return [
      [{ text: '护理级别及风险防范', level: 'none' }],           // R1 标题（模板 colspan=2 渲染）
      [{ text: '特级护理', level: 'red' }, blank()],              // R2
      [{ text: '过敏史', level: 'gray' }, blank()],               // R3C1 过敏史；R3C2 防压疮
      [{ text: '饮食', level: 'gray' }, blank()],                 // R4C1 饮食；R4C2 防误吸
      [{ text: 'VTE', level: 'gray' }, blank()],                  // R5C1 VTE；R5C2 防意外拔管
      [{ text: '解除隔离', level: 'gray' }, blank()],             // R6C1 解除隔离；R6C2 空白
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

    return forkJoin({ bedside: bedside$, extra: extra$ }).pipe(
      tap(({ bedside, extra }) => {
        // 过期响应保护：患者已切换则丢弃
        if (pid !== this.getPatientPid(this.hostPatient.getPatient())) return;
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
    // R3C1 过敏史：gms1 有值 → 红底；gms4 有值时追加详情（如 过敏史123）
    const allergy = extra?.allergy;
    const allergyDetail = String(allergy?.detail ?? '').trim();
    if (allergy?.hasAllergy) {
      cells[2][0] = { text: allergyDetail ? `过敏史${allergyDetail}` : '过敏史', level: 'red' };
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
    // R6C1 解除隔离：医嘱无停止时间/未到期 → 红底
    cells[5][0] = { text: '解除隔离', level: extra?.removeIsolation ? 'red' : 'gray' };
    // R6C2 保持空白

    this.cells = cells;
  }

  /** 按 code 取最新一条有效记录的 strVal */
  private latestValues(records: BedsideRecord[]): Map<string, string> {
    const latest = new Map<string, { time: number; val: string }>();
    for (const rec of records) {
      if (!rec) continue;
      if (rec.valid === false || String(rec.valid) === 'false') continue;
      const code = String(rec.code ?? '');
      if (!code) continue;
      const time = parseTimeMs(rec.time);
      const prev = latest.get(code);
      if (!prev || time >= prev.time) {
        latest.set(code, { time, val: String(rec.strVal ?? '').trim() });
      }
    }
    const result = new Map<string, string>();
    latest.forEach((v, code) => result.set(code, v.val));
    return result;
  }

  /**
   * 风险等级映射：高/极高风险（含"高险"简写）→ 红；中风险 → 黄；低风险 → 绿；未评估 → 灰。
   */
  private riskLevelOf(val: string): CellLevel {
    const v = val.trim();
    if (!v) return 'gray';
    if (v.includes('高风险') || v.includes('高险')) return 'red';
    if (v.includes('中风险') || v.includes('中险')) return 'yellow';
    if (v.includes('低风险') || v.includes('低险')) return 'green';
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

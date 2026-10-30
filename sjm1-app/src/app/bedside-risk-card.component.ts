/**
 * 床头卡危险风险标识 —— Angular 组件
 * 访问路径：/form/bedsideRiskCardForm
 * 通过握手机制（HostPatientService）获取当前患者，按评估结果动态填充风险标识表格：
 * 卡面为 5 列 × 2 行黑框表格，(1,1) 固定特级护理（红底黑字），其余单元格按风险顺序填充。
 * 打印：前端浏览器打印，A4 纵向，卡片为半张 A4（210mm × 148.5mm），占上半页。
 * 风险判定逻辑后续由业务确认，当前为默认占位实现（见 buildRiskFlags）。
 */
import { HttpClient } from '@angular/common/http';
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { forkJoin, Observable, of, Subject } from 'rxjs';
import { catchError, distinctUntilChanged, filter, finalize, map, retry, switchMap, takeUntil, tap } from 'rxjs/operators';
import { HostPatientService } from './services/host-patient.service';

/** 风险列定义（填充顺序固定） */
interface RiskDef {
  code: string;
  label: string;
  /** 评分类型；null = 数据源待定（TODO），暂不参与评估、不填充 */
  scoreType: string | null;
  /** 判定关键词：最新有效记录的 conclusion 包含任一即有风险 */
  keywords: string[];
}

const RISK_DEFS: RiskDef[] = [
  { code: 'specialCare', label: '特级护理', scoreType: null, keywords: [] }, // TODO 数据源待定，当前固定占位 (1,1)
  { code: 'fallDanger', label: '跌倒', scoreType: 'patientFallDangerLJRMYY', keywords: ['高'] },
  { code: 'pressureInjury', label: '压疮', scoreType: 'bradenScore', keywords: ['高'] },
  { code: 'tubeSlip', label: '管道滑脱', scoreType: 'unPlannedCGZYYScore', keywords: ['高'] },
  { code: 'suicide', label: '自杀', scoreType: 'commitSuicideScore', keywords: ['高'] },
];

/** 表格规格：5 列 × 2 行，共 10 格 */
const TABLE_COLS = 5;
const TABLE_ROWS = 2;
const TABLE_CELLS = TABLE_COLS * TABLE_ROWS;
/** (1,1) 默认内容 */
const DEFAULT_CELL = '特级护理';

/** 渲染到卡面的风险标识 */
interface RiskFlag {
  code: string;
  label: string;
}

interface ScoreRecord {
  time?: string;
  scoreType?: string;
  conclusion?: string;
  valid?: boolean | string | number;
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
      <div class="wait-hint no-print" *ngIf="patient && loaded && !loading && riskFlags.length === 0">
        当前患者未识别到风险标识。
      </div>

      <div class="preview" *ngIf="patient">
        <div class="card">
          <table class="risk-table">
            <tbody>
              <tr *ngFor="let row of cellRows">
                <td *ngFor="let cell of row" [class.filled]="!!cell">
                  <span class="label" *ngIf="cell">{{ cell }}</span>
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

    /* 卡片 = 半张 A4（210mm × 148.5mm），黑色边框，距顶 5mm */
    .card {
      box-sizing: border-box;
      width: 210mm; height: 148.5mm;
      padding: 5mm;
      background: #fff;
      border: 1.5px solid #000;
      overflow: hidden;
    }

    /* 5 列 × 2 行风险标识表格 */
    .risk-table {
      box-sizing: border-box;
      width: 100%; height: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    .risk-table td {
      box-sizing: border-box;
      width: 20%; height: 50%;
      border: 1.5px solid #000;
      text-align: center; vertical-align: middle;
      padding: 0;
    }
    .risk-table td.filled { background: #d32f2f; }
    .risk-table td .label {
      writing-mode: vertical-rl;
      text-orientation: upright;
      font-family: 'SimHei', '黑体', sans-serif;
      font-size: 24pt; font-weight: 700; line-height: 1.2;
      color: #000;                     /* 字体黑色 */
      letter-spacing: 0.2em;
      white-space: nowrap;
    }

    @media print {
      @page { size: A4 portrait; margin: 0; }
      :host { display: block; width: auto; margin: 0 !important; padding: 0 !important; overflow: visible; }
      .no-print { display: none !important; }
      .preview { padding: 0 !important; display: block !important; }
      .card {
        box-sizing: border-box;
        width: 210mm !important; height: 148.5mm !important;
        margin: 0 !important; padding: 5mm !important;
        border: 1.5px solid #000 !important; box-shadow: none !important;
        overflow: hidden !important;
        -webkit-print-color-adjust: exact; print-color-adjust: exact; /* 红底需随打印输出 */
        page-break-after: always; break-after: page;
      }
      .card:last-of-type { page-break-after: auto; break-after: auto; }
      .risk-table td { border: 1.5px solid #000 !important; }
      .risk-table td.filled {
        background: #d32f2f !important;
        -webkit-print-color-adjust: exact; print-color-adjust: exact;
      }
      .risk-table td .label { color: #000 !important; }
    }
  `],
})
export class BedsideRiskCardComponent implements OnInit, OnDestroy {
  private readonly API_SCORE = '/api/v1/icu/score/listByPid';
  private readonly destroy$ = new Subject<void>();

  patient: any | null = null;
  loading = false;
  loaded = false;
  riskFlags: RiskFlag[] = [];

  constructor(
    private readonly http: HttpClient,
    private readonly hostPatient: HostPatientService,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    // 主患者流：握手拿到患者后按 pid 拉取各风险评分
    this.hostPatient.patient$.pipe(
      map(p => ({ p, pid: this.getPatientPid(p) })),
      filter(x => !!x.pid),
      distinctUntilChanged((a, b) => a.pid === b.pid),
      switchMap(({ p, pid }) => this.loadRiskFlags(p, pid)),
      takeUntil(this.destroy$),
    ).subscribe({
      error: err => console.error('[bedsideRiskCard] patient stream error', err),
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * 表格单元格（5×2=10 格）：
   * (1,1) 固定默认「特级护理」，其余按风险标识顺序从左到右、从上到下填充，空格留白。
   * TODO: 后续业务逻辑可能按需隐藏/替换默认格。
   */
  get cellRows(): (string | null)[][] {
    const cells: (string | null)[] = [DEFAULT_CELL, ...this.riskFlags.map(f => f.label)];
    while (cells.length < TABLE_CELLS) cells.push(null);
    const flat = cells.slice(0, TABLE_CELLS);
    const rows: (string | null)[][] = [];
    for (let r = 0; r < TABLE_ROWS; r++) {
      rows.push(flat.slice(r * TABLE_COLS, (r + 1) * TABLE_COLS));
    }
    return rows;
  }

  print(): void { window.print(); }

  private getPatientPid(p: any): string {
    return String(
      p?.id ?? p?._id ?? p?.pid ?? p?.patientId ?? p?.patientID ?? p?.patient?.id ?? p?.patient?._id ?? '',
    ).trim();
  }

  private loadRiskFlags(patient: any, pid: string): Observable<unknown> {
    this.patient = patient;
    this.loading = true;
    this.loaded = false;
    this.cdr.detectChanges();

    const reqs: Record<string, Observable<ScoreRecord[] | null>> = {};
    for (const def of RISK_DEFS) {
      if (!def.scoreType) continue; // 数据源待定的暂不请求
      reqs[def.code] = this.http.get<any>(this.API_SCORE, { params: { pid, scoreType: def.scoreType } }).pipe(
        retry(1),
        map(res => this.extractScoreList(res)),
        catchError(() => of(null as ScoreRecord[] | null)),
      );
    }

    return forkJoin(reqs).pipe(
      tap(scoreMap => {
        // 过期响应保护：患者已切换则丢弃
        if (pid !== this.getPatientPid(this.hostPatient.getPatient())) return;
        this.riskFlags = this.buildRiskFlags(scoreMap);
      }),
      catchError(err => {
        console.error('[bedsideRiskCard] score API failed', { pid, err });
        if (pid === this.getPatientPid(this.hostPatient.getPatient())) this.riskFlags = [];
        return of(null);
      }),
      finalize(() => {
        if (pid === this.getPatientPid(this.hostPatient.getPatient())) {
          this.loading = false;
          this.loaded = true;
          this.cdr.detectChanges();
        }
      }),
    );
  }

  /**
   * 风险判定 —— 逻辑替换点。
   * TODO: 具体判定规则待业务确认后仅需修改本方法；当前默认实现为
   * 「各评分类型最新一条有效记录的 conclusion 含关键词（如"高"）即有风险」。
   */
  private buildRiskFlags(scoreMap: Record<string, ScoreRecord[] | null>): RiskFlag[] {
    const flags: RiskFlag[] = [];
    for (const def of RISK_DEFS) {
      if (!def.scoreType || !def.keywords.length) continue;
      const validRows = (scoreMap[def.code] || [])
        .filter(r => r && (r.valid === true || String(r.valid) === 'true'));
      if (!validRows.length) continue;
      // 最新一条（time 倒序）
      const latest = [...validRows].sort((a, b) => String(b?.time || '').localeCompare(String(a?.time || '')))[0];
      const conclusion = String(latest?.conclusion || '');
      if (def.keywords.some(k => conclusion.includes(k))) {
        flags.push({ code: def.code, label: def.label });
      }
    }
    return flags;
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
}

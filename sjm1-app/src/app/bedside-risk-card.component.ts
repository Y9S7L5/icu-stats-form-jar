/**
 * 床头卡危险风险标识 —— Angular 组件
 * 访问路径：/form/bedsideRiskCardForm
 * 通过握手机制（HostPatientService）获取当前患者，按评估结果动态渲染风险标识列：
 * 仅有风险的列才出现，列序固定。卡面仅风险标识区（不含患者信息）。
 * 打印：前端浏览器打印，A4 纵向，卡片为半张 A4（210mm × 148.5mm），每张 A4 默认出 2 张。
 * 风险判定逻辑后续由业务确认，当前为默认占位实现（见 buildRiskFlags）。
 */
import { HttpClient } from '@angular/common/http';
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { forkJoin, Observable, of, Subject } from 'rxjs';
import { catchError, distinctUntilChanged, filter, finalize, map, retry, switchMap, takeUntil, tap } from 'rxjs/operators';
import { HostPatientService } from './services/host-patient.service';

/** 风险列定义（列序固定） */
interface RiskDef {
  code: string;
  label: string;
  /** 评分类型；null = 数据源待定（TODO），暂不参与评估、不渲染 */
  scoreType: string | null;
  /** 判定关键词：最新有效记录的 conclusion 包含任一即有风险 */
  keywords: string[];
}

const RISK_DEFS: RiskDef[] = [
  { code: 'specialCare', label: '特级护理', scoreType: null, keywords: [] }, // TODO 数据源待定
  { code: 'fallDanger', label: '跌倒', scoreType: 'patientFallDangerLJRMYY', keywords: ['高'] },
  { code: 'pressureInjury', label: '压疮', scoreType: 'bradenScore', keywords: ['高'] },
  { code: 'tubeSlip', label: '管道滑脱', scoreType: 'unPlannedCGZYYScore', keywords: ['高'] },
  { code: 'suicide', label: '自杀', scoreType: 'commitSuicideScore', keywords: ['高'] },
];

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
        <span class="copies-field">
          <label>每张A4份数：</label>
          <select [(ngModel)]="copies">
            <option [ngValue]="1">1（仅上半页）</option>
            <option [ngValue]="2">2（整页两张）</option>
          </select>
        </span>
        <button class="btn" type="button" (click)="print()" [disabled]="loading || !patient">打印</button>
      </div>

      <div class="wait-hint no-print" *ngIf="!patient">等待患者信息（握手机制）…</div>
      <div class="loading no-print" *ngIf="loading">风险评估加载中…</div>
      <div class="wait-hint no-print" *ngIf="patient && loaded && !loading && riskFlags.length === 0">
        当前患者未识别到风险标识，仍可打印（卡面为空白标识区）。
      </div>

      <div class="preview" *ngIf="patient">
        <div class="preview-label no-print">A4 纵向 · 每张卡片 = 半页（210mm × 148.5mm），沿中线裁开</div>
        <div class="card" *ngFor="let i of cardSlots">
          <div class="strip" *ngIf="riskFlags.length > 0">
            <div class="risk-col" *ngFor="let f of riskFlags">
              <span class="risk-label">{{ f.label }}</span>
            </div>
          </div>
          <div class="empty-strip" *ngIf="riskFlags.length === 0">
            <span class="no-risk print-hidden">无风险标识</span>
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
    .copies-field label { font-size: 13px; color: #334155; }
    .copies-field select { font-size: 13px; padding: 3px 6px; }
    .btn {
      padding: 6px 24px; font-size: 14px; cursor: pointer;
      background: #2563eb; color: #fff; border: none; border-radius: 4px;
    }
    .btn:disabled { cursor: not-allowed; opacity: .55; }
    .wait-hint, .loading { padding: 28px; text-align: center; color: #64748b; font-size: 14px; }
    .preview { padding: 16px 0; display: flex; flex-direction: column; align-items: center; }
    .preview-label { color: #94a3b8; font-size: 12px; margin-bottom: 8px; }

    /* 卡片 = 半张 A4（210mm × 148.5mm） */
    .card {
      box-sizing: border-box;
      width: 210mm; height: 148.5mm;
      padding: 12mm 14mm;
      background: #fff;
      border: 1px dashed #cbd5e1;      /* 屏幕参考边线（打印隐藏） */
      display: flex; align-items: center;
      overflow: hidden;
    }

    /* 风险标识条：外框 + 列间竖分隔线 + 横贯分隔线（复刻手绘版式） */
    .strip {
      box-sizing: border-box;
      position: relative;
      display: flex;
      width: 100%; height: 112mm;
      border: 3px solid #d32f2f;
    }
    .strip::after {
      content: '';
      position: absolute; left: 0; right: 0; top: 45%;
      border-top: 2.5px solid #d32f2f;
      pointer-events: none;
    }
    .risk-col {
      box-sizing: border-box;
      flex: 0 0 38mm;                 /* 列宽固定，左侧排列，余量留白（右侧可扩展） */
      border-right: 2.5px solid #d32f2f;
      display: flex; justify-content: center;
      padding-top: 6mm;
    }
    .risk-col:last-child { border-right: none; }
    .risk-label {
      writing-mode: vertical-rl;
      text-orientation: upright;
      font-family: 'SimHei', '黑体', sans-serif;
      font-size: 24pt; font-weight: 700; line-height: 1.15;
      color: #c62828;
      letter-spacing: 0.2em;
      white-space: nowrap;
    }

    .empty-strip {
      box-sizing: border-box;
      width: 100%; height: 112mm;
      border: 3px solid #d32f2f;
      display: flex; align-items: center; justify-content: center;
    }
    .no-risk { color: #94a3b8; font-size: 18pt; letter-spacing: 0.3em; }

    @media print {
      @page { size: A4 portrait; margin: 0; }
      :host { display: block; width: auto; margin: 0 !important; padding: 0 !important; overflow: visible; }
      .no-print { display: none !important; }
      .print-hidden { display: none !important; }
      .preview { padding: 0 !important; display: block !important; }
      .preview-label { display: none !important; }
      .card {
        box-sizing: border-box;
        width: 210mm !important; height: 148.5mm !important;
        margin: 0 !important; padding: 12mm 14mm !important;
        border: none !important; box-shadow: none !important;
        overflow: hidden !important;
        page-break-after: always; break-after: page;
      }
      .card:last-of-type { page-break-after: auto; break-after: auto; }
      .strip, .empty-strip { border-color: #d32f2f !important; }
      .strip::after { border-top-color: #d32f2f !important; }
      .risk-label { color: #c62828 !important; }
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
  /** 每张 A4 打印份数（半页一张，最多两张） */
  copies = 2;

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

  get cardSlots(): number[] {
    return Array.from({ length: this.copies }, (_, i) => i);
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

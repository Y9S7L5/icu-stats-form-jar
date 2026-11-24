import { HttpClient, HttpParams } from '@angular/common/http';
import { AfterViewChecked, ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit } from '@angular/core';
import { of, Subject } from 'rxjs';
import { map, switchMap, takeUntil } from 'rxjs/operators';
import { HostPatientService } from './services/host-patient.service';
import { IcuFormViewerContextService } from './icu-form-viewer-context.service';
import { databaseTimeValue, formatShanghaiDate, formatShanghaiHourMinute } from './form-date.util';
import { normalizePrintPages, shouldPrintPage } from './form-print-pages.util';
import { firstDiagnosisSegment, resolveBlankDiagnosis, resolveDiagnosisDisplay } from './diagnosis-history.util';
import { DiagnosisHistoryService } from './diagnosis-history.service';

interface BedsideRecord { pid: string|number; code: string; time: string; strVal?: string; valid: boolean|string|number; editUser?: string; }

/** 审核护士签名持久化（复用 fall-danger-extra，按 pid+formCode 区分表单） */
const FORM_CODE = 'crrtForm';
const API_EXTRA_LATEST = '/api/v1/icu/fall-danger-extra/latest';
const API_EXTRA_SAVE = '/api/v1/icu/fall-danger-extra/save';
const API_ACCOUNT_ALL = '/api/v1/icu/accounts';
interface CrrtMetric { label: string; code: string; unit?: string; }
interface CrrtGroup { name: string; metrics: CrrtMetric[]; }
interface TimePoint { instant: number; rawTime: string; }
interface RenderPage { index: number; timeInstants: number[]; diagnosis?: string; }
interface CrrtStatusPoint { instant: number; treatmentStatus: string; }
type CrrtSessionStatus = 'ongoing' | 'ended';
interface CrrtSession { index: number; points: CrrtStatusPoint[]; startInstant: number; endInstant: number; allTimeInstants: number[]; pageTimeInstants: number[][]; status: CrrtSessionStatus; }

const CRRT_GROUPS: CrrtGroup[] = [
  { name: '治疗模式', metrics: [
    { label: '治疗模式', code: 'param_CBP_Mode' },
    { label: '治疗状态', code: 'param_CRRT治疗状态' },
  ]},
  { name: '抗凝方式', metrics: [
    { label: '抗凝剂1名称', code: 'param_抗凝剂1' },
    { label: '抗凝剂1速度', code: 'param_抗凝剂速度' },
    { label: '抗凝剂2名称', code: 'param_抗凝剂2' },
    { label: '抗凝剂2速度', code: 'param_抗凝剂2速度' },
  ]},
  { name: '治疗处方', metrics: [
    { label: '血流速度', code: 'param_CBP_set_Blood_Flow' },
    { label: '前置换速度', code: 'param_CBP_set_PRE_REPL_Flow' },
    { label: '后置换速度', code: 'param_CBP_set_POST_REPL_Flow' },
    { label: '置换液更换', code: 'param_置换液更换' },
    { label: '透析液速度', code: 'param_CBP_set_DIAL_Flow' },
    { label: '透析液更换', code: 'param_透析液更换' },
    { label: '碳酸氢钠速度', code: 'param_CBP_tanSQNZS' },
    { label: '葡萄糖酸钙速度', code: 'param_葡萄糖酸钙' },
  ]},
  { name: '治疗参数', metrics: [
    { label: '超滤率', code: 'param_CBP_set_UFR' },
    { label: '超滤量/总脱水量', code: 'param_净超滤量2' },
    { label: '生理盐水', code: 'param_生理盐水' },
    { label: '净超滤量', code: 'param_超滤量2' },
    { label: '分浆速度', code: 'param_分浆速度' },
    { label: '弃浆速度', code: 'param_弃浆速度' },
    { label: '补浆速度', code: 'param_补浆速度' },
    { label: '血浆置换总量', code: 'param_血浆置换总量' },
  ]},
  { name: '压力参数', metrics: [
    { label: '动脉压PA', code: 'param_CBP_dongMY' },
    { label: '静脉压PV', code: 'param_CBP_jingMY' },
    { label: '滤前压PBE', code: 'param_滤前压PBE' },
    { label: '跨膜压TMP', code: 'param_CBP_kuaMY' },
  ]},
  { name: '治疗监测', metrics: [
    { label: '滤器前钙', code: 'param_滤器前钙' },
    { label: '滤器后钙', code: 'param_滤器后钙' },
    { label: '滤器前APTT', code: 'param_滤器前APTT' },
    { label: '滤器后APTT', code: 'param_滤器后APTT' },
    { label: '穿刺点情况', code: 'param_CBP_chuanCiDian' },
  ]},
  { name: '下机', metrics: [
    { label: '体外循环凝血等级', code: 'param_滤器凝血等级' },
  ]},
  { name: '备注', metrics: [
    { label: '备注', code: 'param_备注' },
  ]},
];

/* =========================================================
   行高纯数值确定性计算（无 DOM 反馈回路）：
   行高 = (A4 高 − 上方固定区 − 底部封顶线 − 留白 − 表头高) ÷ 可见行数，
   夹逼 [ROW_MIN_PX, ROW_MAX_PX]；屏幕 px 与打印 mm 按 96dpi 同源换算。
   上方固定区（标题/场次/患者信息/诊断）由渲染后单次测量 table.offsetTop 取得
   （诊断可换行，不能用常数）；打印与屏幕的固定区 CSS 按 96dpi 等价契约统一，
   见 crrt-record.component.css 打印段注释。
   ========================================================= */
const PX_PER_MM = 96 / 25.4;
/** A4 屏幕高度(px)，96dpi 下 297mm ≈ 1123px */
const SHEET_H_PX = 1123;
/** 表头行(time-header)高度(px)：内容 nowrap 不换行，可用常数 */
const HEAD_PX = 24;
/** 行高下限(px)：单元格行地板 ≈23px（20px 行高 + 上下 padding + 边框），必须 ≥ 地板 */
const ROW_MIN_PX = 24;
/** 行高上限(px)，数据过少时不再继续撑高 */
const ROW_MAX_PX = 41;
/** 表格底边与底部封顶线之间的留白(px) */
const ROW_GAP_PX = 21;
/**
 * 表格封顶线：距 sheet 底边的距离(px)，表格底边不得越过。
 * 与页码位置解耦（页码固定 bottom:30px，见 crrt-record.component.css），
 * 页码文字占 30~46px，封顶线 35 + 留白 21 → 表格实际停在 56px，压不到页码。
 */
const SHEET_BOTTOM_PX = 35;
/** 首帧未测得上方固定区时的兜底值(px)：取偏大 → 首帧行高偏小（不满页），不会溢出 */
const TABLE_TOP_FALLBACK_PX = 180;

@Component({
  standalone: false, selector: 'app-crrt-record',
  templateUrl: './crrt-record.component.html', styleUrls: ['./crrt-record.component.css'],
})
export class CrrtRecordComponent implements OnInit, OnDestroy, AfterViewChecked {
  private readonly API = '/api/v1/icu/bedside';
  private readonly destroy$ = new Subject<void>();
  private readonly values = new Map<string, string>();
  private yishiRecords: Array<{ instant: number; editUser: string }> = [];
  private accountNameMap = new Map<string, string>();

  readonly groups = CRRT_GROUPS;
  readonly metricCodes = CRRT_GROUPS.flatMap(g => g.metrics.map(m => m.code));
  readonly queryCodes = Array.from(new Set([...this.metricCodes, 'param_Yishi']));
  readonly columnIndexes = [0, 1, 2, 3, 4, 5, 6, 7];

  sessions: CrrtSession[] = [];
  selectedSession: CrrtSession | null = null;
  selectedSessionId: number | null = null;
  visibleGroupsForSession: CrrtGroup[] = [];
  /** 表格上方固定区实测高度(px)，0 = 未测量。见 ngAfterViewChecked() */
  private tableTopPx = 0;
  /** 防止微任务重检堆积 */
  private topCheckScheduled = false;
  /** 组件已销毁时跳过微任务重检 */
  private destroyed = false;
  /** 行数溢出告警只发一次 */
  private overflowWarned = false;

  get sessionOptions(): Array<{ id: number; label: string }> {
    return this.sessions.map(s => ({
      id: s.index,
      label: `第 ${s.index} 场 (${this.sessionStartText(s)})${s.status === 'ongoing' ? ' — 治疗中' : ''}`,
    }));
  }
  patient: any = null; account: any = null;
  pid = ''; age: number | null = null; diagnosisDisplay = '';
  loading = false; loadError = '';
  selectedPrintPages: number[] = [];
  printing = false;

  // Viewer 模式标志
  isViewerMode = false;

  // 审核者签名
  auditorName = ''; auditorId = ''; auditorQuery = ''; auditorOpen = false;
  accountList: { accountId: string; accountName: string }[] = [];
  private blurTimer: any = null;
  private readonly AUDITOR_BLOCK = ['工程师', '美康', '他科带入', '外院带入', '其他账号'];

  constructor(private host: ElementRef<HTMLElement>, private http: HttpClient, private hostPatient: HostPatientService, private cdr: ChangeDetectorRef, private contextService: IcuFormViewerContextService, private diagHistory: DiagnosisHistoryService) {}

  ngOnInit(): void {
    // 检测 viewer 模式
    this.contextService.getContext$().pipe(
      takeUntil(this.destroy$),
    ).subscribe(ctx => {
      this.isViewerMode = ctx.isViewerMode;
      this.cdr.markForCheck();
    });

    this.hostPatient.account$.pipe(takeUntil(this.destroy$)).subscribe(a => this.account = a);
    this.loadAccountList();
    this.hostPatient.patient$.pipe(
      takeUntil(this.destroy$),
      switchMap(p => {
        if (!p?.id) return of(null);
        const next = String(p.id).trim();
        if (!next) return of(null);
        return this.diagHistory.ensurePatient(p).pipe(map(ep => ({ p: ep, pid: next })));
      }),
    ).subscribe(v => {
      if (!v) { this.reset(); return; }
      const { p, pid: next } = v;
      const prev = this.pid;
      this.patient = p; this.pid = next;
      this.age = this.calcAge(p.birthday);
      this.diagnosisDisplay = this.formatDiagnosis(p.clinicalDiagnosis);
      if (next !== prev) {
        this.values.clear(); this.yishiRecords = []; this.accountNameMap.clear(); this.sessions = []; this.selectedSession = null; this.selectedSessionId = null; this.visibleGroupsForSession = []; this.selectedPrintPages = [];
        this.auditorName = ''; this.auditorId = ''; this.auditorQuery = ''; this.auditorOpen = false;
        this.loadAuditor();
        this.load();
      }
    });
  }

  ngOnDestroy(): void { this.destroyed = true; this.destroy$.next(); this.destroy$.complete(); }

  /** 可见数据行数 = 各组指标数之和 + 签名行 */
  private get visibleRowCount(): number {
    return this.visibleGroupsForSession.reduce((n, g) => n + g.metrics.length, 0) + 1;
  }

  /**
   * 渲染后单次测量表格上方固定区（标题/场次/患者信息/诊断）的高度。
   * offsetTop 是布局像素，不受祖先缩放影响；print-hidden(display:none) 页
   * 测得 0，天然跳过。多页取最大值（诊断最长的页最紧），全页共用同一行高。
   */
  private measureTableTopPx(): number {
    let max = 0;
    this.host.nativeElement.querySelectorAll<HTMLElement>('.sheet').forEach(sheet => {
      const table = sheet.querySelector<HTMLElement>('.crrt-table');
      const top = table ? table.offsetTop : 0;
      if (top > max) max = top;
    });
    return max;
  }

  /**
   * 测量上方固定区，变化 ≥1px 时更新字段并延迟到微任务重检。
   * rowStyle 是纯函数 getter（只读字段），若在本轮 CD 内同步改字段，
   * 紧随其后的 checkNoChanges 会读到新值 → ExpressionChangedAfterItHasBeenChecked，
   * 因此必须把 detectChanges 推迟到微任务；flag 防止连续变更堆积重检。
   * tableTop 只取决于表格上方元素、与行高无因果，故一轮收敛不震荡。
   */
  ngAfterViewChecked(): void {
    const next = this.measureTableTopPx();
    if (next > 0 && Math.abs(next - this.tableTopPx) >= 1) {
      this.tableTopPx = next;
      if (!this.topCheckScheduled) {
        this.topCheckScheduled = true;
        Promise.resolve().then(() => {
          this.topCheckScheduled = false;
          if (!this.destroyed) this.cdr.detectChanges();
        });
      }
    }
  }

  /**
   * 行高纯数值计算，写成 <table> 的内联样式，由模板绑定维护。
   * pages 是 getter，每次变更检测返回新数组，*ngFor 无 trackBy 会重建整个表格 DOM，
   * 命令式写入的内联变量会被清空；绑定则在元素创建时就套用，克隆/打印稿也能拿到。
   *
   * 可行高度 = A4 高 − 封顶线 − 留白 − 上方固定区实测 − 表头；
   * 行高 = 可行高度 ÷ 可见行数，夹逼 [ROW_MIN_PX, ROW_MAX_PX]；
   * 打印 mm 由 px 按 96dpi 同源换算，屏幕与打印几何一致（CSS 等价契约）。
   */
  get rowStyle(): string {
    const rows = Math.max(1, this.visibleRowCount);
    const top = this.tableTopPx > 0 ? this.tableTopPx : TABLE_TOP_FALLBACK_PX;
    const avail = SHEET_H_PX - SHEET_BOTTOM_PX - ROW_GAP_PX - top - HEAD_PX;
    const perPx = Math.min(ROW_MAX_PX, Math.max(ROW_MIN_PX, avail / rows));
    // 纯算术预检：行多到夹到下限仍装不下时告警（只告警不修正，不引入反馈回路）
    if (!this.overflowWarned && ROW_MIN_PX * rows + HEAD_PX + top > SHEET_H_PX - SHEET_BOTTOM_PX - ROW_GAP_PX) {
      this.overflowWarned = true;
      console.warn(`CRRT记录单内容超出可用高度（可见行数=${rows}），行高已夹到下限，表格可能被裁切`);
    }
    return `--crrt-row-px:${perPx.toFixed(1)}px;--crrt-row-mm:${(perPx / PX_PER_MM).toFixed(3)}mm`;
  }
  private reset(): void { this.pid = ''; this.patient = null; this.values.clear(); this.yishiRecords = []; this.accountNameMap.clear(); this.sessions = []; this.selectedSession = null; this.selectedSessionId = null; this.visibleGroupsForSession = []; this.selectedPrintPages = []; this.auditorName = ''; this.auditorId = ''; this.auditorQuery = ''; this.auditorOpen = false; }

  load(): void {
    if (!this.pid) return;
    const requestPid = this.pid;
    this.loading = true; this.loadError = '';
    const params = new HttpParams().set('pid', this.pid).set('codes', this.queryCodes.join(','));
    this.http.get<BedsideRecord[] | { data?: BedsideRecord[] }>(`${this.API}/listByPid`, { params })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: r => {
          if (requestPid !== this.pid) return;
          const src = Array.isArray(r) ? r : (r as any)?.data || [];
          this.build(src.filter((x: any) => { const ok = x.valid === true || x.valid === 1 || x.valid === '1' || String(x.valid).toLowerCase() === 'true'; return ok && String(x.pid ?? '').trim() === this.pid; }));
          this.loading = false; this.cdr.detectChanges();
        },
        error: e => { if (requestPid !== this.pid) return; this.loadError = e?.error?.message || 'CRRT记录加载失败'; this.loading = false; this.build([]); this.cdr.detectChanges(); },
      });
  }

  private build(records: BedsideRecord[]): void {
    this.values.clear(); this.yishiRecords = []; this.accountNameMap.clear();
    const metricSet = new Set(this.metricCodes);
    const timeMap = new Map<number, TimePoint>();
    const editUserIds = new Set<string>();

    records.forEach(r => {
      const code = String(r.code ?? '').trim();
      const time = String(r.time ?? '').trim();
      if (!code || !time) return;
      const instant = databaseTimeValue(time);
      if (!Number.isFinite(instant)) return;
      if (code === 'param_Yishi') {
        const user = String(r.editUser ?? '').trim();
        if (user) { this.yishiRecords.push({ instant, editUser: user }); editUserIds.add(user); }
      } else if (metricSet.has(code)) {
        const value = String(r.strVal ?? '').trim();
        if (!value) return;
        if (!timeMap.has(instant)) timeMap.set(instant, { instant, rawTime: time });
        this.values.set(`${code}@@${instant}`, value);
      }
    });

    this.yishiRecords.sort((a, b) => a.instant - b.instant);

    const timeInstants = [...timeMap.values()].sort((a, b) => a.instant - b.instant).map(tp => tp.instant);

    // 会话拆分
    const statusPoints = this.normalizeTreatmentStatus(records);
    this.sessions = this.buildSessions(statusPoints);
    this.assignSessionTimeInstants(this.sessions, timeInstants);
    this.applyDefaultSession();
    this.rebuildSelectedSession();

    this.selectedPrintPages = [];

    if (editUserIds.size) this.loadAccountNames([...editUserIds]);
  }

  metricValue(metric: CrrtMetric, instant: number | undefined): string {
    if (instant === undefined || !Number.isFinite(instant)) return '';
    return this.values.get(`${metric.code}@@${instant}`) ?? '';
  }

  signatureAt(instant: number | undefined): string {
    if (instant === undefined || !Number.isFinite(instant)) return '';
    for (let i = this.yishiRecords.length - 1; i >= 0; i--) {
      const s = this.yishiRecords[i];
      if (s.instant <= instant && s.editUser) return this.accountNameMap.get(s.editUser) || '';
    }
    return '';
  }

  signatureAtForSession(instant: number | undefined, session: CrrtSession | null): string {
    if (instant === undefined || !Number.isFinite(instant) || !session) return '';
    const sessionInstants = new Set(session.allTimeInstants);
    for (let i = this.yishiRecords.length - 1; i >= 0; i--) {
      const s = this.yishiRecords[i];
      if (s.instant <= instant && sessionInstants.has(s.instant) && s.editUser) {
        return this.accountNameMap.get(s.editUser) || '';
      }
    }
    return '';
  }

  private normalizeTreatmentStatus(records: BedsideRecord[]): CrrtStatusPoint[] {
    const statusRecords = records
      .filter(r => String(r.code ?? '').trim() === 'param_CRRT治疗状态')
      .map(r => {
        const instant = databaseTimeValue(String(r.time ?? '').trim());
        const status = String(r.strVal ?? '').trim();
        return { instant, status } as { instant: number; status: string };
      })
      .filter(r => Number.isFinite(r.instant) && r.status);

    if (statusRecords.length === 0) return [];

    statusRecords.sort((a, b) => a.instant - b.instant);

    const points: CrrtStatusPoint[] = [];
    let lastStatus: string | null = null;
    let lastUpInstant: number | null = null;

    for (const rec of statusRecords) {
      const isUp = rec.status === '上机';
      const isDown = rec.status === '下机';

      if (rec.status === lastStatus) {
        if (!isUp) continue;
        if (isUp && lastUpInstant !== null) continue;
      }

      if (isUp && lastStatus === '上机' && lastUpInstant !== null) continue;

      points.push({ instant: rec.instant, treatmentStatus: rec.status });
      lastStatus = rec.status;
      if (isUp) lastUpInstant = rec.instant;
      else if (isDown) lastUpInstant = null;
    }

    return points;
  }

  private buildSessions(statusPoints: CrrtStatusPoint[]): CrrtSession[] {
    const sessions: CrrtSession[] = [];
    let sessionIndex = 1;
    let currentPoints: CrrtStatusPoint[] = [];
    let lastStatus: string | null = null;

    for (const point of statusPoints) {
      if (point.treatmentStatus === '上机') {
        if (lastStatus === '上机' && currentPoints.length > 0) {
          currentPoints.push(point);
        } else {
          if (currentPoints.length > 0) {
            sessions.push(this.createSession(sessionIndex++, currentPoints));
          }
          currentPoints = [point];
        }
      } else if (point.treatmentStatus === '下机') {
        currentPoints.push(point);
        sessions.push(this.createSession(sessionIndex++, currentPoints));
        currentPoints = [];
      } else {
        currentPoints.push(point);
      }
      lastStatus = point.treatmentStatus;
    }

    if (currentPoints.length > 0) {
      sessions.push(this.createSession(sessionIndex++, currentPoints));
    }

    return sessions;
  }

  private createSession(index: number, points: CrrtStatusPoint[]): CrrtSession {
    const startInstant = points[0].instant;
    const endInstant = points[points.length - 1].instant;
    const status: CrrtSessionStatus = points[points.length - 1].treatmentStatus === '下机' ? 'ended' : 'ongoing';
    return { index, points, startInstant, endInstant, allTimeInstants: [], pageTimeInstants: [], status };
  }

  private isInSession(instant: number, session: CrrtSession): boolean {
    if (instant < session.startInstant) return false;
    // ongoing session（只有上机没有下机）：上机之后的所有数据都展示
    if (session.status === 'ongoing') return true;
    return instant <= session.endInstant;
  }

  private assignSessionTimeInstants(sessions: CrrtSession[], allSortedInstants: number[]): void {
    for (const session of sessions) {
      const sessionInstants = allSortedInstants.filter(t => this.isInSession(t, session));
      session.allTimeInstants = sessionInstants;

      session.pageTimeInstants = [];
      for (let i = 0; i < Math.max(1, sessionInstants.length); i += 8) {
        session.pageTimeInstants.push(sessionInstants.slice(i, i + 8));
      }
      if (session.pageTimeInstants.length === 0) session.pageTimeInstants.push([]);
    }
    // 不在任何上机~下机范围内的数据点直接丢弃，不生成 orphan 会话
  }

  private applyDefaultSession(): void {
    if (this.sessions.length > 0) {
      this.selectedSessionId = this.sessions[this.sessions.length - 1].index;
      this.selectedSession = this.sessions[this.sessions.length - 1];
    } else {
      this.selectedSessionId = null;
      this.selectedSession = null;
    }
  }

  private rebuildSelectedSession(): void {
    this.visibleGroupsForSession = this.buildVisibleGroupsForSession(this.selectedSession);
    this.normalizeSelectedPrintPages(this.pages.length);
  }

  private buildVisibleGroupsForSession(session: CrrtSession | null): CrrtGroup[] {
    if (!session || session.allTimeInstants.length === 0) return CRRT_GROUPS;

    const sessionInstants = new Set(session.allTimeInstants);
    const metricHasValue = (metric: CrrtMetric): boolean =>
      [...this.values.entries()].some(([key, value]) => {
        if (!key.startsWith(metric.code + '@@')) return false;
        const instant = Number(key.split('@@')[1]);
        return sessionInstants.has(instant) && value.trim().length > 0;
      });

    const hasAnyValue = CRRT_GROUPS.some(group => group.metrics.some(metricHasValue));
    return hasAnyValue
      ? CRRT_GROUPS.map(group => ({ ...group, metrics: group.metrics.filter(metricHasValue) })).filter(group => group.metrics.length > 0)
      : CRRT_GROUPS;
  }

  onSessionChange(sessionId: number | null): void {
    this.selectedSession = sessionId != null ? this.sessions.find(s => s.index === sessionId) ?? null : null;
    this.rebuildSelectedSession();
  }

  get pages(): RenderPage[] {
    if (!this.selectedSession) return [{ index: 1, timeInstants: [], diagnosis: this.diagnosisForInstants([]) }];
    return this.selectedSession.pageTimeInstants.map((instants, i) => ({ index: i + 1, timeInstants: instants, diagnosis: this.diagnosisForInstants(instants) }));
  }

  /** 页诊断 = 该页第一条数据时间点所在区间的诊断；空页回退当前临床诊断 */
  private diagnosisForInstants(instants: number[]): string {
    return instants.length
      ? resolveDiagnosisDisplay(this.patient, instants[0], this.diagnosisDisplay)
      : resolveBlankDiagnosis(this.patient, this.diagnosisDisplay);
  }

  formatSessionDateTime(instant: number | undefined): string {
    if (instant === undefined || !Number.isFinite(instant)) return '';
    return formatShanghaiDate(instant) + ' ' + formatShanghaiHourMinute(instant);
  }

  sessionStartText(session: CrrtSession | null): string {
    return session ? this.formatSessionDateTime(session.startInstant) : '';
  }

  sessionEndText(session: CrrtSession | null): string {
    return session ? this.formatSessionDateTime(session.endInstant) : '';
  }

  sessionStatusText(session: CrrtSession | null): string {
    if (!session) return '';
    return session.status === 'ongoing' ? '治疗中' : '已结束';
  }

  displayDate(instant: number | undefined): string { return instant !== undefined ? formatShanghaiDate(instant) : ''; }
  displayClock(instant: number | undefined): string { return instant !== undefined ? formatShanghaiHourMinute(instant) : ''; }
  instantAt(page: RenderPage, idx: number): number | undefined { return page.timeInstants[idx]; }

  private loadAccountNames(ids: string[]): void {
    if (!ids.length) return;
    const params = new HttpParams().set('ids', ids.join(','));
    this.http.get<any[]>('/api/v1/icu/accounts/listByIds', { params }).pipe(takeUntil(this.destroy$)).subscribe({
      next: rows => { (Array.isArray(rows) ? rows : []).forEach(r => { const id = this.norm(r?.accountId ?? r?._id ?? r?.id); const name = this.norm(r?.accountName ?? r?.trueName ?? r?.name); if (id && name) this.accountNameMap.set(id, name); }); this.cdr.detectChanges(); },
      error: () => {},
    });
  }

  /* ===== 审核者下拉（可检索 + 屏蔽 + 登录者置顶），参考 braden-form ===== */
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
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {},
      error: (e) => console.error('[crrtRecord] saveAuditor failed', { formCode: FORM_CODE, pid: this.pid, auditorId: this.auditorId, error: e }),
    });
  }
  private loadAuditor(): void {
    if (!this.pid) return;
    this.http.get<any>(API_EXTRA_LATEST, { params: { pid: this.pid, formCode: FORM_CODE } }).pipe(takeUntil(this.destroy$)).subscribe({
      next: (d) => {
        if (d) { this.auditorName = d.auditorName || ''; this.auditorId = d.auditorId || ''; }
        this.auditorQuery = this.auditorName;
        this.cdr.detectChanges();
      },
      error: () => this.cdr.detectChanges(),
    });
  }
  private loadAccountList(): void {
    this.http.get<any[]>(API_ACCOUNT_ALL).pipe(takeUntil(this.destroy$)).subscribe({
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
      error: (e) => console.error('[crrtRecord] loadAccountList failed', e),
    });
  }

  genderText(g?: string | number): string { const v = String(g ?? '').trim(); if (['Male', 'M', '男', '1'].includes(v)) return '男'; if (['Female', 'F', '女', '2'].includes(v)) return '女'; return v; }
  private norm(v: unknown): string { return String(v ?? '').trim(); }
  private calcAge(b?: string): number | null { if (!b) return null; const d = new Date(b); if (Number.isNaN(d.getTime())) return null; const n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) a--; return a >= 0 ? a : null; }
  private formatDiagnosis(d?: string): string { return firstDiagnosisSegment(d, 'legacy'); }
  isPrintPageSelected(pageNumber: number, totalPages = this.pages.length): boolean {
    return shouldPrintPage(pageNumber, this.selectedPrintPages, totalPages);
  }
  private normalizeSelectedPrintPages(totalPages: number): void {
    const normalized = normalizePrintPages(this.selectedPrintPages, totalPages);
    this.selectedPrintPages = (normalized.length === totalPages && totalPages > 0) ? [] : normalized;
  }
  print(): void {
    this.printing = true;
    this.cdr.detectChanges();
    this.warnIfTableCrossesCeiling();
    const afterPrint = () => { this.printing = false; this.cdr.detectChanges(); window.removeEventListener('afterprint', afterPrint); };
    window.addEventListener('afterprint', afterPrint);
    window.print();
  }

  /**
   * 打印前一次性只读校验：表格底边越过封顶线时告警点名页码。
   * 只告警不修正行高——任何"测了再改"的修正都会把反馈回路引回来。
   */
  private warnIfTableCrossesCeiling(): void {
    this.host.nativeElement.querySelectorAll<HTMLElement>('.sheet').forEach((sheet, idx) => {
      if (sheet.offsetHeight <= 0) return;
      const table = sheet.querySelector<HTMLElement>('.crrt-table');
      if (!table) return;
      const bottom = table.offsetTop + table.offsetHeight;
      const ceiling = sheet.clientHeight - SHEET_BOTTOM_PX;
      if (bottom > ceiling) {
        console.warn(`CRRT记录单第 ${idx + 1} 页表格底边 ${Math.round(bottom)}px 超过封顶线 ${ceiling}px，打印可能压到页码`);
      }
    });
  }
}

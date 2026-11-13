import { HttpClient } from '@angular/common/http';
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { Subject, catchError, finalize, map, of, takeUntil } from 'rxjs';
import { HostPatientService } from './services/host-patient.service';
import { IcuFormViewerContextService } from './icu-form-viewer-context.service';
import { formatShanghaiDateMinute } from './form-date.util';
import { normalizePrintPages, shouldPrintPage } from './form-print-pages.util';

interface NursingGoalRecord {
  id?: string; pid: string; recordDate: string;
  values?: Record<string, string>; doctorSign?: string;
  valid?: boolean; updatedBy?: string;
}
interface RenderPage { index: number; slots: (NursingGoalRecord | null)[]; }
interface AccountOption { accountId: string; accountName: string; profession?: string; }
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** 允许新增/编辑记录的账号 profession（与 PICCO 一致：医生/管理员/主任） */
const EDIT_PROFS = ['doctor', 'admin', 'director'];
/** 每页日期列数 */
const DATES_PER_PAGE = 4;

/** 弹窗录入项（与表格行一一对应） */
const GOAL_ITEMS: { code: string; label: string }[] = [
  { code: 'temp_normal', label: '体温·正常' },
  { code: 'temp_hypo', label: '体温·亚低温' },
  { code: 'temp_rewarm_axilla', label: '复温·腋温' },
  { code: 'temp_rewarm_rectal', label: '复温·肛温' },
  { code: 'bp_nibp', label: '血压·无创' },
  { code: 'bp_ibp', label: '血压·有创' },
  { code: 'bp_map', label: 'MAP' },
  { code: 'spo2', label: 'SpO2' },
  { code: 'pao2', label: '氧分压' },
  { code: 'prone_hours', label: '俯卧位通气时间' },
  { code: 'hr', label: '心率' },
  { code: 'cvp', label: 'CVP' },
  { code: 'io_balance', label: '出入量' },
  { code: 'urine', label: '尿量' },
  { code: 'icp', label: 'ICP' },
  { code: 'ecf_drain', label: '脑室外引流' },
  { code: 'lumbar_drain', label: '腰大池引流' },
  { code: 'cpot', label: '镇痛·CPOT' },
  { code: 'rass', label: '镇静·RASS' },
  { code: 'wake_time', label: '唤醒时间' },
  { code: 'glucose', label: '血糖' },
];

@Component({
  selector: 'app-hlmb-form',
  standalone: false,
  templateUrl: './hlmb-form.component.html',
  styleUrls: ['./hlmb-form.component.css'],
})
export class HlmbFormComponent implements OnInit, OnDestroy {
  private readonly API = '/api/v1/icu/nursing-goal-records';
  private readonly destroy$ = new Subject<void>();
  readonly items = GOAL_ITEMS;

  patient: any = null;
  account: any = null;
  pid = '';
  diagnosisDisplay = '';
  loading = false;
  loadError = '';
  pages: RenderPage[] = [{ index: 1, slots: [null, null, null, null] }];
  selectedPrintPages: number[] = [];
  printing = false;
  records: NursingGoalRecord[] = [];
  recordListOpen = false;
  recordFormOpen = false;
  recordEditing = false;
  recordSaving = false;
  recordError = '';
  deletingId = '';
  recordForm: { id?: string; recordDate: string; values: Record<string, string>; signId: string } =
    { recordDate: '', values: {}, signId: '' };
  accounts: AccountOption[] = [];
  isViewerMode = false;

  constructor(
    private http: HttpClient,
    private hostPatient: HostPatientService,
    private cdr: ChangeDetectorRef,
    private contextService: IcuFormViewerContextService,
  ) {}

  ngOnInit(): void {
    this.contextService.getContext$().pipe(takeUntil(this.destroy$)).subscribe(ctx => {
      this.isViewerMode = ctx.isViewerMode;
      this.cdr.markForCheck();
    });
    this.hostPatient.account$.pipe(takeUntil(this.destroy$)).subscribe(a => this.account = a);
    this.hostPatient.patient$.pipe(takeUntil(this.destroy$)).subscribe(p => {
      if (!p?.id) { this.reset(); return; }
      this.patient = p;
      this.pid = String(p.id).trim();
      this.closeDialogs();
      this.diagnosisDisplay = this.formatDiagnosis(p.clinicalDiagnosis);
      this.load();
    });
    this.loadAccounts();
  }

  ngOnDestroy(): void { this.destroy$.next(); this.destroy$.complete(); }

  private reset(): void {
    this.pid = '';
    this.patient = null;
    this.pages = [{ index: 1, slots: [null, null, null, null] }];
    this.selectedPrintPages = [];
    this.records = [];
    this.closeDialogs();
  }

  load(): void {
    if (!this.pid) return;
    this.loading = true;
    this.loadError = '';
    this.http.get<NursingGoalRecord[] | { data: NursingGoalRecord[] }>(`${this.API}/listByPid`, { params: { pid: this.pid } })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: r => {
          const src = Array.isArray(r) ? r : (r.data || []);
          this.build(src);
          this.loading = false;
          this.cdr.detectChanges();
        },
        error: e => {
          this.loadError = e?.error?.message || '护理目标管理记录加载失败';
          this.build([]);
          this.loading = false;
          this.cdr.detectChanges();
        },
      });
  }

  private build(records: NursingGoalRecord[]): void {
    this.records = (Array.isArray(records) ? records : [])
      .filter(r => !!r && r.valid !== false && !!r.recordDate)
      .slice()
      .sort((a, b) => String(a.recordDate).localeCompare(String(b.recordDate)));
    this.pages = [];
    for (let i = 0; i < this.records.length; i += DATES_PER_PAGE) {
      const slots: (NursingGoalRecord | null)[] = [];
      for (let j = 0; j < DATES_PER_PAGE; j++) slots.push(this.records[i + j] ?? null);
      this.pages.push({ index: this.pages.length + 1, slots });
    }
    if (!this.pages.length) this.pages = [{ index: 1, slots: [null, null, null, null] }];
    this.normalizeSelectedPrintPages(this.pages.length);
  }

  val(slot: NursingGoalRecord | null, code: string): string {
    return slot?.values?.[code] ?? '';
  }

  signAt(slot: NursingGoalRecord | null): string {
    return slot?.doctorSign ?? '';
  }

  /** 表头日期展示：yyyy-MM-dd HH:mm（旧数据仅日期时补 00:00） */
  displayDate(slot: NursingGoalRecord | null): string {
    const raw = String(slot?.recordDate ?? '').trim();
    if (!raw) return '';
    const v = raw.replace('T', ' ');
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v} 00:00`;
    return v.slice(0, 16);
  }

  genderText(v: any): string {
    return ['Male', 'M', '男', '1'].includes(String(v)) ? '男'
      : ['Female', 'F', '女', '2'].includes(String(v)) ? '女' : String(v ?? '');
  }

  // ── 权限（与 PICCO 一致） ──
  private canEdit(): boolean {
    return EDIT_PROFS.includes(String(this.account?.profession ?? '').trim().toLowerCase());
  }
  private ensurePermission(): boolean {
    if (this.canEdit()) return true;
    alert('没有权限，仅医生账号可新增或编辑护理目标记录');
    return false;
  }

  // ── 新增/编辑 ──
  openCreate(): void {
    if (!this.ensurePermission()) return;
    if (!this.pid) return;
    this.recordEditing = false;
    this.recordError = '';
    this.recordForm = {
      recordDate: this.nowLocalDateTime(),
      values: {},
      signId: this.defaultSignId(),
    };
    this.recordFormOpen = true;
  }

  openEditList(): void {
    if (!this.ensurePermission()) return;
    if (!this.pid) return;
    this.recordError = '';
    this.recordListOpen = true;
  }

  editRecord(r: NursingGoalRecord): void {
    if (!this.ensurePermission()) return;
    this.recordListOpen = false;
    this.recordEditing = true;
    this.recordError = '';
    const signName = String(r.doctorSign ?? '').trim();
    const matched = this.accounts.find(a => a.accountName === signName);
    this.recordForm = {
      id: r.id,
      recordDate: this.toLocalInput(String(r.recordDate)),
      values: { ...(r.values || {}) },
      signId: matched?.accountId ?? '',
    };
    this.recordFormOpen = true;
  }

  saveRecord(): void {
    if (!this.ensurePermission()) return;
    this.recordError = '';
    const recordDate = this.toStorageDateTime(this.recordForm.recordDate);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(recordDate)) {
      this.recordError = '记录时间格式应为yyyy-MM-dd HH:mm';
      return;
    }
    const values: Record<string, string> = {};
    this.items.forEach(it => {
      const v = String(this.recordForm.values[it.code] ?? '').trim();
      if (v) values[it.code] = v;
    });
    const signAcc = this.accounts.find(a => a.accountId === this.recordForm.signId);
    const doctorSign = signAcc?.accountName ?? '';
    if (!Object.keys(values).length && !doctorSign) {
      this.recordError = '请至少录入一项内容';
      return;
    }
    const dup = this.records.find(r =>
      r.id !== this.recordForm.id && this.toStorageDateTime(r.recordDate) === recordDate);
    if (dup) { this.recordError = '该记录时间已存在记录，请通过编辑修改'; return; }
    this.recordSaving = true;
    const body: { id?: string; pid: string; recordDate: string; values: Record<string, string>; doctorSign: string; updatedBy: string } =
      { pid: this.pid, recordDate, values, doctorSign, updatedBy: String(this.account?.id ?? this.account?._id ?? '') };
    if (this.recordForm.id) body.id = this.recordForm.id;
    this.http.post<any>(`${this.API}/save`, body)
      .pipe(finalize(() => this.recordSaving = false), takeUntil(this.destroy$))
      .subscribe({
        next: () => { this.recordFormOpen = false; this.load(); },
        error: e => { this.recordError = e?.error?.message || '保存失败，请稍后重试'; },
      });
  }

  invalidateRecord(r: NursingGoalRecord): void {
    if (!this.ensurePermission()) return;
    if (!r.id || this.deletingId) return;
    if (!confirm(`确认删除 ${this.fmtRecordDate(r.recordDate)} 的记录？`)) return;
    this.deletingId = r.id;
    const operationPid = this.pid;
    this.http.patch(`${this.API}/${r.id}/invalidate`, null,
      { params: { operatorId: String(this.account?.id ?? this.account?._id ?? '') } })
      .pipe(finalize(() => this.deletingId = ''), takeUntil(this.destroy$))
      .subscribe({
        next: () => { if (operationPid !== this.pid) return; this.load(); },
        error: () => alert('删除失败'),
      });
  }

  closeDialogs(): void {
    this.recordListOpen = false;
    this.recordFormOpen = false;
    this.recordError = '';
    this.recordSaving = false;
    this.recordEditing = false;
  }

  fmtRecordDate(v?: string): string {
    const raw = String(v ?? '').trim();
    if (!raw) return '';
    const s = raw.replace('T', ' ');
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s} 00:00` : s.slice(0, 16);
  }
  paramCount(r: NursingGoalRecord): number {
    return Object.values(r.values || {}).filter(v => String(v ?? '').trim()).length;
  }

  /** datetime-local 输入值（yyyy-MM-ddTHH:mm） */
  private nowLocalDateTime(): string {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}`;
  }

  /** 存储值 → datetime-local 输入值 */
  private toLocalInput(stored: string): string {
    const v = String(stored ?? '').trim().replace('T', ' ');
    if (!v) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00`;
    return v.slice(0, 16).replace(' ', 'T');
  }

  /** datetime-local 输入值 → 存储值 yyyy-MM-dd HH:mm */
  private toStorageDateTime(local: string): string {
    return String(local ?? '').trim().replace('T', ' ').slice(0, 16);
  }

  private loadAccounts(): void {
    const DOCTOR_PROFS = ['director', 'doctor'];
    this.http.get<any[]>('/api/v1/icu/accounts')
      .pipe(takeUntil(this.destroy$), catchError(() => of([])))
      .subscribe(rows => {
        const all = (Array.isArray(rows) ? rows : [])
          .map(r => ({
            accountId: String(r?.accountId ?? r?._id ?? r?.id ?? '').trim(),
            accountName: String(r?.accountName ?? r?.trueName ?? r?.name ?? '').trim(),
            profession: String(r?.profession ?? '').trim(),
          }))
          .filter(a => !!a.accountId && !!a.accountName);
        this.accounts = all.filter(a => DOCTOR_PROFS.includes((a.profession || '').toLowerCase()));
        if (this.recordFormOpen && !this.recordEditing && !this.recordForm.signId) {
          this.recordForm.signId = this.defaultSignId();
        }
        this.cdr.detectChanges();
      });
  }

  /** 默认签名 = 当前账号；当前账号不在医生下拉里时返回空 */
  private defaultSignId(): string {
    const cur = String(this.account?.accountId ?? this.account?.id ?? this.account?._id ?? '').trim();
    return cur && this.accounts.some(a => a.accountId === cur) ? cur : '';
  }

  // ── 打印 ──
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
    const afterPrint = () => {
      this.printing = false;
      this.cdr.detectChanges();
      window.removeEventListener('afterprint', afterPrint);
    };
    window.addEventListener('afterprint', afterPrint);
    window.print();
  }

  private formatDiagnosis(d?: string): string {
    if (!d) return '';
    return d.split(/[;；,，]/)[0].trim();
  }
}

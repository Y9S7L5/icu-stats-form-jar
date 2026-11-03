import { HttpClient } from '@angular/common/http';
import { ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit } from '@angular/core';
import { Subject, of } from 'rxjs';
import { catchError, distinctUntilChanged, filter, finalize, map, switchMap, takeUntil, tap } from 'rxjs/operators';
import { normalizePrintPages, shouldPrintPage } from './form-print-pages.util';
import { IcuFormViewerContextService } from './icu-form-viewer-context.service';
import { HostPatientService } from './services/host-patient.service';
import { endOfShanghaiDayMs, firstDiagnosisSegment, resolveBlankDiagnosis, resolveDiagnosisDisplay } from './diagnosis-history.util';
import { DiagnosisHistoryService } from './diagnosis-history.service';

type ComplianceMark = '' | '√' | '×';
type MeasureCode =
  | 'EXTUBATION_ASSESSMENT' | 'CENTRAL_LINE_NECESSITY' | 'URINARY_CATHETER_NECESSITY'
  | 'EARLY_REHABILITATION' | 'HAND_HYGIENE'
  | 'HEAD_ELEVATION' | 'ORAL_CARE' | 'SUCTION_STANDARD' | 'SUBGLOTTIC_SUCTION'
  | 'DAILY_CUFF_PRESSURE'
  | 'CONDENSATE_MANAGEMENT' | 'VENTILATOR_CIRCUIT_REPLACEMENT'
  | 'MAXIMAL_STERILE_BARRIER' | 'CHLORHEXIDINE_SKIN_ANTISEPSIS' | 'PREFERRED_SUBCLAVIAN_VEIN_PUNCTURE'
  | 'STERILE_DRESSING' | 'CONNECTOR_DISINFECTION'
  | 'STERILE_CATHETERIZATION' | 'URINE_BAG_POSITION' | 'URINE_BAG_TWO_THIRDS'
  | 'CLOSED_ANTI_REFLUX_DRAINAGE' | 'MEATAL_CARE';

interface MeasureItem { code: MeasureCode; label: string; }
interface MeasureGroup {
  code: 'NECESSITY' | 'VAP' | 'CRBSI' | 'CAUTI';
  name: string;
  shortName: string;
  items: readonly MeasureItem[];
}
interface SggrfkcsRecord {
  id?: string;
  pid: string;
  recordDate: string;
  measures: Partial<Record<MeasureCode, ComplianceMark>>;
  doctorName: string;
  nurseId?: string;
  nurseName: string;
  inspectorName: string;
  valid?: boolean;
  updatedBy?: string;
}
interface AccountOption { accountId: string; accountName: string; profession?: string; username?: string; code?: string; }
interface RenderPage { index: number; records: Array<SggrfkcsRecord | null>; diagnosis?: string; }

const NECESSITY_GROUP: MeasureGroup = {
  code: 'NECESSITY', name: '患者及导管留置必要性评估', shortName: '必要性评估',
  items: [
    { code: 'EXTUBATION_ASSESSMENT', label: '撤机或人工气道拔管评估' },
    { code: 'CENTRAL_LINE_NECESSITY', label: '深静脉导管留置的必要性评估' },
    { code: 'URINARY_CATHETER_NECESSITY', label: '导尿管留置必要性评估' },
    { code: 'EARLY_REHABILITATION', label: '早期康复' },
    { code: 'HAND_HYGIENE', label: '手卫生' },
  ],
};
const VAP_GROUP: MeasureGroup = {
  code: 'VAP', name: '呼吸机相关肺炎防控（VAP）', shortName: 'VAP',
  items: [
    { code: 'HEAD_ELEVATION', label: '床头抬高30°~45°' },
    { code: 'ORAL_CARE', label: '口腔护理' },
    { code: 'SUCTION_STANDARD', label: '吸痰操作规范' },
    { code: 'SUBGLOTTIC_SUCTION', label: '声门下吸引' },
    { code: 'DAILY_CUFF_PRESSURE', label: '进行气管导管气囊测压（25-30cmH₂O）' },
    { code: 'CONDENSATE_MANAGEMENT', label: '积水杯最低位，倾倒冷凝水' },
    { code: 'VENTILATOR_CIRCUIT_REPLACEMENT', label: '呼吸机外部管路更换' },
  ],
};
const CRBSI_GROUP: MeasureGroup = {
  code: 'CRBSI', name: '导管相关血流感染防控（CRBSI）', shortName: 'CRBSI',
  items: [
    { code: 'MAXIMAL_STERILE_BARRIER', label: '无菌操作、最大化无菌屏障' },
    { code: 'CHLORHEXIDINE_SKIN_ANTISEPSIS', label: '氯已定皮肤消毒' },
    { code: 'PREFERRED_SUBCLAVIAN_VEIN_PUNCTURE', label: '首选锁骨下静脉穿刺' },
    { code: 'STERILE_DRESSING', label: '无菌敷料覆盖、更换' },
    { code: 'CONNECTOR_DISINFECTION', label: '无菌接头更换，导管连接端口消毒时间不少于15s' },
  ],
};
const CAUTI_GROUP: MeasureGroup = {
  code: 'CAUTI', name: '导尿管相关尿路感染防控（CAUTI）', shortName: 'CAUTI',
  items: [
    { code: 'STERILE_CATHETERIZATION', label: '置管执行无菌操作' },
    { code: 'URINE_BAG_POSITION', label: '尿袋低于膀胱水平，高于地面' },
    { code: 'URINE_BAG_TWO_THIRDS', label: '尿袋3／4满时清空' },
    { code: 'CLOSED_ANTI_REFLUX_DRAINAGE', label: '持续性封闭抗反流引流' },
    { code: 'MEATAL_CARE', label: '尿道口正确清洁，必要时碘伏消毒' },
  ],
};
const GROUPS: readonly MeasureGroup[] = [NECESSITY_GROUP, VAP_GROUP, CRBSI_GROUP, CAUTI_GROUP];
const INSPECTOR_NAMES: readonly string[] = ['陈琳', '陈芬', '伍席洲', '谢娜'];

@Component({
  standalone: false,
  selector: 'app-sggrfkcs-form',
  templateUrl: './sggrfkcs-form.component.html',
  styleUrls: ['./sggrfkcs-form.component.css'],
})
export class SggrfkcsFormComponent implements OnInit, OnDestroy {
  private readonly API = '/api/v1/icu/sggrfkcs';
  private readonly rowsPerPage = 12;
  readonly groups = GROUPS;
  readonly necessityGroup = NECESSITY_GROUP;
  readonly vapGroup = VAP_GROUP;
  readonly crbsiGroup = CRBSI_GROUP;
  readonly cautiGroup = CAUTI_GROUP;
  /** 表格总列数：日期 + 各组措施 + 医生/护士/督查者签名 */
  get totalColumns(): number {
    return 4 + this.groups.reduce((sum, group) => sum + group.items.length, 0);
  }

  patient: any = null;
  account: any = null;
  age: number | null = null;
  diagnosisDisplay = '';
  isViewerMode = false;
  loading = false;
  saving = false;
  deletingId = '';
  loadError = '';
  errorText = '';
  records: SggrfkcsRecord[] = [];
  pages: RenderPage[] = [];
  selectedPrintPages: number[] = [];
  editListOpen = false;
  formOpen = false;
  editing = false;
  form: SggrfkcsRecord = this.emptyForm('');
  accounts: AccountOption[] = [];
  filteredAccounts: AccountOption[] = [];
  nurseQuery = '';
  nurseDropdownOpen = false;
  selectedNurse: AccountOption | null = null;

  allAccounts: AccountOption[] = [];
  doctorAccounts: AccountOption[] = [];
  doctorFiltered: AccountOption[] = [];
  doctorQuery = '';
  doctorDropdownOpen = false;

  inspectorAccounts: AccountOption[] = [];
  inspectorFiltered: AccountOption[] = [];
  inspectorQuery = '';
  inspectorDropdownOpen = false;

  private pid = '';
  private readonly destroy$ = new Subject<void>();
  private readonly refresh$ = new Subject<void>();

  constructor(
    private readonly http: HttpClient,
    private readonly hostPatient: HostPatientService,
    private readonly cdr: ChangeDetectorRef,
    private readonly host: ElementRef<HTMLElement>,
    private readonly contextService: IcuFormViewerContextService,
    private readonly diagHistory: DiagnosisHistoryService,
  ) {}

  ngOnInit(): void {
    this.contextService.getContext$().pipe(takeUntil(this.destroy$)).subscribe(ctx => {
      this.isViewerMode = ctx.isViewerMode;
      this.cdr.markForCheck();
    });
    this.loadAccounts();
    this.hostPatient.account$.pipe(takeUntil(this.destroy$)).subscribe(account => this.account = account);
    this.hostPatient.patient$.pipe(
      filter(Boolean),
      map(patient => ({ patient, pid: this.patientId(patient) })),
      filter(({ pid }) => !!pid),
      distinctUntilChanged((a, b) => a.pid === b.pid),
      switchMap(({ patient, pid }) => this.diagHistory.ensurePatient(patient).pipe(map(ep => ({ patient: ep, pid })))),
      tap(({ patient, pid }) => {
        this.closeDialogs();
        this.patient = patient;
        this.pid = pid;
        this.age = this.calcAge(patient?.birthday);
        this.diagnosisDisplay = this.formatDiagnosis(patient?.clinicalDiagnosis);
        this.records = [];
        this.loadError = '';
        this.paginate();
      }),
      switchMap(({ pid }) => this.fetchRecords(pid)),
      takeUntil(this.destroy$),
    ).subscribe();
    this.refresh$.pipe(takeUntil(this.destroy$)).subscribe(() => {
      if (this.pid) this.fetchRecords(this.pid).pipe(takeUntil(this.destroy$)).subscribe();
    });
  }

  ngOnDestroy(): void { this.destroy$.next(); this.destroy$.complete(); }

  openCreate(): void {
    if (!this.pid) return;
    this.editing = false;
    this.errorText = '';
    this.form = this.emptyForm(this.pid);
    this.form.recordDate = this.toLocalDate(new Date());
    const currentId = String(this.account?.id ?? this.account?._id ?? this.account?.accountId ?? this.account?.username ?? '').trim();
    const currentName = String(this.account?.trueName ?? this.account?.accountName ?? this.account?.name ?? '').trim();
    this.form.nurseId = currentId;
    this.form.nurseName = currentName;
    this.nurseQuery = currentName;
    this.selectedNurse = currentId && currentName ? {
      accountId: currentId, accountName: currentName,
      username: String(this.account?.username ?? ''),
      code: String(this.account?.code ?? this.account?.jobNumber ?? ''),
    } : null;
    this.filteredAccounts = this.accounts.slice(0, 20);
    this.nurseDropdownOpen = false;
    this.form.doctorName = '';
    this.doctorQuery = '';
    this.doctorFiltered = this.doctorAccounts.slice(0, 20);
    this.doctorDropdownOpen = false;
    this.form.inspectorName = '';
    this.inspectorQuery = '';
    this.inspectorFiltered = this.inspectorAccounts.slice(0, 20);
    this.inspectorDropdownOpen = false;
    this.formOpen = true;
  }

  openEditList(): void { this.editListOpen = true; }
  retry(): void { this.reload(); }

  editRecord(record: SggrfkcsRecord): void {
    this.editListOpen = false;
    this.editing = true;
    this.errorText = '';
    this.form = this.normalizeRecord(JSON.parse(JSON.stringify(record)));
    this.nurseQuery = this.form.nurseName || '';
    this.selectedNurse = this.form.nurseId && this.form.nurseName
      ? { accountId: this.form.nurseId, accountName: this.form.nurseName } : null;
    this.filteredAccounts = this.accounts.slice(0, 20);
    this.nurseDropdownOpen = false;
    this.doctorQuery = this.form.doctorName || '';
    this.doctorFiltered = this.allAccounts.slice(0, 20);
    this.doctorDropdownOpen = false;
    this.inspectorQuery = this.form.inspectorName || '';
    this.inspectorFiltered = this.inspectorAccounts.slice(0, 20);
    this.inspectorDropdownOpen = false;
    this.formOpen = true;
  }

  save(): void {
    this.errorText = '';
    if (!this.form.recordDate) { this.errorText = '日期为必填项'; return; }
    if (!this.form.nurseName?.trim()) { this.errorText = '护士签名为必填项'; return; }
    const selectedNurse = this.selectedNurse;
    const confirmed = !!selectedNurse && !!this.form.nurseId
      && this.form.nurseId === selectedNurse.accountId
      && this.form.nurseName.trim() === selectedNurse.accountName;
    if (!confirmed || !selectedNurse) {
      this.errorText = '护士签名已被修改，请从检索结果中选择账号'; return;
    }
    this.saving = true;
    const operationPid = this.pid;
    const body: SggrfkcsRecord = {
      ...this.form, pid: this.pid, measures: { ...this.form.measures },
      doctorName: this.form.doctorName?.trim() || '',
      nurseId: selectedNurse.accountId, nurseName: selectedNurse.accountName,
      inspectorName: this.form.inspectorName?.trim() || '',
      updatedBy: String(this.account?.id ?? this.account?._id ?? ''),
    };
    this.http.post(`${this.API}/save`, body).pipe(
      finalize(() => this.saving = false), takeUntil(this.destroy$),
    ).subscribe({
      next: () => { if (operationPid === this.pid) { this.formOpen = false; this.reload(); } },
      error: error => this.errorText = error?.error?.message || '保存失败，请稍后重试',
    });
  }

  invalidate(record: SggrfkcsRecord): void {
    if (!record.id || this.deletingId) return;
    if (!confirm(`确认删除 ${this.fmtFullDate(record.recordDate)} 的监测记录？`)) return;
    this.deletingId = record.id;
    const operationPid = this.pid;
    this.http.patch(`${this.API}/${record.id}/invalidate`, null, {
      params: { operatorId: String(this.account?.id ?? this.account?._id ?? '') },
    }).pipe(finalize(() => this.deletingId = ''), takeUntil(this.destroy$)).subscribe({
      next: () => { if (operationPid === this.pid) this.reload(); },
      error: () => alert('删除失败'),
    });
  }

  mark(record: SggrfkcsRecord | null, code: MeasureCode): string {
    return record?.measures?.[code] || '';
  }
  setMark(code: MeasureCode, mark: ComplianceMark): void {
    this.form.measures = { ...this.form.measures, [code]: mark };
  }
  setGroupMark(group: MeasureGroup, mark: ComplianceMark): void {
    const measures = { ...this.form.measures };
    group.items.forEach(item => measures[item.code] = mark);
    this.form.measures = measures;
  }
  isGroupMarked(group: MeasureGroup, mark: ComplianceMark): boolean {
    return group.items.every(item => (this.form.measures[item.code] || '') === mark);
  }

  selectNurse(account: AccountOption): void {
    this.selectedNurse = account;
    this.form.nurseId = account.accountId;
    this.form.nurseName = account.accountName;
    this.nurseQuery = account.accountName;
    this.nurseDropdownOpen = false;
    this.errorText = '';
  }
  onNurseSearchInput(value: string): void {
    this.nurseQuery = value;
    const normalized = value.trim();
    if (this.selectedNurse && normalized === this.selectedNurse.accountName) {
      this.form.nurseId = this.selectedNurse.accountId;
      this.form.nurseName = this.selectedNurse.accountName;
    } else {
      this.selectedNurse = null; this.form.nurseId = ''; this.form.nurseName = value;
    }
    const keyword = normalized.toLowerCase();
    this.filteredAccounts = this.accounts.filter(account => !keyword ||
      [account.accountName, account.username, account.code]
        .some(field => String(field || '').toLowerCase().includes(keyword))).slice(0, 20);
    this.nurseDropdownOpen = true;
  }
  openNurseDropdown(): void { this.filteredAccounts = this.accounts.slice(0, 20); this.nurseDropdownOpen = true; }
  closeNurseDropdownLater(): void { window.setTimeout(() => this.nurseDropdownOpen = false, 150); }

  selectDoctor(account: AccountOption): void {
    this.form.doctorName = account.accountName;
    this.doctorQuery = account.accountName;
    this.doctorDropdownOpen = false;
  }
  onDoctorSearchInput(value: string): void {
    this.doctorQuery = value;
    this.form.doctorName = value;
    const keyword = value.trim().toLowerCase();
    this.doctorFiltered = this.doctorAccounts.filter(a => !keyword ||
      [a.accountName, a.username, a.code].some(f => String(f || '').toLowerCase().includes(keyword))).slice(0, 20);
    this.doctorDropdownOpen = true;
  }
  openDoctorDropdown(): void { this.doctorFiltered = this.doctorAccounts.slice(0, 20); this.doctorDropdownOpen = true; }
  closeDoctorDropdownLater(): void { window.setTimeout(() => this.doctorDropdownOpen = false, 150); }

  selectInspector(account: AccountOption): void {
    this.form.inspectorName = account.accountName;
    this.inspectorQuery = account.accountName;
    this.inspectorDropdownOpen = false;
  }
  onInspectorSearchInput(value: string): void {
    this.inspectorQuery = value;
    this.form.inspectorName = value;
    const keyword = value.trim().toLowerCase();
    this.inspectorFiltered = this.inspectorAccounts.filter(a => !keyword ||
      [a.accountName, a.username, a.code].some(f => String(f || '').toLowerCase().includes(keyword))).slice(0, 20);
    this.inspectorDropdownOpen = true;
  }
  openInspectorDropdown(): void { this.inspectorFiltered = this.inspectorAccounts.slice(0, 20); this.inspectorDropdownOpen = true; }
  closeInspectorDropdownLater(): void { window.setTimeout(() => this.inspectorDropdownOpen = false, 150); }

  print(): void {
    const sheets = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('.sheet'));
    if (!sheets.length) { alert('没有可打印的表单'); return; }
    const totalPages = sheets.length;
    const normalized = normalizePrintPages(this.selectedPrintPages, totalPages);
    if (!(normalized.length || totalPages)) { alert('请至少选择一个打印页码'); return; }
    let body = '';
    sheets.forEach((sheet, index) => {
      if (!shouldPrintPage(index + 1, this.selectedPrintPages, totalPages)) return;
      const clone = sheet.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.no-print').forEach(element => element.remove());
      body += `<div class="print-page">${clone.outerHTML}</div>`;
    });
    const css = `
      @page{size:A4 landscape;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#000}
      .print-page{width:297mm;height:210mm;overflow:hidden;break-after:page;page-break-after:always}.print-page:last-child{break-after:auto;page-break-after:auto}
      .sheet{position:relative;width:297mm;height:210mm;margin:0;padding:7mm 10mm;overflow:hidden;background:#fff;box-shadow:none}
      h1{margin:0 0 2mm;text-align:center;font-family:SimHei,'Microsoft YaHei',sans-serif;font-size:18pt;line-height:1.15}
      .patient-info{display:grid;grid-template-columns:1.1fr .9fr .8fr 1fr .65fr .65fr 2.5fr;gap:2mm;margin-bottom:2mm;font-family:'SimSun','宋体',serif;font-size:10pt;line-height:1.2;white-space:nowrap}.patient-info span{min-width:0;overflow:hidden;text-overflow:ellipsis}
      .control-table{width:100%;border-collapse:collapse;table-layout:fixed;font-family:'SimSun','宋体',serif;font-size:8.5pt;line-height:1.18}.control-table col.col-date{width:7.3%}.control-table col.col-measure{width:3.47%}.control-table col.col-signature{width:4.3%}
      .control-table th,.control-table td{border:.25mm solid #000;padding:.7mm .45mm;text-align:center;vertical-align:middle;color:#000;background:#fff}.control-table thead .group-head th{height:8mm;font-size:9.5pt;font-weight:400}.control-table thead .item-head th{height:55mm;padding:1mm .45mm;font-weight:400;word-wrap:break-word;overflow-wrap:break-word;word-break:normal;line-height:1.1}.control-table tbody tr{height:8mm}.control-table td.date-cell{white-space:nowrap;line-height:1.3}.control-table td.mark-cell{font-family:Arial,'SimSun',serif;font-size:11pt;font-weight:700}.control-table td.signature-cell{font-size:8pt;word-break:break-all}.control-table tfoot td{height:7mm;padding:1mm 2mm;text-align:left;font-size:9pt}
      .sheet-pageno{position:absolute;right:0;bottom:3mm;left:0;text-align:center;font-family:'SimSun','宋体',serif;font-size:9pt}.no-print{display:none!important}`;
    const win = window.open('', '_blank', 'width=1200,height=800');
    if (!win) { alert('打印窗口被拦截'); return; }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>三管感染防控措施依从性监测</title><style>${css}</style></head><body>${body}</body></html>`);
    win.document.close();
    const doPrint = () => {
      win.document.querySelectorAll<HTMLElement>('.sheet').forEach(sheet => {
        if (sheet.scrollHeight > sheet.clientHeight + 1) console.warn('打印页内容溢出：', sheet.scrollHeight - sheet.clientHeight, 'px');
      });
      win.focus(); win.print();
    };
    const ready = () => {
      const fonts = (win.document as Document & { fonts?: FontFaceSet }).fonts;
      const afterFonts = () => win.requestAnimationFrame(() => win.requestAnimationFrame(doPrint));
      fonts?.ready ? fonts.ready.then(afterFonts) : afterFonts();
    };
    win.addEventListener('afterprint', () => { try { win.close(); } catch {} });
    win.document.readyState === 'complete' ? ready() : win.addEventListener('load', ready, { once: true });
  }

  closeDialogs(): void {
    this.editListOpen = false; this.formOpen = false; this.errorText = '';
    this.nurseQuery = ''; this.nurseDropdownOpen = false; this.selectedNurse = null;
    this.doctorQuery = ''; this.doctorDropdownOpen = false;
    this.inspectorQuery = ''; this.inspectorDropdownOpen = false;
  }
  fmtRecordDate(value?: string): string {
    if (!value) return '';
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (!m) return value;
    return m[4] ? `${m[1]}-${m[2]}-${m[3]}<br>${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`;
  }
  fmtFullDate(value?: string): string {
    if (!value) return '';
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (!m) return value;
    return m[4] ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`;
  }
  genderText(g?: string): string {
    if (g === 'Male' || g === 'M' || g === '男') return '男';
    if (g === 'Female' || g === 'F' || g === '女') return '女'; return g || '';
  }
  bedText(value?: string): string { return value ? (value.endsWith('床') ? value : `${value}床`) : ''; }

  private fetchRecords(pid: string) {
    this.loading = true; this.loadError = '';
    return this.http.get<SggrfkcsRecord[]>(`${this.API}/listByPid`, { params: { pid } }).pipe(
      tap(list => {
        this.records = (Array.isArray(list) ? list : []).map(r => this.normalizeRecord(r))
          .sort((a, b) => this.dateValue(a.recordDate) - this.dateValue(b.recordDate));
        this.paginate();
      }),
      catchError(error => {
        this.records = []; this.loadError = error?.error?.message || '监测记录加载失败';
        this.paginate(); return of([] as SggrfkcsRecord[]);
      }),
      finalize(() => { this.loading = false; this.cdr.detectChanges(); }),
    );
  }
  private reload(): void { this.refresh$.next(); }
  private paginate(): void {
    const output: RenderPage[] = [];
    const source: Array<SggrfkcsRecord | null> = this.records.length ? [...this.records] : [null];
    for (let i = 0; i < source.length; i += this.rowsPerPage) {
      const rows = source.slice(i, i + this.rowsPerPage);
      while (rows.length < this.rowsPerPage) rows.push(null);
      const first = rows.find(r => !!r);
      output.push({
        index: output.length + 1,
        records: rows,
        diagnosis: first
          ? resolveDiagnosisDisplay(this.patient, endOfShanghaiDayMs(first.recordDate), this.diagnosisDisplay)
          : resolveBlankDiagnosis(this.patient, this.diagnosisDisplay),
      });
    }
    this.pages = output;
    const normalized = normalizePrintPages(this.selectedPrintPages, this.pages.length);
    this.selectedPrintPages = normalized.length === this.pages.length && this.pages.length ? [] : normalized;
  }
  private emptyForm(pid: string): SggrfkcsRecord {
    return { pid, recordDate: '', measures: {}, doctorName: '', nurseId: '', nurseName: '', inspectorName: '' };
  }
  private normalizeRecord(record: SggrfkcsRecord): SggrfkcsRecord {
    return { ...this.emptyForm(String(record?.pid || this.pid || '')), ...record,
      measures: { ...(record?.measures || {}) }, doctorName: record?.doctorName || '',
      nurseName: record?.nurseName || '', inspectorName: record?.inspectorName || '' };
  }
  private loadAccounts(): void {
    const NURSE_PROFS = ['nurse', 'nurseleader', 'matron', 'practicenurse'];
    this.http.get<any[]>('/api/v1/icu/accounts').pipe(takeUntil(this.destroy$)).subscribe({
      next: rows => {
        const all = (Array.isArray(rows) ? rows : []).map(row => ({
          accountId: String(row?.accountId ?? row?._id ?? row?.id ?? '').trim(),
          accountName: String(row?.accountName ?? row?.trueName ?? row?.name ?? '').trim(),
          profession: String(row?.profession ?? '').trim(),
          username: String(row?.username ?? row?.loginName ?? '').trim(),
          code: String(row?.code ?? row?.jobNumber ?? '').trim(),
        })).filter(account => !!account.accountId && !!account.accountName);
        this.allAccounts = all;
        this.accounts = all.filter(a => NURSE_PROFS.includes(a.profession.toLowerCase()));
        this.filteredAccounts = this.accounts.slice(0, 20);
        const DOCTOR_PROFS = ['director', 'doctor'];
        this.doctorAccounts = all.filter(a => DOCTOR_PROFS.includes(a.profession.toLowerCase()));
        this.doctorFiltered = this.doctorAccounts.slice(0, 20);
        this.inspectorAccounts = this.resolveInspectorAccounts(all);
        this.inspectorFiltered = this.inspectorAccounts.slice(0, 20);
      },
      error: () => {
        this.accounts = []; this.filteredAccounts = []; this.allAccounts = [];
        this.inspectorAccounts = this.resolveInspectorAccounts([]);
        this.inspectorFiltered = this.inspectorAccounts.slice(0, 20);
      },
    });
  }
  private resolveInspectorAccounts(all: AccountOption[]): AccountOption[] {
    return INSPECTOR_NAMES.map(name => all.find(a => a.accountName === name)
      || { accountId: name, accountName: name });
  }
  private patientId(p: any): string {
    return String(p?.id ?? p?._id ?? p?.pid ?? p?.patientId ?? p?.patientID ?? '').trim();
  }
  private toLocalDate(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  private dateValue(value?: string): number {
    if (!value) return 0;
    const t = new Date(value.includes('T') ? value : `${value}T00:00:00`).getTime();
    return Number.isNaN(t) ? 0 : t;
  }
  private calcAge(value?: string): number | null {
    if (!value) return null; const b = new Date(value); if (Number.isNaN(b.getTime())) return null;
    const n = new Date(); let age = n.getFullYear() - b.getFullYear();
    if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) age--;
    return age >= 0 ? age : null;
  }
  private formatDiagnosis(value?: string): string {
    return firstDiagnosisSegment(value, 'legacy');
  }
}

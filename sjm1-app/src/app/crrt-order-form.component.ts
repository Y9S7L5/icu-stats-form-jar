import { Component, ChangeDetectorRef, NgZone, OnDestroy, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { forkJoin, of, firstValueFrom, Subject } from 'rxjs';
import { catchError, finalize, map, switchMap, takeUntil } from 'rxjs/operators';
import { HostPatientService } from './services/host-patient.service';
import { IcuFormViewerContextService } from './icu-form-viewer-context.service';
import { normalizePrintPages, shouldPrintPage, selectedPrintPageCount } from './form-print-pages.util';
import { extractRecordTimeMs, firstDiagnosisSegment, resolveDiagnosisDisplay } from './diagnosis-history.util';
import { DiagnosisHistoryService } from './diagnosis-history.service';

type AutoSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

interface CheckboxOption { id: string; label: string; }
interface AccountOption { accountId: string; accountName: string; profession?: string; username?: string; code?: string; }
interface SignatureValue { accountId: string; accountName: string; signedAt?: string | null; }
interface OrderTimeOption { id: string; orderTime: string; updatedAt?: string; sessionIndex?: number; }
interface PrescriptionColumn { code: string; dateTime: string; baseSolution: number | null; potassiumChloride: number | null; sodiumChloride: number | null; doctorSignature: SignatureValue | null; executionTime: string; nurseSignature: SignatureValue | null; }
interface OrderItem { dateTime: string; content: string; doctorSignature: SignatureValue | null; executionTime: string; nurseSignature: SignatureValue | null; }
interface AnticoagulationValue {
  types: string[];
  heparinGroupFirstDose: number|null; heparinGroupMaintenance: number|null;
  lowMolecularSodiumFirstDose: number|null; lowMolecularSodiumMaintenance: number|null;
  citrateMaintenance: number|null; calciumMaintenance: number|null;
  nafamostatFirstDose: number|null; nafamostatMaintenance: number|null;
}
interface CrrtOrderFormRecord {
  id?: string; version?: number;
  pid: string; department: string; patientName: string; bedNo: string; age: string; gender: string; hospitalNo: string; diagnosis: string;
  orderTime: string;
  vascularAccess: string[]; treatmentModes: string[]; machineConsumables: string[];
  anticoagulation: AnticoagulationValue;
  cbpDose: { preReplacement: number|null; postReplacement: number|null; dialysate: number|null; sodiumBicarbonate: number|null; plasmaSeparationSpeed: number|null; plasmaDiscardSpeed: number|null; plasmaReplacementSpeed: number|null; totalPlasmaExchange: number|null; };
  replacementFormulaA: { baseSolution: number|null; potassiumChloride: number|null; sodiumChloride: number|null; };
  dialysateFormulaA: { baseSolution: number|null; potassiumChloride: number|null; sodiumChloride: number|null; };
  treatmentPlan: { bloodFlow: number|null; estimatedHours: number|null; ultrafiltrationRate: number|string|null; };
  doctorSignature: SignatureValue|null; machineNurseSignature: SignatureValue|null; checkNurseSignature: SignatureValue|null;
  replacementPrescriptions: PrescriptionColumn[]; dialysatePrescriptions: PrescriptionColumn[]; orderItems: OrderItem[];
  createdAt?: string; updatedAt?: string;
}

const DOCTOR_PROFS = ['director', 'doctor'];
const NURSE_PROFS = ['nurse', 'matron', 'nurseleader', 'practicenurse'];
const ADMIN_PROFS = ['systemadmin', 'admin'];


@Component({
  standalone: false, selector: 'app-crrt-order-form',
  templateUrl: './crrt-order-form.component.html', styleUrls: ['./crrt-order-form.component.css'],
})
export class CrrtOrderFormComponent implements OnInit, OnDestroy {
  private readonly destroy$ = new Subject<void>();
  readonly apiUrl = '/api/v1/icu/crrt-orders';

  patient: any = null; account: any = null;
  pid = ''; age: number | null = null; diagnosisDisplay = '';
  record: CrrtOrderFormRecord = this.createEmptyRecord();
  timeOptions: OrderTimeOption[] = [];
  selectedRecordId = '';
  doctorAccounts: AccountOption[] = [];
  nurseAccounts: AccountOption[] = [];
  loading = false; isDraft = false; hasRecords = false;
  message = ''; errorMessage = '';
  switchingRecord = false; creating = false; deleting = false;

  /* 新增弹框 */
  createDialogOpen = false;
  createDraftTime = '';
  createDialogError = '';

  /* 打印 */
  selectedPrintPages: number[] = [];
  printingAll = false;
  printAllMode = false;
  printRecords: CrrtOrderFormRecord[] = [];

  /* 自动保存 */
  autoSaveState: AutoSaveState = 'idle';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveInFlight = false;
  private saveAgainAfterCurrent = false;
  private localRevision = 0;
  private savedRevision = 0;

  readonly vascularAccessOptions = ['右侧股静脉','左侧股静脉','右侧颈内静脉','左侧颈内静脉','右侧锁骨下静脉','左侧锁骨下静脉','动静脉内瘘','ECMO'];
  readonly vascularAccessLeft = ['右侧股静脉','右侧颈内静脉','右侧锁骨下静脉','动静脉内瘘'];
  readonly vascularAccessRight = ['左侧股静脉','左侧颈内静脉','左侧锁骨下静脉','ECMO'];
  readonly treatmentModeOptions = ['CVVH','CVVHD','CVVHDF','SCUF','HP','PE','DPMAS','DFPP','CPFA','ECCO2R'];
  readonly treatmentModeLeft = ['CVVH','CVVHDF','HP','DPMAS','CPFA'];
  readonly treatmentModeRight = ['CVVHD','SCUF','PE','DFPP','ECCO2R'];
  readonly machineConsumableOptions = ['金宝','日机装','山外山','贝朗','M150','血液滤过管路（日机装）','TWT-CBP-02P（山外山）','一次性使用体外循环血路（贝朗）','AV600S','HA330','HA330-II','膜式血浆分离器','BS330','二级膜 EC-50W','ST150','OXIRIS'];
  readonly machineConsumableRows: ReadonlyArray<ReadonlyArray<CheckboxOption>> = [
    [{ id: 'machine-gambro', label: '金宝' }, { id: 'filter-m150', label: 'M150' }],
    [{ id: 'machine-nikkiso', label: '日机装' }, { id: 'circuit-nikkiso', label: '血液滤过管路（日机装）' }, { id: 'av600s-nikkiso', label: 'AV600S' }],
    [{ id: 'machine-shanwaishan', label: '山外山' }, { id: 'circuit-twt-cbp-02p', label: 'TWT-CBP-02P（山外山）' }, { id: 'av600s-shanwaishan', label: 'AV600S' }],
    [{ id: 'machine-bbraun', label: '贝朗' }, { id: 'circuit-bbraun', label: '一次性使用体外循环血路（贝朗）' }, { id: 'av600s-bbraun', label: 'AV600S' }],
    [{ id: 'cartridge-ha330', label: 'HA330' }, { id: 'cartridge-ha330-ii', label: 'HA330-II' }, { id: 'plasma-separator', label: '膜式血浆分离器' }, { id: 'filter-bs330', label: 'BS330' }],
    [{ id: 'secondary-membrane-ec-50w', label: '二级膜 EC-50W' }, { id: 'filter-st150', label: 'ST150' }, { id: 'filter-oxiris', label: 'OXIRIS' }],
  ];

  readonly machineConsumableDefaults: Readonly<Record<string, readonly string[]>> = {
    'machine-gambro': ['filter-m150'],
    'machine-nikkiso': ['circuit-nikkiso', 'av600s-nikkiso'],
    'machine-shanwaishan': ['circuit-twt-cbp-02p', 'av600s-shanwaishan'],
    'machine-bbraun': ['circuit-bbraun', 'av600s-bbraun'],
  };

  private readonly customConsumablePrefix = 'custom-consumable:';
  customConsumableSelected = false;
  customConsumableText = '';
  readonly replacementCodes = ['B','C','D','E','F','G','H','I'];
  readonly dialysateCodes = ['b','c','d','e','f','g','h','i'];
  readonly anticoagulationOptions = ['无肝素','肝素钠','低分子肝素','低分子肝素钠','4%枸橼酸钠','10%葡萄糖酸钙','甲磺酸萘莫司他'];

  // Viewer 模式标志
  isViewerMode = false;

  constructor(private http: HttpClient, private hostPatient: HostPatientService, private cdr: ChangeDetectorRef, private ngZone: NgZone, private contextService: IcuFormViewerContextService, private diagHistory: DiagnosisHistoryService) {}

  ngOnInit(): void {
    // 检测 viewer 模式
    this.contextService.getContext$().pipe(
      takeUntil(this.destroy$),
    ).subscribe(ctx => {
      this.isViewerMode = ctx.isViewerMode;
      this.cdr.markForCheck();
    });

    window.addEventListener('beforeunload', this.beforeUnloadHandler);
    window.addEventListener('afterprint', this.afterPrintHandler);
    this.hostPatient.account$.pipe(takeUntil(this.destroy$)).subscribe(a => { if (a) this.account = a; });
    this.hostPatient.patient$.pipe(
      switchMap(p => p ? this.diagHistory.ensurePatient(p) : of(p)),
      takeUntil(this.destroy$),
    ).subscribe(p => {
      if (!p) return;
      const oldPid = this.pid;
      this.patient = p;
      const newPid = this.resolvePid(p);
      this.pid = newPid;
      this.age = this.calcAge(p.birthday);
      this.diagnosisDisplay = resolveDiagnosisDisplay(p, Date.now(), this.formatDiagnosis(p.clinicalDiagnosis || p.diagnosis));
      if (newPid && newPid !== oldPid) { this.flushAutoSave(); this.record = this.createEmptyRecord(); this.customConsumableSelected = false; this.customConsumableText = ''; this.selectedPrintPages = []; this.applyPatientToRecord(this.record); this.loadTimeOptions(); }
    });
    this.loadSignatureAccounts();
  }

  ngOnDestroy(): void { this.flushAutoSave(); window.removeEventListener('beforeunload', this.beforeUnloadHandler); window.removeEventListener('afterprint', this.afterPrintHandler); if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; } this.destroy$.next(); this.destroy$.complete(); }

  private beforeUnloadHandler = (e: BeforeUnloadEvent) => { if (this.autoSaveState === 'dirty' || this.autoSaveState === 'saving' || this.saveInFlight) { e.preventDefault(); e.returnValue = ''; } };

  private readonly afterPrintHandler = (): void => {
    this.ngZone.run(() => this.resetPrintState());
  };

  /* 权限 */
  get profession(): string { return String(this.account?.profession ?? '').trim().toLowerCase(); }
  isDoctorRole(): boolean { return DOCTOR_PROFS.includes(this.profession); }
  isNurseRole(): boolean { return NURSE_PROFS.includes(this.profession); }
  isAdminRole(): boolean { return ADMIN_PROFS.includes(this.profession); }
  canEditDoctorField(): boolean { return this.isFormActive() && (this.isDoctorRole() || this.isAdminRole()); }
  canEditNurseField(): boolean { return this.isFormActive() && (this.isNurseRole() || this.isAdminRole()); }
  isFormActive(): boolean { return this.isDraft || !!this.record.id; }
  private currentAccountId(): string { return String(this.account?.id ?? this.account?._id ?? this.account?.accountId ?? '').trim(); }
  genderText(g?: string|number): string { const v = String(g ?? '').trim(); if (['Male','M','男','1'].includes(v)) return '男'; if (['Female','F','女','2'].includes(v)) return '女'; return v; }

  /* 签名排序：当前账号排第一，但不默认选中 */
  private currentAccountKeys(): Set<string> {
    return new Set(
      [this.account?.id, this.account?._id, this.account?.accountId, this.account?.username, this.account?.code, this.account?.jobNumber]
        .map(v => String(v ?? '').trim())
        .filter(Boolean)
    );
  }
  private isCurrentAccount(option: AccountOption): boolean {
    const keys = this.currentAccountKeys();
    return [option.accountId, option.username, option.code].map(v => String(v ?? '').trim()).filter(Boolean).some(v => keys.has(v));
  }
  private putCurrentAccountFirst(accounts: AccountOption[]): AccountOption[] {
    const idx = accounts.findIndex(a => this.isCurrentAccount(a));
    if (idx <= 0) return [...accounts];
    return [accounts[idx], ...accounts.slice(0, idx), ...accounts.slice(idx + 1)];
  }
  get orderedDoctorAccounts(): AccountOption[] { return this.putCurrentAccountFirst(this.doctorAccounts); }
  get orderedNurseAccounts(): AccountOption[] { return this.putCurrentAccountFirst(this.nurseAccounts); }

  /* 场次编号计算 */
  private orderTimeValue(value: string | null | undefined): number {
    if (!value) return Number.POSITIVE_INFINITY;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
  }

  private assignSessionIndexes(options: OrderTimeOption[]): OrderTimeOption[] {
    const ascendingOptions = [...options].sort((a, b) => {
      const aTime = this.orderTimeValue(a.orderTime);
      const bTime = this.orderTimeValue(b.orderTime);
      const timeDifference = aTime - bTime;
      if (timeDifference !== 0) return timeDifference;
      return String(a.id ?? '').localeCompare(String(b.id ?? ''));
    });
    const sessionIndexMap = new Map<string, number>();
    ascendingOptions.forEach((option, index) => {
      sessionIndexMap.set(String(option.id), index + 1);
    });
    return options.map(option => ({
      ...option,
      sessionIndex: sessionIndexMap.get(String(option.id)) ?? 0,
    }));
  }

  orderTimeOptionLabel(option: OrderTimeOption): string {
    const sessionIndex = Number(option?.sessionIndex) || 0;
    const timeText = this.displayTime(option?.orderTime);
    if (!sessionIndex && !timeText) return '';
    if (!sessionIndex) return timeText;
    if (!timeText) return `第 ${sessionIndex} 场`;
    return `第 ${sessionIndex} 场（${timeText}）`;
  }

  sessionIndexOfRecordId(recordId: string | null | undefined): number | null {
    const normalizedId = String(recordId ?? '').trim();
    if (!normalizedId) return null;
    const option = this.timeOptions.find(item => String(item.id) === normalizedId);
    return option?.sessionIndex ?? null;
  }

  get currentSessionIndex(): number | null {
    return this.sessionIndexOfRecordId(this.record?.id || this.selectedRecordId);
  }

  /* 加载 */
  loadTimeOptions(selectId?: string): void {
    if (!this.pid) return;
    this.loading = true; this.errorMessage = '';
    this.http.get<OrderTimeOption[]>(`${this.apiUrl}/patient/${encodeURIComponent(this.pid)}`)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: opts => {
          this.ngZone.run(() => {
            const descendingOptions = [...(opts ?? [])].sort((a, b) => {
              const aTime = this.orderTimeValue(a.orderTime);
              const bTime = this.orderTimeValue(b.orderTime);
              if (aTime !== bTime) return bTime - aTime;
              return String(b.id ?? '').localeCompare(String(a.id ?? ''));
            });
            this.timeOptions = this.assignSessionIndexes(descendingOptions);
            this.hasRecords = this.timeOptions.length > 0;
            if (!this.hasRecords) { this.selectedRecordId = ''; this.isDraft = false; this.record = this.createEmptyRecord(); this.customConsumableSelected = false; this.customConsumableText = ''; this.applyPatientToRecord(this.record); this.message = '当前患者暂无 CRRT 医嘱单，请点击新增后填写。'; this.loading = false; this.cdr.detectChanges(); return; }
            const id = selectId || this.timeOptions[0].id;
            this.selectedRecordId = id;
            this.loading = false;
            this.cdr.detectChanges();
            this.loadRecord(id);
          });
        },
        error: e => { this.ngZone.run(() => { this.errorMessage = e?.error?.message || '加载失败'; this.loading = false; this.cdr.detectChanges(); }); },
      });
  }

  loadRecord(id: string): void {
    if (!id || this.switchingRecord) return;
    const requestPid = this.pid;
    this.switchingRecord = true; this.loading = true; this.errorMessage = '';
    this.http.get<CrrtOrderFormRecord>(`${this.apiUrl}/${encodeURIComponent(id)}`)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: rec => {
          this.ngZone.run(() => {
            if (requestPid !== this.pid) return;
            this.record = this.normalizeRecord(rec);
            this.hydrateCustomConsumableState();
            this.selectedRecordId = this.record.id || id;
            this.isDraft = false; this.autoSaveState = 'idle'; this.localRevision = 0; this.savedRevision = 0; this.errorMessage = '';
            this.switchingRecord = false; this.loading = false; this.cdr.detectChanges();
          });
        },
        error: e => {
          this.ngZone.run(() => {
            if (requestPid !== this.pid) return;
            this.errorMessage = e?.error?.message || 'CRRT 医嘱单加载失败。';
            this.selectedRecordId = this.record.id || '';
            this.switchingRecord = false; this.loading = false; this.cdr.detectChanges();
          });
        },
      });
  }

  onTimeChange(id: string): void {
    if (!id || id === this.record.id || this.switchingRecord || this.creating) return;
    const prev = this.record.id || '';
    this.flushAutoSave();
    this.loadRecord(id);
  }

  /* 新增弹框 */
  openCreateDialog(): void {
    if (!this.pid) { this.errorMessage = '缺少患者信息'; return; }
    this.createDraftTime = this.toLocalDateTimeValue(new Date());
    this.createDialogError = '';
    this.createDialogOpen = true;
  }

  confirmCreate(): void {
    if (this.creating) return;
    this.createDialogError = '';
    if (!this.pid) { this.createDialogError = '缺少患者信息，不能创建医嘱单。'; return; }
    if (!this.createDraftTime) { this.createDialogError = '请选择医嘱时间。'; return; }
    if (this.timeOptions.some(o => this.sameMinute(o.orderTime, this.createDraftTime))) { this.createDialogError = '该医嘱时间已经存在，请选择其他时间。'; return; }
    const operatorId = this.currentAccountId();
    if (!operatorId) { this.createDialogError = '未获取到当前账号，不能创建医嘱单。'; return; }
    const draft = this.createEmptyRecord();
    this.applyPatientToRecord(draft);
    draft.orderTime = this.createDraftTime;
    this.creating = true;
    this.http.post(this.apiUrl, draft, { params: { operatorId } })
      .pipe(takeUntil(this.destroy$), finalize(() => { this.ngZone.run(() => { this.creating = false; this.cdr.detectChanges(); }); }))
      .subscribe({
        next: (saved: any) => {
          this.ngZone.run(() => {
            try {
              const normalized = this.normalizeRecord(saved as CrrtOrderFormRecord);
              this.record = normalized;
              this.hydrateCustomConsumableState();
              this.selectedRecordId = normalized.id || '';
              this.isDraft = false; this.autoSaveState = 'saved';
              this.upsertTimeOption(normalized);
              this.createDialogOpen = false; this.createDraftTime = ''; this.createDialogError = '';
            } catch (e) {
              console.error('CRRT record normalization failed', e, saved);
              this.createDialogError = '记录已创建，但服务器返回数据解析失败，请刷新后重试。';
            }
            this.cdr.detectChanges();
          });
        },
        error: e => { this.ngZone.run(() => { this.createDialogError = e?.error?.message || `创建失败${e?.status ? `（${e.status}）` : ''}`; this.cdr.detectChanges(); }); },
      });
  }

  /* 删除当前医嘱单 */
  deleteCurrentRecord(): void {
    const id = this.record?.id || this.selectedRecordId;
    if (!id || this.deleting || this.creating || this.switchingRecord) return;
    const timeText = this.displayTime(this.record?.orderTime);
    if (!confirm(`确认删除${timeText ? ` ${timeText} 的` : ''}CRRT 医嘱单？删除后不可恢复。`)) return;
    const operatorId = this.currentAccountId();
    const operationPid = this.pid;
    this.deleting = true;
    this.waitForSaveSettled(() => {
      this.http.delete(`${this.apiUrl}/${encodeURIComponent(id)}`, { params: { operatorId } })
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: () => {
            this.ngZone.run(() => {
              this.deleting = false;
              if (operationPid === this.pid) {
                this.autoSaveState = 'idle'; this.localRevision = 0; this.savedRevision = 0;
                this.loadTimeOptions();
              }
              this.cdr.detectChanges();
            });
          },
          error: e => {
            this.ngZone.run(() => {
              this.deleting = false;
              alert(e?.error?.message || '删除失败，请稍后重试');
              this.cdr.detectChanges();
            });
          },
        });
    });
  }

  /* 等待在途自动保存结束（期间取消后续保存，删除后不再写回） */
  private waitForSaveSettled(cb: () => void): void {
    const tick = () => {
      if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
      this.saveAgainAfterCurrent = false;
      if (this.saveInFlight) { setTimeout(tick, 100); return; }
      cb();
    };
    tick();
  }

  private upsertTimeOption(record: CrrtOrderFormRecord): void {
    if (!record.id) return;
    const opt: OrderTimeOption = { id: record.id, orderTime: record.orderTime, updatedAt: record.updatedAt };
    const others = this.timeOptions.filter(o => o.id !== opt.id);
    const descendingOptions = [opt, ...others].sort((a, b) => {
      const aTime = this.orderTimeValue(a.orderTime);
      const bTime = this.orderTimeValue(b.orderTime);
      if (aTime !== bTime) return bTime - aTime;
      return String(b.id ?? '').localeCompare(String(a.id ?? ''));
    });
    this.timeOptions = this.assignSessionIndexes(descendingOptions);
    this.hasRecords = true;
  }

  /* 自动保存 */
  onPageChanged(): void { if (!this.record.id) return; this.localRevision++; this.autoSaveState = 'dirty'; if (this.saveInFlight) this.saveAgainAfterCurrent = true; if (this.saveTimer) clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flushAutoSave(); }, 800); }
  onDiscreteChange(): void { if (!this.record.id) return; this.onPageChanged(); this.flushAutoSave(); }

  flushAutoSave(): void {
    if (!this.record.id || (this.autoSaveState !== 'dirty' && this.autoSaveState !== 'error')) return;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.saveInFlight) { this.saveAgainAfterCurrent = true; return; }
    const pid = this.record.pid; const reqRev = this.localRevision;
    const snap = JSON.parse(JSON.stringify(this.record));
    this.saveInFlight = true; this.saveAgainAfterCurrent = false; this.autoSaveState = 'saving'; this.cdr.detectChanges();
    this.http.put<CrrtOrderFormRecord>(`${this.apiUrl}/${this.record.id}?operatorId=${encodeURIComponent(this.currentAccountId())}`, snap)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: saved => {
          this.ngZone.run(() => {
            this.saveInFlight = false;
            if (pid !== this.record.pid) { this.cdr.detectChanges(); return; }
            this.record = this.normalizeRecord(saved);
            this.hydrateCustomConsumableState();
            if (reqRev === this.localRevision) { this.savedRevision = reqRev; this.autoSaveState = 'saved'; }
            else { this.autoSaveState = 'dirty'; this.saveAgainAfterCurrent = true; }
            if (this.saveAgainAfterCurrent) setTimeout(() => this.flushAutoSave(), 100);
            this.cdr.detectChanges();
          });
        },
        error: (e: any) => {
          this.ngZone.run(() => {
            this.saveInFlight = false; this.autoSaveState = 'error';
            if (e?.status === 409) this.errorMessage = '该医嘱单已被其他人员修改，请重新加载后再保存';
            this.cdr.detectChanges();
          });
        },
      });
  }

  retryAutoSave(): void { this.autoSaveState = 'dirty'; this.flushAutoSave(); }

  ensureCurrentRecordSaved(): Promise<void> {
    if (!this.record.id || this.autoSaveState === 'saved' || this.autoSaveState === 'idle') return Promise.resolve();
    this.flushAutoSave();
    return new Promise((resolve, reject) => {
      const check = () => { if (this.autoSaveState === 'saved' || this.autoSaveState === 'idle') resolve(); else if (this.autoSaveState === 'error') reject(new Error('save failed')); else setTimeout(check, 100); };
      check();
    });
  }

  trackRecordById(_: number, rec: CrrtOrderFormRecord): string { return rec.id || ''; }

  private waitForRender(): Promise<void> { return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))); }

  /* 数组操作 */
  toggleArrayValue(values: string[], value: string, checked: boolean): void { if (checked) { if (!values.includes(value)) values.push(value); } else { const i = values.indexOf(value); if (i >= 0) values.splice(i, 1); } }

  openDateTimePicker(input: HTMLInputElement | null, event?: Event): void {
    if (!input || input.disabled || input.readOnly) return;
    event?.preventDefault();
    event?.stopPropagation();
    input.focus({ preventScroll: true });
    if (typeof input.showPicker === 'function') {
      try { input.showPicker(); return; } catch { /* 当前浏览器不允许 showPicker 时，继续降级 */ }
    }
    try { input.click(); } catch { /* 不输出日志 */ }
  }

  onMachineConsumableChange(optionId: string, checked: boolean): void {
    this.toggleArrayValue(this.record.machineConsumables, optionId, checked);
    if (checked) {
      const defaults = this.machineConsumableDefaults[optionId] ?? [];
      for (const id of defaults) {
        if (!this.record.machineConsumables.includes(id)) {
          this.record.machineConsumables.push(id);
        }
      }
    }
    this.onDiscreteChange();
  }

  getCustomConsumableText(record: CrrtOrderFormRecord): string {
    const item = (record.machineConsumables || []).find(v => v.startsWith(this.customConsumablePrefix));
    return item ? item.slice(this.customConsumablePrefix.length) : '';
  }

  hasCustomConsumable(record: CrrtOrderFormRecord): boolean {
    return (record.machineConsumables || []).some(v => v.startsWith(this.customConsumablePrefix));
  }

  private hydrateCustomConsumableState(): void {
    this.customConsumableSelected = this.hasCustomConsumable(this.record);
    this.customConsumableText = this.getCustomConsumableText(this.record);
  }

  onCustomConsumableToggle(checked: boolean): void {
    this.customConsumableSelected = checked;
    this.removeCustomConsumableValue();
    if (!checked) {
      this.customConsumableText = '';
    } else {
      this.record.machineConsumables.push(this.customConsumablePrefix + this.customConsumableText.trim());
    }
    this.onDiscreteChange();
  }

  private removeCustomConsumableValue(): void {
    this.record.machineConsumables = (this.record.machineConsumables || []).filter(v => !v.startsWith(this.customConsumablePrefix));
  }

  onCustomConsumableTextChange(value: string): void {
    this.customConsumableText = value;
    this.removeCustomConsumableValue();
    if (this.customConsumableSelected) {
      this.record.machineConsumables.push(this.customConsumablePrefix + value.trim());
    }
    this.onPageChanged();
  }
  isChecked(values: string[], value: string): boolean { return values.includes(value); }
  updateSignature(target: any, key: string, accountId: string, accounts: AccountOption[]): void {
    const acc = accounts.find(a => a.accountId === accountId);
    target[key] = acc ? { accountId: acc.accountId, accountName: acc.accountName, signedAt: new Date().toISOString() } : null;
  }
  addOrderItem(): void { this.record.orderItems.push(this.createEmptyOrderItem()); this.onPageChanged(); }
  removeOrderItem(i: number): void { if (this.record.orderItems.length <= 1) return; this.record.orderItems.splice(i, 1); this.onPageChanged(); }
  trackByIndex(index: number): number { return index; }
  private dateTimeParts(value: string | null | undefined): { date: string; time: string } {
    if (!value) return { date: '', time: '' };
    const raw = String(value).trim();
    if (!raw) return { date: '', time: '' };
    const localMatch = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/);
    if (localMatch) return { date: localMatch[1], time: localMatch[2] };
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return { date: '', time: '' };
    const formatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const parts: Record<string, string> = {};
    formatter.formatToParts(parsed).forEach(p => { if (p.type !== 'literal') parts[p.type] = p.value; });
    return { date: `${parts['year']}-${parts['month']}-${parts['day']}`, time: `${parts['hour']}:${parts['minute']}` };
  }
  displayTime(value: string | null | undefined): string { const p = this.dateTimeParts(value); return p.date ? `${p.date} ${p.time}` : ''; }
  datePart(value: string | null | undefined): string { return this.dateTimeParts(value).date; }
  timePart(value: string | null | undefined): string { return this.dateTimeParts(value).time; }
  fmtDateTime(value: string | null | undefined): string { return this.displayTime(value); }
  sameMinute(a: string, b: string): boolean { return !!a && !!b && this.displayTime(a).substring(0, 16) === this.displayTime(b).substring(0, 16); }

  /* 打印：使用共享 ng-template + window.print() */
  async print(): Promise<void> {
    if (this.printingAll) return;
    this.errorMessage = '';
    try {
      await this.ensureCurrentRecordSaved();
      const snapshot = this.cloneRecord(this.record);
      this.applyPatientToRecord(snapshot);
      this.printAllMode = false;
      this.printRecords = [snapshot];
      this.cdr.detectChanges();
      await this.waitForRender();
      await this.waitForFonts();
      const normalized = normalizePrintPages(this.selectedPrintPages, 2);
      const expectedPageCount = normalized.length === 0 ? 2 : normalized.length;
      this.validatePrintPages(expectedPageCount);
      window.print();
    } catch (error) {
      console.error('CRRT print failed', error);
      this.errorMessage = error instanceof Error ? error.message : '打印准备失败，请重试。';
      this.resetPrintState();
    }
  }

  /* 一键打印全部 */
  async printAllOrders(): Promise<void> {
    if (this.printingAll || !this.timeOptions.length) return;
    this.printingAll = true;
    this.errorMessage = '';
    try {
      await this.ensureCurrentRecordSaved();
      const records = await firstValueFrom(
        forkJoin(this.timeOptions.map(option =>
          this.http.get<CrrtOrderFormRecord>(`${this.apiUrl}/${encodeURIComponent(option.id)}`).pipe(catchError(() => of(null)))
        ))
      );
      const validRecords = records
        .filter((item): item is CrrtOrderFormRecord => item !== null)
        .map(item => this.normalizeRecord(item))
        .sort((a, b) => {
          const timeDiff = this.toOrderTimestamp(a.orderTime) - this.toOrderTimestamp(b.orderTime);
          if (timeDiff !== 0) return timeDiff;
          return String(a.id ?? '').localeCompare(String(b.id ?? ''));
        });
      if (!validRecords.length) { throw new Error('没有可打印的医嘱记录。'); }
      for (const item of validRecords) { this.applyPatientToRecord(item); }
      const selectedLocalPages = normalizePrintPages(this.selectedPrintPages, 2);
      const pagesPerRecord = selectedLocalPages.length === 0 ? 2 : selectedLocalPages.length;
      this.printAllMode = true;
      this.printRecords = validRecords.map(item => this.cloneRecord(item));
      this.cdr.detectChanges();
      await this.waitForRender();
      await this.waitForFonts();
      const expectedPageCount = validRecords.length * pagesPerRecord;
      this.validatePrintPages(expectedPageCount);
      window.print();
    } catch (error) {
      console.error('CRRT print all failed', error);
      this.errorMessage = error instanceof Error ? error.message : '加载全部 CRRT 医嘱单失败。';
      this.resetPrintState();
    }
  }

  /* 深拷贝记录 */
  private cloneRecord(record: CrrtOrderFormRecord): CrrtOrderFormRecord {
    return this.normalizeRecord(JSON.parse(JSON.stringify(record)) as CrrtOrderFormRecord);
  }

  /* 统一患者信息 */
  private firstNonEmpty(...values: unknown[]): string {
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  /* ---- 页码计算 ---- */

  private toOrderTimestamp(value: string | null | undefined): number {
    if (!value) return 0;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  getChronologicalTimeOptions(): OrderTimeOption[] {
    return [...this.timeOptions].sort((a, b) => {
      const timeDiff = this.toOrderTimestamp(a.orderTime) - this.toOrderTimestamp(b.orderTime);
      if (timeDiff !== 0) return timeDiff;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  getRecordSequence(record: CrrtOrderFormRecord): number {
    const orderedOptions = this.getChronologicalTimeOptions();
    let index = orderedOptions.findIndex(option => !!record.id && option.id === record.id);
    if (index < 0 && record.orderTime) {
      index = orderedOptions.findIndex(option => this.sameMinute(option.orderTime, record.orderTime));
    }
    return index >= 0 ? index : 0;
  }

  getRecordPageBase(record: CrrtOrderFormRecord): number {
    return this.getRecordSequence(record) * 2;
  }

  getTotalPageCount(): number {
    const fallbackCount = (this.record?.id || this.isDraft) ? 1 : 0;
    return Math.max(this.timeOptions.length, fallbackCount) * 2;
  }

  getPrintPageFilter(): number[] {
    return normalizePrintPages(this.selectedPrintPages, 2);
  }

  isPrintPageSelected(pageNumber: number): boolean {
    return shouldPrintPage(pageNumber, this.selectedPrintPages, 2);
  }

  shouldPrintOrderPage(localPageNumber: number): boolean {
    return shouldPrintPage(localPageNumber, this.selectedPrintPages, 2);
  }

  getPrintRecordPageBase(record: CrrtOrderFormRecord, printIndex: number): number {
    return this.printAllMode ? printIndex * 2 : this.getRecordPageBase(record);
  }

  getPrintTotalPageCount(): number {
    return this.printAllMode ? this.printRecords.length * 2 : this.getTotalPageCount();
  }

  getPatientHeader(order: CrrtOrderFormRecord) {
    const legacyDiag = this.firstNonEmpty(order.diagnosis, this.diagnosisDisplay, this.patient?.clinicalDiagnosis, this.patient?.diagnosis, this.patient?.diagnose);
    return {
      department: this.firstNonEmpty(order.department, this.patient?.dept, this.patient?.deptName, this.patient?.departmentName, this.patient?.wardName),
      patientName: this.firstNonEmpty(order.patientName, this.patient?.name, this.patient?.patientName),
      bedNo: this.firstNonEmpty(order.bedNo, this.patient?.hisBed, this.patient?.bedNo, this.patient?.bedNumber, this.patient?.bedName),
      hospitalNo: this.firstNonEmpty(order.hospitalNo, this.patient?.mrn, this.patient?.hospitalNo, this.patient?.admissionNo, this.patient?.visitId),
      age: this.firstNonEmpty(order.age, String(this.age ?? '')),
      gender: this.firstNonEmpty(order.gender, this.genderText(this.patient?.gender)),
      // 新逻辑按该医嘱 orderTime 所在区间取诊断；旧逻辑保持原回退链逐字不变
      diagnosis: resolveDiagnosisDisplay(this.patient, extractRecordTimeMs(order, ['orderTime']), legacyDiag),
    };
  }

  /* 等待字体加载 */
  private waitForFonts(): Promise<void> {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    return fonts?.ready ? fonts.ready.then(() => undefined) : Promise.resolve();
  }

  /* 打印状态清理 */
  private resetPrintState(): void {
    this.printAllMode = false;
    this.printRecords = [];
    this.printingAll = false;
    this.cdr.detectChanges();
  }

  /* 打印页数校验 */
  private validatePrintPages(expectedPageCount: number): void {
    const root = document.getElementById('printRoot');
    if (!root) { throw new Error('未找到打印区域。'); }
    const pages = Array.from(root.querySelectorAll<HTMLElement>('.crrt-print-page'));
    if (pages.length !== expectedPageCount) {
      throw new Error(`打印页数异常：应为 ${expectedPageCount} 页，实际为 ${pages.length} 页。`);
    }
    pages.forEach((page, index) => {
      const horizontalOverflow = page.scrollWidth - page.clientWidth;
      const verticalOverflow = page.scrollHeight - page.clientHeight;
      if (horizontalOverflow > 1) { throw new Error(`打印第 ${index + 1} 页存在横向溢出 ${horizontalOverflow}px。`); }
      if (verticalOverflow > 1) { throw new Error(`打印第 ${index + 1} 页存在纵向溢出 ${verticalOverflow}px。`); }
    });
  }

  /* 签名账号加载 */
  private loadSignatureAccounts(): void {
    forkJoin({
      d: this.http.get<any[]>('/api/v1/icu/accounts?profession=Director').pipe(catchError(() => of([]))),
      e: this.http.get<any[]>('/api/v1/icu/accounts?profession=Doctor').pipe(catchError(() => of([]))),
      n: this.http.get<any[]>('/api/v1/icu/accounts?profession=Nurse').pipe(catchError(() => of([]))),
      m: this.http.get<any[]>('/api/v1/icu/accounts?profession=Matron').pipe(catchError(() => of([]))),
      nl: this.http.get<any[]>('/api/v1/icu/accounts?profession=NurseLeader').pipe(catchError(() => of([]))),
      pn: this.http.get<any[]>('/api/v1/icu/accounts?profession=PracticeNurse').pipe(catchError(() => of([]))),
    }).pipe(takeUntil(this.destroy$)).subscribe(r => {
      this.doctorAccounts = this.uniqueAcc([...r.d, ...r.e]);
      this.nurseAccounts = this.uniqueAcc([...r.n, ...r.m, ...r.nl, ...r.pn]);
    });
  }
  private uniqueAcc(list: any[]): AccountOption[] {
    const m = new Map<string, AccountOption>();
    for (const a of list ?? []) {
      const id = String(a?.accountId ?? a?._id ?? a?.id ?? '').trim();
      const name = String(a?.accountName ?? a?.trueName ?? a?.name ?? '').trim();
      if (!id || !name) continue;
      m.set(id, {
        accountId: id, accountName: name, profession: a?.profession,
        username: String(a?.username ?? '').trim(),
        code: String(a?.code ?? a?.jobNumber ?? '').trim(),
      });
    }
    return [...m.values()].sort((a, b) => a.accountName.localeCompare(b.accountName, 'zh-CN'));
  }

  /* 数据模型 */
  private createEmptyRecord(): CrrtOrderFormRecord {
    return {
      pid: '', department: '', patientName: '', bedNo: '', age: '', gender: '', hospitalNo: '', diagnosis: '', orderTime: '',
      vascularAccess: [], treatmentModes: [], machineConsumables: [],
      anticoagulation: { types: [], heparinGroupFirstDose: null, heparinGroupMaintenance: null, lowMolecularSodiumFirstDose: null, lowMolecularSodiumMaintenance: null, citrateMaintenance: null, calciumMaintenance: null, nafamostatFirstDose: null, nafamostatMaintenance: null },
      cbpDose: { preReplacement: null, postReplacement: null, dialysate: null, sodiumBicarbonate: null, plasmaSeparationSpeed: null, plasmaDiscardSpeed: null, plasmaReplacementSpeed: null, totalPlasmaExchange: null },
      replacementFormulaA: { baseSolution: 4000, potassiumChloride: null, sodiumChloride: null },
      dialysateFormulaA: { baseSolution: 4000, potassiumChloride: null, sodiumChloride: null },
      treatmentPlan: { bloodFlow: null, estimatedHours: null, ultrafiltrationRate: null },
      doctorSignature: null, machineNurseSignature: null, checkNurseSignature: null,
      replacementPrescriptions: this.prescriptions(['B','C','D','E','F','G','H','I']),
      dialysatePrescriptions: this.prescriptions(['b','c','d','e','f','g','h','i']),
      orderItems: Array.from({ length: 8 }, () => this.createEmptyOrderItem()),
    };
  }
  private prescriptions(codes: string[]): PrescriptionColumn[] { return codes.map(cd => ({ code: cd, dateTime: '', baseSolution: 4000, potassiumChloride: null, sodiumChloride: null, doctorSignature: null, executionTime: '', nurseSignature: null })); }
  private padPrescriptions(list: PrescriptionColumn[], codes: string[]): PrescriptionColumn[] {
    const result = codes.map((code, i) => ({ code, dateTime: '', baseSolution: 4000, potassiumChloride: null, sodiumChloride: null, doctorSignature: null, executionTime: '', nurseSignature: null, ...(list[i] ?? {}) }));
    return result;
  }
  private createEmptyOrderItem(): OrderItem { return { dateTime: '', content: '', doctorSignature: null, executionTime: '', nurseSignature: null }; }

  private normalizeMachineConsumables(values: unknown): string[] {
    const source = Array.isArray(values) ? values.map(v => String(v)) : [];
    const legacyMap: Record<string, string[]> = {
      '金宝': ['machine-gambro'], 'M150': ['filter-m150'],
      '日机装': ['machine-nikkiso'], '血液滤过管路（日机装）': ['circuit-nikkiso'],
      '山外山': ['machine-shanwaishan'], 'TWT-CBP-02P（山外山）': ['circuit-twt-cbp-02p'],
      '贝朗': ['machine-bbraun'], '一次性使用体外循环血路（贝朗）': ['circuit-bbraun'],
      'HA330': ['cartridge-ha330'], 'HA330-II': ['cartridge-ha330-ii'],
      '膜式血浆分离器': ['plasma-separator'], 'BS330': ['filter-bs330'],
      '二级膜 EC-50W': ['secondary-membrane-ec-50w'], 'ST150': ['filter-st150'], 'OXIRIS': ['filter-oxiris'],
      'AV600S': ['av600s-nikkiso', 'av600s-shanwaishan', 'av600s-bbraun'],
    };
    const normalized = source.flatMap(v => {
      if (['av600s-nikkiso','av600s-shanwaishan','av600s-bbraun'].includes(v)) return [v];
      return legacyMap[v] ?? [v];
    });
    return [...new Set(normalized)];
  }

  private normalizeAnticoagulation(value: any): AnticoagulationValue {
    const source = value ?? {};
    return {
      types: Array.isArray(source.types) ? source.types.map(String) : [],
      heparinGroupFirstDose: source.heparinGroupFirstDose ?? source.heparinFirstDose ?? null,
      heparinGroupMaintenance: source.heparinGroupMaintenance ?? source.heparinMaintenance ?? null,
      lowMolecularSodiumFirstDose: source.lowMolecularSodiumFirstDose ?? source.heparinFirstDose ?? null,
      lowMolecularSodiumMaintenance: source.lowMolecularSodiumMaintenance ?? source.heparinMaintenance ?? null,
      citrateMaintenance: source.citrateMaintenance ?? null,
      calciumMaintenance: source.calciumMaintenance ?? null,
      nafamostatFirstDose: source.nafamostatFirstDose ?? null,
      nafamostatMaintenance: source.nafamostatMaintenance ?? null,
    };
  }

  private normalizeRecord(rec: CrrtOrderFormRecord): CrrtOrderFormRecord {
    const empty = this.createEmptyRecord();
    return {
      ...empty, ...rec,
      anticoagulation: this.normalizeAnticoagulation(rec.anticoagulation),
      cbpDose: { ...empty.cbpDose, ...(rec.cbpDose ?? {}) },
      replacementFormulaA: { ...empty.replacementFormulaA, ...(rec.replacementFormulaA ?? {}) },
      dialysateFormulaA: { ...empty.dialysateFormulaA, ...(rec.dialysateFormulaA ?? {}) },
      treatmentPlan: { ...empty.treatmentPlan, ...(rec.treatmentPlan ?? {}) },
      vascularAccess: rec.vascularAccess ?? [], treatmentModes: rec.treatmentModes ?? [],
      machineConsumables: this.normalizeMachineConsumables(rec.machineConsumables),
      replacementPrescriptions: this.padPrescriptions(rec.replacementPrescriptions ?? [], this.replacementCodes),
      dialysatePrescriptions: this.padPrescriptions(rec.dialysatePrescriptions ?? [], this.dialysateCodes),
      orderItems: rec.orderItems?.length ? rec.orderItems : empty.orderItems,
    };
  }

  private applyPatientToRecord(rec: CrrtOrderFormRecord): void {
    const p = this.patient;
    rec.pid = this.resolvePid(p);
    rec.department = String(p?.dept ?? p?.deptName ?? p?.departmentName ?? p?.wardName ?? '');
    rec.patientName = String(p?.name ?? p?.patientName ?? '');
    rec.bedNo = String(p?.bedNo ?? p?.bedNumber ?? p?.bedName ?? '');
    rec.age = String(this.age ?? '');
    rec.gender = this.genderText(p?.gender);
    rec.hospitalNo = String(p?.hospitalNo ?? p?.admissionNo ?? p?.visitId ?? '');
    rec.diagnosis = String(p?.clinicalDiagnosis ?? p?.diagnosis ?? p?.diagnose ?? '');
  }

  private resolvePid(p: any): string { return String(p?.id ?? p?._id ?? p?.pid ?? p?.patientId ?? p?.patientID ?? '').trim(); }
  private calcAge(b?: string): number | null { if (!b) return null; const d = new Date(b); if (Number.isNaN(d.getTime())) return null; const n = new Date(); let a = n.getFullYear() - d.getFullYear(); const m = n.getMonth() - d.getMonth(); if (m < 0 || (m === 0 && n.getDate() < d.getDate())) a--; return a >= 0 && a < 150 ? a : null; }
  private formatDiagnosis(v?: string): string { return firstDiagnosisSegment(v, 'legacy'); }
  private toLocalDateTimeValue(d: Date): string { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
}

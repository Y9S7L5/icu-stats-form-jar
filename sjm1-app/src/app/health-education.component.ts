import { HttpClient } from '@angular/common/http';
import { ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit } from '@angular/core';
import { Subject } from 'rxjs';
import { distinctUntilChanged, filter, finalize, map, switchMap, takeUntil, tap } from 'rxjs/operators';
import { HostPatientService } from './services/host-patient.service';
import { IcuFormViewerContextService } from './icu-form-viewer-context.service';
import { normalizePrintPages, shouldPrintPage, selectedPrintPageCount } from './form-print-pages.util';
import { firstDiagnosisSegment, resolvePageDiagnosis } from './diagnosis-history.util';
import { DiagnosisHistoryService } from './diagnosis-history.service';

interface OptionItem { code: string; label: string; detail?: string; }
interface OptionGroup { name: string; items: OptionItem[]; }
interface HealthEducationRecord {
  id?: string; pid: string; assessmentTime: string; itemCodes: string[];
  educationTarget: 'A'|'B'|'AB'|''; evaluationCodes: string[];
  nurseId?: string; nurseName: string;
  specialMedicationOther?: string; externalExamOther?: string;
  internalExamOther?: string; otherEducation?: string;
  dischargeEducation?: boolean; transferEducation?: boolean;
  valuableCodes: string[]; valuableOther?: string;
  receiverConfirmed?: boolean; receiverName?: string; receivedAt?: string;
  valid?: boolean; updatedBy?: string;
}
interface AccountOption {
  accountId: string; accountName: string;
  username?: string; code?: string;
}
interface RenderPage { index: number; records: (HealthEducationRecord|null)[]; diagnosis?: string; }
interface HealthEducationSharedInfo { valuableCodes: string[]; valuableOther: string; receiverConfirmed: boolean; receiverName: string; receivedAt: string; }

const GROUPS: OptionGroup[] = [
  { name: '入院/转入宣教', items: [
    {code:'ADMISSION_STAFF',label:'人员介绍',detail:'科主任、护士长、主管医生、主管护士及护工等'},
    {code:'ENVIRONMENT',label:'环境介绍',detail:'医院环境、病区环境，如出入院处、医保办、病员服务中心等'},
    {code:'RULES',label:'介绍住院相关制度',detail:'病区管理、作息、探视、消毒隔离制度及护工服务内容等'},
    {code:'SAFETY',label:'介绍住院安全',detail:'用水、用电安全、禁止烟火、防盗、贵重物品保存、防烫伤等注意事项'},
    {code:'COST',label:'住院费用及住院一日清单发放说明等'},
    {code:'WARM_TIPS',label:'发放《入院温馨提示》',detail:'患者住院所需生活用物及饮食准备宣教'},
    {code:'RISKS',label:'患者跌倒坠床、皮肤压力性损伤、非计划性拔管、VTE发生及营养等风险告知及预防相关知识宣教'},
    {code:'RESTRAINT',label:'保护性约束及风险告知'}]},
  { name: '疾病宣教', items: [
    {code:'DISEASE_CARE',label:'疾病相关临床表现、主要治疗、心理护理及疾病护理教育（疾病护理要点、体位、营养、功能锻炼等）'}]},
  { name: '药物宣教', items: [
    {code:'ORAL_MEDICATION',label:'口服药宣教',detail:'作用、用药途径及方法'},
    {code:'ENTERAL_NUTRITION',label:'肠内营养制剂宣教',detail:'使用目的、途径及方法及注意事项等'},
    {code:'IV_MEDICATION',label:'静脉用药宣教',detail:'使用目的、途径及方法及注意事项等'},
    {code:'SPECIAL_ANTIBIOTIC',label:'特殊用药：抗菌药物'},
    {code:'VASOACTIVE',label:'特殊用药：血管活性药物'},
    {code:'SEDATION',label:'特殊用药：镇静镇痛药物'},
    {code:'SPECIAL_OTHER',label:'特殊用药：其他'}]},
  { name: '检查宣教', items: [
    {code:'EXAM_CT',label:'外出检查：CT'}, {code:'MRI',label:'外出检查：磁共振'},
    {code:'GASTROSCOPY',label:'外出检查：胃镜'}, {code:'EXAM_OTHER',label:'外出检查：其它'},
    {code:'TRANSPORT_RISK',label:'患者转运风险'},
    {code:'BRONCHOSCOPY',label:'科内检查：纤维支气管镜灌洗'},
    {code:'WARD_OTHER',label:'科内检查：其它'}]},
  { name: '术前宣教', items: [{code:'PREOP',label:'讲解术前准备的配合和注意事项，示范：体位练习、咳嗽、咳痰、床上排便方法等'}]},
  { name: '术后宣教', items: [{code:'POSTOP',label:'告知术后注意事项：饮食、活动、术口护理知识、管道护理、疼痛护理'}]},
  { name: '出院/转科宣教', items: [
    {code:'DISCHARGE_PROCEDURE',label:'办理出院（转科）手续，发出院（转科）带药及资料'},
    {code:'DISCHARGE_GUIDANCE',label:'出院（转科）饮食、用药指导、休息及预防疾病注意事项'},
    {code:'FOLLOWUP',label:'出院后复诊及随访事项，发放《出院通知单》'}]},
  { name: '其它', items: [{code:'OTHER',label:'其它宣教'}]}
];
const VALUABLES = ['无','手机','现金','医保卡','身份证','银行卡','钥匙','假牙'];

@Component({
  standalone: false,
  selector: 'app-health-education',
  templateUrl: './health-education.component.html',
  styleUrls: ['./health-education.component.css']
})
export class HealthEducationComponent implements OnInit, OnDestroy {
  private readonly API = '/api/v1/icu/health-education';
  readonly groups = GROUPS; readonly valuables = VALUABLES;
  readonly admissionGroup = GROUPS.find(g=>g.name==='入院/转入宣教')!;
  readonly diseaseGroup = GROUPS.find(g=>g.name==='疾病宣教')!;
  readonly medicationGroup = GROUPS.find(g=>g.name==='药物宣教')!;
  readonly examinationGroup = GROUPS.find(g=>g.name==='检查宣教')!;
  readonly otherGroup = GROUPS.find(g=>g.name==='其它')!;
  readonly remainingGroups = GROUPS.filter(g=>!['入院/转入宣教','疾病宣教','药物宣教','检查宣教','其它'].includes(g.name));
  readonly modalStandardGroups = GROUPS.filter(group =>
    ['入院/转入宣教','疾病宣教','术前宣教','术后宣教','出院/转科宣教'].includes(group.name)
  );
  readonly targetOptions = [{code:'A',label:'家属'},{code:'B',label:'病人'}];
  readonly evaluationOptions = [{code:'A',label:'能复述'},{code:'B',label:'能解释'},{code:'C',label:'能模仿'},{code:'D',label:'能操作'}];

  patient: any = null; hospitalName = '重钢总医院'; age: number|null = null;
  loading = false; saving = false; deletingId = ''; loadError = '';
  records: HealthEducationRecord[] = []; pages: RenderPage[] = [];
  selectedPrintPages: number[] = [];
  editListOpen = false; formOpen = false; editing = false; errorText = '';
  accounts: AccountOption[] = []; account: any = null;
  form: HealthEducationRecord = this.emptyForm('');
  sharedInfo: HealthEducationSharedInfo = this.emptySharedInfo();
  sharedDraft: HealthEducationSharedInfo = this.emptySharedInfo();
  sharedEditing = false; sharedSaving = false;
  nurseQuery = ''; nurseDropdownOpen = false; filteredAccounts: AccountOption[] = [];
  selectedNurse: AccountOption | null = null;
  private sharedCarrierRecord: HealthEducationRecord | null = null;
  private pid = ''; private destroy$ = new Subject<void>();
  private refresh$ = new Subject<void>();

  // Viewer 模式标志
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

    this.loadHospitalName(); this.loadAccounts();
    this.hostPatient.account$.pipe(takeUntil(this.destroy$)).subscribe(a => this.account = a);
    this.hostPatient.patient$.pipe(
      filter(Boolean), map(p => ({p, pid:String(p.id || '').trim()})), filter(x => !!x.pid),
      distinctUntilChanged((a,b) => a.pid === b.pid),
      switchMap(({ p, pid }) => this.diagHistory.ensurePatient(p).pipe(map(ep => ({ p: ep, pid })))),
      tap(({p,pid}) => { this.closeDialogs(); this.patient=p; this.pid=pid; this.age=this.calcAge(p.birthday); this.diagnosisDisplay=this.formatDiagnosis(p.clinicalDiagnosis); this.records=[]; this.sharedInfo=this.emptySharedInfo(); this.sharedDraft=this.emptySharedInfo(); this.sharedCarrierRecord=null; this.sharedEditing=false; this.paginate(); this.loadError=''; }),
      switchMap(({pid}) => this.fetchRecords(pid)), takeUntil(this.destroy$)
    ).subscribe();
    this.refresh$.pipe(takeUntil(this.destroy$)).subscribe(() => { if(this.pid) this.fetchRecords(this.pid).subscribe(); });
  }
  ngOnDestroy(): void { this.destroy$.next(); this.destroy$.complete(); }

  private fetchRecords(pid: string) {
    this.loading = true; this.loadError = '';
    return this.http.get<HealthEducationRecord[]>(`${this.API}/listByPid`, {params:{pid}}).pipe(
      tap(list => { this.records=(Array.isArray(list)?list:[]).sort((a,b)=>this.ts(a.assessmentTime)-this.ts(b.assessmentTime)); this.hydrateSharedInfo(); this.paginate(); }),
      finalize(()=>{this.loading=false; this.cdr.detectChanges();})
    );
  }
  private reload(): void { this.refresh$.next(); }

  openCreate(): void {
    if (!this.pid) return;
    this.editing = false; this.errorText = ''; this.form = this.emptyForm(this.pid);
    this.form.assessmentTime = this.toLocalInput(new Date());
    const currentId = String(this.account?.id ?? this.account?._id ?? this.account?.accountId ?? this.account?.username ?? '').trim();
    const currentName = String(this.account?.trueName ?? this.account?.accountName ?? this.account?.name ?? '').trim();
    this.form.nurseId = currentId;
    this.form.nurseName = currentName;
    this.nurseQuery = currentName;
    this.selectedNurse = currentId && currentName
      ? { accountId: currentId, accountName: currentName, username: String(this.account?.username || ''), code: String(this.account?.code ?? this.account?.jobNumber ?? '') }
      : null;
    this.filteredAccounts = this.accounts.slice(0, 20);
    this.nurseDropdownOpen = false;
    this.formOpen = true;
  }
  openEditList(): void { this.editListOpen=true; }
  editRecord(r: HealthEducationRecord): void {
    this.editListOpen=false; this.editing=true; this.errorText='';
    this.form=JSON.parse(JSON.stringify(r));
    this.form.assessmentTime=this.toLocalInput(new Date(r.assessmentTime));
    if (this.form.receivedAt) this.form.receivedAt=this.toLocalInput(new Date(this.form.receivedAt));
    this.form.itemCodes ||= []; this.form.evaluationCodes ||= []; this.form.valuableCodes ||= [];
    this.nurseQuery = this.form.nurseName || '';
    this.selectedNurse = this.form.nurseId && this.form.nurseName
      ? { accountId: this.form.nurseId, accountName: this.form.nurseName }
      : null;
    this.nurseDropdownOpen = false;
    this.formOpen=true;
  }
  save(): void {
    this.errorText='';
    if (!this.form.assessmentTime) { this.errorText='评估时间为必填项'; return; }
    if (!this.form.nurseName?.trim()) { this.errorText='护士签名为必填项'; return; }
    const nurseIsConfirmed = !!this.selectedNurse && !!this.form.nurseId
      && this.form.nurseId === this.selectedNurse.accountId
      && this.form.nurseName.trim() === this.selectedNurse.accountName;
    if (!nurseIsConfirmed) { this.errorText = '护士签名已被修改，请从检索结果中选择账号'; return; }
    if (this.form.itemCodes?.includes('EXAM_OTHER') && !this.form.externalExamOther?.trim()) { this.errorText='请选择并填写外出检查其它内容'; return; }
    if (this.form.itemCodes?.includes('WARD_OTHER') && !this.form.internalExamOther?.trim()) { this.errorText='请选择并填写科内检查其它内容'; return; }
    if (this.form.itemCodes?.includes('SPECIAL_OTHER') && !this.form.specialMedicationOther?.trim()) { this.errorText='请选择并填写特殊用药其他内容'; return; }
    if (this.form.itemCodes?.includes('OTHER') && !this.form.otherEducation?.trim()) { this.errorText='请选择并填写其它宣教内容'; return; }
    this.saving=true;
    const operationPid = this.pid;
    const body={...this.form, pid:this.pid, assessmentTime:new Date(this.form.assessmentTime).toISOString(),
      receivedAt:this.form.receivedAt ? new Date(this.form.receivedAt).toISOString() : undefined,
      nurseId: this.selectedNurse!.accountId, nurseName: this.selectedNurse!.accountName, updatedBy:String(this.account?.id || '')};
    this.http.post<HealthEducationRecord>(`${this.API}/save`, body).pipe(finalize(()=>this.saving=false), takeUntil(this.destroy$)).subscribe({
      next:()=>{ if(operationPid===this.pid){ this.formOpen=false; this.reload(); } },
      error:e=>this.errorText=e?.error?.message || '保存失败，请稍后重试'
    });
  }
  invalidate(r: HealthEducationRecord): void {
    if (!r.id || this.deletingId) return;
    if (!confirm(`确认删除 ${this.fmtDateTime(r.assessmentTime)} 的评估记录？`)) return;
    this.deletingId = r.id;
    const operationPid = this.pid;
    this.http.patch(`${this.API}/${r.id}/invalidate`, null, {params:{operatorId:String(this.account?.id || '')}}).pipe(
      finalize(()=>this.deletingId=''), takeUntil(this.destroy$)
    ).subscribe({
      next:()=>{ if(operationPid===this.pid) this.reload(); },
      error:()=>alert('删除失败')
    });
  }

  checked(r: HealthEducationRecord|null, code: string): string { return r?.itemCodes?.includes(code) ? '√' : ''; }
  checkedAny(r:HealthEducationRecord|null,codes:string[]):string{if(!r)return'';return codes.some(c=>r.itemCodes?.includes(c))?'√':'';}

  /**
   * 判断全部有效评估记录中，是否至少有一次选择了对应项目。
   * 返回 boolean，用于 HTML 方框组件的 [class.checked] 绑定和 *ngIf。
   */
  summarySelected(code: string): boolean {
    return this.records.some(record =>
      record?.itemCodes?.includes(code)
    );
  }
  /**
   * 判断单次评估是否选择了任意指定项目。
   */
  recordHasAny(record: HealthEducationRecord | null, codes: string[]): boolean {
    if (!record) return false;
    return codes.some(code => record.itemCodes?.includes(code));
  }
  /**
   * 用于后面的动态评估列显示一个普通 √。
   */
  recordAnyMark(record: HealthEducationRecord | null, codes: string[]): string {
    return this.recordHasAny(record, codes) ? '√' : '';
  }

  get otherEducationSummary(): string { return this.joinDistinctOtherValues(this.records.filter(r=>r.itemCodes?.includes('OTHER')&&!!r.otherEducation?.trim()).map(r=>r.otherEducation)); }
  get specialMedicationOtherSummary(): string { return this.joinDistinctOtherValues(this.records.filter(r=>r.itemCodes?.includes('SPECIAL_OTHER')&&!!r.specialMedicationOther?.trim()).map(r=>r.specialMedicationOther)); }
  get externalExamOtherSummary(): string { return this.joinDistinctOtherValues(this.records.filter(r=>r.itemCodes?.includes('EXAM_OTHER')&&!!r.externalExamOther?.trim()).map(r=>r.externalExamOther)); }
  get internalExamOtherSummary(): string { return this.joinDistinctOtherValues(this.records.filter(r=>r.itemCodes?.includes('WARD_OTHER')&&!!r.internalExamOther?.trim()).map(r=>r.internalExamOther)); }
  itemDisplayText(r:HealthEducationRecord|null,code:string):string{return r?.itemCodes?.includes(code)?'√':'';}
  valuableMark(r: HealthEducationRecord|null, code: string): string {
    return r?.valuableCodes?.includes(code) ? '☑' : '□';
  }
  has(arr: string[]|undefined, code: string): boolean { return !!arr?.includes(code); }
  toggle(field:'itemCodes'|'evaluationCodes'|'valuableCodes',code:string,on:boolean):void{const s=new Set(this.form[field]||[]);if(on){s.add(code)}else{s.delete(code);if(field==='itemCodes'){if(code==='SPECIAL_OTHER')this.form.specialMedicationOther='';if(code==='EXAM_OTHER')this.form.externalExamOther='';if(code==='WARD_OTHER')this.form.internalExamOther='';if(code==='OTHER')this.form.otherEducation='';}}this.form[field]=[...s];}
  targetMark(r: HealthEducationRecord|null, code: string): string {
    return r && (r.educationTarget===code || r.educationTarget==='AB') ? '√' : '';
  }
  evalText(r: HealthEducationRecord|null): string { return (r?.evaluationCodes || []).join('、'); }
  groupRows(g: OptionGroup): number { return g.items.length; }

  /** 判断某分组是否已全选 */
  isGroupAllSelected(group: OptionGroup): boolean {
    const codes = group.items.map(item => item.code);
    return codes.length > 0 && codes.every(code => (this.form.itemCodes || []).includes(code));
  }

  /** 切换某分组的全选/取消全选 */
  toggleGroupSelection(group: OptionGroup): void {
    const codes = group.items.map(item => item.code);
    if (this.isGroupAllSelected(group)) {
      this.form.itemCodes = (this.form.itemCodes || []).filter(code => !codes.includes(code));
      this.clearConditionalContent(codes);
    } else {
      const set = new Set(this.form.itemCodes || []);
      codes.forEach(code => set.add(code));
      this.form.itemCodes = [...set];
    }
  }

  /** 判断评价区域是否已全选 */
  areAllEvaluationsSelected(): boolean {
    const codes = this.evaluationOptions.map(o => o.code);
    return codes.length > 0 && codes.every(code => (this.form.evaluationCodes || []).includes(code));
  }

  /** 切换评价区域的全选/取消全选 */
  toggleAllEvaluations(): void {
    const codes = this.evaluationOptions.map(o => o.code);
    if (this.areAllEvaluationsSelected()) {
      this.form.evaluationCodes = [];
    } else {
      this.form.evaluationCodes = [...codes];
    }
  }

  /** 清理被移除选项对应的附带内容 */
  private clearConditionalContent(removedCodes: string[]): void {
    if (removedCodes.includes('SPECIAL_OTHER')) this.form.specialMedicationOther = '';
    if (removedCodes.includes('EXAM_OTHER')) this.form.externalExamOther = '';
    if (removedCodes.includes('WARD_OTHER')) this.form.internalExamOther = '';
    if (removedCodes.includes('OTHER')) this.form.otherEducation = '';
  }

  /* ---- 护士检索选择 ---- */
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
    const normalizedValue = value.trim();
    if (this.selectedNurse && normalizedValue === this.selectedNurse.accountName) {
      this.form.nurseId = this.selectedNurse.accountId;
      this.form.nurseName = this.selectedNurse.accountName;
    } else {
      this.selectedNurse = null;
      this.form.nurseId = '';
      this.form.nurseName = value;
    }
    const keyword = normalizedValue.toLowerCase();
    this.filteredAccounts = this.accounts
      .filter(account => {
        if (!keyword) return true;
        return [account.accountName, account.username, account.code].some(field =>
          String(field || '').toLowerCase().includes(keyword)
        );
      })
      .slice(0, 20);
    this.nurseDropdownOpen = true;
  }
  openNurseDropdown(): void {
    this.filteredAccounts = this.accounts.slice(0, 20);
    this.nurseDropdownOpen = true;
  }
  closeNurseDropdownLater(): void {
    window.setTimeout(() => { this.nurseDropdownOpen = false; }, 150);
  }

  isPrintPageSelected(pageNumber: number, totalPages = this.pages.length): boolean {
    return shouldPrintPage(pageNumber, this.selectedPrintPages, totalPages);
  }
  private normalizeSelectedPrintPages(totalPages: number): void {
    const normalized = normalizePrintPages(this.selectedPrintPages, totalPages);
    this.selectedPrintPages = (normalized.length === totalPages && totalPages > 0) ? [] : normalized;
  }
  print(): void {
    const allSheets = Array.from(this.host.nativeElement.querySelectorAll('.sheet')) as HTMLElement[];
    if (!allSheets.length) { alert('没有可打印的表单'); return; }
    const totalPages = allSheets.length;
    const normalized = normalizePrintPages(this.selectedPrintPages, totalPages);
    const expectedCount = normalized.length === 0 ? totalPages : normalized.length;
    if (expectedCount <= 0) { alert('请至少选择一个打印页码'); return; }
    let body = '';
    allSheets.forEach((s: HTMLElement, idx: number) => {
      const pageNumber = idx + 1;
      if (!shouldPrintPage(pageNumber, this.selectedPrintPages, totalPages)) return;
      const c = s.cloneNode(true) as HTMLElement;
      c.querySelectorAll('.no-print').forEach(el => el.remove());
      body += '<section class="print-page">' + c.outerHTML + '</section>';
    });
    const css = `
      @page{size:A4 portrait;margin:0}html,body{margin:0;padding:0;background:#fff}
      .print-page{box-sizing:border-box;width:210mm;height:297mm;overflow:hidden;page-break-after:always;break-after:page;background:#fff}
      .print-page:last-child{page-break-after:auto;break-after:auto}
      .sheet{box-sizing:border-box;position:relative;width:210mm;min-height:297mm;margin:0;padding:7mm 10mm;box-shadow:none;background:#fff;color:#000;overflow:hidden}
      h1{margin:0 0 4px;text-align:center;font-family:SimHei,sans-serif;font-size:18pt}
      .patient-line{display:flex;justify-content:space-between;margin:2px 0 4px;font-family:'SimSun','宋体',serif;font-size:11pt;font-weight:400;color:#000}
      .patient-line strong{font-weight:700}
      .paper-table{width:100%;border-collapse:collapse;table-layout:fixed;font-family:'SimSun','宋体',serif;font-size:9pt;font-weight:400;line-height:1.2;color:#000;text-shadow:none!important;filter:none!important}
      .paper-table th,.paper-table td{box-sizing:border-box;border:1px solid #000;padding:2px 3px;vertical-align:middle;font-family:inherit;font-size:inherit;color:#000;background:transparent;text-shadow:none!important;filter:none!important}
      .paper-table th{font-weight:700}.paper-table td{font-weight:400}
      .paper-table col.category-column{width:20px}.paper-table col.item-column{width:136px}.paper-table col.detail-column{width:auto}.paper-table col.record-column{width:46px}
      .paper-table .group{box-sizing:border-box;width:20px;min-width:20px;max-width:20px;padding:2px 1px;writing-mode:vertical-rl;text-orientation:upright;text-align:center;vertical-align:middle;white-space:normal;word-break:keep-all;font-size:9pt;font-weight:700;line-height:1.05;letter-spacing:0;color:#000}
      .paper-table .content{width:auto;padding:2px 4px;text-align:left;white-space:normal;word-break:normal;overflow-wrap:break-word}
      .paper-table .mark,.paper-table .time-cell,.paper-table .sign-cell{box-sizing:border-box;width:46px;min-width:46px;max-width:46px;padding:1px 2px;text-align:center;vertical-align:middle;white-space:normal;word-break:normal;font-size:9pt;font-weight:400;color:#000}
      .paper-table .time-cell{height:28px}
      .education-header{text-align:center;vertical-align:middle}
      .bottom-desc{text-align:left!important}
      .bottom-title{text-align:center}
      .other-summary-cell{padding:3px 5px!important;text-align:left;white-space:normal;word-break:normal;overflow-wrap:break-word;font-weight:400;line-height:1.3}
      .shared-info-cell,.handover-cell{padding:3px 5px!important;font-family:'SimSun','宋体',serif;font-size:9pt;font-weight:400;color:#000}
      .handover-cell .handover-content{display:grid;grid-template-columns:minmax(180px,1.2fr) minmax(160px,1fr) minmax(210px,1.2fr) auto;align-items:center;gap:8px 12px}
      .contact-cell{padding:3px 5px!important;text-align:center;font-family:'SimSun','宋体',serif;font-size:9pt;font-weight:400;line-height:1.2;color:#000}
      .time-date,.time-clock{display:block;text-align:center;white-space:nowrap;line-height:1.1}
      .sheet-pageno{position:absolute;right:0;bottom:35px;left:0;margin:0;text-align:center;font-family:'SimSun','宋体',serif;font-size:12pt;font-weight:400;line-height:1;color:#000;white-space:nowrap}
      .no-print,.shared-screen-editor,.shared-actions{display:none!important}
      .other-summary-cell .no-print{display:none!important}
      .merged-item-cell{width:136px;padding:2px 4px!important;text-align:center;vertical-align:middle;white-space:normal;word-break:normal;font-family:'SimSun','宋体',serif;font-size:9pt;font-weight:400;line-height:1.2}
      .detail-content-cell{padding:2px 4px!important;text-align:left;vertical-align:middle;white-space:normal;word-break:normal;overflow-wrap:break-word;font-family:'SimSun','宋体',serif;font-size:9pt;font-weight:400;line-height:1.25}
      .inline-other-part{display:inline;white-space:normal}
      .exam-prefix{display:inline;white-space:nowrap}
      .document-option{display:inline-flex;align-items:center;gap:2px;margin-right:6px;white-space:nowrap;vertical-align:middle}
      .document-checkbox{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;border:1px solid #000;background:#fff;color:#000;vertical-align:middle}
      .document-checkbox-tick{display:block;margin-top:-1px;font-family:'SimSun','宋体',serif;font-size:11px;font-weight:700;line-height:1;color:#000}
      .document-option-label{display:inline-block;font-family:'SimSun','宋体',serif;font-size:9pt;font-weight:400;line-height:1.2;color:#000}
      .other-label{display:inline}
      .other-fill-value{display:inline;font-family:'SimSun','宋体',serif;font-size:9pt;font-weight:400;color:#000}
      .fill-line{display:inline-block;width:140px;min-height:1em;vertical-align:bottom;border-bottom:1px solid #000}.fill-line.short-line{width:55px}.fill-line.long-line{width:80%}
    `;
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { alert('打印窗口被拦截'); return; }
    win.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><style>'+css+'</style></head><body>'+body+'</body></html>');
    win.document.close();
    const doPrint = () => {
      const s = win.document.querySelectorAll<HTMLElement>('.sheet');
      s.forEach(sh => { if(sh.scrollHeight>sh.clientHeight+1) console.warn('Overflow:',sh.scrollHeight-sh.clientHeight); });
      win.focus(); win.print();
    };
    const ready = () => { const d=win.document as any; if(d.fonts?.ready){ d.fonts.ready.then(()=>{requestAnimationFrame(()=>requestAnimationFrame(doPrint));}); } else { requestAnimationFrame(()=>requestAnimationFrame(doPrint)); } };
    win.addEventListener('afterprint', () => { try{win.close()}catch(e){} });
    if((win.document as any).readyState==='complete') ready(); else win.addEventListener('load', ready);
  }

  closeDialogs(): void { this.editListOpen=false; this.formOpen=false; this.errorText=''; this.nurseQuery=''; this.nurseDropdownOpen=false; this.selectedNurse=null; }
  private joinDistinctOtherValues(values:Array<string|undefined|null>):string{return[...new Set(values.map(v=>String(v||'').trim()).filter(Boolean))].join('；');}
  private emptySharedInfo(): HealthEducationSharedInfo { return {valuableCodes:[],valuableOther:'',receiverConfirmed:false,receiverName:'',receivedAt:''}; }
  private cloneSharedInfo(v:HealthEducationSharedInfo):HealthEducationSharedInfo { return {valuableCodes:[...v.valuableCodes],valuableOther:v.valuableOther,receiverConfirmed:v.receiverConfirmed,receiverName:v.receiverName,receivedAt:v.receivedAt}; }
  private hydrateSharedInfo():void{const s=[...this.records].reverse().find(r=>!!r.valuableCodes?.length||!!r.valuableOther?.trim()||r.receiverConfirmed===true||!!r.receiverName?.trim()||!!r.receivedAt)||this.records[this.records.length-1]||null;this.sharedCarrierRecord=s;this.sharedInfo={valuableCodes:[...(s?.valuableCodes||[])],valuableOther:s?.valuableOther||'',receiverConfirmed:s?.receiverConfirmed===true,receiverName:s?.receiverName||'',receivedAt:s?.receivedAt?this.toLocalInput(new Date(s.receivedAt)):''};this.sharedDraft=this.cloneSharedInfo(this.sharedInfo);}
  startSharedEdit():void{if(!this.sharedCarrierRecord){alert('请先新增一条健康教育评估记录');return;}this.sharedDraft=this.cloneSharedInfo(this.sharedInfo);this.sharedEditing=true;}
  cancelSharedEdit():void{this.sharedDraft=this.cloneSharedInfo(this.sharedInfo);this.sharedEditing=false;}
  toggleSharedValuable(code:string,checked:boolean):void{const s=new Set(this.sharedDraft.valuableCodes||[]);checked?s.add(code):s.delete(code);this.sharedDraft.valuableCodes=[...s];}
  saveSharedInfo():void{const c=this.sharedCarrierRecord;if(!c?.id||this.sharedSaving)return;const op=this.pid;this.sharedSaving=true;const b:HealthEducationRecord={...c,valuableCodes:[...(this.sharedDraft.valuableCodes||[])],valuableOther:this.sharedDraft.valuableOther?.trim()||'',receiverConfirmed:this.sharedDraft.receiverConfirmed===true,receiverName:this.sharedDraft.receiverName?.trim()||'',receivedAt:this.sharedDraft.receivedAt?new Date(this.sharedDraft.receivedAt).toISOString():undefined,updatedBy:String(this.account?.id||'')};this.http.post<HealthEducationRecord>(`${this.API}/save`,b).pipe(finalize(()=>{this.sharedSaving=false}),takeUntil(this.destroy$)).subscribe({next:()=>{if(op!==this.pid)return;this.sharedEditing=false;this.reload();},error:e=>alert(e?.error?.message||'贵重物品交接信息保存失败')});}
  private paginate(): void {
    const out: RenderPage[]=[]; const source=this.records.length?this.records:[null as any];
    for(let i=0;i<source.length;i+=5){
      const rows=(source.slice(i,i+5) as (HealthEducationRecord|null)[]);
      while(rows.length<5)rows.push(null);
      const first=rows.find(r=>!!r);
      out.push({index:out.length+1,records:rows,diagnosis:resolvePageDiagnosis(this.patient,first,['assessmentTime'],this.diagnosisDisplay)});
    }
    this.pages=out;
    this.normalizeSelectedPrintPages(this.pages.length);
  }
  private emptyForm(pid: string): HealthEducationRecord { return {pid,assessmentTime:'',itemCodes:[],educationTarget:'',evaluationCodes:[],nurseName:'',valuableCodes:[],receiverConfirmed:false,dischargeEducation:false,transferEducation:false}; }
  private loadAccounts(): void {
    this.http.get<any[]>('/api/v1/icu/accounts').pipe(takeUntil(this.destroy$)).subscribe({
      next: rows => {
        const source = Array.isArray(rows) ? rows : [];
        this.accounts = source
          .map(row => ({
            accountId: String(row?.accountId ?? row?._id ?? row?.id ?? '').trim(),
            accountName: String(row?.accountName ?? row?.trueName ?? row?.name ?? '').trim(),
            username: String(row?.username ?? row?.loginName ?? '').trim(),
            code: String(row?.code ?? row?.jobNumber ?? '').trim(),
          }))
          .filter(account => !!account.accountId && !!account.accountName);
        this.filteredAccounts = this.accounts.slice(0, 20);
      },
      error: () => {
        this.accounts = [];
        this.filteredAccounts = [];
      },
    });
  }
  private loadHospitalName(): void { this.http.get<any>('/api/v1/config/hospital').pipe(takeUntil(this.destroy$)).subscribe({next:x=>{if(x?.hospitalName)this.hospitalName=x.hospitalName;},error:()=>{}}); }
  fmtDateTime(v?: string): string { if(!v)return ''; const d=new Date(v); if(Number.isNaN(d.getTime()))return v; const p=(n:number)=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
  fmtMonthDay(v?: string): string { if(!v)return ''; const d=new Date(v); if(Number.isNaN(d.getTime()))return ''; const p=(n:number)=>String(n).padStart(2,'0'); return `${p(d.getMonth()+1)}-${p(d.getDate())}`; }
  fmtHourMinute(v?: string): string { if(!v)return ''; const d=new Date(v); if(Number.isNaN(d.getTime()))return ''; const p=(n:number)=>String(n).padStart(2,'0'); return `${p(d.getHours())}:${p(d.getMinutes())}`; }
  formatHandoverDate(v?: string): string { if(!v)return '____ 年 __ 月 __ 日'; const d=new Date(v); if(Number.isNaN(d.getTime()))return '____ 年 __ 月 __ 日'; const p=(n:number)=>String(n).padStart(2,'0'); return `${d.getFullYear()} 年 ${p(d.getMonth()+1)} 月 ${p(d.getDate())} 日`; }
  educationTargetText(r: HealthEducationRecord|null): string { if(!r)return ''; if(r.educationTarget==='A')return 'A'; if(r.educationTarget==='B')return 'B'; if(r.educationTarget==='AB')return 'A、B'; return ''; }
  private toLocalInput(d: Date): string { const p=(n:number)=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
  private ts(v?:string):number { const t=v?new Date(v).getTime():0; return Number.isNaN(t)?0:t; }
  private calcAge(v?:string):number|null { if(!v)return null; const b=new Date(v); if(Number.isNaN(b.getTime()))return null; const n=new Date(); let a=n.getFullYear()-b.getFullYear(); if(n.getMonth()<b.getMonth()||(n.getMonth()===b.getMonth()&&n.getDate()<b.getDate()))a--; return a>=0?a:null; }
  genderText(g?: string): string { if (g === 'Male' || g === 'M' || g === '男') return '男'; if (g === 'Female' || g === 'F' || g === '女') return '女'; return g || ''; }
  diagnosisDisplay = '';
  private formatDiagnosis(d?: string): string { return firstDiagnosisSegment(d, 'legacy'); }
}

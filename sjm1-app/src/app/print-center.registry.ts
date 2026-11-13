import { PrintFormDef, PrintGroupKey } from './print-center.models';

import { YdwzlTemperatureComponent } from './ydwzl-temperature.component';
import { ToleranceScoreComponent } from './tolerance-score.component';
import { CommitSuicideScoreComponent } from './commit-suicide-score.component';
import { IadScoreComponent } from './iad-score.component';
import { BaetheiScoreComponent } from './baethei-score.component';
import { BradenFormComponent } from './braden-form.component';
import { PatientFallDangerComponent } from './patient-fall-danger.component';
import { UnplannedExtubationComponent } from './unplanned-extubation.component';
import { HealthEducationComponent } from './health-education.component';
import { WpgmFormComponent } from './wpgm-form.component';
import { EcmoRecordComponent } from './ecmo-record.component';
import { TransfusionRecordComponent } from './transfusion-record.component';
import { PiccoRecordComponent } from './picco-record.component';
import { HlmbFormComponent } from './hlmb-form.component';
import { IabpRecordComponent } from './iabp-record.component';
import { CrrtRecordComponent } from './crrt-record.component';
import { CrrtOrderFormComponent } from './crrt-order-form.component';

export const PRINT_GROUP_NAMES: Record<PrintGroupKey, string> = {
  tube: '管道维护',
  risk: '风险与评分',
  therapy: '专科治疗',
  nursing: '护理记录',
};

/**
 * 可打印表单清单（唯一事实来源）。
 * orientation 已逐个核对各组件源码中的 @page 声明，新增/修改表单时同步维护本文件与 FORM_CATALOG.md。
 */
export const PRINT_FORMS: PrintFormDef[] = [
  /* ── 风险与评分 ── */
  {
    key: 'patientFallDangerForm', title: '跌倒/坠床风险评估及预防措施记录单',
    route: 'patientFallDangerForm', group: 'risk',
    orientation: 'landscape', component: PatientFallDangerComponent,
    probe: { kind: 'score', scoreType: 'patientFallDangerLJRMYY' },
  },
  {
    key: 'bradenForm', title: '住院患者压力性损伤评估及措施记录单（Braden）',
    route: 'bradenForm', group: 'risk',
    orientation: 'landscape', component: BradenFormComponent,
    probe: { kind: 'score', scoreType: 'bradenScore' },
  },
  {
    key: 'unPlannedCGZYYForm', title: '非计划拔管风险评估及护理措施记录单',
    route: 'unPlannedCGZYYForm', group: 'risk',
    orientation: 'landscape', component: UnplannedExtubationComponent,
    probe: { kind: 'score', scoreType: 'unPlannedCGZYYScore' },
  },
  {
    key: 'baetheiForm', title: '住院患者日常生活能力评估单（Barthel）',
    route: 'baetheiForm', group: 'risk',
    orientation: 'landscape', component: BaetheiScoreComponent,
    probe: { kind: 'score', scoreType: 'selfCareAbility' },
  },
  {
    key: 'IADForm', title: '失禁相关性皮炎（IAD）评估记录单', route: 'IADForm', group: 'risk',
    orientation: 'landscape', component: IadScoreComponent,
    probe: { kind: 'score', scoreType: 'incontinenceScore' },
  },
  {
    key: 'toleranceForm', title: '肠内营养耐受性评分表', route: 'toleranceForm', group: 'risk',
    orientation: 'landscape', component: ToleranceScoreComponent,
    probe: { kind: 'score', scoreType: 'toleranceScoreV2' },
  },
  {
    key: 'commitSuicideForm', title: '自杀风险评估表（NGASR）', route: 'commitSuicideForm', group: 'risk',
    orientation: 'landscape', component: CommitSuicideScoreComponent,
    probe: { kind: 'score', scoreType: 'commitSuicideScore' },
  },

  /* ── 专科治疗 ── */
  {
    key: 'ecmoForm', title: 'ECMO 运行护理记录单', route: 'ecmoForm', group: 'therapy',
    orientation: 'portrait', component: EcmoRecordComponent,
    probe: { kind: 'bedside', codes: ['param_ECMOMoShi', 'param_ECMO_xueLiuLiang'] },
  },
  {
    key: 'crrtForm', title: 'CRRT 护理记录单', route: 'crrtForm', group: 'therapy',
    orientation: 'portrait', component: CrrtRecordComponent,
    probe: { kind: 'bedside', codes: ['param_CBP_Mode', 'param_血流速度'] },
  },
  {
    key: 'crrtOrderForm', title: 'CRRT 治疗医嘱单', route: 'crrtOrderForm', group: 'therapy',
    orientation: 'portrait', component: CrrtOrderFormComponent,
    probe: { kind: 'url', url: '/api/v1/icu/crrt-orders' },
  },
  {
    key: 'piccoForm', title: 'PiCCO 监测记录单', route: 'piccoForm', group: 'therapy',
    orientation: 'portrait', component: PiccoRecordComponent,
    probe: { kind: 'url', url: '/api/v1/icu/picco-params/listByPid' },
  },
  {
    key: 'hlmbForm', title: '重症患者护理目标管理', route: 'hlmbForm', group: 'nursing',
    orientation: 'portrait', component: HlmbFormComponent,
    probe: { kind: 'url', url: '/api/v1/icu/nursing-goal-records/listByPid' },
  },
  {
    key: 'iabpForm', title: 'IABP 护理记录单', route: 'iabpForm', group: 'therapy',
    orientation: 'portrait', component: IabpRecordComponent,
    probe: { kind: 'bedside', codes: ['param_反博压', 'param_iabp心率'] },
  },
  {
    key: 'ydwzlForm', title: '亚低温治疗体温记录单', route: 'ydwzlForm', group: 'therapy',
    orientation: 'landscape', component: YdwzlTemperatureComponent,
    probe: { kind: 'bedside', codes: ['param_亚低温体温设置', 'param_亚低温水温设置'] },
  },

  /* ── 护理记录 ── */
  {
    key: 'transfusionForm', title: '输血记录单', route: 'transfusionForm', group: 'nursing',
    orientation: 'portrait', component: TransfusionRecordComponent,
    probe: {
      kind: 'url', url: '/api/v1/icu/transfusion-record/byPid',
      pick: (body: any) => (Array.isArray(body?.pages) ? body.pages.length : 0),
    },
  },
  {
    key: 'jkjyForm', title: '健康教育记录单', route: 'jkjyForm', group: 'nursing',
    orientation: 'portrait', component: HealthEducationComponent,
    probe: { kind: 'url', url: '/api/v1/icu/health-education/listByPid' },
  },
  {
    key: 'wpgmForm', title: '住院患者物品管理表', route: 'wpgmForm', group: 'nursing',
    orientation: 'portrait', component: WpgmFormComponent,
    probe: { kind: 'local', storageKeyPrefix: 'wpgmForm.selectedIds:' },
  },
];

/** 仅调阅、不参与打印的页面，用于 UI 底部说明 */
export const VIEW_ONLY_FORMS = [
  { title: '出科血糖', route: 'bloodSugar', reason: '第三方系统调阅页面' },
  { title: '体温单', route: 'temperatureRecord', reason: '第三方系统调阅页面' },
];

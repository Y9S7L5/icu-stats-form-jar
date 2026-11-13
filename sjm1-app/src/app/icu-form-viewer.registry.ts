import { IcuFormViewerFormDef } from './icu-form-viewer.models';

/**
 * 统一调阅页面表单注册清单。
 * 仅包含允许在统一调阅页面展示的业务表单。
 *
 * 排除项：
 * - transfusionForm：输血记录单（第三方输血系统 iframe 调阅）
 * - temperatureRecord：体温单（第三方）
 * - bloodSugar：血糖单（第三方）
 * - printCenter：打印工具，不是患者业务表单
 * - hljldFormPDF：旧护理记录单技术路由，与新护理记录单重复
 */
export const ICU_VIEWER_FORMS: IcuFormViewerFormDef[] = [
  /* ── 默认护理记录单（最前） ── */
  { key: 'hljldFormPDFNew', title: '重症医学科护理记录单', route: 'hljldFormPDFNew' },

  /* ── 重症医学科重症监护护理记录（外部 iframe） ── */
  {
    key: 'zzjkhljl',
    title: '重症医学科重症监护护理记录',
    route: 'zzjkhljl',
    iframeUrl: 'http://10.35.4.10:10248/pdf/doConsult?formCode=custom_nurse_form_%E9%87%8D%E7%97%87%E7%9B%91%E6%8A%A4%E6%8A%A4%E7%90%86%E8%AE%B0%E5%BD%95%E5%8D%951.0.0&mrn={mrn}&pdfTime={pdfTime}&deptCode=125011&inHospitalNum=',
  },
  /* ── 入院护理评估单（外部 iframe） ── */
  {
    key: 'ruyuanhulipinggudan',
    title: '入院护理评估单',
    route: 'ruyuanhulipinggudan',
    iframeUrl: 'http://10.35.4.10:10248/pdf/doConsult?formCode=ruyuanhulipinggudan&mrn={mrn}&pdfTime={pdfTime}&deptCode=125011&inHospitalNum=',
  },
  /* ── 转入护理评估单（外部 iframe） ── */
  {
    key: 'zhuanruhulipinggudan',
    title: '转入护理评估单',
    route: 'zhuanruhulipinggudan',
    iframeUrl: 'http://10.35.4.10:10248/pdf/doConsult?formCode=zhuanruhulipinggudan&mrn={mrn}&pdfTime={pdfTime}&deptCode=125011&inHospitalNum=',
  },
  /* ── 风险与评分 ── */
   { key: 'bradenForm', title: '患者压力性损伤评估及措施记录单', route: 'bradenForm' },
  { key: 'patientFallDangerForm', title: '跌倒/坠床风险评估及预防措施护理记录单', route: 'patientFallDangerForm' },
  { key: 'baetheiForm', title: '患者日常生活能力评估单', route: 'baetheiForm' },
  { key: 'unPlannedCGZYYForm', title: '非计划拔管风险评估及护理措施记录单', route: 'unPlannedCGZYYForm' },
  { key: 'IADForm', title: '成人失禁相关性皮炎分类及会阴部皮肤评估护理记录单', route: 'IADForm' },
  { key: 'commitSuicideForm', title: '自杀风险评估表（NGASR）', route: 'commitSuicideForm' },
  { key: 'toleranceForm', title: '肠内营养耐受性评分表', route: 'toleranceForm' },

  /* ── 专科治疗 ── */
  { key: 'crrtOrderForm', title: '连续性血液净化治疗医嘱单', route: 'crrtOrderForm' },
  { key: 'crrtForm', title: '连续性血液净化治疗护理记录单', route: 'crrtForm' },
  { key: 'ydwzlForm', title: '患者亚低温治疗体温记录单', route: 'ydwzlForm' },
  { key: 'piccoForm', title: 'PICCO容量监测参数记录表', route: 'piccoForm' },
  { key: 'iabpForm', title: 'IABP运行护理记录单', route: 'iabpForm' },
  { key: 'ecmoForm', title: 'ECMO运行护理记录单', route: 'ecmoForm' },

/* ── 交班报告（已屏蔽） ── */
  // { key: 'handoverReport', title: 'ICU 交班报告', route: 'handoverReport' },
  /* ── 护理记录 ── */
  { key: 'jkjyForm', title: '健康教育记录单', route: 'jkjyForm' },
  { key: 'wpgmForm', title: '住院患者物品管理表', route: 'wpgmForm' },
  { key: 'hlmbForm', title: '重症患者护理目标管理', route: 'hlmbForm' },
];

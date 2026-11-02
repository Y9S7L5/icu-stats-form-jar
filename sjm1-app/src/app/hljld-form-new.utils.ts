import {
  ActiveStayRange,
  BedsideRecord,
  ConfigTubeView,
  DrugActionItem,
  DrugExecution,
  DrugMethodConfig,
  HljldDisplayRow,
  HljldSourceData,
  HljldSummary,
  HljldSummaryItem,
  HljldSummaryKind,
  HljldTimeGroup,
  HljldTimeRow,
  HljldTimelineItem,
  NameAmount,
  NameAmountRoute,
  NurseRecord,
  PatientContext,
  SummaryTextToken,
  TubeExecution,
  TubeFieldConfig,
  TubeRecord,
} from './hljld-form-new.models';

export interface TubeNursingEntry {
  key: string;
  timestamp: number;
  time: string;
  text: string;
}

import { databaseTimeValue, formatShanghaiDateMinute } from './form-date.util';

/* ---- 统计分类定义 ---- */

const CODE_BROUGHT = 'param_带入药量';
const CODE_ORAL = 'param_kouFu';
const CODE_TUBE_FEEDING = 'param_biSi';

/** 尿量与净超滤量已独立成列，不再计入排出物 */
export const URINE_CODE = 'param_niaoLiang';
export const ULTRAFILTRATION_CODE = 'param_chaoLvLiang';

/** 排出物：不含尿量、净超滤量 */
const EXCRETION_SUMMARY_DEFINITIONS = [
  { key: 'stool', code: 'param_daBianAmount', label: '大便量' },
  { key: 'stoma', code: 'param_造瘘口量', label: '造瘘口量' },
  { key: 'vomit', code: 'param_outuwuliang', label: '呕吐物量' },
  { key: 'hemoptysis', code: 'param_咯血', label: '咯血' },
  { key: 'sputum', code: 'param_tanLiang', label: '痰液量' },
] as const;

/** 明细表「排出物」列的名称映射，同样不含尿量与净超滤量 */
const OUTPUT_CODE_NAMES: Record<string, string> = {
  param_daBianAmount: '大便量',
  'param_造瘘口量': '造瘘口量',
  param_outuwuliang: '呕吐物量',
  'param_咯血': '咯血',
  param_tanLiang: '痰液量',
};

const DISPLAY_BEDSIDE_CODES = new Set<string>([
  CODE_BROUGHT, CODE_ORAL, CODE_TUBE_FEEDING,
  ULTRAFILTRATION_CODE, URINE_CODE, 'param_daBianAmount',
  'param_造瘘口量', 'param_outuwuliang', 'param_咯血', 'param_tanLiang',
  'param_外出检查', 'param_物理治疗', 'param_基础护理1', 'param_健康教育',
]);

/**
 * 历史引流编码白名单。
 * 数据库中仍存在这些code，但配置名称已修改。
 */
const LEGACY_DRAIN_CODES = new Set<string>([
  'param_tube_胃肠减压',
]);

/**
 * 判断bedside项目是否属于引流量。
 *
 * 兼容：
 * 1. 历史编码param_tube_胃肠减压；
 * 2. code中包含"引流"的项目。
 */
export function isDrainCode(code?: string): boolean {
  const normalizedCode = String(code ?? '').trim();
  if (!normalizedCode) { return false; }
  return LEGACY_DRAIN_CODES.has(normalizedCode) || normalizedCode.includes('引流');
}

export const DEFAULT_REMARK_LINES = [
  '检查：A：CTB：核磁共振C：胃镜D：肠镜E：超声检查F：床旁胸片G：心电图',
  '治疗：A：机械辅助排痰B：气压治疗C：支气管镜灌洗D：TDP照射E：针灸治疗F：运动治疗G：肺复张',
  '基础护理：A：口腔护理B：动/静脉置管护理C：擦浴D：肛周护理E：压疮护理F：床上洗头',
  '健康教育：A：入院指导B：入科指导C：疾病知识D：药物指导E：饮食指导F：肢体活动指导G：检查指导H：安全指导I：心理指导J：术前指导K：术后指导L：转科/出院指导M：用氧注意事项N：通气配合指导O：康复指导P：VTE预防指导',
];

/* ---- 护理日时间范围 ---- */

/** 护理日左端点：当日 07:00，本身计入（区间左闭） */
export function startOfNursingDay(selectedDate: Date): Date {
  const d = new Date(selectedDate);
  d.setHours(7, 0, 0, 0);
  return d;
}

/** 护理日右端点：次日 07:00，本身不计入（区间右开） */
export function endOfNursingDay(selectedDate: Date): Date {
  const d = startOfNursingDay(selectedDate);
  d.setDate(d.getDate() + 1);
  return d;
}

export function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* ---- 患者时间解析 ---- */

/**
 * 统一解析患者时间字段，使用 databaseTimeValue 处理数据库时区。
 * 返回绝对毫秒时间戳，解析失败返回 NaN。
 */
export function parsePatientDateTime(value?: string): number {
  if (!value) { return NaN; }
  const ts = databaseTimeValue(value);
  return Number.isFinite(ts) ? ts : NaN;
}

/* ---- 有效住院区间 ---- */

export function resolveActiveStayRange(
  patient: PatientContext,
  nursingDayStart: Date,
  nursingDayEnd: Date,
  skipDischargeClip = false,
): ActiveStayRange {
  const admissionTs = parsePatientDateTime(patient.admissionTime);
  const dischargeTs = parsePatientDateTime(patient.dischargeTime);

  const admissionTime = Number.isFinite(admissionTs) ? new Date(admissionTs) : null;
  const dischargeTime = Number.isFinite(dischargeTs) ? new Date(dischargeTs) : null;

  const dayStartMinute = minuteInstant(nursingDayStart);
  const dayEndMinute = minuteInstant(nursingDayEnd);

  // effectiveStart = max(nursingDayStart, admissionTime)
  let effectiveStart = new Date(nursingDayStart);
  let admissionClipped = false;
  if (admissionTime && minuteInstant(admissionTime) > dayStartMinute) {
    effectiveStart = admissionTime;
    admissionClipped = true;
  }

  // effectiveEnd = min(nursingDayEnd, dischargeTime)
  // 打印时跳过出科裁剪，使用完整护理日范围，避免出科时间不准确导致数据丢失
  let effectiveEnd = new Date(nursingDayEnd);
  let dischargeClipped = false;
  if (!skipDischargeClip && dischargeTime && minuteInstant(dischargeTime) < dayEndMinute) {
    effectiveEnd = dischargeTime;
    dischargeClipped = true;
  }

  // 右开：入科时间正好等于次日 07:00 时不属于本护理日
  const beforeAdmission = !!admissionTime && minuteInstant(admissionTime) > dayEndMinute;
  // 左闭：出科时间正好等于当日 07:00 时仍属于本护理日
  const afterDischarge = !!dischargeTime && minuteInstant(dischargeTime) < dayStartMinute;

  const startExclusive = !admissionClipped;
  const startMinute = minuteInstant(effectiveStart);
  const endMinute = minuteInstant(effectiveEnd);
  const hasValidRange = !beforeAdmission && !afterDischarge
    && (startExclusive ? endMinute > startMinute : endMinute >= startMinute);

  return {
    nursingDayStart,
    nursingDayEnd,
    effectiveStart,
    effectiveEnd,
    admissionClipped,
    dischargeClipped,
    beforeAdmission,
    afterDischarge,
    hasValidRange,
    startExclusive,
  };
}

/* ---- 东八区时间工具 ---- */

/**
 * 分钟键：使用绝对毫秒时间戳除以60000取整，
 * 保证跨时区和跨数据源的分钟匹配一致。
 */
export function minuteKey(value: string | Date): number {
  const timestamp = value instanceof Date ? value.getTime() : databaseTimeValue(value);
  if (!Number.isFinite(timestamp)) { return NaN; }
  return Math.floor(timestamp / 60000);
}

/** 将绝对毫秒时间戳格式化为上海时间 yyyy-MM-dd HH:mm */
export function formatTime(ms: number): string {
  return formatShanghaiDateMinute(ms);
}

export function parseAmount(value: unknown): number {
  if (typeof value === 'number') { return Number.isFinite(value) ? value : 0; }
  if (typeof value !== 'string') { return 0; }
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

export function displayAmount(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function hasText(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

/* ---- 时长文本 ---- */

/**
 * 计算两个时间之间的时长，始终显示"xx小时xx分钟"格式。
 * 使用 Math.floor 向下取整，避免带秒时间向上取整。
 */
export function durationText(start: Date, end: Date): string {
  const totalMinutes = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}小时${minutes}分钟`;
}

/* ---- 动态小结标题 ---- */

/**
 * 根据入科/出科截断情况和时间段类型，生成小结标题。
 */
export function buildSummaryLabel(options: {
  defaultLabel: string;
  kind: HljldSummaryKind;
  actualStart: Date;
  actualEnd: Date;
  admissionClipped: boolean;
  dischargeClipped: boolean;
}): string {
  const { kind, actualStart, actualEnd, admissionClipped, dischargeClipped } = options;

  // 出科总结：始终显示实际时长
  if (kind === 'discharge') {
    return `${durationText(actualStart, actualEnd)}总结`;
  }

  // 入科截断：显示实际时长
  if (admissionClipped) {
    if (kind === '24h') {
      return `${durationText(actualStart, actualEnd)}总结`;
    }
    return `${durationText(actualStart, actualEnd)}小结`;
  }

  // 出科截断且非入科截断：显示实际时长总结
  if (dischargeClipped) {
    return `${durationText(actualStart, actualEnd)}总结`;
  }

  // 正常情况使用默认标签
  return options.defaultLabel;
}

/* ---- 药物方法匹配 ---- */

function normalizeCodes(code: string | undefined | null): string[] {
  return String(code || '')
    .split('、')
    .map(item => item.trim())
    .filter(Boolean);
}

export function findDrugMethod(methodCode: string | undefined, configs: DrugMethodConfig[]): DrugMethodConfig | undefined {
  // methodCode 可能是 '、' 复合编码（如 "1、154"），各段指向同一途径，任一段命中即返回
  const targetCodes = normalizeCodes(methodCode);
  if (!targetCodes.length) { return undefined; }
  return configs.find(config =>
    config.valid !== false && normalizeCodes(config.code).some(code => targetCodes.includes(code)));
}

export function routeLabel(name: string | undefined): string {
  const value = String(name || '');
  if (/输液泵|静滴/.test(value)) { return 'ivgtt'; }
  if (/微量泵/.test(value)) { return 'iv泵'; }
  if (/肌肉注射/.test(value)) { return 'im'; }
  if (/皮下注射/.test(value)) { return 'IH'; }
  if (/静注/.test(value)) { return 'iv'; }
  if (/口服/.test(value)) { return 'po'; }
  if (/胃管置管术/.test(value)) { return '鼻饲'; }
  if (/肠内营养/.test(value)) { return '鼻饲注入'; }
  return value;
}

export function enteralDisplayName(rawName: string): string {
  const name = rawName || '';
  if (name.includes('SP')) { return '短肽'; }
  if (name.includes('TPF-F') || name.includes('瑞能')) { return '瑞能'; }
  if (name.includes('TP-HE') || name.includes('瑞高')) { return '瑞高'; }
  if (name.includes('TP') || name.includes('瑞素')) { return '瑞素'; }
  return name;
}

/* ---- Bedside/Drug 渲染判断 ---- */

function isRenderableBedsideRecord(record: BedsideRecord): boolean {
  if (!record || !record.time || !record.code) { return false; }
  if (!isValidBusinessRecord(record)) { return false; }
  if (record.code === 'param_Yishi') { return false; }
  if (!DISPLAY_BEDSIDE_CODES.has(record.code) && !isDrainCode(record.code)) { return false; }
  return hasText(record.strVal) || hasText(record.remark);
}

/** 药物/胃肠单元格：名称或量任一有值才展示，只有途径视为空数据 */
function hasNameOrAmount(item?: NameAmountRoute | NameAmount | null): boolean {
  return !!item && (hasText(item.name) || hasText(item.amount));
}

/** 排出物/引流液单元格：必须有量，只有名称无量视为空数据 */
function hasAmountValue(item?: NameAmount | null): boolean {
  return !!item && hasText(item.amount);
}

/**
 * 根据 param_Yishi 记录解析签名用户ID。
 * 只使用 bedside.code === 'param_Yishi' 的 editUser。
 * 选择 time <= targetTime 的最近一条。
 */
export function resolveYishiSignerId(
  targetTime: string | Date | number,
  bedsideRecords: BedsideRecord[],
): string {
  const targetInstant = typeof targetTime === 'number'
    ? targetTime
    : targetTime instanceof Date
      ? targetTime.getTime()
      : databaseTimeValue(targetTime);

  if (!Number.isFinite(targetInstant)) { return ''; }

  const yishiRecords = bedsideRecords
    .filter(item => item.valid !== false && item.code === 'param_Yishi' && !!item.time && !!item.editUser)
    .map(item => ({
      instant: databaseTimeValue(item.time),
      editUser: String(item.editUser ?? '').trim(),
    }))
    .filter(item => Number.isFinite(item.instant) && !!item.editUser)
    .sort((a, b) => a.instant - b.instant);

  for (let i = yishiRecords.length - 1; i >= 0; i--) {
    if (yishiRecords[i].instant <= targetInstant) {
      return yishiRecords[i].editUser;
    }
  }
  return '';
}

/**
 * 护理记录签名：优先取记录自带的 username，其次 trueName，
 * 最后用 userId / editUser 查账户映射。
 */
export function resolveNurseSignature(
  record: NurseRecord,
  accountMap: Map<string, string>,
): string {
  const direct = String(record.username ?? '').trim() || String(record.trueName ?? '').trim();
  if (direct) { return direct; }
  const id = String(record.userId ?? record.editUser ?? '').trim();
  return id ? (accountMap.get(id) || '') : '';
}

function isRenderableDrugExecution(item: DrugExecution): boolean {
  if (!item || item.status === 'invalid' || !item.startTime) { return false; }
  return (item.drugList ?? []).some(drug =>
    hasText(drug.name) || parseAmount(drug.liquidAmount) !== 0 || hasText(drug.dose) || hasText(drug.unit));
}

/**
 * 执行记录是否含带量的 quickAdd 动作（分次给药行为判定，替代药名白名单）。
 * 与后端 HljldUtils.hasQuickAddActions 对齐：胃肠组下有此类动作的执行
 * （如"存药分次鼻饲"的5%葡萄糖）按每次快推时间分行展示。
 */
function hasQuickAddActions(execution: DrugExecution): boolean {
  return (execution.drugActionList ?? []).some(a =>
    String(a.action ?? '').trim().toLowerCase() === 'quickadd' && parseAmount(a.quickAddAmount) > 0);
}

/* ---- 数据转换 ---- */

function drugToCell(
  execution: DrugExecution, config: DrugMethodConfig, enteral: boolean,
  displayTimeMs?: number, segStartMs?: number, endMs?: number,
): NameAmountRoute {
  const drugList = execution.drugList ?? [];
  const rawName = drugList.map(item => {
    const name = String(item.name ?? '').trim();
    if (!name) { return ''; }
    const unit = String(item.unit ?? '').trim();
    if (unit) {
      const rawDose = item.dose;
      const dose = rawDose != null && rawDose !== ''
        ? (typeof rawDose === 'number' ? parseFloat(rawDose.toFixed(1)) : String(rawDose).trim())
        : '';
      return `${name}(${dose}${unit})`;
    }
    return name;
  }).filter(Boolean).join('、');
  // 持续药物：展示从 from 到 to 的实际用量（班段口径）
  //   from = max(execStart, segStartMs) 或 execStart（开始行）
  //   to   = endMs（开始行用段末）或 displayTimeMs（非开始行用当前时刻）
  // 单次药物：展示 liquidAmount 全量
  let numericAmount: number;
  if (config.isOnce === false && Number.isFinite(displayTimeMs) && displayTimeMs! > 0) {
    const execStartMs = toMs(String(execution.startTime ?? ''));
    const from = Number.isFinite(segStartMs) ? Math.max(execStartMs, segStartMs!) : execStartMs;
    const to = Number.isFinite(endMs) ? endMs! : displayTimeMs!;
    if (Number.isFinite(from) && to > from) {
      const usage = calcContinuousDrugAmount(execution, from, to, true);
      numericAmount = usage.inRange;
    } else {
      numericAmount = 0;
    }
  } else {
    numericAmount = resolveLiquidCap(execution);
  }
  return {
    name: enteral ? enteralDisplayName(rawName) : rawName,
    amount: numericAmount !== 0 ? numericAmount.toFixed(1) : '',
    numericAmount,
    route: routeLabel(config.name),
  };
}

function bedsideInputCell(record: BedsideRecord): NameAmountRoute {
  let route = '';
  if (record.code === 'param_带入药量') { route = '带入'; }
  else if (record.code === 'param_kouFu') { route = 'po'; }
  else if (record.code === 'param_biSi') { route = '鼻饲'; }
  return {
    name: String(record.remark ?? '').trim(),
    amount: displayAmount(record.strVal),
    numericAmount: parseAmount(record.strVal),
    route,
  };
}

function drainName(code: string): string {
  const normalizedCode = String(code ?? '').trim();

  // 兼容历史code，业务显示名称已调整为"胃管负压引流量"
  if (normalizedCode === 'param_tube_胃肠减压') {
    return '胃管负压引流量';
  }

  const stripped = normalizedCode.replace(/^param_tube_/, '').replace(/^param_/, '');
  return stripped.endsWith('管') ? `${stripped.slice(0, -1)}液` : stripped.replace(/管/g, '液');
}

/**
 * 将任意时间归一到所属分钟的起始毫秒，与 minuteKey 同粒度。
 * 统计与展示都按分钟对齐，避免 07:00:30 这类秒级数据在两个护理日重复出现。
 */
export function minuteInstant(value: string | Date | number): number {
  const ts = typeof value === 'number'
    ? value
    : value instanceof Date
      ? value.getTime()
      : databaseTimeValue(value);
  return Number.isFinite(ts) ? Math.floor(ts / 60000) * 60000 : NaN;
}

/**
 * 护理日统计区间判断，默认左闭右开 [start, end)。
 *
 * 07:00 起属于当前护理日，次日 07:00 不属于当前护理日，
 * 即 [07:00, 次日07:00)。
 *
 * startExclusive = true 用于特殊场景：区间为 (start, end)。
 */
export function inNursingRange(
  value: string | Date | number,
  start: Date | number,
  end: Date | number,
  startExclusive = false,
): boolean {
  const ts = minuteInstant(value);
  if (!Number.isFinite(ts)) { return false; }
  const startMs = minuteInstant(start);
  const endMs = minuteInstant(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) { return false; }
  return (startExclusive ? ts > startMs : ts >= startMs) && ts < endMs;
}

function sumBedsideByCodes(records: BedsideRecord[], codes: readonly string[]): number {
  return records.filter(item => codes.includes(item.code)).reduce((sum, item) => sum + parseAmount(item.strVal), 0);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 金额格式化，页面与打印统一口径 */
export function formatSummaryAmount(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  }).format(value);
}

/* ==== 持续用药实际用量 ==== */

const MS_PER_HOUR = 3_600_000;

/** 变更速度的动作，speed 为变更后的绝对值 */
const SPEED_ACTIONS = new Set(['start', 'recovery', 'add', 'minus']);

/** 动作别名规范化映射（trim + 小写 + 中英别名） */
const ACTION_ALIAS: Record<string, 'speed' | 'pause' | 'stop' | 'quickAdd'> = {
  start: 'speed', begin: 'speed', recovery: 'speed', resume: 'speed',
  add: 'speed', minus: 'speed', adjust: 'speed', change: 'speed',
  '开始': 'speed', '升始': 'speed', '恢复': 'speed', '调速': 'speed',
  '加速': 'speed', '减速': 'speed', '降速': 'speed', '调快': 'speed', '调慢': 'speed',
  pause: 'pause', '暂停': 'pause',
  stop: 'stop', end: 'stop', complete: 'stop', finish: 'stop',
  '停止': 'stop', '完成': 'stop', '结束': 'stop',
  quickadd: 'quickAdd', bolus: 'quickAdd', '快推': 'quickAdd',
};

function normalizeAction(raw: DrugActionItem, unknown?: Set<string>): 'speed' | 'pause' | 'stop' | 'quickAdd' | null {
  const key = String(raw.action ?? '').trim().toLowerCase();
  const hit = ACTION_ALIAS[key];
  if (hit) { return hit; }
  // 未登记但带了速度值，按调速处理，比静默丢弃安全
  if (raw.speed != null && String(raw.speed).trim() !== '') { return 'speed'; }
  if (key) { unknown?.add(key); }
  return null;
}

/** 参与出入量统计的入量通道，其余（含空值）一律不计 */
const COUNTED_IN_CHANNELS = new Set(['胃肠', '静脉', '输血']);

/**
 * 肠内营养泵入判定。归入「鼻饲量」而非「胃肠入量」。
 * 若改为归入胃肠入量，删除 methodChannel 中的 enteral 分支即可。
 */
const ENTERAL_NUTRITION_PATTERN = /肠内营养/;

type DrugSegment = { start: number; end: number; speed: number };
type DrugBolus = { time: number; amount: number };

function toMs(value: Date | number | string): number {
  if (typeof value === 'number') { return value; }
  if (value instanceof Date) { return value.getTime(); }
  return databaseTimeValue(value);
}

/** 速度归一为 ml/h；单位缺失按 ml/h 处理 */
function normalizeSpeed(action: DrugActionItem): number {
  const speed = parseAmount(action.speed);
  if (!Number.isFinite(speed) || speed <= 0) { return 0; }
  const unit = String(action.speedUnit ?? '').trim().toLowerCase();
  if (unit === 'ml/min') { return speed * 60; }
  if (unit && unit !== 'ml/h' && unit !== 'ml/hour' && unit !== 'ml/hours') {
    console.warn('[hljld] 未识别的速度单位，按 ml/h 处理：', unit, action);
  }
  return speed;
}

/** 顶层 liquidAmount 优先，缺失时回退 drugList 求和 */
function resolveLiquidCap(execution: DrugExecution): number {
  const top = parseAmount(execution.liquidAmount);
  if (top > 0) { return top; }
  return (execution.drugList ?? []).reduce((sum, d) => sum + parseAmount(d.liquidAmount), 0);
}

export interface DrugActualAmount {
  /** 落在统计区间内的实际入量，全精度不舍入 */
  inRange: number;
  /** 全程累计实际入量（已封顶），用于自检 */
  total: number;
  /** 无动作数据，已回退为开始时点全额计入 */
  fallback: boolean;
}

/**
 * 按 drugActionList 计算持续用药在 (rangeStart, rangeEnd] 内的实际入量。
 *
 * 规则：
 * 1. speed 为变更后的绝对速度，单位 ml/h；start/recovery/add/minus 均置为该值。
 * 2. pause 期间速度记 0，recovery 恢复为该条 speed。
 * 3. quickAdd 为该时刻的瞬时快推，不改变速度，占用 liquidAmount 额度。
 * 4. 结束时刻取顶层 endTime；未结束时算到 min(当前时刻, rangeEnd)。
 * 5. 提前 stop 时按积分自然截断，未输完的液体不计。
 * 6. 累计量封顶到 liquidAmount，触顶即视为在跑满那一刻结束。
 * 7. 全程保留毫秒精度，不做分钟归一；舍入只在展示层做一次。
 */
export function calcContinuousDrugAmount(
  execution: DrugExecution,
  rangeStart: Date | number,
  rangeEnd: Date | number,
  startExclusive = true,
): DrugActualAmount {
  const rangeStartMs = toMs(rangeStart);
  const rangeEndMs = toMs(rangeEnd);
  const startMs = toMs(String(execution.startTime ?? ''));
  if (!Number.isFinite(startMs)) { return { inRange: 0, total: 0, fallback: false }; }

  const cap = resolveLiquidCap(execution);
  const hasCap = cap > 0;

  const endRaw = execution.endTime ? toMs(String(execution.endTime)) : NaN;
  // 未结束的记录随时间推进，展示时按截断时刻计算
  const cutoff = Number.isFinite(endRaw) ? endRaw : Math.min(Date.now(), rangeEndMs);
  if (cutoff <= startMs) { return { inRange: 0, total: 0, fallback: false }; }

  const actions = (execution.drugActionList ?? [])
    .map(item => ({ raw: item, ts: toMs(String(item.time ?? '')) }))
    .filter(item => Number.isFinite(item.ts))
    .sort((a, b) => a.ts - b.ts);

  // 无动作数据：回退为开始时点全额计入，与旧逻辑一致
  if (!actions.length) {
    const hit = inNursingRange(execution.startTime, rangeStart as Date, rangeEnd as Date, startExclusive);
    return { inRange: hit ? cap : 0, total: cap, fallback: true };
  }

  const segments: DrugSegment[] = [];
  const boluses: DrugBolus[] = [];
  let cursor = startMs;
  let speed = 0;
  let stopped = false;
  const unknownActions = new Set<string>();

  for (const { raw, ts } of actions) {
    const at = Math.min(Math.max(ts, cursor), cutoff);
    if (at > cursor && speed > 0) {
      segments.push({ start: cursor, end: at, speed });
    }
    cursor = at;

    const normalized = normalizeAction(raw, unknownActions);
    if (normalized === 'quickAdd') {
      const amount = parseAmount(raw.quickAddAmount);
      if (amount > 0) { boluses.push({ time: at, amount }); }
      continue;
    }
    if (normalized === 'pause') { speed = 0; continue; }
    if (normalized === 'stop') { speed = 0; stopped = true; break; }
    if (normalized === 'speed') { speed = normalizeSpeed(raw); continue; }
    // null: 未识别且无速度值，忽略
  }

  if (unknownActions.size) {
    console.warn('[hljld] 未识别的泵注动作，速度按 0 处理：', [...unknownActions]);
  }

  if (!stopped && cursor < cutoff && speed > 0) {
    segments.push({ start: cursor, end: cutoff, speed });
  }

  // 按时间顺序积分，边算边封顶；同一时刻快推优先占额
  type Ev = { at: number; order: number; seg?: DrugSegment; bolus?: DrugBolus };
  const events: Ev[] = [
    ...boluses.map(bolus => ({ at: bolus.time, order: 0, bolus })),
    ...segments.map(seg => ({ at: seg.start, order: 1, seg })),
  ].sort((a, b) => (a.at - b.at) || (a.order - b.order));

  let used = 0;
  let inRange = 0;
  const remaining = () => (hasCap ? Math.max(0, cap - used) : Number.POSITIVE_INFINITY);

  for (const ev of events) {
    const avail = remaining();
    if (avail <= 0) { break; }

    if (ev.seg) {
      const { start, end, speed: rate } = ev.seg;
      let amount = rate * (end - start) / MS_PER_HOUR;
      let effEnd = end;
      if (amount > avail) {
        amount = avail;
        effEnd = start + (avail / rate) * MS_PER_HOUR;   // 跑满即视为结束
      }
      used += amount;
      const ovStart = Math.max(start, rangeStartMs);
      const ovEnd = Math.min(effEnd, rangeEndMs);
      if (ovEnd >= ovStart) { inRange += rate * (ovEnd - ovStart) / MS_PER_HOUR; }
    } else if (ev.bolus) {
      const amount = Math.min(ev.bolus.amount, avail);
      if (amount <= 0) { continue; }
      used += amount;
      const t = ev.bolus.time;
      const hit = startExclusive
        ? (t > rangeStartMs && t <= rangeEndMs)
        : (t >= rangeStartMs && t <= rangeEndMs);
      if (hit) { inRange += amount; }
    }
  }

  return { inRange: hasCap ? Math.min(inRange, cap) : inRange, total: used, fallback: false };
}

/* ==== 药物剩余量计算 ==== */

/**
 * 计算持续药物在指定时间段内的实际用量。
 * 用于日间小结（14:00-17:00）或夜班小结等时段计算。
 */
export function calcDrugUsageForPeriod(
  execution: DrugExecution,
  periodStart: Date,
  periodEnd: Date,
): DrugActualAmount {
  return calcContinuousDrugAmount(execution, periodStart, periodEnd, true);
}

/**
 * 判断药物在指定时间点是否仍在进行（未停止）。
 */
function isDrugOngoingAt(execution: DrugExecution, timeMs: number): boolean {
  const startMs = toMs(String(execution.startTime ?? ''));
  if (!Number.isFinite(startMs) || startMs >= timeMs) { return false; }

  // 有 endTime 且 endTime <= timeMs，说明已停止
  if (execution.endTime) {
    const endMs = toMs(String(execution.endTime));
    if (Number.isFinite(endMs) && endMs <= timeMs) { return false; }
  }

  // 检查 drugActionList 中是否有 stop 动作且时间 <= timeMs
  const actions = execution.drugActionList ?? [];
  for (const action of actions) {
    if (String(action.action ?? '').trim() === 'stop') {
      const actionMs = toMs(String(action.time ?? ''));
      if (Number.isFinite(actionMs) && actionMs <= timeMs) { return false; }
    }
  }

  return true;
}

/**
 * 计算药物从开始到指定时间点的累计用量。
 * 用于计算剩余量 = 总量 - 已用量。
 */
function calcDrugUsageUpTo(execution: DrugExecution, timeMs: number): number {
  const startMs = toMs(String(execution.startTime ?? ''));
  if (!Number.isFinite(startMs)) { return 0; }
  const result = calcContinuousDrugAmount(execution, startMs - 1, timeMs, false);
  return result.inRange;
}

/* ================= 护理班段（唯一口径） ================= */

export type NursingSegmentKey = 'day' | 'night';

export interface NursingSegment {
  key: NursingSegmentKey;
  /** 左端点，左开，不计入 */
  start: Date;
  /** 右端点，右闭，结算点 */
  end: Date;
  label: string;
}

/** 护理日切成 (7:00,17:00] 与 (17:00,次日7:00] 两段 */
export function resolveNursingSegments(selectedDate: Date): NursingSegment[] {
  const dayStart = startOfNursingDay(selectedDate);           // D 07:00
  const shiftPoint = new Date(dayStart);
  shiftPoint.setHours(17, 0, 0, 0);                           // D 17:00
  const nightEnd = endOfNursingDay(selectedDate);             // D+1 07:00
  return [
    { key: 'day',   start: dayStart,   end: shiftPoint, label: '07:00-17:00' },
    { key: 'night', start: shiftPoint, end: nightEnd,   label: '17:00-次日07:00' },
  ];
}

/**
 * 段内用量 = 累计(段末) - 累计(段初)。
 * 用差值而非重新积分，天然保证 Σ段用量 === 总用量，且复用已有的 cap 封顶逻辑。
 */
export function calcSegmentUsage(
  execution: DrugExecution,
  segStart: Date,
  segEnd: Date,
): number {
  const from = calcDrugUsageUpTo(execution, segStart.getTime());
  const to = calcDrugUsageUpTo(execution, segEnd.getTime());
  return Math.max(0, round1(to - from));
}

export interface SegmentSettlement {
  execution: DrugExecution;
  name: string;
  route: string;
  /** 本段实用量 */
  segmentUsed: number;
  /** 至段末累计已入 */
  cumulativeUsed: number;
  /** 至段末剩余 */
  remainder: number;
  cap: number;
  /** 段末仍在泵注 */
  ongoing: boolean;
  /** 段未走完，只结算到 now */
  partial: boolean;
  /** cumulativeUsed + remainder === cap */
  consistent: boolean;
}

/** 获取药物显示名称 */
function drugDisplayName(execution: DrugExecution): string {
  const drugList = execution.drugList ?? [];
  return drugList.map(item => String(item.name ?? '').trim()).filter(Boolean).join('、');
}

/**
 * 结算一个班段内所有持续泵注药物。
 * @param nowMs 截断时刻，打印时必须显式传入固定值，不要用默认的 Date.now()
 */
export function buildSegmentSettlements(
  executions: DrugExecution[],
  methods: DrugMethodConfig[],
  segment: NursingSegment,
  nowMs: number = Date.now(),
): SegmentSettlement[] {
  const segStartMs = segment.start.getTime();
  const segEndMs = segment.end.getTime();

  // 整段还没开始，不结算
  if (nowMs <= segStartMs) { return []; }

  const cutoffMs = Math.min(segEndMs, nowMs);
  const cutoff = new Date(cutoffMs);
  const partial = cutoffMs < segEndMs;

  const out: SegmentSettlement[] = [];

  for (const execution of executions) {
    const method = findDrugMethod(execution.methodCode, methods);
    // 只处理持续泵注；单次给药走原有明细行逻辑
    if (!method || method.isOnce !== false) { continue; }

    const startMs = databaseTimeValue(execution.startTime);
    // 只展示在day段（07:00-17:00）内开始的药物
    if (!Number.isFinite(startMs) || startMs >= segStartMs) { continue; }

    const endRaw = databaseTimeValue(execution.endTime);
    const endMs = Number.isFinite(endRaw) ? endRaw : NaN;

    const cap = round1(resolveLiquidCap(execution));
    const segmentUsed = calcSegmentUsage(execution, segment.start, cutoff);
    const cumulativeUsed = round1(calcDrugUsageUpTo(execution, cutoffMs));
    // 剩余量 = 总量 - 到day段末(17:00)的累计用量
    const cumulativeAtSegStart = round1(calcDrugUsageUpTo(execution, segStartMs));
    const remainder = round1(cap - cumulativeAtSegStart);
    const ongoing = !Number.isFinite(endMs) || endMs > cutoffMs;

    // 17:00时已用完（无剩余量）的药物不出现在结算行
    if (remainder <= 0) { continue; }

    const consistent = Math.abs(cumulativeAtSegStart + remainder - cap) < 0.05;
    if (!consistent) {
      console.warn('[hljld] 用量不自洽，仅渲染实用量', {
        id: (execution as any).id, cap, cumulativeUsed, remainder,
      });
    }

    out.push({
      execution,
      name: drugDisplayName(execution),
      route: routeLabel(method.name),
      segmentUsed, cumulativeUsed, remainder, cap,
      ongoing, partial, consistent,
    });
  }

  return out;
}

/** 量列文案：已停药只显示实用量；仍在进行显示剩余量+实用量；不自洽只显示实用量 */
export function formatSegmentAmountText(s: SegmentSettlement): string {
  const used = `实用${s.segmentUsed.toFixed(1)}`;
  if (!s.consistent) { return used; }
  return `剩余${s.remainder.toFixed(1)} ${used}`;
}



/* ==== 通道归类与聚合 ==== */

type DrugChannel = 'vein' | 'transfusion' | 'gastro' | 'enteral' | 'other';

/** 配置优先（inChannel / group），名称正则兜底 */
function methodChannel(method: DrugMethodConfig): DrugChannel {
  const group = String(method.group ?? '').trim();
  const channel = String(method.inChannel ?? '').trim();
  const name = String(method.name ?? '');

  if (group === '输血' || channel === '输血') { return 'transfusion'; }
  if (ENTERAL_NUTRITION_PATTERN.test(name)) { return 'enteral'; }
  if (group === '胃肠' || channel === '胃肠' || channel === '消化道') { return 'gastro'; }
  if (channel === '静脉') { return 'vein'; }
  // 已被 COUNTED_IN_CHANNELS 拦截，理论不可达
  return 'other';
}

interface DrugChannelTotals {
  vein: Map<string, number>;
  gastro: Map<string, number>;
  transfusion: number;
  enteral: number;
  fallbackCount: number;
}

/**
 * 区间内药物执行的实际入量，按通道与途径聚合。
 * isOnce === false 走速度切分；其余按给药时点全额计入。
 * 全精度累加，舍入统一在展示层。
 */
function sumDrugAmountsByChannel(
  source: HljldSourceData,
  start: Date,
  end: Date,
  startExclusive: boolean,
): DrugChannelTotals {
  const totals: DrugChannelTotals = {
    vein: new Map(), gastro: new Map(), transfusion: 0, enteral: 0, fallbackCount: 0,
  };

  for (const execution of source.drugExecutions) {
    if (!isRenderableDrugExecution(execution)) { continue; }
    const method = findDrugMethod(execution.methodCode, source.drugMethods);
    if (!method) { continue; }

    // inChannel 必须严格等于三种入量通道之一，空值/其他值一律跳过
    const inCh = String(method.inChannel ?? '').trim();
    if (!COUNTED_IN_CHANNELS.has(inCh)) { continue; }

    let amount = 0;
    if (method.isOnce === false) {
      // 班段口径：用量 = calcDrugUsageUpTo(段末) - calcDrugUsageUpTo(段初)
      const execStartMs = databaseTimeValue(execution.startTime);
      const effectiveStartMs = startExclusive && Number.isFinite(execStartMs) && execStartMs > start.getTime()
        ? execStartMs : start.getTime();
      const usageAtEnd = calcDrugUsageUpTo(execution, end.getTime());
      const usageAtStart = calcDrugUsageUpTo(execution, effectiveStartMs);
      amount = round1(Math.max(0, usageAtEnd - usageAtStart));
    } else {
      // 行为判定：含带量 quickAdd 的单次给药按分次给药累计（不再限定肠内营养药名）
      if (hasQuickAddActions(execution)) {
        // 计算在统计区间内的 quickAdd 和 stop 的 quickAddAmount 量
        let quickAddTotal = 0;
        for (const action of (execution.drugActionList ?? [])) {
          const act = String(action.action ?? '').trim().toLowerCase();
          if (act !== 'quickadd' && act !== 'stop') { continue; }
          const actionTime = databaseTimeValue(action.time);
          if (!Number.isFinite(actionTime)) { continue; }
          if (inNursingRange(action.time, start, end, startExclusive)) {
            quickAddTotal += parseAmount(action.quickAddAmount);
          }
        }
        amount = round1(quickAddTotal);
      } else {
        if (!inNursingRange(execution.startTime, start, end, startExclusive)) { continue; }
        amount = resolveLiquidCap(execution);
      }
    }
    if (!amount) { continue; }

    const route = routeLabel(method.name);
    switch (methodChannel(method)) {
      case 'transfusion': totals.transfusion += amount; break;
      case 'enteral':     totals.enteral += amount; break;
      case 'gastro':      totals.gastro.set(route, (totals.gastro.get(route) ?? 0) + amount); break;
      case 'vein':        totals.vein.set(route, (totals.vein.get(route) ?? 0) + amount); break;
      default:
        if (typeof location !== 'undefined' && /localhost|127\.0\.0\.1/.test(location.hostname)) {
          console.warn('[HLJLD][unexpected-channel]', { methodCode: execution.methodCode, inCh });
        }
        break;
    }
  }

  const isDev = typeof location !== 'undefined' && /localhost|127\.0\.0\.1/.test(location.hostname);
  if (isDev && totals.fallbackCount) {
    console.warn('[HLJLD][drug-action-missing]', { count: totals.fallbackCount });
  }
  return totals;
}

/** 父项由子项求和，不再有 parent 兜底与负差额分支 */
function buildItems(
  keyPrefix: string,
  entries: { label: string; amount: number }[],
): HljldSummaryItem[] {
  return entries
    .filter(entry => round1(entry.amount) !== 0)
    .map(entry => ({
      key: `${keyPrefix}-${entry.label}`,
      label: entry.label,
      amount: round1(entry.amount),
      unit: 'ml' as const,
    }));
}

/* ---- 小结文本行生成 ---- */

function pushAmount(tokens: SummaryTextToken[], label: string, amount: number): void {
  tokens.push({ text: `${label}：` });
  tokens.push({ text: `${formatSummaryAmount(amount)} ml`, strong: true });
}

/** 递归渲染明细项，形如 `名称：xx ml（子项：xx ml、…）` */
function pushItems(tokens: SummaryTextToken[], items: HljldSummaryItem[]): void {
  items.forEach((item, index) => {
    if (index > 0) { tokens.push({ text: '、' }); }
    pushAmount(tokens, item.label, item.amount);
    if (item.children?.length) {
      tokens.push({ text: '（' });
      pushItems(tokens, item.children);
      tokens.push({ text: '）' });
    }
  });
}

/**
 * 输出「标签：xx ml（明细…）」分段。
 *
 * 无数据（总量为 0 且无非零明细）时整段不输出，不再默认展示 0 ml。
 * 括号仅在有非零明细时输出。
 * @returns 是否实际输出，供调用方决定分隔符
 */
function pushGroup(
  tokens: SummaryTextToken[],
  label: string,
  total: number,
  items: HljldSummaryItem[],
): boolean {
  const nonZeroItems = items.filter(item => round1(item.amount) !== 0);
  if (round1(total) === 0 && !nonZeroItems.length) { return false; }

  pushAmount(tokens, label, total);
  if (nonZeroItems.length) {
    tokens.push({ text: '（' });
    pushItems(tokens, nonZeroItems);
    tokens.push({ text: '）' });
  }
  return true;
}

/**
 * 入量行：
 * 总入量：xx ml；药物治疗：xx ml（带入药量、静脉入量（输血入量、iv、ivgtt…））；
 * 胃肠摄入：xx ml（鼻饲量（鼻饲、鼻饲泵入）、胃肠入量（po））
 */
function buildInputLine(summary: {
  totalInput: number;
  drugTreatmentTotal: number;
  drugTreatmentItems: HljldSummaryItem[];
  gastrointestinalInputTotal: number;
  gastrointestinalInputItems: HljldSummaryItem[];
}): SummaryTextToken[] {
  const tokens: SummaryTextToken[] = [];
  pushAmount(tokens, '总入量', summary.totalInput);

  const sep = () => { if (tokens.length) { tokens.push({ text: '；', sep: true }); } };
  const seg: SummaryTextToken[] = [];
  if (pushGroup(seg, '药物治疗', summary.drugTreatmentTotal, summary.drugTreatmentItems)) {
    sep(); tokens.push(...seg);
  }
  seg.length = 0;
  if (pushGroup(seg, '胃肠摄入', summary.gastrointestinalInputTotal, summary.gastrointestinalInputItems)) {
    sep(); tokens.push(...seg);
  }

  return tokens;
}

/**
 * 出量行：总出量无条件保留，其余分段无数据时整段不输出。
 * 总出量：xx ml；尿量：xx ml；净超滤量：xx ml；排出物：xx ml（…）；引流液：xx ml（…）
 */
function buildOutputLine(summary: {
  totalOutput: number;
  urineTotal: number;
  ultrafiltrationTotal: number;
  excretionTotal: number;
  outputItems: HljldSummaryItem[];
  drainTotal: number;
  drainItems: HljldSummaryItem[];
}): SummaryTextToken[] {
  const tokens: SummaryTextToken[] = [];
  pushAmount(tokens, '总出量', summary.totalOutput);

  const sep = () => { if (tokens.length) { tokens.push({ text: '；', sep: true }); } };

  if (round1(summary.urineTotal) !== 0) {
    sep(); pushAmount(tokens, '尿量', summary.urineTotal);
  }
  if (round1(summary.ultrafiltrationTotal) !== 0) {
    sep(); pushAmount(tokens, '净超滤量', summary.ultrafiltrationTotal);
  }
  const seg: SummaryTextToken[] = [];
  if (pushGroup(seg, '排出物', summary.excretionTotal, summary.outputItems)) {
    sep(); tokens.push(...seg);
  }
  seg.length = 0;
  if (pushGroup(seg, '引流液', summary.drainTotal, summary.drainItems)) {
    sep(); tokens.push(...seg);
  }

  return tokens;
}

/* ---- 收集护理日内的引流项目名称 ---- */

/**
 * 从当前护理日有效数据中收集稳定的引流项目名称和顺序。
 * 所有小结共用相同的 drainNames，确保项目结构一致。
 */
export function collectDrainNames(
  bedside: BedsideRecord[],
  effectiveStart: Date,
  effectiveEnd: Date,
  startExclusive = true,
): string[] {
  const seen = new Map<string, number>();

  for (const item of bedside) {
    if (!isValidBusinessRecord(item) || !isDrainCode(item.code) || !hasText(item.strVal)) { continue; }
    if (!inNursingRange(item.time, effectiveStart, effectiveEnd, startExclusive)) { continue; }
    const ts = minuteInstant(item.time);
    const name = drainName(item.code);
    if (!seen.has(name)) { seen.set(name, ts); }
  }

  return Array.from(seen.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);
}

/* ---- 小结 ---- */

export function buildSummary(
  kind: HljldSummaryKind,
  label: string,
  patient: PatientContext,
  source: HljldSourceData,
  periodStart: Date,
  periodEnd: Date,
  drainNames: string[],
): HljldSummary {
  const stay = resolveActiveStayRange(patient, periodStart, periodEnd);
  const actualStart = stay.effectiveStart;
  const actualEnd = stay.effectiveEnd;
  const startTs = actualStart.getTime();
  const endTs = actualEnd.getTime();

  const records = source.bedside.filter(item =>
    isValidBusinessRecord(item)
    && inNursingRange(item.time, actualStart, actualEnd, stay.startExclusive));

  const summaryLabel = buildSummaryLabel({
    defaultLabel: label,
    kind,
    actualStart,
    actualEnd,
    admissionClipped: stay.admissionClipped,
    dischargeClipped: stay.dischargeClipped,
  });

  const drug = sumDrugAmountsByChannel(source, actualStart, actualEnd, stay.startExclusive);
  const veinAmount = (route: string) => drug.vein.get(route) ?? 0;
  const veinRoutes = Array.from(drug.vein.keys());

  // 手工录入项仍取 bedside；静脉/胃肠/输血三个小时汇总已由实算取代
  const broughtTotal = sumBedsideByCodes(records, [CODE_BROUGHT]);
  const oralTotal = sumBedsideByCodes(records, [CODE_ORAL]);
  const tubeFeedingManual = sumBedsideByCodes(records, [CODE_TUBE_FEEDING]);

  // 静脉入量 = 输血 + 各静脉途径实算量
  const intravenousChildren = buildItems('intravenous', [
    { label: '输血入量', amount: drug.transfusion },
    ...veinRoutes.map(route => ({ label: route, amount: veinAmount(route) })),
  ]);
  const intravenousTotal = round1(intravenousChildren.reduce((s, c) => s + c.amount, 0));

  const drugTreatmentItems: HljldSummaryItem[] = [
    { key: 'brought-medication', label: '带入药量', amount: round1(broughtTotal), unit: 'ml' },
    { key: 'intravenous', label: '静脉入量', amount: intravenousTotal, unit: 'ml',
      children: intravenousChildren },
  ];
  const drugTreatmentTotal = round1(broughtTotal + intravenousTotal);

  // 鼻饲量 = 手工鼻饲 + 肠内营养泵入实算量
  const tubeFeedingChildren = buildItems('tube-feeding', [
    { label: '鼻饲', amount: tubeFeedingManual },
    { label: '鼻饲泵入', amount: drug.enteral },
  ]);
  const tubeFeedingAdj = round1(tubeFeedingManual + drug.enteral);

  // 胃肠入量 = 口服（手工 + po 执行）+ 其他胃肠途径
  const gastroPo = oralTotal + (drug.gastro.get('po') ?? 0);
  const gastroOtherRoutes = Array.from(drug.gastro.entries()).filter(([route]) => route !== 'po');
  const gastroChildren = buildItems('gastrointestinal', [
    { label: 'po', amount: gastroPo },
    ...gastroOtherRoutes.map(([route, amount]) => ({ label: route, amount })),
  ]);
  const gastroTotal = round1(gastroChildren.reduce((s, c) => s + c.amount, 0));

  const gastrointestinalInputItems: HljldSummaryItem[] = [
    { key: 'tube-feeding', label: '鼻饲量', amount: tubeFeedingAdj, unit: 'ml',
      children: tubeFeedingChildren },
    { key: 'gastrointestinal', label: '胃肠入量', amount: gastroTotal, unit: 'ml',
      children: gastroChildren },
  ];
  const gastrointestinalInputTotal = round1(tubeFeedingAdj + gastroTotal);

  // 展平视图，供外部读取；不可再对其求和，否则输血与口服会重复计数
  const inputItems: HljldSummaryItem[] = [
    { key: 'brought-medication', label: '带入药量', amount: round1(broughtTotal), unit: 'ml' },
    { key: 'oral', label: '口服量', amount: round1(gastroPo), unit: 'ml' },
    { key: 'tube-feeding', label: '鼻饲量', amount: tubeFeedingAdj, unit: 'ml' },
    { key: 'intravenous', label: '静脉入量', amount: intravenousTotal, unit: 'ml' },
    { key: 'gastrointestinal', label: '胃肠入量', amount: round1(gastroTotal - gastroPo), unit: 'ml' },
    { key: 'blood-transfusion', label: '输血入量', amount: round1(drug.transfusion), unit: 'ml' },
  ];

  const totalInput = round1(drugTreatmentTotal + gastrointestinalInputTotal);

  // 尿量、净超滤量单独统计，不再计入排出物
  const sumByCode = (code: string) => round1(
    records.filter(item => item.code === code)
      .reduce((sum, item) => sum + parseAmount(item.strVal), 0),
  );
  const urineTotal = sumByCode(URINE_CODE);
  const ultrafiltrationTotal = sumByCode(ULTRAFILTRATION_CODE);

  const outputItems: HljldSummaryItem[] = EXCRETION_SUMMARY_DEFINITIONS.map(def => ({
    key: def.key,
    label: def.label,
    amount: sumByCode(def.code),
    unit: 'ml' as const,
  }));
  const excretionTotal = round1(outputItems.reduce((sum, item) => sum + item.amount, 0));

  const drainItems: HljldSummaryItem[] = drainNames.map(name => ({
    key: `drain-${name}`,
    label: name,
    amount: round1(records
      .filter(item => isDrainCode(item.code) && drainName(item.code) === name)
      .reduce((total, item) => total + parseAmount(item.strVal), 0)),
    unit: 'ml' as const,
  }));
  const drainTotal = round1(drainItems.reduce((sum, item) => sum + item.amount, 0));

  const totalOutput = round1(urineTotal + ultrafiltrationTotal + excretionTotal + drainTotal);
  const balance = round1(totalInput - totalOutput);

  const detailLines: SummaryTextToken[][] = [
    buildInputLine({
      totalInput,
      drugTreatmentTotal,
      drugTreatmentItems,
      gastrointestinalInputTotal,
      gastrointestinalInputItems,
    }),
    buildOutputLine({
      totalOutput,
      urineTotal,
      ultrafiltrationTotal,
      excretionTotal,
      outputItems,
      drainTotal,
      drainItems,
    }),
    [{ text: '平衡量：' }, { text: `${formatSummaryAmount(balance)} ml`, strong: true }],
  ];

  return {
    kind,
    label: summaryLabel,
    periodText: `${formatTime(startTs)}—${formatTime(endTs)}`,
    plannedStart: periodStart.getTime(),
    plannedEnd: periodEnd.getTime(),
    periodStart: startTs,
    periodEnd: endTs,
    admissionClipped: stay.admissionClipped,
    dischargeClipped: stay.dischargeClipped,
    available: stay.hasValidRange,
    totalInput,
    inputItems,
    totalOutput,
    outputItems,
    drainItems,
    balance,
    drugTreatmentTotal,
    drugTreatmentItems,
    gastrointestinalInputTotal,
    gastrointestinalInputItems,
    excretionTotal,
    drainTotal,
    urineTotal,
    ultrafiltrationTotal,
    detailLines,
  };
}

/* ---- 管路护理记录 ---- */

/** 统一 valid/status 过滤 */
export function isValidBusinessRecord(record: { valid?: boolean; status?: string } | null | undefined): boolean {
  if (!record) { return false; }
  if (record.valid === false) { return false; }
  const status = String(record.status ?? '').trim().toLowerCase();
  if (status === 'invalid') { return false; }
  return true;
}

/** 格式化管路动态字段值 */
function formatTubeFieldValue(value: unknown): string {
  if (value === null || value === undefined) { return ''; }
  if (Array.isArray(value)) { return value.map(item => formatTubeFieldValue(item)).filter(Boolean).join('、'); }
  if (typeof value === 'string') { return value.trim(); }
  if (typeof value === 'number') { return Number.isFinite(value) ? String(value) : ''; }
  if (typeof value === 'boolean') { return value ? '是' : '否'; }
  return '';
}

/** 从管路配置中读取动态字段值 */
function getDynamicField(source: Record<string, unknown>, field: string): unknown {
  return source[field];
}

/** 匹配 tubeExe.type 与 configTubeView.tubeType */
export function findTubeView(type: string | undefined, views: ConfigTubeView[]): ConfigTubeView | undefined {
  const target = String(type ?? '').trim();
  if (!target) { return undefined; }
  return views.find(view => isValidBusinessRecord(view) && String(view.tubeType ?? '').trim() === target);
}

/** 生成单条管路护理记录文本 */
export function buildTubeNursingText(execution: TubeExecution, record: TubeRecord, view: ConfigTubeView): string {
  if (!isValidBusinessRecord(execution) || !isValidBusinessRecord(record) || !isValidBusinessRecord(view)) { return ''; }

  const tubeName = String(execution.name ?? view.tubeType ?? execution.type ?? '管路').trim();
  const parts: string[] = [];

  const appendConfiguredFields = (configs: TubeFieldConfig[], source: Record<string, unknown>): void => {
    for (const config of configs) {
      if (!isValidBusinessRecord(config)) { continue; }
      const name = String(config.name ?? '').trim();
      const field = String(config.field ?? '').trim();
      if (!name || !field) { continue; }
      const value = formatTubeFieldValue(getDynamicField(source, field));
      if (!value) { continue; }
      parts.push(`${name}：${value}`);
    }
  };

  appendConfiguredFields(view.tubeFieldConfigList ?? [], execution as Record<string, unknown>);
  appendConfiguredFields(view.tubeRecordFieldConfigList ?? [], record as Record<string, unknown>);

  if (!parts.length) { return ''; }
  return `${tubeName}：${parts.join('，')}`;
}

export function buildTubeNursingEntries(
  source: HljldSourceData,
  start: Date,
  end: Date,
  startExclusive = true,
): TubeNursingEntry[] {
  const entries: TubeNursingEntry[] = [];

  for (const exe of source.tubeExecutions) {
    if (!isValidBusinessRecord(exe)) { continue; }
    const view = findTubeView(exe.type, source.tubeViews);
    if (!view) {
      const isDev = typeof location !== 'undefined' && /localhost|127\.0\.0\.1/.test(location.hostname);
      if (isDev) { console.warn('[HLJLD][tube-view-missing]', { tubeExecutionId: exe._id, type: exe.type }); }
      continue;
    }

    for (const record of (exe.tubeRecordList ?? [])) {
      if (!isValidBusinessRecord(record)) { continue; }
      if (!inNursingRange(String(record.time ?? ''), start, end, startExclusive)) { continue; }

      const text = buildTubeNursingText(exe, record, view);
      if (!text) { continue; }

      const ts = minuteInstant(String(record.time ?? ''));
      entries.push({
        key: `tube-${exe._id}-${record._id}-${ts}`,
        timestamp: ts,
        time: String(record.time ?? ''),
        text,
      });
    }
  }

  entries.sort((a, b) => a.timestamp - b.timestamp);
  return entries;
}

/* ---- 时间行生成 ---- */

export function buildRows(
  source: HljldSourceData,
  start: Date,
  end: Date,
  accountMap: Map<string, string> = new Map(),
  startExclusive = true,
): HljldTimeRow[] {
  const inPeriod = (value?: string): boolean =>
    !!value && inNursingRange(value, start, end, startExclusive);

  const bedsideInPeriod = source.bedside
    .filter(item => isRenderableBedsideRecord(item) && inPeriod(item.time));
  const drugsInPeriod = source.drugExecutions
    .filter(item => isRenderableDrugExecution(item) && inPeriod(item.startTime));
  const nurseInPeriod = source.nurseRecords
    .filter(item => isValidBusinessRecord(item) && hasText(item.desc) && inPeriod(item.time));

  // 肠内营养跨护理日补充：startTime 不在当前护理日但 quickAdd/带量stop 在当前护理日（与后端对齐）
  const enteralCrossDayDrugs = source.drugExecutions
    .filter(item => isRenderableDrugExecution(item) && !inPeriod(item.startTime))
    .filter(item => {
      const method = findDrugMethod(item.methodCode, source.drugMethods);
      return !!method && String(method.group ?? '').trim() === '胃肠' && hasQuickAddActions(item);
    })
    .filter(item => (item.drugActionList ?? []).some(a => {
      const act = String(a.action ?? '').trim().toLowerCase();
      const isDoseAction = act === 'quickadd' || (act === 'stop' && parseAmount(a.quickAddAmount) > 0);
      return isDoseAction && inPeriod(a.time);
    }));

  // 收集肠内分次给药的 quickAdd/带量stop 时间点（行为判定，仅收护理区间内，避免跨日幻影行）
  const enteralQuickAddKeys: number[] = [];
  for (const execution of [...drugsInPeriod, ...enteralCrossDayDrugs]) {
    if (!isRenderableDrugExecution(execution)) { continue; }
    const method = findDrugMethod(execution.methodCode, source.drugMethods);
    if (!method) { continue; }
    const isEnteral = String(method.group ?? '').trim() === '胃肠';
    if (!isEnteral) { continue; }
    // 行为判定：含带量 quickAdd 的胃肠组执行按分次给药收集时间键
    if (!hasQuickAddActions(execution)) { continue; }

    for (const action of (execution.drugActionList ?? [])) {
      const act = String(action.action ?? '').trim().toLowerCase();
      const isDoseAction = act === 'quickadd' || (act === 'stop' && parseAmount(action.quickAddAmount) > 0);
      if (!isDoseAction) { continue; }
      if (!inPeriod(action.time)) { continue; }
      const actionKey = minuteKey(action.time);
      if (Number.isFinite(actionKey)) {
        enteralQuickAddKeys.push(actionKey);
      }
    }
  }

  const uniqueKeys = Array.from(new Set([
    ...bedsideInPeriod.map(item => minuteKey(item.time)),
    ...drugsInPeriod.map(item => minuteKey(item.startTime)),
    ...nurseInPeriod.map(item => minuteKey(item.time)),
    ...enteralQuickAddKeys,
  ]))
    .filter(key => Number.isFinite(key))
    .sort((a, b) => a - b);

  const rows: HljldTimeRow[] = [];

  // 计算日间小结时间点（17:00）
  const dayBoundary = new Date(start);
  dayBoundary.setHours(17, 0, 0, 0);
  const dayBoundaryMs = dayBoundary.getTime();

  // 解析护理班段
  const segments = resolveNursingSegments(start);
  const daySegment = segments[0];   // (07:00, 17:00]
  const nightSegment = segments[1]; // (17:00, 次日07:00]

  /** 找到 timeMs 所属的段（左开右闭） */
  function segmentOf(timeMs: number): NursingSegment | undefined {
    for (const seg of segments) {
      if (timeMs > seg.start.getTime() && timeMs <= seg.end.getTime()) { return seg; }
    }
    return undefined;
  }

  // ---- 表首 carryOver 行：前一护理日 night 段仍在执行的续用药物 ----
  {
    // ---- 表首 carryOver 行：在07:00仍活跃（含已停）的持续药物 ----
    const dayStartMs = start.getTime();
    const nowMs = Date.now();
    const carryMeds: NameAmountRoute[] = [];
    for (const execution of source.drugExecutions) {
      if (!isRenderableDrugExecution(execution)) { continue; }
      const method = findDrugMethod(execution.methodCode, source.drugMethods);
      if (!method || method.isOnce !== false) { continue; }
      const startMsExec = databaseTimeValue(execution.startTime);
      if (!Number.isFinite(startMsExec) || startMsExec >= dayStartMs) { continue; } // 当天开始的不算续用
      // 药物在07:00必须仍在活跃（未停止或刚好在07:00之后停）
      if (!isDrugOngoingAt(execution, dayStartMs)) { continue; }
      const cap = round1(resolveLiquidCap(execution));
      if (cap <= 0) { continue; }
      const name = drugDisplayName(execution);
      if (!name) { continue; }
      // 剩余量 = 总量 - 到07:00的累计用量
      const usedAt0700 = round1(calcDrugUsageUpTo(execution, dayStartMs));
      const remaining = round1(cap - usedAt0700);
      // 实用量 = 07:00到当前时刻的累计用量
      const usedNow = round1(calcDrugUsageUpTo(execution, nowMs));
      const currentUsage = round1(Math.max(0, usedNow - usedAt0700));
      carryMeds.push({
        name,
        amount: `剩余${remaining.toFixed(1)}|实用${currentUsage.toFixed(1)}`,
        numericAmount: 0, // 不参与小结累加
        route: routeLabel(method.name),
      });
    }
    if (carryMeds.length > 0) {
      rows.push({
        key: `carry-over-${start.getTime()}`,
        time: new Date(start.getTime()),
        timeText: '',
        sortRank: -1,
        medications: carryMeds,
        enteral: [],
        urines: [],
        ultrafiltrations: [],
        outputs: [],
        drains: [],
        examination: [],
        treatment: [],
        basicCare: [],
        healthEducation: [],
        nursingRecords: [],
        signature: '',
      });
    }
  }

  // 追踪是否已添加日间小结后剩余量
  let daySummaryRemaindersAdded = false;

  for (const key of uniqueKeys) {
    const timeMs = key * 60000;
    const bedside = bedsideInPeriod.filter(item => minuteKey(item.time) === key);

    const medications: NameAmountRoute[] = [];
    const enteral: NameAmountRoute[] = [];

    // 肠内营养 quickAdd：遍历区间内药物和跨日药物，不按 startTime 过滤（行为判定，替代药名白名单）
    for (const execution of [...drugsInPeriod, ...enteralCrossDayDrugs]) {
      const method = findDrugMethod(execution.methodCode, source.drugMethods);
      if (!method) { continue; }
      const isEnteral = String(method.group ?? '').trim() === '胃肠';
      if (!isEnteral) { continue; }
      const drugName = drugDisplayName(execution);
      if (!hasQuickAddActions(execution)) { continue; }

      for (const action of (execution.drugActionList ?? [])) {
        if (String(action.action ?? '').trim().toLowerCase() !== 'quickadd') { continue; }
        const actionKey = minuteKey(action.time);
        if (actionKey !== key) { continue; }
        const quickAddAmount = parseAmount(action.quickAddAmount);

        const cell: NameAmountRoute = {
          name: enteralDisplayName(drugName),
          amount: quickAddAmount > 0 ? `${quickAddAmount.toFixed(1)}` : '0',
          numericAmount: quickAddAmount,
          route: routeLabel(method.name),
        };
        if (hasNameOrAmount(cell)) { enteral.push(cell); }
      }
    }

    const drugExecutions = drugsInPeriod.filter(item => minuteKey(item.startTime) === key);

    // 日间小结（17:00）之后：插入 night 段结算行（17:00→07:00 用量）
    if (!daySummaryRemaindersAdded && timeMs > dayBoundaryMs) {
      const nowMs = Date.now();
      const settlements = buildSegmentSettlements(
        source.drugExecutions,
        source.drugMethods,
        nightSegment,
        nowMs,
      );
      if (settlements.length > 0) {
        const settlementMeds: NameAmountRoute[] = settlements.map(s => ({
          name: s.name,
          amount: formatSegmentAmountText(s),
          numericAmount: s.segmentUsed,
          route: s.route,
        }));
        rows.push({
          key: `settlement-day-${dayBoundaryMs}`,
          time: new Date(dayBoundaryMs + 1000), // 比17:00晚1秒
          timeText: '',
          sortRank: 2,
          medications: settlementMeds,
          enteral: [],
          urines: [],
          ultrafiltrations: [],
          outputs: [],
          drains: [],
          examination: [],
          treatment: [],
          basicCare: [],
          healthEducation: [],
          nursingRecords: [],
          signature: '',
        });
      }
      daySummaryRemaindersAdded = true;
    }

    drugExecutions.forEach(execution => {
      const method = findDrugMethod(execution.methodCode, source.drugMethods);
      if (!method) { return; }
      const isEnteral = String(method.group ?? '').trim() === '胃肠';
      // 行为判定替代药名白名单：胃肠组且含带量 quickAdd 的执行按分次给药处理
      const isTargetEnteral = isEnteral && hasQuickAddActions(execution);

      // 检查当前时间点是否有 quickAdd（用于跳过总量行）
      let hasQuickAddAtTime = false;
      if (isTargetEnteral) {
          for (const action of (execution.drugActionList ?? [])) {
            if (String(action.action ?? '').trim().toLowerCase() !== 'quickadd') { continue; }
            if (minuteKey(action.time) !== key) { continue; }
            const quickAddAmount = parseAmount(action.quickAddAmount);
            if (quickAddAmount <= 0) { continue; }
            hasQuickAddAtTime = true;
            break;
          }
      }

      // 持续药物：仅在开始时间列展示医嘱液体量（resolveLiquidCap），后续时间列按段内累计
      if (method.isOnce === false) {
        const startMs = toMs(String(execution.startTime ?? ''));
        const ongoing = isDrugOngoingAt(execution, timeMs);
        const startsAtTime = Number.isFinite(startMs) && minuteKey(new Date(startMs)) === key;
        if (!ongoing && !startsAtTime) { return; }

        // 开始行：显示当天所在班段（07:00→17:00 或 17:00→07:00）的实际用量
        if (startsAtTime) {
          const seg = segments.find(s => startMs >= s.start.getTime() && startMs < s.end.getTime());
          const segStartMs = seg?.start.getTime();
          const segEndMs = seg?.end.getTime();
          const cell = drugToCell(execution, method, isEnteral, startMs, segStartMs, segEndMs);
          // 始终覆盖 amount 格式，保证0量也显示
          cell.amount = `实用量 ${cell.numericAmount.toFixed(1)}`;
          if (hasNameOrAmount(cell)) { (isEnteral ? enteral : medications).push(cell); }
          return;
        }

        // 其余行：段初到当前时刻的累计
        const seg = segmentOf(timeMs);
        const cell = drugToCell(execution, method, isEnteral, timeMs, seg?.start.getTime());
        if (hasNameOrAmount(cell)) { (isEnteral ? enteral : medications).push(cell); }
        return;
      }

      // 单次给药：在开始时间点展示（但如果当前时间点已有 quickAdd，则跳过总量行）
      if (!hasQuickAddAtTime) {
        const startMs = toMs(String(execution.startTime ?? ''));
        const startsAtTime = Number.isFinite(startMs) && minuteKey(new Date(startMs)) === key;
        if (startsAtTime) {
          const cell = drugToCell(execution, method, isEnteral, startMs);
          if (hasNameOrAmount(cell)) { (isEnteral ? enteral : medications).push(cell); }
        }
      }

    });

    // 单次给药 stop 时间点：累积 quickAdd 量 + stop 的 quickAddAmount == liquidAmount 时才展示
    // （行为判定含跨日药物：stop 携带末次给药量，跨日不可丢）
    for (const execution of [...drugsInPeriod, ...enteralCrossDayDrugs]) {
      const method = findDrugMethod(execution.methodCode, source.drugMethods);
      if (!method) { continue; }
      const isEnteral = String(method.group ?? '').trim() === '胃肠';
      const isTargetEnteral = isEnteral && hasQuickAddActions(execution);
      if (!isTargetEnteral) { continue; }

      const stopAction = (execution.drugActionList ?? []).find(a =>
        String(a.action ?? '').trim().toLowerCase() === 'stop' && minuteKey(a.time) === key
      );
      if (stopAction) {
        const execStartMs = toMs(String(execution.startTime ?? ''));
        const stopMs = toMs(String(stopAction.time ?? ''));
        if (Number.isFinite(execStartMs) && Number.isFinite(stopMs)) {
          // 累积 stop 之前的所有 quickAdd 量
          let cumulativeQuickAdd = 0;
          for (const a of (execution.drugActionList ?? [])) {
            if (String(a.action ?? '').trim().toLowerCase() !== 'quickadd') { continue; }
            const aMs = toMs(String(a.time ?? ''));
            if (Number.isFinite(aMs) && aMs >= execStartMs && aMs <= stopMs) {
              cumulativeQuickAdd += parseAmount(a.quickAddAmount);
            }
          }
          // 加上 stop 自身的 quickAddAmount
          cumulativeQuickAdd += parseAmount(stopAction.quickAddAmount);
          const liquidCap = resolveLiquidCap(execution);
          if (Math.abs(cumulativeQuickAdd - liquidCap) < 0.05) {
            const cell = drugToCell(execution, method, isEnteral, stopMs);
            const stopAmount = parseAmount(stopAction.quickAddAmount);
            cell.amount = stopAmount > 0 ? `${stopAmount.toFixed(1)}` : '';
            cell.numericAmount = stopAmount;
            if (hasNameOrAmount(cell)) { (isEnteral ? enteral : medications).push(cell); }
          }
        }
      }
    }

    bedside
      .filter(item => item.code === CODE_BROUGHT)
      .map(bedsideInputCell)
      .filter(hasNameOrAmount)
      .forEach(cell => medications.push(cell));

    bedside
      .filter(item => item.code === CODE_ORAL || item.code === CODE_TUBE_FEEDING)
      .map(bedsideInputCell)
      .filter(hasNameOrAmount)
      .forEach(cell => enteral.push(cell));

    const values = (code: string) => bedside
      .filter(item => item.code === code)
      .map(item => displayAmount(item.strVal))
      .filter(hasText);

    // 尿量、净超滤量独立成列，只保留量
    const urines = values(URINE_CODE);
    const ultrafiltrations = values(ULTRAFILTRATION_CODE);

    const outputs: NameAmount[] = bedside
      .filter(item => Boolean(OUTPUT_CODE_NAMES[item.code]))
      .map(item => ({
        name: OUTPUT_CODE_NAMES[item.code],
        amount: displayAmount(item.strVal),
        numericAmount: parseAmount(item.strVal),
      }))
      .filter(hasAmountValue);

    const drains: NameAmount[] = bedside
      .filter(item => isDrainCode(item.code))
      .map(item => ({
        name: drainName(item.code),
        amount: displayAmount(item.strVal),
        numericAmount: parseAmount(item.strVal),
      }))
      .filter(hasAmountValue);

    const examination = values('param_外出检查');
    const treatment = values('param_物理治疗');
    const basicCare = values('param_基础护理1');
    const healthEducation = values('param_健康教育');

    const nurseRowsAtKey = nurseInPeriod.filter(item => minuteKey(item.time) === key);
    const nursingRecords: string[] = [];

    // 护理记录
    const combinedNursing = nurseRowsAtKey
      .map(item => String(item.desc).trim())
      .filter(Boolean)
      .join('；');
    if (combinedNursing) { nursingRecords.push(combinedNursing); }

    const hasContent = medications.length || enteral.length
      || urines.length || ultrafiltrations.length
      || outputs.length || drains.length
      || examination.length || treatment.length || basicCare.length
      || healthEducation.length || nursingRecords.length;
    if (!hasContent) { continue; }

    // 有护理记录时优先用护理记录的记录者，取该分钟内最后一条可解析的签名
    let signature = '';
    for (let i = nurseRowsAtKey.length - 1; i >= 0; i -= 1) {
      const name = resolveNurseSignature(nurseRowsAtKey[i], accountMap);
      if (name) { signature = name; break; }
    }
    // 没有护理记录（或护理记录无签名信息）时回退到意识记录
    if (!signature) {
      const signUserId = resolveYishiSignerId(timeMs, source.bedside);
      signature = signUserId ? (accountMap.get(signUserId) || '') : '';
    }

    rows.push({
      key: String(key),
      time: new Date(timeMs),
      timeText: formatTime(timeMs),
      sortRank: 0,
      medications,
      enteral,
      urines,
      ultrafiltrations,
      outputs,
      drains,
      examination,
      treatment,
      basicCare,
      healthEducation,
      nursingRecords,
      signature,
    });
  }

  // night 段结算行（07:00）：插入到表尾
  {
    const nowMs = Date.now();
    const nightSettlements = buildSegmentSettlements(
      source.drugExecutions,
      source.drugMethods,
      nightSegment,
      nowMs,
    );
    if (nightSettlements.length > 0) {
      const settlementMeds: NameAmountRoute[] = nightSettlements.map(s => ({
        name: s.name,
        amount: formatSegmentAmountText(s),
        numericAmount: s.segmentUsed,
        route: s.route,
      }));
      rows.push({
        key: `settlement-night-${nightSegment.end.getTime()}`,
        time: new Date(nightSegment.end.getTime() + 1000), // 比07:00晚1秒
        timeText: '',
        sortRank: 2,
        medications: settlementMeds,
        enteral: [],
        urines: [],
        ultrafiltrations: [],
        outputs: [],
        drains: [],
        examination: [],
        treatment: [],
        basicCare: [],
        healthEducation: [],
        nursingRecords: [],
        signature: '',
      });
    }
  }

  return rows;
}

/* ---- 时间组展开 ---- */

export function buildDisplayGroups(sourceRows: HljldTimeRow[]): HljldTimeGroup[] {
  const sortedRows = [...sourceRows].sort((a, b) => {
    const da = minuteInstant(a.time);
    const db = minuteInstant(b.time);
    if (da !== db) { return da - db; }
    return (a.sortRank ?? 0) - (b.sortRank ?? 0);
  });
  const groups: HljldTimeGroup[] = [];

  for (const row of sortedRows) {
    const medications = row.medications.filter(hasNameOrAmount);
    const enteral = row.enteral.filter(hasNameOrAmount);
    const urines = row.urines.filter(hasText);
    const ultrafiltrations = row.ultrafiltrations.filter(hasText);
    const outputs = row.outputs.filter(hasAmountValue);
    const drains = row.drains.filter(hasAmountValue);
    const examination = row.examination.filter(hasText);
    const treatment = row.treatment.filter(hasText);
    const basicCare = row.basicCare.filter(hasText);
    const healthEducation = row.healthEducation.filter(hasText);
    const nursingRecords = row.nursingRecords.filter(hasText);

    const lineCount = Math.max(
      medications.length, enteral.length,
      urines.length, ultrafiltrations.length,
      outputs.length, drains.length,
      examination.length, treatment.length, basicCare.length,
      healthEducation.length, nursingRecords.length,
    );
    if (lineCount <= 0) { continue; }

    const timestamp = row.time.getTime();
    const groupKey = row.key;
    const displayRows: HljldDisplayRow[] = [];

    for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
      const firstLine = lineIndex === 0;
      const lastLine = lineIndex === lineCount - 1;
      displayRows.push({
        key: `${groupKey}::${lineIndex}`,
        groupKey,
        timestamp,
        lineIndex,
        firstLine,
        lastLine,
        timeText: firstLine ? row.timeText : '',
        medication: medications[lineIndex],
        enteral: enteral[lineIndex],
        urine: urines[lineIndex] ?? '',
        ultrafiltration: ultrafiltrations[lineIndex] ?? '',
        output: outputs[lineIndex],
        drain: drains[lineIndex],
        examination: examination[lineIndex] ?? '',
        treatment: treatment[lineIndex] ?? '',
        basicCare: basicCare[lineIndex] ?? '',
        healthEducation: healthEducation[lineIndex] ?? '',
        nursingRecord: nursingRecords[lineIndex] ?? '',
        signature: lastLine ? row.signature : '',
      });
    }

    groups.push({ key: groupKey, timestamp, rows: displayRows });
  }

  return groups;
}

/* ---- 时间轴构建 ---- */

export function buildTimeline(
  groups: HljldTimeGroup[],
  daySummary: HljldSummary,
  shiftSummary: HljldSummary,
  fullDaySummary: HljldSummary,
  dayBoundaryMs: number,
  nextMorningBoundaryMs: number,
  nowMs: number,
  dischargeSummary?: HljldSummary,
  effectiveEndMs?: number,
): HljldTimelineItem[] {
  const result: HljldTimelineItem[] = [];
  let dayInserted = false;
  let dischargeInserted = false;

  const sortedGroups = [...groups].sort((a, b) => a.timestamp - b.timestamp);

  // 日间小结显示条件：必须有效且时间段大于0分钟
  const showDaySummary =
    daySummary.available
    && daySummary.periodEnd > daySummary.periodStart
    && nowMs >= dayBoundaryMs;

  // 次日07:00小结和24小时总结显示条件
  const showShiftSummary =
    shiftSummary.available
    && shiftSummary.periodEnd > shiftSummary.periodStart
    && nowMs >= nextMorningBoundaryMs;

  const showFullDaySummary =
    fullDaySummary.available
    && fullDaySummary.periodEnd > fullDaySummary.periodStart
    && nowMs >= nextMorningBoundaryMs;

  // 出科时间点
  const dischargeMs = dischargeSummary ? dischargeSummary.periodEnd : 0;
  const hasDischarge = !!dischargeSummary && dischargeSummary.available && dischargeMs > 0;

  // 出科在17:00之前：不插入 daySummary
  const dischargeBeforeDay = hasDischarge && dischargeMs < dayBoundaryMs;
  // 出科等于17:00：不插入 daySummary，只插入 dischargeSummary
  const dischargeAtDay = hasDischarge && dischargeMs === dayBoundaryMs;
  // 出科在17:00之后、次日07:00之前
  const dischargeBetween = hasDischarge && dischargeMs > dayBoundaryMs && dischargeMs < nextMorningBoundaryMs;
  // 出科等于或晚于次日07:00
  const dischargeAtOrAfterMorning = hasDischarge && dischargeMs >= nextMorningBoundaryMs;

  for (const group of sortedGroups) {
    // 只展示当前时间之前已经发生的数据
    if (group.timestamp > minuteInstant(nowMs)) { continue; }

    // 右闭：等于有效结束时刻的那一分钟仍要展示
    if (effectiveEndMs !== undefined && group.timestamp > minuteInstant(effectiveEndMs)) { continue; }

    // 右闭：次日 07:00 属于本护理日最后一分钟
    if (group.timestamp > minuteInstant(nextMorningBoundaryMs)) { continue; }

    // 已到17:00边界，当前组晚于17:00时，先插入日间小结
    // 但出科在17:00之前或等于17:00时不插入 daySummary
    if (showDaySummary && !dayInserted && !dischargeBeforeDay && !dischargeAtDay && group.timestamp > dayBoundaryMs) {
      result.push({ kind: 'day-summary', key: 'day-summary-17', timestamp: dayBoundaryMs, summary: daySummary });
      dayInserted = true;
    }

    // 出科时间在明细之间：在出科时间前插入 daySummary（如果需要），然后插入 dischargeSummary
    if (hasDischarge && !dischargeInserted && dischargeBetween && group.timestamp >= dischargeMs && !dischargeBeforeDay && !dischargeAtDay) {
      // 先确保 daySummary 已插入
      if (showDaySummary && !dayInserted) {
        result.push({ kind: 'day-summary', key: 'day-summary-17', timestamp: dayBoundaryMs, summary: daySummary });
        dayInserted = true;
      }
      result.push({ kind: 'discharge-summary', key: `discharge-summary-${dischargeMs}`, timestamp: dischargeMs, summary: dischargeSummary! });
      dischargeInserted = true;
    }

    result.push({ kind: 'time-group', key: group.key, timestamp: group.timestamp, group });

    // 正好17:00：先展示完整组，再展示日间小结
    if (showDaySummary && !dayInserted && !dischargeBeforeDay && !dischargeAtDay && group.timestamp === dayBoundaryMs) {
      result.push({ kind: 'day-summary', key: 'day-summary-17', timestamp: dayBoundaryMs, summary: daySummary });
      dayInserted = true;
    }

    // 正好出科时间：先展示完整组，再展示出科总结
    if (hasDischarge && !dischargeInserted && group.timestamp === dischargeMs) {
      // 先确保 daySummary 已插入（出科在17:00之后的情况）
      if (showDaySummary && !dayInserted && !dischargeBeforeDay && !dischargeAtDay && dischargeMs > dayBoundaryMs) {
        result.push({ kind: 'day-summary', key: 'day-summary-17', timestamp: dayBoundaryMs, summary: daySummary });
        dayInserted = true;
      }
      result.push({ kind: 'discharge-summary', key: `discharge-summary-${dischargeMs}`, timestamp: dischargeMs, summary: dischargeSummary! });
      dischargeInserted = true;
    }
  }

  // 已到17:00但之后没有明细，仍需展示日间小结（出科不在17:00之前或等于17:00）
  if (showDaySummary && !dayInserted && !dischargeBeforeDay && !dischargeAtDay) {
    result.push({ kind: 'day-summary', key: 'day-summary-17', timestamp: dayBoundaryMs, summary: daySummary });
    dayInserted = true;
  }

  // 出科在17:00之前：在所有明细之后插入 dischargeSummary
  if (hasDischarge && !dischargeInserted && dischargeBeforeDay) {
    result.push({ kind: 'discharge-summary', key: `discharge-summary-${dischargeMs}`, timestamp: dischargeMs, summary: dischargeSummary! });
    dischargeInserted = true;
  }

  // 出科等于17:00：在所有明细之后插入 dischargeSummary（替代 daySummary）
  if (hasDischarge && !dischargeInserted && dischargeAtDay) {
    result.push({ kind: 'discharge-summary', key: `discharge-summary-${dischargeMs}`, timestamp: dischargeMs, summary: dischargeSummary! });
    dischargeInserted = true;
  }

  // 出科在17:00之后、次日07:00之前：如果还没插入，在最后插入
  if (hasDischarge && !dischargeInserted && dischargeBetween) {
    if (showDaySummary && !dayInserted) {
      result.push({ kind: 'day-summary', key: 'day-summary-17', timestamp: dayBoundaryMs, summary: daySummary });
    }
    result.push({ kind: 'discharge-summary', key: `discharge-summary-${dischargeMs}`, timestamp: dischargeMs, summary: dischargeSummary! });
    dischargeInserted = true;
  }

  // 次日07:00展示：夜班小结（17:00→次日07:00）+ 24小时总结
  // 次日07:00前出科：不追加；次日07:00时或之后出科：应显示
  const shouldAppendNextMorningSummaries =
    !hasDischarge || dischargeAtOrAfterMorning;
  if (shouldAppendNextMorningSummaries) {
    if (showShiftSummary) {
      result.push({ kind: 'shift-summary', key: 'shift-summary-next-07', timestamp: nextMorningBoundaryMs, summary: shiftSummary });
    }
    if (showFullDaySummary) {
      result.push({ kind: 'full-day-summary', key: 'full-day-summary-next-07', timestamp: nextMorningBoundaryMs, summary: fullDaySummary });
    }
  }

  return result;
}

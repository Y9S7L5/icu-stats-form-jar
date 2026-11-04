import {
  BedsideRecord,
  DepartmentDailySnapshot,
  DepartmentPatient,
  HandoverPatientRow,
  HandoverReportViewModel,
  HandoverStatus,
  NightFluidSummary,
  NightVitalSigns,
  ShiftKey,
  ShiftRange,
  ShiftStatistics,
} from './handover-report.models';
import { buildSafetyMetrics } from './handover-report.metrics';
import { firstDiagnosisSegment, resolveNursingDayDiagnosis } from './diagnosis-history.util';

const SHIFT_KEYS: ShiftKey[] = ['day', 'evening', 'night'];

// 展示顺序：死亡 → 出院/转出 → 新收(入院) → 转入 → 手术 → 危重(病危)
const STATUS_ORDER: Record<HandoverStatus, number> = {
  '死亡': 1, '出院': 2, '转出': 3, '入院': 4, '转入': 5, '手术': 6, '病危': 7,
  // 转入/入院与当日手术合并行：排位跟随转入/入院事件
  '转入、手术': 5, '入院、手术': 4,
};

export function buildShiftRanges(selectedDate: Date): Record<ShiftKey, ShiftRange> {
  const at = (dayOffset: number, hour: number, minute = 0): Date =>
    new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + dayOffset, hour, minute, 0, 0);

  return {
    day: { key: 'day', label: '白班', start: at(0, 8), end: at(0, 18, 1), settlementTime: at(0, 18) },
    evening: { key: 'evening', label: '中班', start: at(0, 18, 1), end: at(1, 0), settlementTime: at(1, 0) },
    night: { key: 'night', label: '夜班', start: at(1, 0), end: at(1, 8), settlementTime: at(1, 8) },
  };
}

function timeValue(value?: string): number {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

function inShift(value: string | undefined, range: ShiftRange): boolean {
  const ts = timeValue(value);
  return Number.isFinite(ts) && ts >= range.start.getTime() && ts < range.end.getTime();
}

function resolveShift(value: string | undefined, ranges: Record<ShiftKey, ShiftRange>): ShiftKey | undefined {
  return SHIFT_KEYS.find(key => inShift(value, ranges[key]));
}

function isInDepartmentAt(patient: DepartmentPatient, settlementTime: Date): boolean {
  const settlement = settlementTime.getTime();
  const admission = patient.icuAdmissionTime ? timeValue(patient.icuAdmissionTime) : Number.NEGATIVE_INFINITY;
  const discharge = patient.icuDischargeTime ? timeValue(patient.icuDischargeTime) : Number.POSITIVE_INFINITY;
  return admission <= settlement && settlement < discharge;
}

function patientId(patient: DepartmentPatient): string {
  return String(patient.id ?? patient._id ?? '').trim();
}

function nurseRecordPid(patient: DepartmentPatient): string {
  return String(patient.nurseRecordPid ?? patient.id ?? patient._id ?? '').trim();
}

function bedNo(patient: DepartmentPatient): string {
  const raw = String(patient.hisBed || patient.bedNo || '').trim();
  return raw.endsWith('床') ? raw : raw ? `${raw}床` : '';
}

function bedNumber(value: string): number {
  const match = value.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}

function diagnosis(patient: DepartmentPatient, selectedDate: Date): string {
  // 与护理记录单一致：按所选日期匹配诊断历史（整日共用），再取第一诊断；
  // 旧逻辑患者透传 legacy 拆分结果
  const legacyText = firstDiagnosisSegment(patient.clinicalDiagnosis || patient.diagnosis, 'legacy');
  return resolveNursingDayDiagnosis(patient, selectedDate, legacyText);
}

function formatChineseDateTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dischargeStatus(dischargedType?: string): '出院' | '转出' | '死亡' | undefined {
  const v = String(dischargedType || '');
  if (v.includes('死亡')) return '死亡';
  if (v.includes('转出') || v.includes('转科')) return '转出';
  if (v.includes('出院')) return '出院';
  return undefined;
}

function admissionStatus(admissionType?: string): '转入' | '入院' | undefined {
  const v = String(admissionType || '');
  if (v.includes('转入')) return '转入';
  if (v.includes('入院')) return '入院';
  return undefined;
}

function defaultEventText(patient: DepartmentPatient, status: HandoverStatus): string {
  switch (status) {
    case '出院': return `患者于${formatChineseDateTime(patient.icuDischargeTime)}出院。`;
    case '转出': return `患者转${patient.dischargedDepartment || '相关科室'}继续治疗。`;
    case '死亡': return `患者于${formatChineseDateTime(patient.icuDischargeTime)}死亡。`;
    default: return '';
  }
}

/**
 * 页面交班书写顺序：白班 → 中班 → 夜班。
 * 转入、入院等患者从事件发生班次开始，允许在当前班次及后续班次插入护理记录。
 */
function editableShiftsFrom(eventShift: ShiftKey): ShiftKey[] {
  const order: ShiftKey[] = ['day', 'evening', 'night'];
  const index = order.indexOf(eventShift);
  return index < 0 ? [] : order.slice(index);
}

function createRow(
  patient: DepartmentPatient,
  status: HandoverStatus,
  eventShift: ShiftKey,
  eventTime: number,
  bedsideRecords: BedsideRecord[],
  ranges: Record<ShiftKey, ShiftRange>,
  selectedDate: Date,
  keyStatus: HandoverStatus = status,
): HandoverPatientRow {
  const id = patientId(patient);
  // 合并状态（如“转入、手术”）按“、”拆分后逐项判断
  const editable = status.split('、').some(s => ['转入', '入院', '病危', '手术'].includes(s));
  const isCritical = status === '病危';

  // 为每个患者计算生命体征和出入量总结
  const nightVitalSigns = extractPatientNightVitalSigns(patient, bedsideRecords, ranges);
  const { summary: nightFluidSummary, hours: fluidHours } = calculatePatientNightFluidSummary(patient, bedsideRecords, ranges, isCritical);

  return {
    // key 可指定为组成事件（转入/入院），兼容合并前已保存的草稿文本
    key: `${keyStatus}:${id}:${eventTime}`,
    patientId: id,
    nurseRecordPid: nurseRecordPid(patient),
    bedNo: bedNo(patient),
    name: patient.name || '',
    mrn: patient.mrn || '',
    diagnosis: diagnosis(patient, selectedDate),
    status,
    eventTime,
    eventShift,
    editableShifts: editable ? editableShiftsFrom(eventShift) : [],
    shiftTexts: { [eventShift]: defaultEventText(patient, status) },
    nightVitalSigns,
    nightFluidSummary,
    fluidHours,
  };
}

function emptyStatistics(): ShiftStatistics {
  return { total: 0, discharged: 0, transferredOut: 0, death: 0, transferredIn: 0, admission: 0, operation: 0, critical: 0, specialCare: 0 };
}

/** 单个患者在本报表日窗口内的事件集合。 */
interface PatientDayEvents {
  out?: { status: '出院' | '转出' | '死亡'; shift: ShiftKey; time: number };
  in?: { status: '转入' | '入院'; shift: ShiftKey; time: number };
  ops: { shift: ShiftKey; time: number }[];
}

/**
 * 收集单个患者的出科/入科/手术事件。
 * 展示行与班次统计共用此函数，保证口径一致。
 */
function collectPatientDayEvents(patient: DepartmentPatient, ranges: Record<ShiftKey, ShiftRange>): PatientDayEvents {
  const events: PatientDayEvents = { ops: [] };

  const outStatus = dischargeStatus(patient.dischargedType);
  const outShift = resolveShift(patient.icuDischargeTime, ranges);
  if (outStatus && outShift) {
    events.out = { status: outStatus, shift: outShift, time: timeValue(patient.icuDischargeTime) };
  }

  const inStatus = admissionStatus(patient.admissionType);
  const inShift = resolveShift(patient.icuAdmissionTime, ranges);
  if (inStatus && inShift) {
    events.in = { status: inStatus, shift: inShift, time: timeValue(patient.icuAdmissionTime) };
  }

  // 同一结束时间的多条手术记录只计一次（展示行与班次统计共用，避免重复成行）
  const seenOpTimes = new Set<number>();
  for (const op of patient.patientOperations || []) {
    if (op.valid === false || !op.endTime) continue;
    const opShift = resolveShift(op.endTime, ranges);
    if (!opShift) continue;
    const opTime = timeValue(op.endTime);
    if (seenOpTimes.has(opTime)) continue;
    seenOpTimes.add(opTime);
    events.ops.push({ shift: opShift, time: opTime });
  }

  return events;
}

function buildPatientRows(snapshot: DepartmentDailySnapshot, ranges: Record<ShiftKey, ShiftRange>, selectedDate: Date): HandoverPatientRow[] {
  const rows: HandoverPatientRow[] = [];

  for (const patient of snapshot.patients) {
    const events = collectPatientDayEvents(patient, ranges);

    if (events.out) {
      rows.push(createRow(patient, events.out.status, events.out.shift, events.out.time, snapshot.bedsideRecords, ranges, selectedDate));
    }

    if (events.in && events.ops.length > 0) {
      // 转入/入院 + 当日手术合并为一条数据，状态展示为“转入、手术”
      const mergedStatus: HandoverStatus = `${events.in.status}、手术`;
      const earliestOp = events.ops.reduce((a, b) => (a.time <= b.time ? a : b));
      const eventShift = SHIFT_KEYS.indexOf(events.in.shift) <= SHIFT_KEYS.indexOf(earliestOp.shift)
        ? events.in.shift
        : earliestOp.shift;
      const row = createRow(
        patient,
        mergedStatus,
        eventShift,
        events.in.time,
        snapshot.bedsideRecords,
        ranges,
        selectedDate,
        events.in.status,
      );
      // 兜底读取合并前“手术:患者ID:时间”键下已保存的交班文本（转入键未覆盖的班次）
      for (const op of events.ops) {
        const opTexts = snapshot.draft.patientTexts[`手术:${patientId(patient)}:${op.time}`];
        if (!opTexts) continue;
        for (const shift of SHIFT_KEYS) {
          if (opTexts[shift] !== undefined) row.shiftTexts[shift] = opTexts[shift];
        }
      }
      rows.push(row);
    } else if (events.in) {
      rows.push(createRow(patient, events.in.status, events.in.shift, events.in.time, snapshot.bedsideRecords, ranges, selectedDate));
    }

    for (const op of events.ops) {
      // 已与入科事件合并的手术不再单独成行
      if (events.in) continue;
      rows.push(createRow(patient, '手术', op.shift, op.time, snapshot.bedsideRecords, ranges, selectedDate));
    }
  }

  for (const selection of snapshot.draft.criticalPatients || []) {
    const patient = snapshot.patients.find(p => patientId(p) === selection.patientId);
    if (!patient) continue;
    const row = createRow(patient, '病危', 'night', ranges.night.settlementTime.getTime(), snapshot.bedsideRecords, ranges, selectedDate);
    row.editableShifts = ['night', 'day', 'evening'];
    row.shiftTexts = {};
    rows.push(row);
  }

  // 从嵌套结构读取患者交班文本
  for (const row of rows) {
    const patientTexts = snapshot.draft.patientTexts[row.key];
    if (!patientTexts) continue;
    for (const shift of SHIFT_KEYS) {
      const override = patientTexts[shift];
      if (override !== undefined) row.shiftTexts[shift] = override;
    }
  }

  return rows.sort((a, b) => {
    const sd = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (sd !== 0) return sd;
    if (a.status === '病危') return bedNumber(a.bedNo) - bedNumber(b.bedNo);
    return a.eventTime - b.eventTime || bedNumber(a.bedNo) - bedNumber(b.bedNo);
  });
}

function buildStatistics(snapshot: DepartmentDailySnapshot, ranges: Record<ShiftKey, ShiftRange>): Record<ShiftKey, ShiftStatistics> {
  const result: Record<ShiftKey, ShiftStatistics> = { night: emptyStatistics(), day: emptyStatistics(), evening: emptyStatistics() };
  for (const shift of SHIFT_KEYS) {
    const s = result[shift];
    s.total = snapshot.patients.filter(p => isInDepartmentAt(p, ranges[shift].settlementTime)).length;
    s.critical = s.total;
    s.specialCare = s.total;
  }
  // 按事件而非展示行统计：合并行（如“转入、手术”）的两个事件仍分别计入各自班次
  for (const patient of snapshot.patients) {
    const events = collectPatientDayEvents(patient, ranges);
    if (events.out) {
      const s = result[events.out.shift];
      switch (events.out.status) {
        case '出院': s.discharged++; break;
        case '转出': s.transferredOut++; break;
        case '死亡': s.death++; break;
      }
    }
    if (events.in) {
      const s = result[events.in.shift];
      if (events.in.status === '转入') s.transferredIn++; else s.admission++;
    }
    for (const op of events.ops) {
      result[op.shift].operation++;
    }
  }
  return result;
}

export function buildHandoverReport(snapshot: DepartmentDailySnapshot, selectedDate: Date): HandoverReportViewModel {
  const ranges = buildShiftRanges(selectedDate);
  const rows = buildPatientRows(snapshot, ranges, selectedDate);
  const statistics = buildStatistics(snapshot, ranges);
  const metrics = buildSafetyMetrics(snapshot, ranges);
  return { ranges, rows, statistics, metrics };
}

/**
 * 为单个患者提取6点整的生命体征数据
 */
function extractPatientNightVitalSigns(
  patient: DepartmentPatient,
  bedsideRecords: BedsideRecord[],
  ranges: Record<ShiftKey, ShiftRange>,
): NightVitalSigns {
  const pid = String(patient.nurseRecordPid ?? patient.id ?? patient._id ?? '').trim();
  if (!pid) {
    console.warn('[HANDOVER] 患者缺少PID:', patient.name, patient);
    return {};
  }

  // 夜班时间范围：使用night shift的时间范围（次日00:00 ~ 08:00）
  const nightStart = new Date(ranges.night.start);
  const nightEnd = new Date(ranges.night.end);

  const vitalSigns: NightVitalSigns = {};

  // 定义需要提取的生命体征代码
  const vitalSignCodes = {
    temperature: 'param_T',
    heartRate: 'param_HR',
    respiration: 'param_resp',
    spO2: 'param_spo2',
    nibpSystolic: 'param_nibp_s',
    nibpDiastolic: 'param_nibp_d',
    ibpSystolic: 'param_ibp_s',
    ibpDiastolic: 'param_ibp_d',
    cvp: 'param_cvp',
  };

  // 过滤该患者在夜班时间范围内的记录（次日00:00 ~ 08:00）
  const patientRecords = bedsideRecords.filter(record => {
    if (record.valid === false) return false;
    if (record.pid !== pid) return false;
    const recordTime = new Date(record.time).getTime();
    return recordTime >= nightStart.getTime() && recordTime < nightEnd.getTime();
  });

  // 调试：输出匹配的记录
  console.info('[HANDOVER][vital-signs]', {
    patientName: patient.name,
    pid,
    nightStart: nightStart.toISOString(),
    nightEnd: nightEnd.toISOString(),
    totalBedsideRecords: bedsideRecords.length,
    matchedRecords: patientRecords.length,
  });

  // 查找6点整（06:00:00 - 06:00:59）的记录
  const sixOClockRecords = patientRecords.filter(record => {
    const recordDate = new Date(record.time);
    return recordDate.getHours() === 6;
  });

  // 调试：输出6点的记录
  console.info('[HANDOVER][vital-signs-6am]', {
    patientName: patient.name,
    sixOClockRecords: sixOClockRecords.length,
    records: sixOClockRecords.map(r => ({ code: r.code, strVal: r.strVal, time: r.time })),
    allCodes: [...new Set(sixOClockRecords.map(r => r.code))],
  });

  // 提取各生命体征数据
  for (const field in vitalSignCodes) {
    const code = vitalSignCodes[field as keyof typeof vitalSignCodes];
    const record = sixOClockRecords.find(r => r.code === code);
    if (record && record.strVal !== undefined && record.strVal !== '') {
      (vitalSigns as any)[field] = String(record.strVal);
    }
  }

  // 调试：输出提取结果
  console.info('[HANDOVER][vital-signs-result]', {
    patientName: patient.name,
    vitalSigns,
    hasData: Object.values(vitalSigns).some(v => v !== undefined && v !== ''),
  });

  return vitalSigns;
}

/**
 * 为单个患者计算出入量总结
 * 普通患者：当天08:00 ~ 次日08:00（24小时，8-8左闭右开）
 * 入院患者：入科时间 ~ 次日08:00（不足24小时）
 * 病危患者：当天08:00 ~ 次日08:00（24小时）
 */
function calculatePatientNightFluidSummary(
  patient: DepartmentPatient,
  bedsideRecords: BedsideRecord[],
  ranges: Record<ShiftKey, ShiftRange>,
  isCritical: boolean = false,
): { summary: NightFluidSummary; hours: number } {
  const pid = String(patient.nurseRecordPid ?? patient.id ?? patient._id ?? '').trim();
  if (!pid) {
    return { summary: { totalInput: 0, medicationInput: 0, gastrointestinalInput: 0, totalOutput: 0, urineOutput: 0, ultrafiltrationOutput: 0, drainageOutput: 0, drainageItems: [], excretionOutput: 0, excretionItems: [], balance: 0 }, hours: 0 };
  }

  // 出入量统计时间范围：当天07:00 ~ 次日07:00（北京时间）
  // 入科患者：入科时间 ~ 次日07:00（不足24小时，起点取入科时间和当天07:00的较晚者）
  const baseDate = ranges.day.start;
  const day7am = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 7, 0, 0, 0); // 当天07:00
  const nextDay7am = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + 1, 7, 0, 0, 0); // 次日07:00

  // 确定实际起点
  let actualStart = day7am;
  if (!isCritical && patient.icuAdmissionTime) {
    const admTime = new Date(patient.icuAdmissionTime);
    if (!isNaN(admTime.getTime()) && admTime.getTime() > day7am.getTime()) {
      // 入科时间在当天07:00之后，使用入科时间作为起点
      actualStart = admTime;
    }
    // 入科时间在当天07:00之前，使用当天00:00作为起点
    else if (!isNaN(admTime.getTime()) && admTime.getTime() < day7am.getTime()) {
      actualStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0, 0, 0, 0);
    }
  }

  // 计算小时数（满30分钟进1，不满舍去）
  const rawHours = (nextDay7am.getTime() - actualStart.getTime()) / (1000 * 60 * 60);
  const hours = Math.round(rawHours);

  // 过滤起点：向下取整到整点，确保包含入科小时的床旁记录（床旁数据按整点采集）
  const filterStart = new Date(actualStart.getFullYear(), actualStart.getMonth(), actualStart.getDate(), actualStart.getHours(), 0, 0, 0);

  // 该患者在时间范围内的床旁记录
  const patientBedsideRecords = bedsideRecords.filter(record => {
    if (record.valid === false) return false;
    if (record.pid !== pid) return false;
    const recordTime = new Date(record.time).getTime();
    return recordTime >= filterStart.getTime() && recordTime < nextDay7am.getTime();
  });

  // 调试：输出匹配的记录
  console.info('[HANDOVER][fluid-summary]', {
    patientName: patient.name,
    pid,
    actualStart: actualStart.toISOString(),
    nextDay7am: nextDay7am.toISOString(),
    hours,
    isCritical,
    matchedRecords: patientBedsideRecords.length,
  });

  // 入量统计（与hljldFormPDFNew一致）
  // 药物治疗：param_YaoYeti_in_hour
  let medicationInput = 0;
  for (const record of patientBedsideRecords) {
    if (record.code === 'param_YaoYeti_in_hour') {
      medicationInput += parseAmount(record.strVal);
    }
  }

  // 胃肠摄入：param_YaoStomach_in_hour + param_kouFu(口服) + param_biSi(鼻饲)
  let stomachPump = 0;
  let oralTotal = 0;
  let tubeFeedingManual = 0;
  for (const record of patientBedsideRecords) {
    if (record.code === 'param_YaoStomach_in_hour') {
      stomachPump += parseAmount(record.strVal);
    } else if (record.code === 'param_kouFu') {
      oralTotal += parseAmount(record.strVal);
    } else if (record.code === 'param_biSi') {
      tubeFeedingManual += parseAmount(record.strVal);
    }
  }
  const gastrointestinalInput = stomachPump + oralTotal + tubeFeedingManual;

  // 总入量 = 药物治疗 + 胃肠摄入（param_带入药量不计入总入量）
  const totalInput = medicationInput + gastrointestinalInput;

  // 出量统计（与hljldFormPDFNew一致）
  // 尿量
  let urineOutput = 0;
  for (const record of patientBedsideRecords) {
    if (record.code === 'param_niaoLiang') {
      urineOutput += parseAmount(record.strVal);
    }
  }

  // 净超滤量
  let ultrafiltrationOutput = 0;
  for (const record of patientBedsideRecords) {
    if (record.code === 'param_chaoLvLiang') {
      ultrafiltrationOutput += parseAmount(record.strVal);
    }
  }

  // 引流液（code含"引流" 或 param_tube_胃肠减压）- 按名称汇总明细
  let drainageOutput = 0;
  const drainageItemMap = new Map<string, number>();
  const drainageNameMap: Record<string, string> = {
    'param_tube_胃肠减压': '胃管负压引流量',
  };
  for (const record of patientBedsideRecords) {
    const code = record.code || '';
    if (code.includes('引流') || code === 'param_tube_胃肠减压') {
      const amt = parseAmount(record.strVal);
      drainageOutput += amt;
      const name = drainageNameMap[code] || code.replace('param_', '').replace('引流', '引流液');
      drainageItemMap.set(name, (drainageItemMap.get(name) || 0) + amt);
    }
  }
  const drainageItems = Array.from(drainageItemMap.entries()).map(([name, amount]) => ({ name, amount }));

  // 排出物 - 按名称汇总明细
  const excretionDefs: Record<string, string> = {
    'param_daBianAmount': '大便量',
    'param_outuwuliang': '呕吐物量',
    'param_tanLiang': '痰液量',
    'param_造瘘口量': '造瘘口量',
    'param_咯血': '咯血',
  };
  let excretionOutput = 0;
  const excretionItemMap = new Map<string, number>();
  for (const record of patientBedsideRecords) {
    const label = excretionDefs[record.code];
    if (label) {
      const amt = parseAmount(record.strVal);
      excretionOutput += amt;
      excretionItemMap.set(label, (excretionItemMap.get(label) || 0) + amt);
    }
  }
  const excretionItems = Array.from(excretionItemMap.entries()).map(([name, amount]) => ({ name, amount }));

  const totalOutput = urineOutput + ultrafiltrationOutput + drainageOutput + excretionOutput;
  const balance = totalInput - totalOutput;

  return {
    summary: {
      totalInput,
      medicationInput,
      gastrointestinalInput,
      totalOutput,
      urineOutput,
      ultrafiltrationOutput,
      drainageOutput,
      drainageItems,
      excretionOutput,
      excretionItems,
      balance,
    },
    hours,
  };
}

/**
 * 解析数量值
 */
function parseAmount(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value !== 'string') {
    return 0;
  }
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

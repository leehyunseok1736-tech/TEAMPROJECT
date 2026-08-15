const UNKNOWN = '확인 필요';

const text = value => String(value ?? '').trim();

export function normalizeUnitText(value) {
  return text(value)
    .replace(/㎎|ｍｇ/gi, 'mg')
    .replace(/[㎖]/g, 'mL')
    .replace(/[㎍]/g, 'mcg')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseFrequencyPerDay(value) {
  const source = normalizeUnitText(value).replace(/일일/g, '1일');
  const explicit = source.match(/(?:1일|하루)\s*(\d+(?:\.\d+)?)\s*회/)
    || source.match(/(\d+(?:\.\d+)?)\s*회/);
  const direct = source.match(/^\s*(\d+(?:\.\d+)?)\s*(?:회)?\s*$/);
  const number = Number(explicit?.[1] ?? direct?.[1]);
  return Number.isFinite(number) && number > 0 && number <= 12 ? number : null;
}

export function parseAmountPerDose(value) {
  const source = normalizeUnitText(value);
  const match = source.match(/(\d+(?:\.\d+)?)\s*(정|알|캡슐|포|봉|mL|ml|cc|스푼)(?:씩)?/i);
  if (!match) return '';
  const unit = /^(?:ml)$/i.test(match[2]) ? 'mL' : match[2];
  return `${Number(match[1])}${unit}`;
}

export function parseDurationDays(value) {
  const source = normalizeUnitText(value);
  const explicit = [...source.matchAll(/(\d+)\s*일분/g)];
  const general = [...source.matchAll(/(\d+)\s*일(?!\s*\d+(?:\.\d+)?\s*회)/g)];
  const match = explicit.at(-1) || general.at(-1);
  const days = Number(match?.[1]);
  return Number.isInteger(days) && days > 0 ? days : null;
}

export function normalizeDoseSlots(...values) {
  const source = values.flat().filter(Boolean).join(' ').replace(/\s+/g, '');
  const slots = [];
  const add = slot => { if (!slots.includes(slot)) slots.push(slot); };
  if (/매식|아침.*점심.*저녁|조.*중.*석/.test(source)) {
    add('아침'); add('점심'); add('저녁');
  } else {
    if (source.includes('아침') || source.includes('조식')) add('아침');
    if (source.includes('점심') || source.includes('중식')) add('점심');
    if (source.includes('저녁') || source.includes('석식')) add('저녁');
  }
  if (/취침전|자기전|잠들기전/.test(source)) add('취침 전');
  return slots;
}

export function mealTimingOffsetMinutes(value) {
  const source = normalizeUnitText(value).replace(/\s+/g, '');
  if (/식사와함께|식사중|식후즉시|식사직후|직후/.test(source)) return 0;
  const before = source.match(/식전(\d+)분/);
  if (before) return -Number(before[1]);
  if (source.includes('식전') || source.includes('공복')) return -30;
  const afterMinutes = source.match(/식후(\d+)분/);
  if (afterMinutes) return Number(afterMinutes[1]);
  const afterHours = source.match(/식후(\d+(?:\.\d+)?)시간/);
  if (afterHours) return Math.round(Number(afterHours[1]) * 60);
  if (source.includes('식후')) return 30;
  return 0;
}

export function normalizeMedicineNameKey(value) {
  return normalizeUnitText(value)
    .toLowerCase()
    .replace(/(\d+(?:\.\d+)?)\s*mg\b/g, '$1밀리그램')
    .replace(/[^0-9a-z가-힣]/g, '');
}

export function medicineNameVariants(value) {
  const original = normalizeUnitText(value);
  if (!original || original === UNKNOWN) return [];
  const compact = original.replace(/\s+/g, '');
  const koreanUnit = compact.replace(/(\d+(?:\.\d+)?)mg(?=$|[^a-z])/gi, '$1밀리그램');
  const withoutParentheses = koreanUnit.replace(/\([^)]*\).*$/, '');
  const baseName = withoutParentheses
    .replace(/\d+(?:\.\d+)?(?:밀리그램|mg|mcg|g|mL|ml).*$/i, '')
    .replace(/(?:장용|서방|필름코팅)?(?:정|캡슐|연질캡슐|시럽|액|산|과립|크림|연고)$/u, '');
  const prefixes = [8, 6, 4, 3]
    .filter(length => baseName.length > length)
    .map(length => baseName.slice(0, length));
  return [...new Set([original, koreanUnit, withoutParentheses, baseName, ...prefixes].map(text).filter(value => value.length >= 3))];
}

function bigrams(value) {
  if (value.length < 2) return [value];
  return Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
}

function diceSimilarity(left, right) {
  const leftParts = bigrams(left);
  const counts = new Map();
  bigrams(right).forEach(part => counts.set(part, (counts.get(part) || 0) + 1));
  let overlap = 0;
  leftParts.forEach(part => {
    const count = counts.get(part) || 0;
    if (!count) return;
    overlap += 1;
    counts.set(part, count - 1);
  });
  return (2 * overlap) / (leftParts.length + bigrams(right).length || 1);
}

export function medicineNameSimilarityScore(query, productName) {
  const queryKey = normalizeMedicineNameKey(query);
  const productKey = normalizeMedicineNameKey(productName);
  if (!queryKey || !productKey) return 0;
  if (queryKey === productKey) return 100;
  if (productKey.startsWith(queryKey) || queryKey.startsWith(productKey)) return 90;
  if (productKey.includes(queryKey) || queryKey.includes(productKey)) return 82;
  const similarity = diceSimilarity(queryKey, productKey);
  if (similarity >= 0.9) return 88;
  if (similarity >= 0.78) return 76;
  if (similarity >= 0.68 && Math.min(queryKey.length, productKey.length) >= 6) return 65;
  return 0;
}

export function normalizeExtractedMedicine(medicine = {}) {
  const combinedDirection = [
    medicine.amount_per_dose,
    medicine.frequency_per_day,
    medicine.meal_timing,
    medicine.duration,
    medicine.raw_direction,
  ].filter(Boolean).join(' ');
  const doseSlots = normalizeDoseSlots(medicine.dose_slots, medicine.meal_timing, medicine.frequency_per_day, medicine.raw_direction);
  const frequencyCount = parseFrequencyPerDay(medicine.frequency_per_day)
    ?? parseFrequencyPerDay(medicine.raw_direction)
    ?? (doseSlots.length || null);
  const amount = parseAmountPerDose(medicine.amount_per_dose)
    || parseAmountPerDose(combinedDirection)
    || normalizeUnitText(medicine.amount_per_dose)
    || UNKNOWN;
  const durationDays = parseDurationDays(medicine.duration)
    ?? parseDurationDays(medicine.raw_direction)
    ?? parseDurationDays(combinedDirection);
  const explicitTimes = Array.isArray(medicine.times)
    ? medicine.times.map(text).filter(value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    : [];

  return {
    ...medicine,
    name: normalizeUnitText(medicine.name) || UNKNOWN,
    item_code: text(medicine.item_code) || UNKNOWN,
    manufacturer: normalizeUnitText(medicine.manufacturer) || UNKNOWN,
    dosage_form: normalizeUnitText(medicine.dosage_form) || UNKNOWN,
    imprint: normalizeUnitText(medicine.imprint) || UNKNOWN,
    amount_per_dose: amount,
    frequency_per_day: frequencyCount ? `${frequencyCount}회` : UNKNOWN,
    frequency_count: frequencyCount,
    dose_slots: doseSlots,
    times: explicitTimes,
    meal_timing: normalizeUnitText(medicine.meal_timing) || UNKNOWN,
    meal_offset_minutes: mealTimingOffsetMinutes(medicine.meal_timing),
    duration: durationDays ? `${durationDays}일` : normalizeUnitText(medicine.duration) || UNKNOWN,
    duration_days: durationDays,
    raw_direction: normalizeUnitText(medicine.raw_direction),
  };
}

const validTime = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value));
const toMinutes = value => {
  const [hour, minute] = String(value).split(':').map(Number);
  return hour * 60 + minute;
};
const toTime = minutes => {
  const safe = (minutes + 1440) % 1440;
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
};

export function suggestDoseTimes(medicine = {}, profile = {}) {
  const explicit = Array.isArray(medicine.times) ? medicine.times.map(text).filter(validTime) : [];
  if (explicit.length) return { times: explicit, source: '처방전 표기 시간' };

  const slotTimes = {
    '아침': profile.breakfastTime,
    '점심': profile.lunchTime,
    '저녁': profile.dinnerTime,
    '취침 전': profile.bedtimeTime,
  };
  const slots = Array.isArray(medicine.dose_slots)
    ? medicine.dose_slots.filter(slot => validTime(slotTimes[slot]))
    : [];
  const frequencyCount = Number(medicine.frequency_count) || parseFrequencyPerDay(medicine.frequency_per_day);
  let selectedSlots = slots;
  if (!selectedSlots.length && frequencyCount > 0 && frequencyCount <= 3) {
    selectedSlots = frequencyCount === 1 ? ['아침'] : frequencyCount === 2 ? ['아침', '저녁'] : ['아침', '점심', '저녁'];
  }
  if (!selectedSlots.length) return { times: [], source: '시간 확인 필요' };

  const parsedOffset = Number(medicine.meal_offset_minutes);
  const offset = Number.isFinite(parsedOffset) ? parsedOffset : mealTimingOffsetMinutes(medicine.meal_timing);
  const times = selectedSlots
    .map(slot => slot === '취침 전' ? slotTimes[slot] : toTime(toMinutes(slotTimes[slot]) + offset))
    .filter(validTime);
  const timing = text(medicine.meal_timing);
  const offsetLabel = offset < 0 ? `${Math.abs(offset)}분 전` : offset > 0 ? `${offset}분 후` : '기준 시각';
  return {
    times,
    source: `${slots.length ? '사진 표기 복용 시점' : '하루 복용 횟수'} + 기본 시간 ${offsetLabel} 자동 제안—${timing && timing !== UNKNOWN ? `${timing} 확인` : '확인 필요'}`,
  };
}

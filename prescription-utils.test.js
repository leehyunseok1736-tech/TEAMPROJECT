import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mealTimingOffsetMinutes,
  medicineNameSimilarityScore,
  medicineNameVariants,
  normalizeDoseSlots,
  normalizeExtractedMedicine,
  normalizeUnitText,
  parseAmountPerDose,
  parseDurationDays,
  parseFrequencyPerDay,
  suggestDoseTimes,
} from '../prescription-utils.js';

test('복합 복약문에서 투약량·횟수·일수를 서로 분리한다', () => {
  const normalized = normalizeExtractedMedicine({
    name: '동화록소닌정',
    amount_per_dose: '1정씩 2회 5일분',
    frequency_per_day: '1정씩 2회 5일분',
    duration: '1정씩 2회 5일분',
    raw_direction: '1정씩 2회 5일분',
  });
  assert.equal(normalized.amount_per_dose, '1정');
  assert.equal(normalized.frequency_count, 2);
  assert.equal(normalized.frequency_per_day, '2회');
  assert.equal(normalized.duration_days, 5);
  assert.equal(normalized.duration, '5일');
});

test('0.5정과 1포도 1회량으로 보존한다', () => {
  assert.equal(parseAmountPerDose('0.5정씩 2회 4일분'), '0.5정');
  assert.equal(parseAmountPerDose('1포씩 2회 4일분'), '1포');
});

test('1일이라는 표현을 복용 기간 1일로 오인하지 않는다', () => {
  assert.equal(parseFrequencyPerDay('1일 3회, 5일분'), 3);
  assert.equal(parseDurationDays('1일 3회, 5일분'), 5);
});

test('아침·점심·저녁과 취침 전 표기를 복용 시점으로 읽는다', () => {
  assert.deepEqual(normalizeDoseSlots('아침점심저녁식후복용'), ['아침', '점심', '저녁']);
  assert.deepEqual(normalizeDoseSlots('취침전 복용'), ['취침 전']);
});

test('식사 기준별 시간 오프셋을 구분한다', () => {
  assert.equal(mealTimingOffsetMinutes('아침 식전 30분 복용'), -30);
  assert.equal(mealTimingOffsetMinutes('식후 즉시'), 0);
  assert.equal(mealTimingOffsetMinutes('식사 직후'), 0);
  assert.equal(mealTimingOffsetMinutes('식사와 함께'), 0);
  assert.equal(mealTimingOffsetMinutes('식후 30분'), 30);
  assert.equal(mealTimingOffsetMinutes('식후 1시간'), 60);
});

test('유니코드 의약품 단위를 API 검색용 표기로 정규화한다', () => {
  assert.equal(normalizeUnitText('베아리온정10㎎'), '베아리온정10mg');
  assert.ok(medicineNameVariants('베아리온정10㎎').includes('베아리온정10밀리그램'));
});

test('잘린 약명과 한두 글자 OCR 오타도 후보 점수를 얻는다', () => {
  assert.ok(medicineNameVariants('아나프록스정').includes('아나프'));
  assert.ok(medicineNameSimilarityScore('세타펜8시간이알서', '세타펜8시간이알서방정') >= 82);
  assert.ok(medicineNameSimilarityScore('명인아미트립틸린염산염정10mg', '명인아미트리프틸린염산염정10mg') >= 65);
  assert.ok(medicineNameSimilarityScore('아나프록스정', '아나프로록스정') >= 65);
});

test('명시되지 않은 시각과 값은 확인 필요로 남긴다', () => {
  const normalized = normalizeExtractedMedicine({ name: '씬지로이드정0.075㎎', times: ['아침', '25:00'] });
  assert.equal(normalized.amount_per_dose, '확인 필요');
  assert.equal(normalized.frequency_per_day, '확인 필요');
  assert.deepEqual(normalized.times, []);
});

test('실사진 복약 횟수와 식사 기준을 기본 시간에 정확히 반영한다', () => {
  const profile = { breakfastTime: '08:00', lunchTime: '13:00', dinnerTime: '19:00', bedtimeTime: '22:00' };
  assert.deepEqual(suggestDoseTimes({ frequency_count: 2, meal_timing: '식후 30분', meal_offset_minutes: 30 }, profile).times, ['08:30', '19:30']);
  assert.deepEqual(suggestDoseTimes({ dose_slots: ['아침', '점심', '저녁'], meal_timing: '식전 30분', meal_offset_minutes: -30 }, profile).times, ['07:30', '12:30', '18:30']);
  assert.deepEqual(suggestDoseTimes({ dose_slots: ['취침 전'], meal_timing: '취침 전', meal_offset_minutes: 0 }, profile).times, ['22:00']);
});

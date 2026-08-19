import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';
import { readFileSync } from 'node:fs';
import {
  medicineNameSimilarityScore,
  medicineNameVariants,
  normalizeExtractedMedicine,
} from './prescription-utils.js';

const app = express();
const port = process.env.PORT || 3000;
const indexHtml = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const supabaseBrowserJs = readFileSync(new URL('./node_modules/@supabase/supabase-js/dist/umd/supabase.js', import.meta.url), 'utf8');
const MFDS_BASE_URL = process.env.MFDS_BASE_URL || 'https://apis.data.go.kr/1471000';
const MFDS_PATHS = {
  product: process.env.MFDS_PRODUCT_PATH || '/DrugPrdtPrmsnInfoService07/getDrugPrdtPrmsnInq07',
  durProduct: process.env.MFDS_DUR_PRODUCT_PATH || '/DURPrdlstInfoService03/getDurPrdlstInfoList03',
  interaction: process.env.MFDS_DUR_INTERACTION_PATH || '/DURPrdlstInfoService03/getUsjntTabooInfoList03',
  efficacyDuplicate: process.env.MFDS_DUR_DUPLICATE_PATH || '/DURPrdlstInfoService03/getEfcyDplctInfoList03',
  elderly: process.env.MFDS_DUR_ELDERLY_PATH || '/DURPrdlstInfoService03/getOdsnAtentInfoList03'
};

const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 5, fileSize: 10 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => callback(null, allowedTypes.has(file.mimetype))
});

const prescriptionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['medicines'],
  properties: {
    medicines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'item_code', 'manufacturer', 'dosage_form', 'imprint', 'amount_per_dose', 'frequency_per_day', 'dose_slots', 'times', 'meal_timing', 'duration', 'raw_direction'],
        properties: {
          name: { type: 'string' },
          item_code: { type: 'string' },
          manufacturer: { type: 'string' },
          dosage_form: { type: 'string' },
          imprint: { type: 'string' },
          amount_per_dose: { type: 'string' },
          frequency_per_day: { type: 'string' },
          dose_slots: { type: 'array', items: { type: 'string' } },
          times: { type: 'array', items: { type: 'string' } },
          meal_timing: { type: 'string' },
          duration: { type: 'string' },
          raw_direction: { type: 'string' }
        }
      }
    }
  }
};

const extractionPrompt = `You are performing high-precision OCR and table reconstruction only, not medical advice.

Read every supplied Korean prescription or medicine-bag image independently, then return every visible medicine row exactly once and in visual order. Before extracting values, identify the row boundaries and column headers. Keep values aligned to the same horizontal medicine row even when the paper is tilted, wrinkled, cropped, or photographed at an angle.

Field rules:
- name: transcribe the complete printed product name, including strength such as 10mg/10㎎. Do not silently correct an uncertain character.
- amount_per_dose: only the per-administration amount under 투약량/1회량 or text such as "1정씩", "0.5정씩", "1포씩". Do not use frequency, days, total quantity, or strength.
- frequency_per_day: only the daily count under 횟수 or text such as "1일 2회"/"2회". In "1정씩 2회 5일분", amount=1정, frequency=2회, duration=5일. Never treat the first digit or the duration as frequency.
- duration: only 일수/일분/처방 기간. Do not treat duration as a daily count.
- dose_slots: include only visibly printed or clearly checked dose periods among "아침", "점심", "저녁", "취침 전". For "아침점심저녁식후복용", return all three meal slots.
- meal_timing: preserve visible directions such as 식전 30분, 식후 30분, 식후 즉시, 식사 직후, 식사와 함께, 식후 1시간, 취침 전, 필요시. A common instruction may be applied to rows only when the layout clearly shows it applies to the entire prescription.
- times: return only explicit HH:MM clock times. Never convert meal-based directions into clock times.
- dosage_form and imprint: read only when visible; otherwise "확인 필요".
- raw_direction: copy the complete visible direction text associated with the row so deterministic post-processing can audit amount/frequency/duration separation.
- item_code means the Korean MFDS item sequence/품목기준코드 only when visibly printed.

For every unreadable, ambiguous, or absent scalar field, return exactly "확인 필요"; for an absent array return []. Do not infer a medicine or direction from its indication or pill appearance. Return Korean text conforming exactly to the supplied JSON schema.`;

const cache = new Map();
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const text = value => String(value ?? '').trim();
const stripHtml = value => text(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim();
const normalized = value => stripHtml(value)
  .toLowerCase()
  .replace(/㎎|ｍｇ/g, 'mg')
  .replace(/(\d+(?:\.\d+)?)\s*mg\b/g, '$1밀리그램')
  .replace(/[^0-9a-z가-힣]/g, '');
const keyName = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');

function pick(record, ...names) {
  if (!record || typeof record !== 'object') return '';
  const wanted = new Set(names.map(keyName));
  const entry = Object.entries(record).find(([key]) => wanted.has(keyName(key)));
  return entry ? stripHtml(entry[1]) : '';
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function responseItems(payload) {
  const body = payload?.response?.body ?? payload?.body ?? payload;
  const items = body?.items?.item ?? body?.items ?? payload?.items?.item ?? payload?.items;
  if (Array.isArray(items)) return items;
  if (items && typeof items === 'object' && !('item' in items)) return [items];
  return asArray(items?.item);
}

function mfdsKey() {
  const raw = text(process.env.MFDS_API_KEY);
  if (!raw) return '';
  try { return raw.includes('%') ? decodeURIComponent(raw) : raw; } catch { return raw; }
}

async function cached(key, producer, ttl = 15 * 60 * 1000) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await producer();
  cache.set(key, { value, expires: Date.now() + ttl });
  return value;
}

async function fetchMfds(path, params = {}) {
  const apiKey = mfdsKey();
  if (!apiKey) throw new Error('MFDS_API_KEY가 설정되지 않았습니다.');
  const url = new URL(MFDS_BASE_URL.replace(/\/$/, '') + path);
  url.searchParams.set('serviceKey', apiKey);
  url.searchParams.set('pageNo', '1');
  url.searchParams.set('numOfRows', '100');
  url.searchParams.set('type', 'json');
  Object.entries(params).forEach(([key, value]) => {
    if (text(value) && text(value) !== '확인 필요') url.searchParams.set(key, text(value));
  });

  const cacheKey = url.toString().replace(apiKey, '[key]');
  return cached(cacheKey, async () => {
    const result = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    const raw = await result.text();
    if (!result.ok) throw new Error(`식약처 API HTTP ${result.status}`);
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error('식약처 API가 JSON이 아닌 응답을 보냈습니다. 활용신청과 API 경로를 확인하세요.'); }
    const header = payload?.response?.header ?? payload?.header;
    const code = text(header?.resultCode);
    if (code && !['00', '0', 'NORMAL_CODE'].includes(code)) throw new Error(`식약처 API 오류 ${code}: ${text(header?.resultMsg)}`);
    return responseItems(payload);
  });
}

const ignoredIngredientWords = new Set([
  '밀리그램', '그램', '마이크로그램', '밀리리터', '리터', '퍼센트',
  'mg', 'g', 'mcg', 'μg', 'ml', 'l', '정', '캡슐', '단위', '분량',
  '총량', '규격', '비고', '성분정보'
].map(normalized));

function cleanIngredientName(value) {
  return stripHtml(value)
    .replace(/^(?:성분명|주성분명|원료성분명|원료명)\s*[:：]\s*/i, '')
    .trim();
}

function isRealIngredientName(value) {
  const name = cleanIngredientName(value);
  const key = normalized(name);
  if (!key || key.length < 2 || ignoredIngredientWords.has(key)) return false;
  if (/^(?:총량|분량|단위|규격|비고|성분정보)\s*[:：]/i.test(name)) return false;
  if (/^\d+(?:\.\d+)?(?:밀리그램|그램|마이크로그램|밀리리터|리터|퍼센트|mg|g|mcg|μg|ml|l|%)$/i.test(name.replace(/\s+/g, ''))) return false;
  return true;
}

function ingredientParts(record) {
  const names = pick(record, 'MAIN_ITEM_INGR', 'INGR_NAME', 'INGREDIENT', 'INGR_KOR_NAME', 'MATERIAL_NAME');
  const codes = pick(record, 'INGR_CODE', 'INGREDIENT_CODE', 'MAIN_INGR_CODE');
  const labeledNames = [...names.matchAll(/(?:성분명|주성분명|원료성분명)\s*[:：]\s*([^|;\r\n]+)/gi)]
    .map(match => cleanIngredientName(match[1]))
    .filter(isRealIngredientName);
  const nameList = (labeledNames.length
    ? labeledNames
    : names.split(/\r?\n|[;|]|\+(?=[^\d])|,(?=[^\d])/).map(cleanIngredientName).filter(isRealIngredientName));
  const codeList = codes.split(/[,;\s]+/).map(text).filter(Boolean);
  const length = Math.max(nameList.length, codeList.length);
  return Array.from({ length }, (_, index) => ({ name: nameList[index] || '', code: codeList[index] || '' }))
    .filter(part => part.name || part.code);
}

function normalizeProduct(record) {
  return {
    itemSeq: pick(record, 'ITEM_SEQ', 'PRDLST_SN'),
    name: pick(record, 'ITEM_NAME', 'PRDLST_NM'),
    manufacturer: pick(record, 'ENTP_NAME', 'BSSH_NM'),
    ingredients: ingredientParts(record)
  };
}

function productScore(query, product) {
  return medicineNameSimilarityScore(query, product.name);
}

function mergeProducts(...groups) {
  const merged = new Map();
  groups.flat().forEach(record => {
    const product = normalizeProduct(record);
    if (!product.name) return;
    const id = product.itemSeq || normalized(product.name);
    const previous = merged.get(id);
    if (!previous) return merged.set(id, product);
    previous.manufacturer ||= product.manufacturer;
    const ingredientMap = new Map([...previous.ingredients, ...product.ingredients].map(item => [item.code || normalized(item.name), item]));
    previous.ingredients = [...ingredientMap.values()];
  });
  return [...merged.values()];
}

async function searchProducts(name, itemCode = '') {
  const queryName = text(name) === '확인 필요' ? '' : text(name);
  const queryCode = text(itemCode) === '확인 필요' ? '' : text(itemCode);
  if (!queryName && !queryCode) return [];
  const variants = medicineNameVariants(queryName);
  const groups = [];

  for (const variant of variants.length ? variants : ['']) {
    const results = await Promise.all([
      fetchMfds(MFDS_PATHS.product, { item_name: variant, prdlst_Stdr_code: queryCode }).catch(() => []),
      fetchMfds(MFDS_PATHS.durProduct, { itemName: variant, itemSeq: queryCode }).catch(() => [])
    ]);
    groups.push(...results);
    if (mergeProducts(...groups).length) break;
  }

  const products = mergeProducts(...groups);
  return products.map(product => ({
    ...product,
    score: queryCode && product.itemSeq === queryCode
      ? 110
      : Math.max(0, ...variants.map(variant => productScore(variant, product)))
  }))
    .filter(product => product.score > 0 || (queryCode && product.itemSeq === queryCode))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

async function enrichMedicine(medicine) {
  const matches = await searchProducts(medicine.name, medicine.item_code);
  const exact = matches.find(match => match.score >= 100);
  return {
    ...medicine,
    matches,
    matched_product: exact || null,
    confirmation_required: !exact,
    verification_message: exact
      ? '식약처 품목명과 정확히 일치했습니다.'
      : matches.length
        ? '비슷한 품목을 찾았습니다. 실제 약 봉투와 비교해 선택하세요.'
        : '식약처 품목을 자동으로 확인하지 못했습니다. 약사에게 제품명을 확인하세요.'
  };
}

async function generateWithRetry(ai, request) {
  const delays = [0, 1000, 2500];
  let lastError;
  for (const delay of delays) {
    if (delay) await wait(delay);
    try { return await ai.models.generateContent(request); }
    catch (error) {
      lastError = error;
      const status = Number(error?.status || error?.statusCode);
      if (![429, 500, 503].includes(status)) throw error;
    }
  }
  throw lastError;
}

const ingredientKey = ingredient => {
  if (ingredient.code) return `code:${normalized(ingredient.code)}`;
  if (!isRealIngredientName(ingredient.name)) return '';
  const withoutDose = cleanIngredientName(ingredient.name)
    .replace(/\d+(?:\.\d+)?\s*(?:mg|mcg|μg|g|ml|%|밀리그램|그램|마이크로그램|밀리리터|리터|퍼센트|정|캡슐)/gi, ' ');
  const key = normalized(withoutDose);
  if (!key || ignoredIngredientWords.has(key)) return '';
  return `name:${key}`;
};

function duplicateIngredientWarnings(medicines) {
  const warnings = [];
  for (let i = 0; i < medicines.length; i += 1) {
    for (let j = i + 1; j < medicines.length; j += 1) {
      const left = medicines[i], right = medicines[j];
      if (!left.product || !right.product) continue;
      const rightKeys = new Set(right.product.ingredients.map(ingredientKey).filter(key => key.length > 6));
      const duplicates = left.product.ingredients.filter(ingredient => rightKeys.has(ingredientKey(ingredient)));
      if (!duplicates.length) continue;
      warnings.push({
        type: 'duplicate_ingredient', severity: 'danger', medicines: [left.name, right.name],
        title: '동일 성분 중복 가능성',
        message: `${left.name}과(와) ${right.name}에 ${duplicates.map(item => item.name || item.code).join(', ')} 성분이 함께 확인됩니다.`,
        action: '임의로 한 약을 빼거나 시간을 바꾸지 말고, 복용 전에 처방한 의료기관 또는 약사에게 확인하세요.'
      });
    }
  }
  return warnings;
}

function targetMatchesRow(row, medicine) {
  const targets = [medicine.product?.itemSeq, medicine.product?.name, medicine.name,
    ...(medicine.product?.ingredients || []).flatMap(item => [item.code, item.name])]
    .map(normalized).filter(value => value.length >= 4);
  const candidate = [
    pick(row, 'MIXTURE_ITEM_SEQ', 'ITEM_SEQ_2', 'ITEM_SEQ2'),
    pick(row, 'MIXTURE_ITEM_NAME', 'ITEM_NAME_2', 'ITEM_NAME2'),
    pick(row, 'MIXTURE_INGR_CODE', 'INGR_CODE_2', 'INGR_CODE2'),
    pick(row, 'MIXTURE_INGR_KOR_NAME', 'INGR_NAME_2', 'INGR_NAME2')
  ].map(normalized).filter(Boolean);
  return candidate.some(value => targets.some(target => value === target || (target.length >= 6 && value.includes(target))));
}

async function durPairWarnings(medicines, type, path) {
  const warnings = [];
  const errors = [];
  for (let i = 0; i < medicines.length; i += 1) {
    const source = medicines[i];
    if (!source.product) continue;
    let rows;
    try { rows = await fetchMfds(path, { itemName: source.product.name || source.name }); }
    catch (error) { errors.push(error.message); continue; }
    for (let j = i + 1; j < medicines.length; j += 1) {
      const target = medicines[j];
      if (!target.product) continue;
      const row = rows.find(record => targetMatchesRow(record, target));
      if (!row) continue;
      const contraindication = type === 'interaction';
      warnings.push({
        type, severity: contraindication ? 'danger' : 'warning', medicines: [source.name, target.name],
        title: contraindication ? '식약처 DUR 병용금기 확인' : '식약처 DUR 효능군 중복 확인',
        message: pick(row, 'PROHBT_CONTENT', 'REMARK', 'DUR_CONT', 'ETC_OTC_NAME') || `${source.name}과(와) ${target.name}의 DUR 정보가 확인되었습니다.`,
        action: contraindication
          ? '시간을 띄우는 것만으로 해결된다고 판단하지 말고, 복용 전에 반드시 의사 또는 약사에게 확인하세요.'
          : '복용 목적과 용량이 중복되는지 의사 또는 약사에게 확인하세요.',
        sourceUpdatedAt: pick(row, 'CHANGE_DATE', 'NOTIFICATION_DATE')
      });
    }
  }
  return { warnings, errors };
}

async function elderlyWarnings(medicines, age) {
  if (!Number.isFinite(age) || age < 65) return { warnings: [], errors: [] };
  const warnings = [], errors = [];
  for (const medicine of medicines) {
    if (!medicine.product) continue;
    try {
      const rows = await fetchMfds(MFDS_PATHS.elderly, { itemName: medicine.product.name || medicine.name });
      const row = rows[0];
      if (!row) continue;
      warnings.push({
        type: 'elderly_caution', severity: 'warning', medicines: [medicine.name], title: '65세 이상 노인주의 의약품',
        message: pick(row, 'PROHBT_CONTENT', 'REMARK', 'DUR_CONT') || `${medicine.name}에 노인주의 DUR 정보가 있습니다.`,
        action: '복용을 임의로 중단하지 말고 현재 상태와 용량을 의사 또는 약사에게 확인하세요.',
        sourceUpdatedAt: pick(row, 'CHANGE_DATE', 'NOTIFICATION_DATE')
      });
    } catch (error) { errors.push(error.message); }
  }
  return { warnings, errors };
}

async function resolveForSafety(input) {
  const result = [];
  for (const medicine of input.slice(0, 30)) {
    let product = medicine.product && medicine.product.name ? medicine.product : null;
    if (!product) {
      const matches = await searchProducts(medicine.name, medicine.itemSeq);
      product = matches.find(match => match.score >= 100) || null;
    }
    result.push({ ...medicine, product });
  }
  return result;
}

app.use(express.json({ limit: '300kb' }));
app.get('/vendor/supabase.js', (_request, response) => response.type('application/javascript').send(supabaseBrowserJs));
app.get('/api/supabase-config', (_request, response) => {
  const url = process.env.SUPABASE_URL?.trim();
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) {
    return response.status(503).json({ configured: false, error: 'Supabase 환경 변수가 설정되지 않았습니다.' });
  }
  response.json({ configured: true, url, publishableKey });
});
app.use(express.static('.'));
app.get('/', (_request, response) => response.type('html').send(indexHtml));

app.get('/api/health', (_request, response) => response.json({
  ok: true,
  geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
  mfdsConfigured: Boolean(mfdsKey()),
  supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY)
}));

app.post('/api/analyze-prescription', upload.array('photos', 5), async (request, response) => {
  if (!process.env.GEMINI_API_KEY) return response.status(503).json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다. .env 파일을 확인해 주세요.' });
  if (!request.files?.length) return response.status(400).json({ error: '분석할 이미지가 없습니다.' });
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const result = await generateWithRetry(ai, {
      model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
      contents: [{ role: 'user', parts: [
        { text: extractionPrompt },
        ...request.files.flatMap((file, index) => [
          { text: `[IMAGE ${index + 1} START — ${file.originalname}]` },
          { inlineData: { data: file.buffer.toString('base64'), mimeType: file.mimetype } },
          { text: `[IMAGE ${index + 1} END]` },
        ])
      ] }],
      config: { responseMimeType: 'application/json', responseJsonSchema: prescriptionSchema }
    });
    const data = JSON.parse(result.text);
    const extractedMedicines = asArray(data.medicines).map(normalizeExtractedMedicine);
    const medicines = mfdsKey()
      ? await Promise.all(extractedMedicines.map(enrichMedicine))
      : extractedMedicines.map(medicine => ({ ...medicine, matches: [], matched_product: null, confirmation_required: true, verification_message: 'MFDS_API_KEY가 없어 식약처 품목을 확인하지 못했습니다.' }));
    response.json({ medicines, mfdsConfigured: Boolean(mfdsKey()) });
  } catch (error) {
    console.error('Prescription analysis failed:', error);
    const providerMessage = typeof error?.message === 'string' ? error.message.replace(/AIza[\w-]+|AQ\.[\w-]+/g, '[API 키 숨김]') : '알 수 없는 분석 오류';
    const providerStatus = Number(error?.status || error?.statusCode);
    const status = [400, 401, 403, 404, 429, 503].includes(providerStatus) ? providerStatus : 502;
    response.status(status).json({ error: providerStatus === 503 ? '분석 서버가 현재 혼잡합니다. 잠시 후 다시 시도해 주세요.' : `사진 분석 실패: ${providerMessage}` });
  }
});

app.post('/api/check-safety', async (request, response) => {
  const medicines = Array.isArray(request.body?.medicines) ? request.body.medicines : [];
  const age = Number(request.body?.age);
  if (medicines.length < 1) return response.status(400).json({ error: '점검할 약이 없습니다.' });
  if (medicines.length > 30) return response.status(400).json({ error: '한 번에 최대 30개 약까지 점검할 수 있습니다.' });
  if (!mfdsKey()) return response.status(503).json({ error: 'MFDS_API_KEY가 없어 공식 안전정보를 조회할 수 없습니다.' });

  try {
    const resolved = await resolveForSafety(medicines);
    const duplicate = duplicateIngredientWarnings(resolved);
    const [interaction, efficacy, elderly] = await Promise.all([
      durPairWarnings(resolved, 'interaction', MFDS_PATHS.interaction),
      durPairWarnings(resolved, 'efficacy_duplicate', MFDS_PATHS.efficacyDuplicate),
      elderlyWarnings(resolved, age)
    ]);
    const unresolved = resolved.filter(item => !item.product).map(item => item.name);
    const errors = [...interaction.errors, ...efficacy.errors, ...elderly.errors];
    response.json({
      checkedAt: new Date().toISOString(),
      complete: errors.length === 0 && unresolved.length === 0,
      warnings: [...duplicate, ...interaction.warnings, ...efficacy.warnings, ...elderly.warnings],
      unresolved,
      errors: [...new Set(errors)],
      medicines: resolved.map(item => ({ id: item.id, product: item.product }))
    });
  } catch (error) {
    console.error('MFDS safety check failed:', error);
    response.status(502).json({ error: `식약처 안전정보 점검 실패: ${error.message}` });
  }
});

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) return response.status(400).json({ error: '사진은 최대 5장, 각 10MB까지 첨부할 수 있습니다.' });
  response.status(400).json({ error: 'JPG, PNG, WEBP 형식의 사진만 첨부할 수 있습니다.' });
});

if (!process.env.VERCEL) {
  app.listen(port, () => console.log(`약속시간 서버: http://localhost:${port}`));
}

export default app;

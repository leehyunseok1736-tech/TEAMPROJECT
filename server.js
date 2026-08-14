import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';
import { readFileSync } from 'node:fs';

const app = express();
const port = process.env.PORT || 3000;
const indexHtml = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const MFDS_BASE_URL = process.env.MFDS_BASE_URL || 'https://apis.data.go.kr/1471000';
const MFDS_PATHS = {
  product: process.env.MFDS_PRODUCT_PATH || '/DrugPrdtPrmsnInfoService06/getDrugPrdtPrmsnDtlInq06',
  durProduct: process.env.MFDS_DUR_PRODUCT_PATH || '/DURPrdlstInfoService03/getDurPrdlstInfoList3',
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
        required: ['name', 'item_code', 'manufacturer', 'amount_per_dose', 'frequency_per_day', 'times', 'meal_timing', 'duration'],
        properties: {
          name: { type: 'string' },
          item_code: { type: 'string' },
          manufacturer: { type: 'string' },
          amount_per_dose: { type: 'string' },
          frequency_per_day: { type: 'string' },
          times: { type: 'array', items: { type: 'string' } },
          meal_timing: { type: 'string' },
          duration: { type: 'string' }
        }
      }
    }
  }
};

const extractionPrompt = `You are performing OCR and data structuring only, not medical advice. Read only medication directions visibly written in the supplied Korean prescription or medicine-bag images. Do not infer, calculate, normalize, or invent information. For every unreadable, ambiguous, or absent scalar field, return exactly "확인 필요". item_code means the Korean MFDS item sequence/품목기준코드 only when visibly printed. For times, return an empty array unless an explicit clock time is visible. Never convert meal-based directions into guessed times. Include only medicines supported by the images. Return Korean text that conforms to the supplied JSON schema.`;

const cache = new Map();
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const text = value => String(value ?? '').trim();
const stripHtml = value => text(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim();
const normalized = value => stripHtml(value).toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
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

function ingredientParts(record) {
  const names = pick(record, 'MAIN_ITEM_INGR', 'INGR_NAME', 'INGREDIENT', 'INGR_KOR_NAME', 'MATERIAL_NAME');
  const codes = pick(record, 'INGR_CODE', 'INGREDIENT_CODE', 'MAIN_INGR_CODE');
  const nameList = names.split(/\r?\n|;|\+(?=[^\d])|,(?=[^\d])/).map(stripHtml).filter(Boolean);
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
  const q = normalized(query);
  const name = normalized(product.name);
  if (!q || !name) return 0;
  if (q === name) return 100;
  if (name.startsWith(q) || q.startsWith(name)) return 85;
  if (name.includes(q) || q.includes(name)) return 70;
  return 0;
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
  const calls = [
    fetchMfds(MFDS_PATHS.product, { item_name: queryName, item_seq: queryCode }).catch(() => []),
    fetchMfds(MFDS_PATHS.durProduct, { itemName: queryName, itemSeq: queryCode }).catch(() => [])
  ];
  const products = mergeProducts(...await Promise.all(calls));
  return products.map(product => ({ ...product, score: queryCode && product.itemSeq === queryCode ? 110 : productScore(queryName, product) }))
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
  const withoutDose = ingredient.name.replace(/\d+(?:\.\d+)?\s*(?:mg|mcg|μg|g|ml|%|정|캡슐)/gi, ' ');
  return `name:${normalized(withoutDose)}`;
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
app.use(express.static('.'));
app.get('/', (_request, response) => response.type('html').send(indexHtml));

app.get('/api/health', (_request, response) => response.json({
  ok: true, geminiConfigured: Boolean(process.env.GEMINI_API_KEY), mfdsConfigured: Boolean(mfdsKey())
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
        ...request.files.map(file => ({ inlineData: { data: file.buffer.toString('base64'), mimeType: file.mimetype } }))
      ] }],
      config: { responseMimeType: 'application/json', responseJsonSchema: prescriptionSchema }
    });
    const data = JSON.parse(result.text);
    const medicines = mfdsKey()
      ? await Promise.all(asArray(data.medicines).map(enrichMedicine))
      : asArray(data.medicines).map(medicine => ({ ...medicine, matches: [], matched_product: null, confirmation_required: true, verification_message: 'MFDS_API_KEY가 없어 식약처 품목을 확인하지 못했습니다.' }));
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

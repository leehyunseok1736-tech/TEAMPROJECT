const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function trimTime(value) {
  return typeof value === 'string' ? value.slice(0, 5) : '';
}

function medicationFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    amount: row.amount || '',
    times: row.times || [],
    label: row.label || '',
    product: row.product,
    startDate: row.start_date,
    durationDays: row.duration_days,
    duration: row.duration || '',
    scheduleSource: row.schedule_source || ''
  };
}

function profileFromRow(row) {
  if (!row) return null;
  return {
    patientAge: row.patient_age == null ? '' : String(row.patient_age),
    breakfastTime: trimTime(row.breakfast_time),
    lunchTime: trimTime(row.lunch_time),
    dinnerTime: trimTime(row.dinner_time),
    bedtimeTime: trimTime(row.bedtime_time)
  };
}

function parseDoseKey(key) {
  const match = String(key).match(/^(\d{4}-\d{2}-\d{2})-(.+)-(\d{2}:\d{2})$/);
  return match ? { doseDate: match[1], medicationId: match[2], doseTime: match[3] } : null;
}

function doseKey(row) {
  return `${row.dose_date}-${row.medication_id}-${trimTime(row.dose_time)}`;
}

function throwIfError(result) {
  if (result.error) throw result.error;
  return result.data;
}

export async function createSupabaseData({ onAuthChange, onData, onError }) {
  const response = await fetch('/api/supabase-config');
  const config = await response.json();
  if (!response.ok || !config.configured) {
    throw new Error(config.error || 'Supabase 환경 변수가 설정되지 않았습니다.');
  }
  if (!window.supabase?.createClient) throw new Error('Supabase 클라이언트를 불러오지 못했습니다.');

  const client = window.supabase.createClient(config.url, config.publishableKey);
  let user = null;
  let syncChain = Promise.resolve();

  async function loadUserData() {
    if (!user) return { profile: null, medications: [], doseRecords: {} };
    const [profileResult, medicationResult, doseResult] = await Promise.all([
      client.from('profiles').select('*').eq('user_id', user.id).maybeSingle(),
      client.from('medications').select('*').eq('user_id', user.id).order('created_at'),
      client.from('dose_records').select('*').eq('user_id', user.id)
    ]);
    const profile = throwIfError(profileResult);
    const medications = throwIfError(medicationResult).map(medicationFromRow);
    const doseRecords = {};
    throwIfError(doseResult).forEach(row => {
      doseRecords[doseKey(row)] = { status: row.status, updatedAt: row.updated_at };
    });
    return { profile: profileFromRow(profile), medications, doseRecords };
  }

  async function writeProfile(profile) {
    if (!profile) return;
    throwIfError(await client.from('profiles').upsert({
      user_id: user.id,
      patient_age: profile.patientAge === '' ? null : Number(profile.patientAge),
      breakfast_time: profile.breakfastTime || null,
      lunch_time: profile.lunchTime || null,
      dinner_time: profile.dinnerTime || null,
      bedtime_time: profile.bedtimeTime || null
    }, { onConflict: 'user_id' }));
  }

  async function writeMedications(medications, records) {
    const idMap = new Map();
    const ownedRows = throwIfError(await client.from('medications').select('id').eq('user_id', user.id));
    const ownedIds = new Set(ownedRows.map(row => row.id));
    for (const medicine of medications) {
      const oldId = String(medicine.id);
      const row = {
        user_id: user.id,
        name: medicine.name,
        amount: medicine.amount || null,
        times: medicine.times || [],
        label: medicine.label || null,
        product: medicine.product || null,
        start_date: medicine.startDate,
        duration_days: Number(medicine.durationDays) || 0,
        duration: medicine.duration || null,
        schedule_source: medicine.scheduleSource || null
      };
      if (UUID_PATTERN.test(oldId) && ownedIds.has(oldId)) row.id = oldId;
      else row.legacy_id = oldId;
      const conflict = row.id ? 'id' : 'user_id,legacy_id';
      const saved = throwIfError(await client.from('medications').upsert(row, { onConflict: conflict }).select('id').single());
      medicine.id = saved.id;
      idMap.set(oldId, saved.id);
    }

    for (const [key, record] of Object.entries({ ...records })) {
      const parsed = parseDoseKey(key);
      if (!parsed || !idMap.has(parsed.medicationId)) continue;
      const newKey = `${parsed.doseDate}-${idMap.get(parsed.medicationId)}-${parsed.doseTime}`;
      if (newKey !== key) {
        records[newKey] = record;
        delete records[key];
      }
    }

    const keptIds = medications.map(item => item.id);
    let deleteQuery = client.from('medications').delete().eq('user_id', user.id);
    if (keptIds.length) deleteQuery = deleteQuery.not('id', 'in', `(${keptIds.join(',')})`);
    throwIfError(await deleteQuery);
  }

  async function writeDoseRecords(records) {
    const desired = [];
    for (const [key, record] of Object.entries(records)) {
      const parsed = parseDoseKey(key);
      if (!parsed || !UUID_PATTERN.test(parsed.medicationId) || !['taken', 'skipped'].includes(record.status)) continue;
      desired.push({
        user_id: user.id,
        medication_id: parsed.medicationId,
        dose_date: parsed.doseDate,
        dose_time: parsed.doseTime,
        status: record.status
      });
    }

    let keptIds = [];
    if (desired.length) {
      const saved = throwIfError(await client.from('dose_records')
        .upsert(desired, { onConflict: 'medication_id,dose_date,dose_time' })
        .select('id'));
      keptIds = saved.map(row => row.id);
    }
    let deleteQuery = client.from('dose_records').delete().eq('user_id', user.id);
    if (keptIds.length) deleteQuery = deleteQuery.not('id', 'in', `(${keptIds.join(',')})`);
    throwIfError(await deleteQuery);
  }

  function syncState(state) {
    if (!user) return Promise.resolve(false);
    syncChain = syncChain.then(async () => {
      await writeProfile(state.profile);
      await writeMedications(state.medications, state.doseRecords);
      await writeDoseRecords(state.doseRecords);
      return true;
    }).catch(error => {
      onError?.(error);
      return false;
    });
    return syncChain;
  }

  async function hydrate(localState) {
    const remote = await loadUserData();
    const marker = `yakSoksiganSupabaseMigratedV2:${user.id}`;
    if (!localStorage.getItem(marker) && localState.hasLocalData) {
      const merged = {
        profile: localState.profile || remote.profile,
        medications: [...remote.medications, ...localState.medications],
        doseRecords: { ...remote.doseRecords, ...localState.doseRecords }
      };
      const synced = await syncState(merged);
      if (synced) {
        localStorage.setItem(marker, new Date().toISOString());
        onData?.(merged);
      }
      return;
    }
    onData?.(remote);
  }

  async function refresh(localState) {
    const result = await client.auth.getSession();
    throwIfError(result);
    user = result.data.session?.user || null;
    onAuthChange?.(user);
    if (user) await hydrate(localState);
  }

  client.auth.onAuthStateChange((event, session) => {
    const nextUser = session?.user || null;
    const changed = nextUser?.id !== user?.id;
    user = nextUser;
    onAuthChange?.(user);
    if (event === 'SIGNED_IN' && changed) loadUserData().then(data => onData?.(data)).catch(error => onError?.(error));
  });

  return {
    refresh,
    syncState,
    currentUser: () => user,
    signIn: (email, password) => client.auth.signInWithPassword({ email, password }),
    signInAnonymously: () => client.auth.signInAnonymously(),
    signUp: (email, password) => client.auth.signUp({ email, password }),
    resendSignUp: email => client.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: window.location.origin }
    }),
    signOut: () => client.auth.signOut()
  };
}

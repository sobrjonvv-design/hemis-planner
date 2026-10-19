/** Pure domain logic. All student-facing calendar calculations use Uzbekistan time. */
export const DAYS = ['', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
export const SHORT_DAYS = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const TASK_TYPES = ['Практика / ДЗ', 'Лабораторная', 'СРС / Mustaqil ish', 'Контроль ON / YN'];
const TIME_ZONE = 'Asia/Tashkent';
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

export function uid() {
  return globalThis.crypto?.randomUUID?.() || `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function dateInfo(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(value.getTime())) throw new Error('Некорректная дата.');
  const parts = Object.fromEntries(dateFormatter.formatToParts(value).map(part => [part.type, part.value]));
  const iso = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return {day: weekday || 7, date: iso, minutes: Number(parts.hour) * 60 + Number(parts.minute), time: `${parts.hour}:${parts.minute}`};
}

export function localDate(date = new Date()) { return dateInfo(date).date; }

function addDays(iso, amount) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function tomorrowDate(date = new Date()) { return addDays(localDate(date), 1); }

export function createEmptyState() {
  return {
    version: 1, mode: 'local', profile: {name: '', university: '', group: ''},
    schedule: [], subjects: [], tasks: [],
    settings: {notificationEnabled: false, notificationTime: '20:00', timeZone: TIME_ZONE, theme: 'system'},
    updatedAt: new Date().toISOString()
  };
}

export function createDemoState() {
  const state = createEmptyState();
  state.mode = 'demo';
  state.profile = {name: 'Азиза Каримова', university: 'TIFT · демо', group: 'CS–23 / 3 курс'};
  state.subjects = [
    {id: 'data', name: 'Анализ данных', totalHours: 120, excusedHours: 2, unexcusedHours: 4},
    {id: 'web', name: 'Веб-программирование', totalHours: 90, excusedHours: 0, unexcusedHours: 4},
    {id: 'db', name: 'Базы данных', totalHours: 90, excusedHours: 2, unexcusedHours: 12},
    {id: 'en', name: 'Английский язык', totalHours: 60, excusedHours: 2, unexcusedHours: 10},
    {id: 'math', name: 'Линейная алгебра', totalHours: 120, excusedHours: 0, unexcusedHours: 8},
    {id: 'writing', name: 'Академическое письмо', totalHours: 60, excusedHours: 0, unexcusedHours: 0}
  ];
  const subjectNames = new Map(state.subjects.map(subject => [subject.id, subject.name]));
  const makeLesson = (id, subjectId, day, start, end, room, type, teacher) => ({
    id, subjectId, subject: subjectNames.get(subjectId), day, start, end, room, type, teacher, source: 'demo'
  });
  state.schedule = [
    makeLesson('mon-data', 'data', 1, '09:00', '10:20', 'B–304', 'Лекция', 'Н. Рахимова'),
    makeLesson('mon-web', 'web', 1, '10:30', '11:50', 'A–201', 'Практика', 'А. Юсупов'),
    makeLesson('mon-db', 'db', 1, '12:30', '13:50', 'B–208', 'Лабораторная', 'Д. Хакимов'),
    makeLesson('tue-math', 'math', 2, '09:00', '10:20', 'A–102', 'Лекция', 'М. Абдуллаева'),
    makeLesson('tue-en', 'en', 2, '10:30', '11:50', 'C–306', 'Практика', 'С. Исмаилова'),
    makeLesson('tue-writing', 'writing', 2, '12:30', '13:50', 'C–204', 'Семинар', 'Л. Каримова'),
    makeLesson('wed-data', 'data', 3, '09:00', '10:20', 'B–304', 'Практика', 'Н. Рахимова'),
    makeLesson('wed-web', 'web', 3, '10:30', '11:50', 'A–201', 'Лабораторная', 'А. Юсупов'),
    makeLesson('thu-db', 'db', 4, '09:00', '10:20', 'B–208', 'Лекция', 'Д. Хакимов'),
    makeLesson('thu-math', 'math', 4, '10:30', '11:50', 'A–102', 'Практика', 'М. Абдуллаева'),
    makeLesson('thu-en', 'en', 4, '12:30', '13:50', 'C–306', 'Практика', 'С. Исмаилова'),
    makeLesson('fri-data', 'data', 5, '10:30', '11:50', 'B–304', 'Лабораторная', 'Н. Рахимова'),
    makeLesson('fri-web', 'web', 5, '12:30', '13:50', 'A–201', 'Практика', 'А. Юсупов'),
    makeLesson('sat-writing', 'writing', 6, '09:00', '10:20', 'C–204', 'Семинар', 'Л. Каримова'),
    makeLesson('sat-math', 'math', 6, '10:30', '11:50', 'A–102', 'Практика', 'М. Абдуллаева')
  ];
  const today = dateInfo();
  const dueFor = day => addDays(today.date, (day - today.day + 7) % 7);
  const task = (id, title, subjectId, day, type, priority, notes, url, steps, done = false) => ({
    id, title, subjectId, day, type, priority, due: dueFor(day), notes, url, done,
    checklist: steps.map(([text, complete], index) => ({id: `${id}-step-${index}`, text, done: complete})),
    createdAt: state.updatedAt, updatedAt: state.updatedAt
  });
  state.tasks = [
    task('task-eda', 'Исследовать датасет и собрать EDA', 'data', 1, TASK_TYPES[0], 'high',
      'Проверить пропуски, построить распределения и сформулировать 3 вывода. Пример учебного задания.',
      'https://colab.research.google.com/', [['Очистить данные', true], ['Построить визуализации', true], ['Описать выводы', false]]),
    task('task-web', 'Сверстать адаптивную страницу', 'web', 1, TASK_TYPES[0], 'medium',
      'Использовать семантическую разметку и проверить мобильную версию. Ссылка ведёт на учебные материалы.',
      'https://developer.mozilla.org/ru/docs/Learn_web_development', [['Разметка HTML', true], ['Адаптивная сетка', false], ['Проверка доступности', false]]),
    task('task-sql', 'Лабораторная №4 · JOIN и подзапросы', 'db', 1, TASK_TYPES[1], 'high',
      'Подготовить SQL-файл с пятью запросами и кратким пояснением.', 'https://www.postgresql.org/docs/current/tutorial-join.html',
      [['INNER и LEFT JOIN', false], ['Два подзапроса', false], ['Сохранить отчёт', false]]),
    task('task-en', 'Подготовить выступление: My future career', 'en', 2, TASK_TYPES[2], 'medium',
      '3–5 минут, 5 слайдов и список новой лексики.', 'https://www.canva.com/',
      [['План выступления', true], ['Слайды и репетиция', false]]),
    task('task-math', 'Решить системы линейных уравнений', 'math', 2, TASK_TYPES[0], 'low',
      'Метод Гаусса: задачи 1–6. Сверить решение обратной подстановкой.', '',
      [['Задачи 1–3', true], ['Задачи 4–6', false]]),
    task('task-test', 'Повторить нормализацию к ON', 'db', 4, TASK_TYPES[3], 'high',
      '1НФ, 2НФ, 3НФ и функциональные зависимости.', 'https://www.postgresql.org/docs/current/ddl.html',
      [['Повторить конспект', false], ['Разобрать 3 примера', false]]),
    task('task-essay', 'Составить план академического эссе', 'writing', 2, TASK_TYPES[2], 'low',
      'Тезис, аргументы, источники и вывод. Выполненное демо-задание.', '',
      [['Сформулировать тезис', true], ['Подобрать источники', true]], true)
  ];
  return state;
}

/** Hours include both absence categories. A missing teaching load never becomes a guessed denominator. */
export function attendanceStats(subject = {}) {
  const nonNegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  const excused = nonNegative(subject.excusedHours);
  const unexcused = nonNegative(subject.unexcusedHours);
  const missed = excused + unexcused;
  const total = typeof subject.totalHours === 'number' && Number.isFinite(subject.totalHours) && subject.totalHours > 0 ? subject.totalHours : null;
  if (total === null) return {total, excused, unexcused, missed, percent: null, limitHours: null, remainingHours: null, safeHours: null, status: 'unknown'};
  const percent = missed / total * 100;
  const limitHours = total * 0.25;
  const remainingHours = Math.max(0, Math.round((limitHours - missed) * 1e8) / 1e8);
  // Reaching exactly 25% is already the threshold; safeHours must stay strictly below it.
  const safeHours = Math.max(0, Math.ceil(remainingHours) - 1);
  return {total, excused, unexcused, missed, percent, limitHours, remainingHours, safeHours,
    status: percent >= 20 ? 'critical' : percent >= 15 ? 'warning' : 'ok'};
}

function timeMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function dayStatus(schedule, date = new Date()) {
  const now = dateInfo(date);
  const lessons = schedule.filter(lesson => lesson.day === now.day)
    .slice().sort((a, b) => timeMinutes(a.start) - timeMinutes(b.start) || timeMinutes(a.end) - timeMinutes(b.end));
  if (!lessons.length) return {kind: 'free', minutes: 0, progress: 0};
  const current = lessons.find(lesson => timeMinutes(lesson.start) <= now.minutes && timeMinutes(lesson.end) > now.minutes);
  const next = lessons.find(lesson => timeMinutes(lesson.start) > now.minutes);
  if (current) {
    const start = timeMinutes(current.start), end = timeMinutes(current.end);
    return {kind: 'live', current, next, minutes: end - now.minutes, progress: Math.max(0, Math.min(100, (now.minutes - start) / (end - start) * 100))};
  }
  if (next) {
    const prior = lessons.some(lesson => timeMinutes(lesson.end) <= now.minutes);
    return {kind: prior ? 'break' : 'upcoming', next, minutes: timeMinutes(next.start) - now.minutes, progress: 0};
  }
  return {kind: 'done', minutes: 0, progress: 100};
}

export function summaries(state, date = new Date()) {
  const today = dateInfo(date);
  const tomorrow = {date: addDays(today.date, 1), day: today.day % 7 + 1};
  const summary = target => ({
    lessons: state.schedule.filter(lesson => lesson.day === target.day).length,
    tasks: state.tasks.filter(task => !task.done && (task.due ? task.due === target.date : task.day === target.day)).length
  });
  return {today: summary(today), tomorrow: summary(tomorrow)};
}

/** Convert legacy hemis_planner_state_v1 snapshots (lessons/attendance/studentProfile) into the v1 schema. */
export function migrateLegacyState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Array.isArray(raw.schedule) || (!Array.isArray(raw.lessons) && !Array.isArray(raw.attendance))) return raw;
  const norm = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[‘’ʻʼ`]/g, "'").replace(/\s+/g, ' ').trim();
  const subjectsByKey = new Map();
  const activeKeys = new Set();
  for (const [index, entry] of (Array.isArray(raw.attendance) ? raw.attendance : []).entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.subject ?? entry.name ?? '').trim();
    if (!name) continue;
    const key = norm(name);
    const id = String(entry.id || `subj-${index + 1}`).trim();
    const total = typeof entry.totalHours === 'number' && Number.isFinite(entry.totalHours) && entry.totalHours > 0 ? entry.totalHours : null;
    const excused = typeof entry.excusedHours === 'number' && Number.isFinite(entry.excusedHours) && entry.excusedHours >= 0 ? entry.excusedHours : 0;
    const unexcused = typeof entry.unexcusedHours === 'number' && Number.isFinite(entry.unexcusedHours) && entry.unexcusedHours >= 0 ? entry.unexcusedHours : 0;
    const prev = subjectsByKey.get(key);
    subjectsByKey.set(key, {
      id: prev?.id || id,
      name: prev?.name || name,
      totalHours: total ?? prev?.totalHours ?? null,
      excusedHours: Math.max(prev?.excusedHours ?? 0, excused),
      unexcusedHours: Math.max(prev?.unexcusedHours ?? 0, unexcused)
    });
  }
  const schedule = [];
  const seenLessonIds = new Set();
  for (const [index, entry] of (Array.isArray(raw.lessons) ? raw.lessons : []).entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const subjectName = String(entry.subject ?? '').trim();
    const day = Number(entry.dayOfWeek ?? entry.day);
    const start = String(entry.startTime ?? entry.start ?? '').trim();
    const end = String(entry.endTime ?? entry.end ?? '').trim();
    if (!subjectName || !Number.isInteger(day) || day < 1 || day > 6 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || timeMinutes(end) <= timeMinutes(start)) continue;
    const key = norm(subjectName);
    if (!subjectsByKey.has(key)) {
      subjectsByKey.set(key, { id: `subj-${subjectsByKey.size + 1}`, name: subjectName, totalHours: null, excusedHours: 0, unexcusedHours: 0 });
    }
    activeKeys.add(key);
    const subject = subjectsByKey.get(key);
    let lessonId = String(entry.id || `lesson-${index + 1}`).trim();
    if (seenLessonIds.has(lessonId)) lessonId = `${lessonId}-${index + 1}`;
    seenLessonIds.add(lessonId);
    schedule.push({
      id: lessonId,
      subjectId: subject.id,
      subject: subject.name,
      day,
      start,
      end,
      room: String(entry.room ?? 'Не указана').trim().slice(0, 160) || 'Не указана',
      type: String(entry.type ?? 'Занятие').trim().slice(0, 120) || 'Занятие',
      teacher: String(entry.teacher ?? 'Не указан').trim().slice(0, 300) || 'Не указан',
      source: raw.demoMode === true ? 'demo' : 'hemis'
    });
  }
  const subjects = [...subjectsByKey.entries()]
    .sort(([keyA], [keyB]) => Number(activeKeys.has(keyB)) - Number(activeKeys.has(keyA)))
    .map(([, item]) => item);
  const subjectIds = new Set(subjects.map(item => item.id));
  const fallbackSubjectId = subjects[0]?.id || '';
  const tasks = [];
  const seenTaskIds = new Set();
  for (const [index, entry] of (Array.isArray(raw.tasks) ? raw.tasks : []).entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const title = String(entry.title ?? '').trim();
    if (!title) continue;
    const byKey = subjectsByKey.get(norm(entry.subject ?? entry.subjectName ?? ''));
    const subjectId = subjectIds.has(entry.subjectId) ? entry.subjectId : (byKey?.id || fallbackSubjectId);
    if (!subjectId) continue;
    let taskId = String(entry.id || `task-${index + 1}`).trim();
    if (seenTaskIds.has(taskId)) taskId = `${taskId}-${index + 1}`;
    seenTaskIds.add(taskId);
    const day = Number(entry.dayOfWeek ?? entry.day);
    const rawDue = String(entry.dueDate ?? entry.due ?? '').trim().slice(0, 10);
    const checklist = (Array.isArray(entry.checklist) ? entry.checklist : []).map((step, stepIndex) => ({
      id: String(step?.id || `${taskId}-step-${stepIndex + 1}`).trim(),
      text: String(step?.text ?? step?.title ?? '').trim(),
      done: Boolean(step?.done ?? step?.completed)
    })).filter(step => step.text);
    tasks.push({
      id: taskId,
      title: title.slice(0, 500),
      subjectId,
      day: Number.isInteger(day) && day >= 1 && day <= 6 ? day : 1,
      type: TASK_TYPES.includes(entry.type) ? entry.type : TASK_TYPES[0],
      priority: ['low', 'medium', 'high'].includes(entry.priority) ? entry.priority : 'medium',
      due: /^\d{4}-\d{2}-\d{2}$/.test(rawDue) ? rawDue : '',
      notes: String(entry.notes ?? '').slice(0, 20000),
      url: String(entry.url ?? entry.link ?? '').trim(),
      done: Boolean(entry.done ?? entry.completed),
      checklist
    });
  }
  const sp = raw.studentProfile && typeof raw.studentProfile === 'object' ? raw.studentProfile : (raw.profile && typeof raw.profile === 'object' ? raw.profile : {});
  const groupParts = [sp.groupName ?? sp.group, sp.semesterName].map(v => String(v ?? '').trim()).filter(Boolean);
  const st = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const reminderTime = String(st.notificationTime ?? st.reminderTime ?? '20:00').trim();
  const theme = st.theme ?? raw.theme;
  const updatedAt = typeof raw.lastSyncAt === 'string' && Number.isFinite(Date.parse(raw.lastSyncAt)) ? new Date(raw.lastSyncAt).toISOString() : new Date().toISOString();
  return {
    version: 1,
    mode: raw.demoMode === true ? 'demo' : (schedule.length || subjects.length ? 'hemis' : 'local'),
    profile: {
      name: String(sp.fullName ?? sp.name ?? '').trim().slice(0, 120),
      university: String(sp.university ?? '').trim().slice(0, 160),
      group: groupParts.join(' · ').slice(0, 80)
    },
    subjects,
    schedule,
    tasks,
    settings: {
      notificationEnabled: Boolean(st.notificationEnabled ?? st.reminderEnabled ?? false),
      notificationTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(reminderTime) ? reminderTime : '20:00',
      timeZone: TIME_ZONE,
      theme: ['system', 'light', 'dark'].includes(theme) ? theme : 'system'
    },
    updatedAt
  };
}

/** Rebuild the schema explicitly: backups/cloud data cannot inject credentials or arbitrary state fields. */
export function validateState(raw) {
  raw = migrateLegacyState(raw);
  const fail = message => { throw new Error(`Некорректная резервная копия: ${message}`); };
  const object = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} должен быть объектом.`);
    return value;
  };
  const text = (value, label, max = 500, fallback = '') => {
    if (value == null) return fallback;
    if (typeof value !== 'string' || value.length > max) fail(`проверьте поле «${label}» (до ${max} символов).`);
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  };
  const requiredText = (value, label, max = 500) => {
    const result = text(value, label, max).trim();
    if (!result) fail(`не заполнено поле «${label}».`);
    return result;
  };
  const bool = (value, label, fallback = false) => {
    if (value == null) return fallback;
    if (typeof value !== 'boolean') fail(`${label} должен быть логическим значением.`);
    return value;
  };
  const list = (value, label, max) => {
    if (!Array.isArray(value) || value.length > max) fail(`${label}: требуется массив, не более ${max} записей.`);
    return value;
  };
  const number = (value, label, fallback = 0) => {
    if (value == null) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000) fail(`неверное число в поле «${label}».`);
    return value;
  };
  const choice = (value, choices, label, fallback) => {
    if (value == null) return fallback;
    if (!choices.includes(value)) fail(`неверное значение «${label}».`);
    return value;
  };
  const weekday = value => {
    if (!Number.isInteger(value) || value < 1 || value > 6) fail('день недели должен быть от 1 (Пн) до 6 (Сб).');
    return value;
  };
  const time = (value, label) => {
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(`неверное время «${label}».`);
    return value;
  };
  const dueDate = value => {
    if (value == null || value === '') return '';
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('дедлайн должен быть датой ГГГГ-ММ-ДД.');
    const parsed = new Date(`${value}T12:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('дедлайн содержит несуществующую дату.');
    return value;
  };
  const timestamp = (value, fallback) => {
    if (value == null || value === '') return fallback;
    if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) fail('неверная дата изменения.');
    return new Date(value).toISOString();
  };
  const unique = (items, label) => {
    const ids = new Set();
    for (const item of items) {
      if (ids.has(item.id)) fail(`повторяющийся ID в разделе «${label}».`);
      ids.add(item.id);
    }
    return ids;
  };
  object(raw, 'Данные');
  if (raw.version !== 1) fail('версия данных не поддерживается.');
  const now = new Date().toISOString();
  const state = createEmptyState();
  state.mode = choice(raw.mode, ['demo', 'local', 'hemis'], 'режим', 'local');
  const profile = object(raw.profile || {}, 'Профиль');
  state.profile = {name: text(profile.name, 'имя', 120), university: text(profile.university, 'вуз', 160), group: text(profile.group, 'группа', 80)};
  state.subjects = list(raw.subjects, 'Предметы', 2000).map((entry, index) => {
    const subject = object(entry, `Предмет ${index + 1}`);
    return {id: requiredText(subject.id, 'ID предмета', 160), name: requiredText(subject.name, 'предмет', 300),
      totalHours: number(subject.totalHours, 'общее число часов', null),
      excusedHours: number(subject.excusedHours, 'уважительные НБ'), unexcusedHours: number(subject.unexcusedHours, 'неуважительные НБ')};
  });
  const subjectIds = unique(state.subjects, 'Предметы');
  const subjectMap = new Map(state.subjects.map(subject => [subject.id, subject]));
  const reference = value => {
    const id = requiredText(value, 'ссылка на предмет', 160);
    if (!subjectIds.has(id)) fail('занятие или задание ссылается на отсутствующий предмет.');
    return id;
  };
  state.schedule = list(raw.schedule, 'Расписание', 4000).map((entry, index) => {
    const lesson = object(entry, `Занятие ${index + 1}`);
    const start = time(lesson.start, 'начало пары'), end = time(lesson.end, 'конец пары');
    if (timeMinutes(end) <= timeMinutes(start)) fail('окончание пары должно быть позже начала.');
    const subjectId = reference(lesson.subjectId);
    return {id: requiredText(lesson.id, 'ID занятия', 160), subjectId, subject: subjectMap.get(subjectId).name,
      day: weekday(lesson.day), start, end, room: text(lesson.room, 'аудитория', 160), type: text(lesson.type, 'тип занятия', 120),
      teacher: text(lesson.teacher, 'преподаватель', 300), source: text(lesson.source, 'источник', 120, 'manual')};
  });
  unique(state.schedule, 'Расписание');
  state.tasks = list(raw.tasks, 'Задания', 10000).map((entry, index) => {
    const task = object(entry, `Задание ${index + 1}`);
    const urlText = text(task.url, 'ссылка на материалы', 2048).trim();
    let url = '';
    if (urlText) {
      let parsed;
      try { parsed = new URL(urlText); } catch { fail('ссылка на материалы должна быть полным HTTP(S)-адресом.'); }
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('разрешены только HTTP(S)-ссылки без логина и пароля.');
      url = parsed.href;
    }
    const checklist = list(task.checklist ?? [], 'Чек-лист', 200).map((entry, stepIndex) => {
      const step = object(entry, `Подзадача ${stepIndex + 1}`);
      return {id: requiredText(step.id, 'ID подзадачи', 160), text: requiredText(step.text, 'подзадача', 1000), done: bool(step.done, 'выполнение подзадачи')};
    });
    unique(checklist, 'Чек-лист');
    return {id: requiredText(task.id, 'ID задания', 160), title: requiredText(task.title, 'название задания', 500),
      subjectId: reference(task.subjectId), day: weekday(task.day), type: choice(task.type, TASK_TYPES, 'тип работы', TASK_TYPES[0]),
      priority: choice(task.priority, ['low', 'medium', 'high'], 'приоритет', 'medium'), due: dueDate(task.due),
      notes: text(task.notes, 'заметки', 20000), url, done: bool(task.done, 'выполнение задания'), checklist,
      createdAt: timestamp(task.createdAt, now), updatedAt: timestamp(task.updatedAt, now)};
  });
  unique(state.tasks, 'Задания');
  const settings = object(raw.settings || {}, 'Настройки');
  state.settings = {notificationEnabled: bool(settings.notificationEnabled, 'уведомления'),
    notificationTime: time(settings.notificationTime ?? '20:00', 'уведомление'), timeZone: TIME_ZONE,
    theme: choice(settings.theme, ['system', 'light', 'dark'], 'тема оформления', 'system')};
  state.updatedAt = timestamp(raw.updatedAt, now);
  return state;
}

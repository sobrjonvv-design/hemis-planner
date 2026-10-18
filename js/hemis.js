/**
 * Модуль интеграции и анализа расписания и посещаемости (НБ / Davomat) HEMIS
 * Поддерживает:
 * 1. Автоматическую очистку URL (например https://student.tift.uz/dashboard/login -> https://student.tift.uz)
 * 2. Подключение через локальный мост (http://127.0.0.1:8080/hemis-proxy) для серверов .uz (TAS-IX) и прямое подключение
 * 3. Авторизацию через /rest/v1/auth/login
 * 4. Загрузку расписания (/rest/v1/education/schedule), посещаемости (/rest/v1/education/attendance) и часов предметов (/rest/v1/education/subjects)
 */
(function (global) {
  const DAYS_OF_WEEK = [
    { id: 1, name: 'Понедельник', short: 'Пн' },
    { id: 2, name: 'Вторник', short: 'Вт' },
    { id: 3, name: 'Среда', short: 'Ср' },
    { id: 4, name: 'Четверг', short: 'Чт' },
    { id: 5, name: 'Пятница', short: 'Пт' },
    { id: 6, name: 'Суббота', short: 'Сб' }
  ];

  const LOCAL_BRIDGE_URL = 'http://127.0.0.1:8080/hemis-proxy';

  function cleanHemisBaseUrl(rawUrl) {
    let str = String(rawUrl || '').trim();
    if (!str) return 'https://student.tift.uz';
    if (!/^https?:\/\//i.test(str)) {
      str = 'https://' + str;
    }
    try {
      const parsed = new URL(str);
      return parsed.origin;
    } catch (_) {
      return str.replace(/\/+$/, '');
    }
  }

  async function fetchHemisEndpoint(url, options = {}, useCorsProxy = true) {
    if (useCorsProxy) {
      try {
        const bridgeEndpoint = `${LOCAL_BRIDGE_URL}?url=${encodeURIComponent(url)}`;
        const bridgeRes = await fetch(bridgeEndpoint, {
          method: options.method || 'GET',
          headers: {
            Accept: 'application/json',
            ...(options.headers || {})
          },
          body: options.body
        });
        const data = await bridgeRes.json().catch(() => null);
        if (data !== null) {
          return data;
        }
      } catch (_) {
        // Локальный мост не запущен — пробуем прямой запрос
      }
    }

    try {
      const directResponse = await fetch(url, {
        ...options,
        headers: {
          Accept: 'application/json',
          ...(options.headers || {})
        }
      });
      const data = await directResponse.json().catch(() => null);
      if (data !== null) {
        return data;
      }
    } catch (_) {
      throw new Error(
        'Браузер заблокировал прямой CORS-запрос к серверу вуза, а зарубежные прокси блокируются сетью .uz (HTTP 403). Запустите «Запустить_HEMIS_Planner.bat» в папке проекта (или откройте http://localhost:8080) и обновите страницу!'
      );
    }

    throw new Error('Не удалось получить ответ от сервера HEMIS.');
  }

  async function loginToHemis(baseUrl, login, password, useCorsProxy = true) {
    const cleanUrl = cleanHemisBaseUrl(baseUrl);
    const endpoint = `${cleanUrl}/rest/v1/auth/login`;

    const cleanLogin = String(login || '').trim();
    const loginPayloadValue = /^\d+$/.test(cleanLogin) ? Number(cleanLogin) : cleanLogin;

    const result = await fetchHemisEndpoint(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: loginPayloadValue, password })
      },
      useCorsProxy
    );

    const token =
      result?.data?.token ||
      result?.token ||
      result?.access_token;

    if (!token) {
      const errMsg =
        result?.error ||
        result?.message ||
        'Неверный логин или пароль в системе HEMIS.';
      throw new Error(errMsg);
    }

    return token;
  }

  async function fetchScheduleWithToken(baseUrl, token, useCorsProxy = true) {
    const cleanUrl = cleanHemisBaseUrl(baseUrl);
    const cleanToken = token.replace(/^Bearer\s+/i, '').trim();
    const authHeaders = {
      Authorization: `Bearer ${cleanToken}`
    };

    let studentProfile = null;
    try {
      const meRes = await fetchHemisEndpoint(
        `${cleanUrl}/rest/v1/account/me`,
        { method: 'GET', headers: authHeaders },
        useCorsProxy
      );
      if (meRes?.data) {
        studentProfile = {
          fullName: meRes.data.full_name || meRes.data.short_name || meRes.data.name || 'Студент',
          groupName: meRes.data.group?.name || '',
          semesterName: meRes.data.semester?.name || '',
          university: meRes.data.university || cleanUrl.replace('https://', '')
        };
      }
    } catch (_) {
      // Профиль необязателен
    }

    const scheduleRes = await fetchHemisEndpoint(
      `${cleanUrl}/rest/v1/education/schedule`,
      { method: 'GET', headers: authHeaders },
      useCorsProxy
    );

    if (scheduleRes?.success === false && scheduleRes?.error) {
      throw new Error(scheduleRes.error);
    }

    const lessons = normalizeHemisSchedulePayload(scheduleRes);

    // Загружаем посещаемость (НБ / Davomat) и часы предметов из HEMIS
    let attendanceRaw = [];
    let subjectsRaw = [];

    try {
      const attRes = await fetchHemisEndpoint(
        `${cleanUrl}/rest/v1/education/attendance`,
        { method: 'GET', headers: authHeaders },
        useCorsProxy
      );
      if (Array.isArray(attRes?.data)) {
        attendanceRaw = attRes.data;
      } else if (Array.isArray(attRes?.data?.items)) {
        attendanceRaw = attRes.data.items;
      }
    } catch (_) {
      // Если эндпоинт посещаемости недоступен, создадим пустую структуру по предметам
    }

    try {
      const subjRes = await fetchHemisEndpoint(
        `${cleanUrl}/rest/v1/education/subjects`,
        { method: 'GET', headers: authHeaders },
        useCorsProxy
      );
      if (Array.isArray(subjRes?.data)) {
        subjectsRaw = subjRes.data;
      } else if (Array.isArray(subjRes?.data?.items)) {
        subjectsRaw = subjRes.data.items;
      }
    } catch (_) {
      // Используем стандартные 60 часов по умолчанию
    }

    const attendance = normalizeHemisAttendancePayload(attendanceRaw, subjectsRaw, lessons);

    return {
      studentProfile,
      lessons,
      attendance
    };
  }

  /**
   * Нормализует данные о пропусках (НБ / Davomat) по каждому предмету
   * Стандартный лимит в вузах HEMIS — 25% от общей учебной нагрузки предмета (totalHours)
   */
  function normalizeHemisAttendancePayload(attendanceItems = [], subjectItems = [], lessons = []) {
    const map = {};

    // 1. Сначала регистрируем все предметы из расписания и списка предметов
    for (const l of lessons) {
      const name = (l.subject || '').trim();
      if (!name) continue;
      if (!map[name]) {
        map[name] = {
          subject: name,
          missedHours: 0,
          unexcusedHours: 0,
          excusedHours: 0,
          totalHours: 60
        };
      }
    }

    for (const s of subjectItems) {
      const name = (
        s.subject?.name ||
        s.curriculumSubject?.subject?.name ||
        s.name ||
        ''
      ).trim();
      if (!name) continue;
      const totalLoad =
        Number(s.total_acload) ||
        Number(s.curriculumSubject?.total_acload) ||
        Number(s.totalHours) ||
        60;

      if (!map[name]) {
        map[name] = {
          subject: name,
          missedHours: 0,
          unexcusedHours: 0,
          excusedHours: 0,
          totalHours: totalLoad
        };
      } else if (totalLoad > 0) {
        map[name].totalHours = totalLoad;
      }
    }

    // 2. Суммируем все записи о пропусках из /rest/v1/education/attendance
    for (const item of attendanceItems) {
      const name = (item.subject?.name || item.subjectName || '').trim();
      if (!name) continue;

      if (!map[name]) {
        map[name] = {
          subject: name,
          missedHours: 0,
          unexcusedHours: 0,
          excusedHours: 0,
          totalHours: 60
        };
      }

      const absentOn = Number(item.absent_on) || 0;
      const absentOff = Number(item.absent_off) || 0;
      let hours = absentOn + absentOff;

      if (hours === 0) {
        hours = Number(item.hour) || Number(item.hours) || 2;
        if (item.explicable) {
          map[name].excusedHours += hours;
        } else {
          map[name].unexcusedHours += hours;
        }
      } else {
        map[name].excusedHours += absentOn;
        map[name].unexcusedHours += absentOff;
      }

      map[name].missedHours += hours;
    }

    return map;
  }

  function extractDayOfWeek(item) {
    if (item.dayOfWeek && item.dayOfWeek >= 1 && item.dayOfWeek <= 7) {
      return Number(item.dayOfWeek);
    }
    if (item.weekDay && item.weekDay >= 1 && item.weekDay <= 7) {
      return Number(item.weekDay);
    }

    const rawDate = item.lesson_date ?? item.lessonDate ?? item.date;
    if (rawDate !== undefined && rawDate !== null) {
      let dateObj;
      if (typeof rawDate === 'number' || /^\d+$/.test(String(rawDate))) {
        const num = Number(rawDate);
        dateObj = new Date(num < 1e11 ? num * 1000 : num);
      } else {
        dateObj = new Date(rawDate);
      }

      if (!isNaN(dateObj.getTime())) {
        const jsDay = dateObj.getDay();
        return jsDay === 0 ? 7 : jsDay;
      }
    }

    return 1;
  }

  function guessPairTimes(pairName) {
    const num = parseInt(String(pairName).replace(/\D/g, ''), 10) || 1;
    const slots = {
      1: { start: '08:30', end: '09:50' },
      2: { start: '10:00', end: '11:20' },
      3: { start: '11:30', end: '12:50' },
      4: { start: '13:30', end: '14:50' },
      5: { start: '15:00', end: '16:20' },
      6: { start: '16:30', end: '17:50' }
    };
    return slots[num] || slots[1];
  }

  function normalizeHemisSchedulePayload(payload) {
    let rawItems = [];
    if (Array.isArray(payload)) {
      rawItems = payload;
    } else if (Array.isArray(payload?.data)) {
      rawItems = payload.data;
    } else if (Array.isArray(payload?.data?.items)) {
      rawItems = payload.data.items;
    } else if (Array.isArray(payload?.items)) {
      rawItems = payload.items;
    } else {
      throw new Error('Не удалось найти массив расписания в ответе HEMIS.');
    }

    const uniqueMap = new Map();

    for (const item of rawItems) {
      const dayOfWeek = extractDayOfWeek(item);
      if (dayOfWeek < 1 || dayOfWeek > 6) continue;

      const subjectName =
        item.subject?.name ||
        item.subjectName ||
        item.name ||
        'Учебная дисциплина';

      const trainingType =
        item.trainingType?.name ||
        item.trainingType ||
        'Занятие';

      const pairName =
        item.lessonPair?.name ||
        item.pairName ||
        '1 пара';

      const startTime =
        item.lessonPair?.start_time ||
        item.startTime ||
        guessPairTimes(pairName).start;

      const endTime =
        item.lessonPair?.end_time ||
        item.endTime ||
        guessPairTimes(pairName).end;

      const auditorium =
        item.auditorium?.name ||
        item.room ||
        '—';

      const building =
        item.auditorium?.building?.name || '';

      const roomDisplay =
        building && !auditorium.includes(building)
          ? `${auditorium} (${building})`
          : auditorium;

      const teacher =
        item.employee?.name ||
        item.teacher ||
        'Преподаватель не указан';

      const dedupKey = `${dayOfWeek}_${startTime}_${subjectName.toLowerCase().trim()}`;

      if (!uniqueMap.has(dedupKey)) {
        uniqueMap.set(dedupKey, {
          id: item.id ? `hemis_${item.id}` : `lesson_${dedupKey.replace(/\s+/g, '_')}`,
          dayOfWeek,
          subject: subjectName.trim(),
          trainingType: trainingType.trim(),
          pairName: String(pairName).trim(),
          startTime,
          endTime,
          room: roomDisplay,
          teacher: teacher.trim()
        });
      }
    }

    const normalized = Array.from(uniqueMap.values());
    normalized.sort((a, b) => {
      if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
      return a.startTime.localeCompare(b.startTime);
    });

    return normalized;
  }

  function getDemoHemisData() {
    const studentProfile = {
      fullName: 'Демо-аккаунт студента (HEMIS)',
      groupName: 'ТМФТУ • 23-04',
      semesterName: '5-семестр',
      university: 'student.tift.uz'
    };

    const lessons = [
      {
        id: 'demo_mon_1',
        dayOfWeek: 1,
        subject: 'Искусственный интеллект и машинное обучение',
        trainingType: 'Лекция',
        pairName: '1 пара',
        startTime: '08:30',
        endTime: '09:50',
        room: 'А-204 (Главный корпус)',
        teacher: 'проф. Каримов А.Р.'
      },
      {
        id: 'demo_mon_2',
        dayOfWeek: 1,
        subject: 'Проектирование баз данных',
        trainingType: 'Практика',
        pairName: '2 пара',
        startTime: '10:00',
        endTime: '11:20',
        room: 'Б-312',
        teacher: 'доц. Рустамова Н.Ш.'
      },
      {
        id: 'demo_tue_1',
        dayOfWeek: 2,
        subject: 'Веб-программирование и облачные технологии',
        trainingType: 'Лабораторная',
        pairName: '1 пара',
        startTime: '08:30',
        endTime: '09:50',
        room: 'Лаб-105 (IT-центр)',
        teacher: 'ст. преп. Юсупов Т.М.'
      },
      {
        id: 'demo_tue_2',
        dayOfWeek: 2,
        subject: 'Компьютерные сети и телекоммуникации',
        trainingType: 'Лекция',
        pairName: '2 пара',
        startTime: '10:00',
        endTime: '11:20',
        room: 'А-101',
        teacher: 'доц. Ибрагимов Ш.К.'
      },
      {
        id: 'demo_wed_1',
        dayOfWeek: 3,
        subject: 'Искусственный интеллект и машинное обучение',
        trainingType: 'Лабораторная',
        pairName: '2 пара',
        startTime: '10:00',
        endTime: '11:20',
        room: 'Лаб-208',
        teacher: 'асс. Мирзаев Д.О.'
      },
      {
        id: 'demo_wed_2',
        dayOfWeek: 3,
        subject: 'Английский язык (Academic Writing)',
        trainingType: 'Практика',
        pairName: '3 пара',
        startTime: '11:30',
        endTime: '12:50',
        room: 'В-405',
        teacher: 'преп. Саидова Л.А.'
      },
      {
        id: 'demo_thu_1',
        dayOfWeek: 4,
        subject: 'Проектирование баз данных',
        trainingType: 'Лабораторная',
        pairName: '1 пара',
        startTime: '08:30',
        endTime: '09:50',
        room: 'Б-310',
        teacher: 'доц. Рустамова Н.Ш.'
      },
      {
        id: 'demo_fri_1',
        dayOfWeek: 5,
        subject: 'Веб-программирование и облачные технологии',
        trainingType: 'Практика',
        pairName: '2 пара',
        startTime: '10:00',
        endTime: '11:20',
        room: 'Б-201',
        teacher: 'ст. преп. Юсупов Т.М.'
      },
      {
        id: 'demo_fri_2',
        dayOfWeek: 5,
        subject: 'Компьютерные сети и телекоммуникации',
        trainingType: 'Практика',
        pairName: '3 пара',
        startTime: '11:30',
        endTime: '12:50',
        room: 'Лаб-Cisco 302',
        teacher: 'доц. Ибрагимов Ш.К.'
      }
    ];

    const attendance = {
      'Искусственный интеллект и машинное обучение': {
        subject: 'Искусственный интеллект и машинное обучение',
        missedHours: 4,
        unexcusedHours: 4,
        excusedHours: 0,
        totalHours: 60
      },
      'Проектирование баз данных': {
        subject: 'Проектирование баз данных',
        missedHours: 12,
        unexcusedHours: 10,
        excusedHours: 2,
        totalHours: 60
      },
      'Веб-программирование и облачные технологии': {
        subject: 'Веб-программирование и облачные технологии',
        missedHours: 2,
        unexcusedHours: 2,
        excusedHours: 0,
        totalHours: 60
      },
      'Компьютерные сети и телекоммуникации': {
        subject: 'Компьютерные сети и телекоммуникации',
        missedHours: 14,
        unexcusedHours: 14,
        excusedHours: 0,
        totalHours: 60
      },
      'Английский язык (Academic Writing)': {
        subject: 'Английский язык (Academic Writing)',
        missedHours: 0,
        unexcusedHours: 0,
        excusedHours: 0,
        totalHours: 60
      }
    };

    const sampleTasks = [
      {
        id: 'task_demo_1',
        subject: 'Искусственный интеллект и машинное обучение',
        dayOfWeek: 1,
        title: 'Подготовить проект по градиентному спуску',
        type: 'Лабораторная',
        priority: 'high',
        deadline: '',
        link: 'https://colab.research.google.com/',
        notes: 'Подготовиться к защите в начале пары',
        subtasks: [
          { id: 'sub_1', text: 'Загрузить датасет и очистить пропуски', done: true },
          { id: 'sub_2', text: 'Построить график функции потерь (Loss)', done: true },
          { id: 'sub_3', text: 'Оформить выводы в отчёте', done: false }
        ],
        completed: false,
        createdAt: Date.now()
      },
      {
        id: 'task_demo_2',
        subject: 'Проектирование баз данных',
        dayOfWeek: 1,
        title: 'Построить ER-диаграмму (3НФ) для интернет-магазина',
        type: 'Практика / ДЗ',
        priority: 'urgent',
        deadline: '',
        link: 'https://app.diagrams.net/',
        notes: 'Принести схему в PostgreSQL и draw.io',
        subtasks: [
          { id: 'sub_4', text: 'Составить список таблиц и первичных ключей', done: true },
          { id: 'sub_5', text: 'Написать SQL-скрипт создания таблиц', done: false }
        ],
        completed: false,
        createdAt: Date.now()
      },
      {
        id: 'task_demo_3',
        subject: 'Веб-программирование и облачные технологии',
        dayOfWeek: 2,
        title: 'Защитить Лабораторную работу №3 (GitHub Pages + REST API)',
        type: 'Лабораторная',
        priority: 'urgent',
        deadline: '',
        link: 'https://github.com/',
        notes: 'Загрузить код в свой репозиторий GitHub и показать ссылку преподавателю',
        subtasks: [
          { id: 'sub_6', text: 'Проверить адаптивность на мобильном', done: true },
          { id: 'sub_7', text: 'Опубликовать ветку main в GitHub Pages', done: false }
        ],
        completed: false,
        createdAt: Date.now()
      }
    ];

    return { studentProfile, lessons, attendance, sampleTasks };
  }

  global.HemisPlanner = global.HemisPlanner || {};
  Object.assign(global.HemisPlanner, {
    DAYS_OF_WEEK,
    cleanHemisBaseUrl,
    loginToHemis,
    fetchScheduleWithToken,
    normalizeHemisSchedulePayload,
    normalizeHemisAttendancePayload,
    getDemoHemisData
  });
})(window);

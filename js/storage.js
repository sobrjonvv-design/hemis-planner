/**
 * Модуль хранения данных и облачной синхронизации (Телефон ↔ ПК)
 * Сохраняет:
 * - studentProfile
 * - lessons (расписание)
 * - tasks (задания с чек-листами и ссылками)
 * - attendance (пропуски НБ / Davomat и часы предметов)
 * - reminderSettings (настройки вечерних напоминаний)
 */
(function (global) {
  const STATE_KEY = 'hemis_planner_state_v1';
  const CLOUD_CONFIG_KEY = 'hemis_planner_cloud_v1';
  const HEMIS_AUTH_KEY = 'hemis_planner_auth_v1';
  const REMINDER_KEY = 'hemis_planner_reminders_v1';
  const GIST_FILENAME = 'hemis-planner-data.json';

  function loadLocalState() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) {
        return {
          studentProfile: null,
          lessons: [],
          tasks: [],
          attendance: {},
          updatedAt: 0
        };
      }
      const parsed = JSON.parse(raw);
      return {
        studentProfile: parsed.studentProfile || null,
        lessons: Array.isArray(parsed.lessons) ? parsed.lessons : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        attendance: parsed.attendance && typeof parsed.attendance === 'object' ? parsed.attendance : {},
        updatedAt: parsed.updatedAt || Date.now()
      };
    } catch (e) {
      console.error('Ошибка чтения LocalStorage:', e);
      return { studentProfile: null, lessons: [], tasks: [], attendance: {}, updatedAt: 0 };
    }
  }

  function saveLocalState(state) {
    const payload = {
      studentProfile: state.studentProfile || null,
      lessons: state.lessons || [],
      tasks: state.tasks || [],
      attendance: state.attendance || {},
      updatedAt: Date.now()
    };
    localStorage.setItem(STATE_KEY, JSON.stringify(payload));
    return payload;
  }

  function loadReminderSettings() {
    try {
      const raw = localStorage.getItem(REMINDER_KEY);
      return raw
        ? JSON.parse(raw)
        : {
            enabled: false,
            time: '20:00',
            lastNotifiedDate: ''
          };
    } catch (_) {
      return { enabled: false, time: '20:00', lastNotifiedDate: '' };
    }
  }

  function saveReminderSettings(settings) {
    localStorage.setItem(REMINDER_KEY, JSON.stringify(settings));
  }

  function loadHemisAuthConfig() {
    try {
      const raw = localStorage.getItem(HEMIS_AUTH_KEY);
      return raw
        ? JSON.parse(raw)
        : {
            baseUrl: 'https://student.tift.uz',
            login: '',
            token: '',
            useCorsProxy: true
          };
    } catch (_) {
      return { baseUrl: 'https://student.tift.uz', login: '', token: '', useCorsProxy: true };
    }
  }

  function saveHemisAuthConfig(config) {
    localStorage.setItem(HEMIS_AUTH_KEY, JSON.stringify(config));
  }

  function loadCloudConfig() {
    try {
      const raw = localStorage.getItem(CLOUD_CONFIG_KEY);
      return raw
        ? JSON.parse(raw)
        : {
            provider: 'gist',
            gistToken: '',
            gistId: '',
            firebaseUrl: '',
            firebaseSyncKey: '',
            firebaseSecret: ''
          };
    } catch (_) {
      return {
        provider: 'gist',
        gistToken: '',
        gistId: '',
        firebaseUrl: '',
        firebaseSyncKey: '',
        firebaseSecret: ''
      };
    }
  }

  function saveCloudConfig(config) {
    localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(config));
  }

  function isCloudConfigured(config = loadCloudConfig()) {
    if (config.provider === 'gist') {
      return Boolean(config.gistToken && config.gistToken.trim());
    }
    if (config.provider === 'firebase') {
      return Boolean(config.firebaseUrl && config.firebaseSyncKey);
    }
    return false;
  }

  async function pushStateToCloud(state, config = loadCloudConfig()) {
    const payload = {
      studentProfile: state.studentProfile || null,
      lessons: state.lessons || [],
      tasks: state.tasks || [],
      attendance: state.attendance || {},
      updatedAt: Date.now()
    };

    if (config.provider === 'gist') {
      if (!config.gistToken) {
        throw new Error('Укажите GitHub Personal Access Token с правом gist.');
      }
      const headers = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${config.gistToken.trim()}`,
        'Content-Type': 'application/json'
      };

      const body = {
        description: 'HEMIS Planner — синхронизация расписания, НБ и учебных заданий',
        public: false,
        files: {
          [GIST_FILENAME]: {
            content: JSON.stringify(payload, null, 2)
          }
        }
      };

      const gistId = (config.gistId || '').trim();
      const url = gistId
        ? `https://api.github.com/gists/${gistId}`
        : 'https://api.github.com/gists';

      const res = await fetch(url, {
        method: gistId ? 'PATCH' : 'POST',
        headers,
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || `Ошибка GitHub Gist API (HTTP ${res.status})`);
      }

      const result = await res.json();
      if (result.id && result.id !== config.gistId) {
        config.gistId = result.id;
        saveCloudConfig(config);
      }
      return { gistId: result.id, updatedAt: payload.updatedAt };
    }

    if (config.provider === 'firebase') {
      if (!config.firebaseUrl || !config.firebaseSyncKey) {
        throw new Error('Укажите URL базы Firebase и ваш личный ключ синхронизации.');
      }
      const base = config.firebaseUrl.replace(/\/+$/, '');
      const safeKey = encodeURIComponent(config.firebaseSyncKey.trim());
      const authQuery = config.firebaseSecret
        ? `?auth=${encodeURIComponent(config.firebaseSecret.trim())}`
        : '';
      const endpoint = `${base}/hemis_planner/${safeKey}.json${authQuery}`;

      const res = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        throw new Error(`Ошибка записи в Firebase (HTTP ${res.status})`);
      }
      return { updatedAt: payload.updatedAt };
    }

    throw new Error('Неизвестный провайдер облачной синхронизации.');
  }

  async function pullStateFromCloud(config = loadCloudConfig()) {
    if (config.provider === 'gist') {
      if (!config.gistToken || !config.gistId) {
        throw new Error('Для загрузки из GitHub Gist укажите Token и ID существующего Gist.');
      }
      const res = await fetch(`https://api.github.com/gists/${config.gistId.trim()}`, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${config.gistToken.trim()}`
        }
      });

      if (!res.ok) {
        throw new Error(`Не удалось загрузить Gist (HTTP ${res.status})`);
      }

      const data = await res.json();
      const fileObj = data.files?.[GIST_FILENAME] || Object.values(data.files || {})[0];
      if (!fileObj || !fileObj.content) {
        throw new Error('В указанном Gist не найдено данных HEMIS Planner.');
      }

      const parsed = JSON.parse(fileObj.content);
      return saveLocalState(parsed);
    }

    if (config.provider === 'firebase') {
      if (!config.firebaseUrl || !config.firebaseSyncKey) {
        throw new Error('Укажите URL базы Firebase и ваш личный ключ синхронизации.');
      }
      const base = config.firebaseUrl.replace(/\/+$/, '');
      const safeKey = encodeURIComponent(config.firebaseSyncKey.trim());
      const authQuery = config.firebaseSecret
        ? `?auth=${encodeURIComponent(config.firebaseSecret.trim())}`
        : '';
      const endpoint = `${base}/hemis_planner/${safeKey}.json${authQuery}`;

      const res = await fetch(endpoint, { method: 'GET' });
      if (!res.ok) {
        throw new Error(`Ошибка чтения из Firebase (HTTP ${res.status})`);
      }

      const parsed = await res.json();
      if (!parsed) {
        throw new Error('По указанному ключу в базе Firebase пока нет сохранённых данных.');
      }

      return saveLocalState(parsed);
    }

    throw new Error('Неизвестный провайдер облачной синхронизации.');
  }

  function exportStateToJsonFile(state) {
    const dataStr = JSON.stringify(state, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const datePart = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `hemis-planner-backup-${datePart}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  global.HemisPlanner = global.HemisPlanner || {};
  Object.assign(global.HemisPlanner, {
    loadLocalState,
    saveLocalState,
    loadReminderSettings,
    saveReminderSettings,
    loadHemisAuthConfig,
    saveHemisAuthConfig,
    loadCloudConfig,
    saveCloudConfig,
    isCloudConfigured,
    pushStateToCloud,
    pullStateFromCloud,
    exportStateToJsonFile
  });
})(window);

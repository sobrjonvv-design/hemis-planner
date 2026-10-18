/**
 * Модуль хранения данных и облачной синхронизации (Телефон ↔ ПК) для всех пользователей
 * Поддерживает:
 * 1. Быструю облачную синхронизацию по ID / Логину и паролю (БЕЗ токенов GitHub и регистрации!)
 *    Работает через связку Bytebin + KeyVal + Ntfy с поддержкой CORS на GitHub Pages
 * 2. GitHub Gist API (для продвинутых пользователей)
 * 3. Firebase Realtime Database REST API
 * 4. Экспорт и импорт резервной копии в формате .json
 */
(function (global) {
  const STATE_KEY = 'hemis_planner_state_v1';
  const CLOUD_CONFIG_KEY = 'hemis_planner_cloud_v1';
  const HEMIS_AUTH_KEY = 'hemis_planner_auth_v1';
  const REMINDER_KEY = 'hemis_planner_reminders_v1';
  const GIST_FILENAME = 'hemis-planner-data.json';
  const KEYVAL_APP_KEY = 'osmjpp9p';

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
        attendance:
          parsed.attendance && typeof parsed.attendance === 'object' ? parsed.attendance : {},
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
      updatedAt: state.updatedAt || Date.now()
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
      const parsed = raw ? JSON.parse(raw) : {};
      return {
        provider: parsed.provider || 'quick',
        quickId: parsed.quickId || '',
        quickPin: parsed.quickPin || '',
        gistToken: parsed.gistToken || '',
        gistId: parsed.gistId || '',
        firebaseUrl: parsed.firebaseUrl || '',
        firebaseSyncKey: parsed.firebaseSyncKey || '',
        firebaseSecret: parsed.firebaseSecret || ''
      };
    } catch (_) {
      return {
        provider: 'quick',
        quickId: '',
        quickPin: '',
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
    if (config.provider === 'quick') {
      return Boolean(config.quickId && config.quickId.trim() && config.quickPin && config.quickPin.trim());
    }
    if (config.provider === 'gist') {
      return Boolean(config.gistToken && config.gistToken.trim());
    }
    if (config.provider === 'firebase') {
      return Boolean(config.firebaseUrl && config.firebaseSyncKey);
    }
    return false;
  }

  /**
   * Генерирует детерминированный безопасный хэш-ключ комнаты из ID студента и пароля синхронизации
   */
  function computeQuickSyncKey(quickId, quickPin) {
    const raw = `hemis_v1_${String(quickId).trim().toLowerCase()}_${String(quickPin).trim()}`;
    let h1 = 0xdeadbeef ^ raw.length;
    let h2 = 0x41c6ce57 ^ raw.length;
    for (let i = 0, ch; i < raw.length; i++) {
      ch = raw.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const hex = (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
    const cleanPrefix = String(quickId)
      .trim()
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 12);
    return `hp_${cleanPrefix}_${hex}`;
  }

  async function pushStateToCloud(state, config = loadCloudConfig()) {
    const payload = {
      studentProfile: state.studentProfile || null,
      lessons: state.lessons || [],
      tasks: state.tasks || [],
      attendance: state.attendance || {},
      updatedAt: Date.now()
    };

    // 1. Быстрая синхронизация без токенов (по ID студента и ПИН/паролю)
    if (config.provider === 'quick') {
      if (!config.quickId || !config.quickPin) {
        throw new Error('Введите ваш ID (логин) и придумайте код/пароль синхронизации.');
      }
      const syncRoomKey = computeQuickSyncKey(config.quickId, config.quickPin);
      const jsonStr = JSON.stringify(payload);

      let storedPointer = false;

      // Сохраняем полный JSON в Bytebin и записываем указатель в KeyVal
      try {
        const bbRes = await fetch('https://bytebin.lucko.me/post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: jsonStr
        });
        if (bbRes.ok) {
          const bbData = await bbRes.json();
          if (bbData && bbData.key) {
            const kvUrl = `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${KEYVAL_APP_KEY}/${encodeURIComponent(
              syncRoomKey
            )}/${encodeURIComponent(bbData.key)}`;
            const kvRes = await fetch(kvUrl, { method: 'POST' });
            if (kvRes.ok) {
              storedPointer = true;
            }
          }
        }
      } catch (e) {
        console.warn('Bytebin/KeyVal warning:', e);
      }

      // Также дублируем в канал ntfy.sh для мгновенного резерва
      try {
        await fetch(`https://ntfy.sh/${syncRoomKey}`, {
          method: 'PUT',
          headers: {
            Filename: 'state.json'
          },
          body: jsonStr
        });
        storedPointer = true;
      } catch (e) {
        console.warn('Ntfy mirror warning:', e);
      }

      if (!storedPointer) {
        throw new Error('Не удалось связаться с облачным сервером. Проверьте подключение к интернету.');
      }

      return { syncRoomKey, updatedAt: payload.updatedAt };
    }

    // 2. GitHub Gist
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

    // 3. Firebase Realtime DB
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
    // 1. Быстрая загрузка по ID студента и паролю
    if (config.provider === 'quick') {
      if (!config.quickId || !config.quickPin) {
        throw new Error('Введите ваш ID (логин) и код/пароль синхронизации.');
      }
      const syncRoomKey = computeQuickSyncKey(config.quickId, config.quickPin);

      // Сначала пробуем получить указатель из KeyVal -> Bytebin
      try {
        const kvUrl = `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${KEYVAL_APP_KEY}/${encodeURIComponent(
          syncRoomKey
        )}`;
        const kvRes = await fetch(kvUrl);
        if (kvRes.ok) {
          const rawKey = await kvRes.json();
          if (rawKey && typeof rawKey === 'string' && rawKey.trim()) {
            const bbRes = await fetch(`https://bytebin.lucko.me/${encodeURIComponent(rawKey.trim())}`);
            if (bbRes.ok) {
              const parsed = await bbRes.json();
              if (parsed && (Array.isArray(parsed.lessons) || Array.isArray(parsed.tasks))) {
                return saveLocalState(parsed);
              }
            }
          }
        }
      } catch (e) {
        console.warn('KeyVal/Bytebin pull fallback:', e);
      }

      // Резервный вариант через ntfy.sh
      const ntfyRes = await fetch(`https://ntfy.sh/${syncRoomKey}/json?poll=1&since=all`);
      if (ntfyRes.ok) {
        const text = await ntfyRes.text();
        const lines = text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);

        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const eventObj = JSON.parse(lines[i]);
            if (eventObj.attachment?.url) {
              const fileRes = await fetch(eventObj.attachment.url);
              if (fileRes.ok) {
                const parsed = await fileRes.json();
                return saveLocalState(parsed);
              }
            } else if (eventObj.message && eventObj.message.startsWith('{')) {
              const parsed = JSON.parse(eventObj.message);
              return saveLocalState(parsed);
            }
          } catch (_) {}
        }
      }

      throw new Error(
        'По этому ID и паролю в облаке ещё нет данных. Сначала нажмите «⬆ Отправить в облако» на том устройстве, где загружено расписание!'
      );
    }

    // 2. GitHub Gist
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

    // 3. Firebase Realtime DB
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

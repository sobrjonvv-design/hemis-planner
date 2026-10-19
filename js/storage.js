/**
 * Модуль хранения данных и быстрой облачной синхронизации (Телефон ↔ ПК)
 * Работает по простому ID студента и паролю (без токенов GitHub и регистрации).
 */
(function (global) {
  const STATE_KEY = 'hemis_planner_state_v1';
  const CLOUD_CONFIG_KEY = 'hemis_planner_cloud_v2';
  const HEMIS_AUTH_KEY = 'hemis_planner_auth_v1';
  const REMINDER_KEY = 'hemis_planner_reminders_v1';
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
      lessons: Array.isArray(state.lessons) ? state.lessons : [],
      tasks: Array.isArray(state.tasks) ? state.tasks : [],
      attendance: state.attendance && typeof state.attendance === 'object' ? state.attendance : {},
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
      const parsed = raw ? JSON.parse(raw) : {};
      return {
        provider: 'quick',
        quickId: String(parsed.quickId || '').trim(),
        quickPin: String(parsed.quickPin || '').trim()
      };
    } catch (_) {
      return {
        provider: 'quick',
        quickId: '',
        quickPin: ''
      };
    }
  }

  function saveCloudConfig(config) {
    const clean = {
      provider: 'quick',
      quickId: String(config.quickId || '').trim(),
      quickPin: String(config.quickPin || '').trim()
    };
    localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(clean));
    return clean;
  }

  function isCloudConfigured(config = loadCloudConfig()) {
    return Boolean(config.quickId && config.quickId.trim() && config.quickPin && config.quickPin.trim());
  }

  /**
   * Генерирует детерминированный безопасный хэш-ключ комнаты из ID студента и пароля синхронизации
   */
  function computeQuickSyncKey(quickId, quickPin) {
    const raw = `hemis_v2_${String(quickId).trim().toLowerCase()}_${String(quickPin).trim()}`;
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

  /**
   * Отправляет состояние в облако (Simple CORS POST без нестандартных заголовков)
   */
  async function pushStateToCloud(state, config = loadCloudConfig()) {
    const quickId = String(config.quickId || '').trim();
    const quickPin = String(config.quickPin || '').trim();

    if (!quickId || !quickPin) {
      throw new Error('Введите ваш ID студента и придумайте пароль синхронизации.');
    }

    const payload = {
      studentProfile: state.studentProfile || null,
      lessons: state.lessons || [],
      tasks: state.tasks || [],
      attendance: state.attendance || {},
      updatedAt: Date.now()
    };

    const syncRoomKey = computeQuickSyncKey(quickId, quickPin);
    const jsonStr = JSON.stringify(payload);
    let bbKey = null;
    let savedSuccess = false;

    // 1. Загружаем полный JSON в Bytebin (Simple POST)
    try {
      const bbRes = await fetch('https://bytebin.lucko.me/post', {
        method: 'POST',
        body: jsonStr
      });
      if (bbRes.ok) {
        const bbData = await bbRes.json();
        if (bbData && bbData.key) {
          bbKey = bbData.key;
        }
      }
    } catch (e) {
      console.warn('Bytebin error:', e);
    }

    // 2. Сохраняем короткий ключ в KeyVal
    if (bbKey) {
      try {
        const kvUrl = `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${KEYVAL_APP_KEY}/${encodeURIComponent(
          syncRoomKey
        )}/${encodeURIComponent(bbKey)}`;
        const kvRes = await fetch(kvUrl, { method: 'POST', body: '' });
        if (kvRes.ok) {
          savedSuccess = true;
        }
      } catch (e) {
        console.warn('KeyVal error:', e);
      }
    }

    // 3. Также отправляем резервное сообщение в ntfy.sh (Simple POST без кастомных заголовков)
    try {
      const ntfyPayload = bbKey ? `BBKEY:${bbKey}` : jsonStr;
      const ntfyRes = await fetch(`https://ntfy.sh/${syncRoomKey}`, {
        method: 'POST',
        body: ntfyPayload
      });
      if (ntfyRes.ok) {
        savedSuccess = true;
      }
    } catch (e) {
      console.warn('Ntfy error:', e);
    }

    if (!savedSuccess) {
      throw new Error('Не удалось связаться с облаком. Проверьте подключение к интернету.');
    }

    return { syncRoomKey, updatedAt: payload.updatedAt };
  }

  /**
   * Загружает состояние из облака по ID студента и паролю
   */
  async function pullStateFromCloud(config = loadCloudConfig()) {
    const quickId = String(config.quickId || '').trim();
    const quickPin = String(config.quickPin || '').trim();

    if (!quickId || !quickPin) {
      throw new Error('Введите ваш ID студента и пароль синхронизации.');
    }

    const syncRoomKey = computeQuickSyncKey(quickId, quickPin);

    // 1. Сначала пробуем KeyVal -> Bytebin
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

    // 2. Резервный вариант через ntfy.sh
    try {
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
            const msg = String(eventObj.message || '').trim();
            if (msg.startsWith('BBKEY:')) {
              const key = msg.replace('BBKEY:', '').trim();
              const bbRes = await fetch(`https://bytebin.lucko.me/${encodeURIComponent(key)}`);
              if (bbRes.ok) {
                const parsed = await bbRes.json();
                return saveLocalState(parsed);
              }
            } else if (msg.startsWith('{')) {
              const parsed = JSON.parse(msg);
              return saveLocalState(parsed);
            }
          } catch (_) {}
        }
      }
    } catch (e) {
      console.warn('Ntfy pull error:', e);
    }

    throw new Error(
      'Данные по этому ID и паролю ещё не найдены в облаке. Сначала нажмите «⬆ Сохранить в облако» на устройстве с расписанием!'
    );
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
